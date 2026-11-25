use reqwest::{
    header::{HeaderName, HeaderValue},
    Client, Url,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::OnceLock, time::Duration};

const PROBE_BUDGET: Duration = Duration::from_secs(8);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const BODY_CHUNK_TIMEOUT: Duration = Duration::from_secs(4);
const ERROR_BODY_TIMEOUT: Duration = Duration::from_secs(2);
const ERROR_BODY_MAX_BYTES: usize = 2048;
const DETAIL_MAX_CHARS: usize = 160;
const PLAYER_USER_AGENT: &str = "VLC/3.0.20 LibVLC/3.0.20";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbeArgs {
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbeResult {
    pub status: u16,
    pub host: String,
    pub via_host: Option<String>,
    pub reason: String,
    pub retry_after_sec: Option<u64>,
    pub detail: Option<String>,
}

fn client() -> Option<&'static Client> {
    static CLIENT: OnceLock<Option<Client>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(CONNECT_TIMEOUT)
                .timeout(PROBE_BUDGET)
                .build()
                .ok()
        })
        .as_ref()
}

fn format_host(url: &Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_string(),
    }
}

fn no_response(host: String) -> StreamProbeResult {
    StreamProbeResult {
        status: 0,
        host,
        via_host: None,
        reason: "no_response".to_string(),
        retry_after_sec: None,
        detail: None,
    }
}

fn header_str<'a>(headers: &'a reqwest::header::HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

fn is_restore_ongoing(headers: &reqwest::header::HeaderMap) -> bool {
    const RESTORE_HEADERS: &[&str] = &[
        "x-oss-restore",
        "x-amz-restore",
        "x-cos-restore",
        "x-obs-restore",
    ];
    RESTORE_HEADERS.iter().any(|name| {
        header_str(headers, name).is_some_and(|val| {
            let normalized = val.to_ascii_lowercase().replace(' ', "");
            normalized.contains("ongoing-request=\"true\"")
        })
    })
}

fn is_archive_storage_class(headers: &reqwest::header::HeaderMap) -> bool {
    const STORAGE_HEADERS: &[&str] = &[
        "x-oss-storage-class",
        "x-xos-storage-class",
        "x-amz-storage-class",
        "x-cos-storage-class",
        "x-obs-storage-class",
    ];
    STORAGE_HEADERS.iter().any(|name| {
        header_str(headers, name).is_some_and(|val| {
            matches!(
                val.trim().to_ascii_lowercase().as_str(),
                "archive"
                    | "coldarchive"
                    | "deepcoldarchive"
                    | "glacier"
                    | "deep_archive"
                    | "glacier_ir"
            )
        })
    })
}

fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    header_str(headers, "retry-after")?
        .trim()
        .parse::<u64>()
        .ok()
        .map(|secs| secs.clamp(5, 120))
}

fn sanitize_detail(raw: &str) -> Option<String> {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("<html")
        || lower.contains("<!doctype")
        || lower.contains("http://")
        || lower.contains("https://")
    {
        return None;
    }
    let truncated: String = trimmed.chars().take(DETAIL_MAX_CHARS).collect();
    Some(truncated)
}

async fn read_first_non_empty_chunk(response: &mut reqwest::Response) -> bool {
    let read_work = async {
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) if chunk.is_empty() => continue,
                Ok(Some(_)) => return true,
                Ok(None) | Err(_) => return false,
            }
        }
    };
    tokio::time::timeout(BODY_CHUNK_TIMEOUT, read_work)
        .await
        .unwrap_or(false)
}

