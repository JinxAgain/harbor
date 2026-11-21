use super::{MediaContext, SongResult, HTTP_CLIENT};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::{json, Value};

const MODELS: [&str; 6] = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite",
];

const RETIRED: [&str; 9] = [
    "gemini-3.5-flash",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-exp",
    "gemini-1.5-flash",
    "gemini-1.5-flash-8b",
    "gemini-1.5-pro",
    "gemini-pro",
    "gemini-3-pro-preview",
];

const BASE_PROMPT: &str = "You are a music identification assistant. The audio is a short clip captured from a movie, show, or music player, so music may sit under dialogue or sound effects. Listen carefully to the melody, instrumentation, vocals, and any audible lyrics. Do NOT guess or invent a song if you are not confident: return empty strings for both artist and title whenever there is no clear recognizable music or you are uncertain. Reply with only a JSON object using the keys artist, title, and album. No prose, no code fence.";

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestMode {
    Full,
    NoSchema,
    Plain,
}

struct GErr {
    message: String,
    try_next: bool,
    bad_request: bool,
    rate_limited: bool,
}

impl GErr {
    fn hard(message: String) -> Self {
        GErr {
            message,
            try_next: false,
            bad_request: false,
            rate_limited: false,
        }
    }
}

pub fn thinking_config(model: &str) -> Value {
    let m = model.trim().to_ascii_lowercase();
    if m.starts_with("gemini-2.5-") {
        // 2.5 Pro rejects budget 0; Flash and Flash-Lite support 0 for minimum latency.
        let budget = if m.contains("-pro") { 128 } else { 0 };
        json!({ "thinkingBudget": budget })
    } else if m.starts_with("gemini-3.6-flash")
        || m.starts_with("gemini-3-flash-preview")
        || m.contains("flash-lite")
    {
        json!({ "thinkingLevel": "minimal" })
    } else {
        // gemini-3.8-flash and gemini-4-* reject "minimal" with HTTP 400.
        json!({ "thinkingLevel": "low" })
    }
}

pub fn model_chain(requested: Option<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Some(m) = requested
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
    {
        if !RETIRED.contains(&m.as_str()) {
            out.push(m);
        }
    }
    for m in MODELS {
        if !out.iter().any(|x| x == m) {
            out.push(m.to_string());
        }
    }
    out
}

pub(crate) fn build_prompt(context: Option<&MediaContext>) -> String {
    let Some(ctx) = context else {
        return BASE_PROMPT.to_string();
    };
    let title = ctx.title.as_deref().map(str::trim).unwrap_or("");
    if title.is_empty() {
        return BASE_PROMPT.to_string();
    }
    let mut meta_parts = vec![format!("\"{title}\"")];
    if let Some(year) = ctx.year.as_deref().map(str::trim).filter(|y| !y.is_empty()) {
        meta_parts.push(format!("({year})"));
    }
    if let (Some(season), Some(episode)) = (ctx.season, ctx.episode) {
        meta_parts.push(format!("S{season:02}E{episode:02}"));
    }
    format!(
        "{BASE_PROMPT} Playback context: the clip is from {}. Use this only to help verify soundtrack or needle-drop candidates; still return empty strings if the audio does not clearly match.",
        meta_parts.join(" ")
    )
}

fn build_body(
    audio: &str,
    model: &str,
    prompt: &str,
    grounding: bool,
    mode: RequestMode,
) -> Value {
    let mut cfg = json!({ "temperature": 0.0 });
    if mode != RequestMode::Plain {
        cfg["thinkingConfig"] = thinking_config(model);
    }
    if mode == RequestMode::Full {
        cfg["responseMimeType"] = json!("application/json");
        cfg["responseSchema"] = json!({
            "type": "OBJECT",
            "properties": {
                "artist": { "type": "STRING" },
                "title": { "type": "STRING" },
                "album": { "type": "STRING" }
            },
            "required": ["artist", "title"]
        });
    }

    let mut body = json!({
        "contents": [{
            "role": "user",
            "parts": [
                { "text": prompt },
                { "inlineData": { "mimeType": "audio/wav", "data": audio } }
            ]
        }],
        "generationConfig": cfg
    });
    if grounding && mode != RequestMode::Plain {
        body["tools"] = json!([{ "googleSearch": {} }]);
    }
    body
}

