mod audd;
mod capture;
mod enrich;
mod gemini;
mod shazam;

use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::Duration;
#[cfg(windows)]
use tauri::Emitter;
use url::Url;

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
fn emit_stage(app: &tauri::AppHandle, stage: &str) {
    let _ = app.emit("harbor:song-id-stage", stage);
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
        emit_stage(&app, "capturing");
        let default_secs = match request.provider {
            SongIdProvider::Shazam => 7,
            SongIdProvider::Audd | SongIdProvider::Ai => 6,
        };
        let secs = request.seconds.unwrap_or(default_secs).clamp(3, 15);
        let audio = capture::capture_audio(secs).await?;
        capture::ensure_audible(&audio.samples_16k)?;

        emit_stage(&app, "identifying");
        let grounding = request.gemini_grounding.unwrap_or(true);
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
        Ok(result)
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
}
