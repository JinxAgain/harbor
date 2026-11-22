//! Subtitle cue parser (SRT, WebVTT, ASS/SSA, TTML), charset decoder, and ASS dialogue filter.
//!
//! Ported from NuvioMobile's `AutoSyncSubtitleCueParser.kt` and `AutoSyncAssDialogueFilter.kt`.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252};
use regex::Regex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SubtitleFormat {
    Srt,
    Vtt,
    Ass,
    Ssa,
    Ttml,
}

impl SubtitleFormat {
    pub fn ext(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::Ass => "ass",
            Self::Ssa => "ssa",
            Self::Ttml => "ttml",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubtitleCue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
    pub estimated_end: bool,
}

impl SubtitleCue {
    pub fn new(start_ms: i64, end_ms: i64, text: String) -> Self {
        Self {
            start_ms,
            end_ms,
            text,
            estimated_end: false,
        }
    }
}

const MIN_DIALOGUE_EVENTS: usize = 20;
const TYPESET_STYLE_RATIO: f64 = 0.5;
const MIN_DIALOGUE_DURATION_MS: i64 = 300;
const MAX_DIALOGUE_DURATION_MS: i64 = 12_000;
const BURST_WINDOW_MS: i64 = 1_000;
const BURST_MIN_STARTS: usize = 5;

struct AssStyle {
    name: String,
    alignment: Option<i32>,
}

struct AssEvent {
    start_ms: i64,
    end_ms: i64,
    style: String,
    name: String,
    effect: String,
    raw_text: String,
}

/// Decodes raw subtitle bytes into UTF-8 text with BOM detection, strict UTF-8 check,
/// and language-aware single-byte / CJK encoding fallback.
pub fn decode_subtitle_bytes(bytes: &[u8], language_hint: Option<&str>) -> String {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xff, 0xfe]) {
        let (decoded, _, _) = UTF_16LE.decode(&bytes[2..]);
        return decoded.into_owned();
    }
    if bytes.starts_with(&[0xfe, 0xff]) {
        let (decoded, _, _) = UTF_16BE.decode(&bytes[2..]);
        return decoded.into_owned();
    }
    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return utf8.to_string();
    }

    // Try UTF-8 only if lossless wasn't possible -> choose candidates informed by language hint.
    let lang = language_hint
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let mut candidate_labels: Vec<&'static [u8]> = Vec::new();
    match lang.split(['-', '_']).next().unwrap_or("") {
        "ar" | "ara" => candidate_labels.extend([b"windows-1256".as_slice(), b"iso-8859-6"]),
        "ru" | "rus" | "uk" | "ukr" | "bg" | "bul" | "sr" | "srp" | "mk" | "be" => {
            candidate_labels.extend([b"windows-1251".as_slice(), b"koi8-r"]);
        }
        "pl" | "pol" | "cs" | "ces" | "cze" | "sk" | "slk" | "hu" | "hun" | "ro" | "ron"
        | "hr" | "sl" => {
            candidate_labels.extend([b"windows-1250".as_slice(), b"iso-8859-2"]);
        }
        "el" | "ell" | "gre" => candidate_labels.extend([b"windows-1253".as_slice(), b"iso-8859-7"]),
        "tr" | "tur" => candidate_labels.extend([b"windows-1254".as_slice(), b"iso-8859-9"]),
        "he" | "heb" | "iw" => candidate_labels.extend([b"windows-1255".as_slice(), b"iso-8859-8"]),
        "vi" | "vie" => candidate_labels.push(b"windows-1258"),
        "th" | "tha" => candidate_labels.push(b"windows-874"),
        "ja" | "jpn" => candidate_labels.extend([b"shift_jis".as_slice(), b"euc-jp"]),
        "ko" | "kor" => candidate_labels.push(b"euc-kr"),
        "zh" | "zho" | "chi" => candidate_labels.extend([b"gbk".as_slice(), b"big5"]),
        _ => {}
    }
    candidate_labels.extend([
        b"windows-1252".as_slice(),
        b"windows-1250",
        b"windows-1251",
        b"windows-1256",
        b"shift_jis",
        b"gbk",
    ]);

    let (utf8_lossy, _, utf8_errors) = UTF_8.decode(bytes);
    if !utf8_errors {
        return utf8_lossy.into_owned();
    }

    let mut best_text = String::new();
    let mut best_errors = usize::MAX;
    let mut best_replacements = usize::MAX;
    for label in candidate_labels {
        let Some(enc) = Encoding::for_label(label) else {
            continue;
        };
        let (decoded, _, had_errors) = enc.decode(bytes);
        let replacements = decoded.chars().filter(|&c| c == '\u{FFFD}').count();
        let err_score = usize::from(had_errors);
        if (err_score, replacements) < (best_errors, best_replacements) {
            best_errors = err_score;
            best_replacements = replacements;
            best_text = decoded.into_owned();
            if err_score == 0 && replacements == 0 {
                return best_text;
            }
        }
    }
    if best_text.is_empty() {
        WINDOWS_1252.decode(bytes).0.into_owned()
    } else {
        best_text
    }
}

