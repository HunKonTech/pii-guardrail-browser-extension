use regex::{Captures, Regex};
use std::sync::LazyLock;

use crate::types::{DetectionSource, EntityType, PiiSpan};

const PROVIDER_TOKEN_SCORE: f64 = 0.97;
const ASSIGNED_SECRET_SCORE: f64 = 0.90;
const CONNECTION_PASSWORD_SCORE: f64 = 0.97;
const CONNECTION_USERNAME_SCORE: f64 = 0.85;
const CONNECTION_HOST_SCORE: f64 = 0.85;

/// Minimum Shannon entropy (bits per character) for a value assigned to a
/// token/key-like name to count as a secret. Human-chosen words sit well
/// below this; random tokens sit well above it.
const MIN_SECRET_ENTROPY: f64 = 3.0;
const MIN_SECRET_LEN: usize = 8;
const MIN_PASSWORD_LEN: usize = 4;

/// Well-known token shapes. Each is distinctive enough to stand alone.
static PROVIDER_TOKEN_RES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    [
        // AWS access key id
        r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
        // GitHub personal / OAuth / app / refresh tokens
        r"\bgh[pousr]_[A-Za-z0-9]{36,255}\b",
        r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b",
        // OpenAI / Anthropic style keys
        r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_\-]{20,}",
        // Stripe secret / restricted keys
        r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b",
        // Slack tokens
        r"\bxox[abposr]-[A-Za-z0-9\-]{10,}",
        // Google API key
        r"\bAIza[0-9A-Za-z_\-]{35}",
        // JSON Web Token
        r"\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}",
        // PEM private key block
        r"(?s)-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----.*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----",
    ]
    .iter()
    .map(|pattern| Regex::new(pattern).unwrap())
    .collect()
});

/// `name = value`, `name: value`, `"name": "value"`, `NAME=value` where the
/// name mentions a credential. Group 1 = name, 2 = opening quote, 3 = value.
static ASSIGNMENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r"(?i)([A-Za-z0-9_.\-]*(?:password|passwd|passphrase|pwd|secret|token|api[_\-]?key|apikey",
        r"|access[_\-]?key|private[_\-]?key|auth[_\-]?key|credentials?)[A-Za-z0-9_\-]*)",
        r#"["']?\s*(?::=|:|=)\s*(["'`]?)([^\s"'`,;=(){}\[\]<>]+)"#,
    ))
    .unwrap()
});

/// `scheme://user:password@host`. Group 1 = user, 2 = password, 3 = host.
static CONNECTION_STRING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)\b[a-z][a-z0-9+.\-]*://([^\s:/@'"`]+):([^\s@/'"`]+)@([A-Za-z0-9.\-]+|\[[0-9A-Fa-f:]+\])"#,
    )
    .unwrap()
});

/// Names that mention a credential word but describe metadata about it.
const NON_SECRET_NAME_SUFFIXES: &[&str] = &[
    "url", "uri", "endpoint", "path", "file", "type", "name", "header", "prefix", "length", "len",
    "count", "limit", "expiry", "expires", "ttl", "timeout", "field", "policy", "id",
];

/// Values that are obviously not real credentials.
const PLACEHOLDER_VALUES: &[&str] = &[
    "true", "false", "null", "none", "nil", "undefined", "changeme", "password", "secret",
    "example", "redacted", "string", "str", "required", "optional",
];

pub fn detect_secrets(text: &str) -> Vec<PiiSpan> {
    let mut spans = Vec::new();

    for pattern in PROVIDER_TOKEN_RES.iter() {
        for mat in pattern.find_iter(text) {
            spans.push(span(
                mat.start(),
                mat.end(),
                text,
                EntityType::Secret,
                PROVIDER_TOKEN_SCORE,
            ));
        }
    }

    for caps in ASSIGNMENT_RE.captures_iter(text) {
        if let Some(found) = assigned_secret(text, &caps) {
            spans.push(found);
        }
    }

    for caps in CONNECTION_STRING_RE.captures_iter(text) {
        spans.extend(connection_string_spans(text, &caps));
    }

    spans
}

