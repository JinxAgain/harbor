use std::collections::HashMap;
use std::time::Duration;

use crate::subsync::url_guard;

const CHUNK: u64 = 65536;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(serde::Serialize)]
pub struct MovieHash {
    pub hash: String,
    pub size: u64,
}

fn sum_u64_le(buf: &[u8]) -> u64 {
    let mut sum: u64 = 0;
    let mut i = 0;
    while i + 8 <= buf.len() {
        let mut v = [0u8; 8];
        v.copy_from_slice(&buf[i..i + 8]);
        sum = sum.wrapping_add(u64::from_le_bytes(v));
        i += 8;
    }
    sum
}

fn hash_from_ends(size: u64, head: &[u8], tail: &[u8]) -> String {
    let h = size
        .wrapping_add(sum_u64_le(head))
        .wrapping_add(sum_u64_le(tail));
    format!("{:016x}", h)
}

fn local_hash(path: &std::path::Path) -> Result<MovieHash, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).map_err(|e| format!("open: {}", e))?;
    let size = f.metadata().map_err(|e| format!("stat: {}", e))?.len();
    if size < CHUNK * 2 {
        return Err("file too small to hash".into());
    }
    let mut head = vec![0u8; CHUNK as usize];
    f.read_exact(&mut head)
        .map_err(|e| format!("read head: {}", e))?;
    f.seek(SeekFrom::Start(size - CHUNK))
        .map_err(|e| format!("seek: {}", e))?;
    let mut tail = vec![0u8; CHUNK as usize];
    f.read_exact(&mut tail)
        .map_err(|e| format!("read tail: {}", e))?;
    Ok(MovieHash {
        hash: hash_from_ends(size, &head, &tail),
        size,
    })
}

#[derive(Clone, Copy)]
struct ParsedContentRange {
    start: u64,
    total: Option<u64>,
}

fn parse_content_range(h: &str) -> Option<ParsedContentRange> {
    let trimmed = h.trim();
    let rest = trimmed.strip_prefix("bytes ")?.trim();
    let (range_part, total_part) = rest.split_once('/')?;
    let (start_s, _) = range_part.split_once('-')?;
    let start = start_s.trim().parse::<u64>().ok()?;
    let total = if total_part.trim() == "*" {
        None
    } else {
        Some(total_part.trim().parse::<u64>().ok()?)
    };
    Some(ParsedContentRange { start, total })
}

struct RangeChunkResult {
    final_url: url::Url,
    final_headers: Vec<(String, String)>,
    allow_local: bool,
    total_size: Option<u64>,
    body: Vec<u8>,
}