pub fn detect_format(source_url: Option<&str>, text: &str, format_hint: Option<&str>) -> SubtitleFormat {
    if let Some(hint) = format_hint {
        match hint.trim().to_ascii_lowercase().as_str() {
            "vtt" | "webvtt" => return SubtitleFormat::Vtt,
            "ass" => return SubtitleFormat::Ass,
            "ssa" => return SubtitleFormat::Ssa,
            "ttml" | "dfxp" | "xml" => return SubtitleFormat::Ttml,
            "srt" => return SubtitleFormat::Srt,
            _ => {}
        }
    }
    let clean = strip_bom_and_crlf(text);
    let path = source_url
        .unwrap_or("")
        .split(['?', '#'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let trimmed_start = clean.trim_start();
    if path.ends_with(".vtt") || path.ends_with(".webvtt") || trimmed_start.starts_with("WEBVTT") {
        return SubtitleFormat::Vtt;
    }
    if path.ends_with(".ssa") {
        return SubtitleFormat::Ssa;
    }
    if path.ends_with(".ass") || has_ass_events_header(&clean) {
        if has_ssa_styles_header(&clean) && !clean.contains("[V4+ Styles]") {
            return SubtitleFormat::Ssa;
        }
        return SubtitleFormat::Ass;
    }
    let head: String = clean.chars().take(512).collect();
    if path.ends_with(".ttml")
        || path.ends_with(".dfxp")
        || path.ends_with(".xml")
        || ttml_root_regex().is_match(&head)
    {
        return SubtitleFormat::Ttml;
    }
    SubtitleFormat::Srt
}

pub fn parse_subtitles(
    raw_text: &str,
    source_url: Option<&str>,
    format_hint: Option<&str>,
) -> (SubtitleFormat, Vec<SubtitleCue>) {
    let cleaned = strip_bom_and_crlf(raw_text);
    let format = detect_format(source_url, &cleaned, format_hint);
    let cues = match format {
        SubtitleFormat::Vtt => parse_vtt(&cleaned),
        SubtitleFormat::Ass | SubtitleFormat::Ssa => parse_ass(&cleaned),
        SubtitleFormat::Ttml => parse_ttml(&cleaned),
        SubtitleFormat::Srt => parse_srt(&cleaned),
    };
    (format, normalize_external_timeline(cues))
}

pub fn normalize_external_timeline(mut cues: Vec<SubtitleCue>) -> Vec<SubtitleCue> {
    if cues.len() < 2 {
        return cues;
    }
    cues.sort_by_key(|c| c.start_ms);
    let mut seen: HashSet<(i64, i64, String)> = HashSet::with_capacity(cues.len());
    let mut out = Vec::with_capacity(cues.len());
    for cue in cues {
        let key = (cue.start_ms, cue.end_ms, cue.text.clone());
        if seen.insert(key) {
            out.push(cue);
        }
    }
    out
}

/// Drops karaoke/signs/long non-dialogue events from Matroska indexed ASS/SSA cues when enough
/// dialogue cues remain, matching `AutoSyncAssDialogueFilter.indexedDialogueCues`.
pub fn filter_indexed_ass_dialogue_cues(mut cues: Vec<SubtitleCue>) -> Vec<SubtitleCue> {
    if cues.len() < MIN_DIALOGUE_EVENTS {
        return cues;
    }
    cues.sort_by_key(|c| c.start_ms);
    let starts: Vec<i64> = cues.iter().map(|c| c.start_ms).collect();
    let dialogue: Vec<SubtitleCue> = cues
        .iter()
        .enumerate()
        .filter(|(idx, cue)| {
            let duration_ms = cue.end_ms - cue.start_ms;
            if !cue.estimated_end
                && !(MIN_DIALOGUE_DURATION_MS..=MAX_DIALOGUE_DURATION_MS).contains(&duration_ms)
            {
                return false;
            }
            starts_within(&starts, *idx, BURST_WINDOW_MS) < BURST_MIN_STARTS
        })
        .map(|(_, cue)| cue.clone())
        .collect();
    if dialogue.len() < MIN_DIALOGUE_EVENTS {
        cues
    } else {
        dialogue
    }
}

fn starts_within(starts: &[i64], index: usize, radius_ms: i64) -> usize {
    let center = starts[index];
    let mut first = index;
    while first > 0 && center - starts[first - 1] <= radius_ms {
        first -= 1;
    }
    let mut last = index;
    while last + 1 < starts.len() && starts[last + 1] - center <= radius_ms {
        last += 1;
    }
    last - first + 1
}

fn strip_bom_and_crlf(raw: &str) -> String {
    raw.replace('\u{FEFF}', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

fn timestamp_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:([0-9]+):)?([0-9]{1,2}):([0-9]{2})(?:[.,]([0-9]+))?$").unwrap())
}

fn ass_override_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\{[^}]*\}").unwrap())
}

