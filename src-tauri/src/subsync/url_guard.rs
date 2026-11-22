#![allow(dead_code)]

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
];

fn is_abs_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() > 2 && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\'))
        || value.starts_with('/')
        || value.starts_with("\\\\")
}

/// Resolves a local filesystem path from either a `file://` URL or an absolute path.
pub(crate) fn local_file_path(source: &str) -> Option<PathBuf> {
    let trimmed = source.trim();
    if trimmed.to_ascii_lowercase().starts_with("file://") {
        if let Ok(parsed) = url::Url::parse(trimmed) {
            if let Ok(path) = parsed.to_file_path() {
                return Some(path);
            }
        }
        return None;
    }
    if is_abs_path(trimmed) {
        return Some(PathBuf::from(trimmed));
    }
    None
}

fn is_disallowed_ipv4(ip: Ipv4Addr, allow_lan_and_loopback: bool) -> Result<(), String> {
    let octets = ip.octets();
    if octets[0] == 0
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
    {
        return Err("internal-ip-blocked".into());
    }
    if ip.is_loopback() {
        return if allow_lan_and_loopback {
            Ok(())
        } else {
            Err("loopback-blocked".into())
        };
    }
    let shared_cgnat = octets[0] == 100 && (octets[1] & 0xc0) == 0x40;
    if ip.is_private() || shared_cgnat {
        return if allow_lan_and_loopback {
            Ok(())
        } else {
            Err("internal-ip-blocked".into())
        };
    }
    Ok(())
}

fn is_disallowed_ipv6(ip: Ipv6Addr, allow_lan_and_loopback: bool) -> Result<(), String> {
    if ip.is_unspecified() || ip.is_multicast() {
        return Err("internal-ip-blocked".into());
    }
    let seg = ip.segments();
    // fe80::/10 link-local is always blocked (cloud/host metadata surface).
    if (seg[0] & 0xffc0) == 0xfe80 {
        return Err("internal-ip-blocked".into());
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_disallowed_ipv4(v4, allow_lan_and_loopback);
    }
    if ip.is_loopback() {
        return if allow_lan_and_loopback {
            Ok(())
        } else {
            Err("loopback-blocked".into())
        };
    }
    // fc00::/7 unique local addresses.
    if (seg[0] & 0xfe00) == 0xfc00 {
        return if allow_lan_and_loopback {
            Ok(())
        } else {
            Err("internal-ip-blocked".into())
        };
    }
    Ok(())
}

pub(crate) fn check_ip(ip: IpAddr, allow_lan_and_loopback: bool) -> Result<(), String> {
    match ip {
        IpAddr::V4(v4) => is_disallowed_ipv4(v4, allow_lan_and_loopback),
        IpAddr::V6(v6) => is_disallowed_ipv6(v6, allow_lan_and_loopback),
    }
}

fn check_host(parsed: &url::Url, allow_lan_and_loopback: bool) -> Result<(), String> {
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("userinfo-blocked".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "no-host".to_string())?;
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        return check_ip(ip, allow_lan_and_loopback);
    }
    let lower = trimmed.trim_end_matches('.').to_ascii_lowercase();
    if lower == "metadata.google.internal" || lower == "169.254.169.254" {
        return Err("internal-ip-blocked".into());
    }
    if !allow_lan_and_loopback
        && (lower == "localhost"
            || lower.ends_with(".localhost")
            || lower.ends_with(".local")
            || lower.ends_with(".internal"))
    {
        return Err("local-hostname-blocked".into());
    }
    Ok(())
}

pub(crate) fn check_http_url(parsed: &url::Url, allow_lan_and_loopback: bool) -> Result<(), String> {
    match parsed.scheme() {
        "http" | "https" => check_host(parsed, allow_lan_and_loopback),
        _ => Err("scheme-not-allowed".into()),
    }
}

