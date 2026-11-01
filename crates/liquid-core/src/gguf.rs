//! Bounded GGUF metadata inspection without loading model tensors into memory.
use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

const MAX_STRING: u64 = 20_000_000;
const MAX_ARRAY: u64 = 50_000_000;

#[derive(Debug, PartialEq, Eq)]
pub struct ModelInfo {
    pub architecture: Option<String>,
    pub context_length: Option<u64>,
    pub has_template: bool,
    pub thinking: bool,
    pub name: Option<String>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

struct Reader<R> {
    input: R,
    size: u64,
}

impl<R: Read + Seek> Reader<R> {
    fn bytes<const N: usize>(&mut self) -> io::Result<[u8; N]> {
        let mut b = [0; N];
        self.input.read_exact(&mut b)?;
        Ok(b)
    }
    fn u32(&mut self) -> io::Result<u32> {
        Ok(u32::from_le_bytes(self.bytes()?))
    }
    fn u64(&mut self) -> io::Result<u64> {
        Ok(u64::from_le_bytes(self.bytes()?))
    }
    fn skip(&mut self, n: u64) -> io::Result<()> {
        let pos = self.input.stream_position()?;
        let end = pos
            .checked_add(n)
            .filter(|end| *end <= self.size)
            .ok_or_else(|| invalid("GGUF value extends beyond the file"))?;
        self.input.seek(SeekFrom::Start(end))?;
        Ok(())
    }
    fn string(&mut self) -> io::Result<String> {
        let n = self.u64()?;
        if n > MAX_STRING {
            return Err(invalid("GGUF string is too long"));
        }
        let pos = self.input.stream_position()?;
        if n > self.size.saturating_sub(pos) {
            return Err(invalid("GGUF string extends beyond the file"));
        }
        let mut b = vec![0; n as usize];
        self.input.read_exact(&mut b)?;
        Ok(String::from_utf8_lossy(&b).into_owned())
    }
    fn value(&mut self, kind: u32) -> io::Result<Option<Value>> {
        match kind {
            8 => Ok(Some(Value::Text(self.string()?))),
            9 => {
                let item = self.u32()?;
                let count = self.u64()?;
                if count > MAX_ARRAY {
                    return Err(invalid("GGUF array is too long"));
                }
                if item == 8 {
                    for _ in 0..count {
                        let n = self.u64()?;
                        self.skip(n)?;
                    }
                } else {
                    let width = width(item).ok_or_else(|| invalid("unknown GGUF array type"))?;
                    self.skip(
                        count
                            .checked_mul(width)
                            .ok_or_else(|| invalid("GGUF array overflow"))?,
                    )?;
                }
                Ok(None)
            }
            4 => Ok(Some(Value::Number(self.u32()? as u64))),
            10 => Ok(Some(Value::Number(self.u64()?))),
            _ => {
                let n = width(kind).ok_or_else(|| invalid("unknown GGUF value type"))?;
                self.skip(n)?;
                Ok(None)
            }
        }
    }
}
fn width(kind: u32) -> Option<u64> {
    match kind {
        0 | 1 | 7 => Some(1),
        2 | 3 => Some(2),
        4..=6 => Some(4),
        10..=12 => Some(8),
        _ => None,
    }
}
enum Value {
    Text(String),
    Number(u64),
}

/// Inspect a GGUF file's metadata. Tensor contents are never read.
pub fn probe(path: impl AsRef<Path>) -> io::Result<ModelInfo> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    probe_reader(file, size)
}

fn probe_reader(input: impl Read + Seek, size: u64) -> io::Result<ModelInfo> {
    let mut r = Reader { input, size };
    if size < 24 {
        return Err(invalid("GGUF file is too small"));
    }
    if &r.bytes::<4>()? != b"GGUF" {
        return Err(invalid("not a GGUF file"));
    }
    let version = r.u32()?;
    if !(1..=3).contains(&version) {
        return Err(invalid("unsupported GGUF version"));
    }
    let tensors = r.u64()?;
    let pairs = r.u64()?;
    if tensors > 1_000_000 || pairs > 100_000 {
        return Err(invalid("GGUF header is damaged"));
    }
    let mut metadata = HashMap::new();
    for _ in 0..pairs {
        let key = r.string()?;
        let kind = r.u32()?;
        if let Some(value) = r.value(kind)? {
            metadata.insert(key, value);
        }
    }
    let text = |key: &str| match metadata.get(key) {
        Some(Value::Text(s)) => Some(s.clone()),
        _ => None,
    };
    let architecture = text("general.architecture");
    let key = architecture
        .as_ref()
        .map(|a| format!("{a}.context_length"))
        .unwrap_or_else(|| "context_length".into());
    let context_length = match metadata.get(&key) {
        Some(Value::Number(n)) if *n > 0 => Some(*n),
        _ => None,
    };
    let template = text("tokenizer.chat_template").unwrap_or_default();
    Ok(ModelInfo {
        architecture,
        context_length,
        has_template: !template.is_empty(),
        thinking: template.contains("enable_thinking"),
        name: text("general.name"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    fn string(out: &mut Vec<u8>, s: &str) {
        out.extend((s.len() as u64).to_le_bytes());
        out.extend(s.as_bytes());
    }
    fn header(pairs: u64) -> Vec<u8> {
        let mut b = b"GGUF".to_vec();
        b.extend(3u32.to_le_bytes());
        b.extend(1u64.to_le_bytes());
        b.extend(pairs.to_le_bytes());
        b
    }
    #[test]
    fn reads_metadata() {
        let mut b = header(3);
        string(&mut b, "general.architecture");
        b.extend(8u32.to_le_bytes());
        string(&mut b, "llama");
        string(&mut b, "llama.context_length");
        b.extend(4u32.to_le_bytes());
        b.extend(4096u32.to_le_bytes());
        string(&mut b, "tokenizer.chat_template");
        b.extend(8u32.to_le_bytes());
        string(&mut b, "enable_thinking");
        let info = probe_reader(Cursor::new(&b), b.len() as u64).unwrap();
        assert_eq!(info.architecture.as_deref(), Some("llama"));
        assert_eq!(info.context_length, Some(4096));
        assert!(info.has_template && info.thinking);
    }
    #[test]
    fn rejects_truncated_arrays_and_invalid_magic() {
        let mut b = header(1);
        string(&mut b, "array");
        b.extend(9u32.to_le_bytes());
        b.extend(4u32.to_le_bytes());
        b.extend(10u64.to_le_bytes());
        assert!(probe_reader(Cursor::new(&b), b.len() as u64).is_err());
        b[0] = 0;
        assert!(probe_reader(Cursor::new(&b), b.len() as u64).is_err());
    }
}