async fn range_get_bounded(
    initial_url: url::Url,
    initial_headers: Vec<(String, String)>,
    mut allow_local: bool,
    expected_start: u64,
) -> Result<RangeChunkResult, String> {
    let range_end = expected_start
        .checked_add(CHUNK - 1)
        .ok_or_else(|| "range overflow".to_string())?;
    let range_header = format!("bytes={expected_start}-{range_end}");

    let mut current_url = initial_url;
    let mut current_headers = initial_headers;
    let mut final_resp = None;

    for _hop in 0..=5 {
        let (host, addrs) =
            url_guard::resolve_and_validate_http_target(&current_url, allow_local).await?;
        if url_guard::any_addr_is_public(&addrs) {
            allow_local = false;
        }
        let client = url_guard::build_pinned_http_client(
            &host,
            &addrs,
            CONNECT_TIMEOUT,
            Some(REQUEST_TIMEOUT),
            true,
        )?;

        let mut req = client
            .get(current_url.clone())
            .header(reqwest::header::RANGE, &range_header)
            .header(reqwest::header::ACCEPT_ENCODING, "identity");
        for (k, v) in &current_headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let resp = req
            .send()
            .await
            .map_err(|e| format!("request: {}", e.without_url()))?;
        let status = resp.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect missing location".to_string())?;
            let next_url = current_url.join(loc).map_err(|e| e.to_string())?;
            if !url_guard::is_explicit_local_or_lan_host(&next_url) {
                allow_local = false;
            }
            url_guard::check_http_url(&next_url, allow_local)?;
            if current_url.scheme() == "https" && next_url.scheme() == "http" {
                return Err("https downgrade blocked".into());
            }
            if !crate::http_redirect::same_origin(&current_url, &next_url) {
                current_headers.retain(|(k, _)| crate::http_redirect::safe_cross_origin_header(k));
            }
            current_url = next_url;
            continue;
        }
        final_resp = Some(resp);
        break;
    }

    let mut resp = final_resp.ok_or_else(|| "too many redirects".to_string())?;
    if resp.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("range unsupported: {}", resp.status()));
    }
    if let Some(ce) = resp
        .headers()
        .get(reqwest::header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
    {
        if !ce.trim().is_empty() && !ce.trim().eq_ignore_ascii_case("identity") {
            return Err("compressed range response rejected".into());
        }
    }
    let cr = resp
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_range)
        .ok_or_else(|| "missing or invalid content-range".to_string())?;
    if cr.start != expected_start {
        return Err("unexpected content-range start".into());
    }

    let mut body = Vec::with_capacity(CHUNK as usize);
    while body.len() < CHUNK as usize {
        let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| format!("body: {}", e.without_url()))?
        else {
            break;
        };
        let need = (CHUNK as usize) - body.len();
        if chunk.len() >= need {
            body.extend_from_slice(&chunk[..need]);
            break;
        }
        body.extend_from_slice(&chunk);
    }
    if body.len() < CHUNK as usize {
        return Err("short range body".into());
    }

    Ok(RangeChunkResult {
        final_url: current_url,
        final_headers: current_headers,
        allow_local,
        total_size: cr.total,
        body,
    })
}

async fn http_hash(
    url: &str,
    headers: &HashMap<String, String>,
    size_hint: u64,
) -> Result<MovieHash, String> {
    url_guard::validate_playback_media_url(url)?;
    let parsed_url = url::Url::parse(url).map_err(|_| "invalid-url".to_string())?;
    let initial_allow_local = url_guard::is_explicit_local_or_lan_host(&parsed_url);
    let safe_hdrs = url_guard::safe_reqwest_headers(headers, true);

    let head = range_get_bounded(parsed_url, safe_hdrs, initial_allow_local, 0).await?;
    let size = if size_hint >= CHUNK * 2 {
        size_hint
    } else {
        head.total_size.ok_or_else(|| "unknown size".to_string())?
    };
    if size < CHUNK * 2 {
        return Err("file too small to hash".into());
    }

    let tail = range_get_bounded(
        head.final_url,
        head.final_headers,
        head.allow_local,
        size - CHUNK,
    )
    .await?;

    Ok(MovieHash {
        hash: hash_from_ends(size, &head.body[..CHUNK as usize], &tail.body[..CHUNK as usize]),
        size,
    })
}

