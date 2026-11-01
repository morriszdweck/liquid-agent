//! Parse the tool-call formats emitted by local models.
use regex::Regex;
use serde_json::{json, Map, Value};

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("static regex")
}
fn clean(text: &str) -> String {
    let text = re(r"<\|?/?tool_call(_start|_end)?\|?>").replace_all(text, "");
    re(r"</?function[^>]*>|</?parameter[^>]*>")
        .replace_all(&text, "")
        .trim()
        .to_owned()
}
fn coerce(s: &str) -> Value {
    let v = s.trim();
    if re(r"^-?\d+(\.\d+)?$").is_match(v) {
        if let Ok(n) = v.parse::<f64>() {
            if let Some(n) = serde_json::Number::from_f64(n) {
                return Value::Number(n);
            }
        }
    }
    match v {
        "true" | "True" => Value::Bool(true),
        "false" | "False" => Value::Bool(false),
        "None" | "null" => Value::Null,
        _ => Value::String(s.into()),
    }
}
fn opening(text: &str, position: usize) -> usize {
    text[..position]
        .rfind("<tool_call>")
        .filter(|&i| text[i + 11..position].trim().is_empty())
        .unwrap_or(position)
}
fn xml(text: &str) -> Option<(usize, String, Value)> {
    let function = re(r"<function=([^>\n]+)>").captures(text)?;
    let matched = function.get(0)?;
    let start = opening(text, matched.start());
    let body = &text[matched.end()..];
    let parameter = re(r"<parameter=([^>\n]+)>\n?");
    let mut args = Map::new();
    for cap in parameter.captures_iter(body) {
        let m = cap.get(0)?;
        let remaining = &body[m.end()..];
        let end = ["</parameter>", "<parameter=", "</function>", "</tool_call>"]
            .iter()
            .filter_map(|x| remaining.find(x))
            .min()
            .unwrap_or(remaining.len());
        let value = remaining[..end]
            .strip_suffix('\n')
            .unwrap_or(&remaining[..end]);
        args.insert(cap[1].trim().to_owned(), coerce(value));
    }
    Some((start, function[1].trim().to_owned(), Value::Object(args)))
}
fn kwargs(text: &str, mut i: usize) -> Option<Value> {
    let mut args = Map::new();
    let key_re = re(r"^([A-Za-z_]\w*)\s*=\s*");
    loop {
        while let Some(c) = text.get(i..)?.chars().next() {
            if !c.is_whitespace() {
                break;
            }
            i += c.len_utf8();
        }
        if text.get(i..)?.starts_with(')') {
            return Some(Value::Object(args));
        }
        let Some(cap) = key_re.captures(&text[i..]) else {
            return if args.is_empty() {
                None
            } else {
                Some(Value::Object(args))
            };
        };
        let name = cap[1].to_owned();
        i += cap.get(0)?.end();
        let remaining = text.get(i..)?;
        let value = if remaining.starts_with('"') || remaining.starts_with('\'') {
            let q = remaining.chars().next()?;
            let triple = remaining.starts_with(&q.to_string().repeat(3));
            let quote = q.to_string().repeat(if triple { 3 } else { 1 });
            i += quote.len();
            let mut out = String::new();
            while i < text.len() && !text[i..].starts_with(&quote) {
                let c = text[i..].chars().next()?;
                i += c.len_utf8();
                if c == '\\' && i < text.len() {
                    let n = text[i..].chars().next()?;
                    i += n.len_utf8();
                    out.push(match n {
                        'n' => '\n',
                        't' => '\t',
                        _ => n,
                    });
                } else {
                    out.push(c);
                }
            }
            if i < text.len() {
                i += quote.len();
            }
            Value::String(out)
        } else {
            let n = remaining.find([',', ')']).unwrap_or(remaining.len());
            i += n;
            coerce(remaining[..n].trim())
        };
        args.insert(name, value);
        while let Some(c) = text.get(i..).and_then(|s| s.chars().next()) {
            if !c.is_whitespace() {
                break;
            }
            i += c.len_utf8();
        }
        match text.get(i..).and_then(|s| s.chars().next()) {
            Some(',') => i += 1,
            _ => return Some(Value::Object(args)),
        }
    }
}
fn pythonic(text: &str) -> Option<(usize, String, Value)> {
    let expression = re(r"(<\|tool_call_start\|>\s*)?\[\s*([A-Za-z_][\w.]*)\s*\(");
    let cap = expression.captures(text)?;
    let m = cap.get(0)?;
    Some((m.start(), cap[2].into(), kwargs(text, m.end())?))
}
fn json_call(text: &str) -> Option<(usize, String, Value)> {
    let start = text.find('{')?;
    let mut depth = 0;
    let mut inside = false;
    let mut escaped = false;
    for (off, c) in text[start..].char_indices() {
        if inside {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                inside = false;
            }
        } else if c == '"' {
            inside = true;
        } else if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                let obj: Value = serde_json::from_str(&text[start..start + off + 1]).ok()?;
                let name = obj
                    .get("name")
                    .filter(|value| !value.is_null())
                    .or_else(|| {
                        obj.pointer("/function/name")
                            .filter(|value| !value.is_null())
                    })
                    .or_else(|| obj.get("tool").filter(|value| !value.is_null()))?
                    .as_str()?
                    .to_owned();
                let mut args = obj
                    .get("arguments")
                    .filter(|value| !value.is_null())
                    .or_else(|| obj.get("parameters").filter(|value| !value.is_null()))
                    .or_else(|| obj.get("args").filter(|value| !value.is_null()))
                    .or_else(|| {
                        obj.pointer("/function/arguments")
                            .filter(|value| !value.is_null())
                    })
                    .cloned()
                    .unwrap_or(json!({}));
                if let Some(s) = args.as_str() {
                    args = serde_json::from_str(s).ok()?;
                }
                return Some((opening(text, start), name, args));
            }
        }
    }
    None
}
fn normalize(name: &str, args: Value, tools: &Value) -> Option<Value> {
    let name = name.split('(').next()?.trim().to_lowercase();
    let name = name.strip_prefix("functions.").unwrap_or(&name);
    let tool = tools.get(name)?;
    let params = tool.get("params")?.as_array()?;
    let mut args = args.as_object().cloned().unwrap_or_default();
    let known: Vec<&str> = params
        .iter()
        .filter_map(|p| p.get("name")?.as_str())
        .collect();
    let unknown: Vec<String> = args
        .keys()
        .filter(|k| !known.contains(&k.as_str()))
        .cloned()
        .collect();
    let missing: Vec<&str> = params
        .iter()
        .filter(|p| p.get("required") != Some(&Value::Bool(false)))
        .filter_map(|p| p.get("name")?.as_str())
        .filter(|name| !args.contains_key(*name))
        .collect();
    if unknown.len() == 1 && missing.len() == 1 {
        if let Some(value) = args.remove(&unknown[0]) {
            args.insert(missing[0].to_owned(), value);
        }
    }
    args.retain(|k, _| known.contains(&k.as_str()));
    Some(json!({"name":name,"args":args}))
}
/// Parse and validate the first recognized call, preserving text before it.
pub fn parse(text: &str, tools: &Value) -> Value {
    for find in [
        xml as fn(&str) -> Option<(usize, String, Value)>,
        pythonic,
        json_call,
    ] {
        if let Some((start, name, args)) = find(text) {
            if let Some(call) = normalize(&name, args, tools) {
                return json!({"text":clean(&text[..start]),"call":call});
            }
        }
    }
    json!({"text":clean(text),"call":null})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_formats_and_normalizes() {
        let tools = json!({"shell":{"params":[{"name":"command"}]}});
        for text in ["Hello\n<tool_call><function=shell><parameter=command>ls</parameter></function></tool_call>", "Hello\n[shell(command='ls')]", "Hello\n{\"name\":\"functions.shell\",\"arguments\":{\"cmd\":\"ls\"}}"] {
            assert_eq!(parse(text,&tools), json!({"text":"Hello", "call":{"name":"shell","args":{"command":"ls"}}}));
        }
    }
    #[test]
    fn rejects_unknown_tools_and_handles_unicode() {
        let tools = json!({"shell":{"params":[{"name":"command"}]}});
        assert!(parse("héllo [unknown(cmd='x')]", &tools)["call"].is_null());
        assert_eq!(
            parse("héllo [shell(command='你好')]", &tools)["call"]["args"]["command"],
            "你好"
        );
    }

    #[test]
    fn null_json_fields_fall_back_to_alternatives() {
        let tools = json!({"shell":{"params":[{"name":"command"}]}});
        let input = r#"{"name":null,"tool":"shell","arguments":null,"args":{"command":"ls"}}"#;
        assert_eq!(parse(input, &tools)["call"]["args"]["command"], "ls");
    }
}