pub async fn recognize(
    wav: Vec<u8>,
    api_key: String,
    model: Option<String>,
    context: Option<&MediaContext>,
    grounding: bool,
) -> Result<Option<SongResult>, String> {
    let audio = B64.encode(&wav);
    let prompt = build_prompt(context);
    let mut grounding_blocked = false;
    let mut primary_err: Option<String> = None;
    let mut last_err = String::new();

    for (idx, m) in model_chain(model).into_iter().enumerate() {
        let mut use_grounding = grounding && !grounding_blocked;
        'retry_model: loop {
            let modes: &[RequestMode] = if use_grounding {
                &[RequestMode::Full, RequestMode::NoSchema, RequestMode::Plain]
            } else {
                &[RequestMode::Full, RequestMode::Plain]
            };

            let mut model_err: Option<String> = None;
            for &mode in modes {
                match attempt(&audio, &api_key, &m, &prompt, use_grounding, mode).await {
                    Ok(v) => return Ok(v),
                    Err(e) if e.rate_limited && use_grounding => {
                        // Google Search grounding uses a separate quota; retry the same model ungrounded.
                        grounding_blocked = true;
                        use_grounding = false;
                        last_err = e.message;
                        continue 'retry_model;
                    }
                    Err(e) if e.bad_request => {
                        model_err = Some(e.message.clone());
                        last_err = e.message;
                        continue;
                    }
                    Err(e) if e.try_next => {
                        model_err = Some(e.message.clone());
                        last_err = e.message;
                        break;
                    }
                    Err(e) => return Err(e.message),
                }
            }
            if idx == 0 {
                if let Some(err) = model_err {
                    primary_err = Some(err);
                }
            }
            break;
        }
    }

    Err(primary_err.unwrap_or_else(|| {
        if last_err.is_empty() {
            "Gemini has no usable model for this key".to_string()
        } else {
            last_err
        }
    }))
}

fn is_audio_gemini_model(id: &str) -> bool {
    let low = id.to_ascii_lowercase();
    if !low.starts_with("gemini-") || RETIRED.contains(&low.as_str()) {
        return false;
    }
    !(low.contains("embedding")
        || low.contains("imagen")
        || low.contains("veo")
        || low.contains("-tts")
        || low.contains("aqa")
        || low.contains("live")
        || low.contains("robotics")
        || low.contains("computer-use")
        || low.contains("customtools")
        || low.contains("deep-research")
        || low.ends_with("-image")
        || low.contains("-image-"))
}

pub(crate) fn parse_models_list(status: u16, raw: &str) -> Result<Vec<String>, String> {
    let json: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let msg = json["error"]["message"]
            .as_str()
            .unwrap_or_else(|| raw.trim())
            .to_string();
        return Err(classify(status, "models.list", msg).message);
    }

    let mut ids: Vec<String> = json["models"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    item["supportedGenerationMethods"]
                        .as_array()
                        .map(|methods| methods.iter().any(|m| m.as_str() == Some("generateContent")))
                        .unwrap_or(false)
                })
                .filter_map(|item| {
                    let full = item["name"].as_str()?;
                    let id = full.strip_prefix("models/").unwrap_or(full).trim();
                    is_audio_gemini_model(id).then(|| id.to_string())
                })
                .collect()
        })
        .unwrap_or_default();

    ids.sort();
    ids.dedup();
    ids.reverse();
    Ok(ids)
}

pub async fn list_models(api_key: String) -> Result<Vec<String>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Missing Gemini API key".to_string());
    }
    let resp = HTTP_CLIENT
        .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=100")
        .header("x-goog-api-key", key)
        .send()
        .await
        .map_err(|e| format!("Could not reach Gemini: {e}"))?;

    let status = resp.status().as_u16();
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Could not read the Gemini reply: {e}"))?;
    parse_models_list(status, &raw)
}

