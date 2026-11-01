//! Hugging Face model identifiers and file selection.
use regex::Regex;
use serde_json::{json, Value};
use url::Url;

pub fn parse_hf_link(input: &str) -> Result<Value, &'static str> {
    let text = input.trim();
    if text.is_empty() {
        return Err("Paste a link to a model on Hugging Face.");
    }
    let pair = Regex::new(r"^[^/\s]+/[^/\s]+$").unwrap();
    let mut revision = "main".to_owned();
    let mut file = String::new();
    let repo = if pair.is_match(text) {
        text.to_owned()
    } else {
        let url_text = if text.to_lowercase().starts_with("http://")
            || text.to_lowercase().starts_with("https://")
        {
            text.to_owned()
        } else {
            format!("https://{text}")
        };
        let url =
            Url::parse(&url_text).map_err(|_| "That doesn't look like a Hugging Face link.")?;
        if !matches!(
            url.host_str(),
            Some("huggingface.co" | "www.huggingface.co" | "hf.co")
        ) {
            return Err("Use a link from huggingface.co.");
        }
        let mut parts = Vec::new();
        for part in url.path().split('/').filter(|part| !part.is_empty()) {
            let bytes = part.as_bytes();
            let mut i = 0;
            while i < bytes.len() {
                if bytes[i] == b'%' {
                    if i + 2 >= bytes.len()
                        || !bytes[i + 1].is_ascii_hexdigit()
                        || !bytes[i + 2].is_ascii_hexdigit()
                    {
                        return Err("That link has characters Hugging Face can't read.");
                    }
                    i += 3;
                } else {
                    i += 1;
                }
            }
            parts.push(
                percent_encoding::percent_decode_str(part)
                    .decode_utf8()
                    .map_err(|_| "That link has characters Hugging Face can't read.")?
                    .into_owned(),
            );
        }
        if parts.len() < 2 {
            return Err("That link is missing the model name.");
        }
        if parts.len() >= 4
            && ["tree", "blob", "resolve"].contains(&parts[2].as_str())
            && !parts[3].is_empty()
        {
            revision = parts[3].clone();
            file = parts[4..].join("/");
        }
        format!("{}/{}", parts[0], parts[1])
    };
    let repo = if repo.to_ascii_lowercase().ends_with(".git") {
        &repo[..repo.len() - 4]
    } else {
        &repo
    };
    if !Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
        .unwrap()
        .is_match(repo)
    {
        return Err("That doesn't look like a Hugging Face model link.");
    }
    if !file.is_empty() {
        if !file.to_ascii_lowercase().ends_with(".gguf") {
            return Err("That link points to a file that isn't a GGUF model.");
        }
        if file.split('/').any(|p| p == "." || p == "..") {
            return Err("That file path isn't allowed.");
        }
    }
    Ok(
        json!({"repo":repo, "revision":revision, "file":if file.is_empty() { None } else { Some(file) }}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_and_rejects_links() {
        assert_eq!(
            parse_hf_link("org/model.git").unwrap(),
            json!({"repo":"org/model","revision":"main","file":null})
        );
        assert_eq!(
            parse_hf_link("https://huggingface.co/org/model/blob/branch/dir/model-Q4.gguf")
                .unwrap()["file"],
            "dir/model-Q4.gguf"
        );
        assert!(parse_hf_link("https://evil.example/org/model").is_err());
        assert!(
            parse_hf_link("https://huggingface.co/org/model/blob/main/%2e%2e%2Fsecret.gguf")
                .is_err()
        );
        assert!(parse_hf_link("https://huggingface.co/org/model/blob/main/%XX.gguf").is_err());
    }

    #[test]
    fn groups_shards_and_excludes_incomplete_models() {
        let files = json!([
            {"path":"m-Q4_K_M-00002-of-00002.gguf", "size":12},
            {"path":"m-Q4_K_M-00001-of-00002.gguf", "size":10},
            {"path":"missing-Q8_0-00001-of-00002.gguf", "size":30},
            {"path":"mmproj.gguf", "size":1},
            {"path":"m-Q8_0.gguf", "size":100}
        ]);
        let result = variants(&files, 8.0).unwrap();
        assert_eq!(result["variants"].as_array().unwrap().len(), 2);
        assert_eq!(result["recommended"], "m-Q4_K_M-00001-of-00002.gguf");
        assert_eq!(result["variants"][0]["bytes"], 22.0);
        assert_eq!(
            result["variants"][0]["shards"][0],
            "m-Q4_K_M-00001-of-00002.gguf"
        );
        assert_eq!(result["warnings"].as_array().unwrap().len(), 2);
    }
}

fn quant_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let name = name
        .strip_suffix(".gguf")
        .or_else(|| name.strip_suffix(".GGUF"))
        .unwrap_or(name);
    let pattern =
        Regex::new(r"(?i)(?:^|[\s._-])((?:IQ\d+|Q\d+)(?:_[A-Za-z0-9]+)*|BF16|FP16|F16|F32|FP32)")
            .unwrap();
    pattern
        .captures_iter(name)
        .filter(|c| {
            let end = c.get(1).unwrap().end();
            name[end..]
                .chars()
                .next()
                .is_none_or(|c| c.is_whitespace() || "._-".contains(c))
        })
        .last()
        .map(|c| {
            c[1].to_uppercase()
                .replace("FP16", "F16")
                .replace("FP32", "F32")
        })
        .unwrap_or_else(|| "GGUF".into())
}