fn ass_events_header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?im)^[ \t]*\[Events\][ \t]*$").unwrap())
}

fn has_ass_events_header(text: &str) -> bool {
    ass_events_header_regex().is_match(text)
}

fn has_ssa_styles_header(text: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?im)^[ \t]*\[V4 Styles\][ \t]*$").unwrap());
    re.is_match(text)
}

fn ttml_root_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<tt[\s>]").unwrap())
}

fn non_dialogue_name_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[^a-z])(?:signs?|songs?|lyrics?|karaoke|kara|kfx|fx|op|ed|opening|ending|insert|romaji|kanji|title|eyecatch|preview|next|logo|credits?|staff|notes?|tl ?note|typeset|ts|ruby|furigana|screen|text)(?:$|[^a-z])",
        )
        .unwrap()
    })
}

fn dialogue_name_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:^|[^a-z])(?:default|main|dialog|dialogue|dial|italics?|flashback|thoughts?|internal|narrat\w*|overlap|top|alt|sub|subs|subtitles?)(?:$|[^a-z])",
        )
        .unwrap()
    })
}

fn typeset_tag_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"\\(?:pos|move|org|i?clip)\s*\(|\\t\s*\(|\\p[1-9]|\\[kK][fo]?[0-9]|\\fr[xyz]?-?[0-9]|\\fa[xy]",
        )
        .unwrap()
    })
}

fn parse_srt(text: &str) -> Vec<SubtitleCue> {
    static SEP: OnceLock<Regex> = OnceLock::new();
    let sep = SEP.get_or_init(|| Regex::new(r"\n\s*\n").unwrap());
    let mut cues = Vec::new();
    for block in sep.split(text) {
        let lines: Vec<&str> = block
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let mut idx = 0;
        if lines[idx].chars().all(|c| c.is_ascii_digit()) && idx + 1 < lines.len() {
            idx += 1;
        }
        let Some(&timing) = lines.get(idx) else {
            continue;
        };
        if !timing.contains("-->") {
            continue;
        }
        let Some((start_ms, end_ms)) = parse_start_end_time_ms(timing) else {
            continue;
        };
        if end_ms <= start_ms {
            continue;
        }
        let body = normalize_cue_text(&lines[idx + 1..].join("\n"));
        if body.is_empty() {
            continue;
        }
        cues.push(SubtitleCue::new(start_ms, end_ms, body));
    }
    cues
}

fn is_webvtt_metadata_header(line: &str) -> bool {
    line == "STYLE"
        || line == "REGION"
        || line == "NOTE"
        || line.starts_with("NOTE ")
        || line.starts_with("NOTE\t")
}

