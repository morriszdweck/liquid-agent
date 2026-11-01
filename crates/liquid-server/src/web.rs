//! Public web retrieval for agent tools. Each redirect gets a fresh DNS and address check.
use anyhow::{bail, Context, Result};
use futures_util::StreamExt;
use regex::Regex;
use std::{
    net::{IpAddr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use url::Url;

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || (a == 100 && (64..=127).contains(&b))
                || (a == 169 && b == 254)
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && (b == 168 || b == 0 || (b == 88 && c == 99)))
                || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                || (a == 203 && b == 0 && c == 113))
        }
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = ip.segments();
            // Restrict to globally routed unicast and exclude documentation, benchmarking, and ORCHID ranges.
            (s[0] & 0xe000) == 0x2000
                && !(s[0] == 0x2001
                    && (s[1] == 0x0db8
                        || s[1] == 0x0002
                        || (s[1] & 0xfff0) == 0x0010
                        || (s[1] & 0xfff0) == 0x0020))
                && !(s[0] == 0x3fff && (s[1] & 0xf000) == 0)
        }
    }
}
fn parse_url(raw: &str) -> Result<Url> {
    let raw = raw.trim();
    let lower = raw.to_ascii_lowercase();
    let input = if lower.starts_with("https://") || lower.starts_with("http://") {
        raw.to_owned()
    } else if raw.contains("://") {
        bail!("Only public websites can be opened.")
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&input).context("That isn't a web address.")?;
    let host = url
        .host_str()
        .context("That isn't a web address.")?
        .trim_end_matches('.')
        .trim_matches(['[', ']']);
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".local")
        || (!host.contains('.') && host.parse::<Ipv6Addr>().is_err())
    {
        bail!("Only public websites can be opened.");
    }
    Ok(url)
}
pub async fn browser_url(raw: &str, cancel: &CancellationToken) -> Result<String> {
    let url = parse_url(raw)?;
    let host = url
        .host_str()
        .context("Invalid host")?
        .trim_matches(['[', ']']);
    let port = url.port_or_known_default().context("Invalid port")?;
    let addresses = tokio::select! {
        _ = cancel.cancelled() => bail!("Stopped."),
        result = tokio::net::lookup_host((host, port)) => result.context("Could not resolve website")?.collect::<Vec<_>>(),
    };
    anyhow::ensure!(
        !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())),
        "Only public websites can be opened."
    );
    Ok(url.to_string())
}
async fn get_page(
    mut url: Url,
    post: Option<String>,
    cancel: &CancellationToken,
) -> Result<(String, String)> {
    let operation = async {
        for redirect in 0..=5 {
            let host = url
                .host_str()
                .context("Invalid host")?
                .trim_matches(['[', ']']);
            let port = url.port_or_known_default().context("Invalid port")?;
            let addresses: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
                .await
                .context("Could not resolve website")?
                .collect();
            anyhow::ensure!(
                !addresses.is_empty() && addresses.iter().all(|a| public_ip(a.ip())),
                "Only public websites can be opened."
            );
            let client = reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .resolve_to_addrs(host, &addresses)
                .timeout(Duration::from_secs(20))
                .user_agent("Mozilla/5.0 (compatible; LiquidAgent/0.2)")
                .build()?;
            let request = if redirect == 0 {
                if let Some(body) = &post {
                    client
                        .post(url.clone())
                        .header("content-type", "application/x-www-form-urlencoded")
                        .body(body.clone())
                } else {
                    client.get(url.clone())
                }
            } else {
                client.get(url.clone())
            };
            let response = request.send().await.context("Couldn't reach the website")?;
            if response.status().is_redirection() {
                anyhow::ensure!(redirect < 5, "Too many redirects.");
                let next = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .context("Missing redirect address")?
                    .to_str()?;
                url = parse_url(url.join(next)?.as_str())?;
                continue;
            }
            let response = response
                .error_for_status()
                .context("Website returned an error")?;
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_owned();
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk?;
                anyhow::ensure!(bytes.len() + chunk.len() <= 2_000_000, "Page is too large.");
                bytes.extend_from_slice(&chunk);
            }
            return Ok((content_type, String::from_utf8_lossy(&bytes).into_owned()));
        }
        bail!("Too many redirects.")
    };
    tokio::select! { _ = cancel.cancelled() => bail!("Stopped."), result = operation => result }
}
fn decode(text: &str) -> String {
    let entities = Regex::new(r"&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);").unwrap();
    entities
        .replace_all(text, |c: &regex::Captures<'_>| {
            let e = &c[1];
            match e {
                "amp" => "&".into(),
                "lt" => "<".into(),
                "gt" => ">".into(),
                "quot" => "\"".into(),
                "apos" => "'".into(),
                "nbsp" => " ".into(),
                _ => {
                    let n = if let Some(v) = e.strip_prefix("#x") {
                        u32::from_str_radix(v, 16).ok()
                    } else {
                        e.strip_prefix('#').and_then(|v| v.parse().ok())
                    };
                    n.and_then(char::from_u32)
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| c[0].to_owned())
                }
            }
        })
        .into_owned()
}
fn html_text(html: &str) -> String {
    let omit = Regex::new(r"(?is)<(script|style|noscript|svg|head)\b[^>]*>.*?</(?:script|style|noscript|svg|head)\s*>").unwrap();
    let breaks =
        Regex::new(r"(?i)<br\s*/?>|</(?:p|div|li|h[1-6]|tr|section|article|header|footer)\s*>")
            .unwrap();
    let tags = Regex::new(r"(?s)<[^>]*>").unwrap();
    let cleaned = omit.replace_all(html, " ");
    let cleaned = breaks.replace_all(&cleaned, "\n");
    let cleaned = tags.replace_all(&cleaned, " ");
    decode(&cleaned)
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}
fn search_results(html: &str) -> String {
    let links = Regex::new(r#"(?is)class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
    let snippets = Regex::new(r#"(?is)class="result__snippet"[^>]*>(.*?)</a>"#).unwrap();
    let snippets: Vec<_> = snippets.captures_iter(html).collect();
    let results: Vec<_> = links
        .captures_iter(html)
        .take(6)
        .enumerate()
        .map(|(i, c)| {
            let href = decode(&c[1]);
            let target = Url::parse("https://duckduckgo.com/")
                .unwrap()
                .join(&href)
                .ok()
                .and_then(|u| {
                    u.query_pairs()
                        .find(|(k, _)| k == "uddg")
                        .map(|(_, v)| v.into_owned())
                })
                .unwrap_or(href);
            format!(
                "{}. {}\n{}\n{}",
                i + 1,
                html_text(&c[2]),
                target,
                snippets
                    .get(i)
                    .map(|s| html_text(&s[1]))
                    .unwrap_or_default()
            )
        })
        .collect();
    if results.is_empty() {
        "No results.".into()
    } else {
        results.join("\n\n")
    }
}
pub async fn fetch(raw: &str, cancel: &CancellationToken) -> Result<String> {
    let (kind, body) = get_page(parse_url(raw)?, None, cancel).await?;
    if !kind.to_ascii_lowercase().contains("html") {
        return Ok(body);
    }
    let title = Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>")
        .unwrap()
        .captures(&body)
        .map(|c| html_text(&c[1]));
    let main = Regex::new(r"(?is)<(?:main|article)\b[^>]*>.*?</(?:main|article)\s*>").unwrap();
    Ok(format!(
        "{}{}",
        title.map(|s| format!("Title: {s}\n\n")).unwrap_or_default(),
        html_text(main.find(&body).map(|m| m.as_str()).unwrap_or(&body))
    ))
}
pub async fn search(query: &str, cancel: &CancellationToken) -> Result<String> {
    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("q", query)
        .finish();
    for attempt in 0..3 {
        match get_page(
            parse_url("https://html.duckduckgo.com/html/")?,
            Some(body.clone()),
            cancel,
        )
        .await
        {
            Ok((_, html)) => return Ok(search_results(&html)),
            Err(e) if attempt == 2 || cancel.is_cancelled() => return Err(e),
            Err(_) => {}
        }
    }
    unreachable!()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn blocks_private_and_special_addresses() {
        for s in [
            "127.0.0.1",
            "10.0.0.1",
            "100.64.1.1",
            "192.168.1.1",
            "169.254.169.254",
            "::1",
            "::ffff:127.0.0.1",
            "fc00::1",
            "2001:db8::1",
        ] {
            assert!(!public_ip(s.parse().unwrap()), "{s}");
        }
        for s in ["8.8.8.8", "2606:4700:4700::1111"] {
            assert!(public_ip(s.parse().unwrap()), "{s}");
        }
    }
    #[test]
    fn rejects_non_web_urls() {
        for s in [
            "http://localhost/a",
            "file:///etc/passwd",
            "http://thing.local/",
            "http://user:pass@example.com/",
        ] {
            assert!(parse_url(s).is_err(), "{s}");
        }
    }
    #[test]
    fn extracts_search_and_html() {
        let html = r#"<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">A &amp; B</a><a class="result__snippet">A <b>result</b></a>"#;
        assert_eq!(
            search_results(html),
            "1. A & B\nhttps://example.com/\nA result"
        );
        assert_eq!(
            html_text("<script>bad</script><p>Hi &amp; &#x1f600;</p>"),
            "Hi & 😀"
        );
    }
    #[tokio::test]
    async fn blocks_local_fetch() {
        assert!(fetch("http://127.0.0.1:12345/", &CancellationToken::new())
            .await
            .unwrap_err()
            .to_string()
            .contains("public"));
    }
}
