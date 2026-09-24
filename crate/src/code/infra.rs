use regex::Regex;
use std::sync::LazyLock;

use crate::types::{DetectionSource, EntityType, PiiSpan};

const INTERNAL_HOST_SCORE: f64 = 0.85;
const PATH_USERNAME_SCORE: f64 = 0.85;

/// Hostnames under private-network suffixes. At least two labels before the
/// suffix so member access in code (`this.local`, `config.corp`) stays quiet.
static INTERNAL_HOST_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)\b(?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.){2,}",
        r"(?:internal|intranet|intra|corp|local|lan|localdomain)\b",
    ))
    .unwrap()
});

/// Home-directory paths; group 1 is the account name.
static HOME_PATH_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:/Users/|/home/|\b[A-Za-z]:(?:\\{1,2}|/)Users(?:\\{1,2}|/))([A-Za-z0-9._\-]+)")
        .unwrap()
});

/// Directory names under `/Users` or `/home` that are not a person's account.
const SHARED_HOME_DIRS: &[&str] = &["shared", "public", "default", "guest", "user", "username"];

pub fn detect_infrastructure(text: &str) -> Vec<PiiSpan> {
    let mut spans = Vec::new();

    for mat in INTERNAL_HOST_RE.find_iter(text) {
        spans.push(span(
            mat.start(),
            mat.end(),
            text,
            EntityType::Hostname,
            INTERNAL_HOST_SCORE,
        ));
    }

    for caps in HOME_PATH_RE.captures_iter(text) {
        let (Some(whole), Some(account)) = (caps.get(0), caps.get(1)) else {
            continue;
        };
        if !starts_a_filesystem_path(text, whole.start())
            || SHARED_HOME_DIRS.contains(&account.as_str().to_ascii_lowercase().as_str())
        {
            continue;
        }
        spans.push(span(
            account.start(),
            account.end(),
            text,
            EntityType::Username,
            PATH_USERNAME_SCORE,
        ));
    }

    spans
}

/// `/home/…` inside a URL (`https://site.com/home/about`) is a web route, not
/// a filesystem path. Accept the match only at a token boundary or after
/// `file://`.
fn starts_a_filesystem_path(text: &str, start: usize) -> bool {
    let before = &text[..start];
    if before.ends_with("file://") {
        return true;
    }
    match before.chars().next_back() {
        None => true,
        Some(c) => c.is_whitespace() || "\"'`=([{,:;>~".contains(c),
    }
}

fn span(start: usize, end: usize, text: &str, entity_type: EntityType, score: f64) -> PiiSpan {
    PiiSpan::new(
        start,
        end,
        entity_type,
        score,
        text[start..end].to_string(),
        DetectionSource::Regex,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn found(text: &str, entity_type: EntityType) -> Vec<String> {
        detect_infrastructure(text)
            .into_iter()
            .filter(|s| s.entity_type == entity_type)
            .map(|s| s.text)
            .collect()
    }

    #[test]
    fn detects_internal_hostnames() {
        assert_eq!(
            found("curl http://build-01.ci.acme.internal:8080/health", EntityType::Hostname),
            vec!["build-01.ci.acme.internal"]
        );
        assert_eq!(
            found("host = 'ip-10-0-0-12.ec2.internal'", EntityType::Hostname),
            vec!["ip-10-0-0-12.ec2.internal"]
        );
    }

    #[test]
    fn ignores_member_access_that_looks_like_a_host() {
        assert!(found("value = this.local", EntityType::Hostname).is_empty());
        assert!(found("cfg.corp", EntityType::Hostname).is_empty());
    }

    #[test]
    fn detects_usernames_in_home_paths() {
        assert_eq!(
            found("File \"/Users/jdoe/project/app.py\", line 3", EntityType::Username),
            vec!["jdoe"]
        );
        assert_eq!(
            found("cd /home/anna.k/src", EntityType::Username),
            vec!["anna.k"]
        );
        assert_eq!(
            found(r#"path = "C:\\Users\\mmueller\\AppData""#, EntityType::Username),
            vec!["mmueller"]
        );
    }

    #[test]
    fn ignores_web_routes_and_shared_dirs() {
        assert!(found("https://example.com/home/about", EntityType::Username).is_empty());
        assert!(found("ls /Users/Shared/data", EntityType::Username).is_empty());
    }
}