fn parse_vtt(text: &str) -> Vec<SubtitleCue> {
    let lines: Vec<&str> = text.lines().map(str::trim_end).collect();
    let mut cues = Vec::new();
    let mut cursor = 0usize;
    while cursor < lines.len() {
        let line = lines[cursor].trim();
        if line.is_empty() || line.starts_with("WEBVTT") {
            cursor += 1;
            continue;
        }
        if is_webvtt_metadata_header(line) {
            let next_line = lines.get(cursor + 1).map(|l| l.trim()).unwrap_or("");
            if next_line.is_empty() || !next_line.contains("-->") {
                cursor += 1;
                while cursor < lines.len() && !lines[cursor].trim().is_empty() {
                    cursor += 1;
                }
                if cursor < lines.len() {
                    cursor += 1;
                }
                continue;
            }
        }
        let mut timing_line = line;
        let mut text_start = cursor + 1;
        if !timing_line.contains("-->") {
            timing_line = lines.get(cursor + 1).map(|l| l.trim()).unwrap_or("");
            text_start = cursor + 2;
        }
        if !timing_line.contains("-->") {
            cursor += 1;
            continue;
        }
        let Some((start_ms, end_ms)) = parse_start_end_time_ms(timing_line) else {
            cursor += 1;
            continue;
        };
        if end_ms <= start_ms {
            cursor += 1;
            continue;
        }
        let mut text_parts = Vec::new();
        let mut i = text_start;
        while i < lines.len() && !lines[i].trim().is_empty() {
            text_parts.push(lines[i].trim());
            i += 1;
        }
        let body = normalize_cue_text(&text_parts.join("\n"));
        if !body.is_empty() {
            cues.push(SubtitleCue::new(start_ms, end_ms, body));
        }
        cursor = i + 1;
    }
    cues
}

fn parse_ass(text: &str) -> Vec<SubtitleCue> {
    let mut section = String::new();
    let mut format_fields: Option<Vec<String>> = None;
    let mut style_format_fields: Option<Vec<String>> = None;
    let mut styles = Vec::new();
    let mut events = Vec::new();

    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            section = line.to_ascii_lowercase();
            continue;
        }
        if section == "[events]" {
            if let Some(rest) = strip_prefix_ignore_case(line, "Format:") {
                format_fields = Some(rest.split(',').map(|s| s.trim().to_string()).collect());
            } else if let Some(rest) = strip_prefix_ignore_case(line, "Dialogue:") {
                if let Some(ev) = parse_ass_dialogue(rest, format_fields.as_deref()) {
                    events.push(ev);
                }
            }
        } else if section.contains("styles") {
            if let Some(rest) = strip_prefix_ignore_case(line, "Format:") {
                style_format_fields = Some(rest.split(',').map(|s| s.trim().to_string()).collect());
            } else if let Some(rest) = strip_prefix_ignore_case(line, "Style:") {
                if let Some(st) = parse_ass_style(
                    rest,
                    style_format_fields.as_deref(),
                    section == "[v4 styles]",
                ) {
                    styles.push(st);
                }
            }
        }
    }

    let dialogue = filter_ass_dialogue_events(&events, &styles);
    let override_re = ass_override_regex();
    let mut cues: Vec<SubtitleCue> = dialogue
        .into_iter()
        .filter_map(|event| {
            let stripped = override_re.replace_all(&event.raw_text, "");
            let replaced = stripped
                .replace("\\N", "\n")
                .replace("\\n", "\n")
                .replace("\\h", " ");
            let body = normalize_cue_text(&replaced);
            if body.is_empty() {
                None
            } else {
                Some(SubtitleCue::new(event.start_ms, event.end_ms, body))
            }
        })
        .collect();
    cues.sort_by_key(|c| c.start_ms);
    cues
}

fn strip_prefix_ignore_case<'a>(line: &'a str, prefix: &str) -> Option<&'a str> {
    let head = line.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        line.get(prefix.len()..)
    } else {
        None
    }
}

fn index_of_field(fields: &[String], name: &str) -> Option<usize> {
    fields.iter().position(|f| f.eq_ignore_ascii_case(name))
}

