use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use tokio::io::AsyncReadExt;

const EXTRACT_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_SRT_BYTES: usize = 4 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 4096;
const ASS_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ASS_BYTES: usize = 2 * 1024 * 1024;
const MAX_PROXY_REDIRECTS: usize = 5;
const FFMPEG_FORMAT_WHITELIST: &str =
    "matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpegts,mpeg,avi,ogg,asf,flv,srt,ass,webvtt";
const PROXY_ENV_VARS: &[&str] = &[
    "http_proxy",
    "HTTP_PROXY",
    "https_proxy",
    "HTTPS_PROXY",
    "all_proxy",
    "ALL_PROXY",
];

async fn cached_ffmpeg_path() -> Option<PathBuf> {
    static FFMPEG_PATH: tokio::sync::OnceCell<Option<PathBuf>> = tokio::sync::OnceCell::const_new();
    FFMPEG_PATH
        .get_or_init(|| async {
            tokio::task::spawn_blocking(crate::transcode::locate_ffmpeg)
                .await
                .ok()
                .flatten()
        })
        .await
        .clone()
}

enum ValidatedExtractSource {
    Local(PathBuf),
    RemoteHttp(url::Url),
}

fn is_playlist_url(parsed: &url::Url) -> bool {
    let lower = parsed.path().to_ascii_lowercase();
    lower.ends_with(".m3u8") || lower.ends_with(".m3u") || lower.ends_with(".mpd")
}

fn is_playlist_content_type(ct: &str) -> bool {
    let lower = ct.to_ascii_lowercase();
    lower.contains("mpegurl") || lower.contains("dash+xml")
}

fn is_playlist_prefix(prefix: &[u8]) -> bool {
    let trimmed = prefix.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(prefix);
    let start = trimmed
        .iter()
        .position(|b| !b.is_ascii_whitespace())
        .unwrap_or(trimmed.len());
    let s = &trimmed[start..];
    if s.is_empty() {
        return false;
    }
    let upper: Vec<u8> = s.iter().take(16).map(|b| b.to_ascii_uppercase()).collect();
    upper.starts_with(b"#EXTM3U") || upper.starts_with(b"FFCONCAT") || upper.starts_with(b"<MPD")
}

fn validate_extract_source(source: &str) -> Result<ValidatedExtractSource, String> {
    crate::subsync::url_guard::validate_playback_media_url(source)?;
    if let Some(path) = crate::subsync::url_guard::local_file_path(source) {
        Ok(ValidatedExtractSource::Local(path))
    } else {
        let parsed = url::Url::parse(source.trim()).map_err(|_| "invalid-url".to_string())?;
        if is_playlist_url(&parsed) {
            return Err("playlist-not-supported".to_string());
        }
        Ok(ValidatedExtractSource::RemoteHttp(parsed))
    }
}

struct ExtractProxyState {
    target_url: url::Url,
    headers: Vec<(String, String)>,
}

struct EphemeralExtractProxy {
    local_url: String,
    _shutdown: tokio::sync::oneshot::Sender<()>,
}