pub(crate) async fn resolve_and_validate_http_target(
    parsed: &url::Url,
    allow_lan_and_loopback: bool,
) -> Result<(String, Vec<SocketAddr>), String> {
    check_http_url(parsed, allow_lan_and_loopback)?;
    let host = parsed
        .host_str()
        .ok_or_else(|| "no-host".to_string())?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| "no-port".to_string())?;
    let trimmed = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = trimmed.parse::<IpAddr>() {
        check_ip(ip, allow_lan_and_loopback)?;
        return Ok((trimmed.to_string(), vec![SocketAddr::new(ip, port)]));
    }
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((trimmed, port))
        .await
        .map_err(|_| "dns-lookup-failed".to_string())?
        .collect();
    if addrs.is_empty() {
        return Err("dns-empty".into());
    }
    for addr in &addrs {
        check_ip(addr.ip(), allow_lan_and_loopback)?;
    }
    Ok((trimmed.to_string(), addrs))
}

pub(crate) fn build_pinned_http_client(
    host: &str,
    addrs: &[SocketAddr],
    connect_timeout: Duration,
    total_timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(connect_timeout);
    if let Some(t) = total_timeout {
        builder = builder.timeout(t);
    }
    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve_to_addrs(host, addrs);
    }
    builder.build().map_err(|e| e.to_string())
}