fn parse_ass_style(
    payload: &str,
    format_fields: Option<&[String]>,
    legacy_ssa: bool,
) -> Option<AssStyle> {
    let fields = format_fields.unwrap_or(&[]);
    let parts: Vec<&str> = payload.split(',').map(str::trim).collect();
    let name_idx = index_of_field(fields, "Name").unwrap_or(0);
    let align_idx = index_of_field(fields, "Alignment");
    let name = parts.get(name_idx).copied()?.trim();
    if name.is_empty() {
        return None;
    }
    let alignment = align_idx
        .and_then(|idx| parts.get(idx))
        .and_then(|s| s.parse::<i32>().ok())
        .map(|a| {
            if !legacy_ssa {
                a
            } else if (5..=7).contains(&a) {
                a + 2
            } else if (9..=11).contains(&a) {
                a - 5
            } else {
                a
            }
        });
    Some(AssStyle {
        name: name.to_string(),
        alignment,
    })
}

fn parse_ass_dialogue(payload: &str, format_fields: Option<&[String]>) -> Option<AssEvent> {
    const DEFAULT_FIELDS: usize = 10;
    let fields = format_fields.unwrap_or(&[]);
    let limit = if fields.is_empty() {
        DEFAULT_FIELDS
    } else {
        fields.len()
    };
    let parts: Vec<&str> = payload.splitn(limit, ',').map(str::trim).collect();
    let start_idx = index_of_field(fields, "Start").unwrap_or(1);
    let end_idx = index_of_field(fields, "End").unwrap_or(2);
    let style_idx = index_of_field(fields, "Style").unwrap_or(3);
    let name_idx = index_of_field(fields, "Name").unwrap_or(4);
    let effect_idx = index_of_field(fields, "Effect").unwrap_or(8);
    let text_idx = index_of_field(fields, "Text").unwrap_or(9);

    if parts.len() <= start_idx || parts.len() <= text_idx {
        return None;
    }
    let start_ms = parse_timestamp_ms(parts[start_idx])?;
    let end_ms = parts
        .get(end_idx)
        .and_then(|s| parse_timestamp_ms(s))
        .unwrap_or(start_ms + 3_000);
    if end_ms <= start_ms {
        return None;
    }
    Some(AssEvent {
        start_ms,
        end_ms,
        style: parts.get(style_idx).copied().unwrap_or("").to_string(),
        name: parts.get(name_idx).copied().unwrap_or("").to_string(),
        effect: parts.get(effect_idx).copied().unwrap_or("").to_string(),
        raw_text: parts[text_idx].to_string(),
    })
}

fn filter_ass_dialogue_events<'a>(
    events: &'a [AssEvent],
    styles: &[AssStyle],
) -> Vec<&'a AssEvent> {
    if events.len() < MIN_DIALOGUE_EVENTS {
        return events.iter().collect();
    }
    let mut styles_by_name: HashMap<String, &AssStyle> = HashMap::new();
    for s in styles {
        styles_by_name.insert(s.name.to_ascii_lowercase(), s);
    }
    let mut events_by_style: HashMap<String, Vec<&AssEvent>> = HashMap::new();
    for ev in events {
        events_by_style
            .entry(ev.style.to_ascii_lowercase())
            .or_default()
            .push(ev);
    }
    let mut dialogue_styles: HashSet<String> = HashSet::new();
    for (style_key, style_events) in &events_by_style {
        if is_dialogue_style(
            style_key,
            styles_by_name.get(style_key).copied(),
            style_events,
        ) {
            dialogue_styles.insert(style_key.clone());
        }
    }
    let filtered: Vec<&AssEvent> = events
        .iter()
        .filter(|ev| {
            dialogue_styles.contains(&ev.style.to_ascii_lowercase()) && is_dialogue_event(ev)
        })
        .collect();
    if filtered.len() < MIN_DIALOGUE_EVENTS {
        events.iter().collect()
    } else {
        filtered
    }
}

