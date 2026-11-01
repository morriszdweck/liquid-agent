//! Validation and scheduling rules for saved routines.
use regex::Regex;
use serde_json::{json, Map, Value};

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}
fn clip(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// Apply permitted routine changes without dropping preexisting fields.
pub fn clean(input: &Value, base: &Value) -> Value {
    let mut result: Map<String, Value> = base.as_object().cloned().unwrap_or_default();
    for (key, max) in [("name", 60), ("prompt", 2000)] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() {
                result.insert(key.into(), json!(clip(value, max)));
            }
        }
    }
    if let Some(icon) = input.get("icon").and_then(Value::as_str) {
        result.insert("icon".into(), json!(clip(icon, 30)));
    }
    if let Some(color) = input.get("color").and_then(Value::as_str) {
        if Regex::new(r"(?i)^#[0-9a-f]{6}$").unwrap().is_match(color) {
            result.insert("color".into(), json!(color));
        }
    }
    if let Some(schedule) = input
        .get("schedule")
        .filter(|s| s.is_object() || s.is_array())
    {
        let time = schedule
            .get("time")
            .and_then(Value::as_str)
            .filter(|s| Regex::new(r"^[0-9]{2}:[0-9]{2}$").unwrap().is_match(s))
            .map(str::to_owned)
            .or_else(|| {
                base.pointer("/schedule/time")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "09:00".into());
        let days = if let Some(days) = schedule.get("days").and_then(Value::as_array) {
            let mut days: Vec<i64> = days
                .iter()
                .filter_map(|d| {
                    d.as_i64().or_else(|| {
                        d.as_f64()
                            .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 6.0)
                            .map(|n| n as i64)
                    })
                })
                .filter(|d| (0..=6).contains(d))
                .collect();
            days.sort();
            days.dedup();
            json!(days)
        } else {
            base.pointer("/schedule/days").cloned().unwrap_or(json!([]))
        };
        result.insert(
            "schedule".into(),
            json!({"enabled":truthy(schedule.get("enabled")),"time":time,"days":days}),
        );
    }
    Value::Object(result)
}

/// Return IDs scheduled for this local minute that have not run recently.
pub fn due(routines: &Value, time: &str, day: i64, now: i64) -> Vec<String> {
    routines
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let s = r.get("schedule")?;
            if !truthy(s.get("enabled"))
                || s.get("time")?.as_str()? != time
                || !s.get("days")?.as_array()?.contains(&json!(day))
            {
                return None;
            }
            if now.saturating_sub(r.get("lastRun").and_then(Value::as_i64).unwrap_or(0)) < 120_000 {
                return None;
            }
            r.get("id")?.as_str().map(str::to_owned)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_routine_and_days() {
        let base = json!({"id":"a","name":"Old","schedule":{"time":"08:00","days":[1]}});
        let input = json!({"name":"  New  ","color":"bad","schedule":{"enabled":true,"time":"bad","days":[6,1,1,8,"2"]}});
        assert_eq!(
            clean(&input, &base),
            json!({"id":"a","name":"New","schedule":{"enabled":true,"time":"08:00","days":[1,6]}})
        );
    }
    #[test]
    fn selects_only_due_routines() {
        let entries = json!([{"id":"a","schedule":{"enabled":true,"time":"08:00","days":[1]},"lastRun":0},{"id":"b","schedule":{"enabled":true,"time":"08:00","days":[1]},"lastRun":199_999}]);
        assert_eq!(due(&entries, "08:00", 1, 200_000), vec!["a"]);
        assert!(due(&entries, "08:01", 1, 200_000).is_empty());
    }
}
