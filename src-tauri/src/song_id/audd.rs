use super::{sanitize_https_url, SongResult, HTTP_CLIENT};
use reqwest::multipart::{Form, Part};
use serde_json::Value;

pub(crate) fn parse_response(status: u16, raw: &str) -> Result<Option<SongResult>, String> {
    if status == 429 {
        return Err("AudD rate limit reached. Wait a moment and try again.".to_string());
    }
    if !(200..300).contains(&status) {
        return Err(format!("AudD returned HTTP {status}"));
    }

    let json: Value =
        serde_json::from_str(raw).map_err(|e| format!("AudD response was unreadable: {e}"))?;
    if json["status"] != "success" {
        let msg = json["error"]["error_message"]
            .as_str()
            .unwrap_or("unknown error");
        return Err(format!("AudD: {msg}"));
    }

    let r = &json["result"];
    if r.is_null() {
        return Ok(None);
    }

    let title = r["title"].as_str().unwrap_or("").trim().to_string();
    let artist = r["artist"].as_str().unwrap_or("").trim().to_string();
    if title.is_empty() && artist.is_empty() {
        return Ok(None);
    }
    let album = r["album"].as_str().unwrap_or("").trim().to_string();
    let link = sanitize_https_url(r["song_link"].as_str().unwrap_or(""));

    let mut artwork = String::new();
    if let Some(u) = r["apple_music"]["artwork"]["url"].as_str() {
        artwork = sanitize_https_url(&u.replace("{w}", "300").replace("{h}", "300"));
    } else if let Some(u) = r["spotify"]["album"]["images"][0]["url"].as_str() {
        artwork = sanitize_https_url(u);
    }

    Ok(Some(SongResult {
        title,
        artist,
        album,
        artwork,
        link,
        provider: "audd".to_string(),
    }))
}

pub async fn recognize(wav: Vec<u8>, api_token: String) -> Result<Option<SongResult>, String> {
    let part = Part::bytes(wav)
        .file_name("clip.wav")
        .mime_str("audio/wav")
        .map_err(|e| e.to_string())?;
    let form = Form::new()
        .text("api_token", api_token)
        .text("return", "apple_music,spotify")
        .part("file", part);

    let resp = HTTP_CLIENT
        .post("https://api.audd.io/")
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("Could not reach AudD: {e}"))?;
    let status = resp.status().as_u16();
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Could not read AudD reply: {e}"))?;
    parse_response(status, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_response_rejects_non_2xx_and_extracts_valid_results() {
        assert!(parse_response(502, "<html>Bad Gateway</html>").is_err());
        assert!(parse_response(429, "rate limit").unwrap_err().contains("rate limit"));

        assert!(parse_response(200, r#"{"status":"success","result":null}"#)
            .expect("ok")
            .is_none());

        let ok = parse_response(
            200,
            r#"{
                "status": "success",
                "result": {
                    "title": "Time",
                    "artist": "Hans Zimmer",
                    "album": "Inception",
                    "song_link": "https://lis.tn/time",
                    "apple_music": {
                        "artwork": { "url": "https://is1.mzstatic.com/{w}x{h}.jpg" }
                    }
                }
            }"#,
        )
        .expect("ok")
        .expect("song");
        assert_eq!(ok.title, "Time");
        assert_eq!(ok.artist, "Hans Zimmer");
        assert_eq!(ok.artwork, "https://is1.mzstatic.com/300x300.jpg");
        assert_eq!(ok.link, "https://lis.tn/time");
        assert_eq!(ok.provider, "audd");
    }
}