async fn proxy_extract_request(
    State(state): State<Arc<ExtractProxyState>>,
    method: Method,
    req_headers: HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }

    let range_header = req_headers
        .get(axum::http::header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let mut current_url = state.target_url.clone();
    let mut current_headers = state.headers.clone();
    let mut allow_local = crate::subsync::url_guard::is_explicit_local_or_lan_host(&current_url);

    for _ in 0..=MAX_PROXY_REDIRECTS {
        if is_playlist_url(&current_url) {
            return (StatusCode::FORBIDDEN, "playlist-not-supported").into_response();
        }
        let (host, addrs) = match crate::subsync::url_guard::resolve_and_validate_http_target(
            &current_url,
            allow_local,
        )
        .await
        {
            Ok(v) => v,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        if crate::subsync::url_guard::any_addr_is_public(&addrs) {
            allow_local = false;
        }
        let client = match crate::subsync::url_guard::build_pinned_http_client(
            &host,
            &addrs,
            Duration::from_secs(10),
            None,
            Some(Duration::from_secs(30)),
            true,
        ) {
            Ok(c) => c,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };

        let mut req = if method == Method::HEAD {
            client.head(current_url.as_str())
        } else {
            client.get(current_url.as_str())
        };
        req = req.header(reqwest::header::ACCEPT_ENCODING, "identity");
        for (k, v) in &current_headers {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some(ref r) = range_header {
            req = req.header(reqwest::header::RANGE, r.as_str());
        }

        let resp = match req.send().await {
            Ok(r) => r,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };

        let status_u16 = resp.status().as_u16();
        if matches!(status_u16, 301 | 302 | 303 | 307 | 308) {
            let Some(loc) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return StatusCode::BAD_GATEWAY.into_response();
            };
            let Ok(next) = current_url.join(loc) else {
                return StatusCode::BAD_GATEWAY.into_response();
            };
            if current_url.scheme() == "https" && next.scheme() != "https" {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            if !crate::subsync::url_guard::is_explicit_local_or_lan_host(&next) {
                allow_local = false;
            }
            if crate::subsync::url_guard::check_http_url(&next, allow_local).is_err() {
                return StatusCode::BAD_GATEWAY.into_response();
            }
            if !crate::http_redirect::same_origin(&current_url, &next) {
                current_headers
                    .retain(|(k, _)| crate::http_redirect::safe_cross_origin_header(k));
            }
            current_url = next;
            continue;
        }

        if let Some(ct) = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
        {
            if is_playlist_content_type(ct) {
                return (StatusCode::FORBIDDEN, "playlist-not-supported").into_response();
            }
        }
        if let Some(ce) = resp
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
        {
            if !ce.trim().is_empty() && !ce.trim().eq_ignore_ascii_case("identity") {
                return StatusCode::BAD_GATEWAY.into_response();
            }
        }

        let status = StatusCode::from_u16(status_u16).unwrap_or(StatusCode::BAD_GATEWAY);
        let mut builder = Response::builder().status(status);
        for name in [
            reqwest::header::CONTENT_TYPE,
            reqwest::header::CONTENT_LENGTH,
            reqwest::header::CONTENT_RANGE,
            reqwest::header::ACCEPT_RANGES,
        ] {
            if let Some(val) = resp.headers().get(&name) {
                builder = builder.header(name.as_str(), val.as_bytes());
            }
        }
        let body = if method == Method::HEAD {
            Body::empty()
        } else {
            let mut stream = resp.bytes_stream();
            let mut initial = Vec::new();
            loop {
                match stream.next().await {
                    Some(Ok(chunk)) => {
                        initial.extend_from_slice(&chunk);
                        let non_ws = initial
                            .strip_prefix(b"\xEF\xBB\xBF")
                            .unwrap_or(&initial)
                            .iter()
                            .filter(|b| !b.is_ascii_whitespace())
                            .count();
                        if non_ws >= 16 || initial.len() >= 256 {
                            break;
                        }
                    }
                    Some(Err(_)) => return StatusCode::BAD_GATEWAY.into_response(),
                    None => break,
                }
            }
            if is_playlist_prefix(&initial) {
                return (StatusCode::FORBIDDEN, "playlist-not-supported").into_response();
            }
            let head_chunks = if initial.is_empty() {
                Vec::new()
            } else {
                vec![Ok::<Bytes, reqwest::Error>(Bytes::from(initial))]
            };
            Body::from_stream(futures_util::stream::iter(head_chunks).chain(stream))
        };
        return builder
            .body(body)
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    StatusCode::BAD_GATEWAY.into_response()
}

async fn start_extract_proxy(
    target_url: url::Url,
    headers: Option<&HashMap<String, String>>,
) -> Result<EphemeralExtractProxy, String> {
    let safe_headers = headers
        .map(|h| crate::subsync::url_guard::safe_reqwest_headers(h, true))
        .unwrap_or_default();
    let state = Arc::new(ExtractProxyState {
        target_url,
        headers: safe_headers,
    });
    let token = uuid::Uuid::new_v4().to_string();
    let route_path = format!("/{}", token);
    let app = axum::Router::new()
        .route(&route_path, axum::routing::any(proxy_extract_request))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("extract proxy bind: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("extract proxy addr: {}", e))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await;
    });

    Ok(EphemeralExtractProxy {
        local_url: format!("http://127.0.0.1:{}/{}", addr.port(), token),
        _shutdown: tx,
    })
}

async fn prepare_ffmpeg_source(
    cmd: &mut tokio::process::Command,
    validated: &ValidatedExtractSource,
    headers: Option<&HashMap<String, String>>,
) -> Result<Option<EphemeralExtractProxy>, String> {
    for var in PROXY_ENV_VARS {
        cmd.env_remove(var);
    }
    cmd.kill_on_drop(true)
        .arg("-nostdin")
        .arg("-loglevel")
        .arg("error");
    match validated {
        ValidatedExtractSource::Local(path) => {
            cmd.arg("-protocol_whitelist")
                .arg("file")
                .arg("-i")
                .arg(path);
            Ok(None)
        }
        ValidatedExtractSource::RemoteHttp(url) => {
            let proxy = start_extract_proxy(url.clone(), headers).await?;
            cmd.arg("-protocol_whitelist")
                .arg("http,tcp")
                .arg("-format_whitelist")
                .arg(FFMPEG_FORMAT_WHITELIST)
                .arg("-i")
                .arg(&proxy.local_url);
            Ok(Some(proxy))
        }
    }
}

async fn read_capped_stdout(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut limited = (&mut reader).take((max_bytes + 1) as u64);
    let _ = limited.read_to_end(&mut out).await;
    if out.len() > max_bytes {
        return Err("subtitle exceeds maximum size".to_string());
    }
    Ok(out)
}

async fn drain_limited_stderr(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    max_bytes: usize,
) -> Vec<u8> {
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if out.len() < max_bytes {
                    let take = (max_bytes - out.len()).min(n);
                    out.extend_from_slice(&buf[..take]);
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn subtitle_extract(
    source: String,
    stream_index: Option<u32>,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let validated = validate_extract_source(&source)?;
    let ffmpeg = cached_ffmpeg_path()
        .await
        .ok_or_else(|| "ffmpeg not found".to_string())?;
    let map = format!("0:s:{}", stream_index.unwrap_or(0));
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    let _proxy = prepare_ffmpeg_source(&mut cmd, &validated, headers.as_ref()).await?;
    cmd.arg("-map")
        .arg(&map)
        .arg("-f")
        .arg("srt")
        .arg("-");
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    crate::proc_guard::configure_command(&mut cmd);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {}", e))?;
    crate::proc_guard::adopt(&child);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr not captured".to_string())?;

    let stderr_task = tokio::spawn(drain_limited_stderr(stderr, MAX_STDERR_BYTES));
    let io_future = async {
        let out_res = read_capped_stdout(stdout, MAX_SRT_BYTES).await;
        if out_res.is_err() {
            let _ = child.kill().await;
            let _ = child.wait().await;
            let err_bytes = stderr_task.await.unwrap_or_default();
            return (out_res, err_bytes, Ok(None));
        }
        let status = child.wait().await.map(Some);
        let err_bytes = stderr_task.await.unwrap_or_default();
        (out_res, err_bytes, status)
    };

    let (bytes_res, err_bytes, status_res) =
        match tokio::time::timeout(EXTRACT_TIMEOUT, io_future).await {
            Ok(tuple) => tuple,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err("subtitle extraction timed out".to_string());
            }
        };

    let bytes = bytes_res?;
    let status = status_res
        .map_err(|e| format!("ffmpeg wait: {}", e))?
        .ok_or_else(|| "subtitle exceeds maximum size".to_string())?;
    if !status.success() {
        let err = String::from_utf8_lossy(&err_bytes);
        return Err(format!(
            "ffmpeg failed: {}",
            err.chars().take(200).collect::<String>()
        ));
    }
    let text = crate::subsync::cue_parser::decode_subtitle_bytes(&bytes, None);
    if text.trim().is_empty() {
        return Err("no subtitle content extracted".to_string());
    }
    Ok(text)
}

#[tauri::command]
pub async fn subtitle_extract_ass(
    source: String,
    stream_index: Option<u32>,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let validated = validate_extract_source(&source)?;
    if let ValidatedExtractSource::Local(ref path) = validated {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext == "ass" || ext == "ssa" {
            let is_file = tokio::fs::metadata(path)
                .await
                .map(|m| m.is_file())
                .unwrap_or(false);
            if is_file {
                if let Ok(file) = tokio::fs::File::open(path).await {
                    let mut buf = Vec::new();
                    if file
                        .take(MAX_ASS_BYTES as u64)
                        .read_to_end(&mut buf)
                        .await
                        .is_ok()
                    {
                        let text = crate::subsync::cue_parser::decode_subtitle_bytes(&buf, None);
                        if !text.trim().is_empty() {
                            return Ok(text);
                        }
                    }
                }
            }
        }
    }

    let ffmpeg = cached_ffmpeg_path()
        .await
        .ok_or_else(|| "ffmpeg not found".to_string())?;
    let map = format!("0:s:{}", stream_index.unwrap_or(0));
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    let _proxy = prepare_ffmpeg_source(&mut cmd, &validated, headers.as_ref()).await?;
    cmd.arg("-t")
        .arg("180")
        .arg("-map")
        .arg(&map)
        .arg("-c:s")
        .arg("copy")
        .arg("-f")
        .arg("ass")
        .arg("-");
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    crate::proc_guard::configure_command(&mut cmd);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {}", e))?;
    crate::proc_guard::adopt(&child);
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout not captured".to_string())?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut dialogue_count = 0;
    let mut events_offset: Option<usize> = None;

    let read_future = async {
        while buf.len() < MAX_ASS_BYTES {
            let to_read = std::cmp::min(chunk.len(), MAX_ASS_BYTES - buf.len());
            let n = match stdout.read(&mut chunk[..to_read]).await {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            let start_scan = buf.len().saturating_sub(16);
            buf.extend_from_slice(&chunk[..n]);
            let scanned = String::from_utf8_lossy(&buf[start_scan..]);
            if events_offset.is_none()
                && (scanned.contains("[Events]") || scanned.contains("[events]"))
            {
                events_offset = Some(buf.len());
            }
            if let Some(ev_off) = events_offset {
                dialogue_count +=
                    scanned.matches("Dialogue:").count() + scanned.matches("dialogue:").count();
                if buf.len().saturating_sub(ev_off) >= 32 * 1024 || dialogue_count >= 40 {
                    break;
                }
            }
        }
    };

    let _ = tokio::time::timeout(ASS_HEADER_TIMEOUT, read_future).await;
    let _ = child.kill().await;
    let _ = child.wait().await;

    let text = crate::subsync::cue_parser::decode_subtitle_bytes(&buf, None);
    if text.contains("[V4+ Styles]") || text.contains("[V4 Styles]") {
        return Ok(text);
    }

    Err("no ass header extracted".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_extract_source_blocks_dangerous_schemes_and_imds() {
        assert!(validate_extract_source("concat:file:///etc/passwd").is_err());
        assert!(validate_extract_source("lavfi:testsrc").is_err());
        assert!(validate_extract_source("http://169.254.169.254/latest/meta-data").is_err());
        assert!(validate_extract_source("http://[fd00:ec2::254]/latest").is_err());
        assert!(validate_extract_source("https://cdn.example.com/movie.mkv").is_ok());
        assert!(validate_extract_source("http://127.0.0.1:11470/stream.mkv").is_ok());
    }

    #[tokio::test]
    async fn subtitle_extract_ass_decodes_utf16le_local_files() {
        let dir = std::env::temp_dir().join(format!("harbor-subext-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ass_path = dir.join("utf16.ass");
        let content = "[Script Info]\r\nPlayResY: 1080\r\n[V4+ Styles]\r\nStyle: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,2,2,10,10,10,1\r\n[Events]\r\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,你好\r\n";
        let mut bytes = vec![0xFFu8, 0xFEu8];
        for unit in content.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        std::fs::write(&ass_path, bytes).unwrap();

        let extracted = subtitle_extract_ass(ass_path.to_string_lossy().into_owned(), None, None)
            .await
            .expect("extract utf16 ass");
        assert!(extracted.contains("[V4+ Styles]"));
        assert!(extracted.contains("你好"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn proxy_rejects_playlist_payload_on_mkv_url() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = axum::Router::new().route(
            "/movie.mkv",
            axum::routing::get(|| async {
                (
                    [(axum::http::header::CONTENT_TYPE, "video/x-matroska")],
                    "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nhttp://169.254.169.254/latest\n",
                )
            }),
        );
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await;
        });

        let target = url::Url::parse(&format!("http://127.0.0.1:{}/movie.mkv", addr.port())).unwrap();
        let proxy = start_extract_proxy(target, None).await.unwrap();
        let resp = reqwest::get(&proxy.local_url).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::FORBIDDEN);
        let _ = tx.send(());
    }

    #[tokio::test]
    async fn proxy_strips_sensitive_headers_on_bounce_redirect_and_latches_allow_local() {
        use std::sync::Mutex;

        let seen_auth: Arc<Mutex<Vec<(String, Option<String>)>>> = Arc::new(Mutex::new(Vec::new()));

        let listener_a = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_a = listener_a.local_addr().unwrap();
        let listener_b = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_b = listener_b.local_addr().unwrap();

        let seen_a = seen_auth.clone();
        let url_b = format!("http://localhost:{}/bounce", addr_b.port());
        let app_a = axum::Router::new()
            .route(
                "/start",
                axum::routing::get(move |headers: HeaderMap| {
                    let seen = seen_a.clone();
                    let dest = url_b.clone();
                    async move {
                        seen.lock().unwrap().push((
                            "/start".into(),
                            headers
                                .get("authorization")
                                .and_then(|v| v.to_str().ok())
                                .map(str::to_string),
                        ));
                        axum::response::Redirect::temporary(&dest)
                    }
                }),
            )
            .route(
                "/bounced-back",
                axum::routing::get({
                    let seen = seen_auth.clone();
                    move |headers: HeaderMap| {
                        let seen = seen.clone();
                        async move {
                            seen.lock().unwrap().push((
                                "/bounced-back".into(),
                                headers
                                    .get("authorization")
                                    .and_then(|v| v.to_str().ok())
                                    .map(str::to_string),
                            ));
                            "OK_DATA_PAYLOAD_123456"
                        }
                    }
                }),
            );

        let url_back = format!("http://127.0.0.1:{}/bounced-back", addr_a.port());
        let app_b = axum::Router::new().route(
            "/bounce",
            axum::routing::get(move || async move { axum::response::Redirect::temporary(&url_back) }),
        );

        let (tx_a, rx_a) = tokio::sync::oneshot::channel::<()>();
        let (tx_b, rx_b) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener_a, app_a)
                .with_graceful_shutdown(async move {
                    let _ = rx_a.await;
                })
                .await;
        });
        tokio::spawn(async move {
            let _ = axum::serve(listener_b, app_b)
                .with_graceful_shutdown(async move {
                    let _ = rx_b.await;
                })
                .await;
        });

        let mut hdrs = HashMap::new();
        hdrs.insert("Authorization".into(), "Bearer secret".into());
        let target = url::Url::parse(&format!("http://127.0.0.1:{}/start", addr_a.port())).unwrap();
        let proxy = start_extract_proxy(target, Some(&hdrs)).await.unwrap();
        let resp = reqwest::get(&proxy.local_url).await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        let seen = seen_auth.lock().unwrap().clone();
        assert_eq!(seen[0], ("/start".into(), Some("Bearer secret".into())));
        assert_eq!(seen[1], ("/bounced-back".into(), None));

        // Redirecting from local host to non-local domain must latch allow_local = false
        // and reject a subsequent redirect to loopback.
        let listener_c = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr_c = listener_c.local_addr().unwrap();
        let app_c = axum::Router::new().route(
            "/to-public",
            axum::routing::get(|| async {
                axum::response::Redirect::temporary("https://nonexistent-public-example.com/movie.mkv")
            }),
        );
        let (tx_c, rx_c) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener_c, app_c)
                .with_graceful_shutdown(async move {
                    let _ = rx_c.await;
                })
                .await;
        });
        let target_c =
            url::Url::parse(&format!("http://127.0.0.1:{}/to-public", addr_c.port())).unwrap();
        let proxy_c = start_extract_proxy(target_c, None).await.unwrap();
        let resp_c = reqwest::get(&proxy_c.local_url).await.unwrap();
        assert_eq!(resp_c.status(), reqwest::StatusCode::BAD_GATEWAY);

        let _ = tx_a.send(());
        let _ = tx_b.send(());
        let _ = tx_c.send(());
    }
}