/// Group complete GGUF shards and recommend a size for available memory.
pub fn variants(files: &Value, memory_gb: f64) -> Result<Value, &'static str> {
    let shard_re = Regex::new(r"(?i)^(.*)-(\d{5})-of-(\d{5})\.gguf$").unwrap();
    let mut groups: Vec<(String, Vec<(String, usize, usize, f64)>)> = Vec::new();
    let mut found: Vec<Value> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    let mut projectors = 0;
    for entry in files.as_array().into_iter().flatten() {
        if entry
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| !t.is_empty() && t != "file")
        {
            continue;
        }
        let path = entry.get("path").and_then(Value::as_str).unwrap_or("");
        if !path.to_ascii_lowercase().ends_with(".gguf") {
            continue;
        }
        if path.to_ascii_lowercase().contains("mmproj") {
            projectors += 1;
            continue;
        }
        let size = entry
            .get("size")
            .filter(|value| !value.is_null())
            .or_else(|| entry.pointer("/lfs/size"))
            .and_then(|n| {
                n.as_f64()
                    .or_else(|| n.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(0.0);
        if let Some(c) = shard_re.captures(path) {
            let base = c[1].to_owned();
            let index = c[2].parse::<usize>().unwrap_or(0);
            let total = c[3].parse::<usize>().unwrap_or(0);
            let pos = groups
                .iter()
                .position(|(key, _)| key == &base)
                .unwrap_or_else(|| {
                    groups.push((base, Vec::new()));
                    groups.len() - 1
                });
            groups[pos].1.push((path.into(), index, total, size));
        } else {
            found.push(json!({"id":path,"file":path,"quant":quant_of(path),"bytes":size,"shards":[path],"shardBytes":[size]}));
        }
    }
    for (base, mut parts) in groups {
        let total = parts[0].2;
        parts.sort_by_key(|part| part.1);
        if total == 0
            || parts.len() != total
            || parts
                .iter()
                .enumerate()
                .any(|(i, p)| p.1 != i + 1 || p.2 != total)
        {
            warnings.push(format!(
                "{} is missing one or more parts, so it was skipped.",
                base.rsplit('/').next().unwrap_or(&base)
            ));
            continue;
        }
        let shards: Vec<_> = parts.iter().map(|p| p.0.clone()).collect();
        let sizes: Vec<_> = parts.iter().map(|p| p.3).collect();
        found.push(json!({"id":shards[0],"file":shards[0],"quant":quant_of(&base),"bytes":sizes.iter().sum::<f64>(),"shards":shards,"shardBytes":sizes}));
    }
    if projectors > 0 {
        warnings.push("This repository also has a vision or audio projector; only the text model is used here.".into());
    }
    if found.is_empty() {
        return Err("No GGUF files found in this repository. Pick a GGUF version of the model.");
    }
    found.sort_by(|a, b| {
        let size = |v: &Value| {
            let n = v["bytes"].as_f64().unwrap_or(0.0);
            if n == 0.0 {
                f64::MAX
            } else {
                n
            }
        };
        size(a).total_cmp(&size(b))
    });
    let effective = if memory_gb == 0.0 { 8.0 } else { memory_gb };
    let cap = effective.max(2.0) * 0.7e9;
    let sized: Vec<usize> = (0..found.len())
        .filter(|&i| found[i]["bytes"].as_f64().unwrap_or(0.0) > 0.0)
        .collect();
    let fitting: Vec<usize> = sized
        .iter()
        .copied()
        .filter(|&i| found[i]["bytes"].as_f64().unwrap_or(0.0) <= cap)
        .collect();
    let pool = if fitting.is_empty() {
        sized.into_iter().take(1).collect::<Vec<_>>()
    } else {
        fitting
    };
    let prefs: &[&str] = if memory_gb >= 16.0 {
        &[
            "Q8_0", "Q6_K", "Q5_K_M", "Q5_K_S", "Q4_K_M", "Q4_0", "BF16", "F16",
        ]
    } else if memory_gb >= 8.0 {
        &[
            "Q4_K_M", "Q4_0", "Q5_K_M", "Q5_K_S", "Q6_K", "Q8_0", "BF16", "F16",
        ]
    } else {
        &[
            "Q4_0", "Q4_K_M", "Q3_K_M", "IQ3_XXS", "Q2_K", "Q5_K_M", "Q6_K", "Q8_0", "BF16", "F16",
        ]
    };
    let recommended = prefs
        .iter()
        .find_map(|q| {
            pool.iter()
                .rev()
                .find(|&&i| found[i]["quant"] == *q)
                .copied()
        })
        .or_else(|| pool.first().copied())
        .unwrap_or(0);
    let id = found[recommended]["id"].clone();
    let last = found.len() - 1;
    for (i, v) in found.iter_mut().enumerate() {
        v["recommended"] = json!(v["id"] == id);
        v["label"] = json!(if v["id"] == id {
            "Recommended"
        } else if i == 0 {
            "Smallest"
        } else if i == last {
            "Best"
        } else {
            "Balanced"
        });
        let n = v["shards"].as_array().unwrap().len();
        if n > 1 {
            v["note"] = json!(format!("{n} parts"));
        }
    }
    Ok(json!({"variants":found,"recommended":id,"warnings":warnings}))
}
