//! Validation for user settings and local model endpoints.
use serde_json::Value;

pub fn is_local(input: &str) -> bool {
    url::Url::parse(input)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1"))
}

/// Apply a patch according to the current schema and choices; unknown keys are ignored.
pub fn apply(current: &Value, defaults: &Value, choices: &Value, patch: &Value) -> Value {
    let mut result = current.as_object().cloned().unwrap_or_default();
    let Some(patch) = patch.as_object() else {
        return Value::Object(result);
    };
    for (key, value) in patch {
        let Some(default) = defaults.get(key) else {
            continue;
        };
        let same_type = (default.is_string() && value.is_string())
            || (default.is_boolean() && value.is_boolean())
            || (default.is_number() && value.is_number());
        if !same_type {
            continue;
        }
        if ["smallURL", "omniURL", "guardianURL", "browserURL"].contains(&key.as_str())
            && !value.as_str().is_some_and(is_local)
        {
            continue;
        }
        if let Some(options) = choices.get(key).and_then(Value::as_array) {
            if !options.contains(value) {
                continue;
            }
        }
        result.insert(key.clone(), value.clone());
    }
    Value::Object(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rejects_remote_and_invalid_settings() {
        let defaults = json!({"smallURL":"http://127.0.0.1:8180/v1", "theme":"system", "maxSteps":8, "speakReplies":false});
        let choices = json!({"theme":["system", "dark"]});
        let patch = json!({"smallURL":"http://localhost.evil.example", "theme":"blue", "maxSteps":"3", "speakReplies":true, "other":3});
        assert_eq!(
            apply(&defaults, &defaults, &choices, &patch),
            json!({"smallURL":"http://127.0.0.1:8180/v1", "theme":"system", "maxSteps":8, "speakReplies":true})
        );
        assert!(is_local("http://[::1]:8766/classify"));
        assert!(!is_local("http://127.0.0.1.evil.example"));
        assert!(!is_local("http://localhost@evil.example"));
    }
}
