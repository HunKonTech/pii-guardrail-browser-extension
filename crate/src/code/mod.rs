//! Source-code recognizers.
//!
//! Pasted code carries sensitive values that prose rarely does: API keys and
//! tokens, credentials in assignments and connection strings, internal
//! hostnames, and usernames embedded in home-directory paths. These
//! recognizers run on the whole text (code is often pasted without fences)
//! and only when `PipelineConfig::code_mode` enables them.

mod infra;
mod secrets;

use crate::types::{EntityType, PiiSpan};

/// Run every source-code recognizer against the input text.
pub fn detect_code_secrets(text: &str) -> Vec<PiiSpan> {
    let mut spans = secrets::detect_secrets(text);
    spans.extend(infra::detect_infrastructure(text));
    spans
}

/// Fold source-code spans into the regex spans.
///
/// Credential spans win outright: a connection string's password sits right
/// before `@host`, which the email pattern would otherwise swallow as
/// `password@host.tld`, and a token can contain digit runs that look like
/// phone numbers. Hostnames are weaker than the structured recognizers, so a
/// hostname that overlaps an email or IP address is dropped instead.
pub fn combine_with_regex(regex_spans: Vec<PiiSpan>, code_spans: Vec<PiiSpan>) -> Vec<PiiSpan> {
    let (hostnames, credentials): (Vec<PiiSpan>, Vec<PiiSpan>) = code_spans
        .into_iter()
        .partition(|span| span.entity_type == EntityType::Hostname);

    let mut combined: Vec<PiiSpan> = regex_spans
        .into_iter()
        .filter(|span| !credentials.iter().any(|credential| credential.overlaps(span)))
        .collect();
    combined.extend(credentials);

    let kept_hostnames: Vec<PiiSpan> = hostnames
        .into_iter()
        .filter(|host| !combined.iter().any(|span| span.overlaps(host)))
        .collect();
    combined.extend(kept_hostnames);
    combined
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::regex_recognizers::detect_regex;

    fn combined(text: &str) -> Vec<PiiSpan> {
        combine_with_regex(detect_regex(text), detect_code_secrets(text))
    }

    #[test]
    fn connection_string_password_beats_email_pattern() {
        let text = "DATABASE_URL=postgres://admin:s3cretPw@db.acme.com:5432/app";
        let spans = combined(text);

        assert!(spans
            .iter()
            .any(|s| s.entity_type == EntityType::Password && s.text == "s3cretPw"));
        assert!(!spans.iter().any(|s| s.entity_type == EntityType::Email));
        assert!(spans
            .iter()
            .any(|s| s.entity_type == EntityType::Hostname && s.text == "db.acme.com"));
    }

    #[test]
    fn email_keeps_precedence_over_internal_hostname() {
        let text = "contact ops@build.acme.internal for access";
        let spans = combined(text);

        assert!(spans
            .iter()
            .any(|s| s.entity_type == EntityType::Email && s.text == "ops@build.acme.internal"));
        assert!(!spans.iter().any(|s| s.entity_type == EntityType::Hostname));
    }
}