fn assigned_secret(text: &str, caps: &Captures) -> Option<PiiSpan> {
    let name = caps.get(1)?.as_str().to_ascii_lowercase();
    let quote = caps.get(2)?.as_str();
    let quoted = !quote.is_empty();
    let value = caps.get(3)?;
    // The value pattern stops at whitespace; a quoted value runs to its
    // closing quote on the same line (`"correct horse battery"`).
    let (value_start, value_end) = if quoted {
        let rest = &text[value.start()..];
        let line_end = rest.find('\n').unwrap_or(rest.len());
        match rest[..line_end].find(quote) {
            Some(close) => (value.start(), value.start() + close),
            None => (value.start(), value.end()),
        }
    } else {
        (value.start(), value.end())
    };
    let value_text = &text[value_start..value_end];

    if name_describes_metadata(&name)
        || is_placeholder_value(value_text)
        || value_text.contains("://")
    {
        return None;
    }

    let is_password = ["password", "passwd", "passphrase", "pwd"]
        .iter()
        .any(|word| name.contains(word));

    if !quoted && looks_like_code_reference(text, value_end, value_text) {
        return None;
    }

    let accepted = if is_password {
        value_text.chars().count() >= MIN_PASSWORD_LEN
    } else {
        value_text.chars().count() >= MIN_SECRET_LEN
            && shannon_entropy(value_text) >= MIN_SECRET_ENTROPY
    };
    if !accepted {
        return None;
    }

    let entity_type = if is_password {
        EntityType::Password
    } else {
        EntityType::Secret
    };
    Some(span(
        value_start,
        value_end,
        text,
        entity_type,
        ASSIGNED_SECRET_SCORE,
    ))
}

fn connection_string_spans(text: &str, caps: &Captures) -> Vec<PiiSpan> {
    let mut spans = Vec::new();
    let (Some(user), Some(password), Some(host)) = (caps.get(1), caps.get(2), caps.get(3)) else {
        return spans;
    };

    if is_template_reference(password.as_str()) || is_placeholder_value(password.as_str()) {
        return spans;
    }

    if !is_template_reference(user.as_str()) {
        spans.push(span(
            user.start(),
            user.end(),
            text,
            EntityType::Username,
            CONNECTION_USERNAME_SCORE,
        ));
    }
    spans.push(span(
        password.start(),
        password.end(),
        text,
        EntityType::Password,
        CONNECTION_PASSWORD_SCORE,
    ));

    let host_text = host.as_str();
    let is_ip_literal = host_text.starts_with('[')
        || host_text.chars().all(|c| c.is_ascii_digit() || c == '.');
    if !is_ip_literal && !host_text.eq_ignore_ascii_case("localhost") {
        spans.push(span(
            host.start(),
            host.end(),
            text,
            EntityType::Hostname,
            CONNECTION_HOST_SCORE,
        ));
    }
    spans
}

fn name_describes_metadata(name: &str) -> bool {
    let last_segment = name
        .rsplit(['_', '-', '.'])
        .next()
        .unwrap_or(name);
    NON_SECRET_NAME_SUFFIXES.contains(&last_segment)
        || NON_SECRET_NAME_SUFFIXES
            .iter()
            .any(|suffix| suffix.len() > 3 && last_segment.ends_with(suffix))
}

fn is_placeholder_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    PLACEHOLDER_VALUES.contains(&lower.as_str())
        || is_template_reference(value)
        || lower.chars().all(|c| c == '*' || c == 'x' || c == '.')
        || lower.starts_with("your")
}

fn is_template_reference(value: &str) -> bool {
    value.starts_with('$') || value.starts_with('{') || value.starts_with('%')
}

/// An unquoted value that is really an expression: a call (`getpass()`), a
/// dotted path (`user.password`, `os.environ`), or a plain word identifier
/// (`password = pwd_input`). `.env` style secrets (`API_KEY=a1b2c3...`) mix
/// letters and digits, which is what separates them from identifiers.
fn looks_like_code_reference(text: &str, value_end: usize, value: &str) -> bool {
    let next_char = text[value_end..].chars().next();
    if next_char == Some('(') || value.contains('.') {
        return true;
    }
    let has_digit = value.chars().any(|c| c.is_ascii_digit());
    let has_alpha = value.chars().any(|c| c.is_alphabetic());
    let has_symbol = value
        .chars()
        .any(|c| !c.is_alphanumeric() && c != '_');
    !(has_digit && has_alpha) && !has_symbol
}