async fn attempt(
    audio: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
    grounding: bool,
    mode: RequestMode,
) -> Result<Option<SongResult>, GErr> {
    let body = build_body(audio, model, prompt, grounding, mode);
    let url =
        format!("https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent");
    let resp = HTTP_CLIENT
        .post(&url)
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| GErr::hard(format!("Could not reach Gemini: {e}")))?;

    let status = resp.status();
    let raw = resp
        .text()
        .await
        .map_err(|e| GErr::hard(format!("Could not read the Gemini reply: {e}")))?;
    let json: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);

    if !status.is_success() {
        let msg = json["error"]["message"]
            .as_str()
            .unwrap_or_else(|| raw.trim())
            .to_string();
        return Err(classify(status.as_u16(), model, msg));
    }

    if let Some(reason) = json["promptFeedback"]["blockReason"].as_str() {
        return Err(GErr::hard(format!("Gemini blocked the clip ({reason})")));
    }

    let text = collect_text(&json);
    let body = text.trim();
    let Some(parsed) = extract_json(body) else {
        let reason = json["candidates"][0]["finishReason"].as_str().unwrap_or("");
        if body.is_empty() {
            if !reason.is_empty() && reason != "STOP" {
                return Err(GErr {
                    message: format!(
                        "Gemini stopped without an answer ({reason}). Try a different scene."
                    ),
                    try_next: true,
                    bad_request: false,
                    rate_limited: false,
                });
            }
            return Ok(None);
        }
        let mut snip: String = body.chars().take(180).collect();
        if body.chars().count() > 180 {
            snip.push_str("...");
        }
        return Err(GErr {
            message: format!("Gemini replied without JSON: {snip}"),
            try_next: true,
            bad_request: false,
            rate_limited: false,
        });
    };
    let title = field(&parsed, "title");
    let artist = field(&parsed, "artist");
    let album = field(&parsed, "album");
    if title.is_empty() && artist.is_empty() {
        return Ok(None);
    }
    Ok(Some(SongResult {
        title,
        artist,
        album,
        artwork: String::new(),
        link: String::new(),
        provider: "ai".to_string(),
    }))
}

fn classify(status: u16, model: &str, msg: String) -> GErr {
    let low = msg.to_lowercase();
    match status {
        400 if low.contains("api key not valid") || low.contains("api_key_invalid") => GErr::hard(
            "Gemini rejected the API key. Paste a fresh key from aistudio.google.com into Settings."
                .to_string(),
        ),
        400 => GErr {
            message: format!("Gemini rejected the request: {msg}"),
            try_next: false,
            bad_request: true,
            rate_limited: false,
        },
        401 | 403 => GErr::hard(format!("Gemini denied this key: {msg}")),
        404 => GErr {
            message: format!("Gemini model {model} is unavailable: {msg}"),
            try_next: true,
            bad_request: false,
            rate_limited: false,
        },
        429 => GErr {
            message: format!(
                "Gemini quota or rate limit reached on {model}. Wait a moment and try again."
            ),
            try_next: true,
            bad_request: false,
            rate_limited: true,
        },
        500..=599 => GErr {
            message: format!("Gemini server error {status} on {model}. Try again."),
            try_next: true,
            bad_request: false,
            rate_limited: false,
        },
        _ => GErr::hard(format!("Gemini error {status}: {msg}")),
    }
}

fn collect_text(json: &Value) -> String {
    let mut out = String::new();
    if let Some(parts) = json["candidates"][0]["content"]["parts"].as_array() {
        for p in parts {
            if p["thought"].as_bool().unwrap_or(false) {
                continue;
            }
            if let Some(t) = p["text"].as_str() {
                out.push_str(t);
            }
        }
    }
    out
}

fn extract_json(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        if v.is_object() {
            return Some(v);
        }
    }
    let start = trimmed.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, ch) in trimmed[start..].char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return serde_json::from_str(&trimmed[start..start + i + ch.len_utf8()]).ok();
                }
            }
            _ => {}
        }
    }
    None
}

