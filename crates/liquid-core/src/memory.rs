//! Rank saved facts for inclusion in a model prompt.
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

fn words(text: &str) -> HashSet<String> {
    static WORD: OnceLock<Regex> = OnceLock::new();
    let pattern = WORD.get_or_init(|| Regex::new(r"[a-z0-9']{3,}").unwrap());
    let lower = text.to_lowercase();
    pattern
        .find_iter(&lower)
        .map(|m| m.as_str().to_owned())
        .collect()
}

/// Facts with shared words come first; newer facts win ties.
pub fn search<'a>(facts: &'a [String], query: &str, limit: usize) -> Vec<&'a str> {
    let query = words(query);
    let mut scored: Vec<_> = facts
        .iter()
        .enumerate()
        .filter_map(|(index, fact)| {
            let score = words(fact).intersection(&query).count();
            (score > 0).then_some((score, index, fact.as_str()))
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| b.1.cmp(&a.1)));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, _, fact)| fact)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ranks_unique_shared_words_then_recency() {
        let facts = vec![
            "Likes Rust and hiking".into(),
            "Uses Rust daily".into(),
            "Rust Rust Rust".into(),
        ];
        assert_eq!(
            search(&facts, "rust hiking rust", 3),
            vec!["Likes Rust and hiking", "Rust Rust Rust", "Uses Rust daily"]
        );
        assert!(search(&facts, "cats", 4).is_empty());
        assert_eq!(search(&facts, "rust", 0).len(), 0);
    }
}