fn is_dialogue_style(name: &str, style: Option<&AssStyle>, events: &[&AssEvent]) -> bool {
    let named_dialogue = dialogue_name_regex().is_match(name);
    if !named_dialogue && non_dialogue_name_regex().is_match(name) {
        return false;
    }
    if !named_dialogue {
        if let Some(a) = style.and_then(|s| s.alignment) {
            if (4..=6).contains(&a) {
                return false;
            }
        }
    }
    let typeset_count = events
        .iter()
        .filter(|ev| typeset_tag_regex().is_match(&ev.raw_text))
        .count();
    (typeset_count as f64) < (events.len() as f64) * TYPESET_STYLE_RATIO
}

fn is_dialogue_event(event: &AssEvent) -> bool {
    if !event.effect.trim().is_empty() {
        return false;
    }
    let actor = event.name.to_ascii_lowercase();
    if !actor.is_empty()
        && !dialogue_name_regex().is_match(&actor)
        && non_dialogue_name_regex().is_match(&actor)
    {
        return false;
    }
    !typeset_tag_regex().is_match(&event.raw_text)
}

fn parse_ttml(text: &str) -> Vec<SubtitleCue> {
    static P_RE: OnceLock<Regex> = OnceLock::new();
    static BR_RE: OnceLock<Regex> = OnceLock::new();
    let frame_rate = parse_ttml_frame_rate(text);
    let p_re = P_RE.get_or_init(|| Regex::new(r"(?is)<p\b([^>]*)>(.*?)</p>").unwrap());
    let br_re = BR_RE.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").unwrap());
    let mut cues = Vec::new();
    for cap in p_re.captures_iter(text) {
        let attrs = &cap[1];
        let Some(start_raw) =
            attribute_value(attrs, "begin").or_else(|| attribute_value(attrs, "start"))
        else {
            continue;
        };
        let end_raw = attribute_value(attrs, "end");
        let Some(start_ms) = parse_ttml_timestamp(&start_raw, frame_rate) else {
            continue;
        };
        let end_ms = end_raw
            .as_deref()
            .and_then(|raw| parse_ttml_timestamp(raw, frame_rate))
            .or_else(|| {
                attribute_value(attrs, "dur")
                    .as_deref()
                    .and_then(|raw| parse_ttml_timestamp(raw, frame_rate))
                    .map(|dur| start_ms.saturating_add(dur))
            })
            .unwrap_or(start_ms + 3_000);
        if end_ms <= start_ms {
            continue;
        }
        let body = normalize_cue_text(&br_re.replace_all(&cap[2], "\n"));
        if !body.is_empty() {
            cues.push(SubtitleCue::new(start_ms, end_ms, body));
        }
    }
    cues.sort_by_key(|c| c.start_ms);
    cues
}

fn parse_ttml_frame_rate(text: &str) -> f64 {
    static TT_RE: OnceLock<Regex> = OnceLock::new();
    let tt_re = TT_RE.get_or_init(|| Regex::new(r"(?is)<tt\b([^>]*)>").unwrap());
    let attrs = tt_re
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str())
        .unwrap_or("");
    let base = attribute_value(attrs, "ttp:frameRate")
        .or_else(|| attribute_value(attrs, "frameRate"))
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(30.0);
    let mult = attribute_value(attrs, "ttp:frameRateMultiplier")
        .or_else(|| attribute_value(attrs, "frameRateMultiplier"))
        .and_then(|raw| {
            let parts: Vec<&str> = raw.split_whitespace().collect();
            if parts.len() == 2 {
                let n = parts[0].parse::<f64>().ok()?;
                let d = parts[1].parse::<f64>().ok()?;
                if d > 0.0 {
                    Some(n / d)
                } else {
                    None
                }
            } else {
                None
            }
        })
        .unwrap_or(1.0);
    let effective = base * mult;
    if effective.is_finite() && effective > 0.0 {
        effective
    } else {
        30.0
    }
}

fn parse_ttml_timestamp(raw: &str, frame_rate: f64) -> Option<i64> {
    static UNIT_RE: OnceLock<Regex> = OnceLock::new();
    let cleaned = raw.trim().split_whitespace().next()?;
    if cleaned.is_empty() {
        return None;
    }
    if let Some(ms) = parse_clock_with_frames(cleaned, frame_rate) {
        return Some(ms);
    }
    if let Some(ms) = parse_timestamp_ms(cleaned) {
        return Some(ms);
    }
    let unit_re =
        UNIT_RE.get_or_init(|| Regex::new(r"(?i)^([0-9]+(?:\.[0-9]+)?)(ms|h|m|s)$").unwrap());
    let cap = unit_re.captures(cleaned)?;
    let val = cap[1].parse::<f64>().ok()?;
    let mult = match cap[2].to_ascii_lowercase().as_str() {
        "h" => 3_600_000.0,
        "m" => 60_000.0,
        "s" => 1_000.0,
        "ms" => 1.0,
        _ => return None,
    };
    Some(((val * mult) as i64).max(0))
}