fn field(v: &Value, key: &str) -> String {
    let s = v[key].as_str().unwrap_or("").trim();
    match s.to_lowercase().as_str() {
        "unknown" | "n/a" | "na" | "none" | "null" | "unidentified" => String::new(),
        _ => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parts(v: Value) -> Value {
        json!({ "candidates": [{ "content": { "parts": v } }] })
    }

    #[test]
    fn wire_format_matches_documented_contract() {
        let prompt = build_prompt(Some(&MediaContext {
            title: Some("Stranger Things".into()),
            year: Some("2022".into()),
            season: Some(4),
            episode: Some(4),
        }));
        let b = build_body("QUJD", "gemini-3.8-flash", &prompt, true, RequestMode::Full);
        assert_eq!(b["contents"][0]["role"], "user");
        assert_eq!(
            b["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            "audio/wav"
        );
        assert_eq!(b["contents"][0]["parts"][1]["inlineData"]["data"], "QUJD");
        assert!(b["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Stranger Things"));
        assert!(b["contents"][0]["parts"][0]["text"]
            .as_str()
            .unwrap()
            .contains("S04E04"));
        assert_eq!(
            b["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "low"
        );
        assert_eq!(
            b["generationConfig"]["responseMimeType"],
            "application/json"
        );
        assert_eq!(b["generationConfig"]["responseSchema"]["type"], "OBJECT");
        assert_eq!(
            b["generationConfig"]["responseSchema"]["properties"]["title"]["type"],
            "STRING"
        );
        assert_eq!(
            b["generationConfig"]["responseSchema"]["required"][0],
            "artist"
        );
        assert!(b["tools"][0]["googleSearch"].is_object());
        assert!(b["contents"][0]["parts"][1]["inline_data"].is_null());
        assert!(b["contents"][0]["parts"][1]["inlineData"]["mime_type"].is_null());
    }

    #[test]
    fn thinking_config_respects_model_constraints() {
        assert_eq!(thinking_config("gemini-2.5-flash")["thinkingBudget"], 0);
        assert_eq!(thinking_config("gemini-2.5-flash-lite")["thinkingBudget"], 0);
        assert_eq!(thinking_config("gemini-2.5-pro")["thinkingBudget"], 128);
        assert_eq!(thinking_config("gemini-3.8-flash")["thinkingLevel"], "low");
        assert_eq!(thinking_config("gemini-4-argon")["thinkingLevel"], "low");
        assert_eq!(
            thinking_config("gemini-3.5-flash-lite")["thinkingLevel"],
            "minimal"
        );
        assert_eq!(
            thinking_config("gemini-3.6-flash")["thinkingLevel"],
            "minimal"
        );
        assert_eq!(
            thinking_config("gemini-3-flash-preview")["thinkingLevel"],
            "minimal"
        );
        assert_eq!(
            thinking_config("gemini-3.1-flash-lite")["thinkingLevel"],
            "minimal"
        );
    }

    #[test]
    fn unstructured_and_plain_bodies_drop_schema_and_tools_properly() {
        let b = build_body(
            "QUJD",
            "gemini-3.5-flash-lite",
            "prompt",
            true,
            RequestMode::NoSchema,
        );
        assert!(b["generationConfig"]["responseSchema"].is_null());
        assert!(b["generationConfig"]["responseMimeType"].is_null());
        assert_eq!(
            b["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "minimal"
        );
        assert!(b["tools"][0]["googleSearch"].is_object());

        let plain = build_body(
            "QUJD",
            "gemini-3.5-flash-lite",
            "prompt",
            true,
            RequestMode::Plain,
        );
        assert!(plain["tools"].is_null());
        assert!(plain["generationConfig"]["thinkingConfig"].is_null());
        assert_eq!(plain["contents"][0]["parts"][1]["inlineData"]["data"], "QUJD");
    }

    #[test]
    fn dead_models_are_never_requested() {
        let chain = model_chain(Some("gemini-3.5-flash".into()));
        assert!(!chain.iter().any(|m| RETIRED.contains(&m.as_str())));
        assert_eq!(chain[0], "gemini-2.5-flash");
        for dead in RETIRED {
            assert!(!model_chain(Some(dead.to_string())).contains(&dead.to_string()));
        }
    }

    #[test]
    fn model_chain_dedupes_and_honours_a_live_custom_model() {
        assert_eq!(
            model_chain(Some("gemini-2.5-flash".into())).len(),
            MODELS.len()
        );
        let c = model_chain(Some("  my-model  ".into()));
        assert_eq!(c[0], "my-model");
        assert_eq!(c.len(), MODELS.len() + 1);
        assert_eq!(model_chain(Some("   ".into()))[0], "gemini-2.5-flash");
        assert_eq!(model_chain(None)[0], "gemini-2.5-flash");
    }

    #[test]
    fn parse_models_list_filters_audio_capable_gemini_models() {
        let body = r#"{
            "models": [
                {"name": "models/gemini-2.5-flash", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.5-flash-lite", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-3-flash-preview", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.5-flash-preview-tts", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-embedding-001", "supportedGenerationMethods": ["embedContent"]},
                {"name": "models/imagen-3.0-generate-002", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.0-flash", "supportedGenerationMethods": ["generateContent"]},
                {"name": "models/gemini-2.5-pro", "supportedGenerationMethods": ["countTokens"]}
            ]
        }"#;
        let ids = parse_models_list(200, body).expect("models");
        assert_eq!(
            ids,
            vec![
                "gemini-3-flash-preview",
                "gemini-2.5-flash-lite",
                "gemini-2.5-flash"
            ]
        );
        let bad_key = parse_models_list(
            400,
            r#"{"error":{"message":"API key not valid. Please pass a valid API key."}}"#,
        )
        .unwrap_err();
        assert!(bad_key.contains("API key"));
    }

    #[test]
    fn collect_text_joins_parts_and_skips_thoughts() {
        let v = parts(json!([
            { "text": "ignore me", "thought": true },
            { "text": "{\"artist\":\"A\"," },
            { "text": "\"title\":\"B\"}" }
        ]));
        assert_eq!(collect_text(&v), "{\"artist\":\"A\",\"title\":\"B\"}");
    }

    #[test]
    fn collect_text_survives_missing_shapes() {
        assert_eq!(collect_text(&json!({})), "");
        assert_eq!(collect_text(&json!({ "candidates": [] })), "");
        assert_eq!(
            collect_text(&json!({ "candidates": [{ "finishReason": "SAFETY" }] })),
            ""
        );
        assert_eq!(collect_text(&parts(json!("not-an-array"))), "");
    }

    #[test]
    fn extract_json_handles_every_realistic_reply_shape() {
        let want = json!({ "artist": "Debussy", "title": "Clair de Lune" });
        let plain = "{\"artist\":\"Debussy\",\"title\":\"Clair de Lune\"}";
        assert_eq!(extract_json(plain).unwrap(), want);
        assert_eq!(
            extract_json(&format!("```json\n{plain}\n```")).unwrap(),
            want
        );
        assert_eq!(
            extract_json(&format!("Sure! {plain} Hope that helps.")).unwrap(),
            want
        );
        assert_eq!(extract_json(&format!("  \n{plain}\n  ")).unwrap(), want);
    }

    #[test]
    fn extract_json_survives_braces_inside_strings_and_nesting() {
        let tricky = r#"{"artist":"AC {DC}","title":"a \"quoted\" } brace","album":{"n":1}}"#;
        let v = extract_json(tricky).unwrap();
        assert_eq!(v["artist"], "AC {DC}");
        assert_eq!(v["title"], "a \"quoted\" } brace");
    }

    #[test]
    fn extract_json_returns_none_instead_of_panicking() {
        assert!(extract_json("").is_none());
        assert!(extract_json("   ").is_none());
        assert!(extract_json("no json at all").is_none());
        assert!(extract_json("{ unterminated").is_none());
        assert!(extract_json("[1,2,3]").is_none());
        assert!(extract_json("\"just a string\"").is_none());
        assert!(extract_json("héllo { wörld").is_none());
        assert!(extract_json("日本語のテキスト{壊れた").is_none());
    }

    #[test]
    fn field_normalises_placeholder_values() {
        let v =
            json!({ "a": "Unknown", "b": "  N/A ", "c": "  Real Name  ", "d": 7, "e": "none" });
        assert_eq!(field(&v, "a"), "");
        assert_eq!(field(&v, "b"), "");
        assert_eq!(field(&v, "c"), "Real Name");
        assert_eq!(field(&v, "d"), "");
        assert_eq!(field(&v, "e"), "");
        assert_eq!(field(&v, "missing"), "");
    }

    #[test]
    fn classify_routes_every_status_correctly() {
        assert!(classify(404, "m", "not found".into()).try_next);
        assert!(classify(400, "m", "bad schema".into()).bad_request);
        let key = classify(
            400,
            "m",
            "API key not valid. Please pass a valid API key.".into(),
        );
        assert!(!key.bad_request && !key.try_next);
        assert!(key.message.contains("API key"));
        for s in [401u16, 403] {
            let e = classify(s, "m", "x".into());
            assert!(
                !e.try_next && !e.bad_request,
                "status {s} must be a hard stop"
            );
        }
        for s in [429u16, 500, 503] {
            let e = classify(s, "m", "x".into());
            assert!(e.try_next, "status {s} must advance the chain");
            assert_eq!(e.rate_limited, s == 429);
        }
    }

    #[test]
    fn payload_stays_far_under_the_20mb_inline_cap() {
        let max_pcm = 16_000usize * 15 * 2;
        let b64 = (max_pcm + 44).div_ceil(3) * 4;
        assert!(
            b64 < 20 * 1024 * 1024,
            "worst case {b64} bytes exceeds the inline cap"
        );
    }
}
