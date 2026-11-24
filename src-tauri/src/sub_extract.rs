use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::AsyncReadExt;

const EXTRACT_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_SRT_BYTES: usize = 4 * 1024 * 1024;
const MAX_STDERR_BYTES: usize = 4096;
const ASS_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ASS_BYTES: usize = 2 * 1024 * 1024;

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
    RemoteHttp(String),
}

fn validate_extract_source(source: &str) -> Result<ValidatedExtractSource, String> {
    crate::subsync::url_guard::validate_playback_media_url(source)?;
    if let Some(path) = crate::subsync::url_guard::local_file_path(source) {
        Ok(ValidatedExtractSource::Local(path))
    } else {
        Ok(ValidatedExtractSource::RemoteHttp(source.trim().to_string()))
    }
}

fn configure_ffmpeg_source(
    cmd: &mut tokio::process::Command,
    validated: &ValidatedExtractSource,
    headers: Option<&HashMap<String, String>>,
) {
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
        }
        ValidatedExtractSource::RemoteHttp(url) => {
            cmd.arg("-protocol_whitelist").arg("http,https,tcp,tls");
            if let Some(h) = headers {
                if let Some(ua) = crate::subsync::url_guard::user_agent(h) {
                    cmd.arg("-user_agent").arg(ua);
                }
                let header_blob = crate::subsync::url_guard::safe_header_blob(h);
                if !header_blob.is_empty() {
                    cmd.arg("-headers").arg(header_blob);
                }
            }
            cmd.arg("-i").arg(url);
        }
    }
}

async fn read_limited(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    max_bytes: usize,
) -> Vec<u8> {
    let mut out = Vec::new();
    let mut limited = (&mut reader).take(max_bytes as u64);
    let _ = limited.read_to_end(&mut out).await;
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
    configure_ffmpeg_source(&mut cmd, &validated, headers.as_ref());
    cmd.arg("-map")
        .arg(&map)
        .arg("-f")
        .arg("srt")
        .arg("-");
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {}", e))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout not captured".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr not captured".to_string())?;

    let io_future = async {
        let (out_bytes, err_bytes) = tokio::join!(
            read_limited(stdout, MAX_SRT_BYTES),
            read_limited(stderr, MAX_STDERR_BYTES)
        );
        let status = child.wait().await;
        (out_bytes, err_bytes, status)
    };

    let (bytes, err_bytes, status_res) = match tokio::time::timeout(EXTRACT_TIMEOUT, io_future).await
    {
        Ok(tuple) => tuple,
        Err(_) => {
            let _ = child.kill().await;
            return Err("subtitle extraction timed out".to_string());
        }
    };

    let status = status_res.map_err(|e| format!("ffmpeg wait: {}", e))?;
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
    configure_ffmpeg_source(&mut cmd, &validated, headers.as_ref());
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
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = cmd.spawn().map_err(|e| format!("ffmpeg spawn: {}", e))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout not captured".to_string())?;

    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut dialogue_count = 0;
    let mut has_events = false;

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
            if !has_events && (scanned.contains("[Events]") || scanned.contains("[events]")) {
                has_events = true;
            }
            if has_events {
                dialogue_count +=
                    scanned.matches("Dialogue:").count() + scanned.matches("dialogue:").count();
                if buf.len() >= 32 * 1024 || dialogue_count >= 40 {
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
}
