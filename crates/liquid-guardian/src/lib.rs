//! Rust inference for the Auto 150M safety classifier.
use anyhow::{Context, Result};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;
use candle_transformers::models::modernbert::{Config, ModernBertForSequenceClassification};
use serde_json::Value;
use std::path::Path;
use tokenizers::{Tokenizer, TruncationParams};

const MAX_TOKENS: usize = 8192;

/// Translate the current Transformers configuration into Candle's format.
fn parse_config(mut config: Value) -> Result<Config> {
    // Candle's classifier config expects string label IDs, while Transformers
    // stores them as JSON numbers. Flattened deserialization otherwise silently
    // discards the classifier configuration.
    if let Some(labels) = config.get_mut("label2id").and_then(Value::as_object_mut) {
        for value in labels.values_mut() {
            if let Some(id) = value.as_u64() {
                *value = Value::String(id.to_string());
            }
        }
    }
    for (target, source, default) in [
        ("global_rope_theta", "full_attention", 160_000.0),
        ("local_rope_theta", "sliding_attention", 10_000.0),
    ] {
        if config.get(target).is_none() {
            let value = config
                .pointer(&format!("/rope_parameters/{source}/rope_theta"))
                .cloned()
                .unwrap_or_else(|| Value::from(default));
            config[target] = value;
        }
    }
    // Only the first 8192 positions are used, saving rotary-cache memory.
    if let Some(max) = config
        .get("max_position_embeddings")
        .and_then(Value::as_u64)
    {
        config["max_position_embeddings"] = Value::from(max.min(MAX_TOKENS as u64));
    }
    Ok(serde_json::from_value(config)?)
}

pub struct Guardian {
    tokenizer: Tokenizer,
    full_tokenizer: Tokenizer,
    model: ModernBertForSequenceClassification,
    device: Device,
}

impl Guardian {
    pub fn load(folder: &Path) -> Result<Self> {
        let config = parse_config(serde_json::from_slice(&std::fs::read(
            folder.join("config.json"),
        )?)?)?;
        let mut tokenizer = Tokenizer::from_file(folder.join("tokenizer.json"))
            .map_err(|e| anyhow::anyhow!("loading tokenizer: {e}"))?;
        let mut full_tokenizer = tokenizer.clone();
        full_tokenizer
            .with_truncation(None)
            .map_err(|e| anyhow::anyhow!("configuring tokenizer: {e}"))?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_TOKENS,
                ..Default::default()
            }))
            .map_err(|e| anyhow::anyhow!("configuring tokenizer: {e}"))?;
        let device = Device::Cpu;
        let weights =
            std::fs::read(folder.join("model.safetensors")).context("reading guardian model")?;
        let vb = VarBuilder::from_buffered_safetensors(weights, DType::F32, &device)?;
        let model = ModernBertForSequenceClassification::load(vb, &config)?;
        Ok(Self {
            tokenizer,
            full_tokenizer,
            model,
            device,
        })
    }

    /// Classify a serialized request, returning the probability of denial.
    pub fn score(&self, text: &str) -> Result<f32> {
        let encoding = self
            .tokenizer
            .encode(text, true)
            .map_err(|e| anyhow::anyhow!("tokenizing: {e}"))?;
        let ids = encoding.get_ids();
        let mask = vec![1u32; ids.len()];
        let ids = Tensor::new(ids, &self.device)?.unsqueeze(0)?;
        let mask = Tensor::new(mask.as_slice(), &self.device)?.unsqueeze(0)?;
        Ok(self.model.forward(&ids, &mask)?.to_vec2::<f32>()?[0][1])
    }

    pub fn classify(&self, body: &Value) -> Result<f32> {
        let text = serialize(body, |text| {
            Ok(self
                .full_tokenizer
                .encode(text, true)
                .map_err(|e| anyhow::anyhow!("tokenizing: {e}"))?
                .len())
        })?;
        self.score(&text)
    }
}

fn as_text(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

/// Match the model's training format and discard oldest history first when needed.
fn serialize(body: &Value, token_count: impl Fn(&str) -> Result<usize>) -> Result<String> {
    if let Some(text) = body.get("text") {
        return text
            .as_str()
            .map(str::to_owned)
            .context("text must be a string");
    }
    let tool = body.get("tool").context("missing tool")?;
    let args = body.get("args").context("missing args")?;
    let request = body
        .get("request")
        .and_then(Value::as_str)
        .context("missing request")?;
    let history = match body.get("history") {
        None => &[][..],
        Some(value) => value
            .as_array()
            .context("history must be an array")?
            .as_slice(),
    };
    for start in 0..=history.len() {
        let mut text = format!("### PROPOSED TOOL CALL\ntool: {}\nargs: {}\n\n### USER REQUEST\n{}\n\n### AGENT HISTORY", as_text(tool), as_text(args), request);
        if start == history.len() {
            text.push_str("\n(no prior actions)");
        }
        for (index, item) in history[start..].iter().enumerate() {
            let tool = item.get("tool").context("history entry missing tool")?;
            let args = item.get("args").context("history entry missing args")?;
            let result = item.get("result").map(as_text).unwrap_or_default();
            text.push_str(&format!(
                "\n[{}] {}({})\n-> {}",
                index + 1,
                as_text(tool),
                as_text(args),
                result
            ));
        }
        if start == history.len() || token_count(&text)? <= MAX_TOKENS {
            return Ok(text);
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn maps_rope_parameters_and_limits_cache() {
        let config = serde_json::json!({"vocab_size": 10, "hidden_size": 8, "num_hidden_layers": 1,
          "num_attention_heads": 2, "intermediate_size": 16, "max_position_embeddings": 65536,
          "layer_norm_eps": 0.00001, "pad_token_id": 0, "global_attn_every_n_layers": 3,
          "local_attention": 128, "rope_parameters": {"full_attention": {"rope_theta": 1280000},
          "sliding_attention": {"rope_theta": 10000}}, "id2label": {"0": "approve", "1": "deny"},
          "label2id": {"approve": 0, "deny": 1}, "classifier_pooling": "cls"});
        let parsed = parse_config(config).unwrap();
        assert_eq!(parsed.global_rope_theta, 1_280_000.0);
        assert_eq!(parsed.max_position_embeddings, 8192);
        assert_eq!(parsed.classifier_config.unwrap().id2label.len(), 2);
    }

    #[test]
    fn serializes_and_drops_oldest_history() {
        let body = serde_json::json!({"tool":"Bash", "args":"ls", "request":"List files", "history":[
            {"tool":"Read", "args":"old", "result":"a"}, {"tool":"Read", "args":"new", "result":"b"}]});
        let text = serialize(&body, |s| {
            Ok(if s.contains("old") { MAX_TOKENS + 1 } else { 1 })
        })
        .unwrap();
        assert!(text.contains("[1] Read(new)\n-> b"));
        assert!(!text.contains("old"));
        assert!(text.starts_with(
            "### PROPOSED TOOL CALL\ntool: Bash\nargs: ls\n\n### USER REQUEST\nList files"
        ));
    }
}