async fn read_error_body(response: &mut reqwest::Response) -> String {
    let read_work = async {
        let mut buf = Vec::new();
        while buf.len() < ERROR_BODY_MAX_BYTES {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    let remaining = ERROR_BODY_MAX_BYTES - buf.len();
                    let take = chunk.len().min(remaining);
                    buf.extend_from_slice(&chunk[..take]);
                    if take < chunk.len() {
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    };
    tokio::time::timeout(ERROR_BODY_TIMEOUT, read_work)
        .await
        .unwrap_or_default()
}

pub(crate) async fn probe_with_client(
    client: &Client,
    url: &str,
    headers: Option<&HashMap<String, String>>,
) -> StreamProbeResult {
    let Ok(parsed) = Url::parse(url) else {
        return no_response(String::new());
    };
    if !matches!(parsed.scheme(), "http" | "https") {
        return no_response(format_host(&parsed));
    }

    let initial_host = format_host(&parsed);
    let mut builder = client.get(url);
    let mut has_user_agent = false;

    if let Some(caller_headers) = headers {
        for (name, value) in caller_headers {
            let lower = name.to_ascii_lowercase();
            if matches!(
                lower.as_str(),
                "range" | "accept-encoding" | "host" | "content-length"
            ) {
                continue;
            }
            let Ok(header_name) = HeaderName::from_bytes(name.as_bytes()) else {
                continue;
            };
            let Ok(header_value) = HeaderValue::from_str(value) else {
                continue;
            };
            if lower == "user-agent" {
                has_user_agent = true;
            }
            builder = builder.header(header_name, header_value);
        }
    }

    if !has_user_agent {
        builder = builder.header(reqwest::header::USER_AGENT, PLAYER_USER_AGENT);
    }
    builder = builder
        .header(reqwest::header::RANGE, "bytes=0-1023")
        .header(reqwest::header::ACCEPT_ENCODING, "identity");

    let Ok(Ok(mut response)) = tokio::time::timeout(
        PROBE_BUDGET,
        crate::http_redirect::send_get(client, builder, url),
    )
    .await
    else {
        return no_response(initial_host);
    };

    let status = response.status().as_u16();
    let final_host = format_host(response.url());
    let via_host = if !initial_host.is_empty() && final_host != initial_host {
        Some(initial_host)
    } else {
        None
    };

    let resp_headers = response.headers().clone();
    let retry_after_sec = parse_retry_after(&resp_headers);
    let restore_ongoing = is_restore_ongoing(&resp_headers);
    let archive_storage_class = is_archive_storage_class(&resp_headers);

    if restore_ongoing {
        return StreamProbeResult {
            status,
            host: final_host,
            via_host,
            reason: "archive_restoring".to_string(),
            retry_after_sec,
            detail: Some("Archive · Restoring".to_string()),
        };
    }

    if matches!(status, 200 | 206) {
        if read_first_non_empty_chunk(&mut response).await {
            return StreamProbeResult {
                status,
                host: final_host,
                via_host,
                reason: "ready".to_string(),
                retry_after_sec,
                detail: None,
            };
        }

        if archive_storage_class {
            return StreamProbeResult {
                status,
                host: final_host,
                via_host,
                reason: "archive_restoring".to_string(),
                retry_after_sec,
                detail: Some("Archive · Restoring".to_string()),
            };
        }

        return StreamProbeResult {
            status,
            host: final_host,
            via_host,
            reason: "truncated".to_string(),
            retry_after_sec,
            detail: None,
        };
    }

    if status >= 400 {
        let body = read_error_body(&mut response).await;
        let body_lower = body.to_ascii_lowercase();
        if body_lower.contains("invalidobjectstate")
            || body_lower.contains("restorealreadyinprogress")
            || (archive_storage_class && matches!(status, 403 | 409 | 503))
        {
            return StreamProbeResult {
                status,
                host: final_host,
                via_host,
                reason: "archive_restoring".to_string(),
                retry_after_sec,
                detail: Some("Archive · Restoring".to_string()),
            };
        }

        let is_plain_text = header_str(&resp_headers, "content-type")
            .is_some_and(|ct| ct.trim().to_ascii_lowercase().starts_with("text/plain"));
        let detail = header_str(&resp_headers, "x-xos-err-desc")
            .and_then(sanitize_detail)
            .or_else(|| {
                if is_plain_text {
                    sanitize_detail(&body)
                } else {
                    None
                }
            });

        return StreamProbeResult {
            status,
            host: final_host,
            via_host,
            reason: "http_error".to_string(),
            retry_after_sec,
            detail,
        };
    }

    StreamProbeResult {
        status,
        host: final_host,
        via_host,
        reason: "http_error".to_string(),
        retry_after_sec,
        detail: None,
    }
}

#[tauri::command]
pub async fn probe_stream_status(args: StreamProbeArgs) -> StreamProbeResult {
    let fallback_host = Url::parse(&args.url)
        .map(|u| format_host(&u))
        .unwrap_or_default();
    let Some(client) = client() else {
        return no_response(fallback_host);
    };
    probe_with_client(client, &args.url, args.headers.as_ref()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{http::StatusCode, routing::get, Router};

    struct Server {
        url: String,
        task: tokio::task::JoinHandle<()>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn serve(router: Router) -> Server {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        Server { url, task }
    }

    fn test_client() -> Client {
        Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap()
    }

    #[tokio::test]
    async fn detects_archive_restoring_across_redirect_when_206_closes_with_zero_bytes() {
        let cdn = serve(Router::new().route(
            "/download",
            get(|| async {
                axum::http::Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header("content-length", "1024")
                    .header("content-range", "bytes 0-1023/520660861")
                    .header("x-oss-storage-class", "Archive")
                    // Close immediately with 0 bytes despite Content-Length: 1024.
                    .body(axum::body::Body::empty())
                    .unwrap()
            }),
        ))
        .await;

        let cdn_url = format!("{}/download", cdn.url);
        let addon = serve(Router::new().route(
            "/play",
            get(move || {
                let target = cdn_url.clone();
                async move { (StatusCode::FOUND, [("location", target)]) }
            }),
        ))
        .await;

        let res = probe_with_client(&test_client(), &format!("{}/play", addon.url), None).await;
        assert_eq!(res.reason, "archive_restoring");
        assert_eq!(res.status, 206);
        assert_eq!(res.host, cdn.url.trim_start_matches("http://"));
        assert_eq!(
            res.via_host.as_deref(),
            Some(addon.url.trim_start_matches("http://"))
        );
        assert_eq!(res.detail.as_deref(), Some("Archive · Restoring"));
    }

    #[tokio::test]
    async fn detects_archive_restoring_from_ongoing_restore_header() {
        let server = serve(Router::new().route(
            "/file",
            get(|| async {
                axum::http::Response::builder()
                    .status(StatusCode::OK)
                    .header("x-oss-storage-class", "Archive")
                    .header("x-oss-restore", "ongoing-request=\"true\"")
                    .header("retry-after", "20")
                    .body(axum::body::Body::from("x"))
                    .unwrap()
            }),
        ))
        .await;

        let res = probe_with_client(&test_client(), &format!("{}/file", server.url), None).await;
        assert_eq!(res.reason, "archive_restoring");
        assert_eq!(res.status, 200);
        assert_eq!(res.retry_after_sec, Some(20));
    }

    #[tokio::test]
    async fn thawed_archive_file_returning_bytes_is_classified_as_ready() {
        let server = serve(Router::new().route(
            "/file",
            get(|| async {
                axum::http::Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header("content-range", "bytes 0-1023/520660861")
                    .header("x-oss-storage-class", "Archive")
                    .header(
                        "x-oss-restore",
                        "ongoing-request=\"false\", expiry-date=\"Wed, 25 Nov 2026 00:00:00 GMT\"",
                    )
                    .body(axum::body::Body::from(vec![0x1a, 0x45, 0xdf, 0xa3]))
                    .unwrap()
            }),
        ))
        .await;

        let res = probe_with_client(&test_client(), &format!("{}/file", server.url), None).await;
        assert_eq!(res.reason, "ready");
        assert_eq!(res.status, 206);
    }

    #[tokio::test]
    async fn zero_byte_206_without_archive_header_is_truncated() {
        let server = serve(Router::new().route(
            "/file",
            get(|| async {
                axum::http::Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header("content-length", "1024")
                    .body(axum::body::Body::empty())
                    .unwrap()
            }),
        ))
        .await;

        let res = probe_with_client(&test_client(), &format!("{}/file", server.url), None).await;
        assert_eq!(res.reason, "truncated");
        assert_eq!(res.status, 206);
    }

    #[tokio::test]
    async fn plain_text_504_returns_http_error_with_sanitized_detail() {
        let server = serve(Router::new().route(
            "/play",
            get(|| async {
                (
                    StatusCode::GATEWAY_TIMEOUT,
                    [("content-type", "text/plain; charset=utf-8")],
                    "Offline download timed out.\nPlease retry in a few moments.",
                )
            }),
        ))
        .await;

        let res = probe_with_client(&test_client(), &format!("{}/play", server.url), None).await;
        assert_eq!(res.reason, "http_error");
        assert_eq!(res.status, 504);
        assert_eq!(
            res.detail.as_deref(),
            Some("Offline download timed out. Please retry in a few moments.")
        );
    }

    #[tokio::test]
    async fn invalid_object_state_403_is_classified_as_archive_restoring() {
        let server = serve(Router::new().route(
            "/file",
            get(|| async {
                (
                    StatusCode::FORBIDDEN,
                    [("content-type", "application/xml")],
                    "<Error><Code>InvalidObjectState</Code><Message>The operation is not valid for the object's state</Message></Error>",
                )
            }),
        ))
        .await;

        let res = probe_with_client(&test_client(), &format!("{}/file", server.url), None).await;
        assert_eq!(res.reason, "archive_restoring");
        assert_eq!(res.status, 403);
    }

    #[tokio::test]
    async fn invalid_scheme_and_unreachable_port_return_no_response() {
        let res = probe_with_client(&test_client(), "file:///tmp/video.mkv", None).await;
        assert_eq!(res.reason, "no_response");
        assert_eq!(res.status, 0);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let res = probe_with_client(&test_client(), &format!("http://{addr}/play"), None).await;
        assert_eq!(res.reason, "no_response");
        assert_eq!(res.status, 0);
        assert_eq!(res.host, addr.to_string());
    }
}