fn shannon_entropy(value: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut total = 0usize;
    for c in value.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    counts
        .values()
        .map(|&count| {
            let p = count as f64 / total as f64;
            -p * p.log2()
        })
        .sum()
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
        detect_secrets(text)
            .into_iter()
            .filter(|s| s.entity_type == entity_type)
            .map(|s| s.text)
            .collect()
    }

    #[test]
    fn detects_provider_tokens() {
        let cases = [
            "aws_key = AKIAIOSFODNN7EXAMPLE",
            "ghp_0123456789abcdefghijABCDEFGHIJ012345",
            "client = OpenAI(api_key=\"sk-proj-abcdefghijklmnopqrstuvwx\")",
            "stripe.api_key = 'sk_test_notarealtoken123'",
            "SLACK=xoxb-123456789012-abcdefABCDEF",
            "key: AIzaSyA-1234567890abcdefghijklmnopqrstu",
            "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        ];
        for text in cases {
            assert!(
                !found(text, EntityType::Secret).is_empty(),
                "expected a secret in {text:?}"
            );
        }
    }

    #[test]
    fn detects_pem_private_key_block() {
        let text = "key = \"\"\"-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\"\"\"";
        let secrets = found(text, EntityType::Secret);

        assert_eq!(secrets.len(), 1);
        assert!(secrets[0].starts_with("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(secrets[0].ends_with("-----END RSA PRIVATE KEY-----"));
    }

    #[test]
    fn detects_assigned_passwords_and_high_entropy_tokens() {
        assert_eq!(
            found("DB_PASSWORD=hunter2", EntityType::Password),
            vec!["hunter2"]
        );
        assert_eq!(
            found(r#"{"password": "correct horse"}"#, EntityType::Password),
            vec!["correct horse"]
        );
        assert_eq!(
            found("const apiToken = 'q8Zr2LmX0vPa7TkW';", EntityType::Secret),
            vec!["q8Zr2LmX0vPa7TkW"]
        );
        assert_eq!(
            found("SECRET_KEY: 9f8a7b6c5d4e3f2a1b0c", EntityType::Secret),
            vec!["9f8a7b6c5d4e3f2a1b0c"]
        );
    }

    #[test]
    fn ignores_code_references_and_placeholders() {
        let cases = [
            "password = getpass()",
            "password = user.password",
            "password = pwd_input",
            "if password == \"abc123\":",
            "token = os.environ['TOKEN']",
            "API_KEY=${API_KEY}",
            "password: ********",
            "api_key = \"your-api-key-here\"",
            "token_url = \"https://oauth2.example.com/token\"",
            "tokenizer = AutoTokenizer.from_pretrained(name)",
            "secret_name = \"prod-db-credentials\"",
            "token = 'aaaaaaaaaa'",
        ];
        for text in cases {
            let spans = detect_secrets(text);
            assert!(spans.is_empty(), "unexpected spans in {text:?}: {spans:?}");
        }
    }

    #[test]
    fn splits_connection_string_into_user_password_and_host() {
        let text = "mongodb://svc_reporting:Tr0ub4dor@mongo-01.prod.acme.io/db";

        assert_eq!(found(text, EntityType::Username), vec!["svc_reporting"]);
        assert_eq!(found(text, EntityType::Password), vec!["Tr0ub4dor"]);
        assert_eq!(found(text, EntityType::Hostname), vec!["mongo-01.prod.acme.io"]);
    }

    #[test]
    fn connection_string_skips_ip_hosts_and_templated_passwords() {
        assert!(found("redis://app:pw1234@10.0.0.5:6379", EntityType::Hostname).is_empty());
        assert!(detect_secrets("postgres://app:${DB_PASS}@db:5432").is_empty());
    }
}