fn parse_clock_with_frames(raw: &str, frame_rate: f64) -> Option<i64> {
    if !frame_rate.is_finite() || frame_rate <= 0.0 {
        return None;
    }
    let parts: Vec<&str> = raw.split(':').collect();
    if parts.len() != 4 {
        return None;
    }
    let hours: f64 = parts[0].parse().ok()?;
    let minutes: f64 = parts[1].parse().ok()?;
    let seconds: f64 = parts[2].parse().ok()?;
    let frames: f64 = parts[3].parse().ok()?;
    let ms = hours * 3_600_000.0 + minutes * 60_000.0 + seconds * 1_000.0 + frames * 1_000.0 / frame_rate;
    Some((ms as i64).max(0))
}

fn attribute_value(attrs: &str, name: &str) -> Option<String> {
    static ATTR_RE: OnceLock<Regex> = OnceLock::new();
    let re = ATTR_RE.get_or_init(|| {
        Regex::new(r#"(?:^|\s)([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap()
    });
    for cap in re.captures_iter(attrs) {
        let Some(attr_name) = cap.get(1).map(|m| m.as_str()) else {
            continue;
        };
        if attr_name.eq_ignore_ascii_case(name) {
            let raw_val = cap
                .get(2)
                .or_else(|| cap.get(3))
                .map(|m| m.as_str().trim())
                .unwrap_or("");
            return if raw_val.is_empty() {
                None
            } else {
                Some(raw_val.to_string())
            };
        }
    }
    None
}

fn parse_start_end_time_ms(timing_line: &str) -> Option<(i64, i64)> {
    let (left, right) = timing_line.split_once("-->")?;
    let start_tok = left.trim().split_whitespace().next()?;
    let end_tok = right.trim().split_whitespace().next()?;
    Some((parse_timestamp_ms(start_tok)?, parse_timestamp_ms(end_tok)?))
}

pub(crate) fn parse_timestamp_ms(raw: &str) -> Option<i64> {
    let cap = timestamp_regex().captures(raw.trim())?;
    let hours: i64 = cap.get(1).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
    let minutes: i64 = cap[2].parse().ok()?;
    let seconds: i64 = cap[3].parse().ok()?;
    let millis = match cap.get(4).map(|m| m.as_str()) {
        None | Some("") => 0,
        Some(frac) => {
            let mut digits: String = frac.chars().take(3).collect();
            while digits.len() < 3 {
                digits.push('0');
            }
            digits.parse().unwrap_or(0)
        }
    };
    Some(((hours * 3600 + minutes * 60 + seconds) * 1000) + millis)
}

fn normalize_cue_text(text: &str) -> String {
    static VTT_TIME_TAG: OnceLock<Regex> = OnceLock::new();
    static HTML_TAG: OnceLock<Regex> = OnceLock::new();
    static WS_RE: OnceLock<Regex> = OnceLock::new();
    let vtt_tag = VTT_TIME_TAG
        .get_or_init(|| Regex::new(r"<(?:[0-9]+:)?[0-9]{1,2}:[0-9]{2}(?:[.,][0-9]+)?>").unwrap());
    let html_tag =
        HTML_TAG.get_or_init(|| Regex::new(r"</?[a-zA-Z0-9._-]+(?: [^>]*)?>").unwrap());
    let ws = WS_RE.get_or_init(|| Regex::new(r"[ \t]+").unwrap());

    let no_vtt = vtt_tag.replace_all(text, "");
    let no_html = html_tag.replace_all(&no_vtt, "");
    let unescaped = no_html
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"");

    unescaped
        .lines()
        .map(|l| ws.replace_all(l, " ").trim().to_string())
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_srt_and_vtt_cues() {
        let srt = "\u{FEFF}1\r\n00:00:01,500 --> 00:00:03,200\r\nHello world!\r\n\r\n2\r\n00:00:05,000 --> 00:00:07,000\r\n<i>Second</i> line\r\n";
        let (fmt, cues) = parse_subtitles(srt, Some("movie.srt"), None);
        assert_eq!(fmt, SubtitleFormat::Srt);
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_ms, 1500);
        assert_eq!(cues[1].text, "Second line");

        let vtt = "WEBVTT\n\nNOTE ignore me\n\n00:02.000 --> 00:04.500 align:middle\n<00:02.500>Hi there\n";
        let (vfmt, vcues) = parse_subtitles(vtt, None, None);
        assert_eq!(vfmt, SubtitleFormat::Vtt);
        assert_eq!(vcues.len(), 1);
        assert_eq!(vcues[0].start_ms, 2000);
        assert_eq!(vcues[0].end_ms, 4500);
        assert_eq!(vcues[0].text, "Hi there");
    }

    #[test]
    fn filters_ass_signs_and_karaoke_keeping_dialogue() {
        let mut ass = String::from(
            "[Script Info]\nTitle: Test\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, Alignment\nStyle: Default,Arial,20,2\nStyle: Signs,Arial,20,2\nStyle: MiddleTitle,Arial,20,5\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        );
        for i in 0..22 {
            let s = i * 3 + 1;
            ass.push_str(&format!(
                "Dialogue: 0,0:{:02}:{:02}.00,0:{:02}:{:02}.50,Default,,0,0,0,,Line {}\n",
                s / 60,
                s % 60,
                s / 60,
                s % 60,
                i
            ));
        }
        ass.push_str("Dialogue: 0,0:00:10.00,0:00:12.00,Signs,,0,0,0,,SIGN TEXT\n");
        ass.push_str("Dialogue: 0,0:00:12.00,0:00:14.00,MiddleTitle,,0,0,0,,EPISODE TITLE\n");
        ass.push_str("Dialogue: 0,0:00:14.00,0:00:15.00,Default,,0,0,0,,{\\pos(100,200)}Placed\n");
        ass.push_str("Dialogue: 0,0:00:15.00,0:00:16.00,Default,,0,0,0,Banner;10,Scroll text\n");

        let (fmt, cues) = parse_subtitles(&ass, Some("ep.ass"), None);
        assert_eq!(fmt, SubtitleFormat::Ass);
        assert_eq!(cues.len(), 22);
        assert!(cues.iter().all(|c| c.text.starts_with("Line ")));
    }

    #[test]
    fn decodes_legacy_encodings() {
        // "Café" in Windows-1252: 43 61 66 E9
        let decoded = decode_subtitle_bytes(b"Caf\xe9", Some("en"));
        assert_eq!(decoded, "Café");
    }

    #[test]
    fn parses_non_ascii_ass_arabic_digits_and_ttml_dur() {
        let ass = "[Script Info]\nTitle: AR\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nم\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,أهلا\n";
        let (fmt, cues) = parse_subtitles(ass, Some("ar.ass"), None);
        assert_eq!(fmt, SubtitleFormat::Ass);
        assert_eq!(cues.len(), 1);
        assert_eq!(cues[0].text, "أهلا");

        let srt = "1\n00:00:01,000 --> 00:00:02,000\nLine 1\n\n2\n٠٠:٠٠:٠٣,٠٠٠ --> ٠٠:٠٠:٠٤,٠٠٠\nArabic digits\n";
        let (_, scues) = parse_subtitles(srt, Some("ar.srt"), None);
        assert_eq!(scues.len(), 1);

        let ttml = r#"<tt xml:lang='en' ttp:frameRate='25'><body><div><p begin='1.5s' dur='2.25s'>Hello TTML</p></div></body></tt>"#;
        let (tfmt, tcues) = parse_subtitles(ttml, Some("sub.ttml"), None);
        assert_eq!(tfmt, SubtitleFormat::Ttml);
        assert_eq!(tcues.len(), 1);
        assert_eq!(tcues[0].start_ms, 1500);
        assert_eq!(tcues[0].end_ms, 3750);
    }
}
