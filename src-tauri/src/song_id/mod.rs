mod audd;
mod capture;
mod enrich;
mod gemini;
mod shazam;

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::LazyLock;
use std::time::Duration;
#[cfg(windows)]
use tauri::Emitter;
use tokio::sync::Notify;
use url::Url;

static ACTIVE_RUN_ID: AtomicU64 = AtomicU64::new(0);
static CANCEL_NOTIFY: LazyLock<Notify> = LazyLock::new(Notify::new);

fn bump_run_id() -> u64 {
    let next = ACTIVE_RUN_ID.fetch_add(1, Ordering::SeqCst) + 1;
    CANCEL_NOTIFY.notify_waiters();
    next
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_cancelled(run_id: u64) -> bool {
    ACTIVE_RUN_ID.load(Ordering::SeqCst) != run_id
}

#[cfg_attr(not(windows), allow(dead_code))]
async fn run_cancellable<T>(run_id: u64, fut: impl Future<Output = T>) -> Option<T> {
    let cancel = async {
        loop {
            let notified = CANCEL_NOTIFY.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if is_cancelled(run_id) {
                return;
            }
            notified.await;
            if is_cancelled(run_id) {
                return;
            }
        }
    };
    tokio::select! {
        biased;
        () = cancel => None,
        res = fut => Some(res),
    }
}

#[tauri::command]
pub fn cancel_song_identification() {
    bump_run_id();
}

pub(crate) static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35))
        .build()
        .expect("Failed to initialize shared song_id HTTP client")
});

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SongIdProvider {
    Shazam,
    Audd,
    Ai,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaContext {
    pub title: Option<String>,
    pub year: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentifyRequest {
    pub provider: SongIdProvider,
    pub seconds: Option<u32>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub context: Option<MediaContext>,
    pub gemini_grounding: Option<bool>,
    pub fallback_gemini_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongResult {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub artwork: String,
    pub link: String,
    pub provider: String,
}

pub(crate) fn sanitize_https_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let Ok(parsed) = Url::parse(trimmed) else {
        return String::new();
    };
    if parsed.scheme() == "https" && parsed.host_str().is_some() {
        parsed.to_string()
    } else {
        String::new()
    }
}

#[cfg(windows)]
fn emit_stage(app: &tauri::AppHandle, run_id: u64, stage: &str) {
    if !is_cancelled(run_id) {
        let _ = app.emit("harbor:song-id-stage", stage);
    }
}

#[cfg(windows)]
fn require_key(raw: Option<&str>, message: &str) -> Result<String, String> {
    raw.map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| message.to_string())
}

#[tauri::command]
pub async fn identify_now_playing(
    app: tauri::AppHandle,
    request: IdentifyRequest,
) -> Result<Option<SongResult>, String> {
    #[cfg(windows)]
    {
        let run_id = bump_run_id();
        emit_stage(&app, run_id, "capturing");
        let default_secs = match request.provider {
            SongIdProvider::Shazam => 7,
            SongIdProvider::Audd | SongIdProvider::Ai => 6,
        };
        let secs = request.seconds.unwrap_or(default_secs).clamp(3, 15);
        let Some(audio_res) =
            run_cancellable(run_id, capture::capture_audio(secs, run_id, &ACTIVE_RUN_ID)).await
        else {
            return Ok(None);
        };
        if is_cancelled(run_id) {
            return Ok(None);
        }
        let audio = audio_res?;
        capture::ensure_audible(&audio.samples_16k)?;

        emit_stage(&app, run_id, "identifying");
        let grounding = request.gemini_grounding.unwrap_or(true);
        let Some(identify_res) = run_cancellable(run_id, async move {
            let mut result = match request.provider {
                SongIdProvider::Shazam => {
                    let primary = shazam::recognize(&audio).await;
                    let fallback_key = request
                        .fallback_gemini_key
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string);
                    match (primary, fallback_key) {
                        (Ok(Some(song)), _) => Ok(Some(song)),
                        (Ok(None), Some(gemini_key)) => {
                            let wav = capture::encode_wav_16k_mono(&audio.samples_16k)?;
                            gemini::recognize(
                                wav,
                                gemini_key,
                                request.model.clone(),
                                request.context.as_ref(),
                                grounding,
                            )
                            .await
                        }
                        (Err(shazam_err), Some(gemini_key)) => {
                            let wav = capture::encode_wav_16k_mono(&audio.samples_16k)?;
                            match gemini::recognize(
                                wav,
                                gemini_key,
                                request.model.clone(),
                                request.context.as_ref(),
                                grounding,
                            )
                            .await
                            {
                                Ok(Some(song)) => Ok(Some(song)),
                                Ok(None) => Err(shazam_err),
                                Err(_) => Err(shazam_err),
                            }
                        }
                        (other, None) => other,
                    }
                }
                SongIdProvider::Audd => {
                    let token = require_key(request.api_key.as_deref(), "Missing AudD API token")?;
                    let wav = capture::encode_wav_16k_mono(&audio.samples_16k)?;
                    audd::recognize(wav, token).await
                }
                SongIdProvider::Ai => {
                    let key = require_key(request.api_key.as_deref(), "Missing Gemini API key")?;
                    let wav = capture::encode_wav_16k_mono(&audio.samples_16k)?;
                    gemini::recognize(
                        wav,
                        key,
                        request.model.clone(),
                        request.context.as_ref(),
                        grounding,
                    )
                    .await
                }
            }?;

            if let Some(ref mut song) = result {
                song.artwork = sanitize_https_url(&song.artwork);
                song.link = sanitize_https_url(&song.link);
                if song.artwork.is_empty() && !song.title.is_empty() {
                    enrich::fill_artwork(song).await;
                    song.artwork = sanitize_https_url(&song.artwork);
                }
            }
            Ok::<Option<SongResult>, String>(result)
        })
        .await
        else {
            return Ok(None);
        };
        identify_res
    }
    #[cfg(not(windows))]
    {
        let _ = (app, request);
        Err("Song identification is only supported on Windows for now".into())
    }
}

#[tauri::command]
pub async fn list_gemini_models(api_key: String) -> Result<Vec<String>, String> {
    gemini::list_models(api_key).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_https_url_accepts_only_https_with_host() {
        assert_eq!(
            sanitize_https_url("  https://www.shazam.com/track/123 "),
            "https://www.shazam.com/track/123"
        );
        assert_eq!(sanitize_https_url("http://example.com/art.jpg"), "");
        assert_eq!(sanitize_https_url("javascript:alert(1)"), "");
        assert_eq!(sanitize_https_url("file:///C:/Windows/System32/calc.exe"), "");
        assert_eq!(sanitize_https_url("ms-msdt:/id"), "");
        assert_eq!(sanitize_https_url("https://"), "");
        assert_eq!(sanitize_https_url("   "), "");
    }

    #[test]
    fn run_cancellable_completes_normally_and_aborts_on_cancel() {
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let run1 = bump_run_id();
            let done = run_cancellable(run1, async { 42usize }).await;
            assert_eq!(done, Some(42));

            let run2 = bump_run_id();
            let handle = tokio::spawn(run_cancellable(run2, std::future::pending::<()>()));
            tokio::task::yield_now().await;
            cancel_song_identification();
            assert_eq!(handle.await.expect("join"), None);
        });
    }
}