#[tauri::command]
pub async fn compute_moviehash(
    url: String,
    headers: Option<HashMap<String, String>>,
    size: Option<u64>,
) -> Result<MovieHash, String> {
    url_guard::validate_playback_media_url(&url)?;
    if let Some(path) = url_guard::local_file_path(&url) {
        return tokio::task::spawn_blocking(move || local_hash(&path))
            .await
            .map_err(|e| format!("moviehash task failed: {e}"))?;
    }
    let hdrs = headers.unwrap_or_default();
    http_hash(&url, &hdrs, size.unwrap_or(0)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn zero_ends_hash_equals_size() {
        let head = vec![0u8; CHUNK as usize];
        let tail = vec![0u8; CHUNK as usize];
        assert_eq!(hash_from_ends(131072, &head, &tail), "0000000000020000");
    }

    #[test]
    fn wrapping_sum_matches_manual() {
        let buf = vec![1u8; CHUNK as usize];
        let per = 0x0101010101010101u64;
        let n = CHUNK / 8;
        let ones = per.wrapping_mul(n);
        let expect = 200000u64.wrapping_add(ones).wrapping_add(ones);
        assert_eq!(
            hash_from_ends(200000, &buf, &buf),
            format!("{:016x}", expect)
        );
    }

    #[tokio::test]
    async fn compute_moviehash_decodes_local_file_url_and_blocks_ssrf() {
        let dir = std::env::temp_dir().join(format!("harbor-hash-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("My Movie.mkv");
        let payload = vec![0x42u8; (CHUNK * 3) as usize];
        std::fs::write(&file_path, &payload).unwrap();
        let file_url = url::Url::from_file_path(&file_path).unwrap().to_string();
        assert!(file_url.contains("My%20Movie.mkv"));

        let res = compute_moviehash(file_url, None, None)
            .await
            .expect("hash percent-encoded file url");
        assert_eq!(res.size, CHUNK * 3);
        assert_eq!(
            res.hash,
            hash_from_ends(CHUNK * 3, &payload[..CHUNK as usize], &payload[..CHUNK as usize])
        );

        assert!(compute_moviehash("http://169.254.169.254/latest/meta-data".into(), None, None)
            .await
            .is_err());
        assert!(compute_moviehash("http://[fd00:ec2::254]/a.mkv".into(), None, None)
            .await
            .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn http_hash_strips_cross_origin_headers_and_caps_oversized_206() {
        use axum::{
            extract::Request,
            http::{HeaderMap, HeaderValue, StatusCode},
            response::IntoResponse,
            routing::get,
            Router,
        };

        let leaked_auth = Arc::new(AtomicBool::new(false));
        let leaked_auth_c = Arc::clone(&leaked_auth);

        let target_app = Router::new().route(
            "/media.mkv",
            get(move |req: Request| {
                let leaked_auth_inner = Arc::clone(&leaked_auth_c);
                async move {
                    if req.headers().contains_key("authorization") {
                        leaked_auth_inner.store(true, Ordering::SeqCst);
                    }
                    let range = req
                        .headers()
                        .get("range")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("bytes=0-65535");
                    let start: u64 = range
                        .strip_prefix("bytes=")
                        .and_then(|s| s.split_once('-'))
                        .and_then(|(a, _)| a.parse().ok())
                        .unwrap_or(0);
                    let total = CHUNK * 4;
                    let mut headers = HeaderMap::new();
                    headers.insert(
                        "content-range",
                        HeaderValue::from_str(&format!("bytes {start}-{}/{total}", start + CHUNK - 1))
                            .unwrap(),
                    );
                    // Send double CHUNK to verify the client stops after CHUNK without erroring.
                    (
                        StatusCode::PARTIAL_CONTENT,
                        headers,
                        vec![7u8; (CHUNK * 2) as usize],
                    )
                        .into_response()
                }
            }),
        );
        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target_listener.local_addr().unwrap();
        let target_task =
            tokio::spawn(async move { axum::serve(target_listener, target_app).await.unwrap() });

        let redir_app = Router::new().route(
            "/start.mkv",
            get(move || async move {
                (
                    StatusCode::FOUND,
                    [(
                        "location",
                        format!("http://127.0.0.1:{}/media.mkv", target_addr.port()),
                    )],
                )
                    .into_response()
            }),
        );
        let redir_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let redir_addr = redir_listener.local_addr().unwrap();
        let redir_task =
            tokio::spawn(async move { axum::serve(redir_listener, redir_app).await.unwrap() });

        let mut hdrs = HashMap::new();
        hdrs.insert("Authorization".into(), "Bearer secret-token".into());
        hdrs.insert("X-Harbor-Public-Network-Only".into(), "1".into());
        let res = http_hash(
            &format!("http://127.0.0.1:{}/start.mkv", redir_addr.port()),
            &hdrs,
            0,
        )
        .await
        .expect("cross-port local redirect hashes cleanly");
        assert!(!leaked_auth.load(Ordering::SeqCst));
        assert_eq!(res.size, CHUNK * 4);
        assert_eq!(
            res.hash,
            hash_from_ends(
                CHUNK * 4,
                &vec![7u8; CHUNK as usize],
                &vec![7u8; CHUNK as usize],
            )
        );

        target_task.abort();
        redir_task.abort();
    }
}