/// Validates a currently-playing media source for reading container subtitle indexes.
/// Supports local files, loopback torrent/proxy streams, LAN media servers, and HTTPS/HTTP streams
/// while still blocking cloud metadata and link-local addresses.
pub(crate) fn validate_playback_media_url(source: &str) -> Result<(), String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("empty-media-url".into());
    }
    if local_file_path(trimmed).is_some() {
        return Ok(());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("file://") {
        return Err("invalid-local-path".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "invalid-url".to_string())?;
    check_http_url(&parsed, true)
}

/// Validates an external subtitle download URL. Blocks private/loopback networks unless
/// `allow_local_trusted` is explicitly enabled for a user-installed local addon.
pub(crate) fn validate_subtitle_candidate_url(
    url_str: &str,
    allow_local_trusted: bool,
) -> Result<url::Url, String> {
    let trimmed = url_str.trim();
    if trimmed.is_empty() {
        return Err("empty-subtitle-url".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "invalid-url".to_string())?;
    check_http_url(&parsed, allow_local_trusted)?;
    Ok(parsed)
}

fn has_ctl(s: &str) -> bool {
    s.chars().any(|c| c.is_control())
}

pub(crate) fn safe_header_blob(headers: &HashMap<String, String>) -> String {
    let mut blob = String::new();
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if lk == "user-agent" || HOP_BY_HOP.contains(&lk.as_str()) || has_ctl(k) || has_ctl(v) {
            continue;
        }
        blob.push_str(&format!("{}: {}\r\n", k, v));
    }
    blob
}

pub(crate) fn safe_reqwest_headers(
    headers: &HashMap<String, String>,
    skip_range_and_encoding: bool,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (k, v) in headers {
        let lk = k.to_ascii_lowercase();
        if HOP_BY_HOP.contains(&lk.as_str()) || has_ctl(k) || has_ctl(v) {
            continue;
        }
        if lk == "x-harbor-subtitle-credential" || lk == "x-harbor-subtitle-public-network" {
            continue;
        }
        if skip_range_and_encoding && (lk == "range" || lk == "accept-encoding") {
            continue;
        }
        out.push((k.clone(), v.clone()));
    }
    out
}

pub(crate) fn user_agent(headers: &HashMap<String, String>) -> Option<String> {
    headers
        .iter()
        .find(|(k, v)| k.eq_ignore_ascii_case("user-agent") && !has_ctl(v))
        .map(|(_, v)| v.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn playback_allows_local_torrent_lan_and_remote_while_blocking_link_local() {
        #[cfg(windows)]
        assert!(validate_playback_media_url("file:///C:/movies/test.mkv").is_ok());
        #[cfg(not(windows))]
        assert!(validate_playback_media_url("file:///movies/test.mkv").is_ok());
        assert!(validate_playback_media_url("C:\\movies\\test.mkv").is_ok());
        assert!(validate_playback_media_url("/movies/test.mkv").is_ok());
        assert!(validate_playback_media_url("http://127.0.0.1:11470/stream/abc/0").is_ok());
        assert!(validate_playback_media_url("http://localhost:8096/Items/1/Download").is_ok());
        assert!(validate_playback_media_url("http://192.168.1.50:32400/library/parts/1/file.mkv").is_ok());
        assert!(validate_playback_media_url("https://cdn.example.com/a.mkv").is_ok());
        assert!(validate_playback_media_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_playback_media_url("http://[fe80::1]/x.mkv").is_err());
        assert!(validate_playback_media_url("ftp://example.com/a.mkv").is_err());
    }

    #[test]
    fn subtitle_candidate_url_respects_local_trusted_flag() {
        assert!(validate_subtitle_candidate_url("https://dl.opensubtitles.org/en.srt", false).is_ok());
        assert!(validate_subtitle_candidate_url("http://192.168.1.20/sub.srt", false).is_err());
        assert!(validate_subtitle_candidate_url("http://127.0.0.1:9000/sub.srt", false).is_err());
        assert!(validate_subtitle_candidate_url("http://192.168.1.20/sub.srt", true).is_ok());
        assert!(validate_subtitle_candidate_url("http://169.254.169.254/sub.srt", true).is_err());
    }

    #[test]
    fn header_blob_and_ua_strip_crlf_and_hop_by_hop() {
        let mut h = HashMap::new();
        h.insert("Referer".into(), "https://ok".into());
        h.insert("X-Bad".into(), "a\r\nHost: evil".into());
        h.insert("Connection".into(), "keep-alive".into());
        h.insert("User-Agent".into(), "UA\r\nX-Injected: 1".into());
        let blob = safe_header_blob(&h).to_lowercase();
        assert!(blob.contains("referer: https://ok"));
        assert!(!blob.contains("evil"));
        assert!(!blob.contains("connection"));
        assert!(user_agent(&h).is_none());
    }

    #[test]
    fn blocks_userinfo_multicast_this_network_and_trailing_dot_hosts() {
        assert!(validate_subtitle_candidate_url("https://user:pass@example.com/a.srt", true).is_err());
        assert!(validate_playback_media_url("http://user:pass@127.0.0.1:8080/a.mkv").is_err());
        assert!(validate_subtitle_candidate_url("http://224.0.0.1/a.srt", true).is_err());
        assert!(validate_playback_media_url("http://[ff02::1]/a.mkv").is_err());
        assert!(validate_subtitle_candidate_url("http://0.1.2.3/a.srt", true).is_err());
        assert!(validate_subtitle_candidate_url("http://localhost./a.srt", false).is_err());
        assert!(
            validate_subtitle_candidate_url("http://metadata.google.internal./latest", true)
                .is_err()
        );
    }

    #[tokio::test]
    async fn resolve_and_validate_pins_dns_and_blocks_loopback_when_disallowed() {
        let ip_url = url::Url::parse("http://127.0.0.1:8080/sub.srt").unwrap();
        assert!(resolve_and_validate_http_target(&ip_url, false).await.is_err());
        let (host, addrs) = resolve_and_validate_http_target(&ip_url, true)
            .await
            .expect("loopback allowed when opted in");
        assert_eq!(host, "127.0.0.1");
        assert_eq!(addrs, vec!["127.0.0.1:8080".parse().unwrap()]);

        let local_url = url::Url::parse("http://localhost:8080/sub.srt").unwrap();
        assert!(resolve_and_validate_http_target(&local_url, false).await.is_err());
        let resolved = resolve_and_validate_http_target(&local_url, true).await;
        if let Ok((resolved_host, resolved_addrs)) = resolved {
            assert_eq!(resolved_host, "localhost");
            assert!(!resolved_addrs.is_empty());
        }
    }
}
