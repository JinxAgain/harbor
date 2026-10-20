use std::collections::HashMap;
use std::time::Duration;
use tokio::io::AsyncReadExt;

const EXTRACT_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_SRT_BYTES: usize = 4 * 1024 * 1024;

#[tauri::command]
pub async fn subtitle_extract(
    source: String,
    stream_index: Option<u32>,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    let ffmpeg = crate::transcode::locate_ffmpeg().ok_or_else(|| "ffmpeg not found".to_string())?;
    let map = format!("0:s:{}", stream_index.unwrap_or(0));
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.arg("-nostdin").arg("-loglevel").arg("error");
    if let Some(h) = &headers {
        if let Some(ua) = h.get("User-Agent").or_else(|| h.get("user-agent")) {
            cmd.arg("-user_agent").arg(ua);
        }
    }
    cmd.arg("-i")
        .arg(&source)
        .arg("-map")
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
    let output = match tokio::time::timeout(EXTRACT_TIMEOUT, cmd.output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("ffmpeg spawn: {}", e)),
        Err(_) => return Err("subtitle extraction timed out".to_string()),
    };
    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "ffmpeg failed: {}",
            err.chars().take(200).collect::<String>()
        ));
    }
    let mut bytes = output.stdout;
    if bytes.len() > MAX_SRT_BYTES {
        bytes.truncate(MAX_SRT_BYTES);
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    if text.trim().is_empty() {
        return Err("no subtitle content extracted".to_string());
    }
    Ok(text)
}

const ASS_HEADER_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_ASS_BYTES: usize = 2 * 1024 * 1024;

fn local_ass_path(source: &str) -> Option<std::path::PathBuf> {
    let path = if source.starts_with("file://") {
        if let Ok(u) = url::Url::parse(source) {
            u.to_file_path().ok()
        } else {
            None
        }
    } else {
        Some(std::path::PathBuf::from(source))
    }?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if (ext == "ass" || ext == "ssa") && path.is_file() {
        Some(path)
    } else {
        None
    }
}

#[tauri::command]
pub async fn subtitle_extract_ass(
    source: String,
    stream_index: Option<u32>,
    headers: Option<HashMap<String, String>>,
) -> Result<String, String> {
    if let Some(path) = local_ass_path(&source) {
        if let Ok(file) = tokio::fs::File::open(&path).await {
            let mut buf = Vec::new();
            if file
                .take(MAX_ASS_BYTES as u64)
                .read_to_end(&mut buf)
                .await
                .is_ok()
            {
                let text = String::from_utf8_lossy(&buf).to_string();
                if !text.trim().is_empty() {
                    return Ok(text);
                }
            }
        }
    }

    let ffmpeg = crate::transcode::locate_ffmpeg().ok_or_else(|| "ffmpeg not found".to_string())?;
    let map = format!("0:s:{}", stream_index.unwrap_or(0));
    let mut cmd = tokio::process::Command::new(&ffmpeg);
    cmd.arg("-nostdin").arg("-loglevel").arg("error");
    if let Some(h) = &headers {
        if let Some(ua) = h.get("User-Agent").or_else(|| h.get("user-agent")) {
            cmd.arg("-user_agent").arg(ua);
        }
        let mut header_lines = String::new();
        for (k, v) in h {
            if k.eq_ignore_ascii_case("user-agent") {
                continue;
            }
            header_lines.push_str(&format!("{}: {}\r\n", k, v));
        }
        if !header_lines.is_empty() {
            cmd.arg("-headers").arg(header_lines);
        }
    }
    cmd.arg("-i")
        .arg(&source)
        .arg("-t")
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
        .stderr(std::process::Stdio::piped());

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

    let text = String::from_utf8_lossy(&buf).to_string();
    if text.contains("[V4+ Styles]") || text.contains("[V4 Styles]") {
        return Ok(text);
    }

    if let Ok(output) = child.wait_with_output().await {
        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            return Err(format!(
                "ffmpeg failed: {}",
                err.chars().take(200).collect::<String>()
            ));
        }
    }
    Err("no ass header extracted".to_string())
}
