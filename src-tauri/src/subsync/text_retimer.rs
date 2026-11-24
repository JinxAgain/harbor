//! Lossless subtitle text retimer & piecewise boundary mapper.
//!
//! Ported from NuvioMobile's `AutoSyncTimelineTimeMapper.kt` and `AutoSyncSubtitleTextRetimer.kt`.
//! Rewrites only timestamp fields in SRT, WebVTT, and ASS/SSA, keeping all styles, fonts,
//! cue settings, override tags, comments, and markup untouched.

use regex::Regex;
use std::collections::{HashMap, VecDeque};
use std::sync::OnceLock;

use crate::subsync::aligner::TimelineRetimeResult;
#[cfg(test)]
use crate::subsync::cue_parser::detect_format;
use crate::subsync::cue_parser::{SubtitleCue, SubtitleFormat};

const ASS_DEFAULT_FIELD_COUNT: usize = 10;
const ASS_DEFAULT_START_INDEX: usize = 1;
const ASS_DEFAULT_END_INDEX: usize = 2;
const ASS_MIN_DURATION_MS: i64 = 10;

pub struct TimelineTimeMapper {
    exact_cues: HashMap<(i64, i64), VecDeque<(i64, i64)>>,
    anchors: Vec<(i64, i64)>,
    scale: f64,
    intercept_ms: f64,
    uniform_delay_only: bool,
}

impl TimelineTimeMapper {
    pub fn from_result(timeline: &TimelineRetimeResult) -> Self {
        let mut exact_cues: HashMap<(i64, i64), VecDeque<(i64, i64)>> =
            HashMap::with_capacity(timeline.cues.len());
        let mut raw_anchors: Vec<(i64, i64)> = Vec::with_capacity(timeline.cues.len() * 2);

        for c in &timeline.cues {
            exact_cues
                .entry((c.original_start_ms, c.original_end_ms))
                .or_default()
                .push_back((c.start_ms.max(0), c.end_ms.max(c.start_ms.saturating_add(1))));
            raw_anchors.push((c.original_start_ms, c.start_ms.max(0)));
            raw_anchors.push((c.original_end_ms, c.end_ms.max(c.start_ms.saturating_add(1))));
        }

        raw_anchors.sort_by_key(|a| a.0);
        let mut anchors: Vec<(i64, i64)> = Vec::with_capacity(raw_anchors.len());
        let mut idx = 0usize;
        while idx < raw_anchors.len() {
            let x = raw_anchors[idx].0;
            let mut sum_y = 0i128;
            let mut count = 0i128;
            while idx < raw_anchors.len() && raw_anchors[idx].0 == x {
                sum_y += i128::from(raw_anchors[idx].1);
                count += 1;
                idx += 1;
            }
            let avg_y = (sum_y / count) as i64;
            let clamped_y = anchors
                .last()
                .map(|&(_, prev_y)| avg_y.max(prev_y))
                .unwrap_or_else(|| avg_y.max(0));
            anchors.push((x, clamped_y));
        }

        let uniform_delay_only = (timeline.alignment_scale - 1.0).abs() <= 1e-6
            && (timeline.alignment_source == "sampled-delay"
                || timeline.alignment_source.contains("delay-only"));

        Self {
            exact_cues,
            anchors,
            scale: timeline.alignment_scale,
            intercept_ms: timeline.alignment_intercept_ms,
            uniform_delay_only,
        }
    }

    pub fn map_cue_interval(&mut self, orig_start_ms: i64, orig_end_ms: i64) -> (i64, i64) {
        if self.uniform_delay_only {
            let s = (((orig_start_ms as f64) + self.intercept_ms).round() as i64).max(0);
            let e = (((orig_end_ms as f64) + self.intercept_ms).round() as i64).max(s.saturating_add(1));
            return (s, e);
        }
        if let Some(queue) = self.exact_cues.get_mut(&(orig_start_ms, orig_end_ms)) {
            if let Some((s, e)) = queue.pop_front() {
                return (s, e);
            }
        }
        let s = self.map_continuous(orig_start_ms);
        let e = self.map_continuous(orig_end_ms).max(s.saturating_add(1));
        (s, e)
    }

    fn map_continuous(&self, original_ms: i64) -> i64 {
        if self.uniform_delay_only || self.anchors.is_empty() {
            return (((original_ms as f64) * self.scale + self.intercept_ms).round() as i64).max(0);
        }
        if original_ms <= self.anchors[0].0 {
            let (x0, y0) = self.anchors[0];
            return y0
                .saturating_add((((original_ms - x0) as f64) * self.scale).round() as i64)
                .max(0);
        }
        let last_idx = self.anchors.len() - 1;
        if original_ms >= self.anchors[last_idx].0 {
            let (xn, yn) = self.anchors[last_idx];
            return yn
                .saturating_add((((original_ms - xn) as f64) * self.scale).round() as i64)
                .max(0);
        }
        let pos = self.anchors.partition_point(|&(x, _)| x < original_ms);
        let (x1, y1) = self.anchors[pos];
        if x1 == original_ms || pos == 0 {
            return y1.max(0);
        }
        let (x0, y0) = self.anchors[pos - 1];
        let span = (x1 - x0) as f64;
        if span <= 0.0 {
            return y1.max(0);
        }
        let t = ((original_ms - x0) as f64) / span;
        let y = (y0 as f64) + ((y1 - y0) as f64) * t;
        (y.round() as i64).max(0)
    }
}

#[derive(Clone, Copy)]
struct ParsedTimestamp {
    ms: i64,
    has_hours: bool,
    separator: char,
}

struct TimingEntry {
    line_index: usize,
    lead: String,
    arrow: String,
    tail: String,
    start: ParsedTimestamp,
    end: ParsedTimestamp,
    original_end_ms: i64,
    original_start_ms: i64,
    start_ms: i64,
    end_ms: i64,
}

fn timing_line_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"^(\s*)((?:[0-9]+:)?[0-9]{1,2}:[0-9]{2}(?:[.,][0-9]+)?)(\s*-->\s*)((?:[0-9]+:)?[0-9]{1,2}:[0-9]{2}(?:[.,][0-9]+)?)(.*)$",
        )
        .unwrap()
    })
}

fn ts_parts_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^(?:([0-9]+):)?([0-9]{1,2}):([0-9]{2})(?:([.,])([0-9]+))?$").unwrap()
    })
}

fn vtt_inline_ts_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"<((?:[0-9]+:)?[0-9]{1,2}:[0-9]{2}(?:[.,][0-9]+)?)>").unwrap())
}

fn is_webvtt_metadata_header(trimmed: &str) -> bool {
    trimmed == "STYLE"
        || trimmed == "REGION"
        || trimmed == "NOTE"
        || trimmed.starts_with("NOTE ")
        || trimmed.starts_with("NOTE\t")
}

#[cfg(test)]
pub fn retime_subtitle_text(body: &str, timeline: &TimelineRetimeResult) -> Option<String> {
    let fmt = detect_format(None, body, None);
    retime_subtitle_text_for_format(body, timeline, fmt)
}

pub fn retime_subtitle_text_for_format(
    body: &str,
    timeline: &TimelineRetimeResult,
    format: SubtitleFormat,
) -> Option<String> {
    if format == SubtitleFormat::Ttml {
        return None;
    }
    let text = body
        .replace('\u{FEFF}', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let mut mapper = TimelineTimeMapper::from_result(timeline);
    match format {
        SubtitleFormat::Ass | SubtitleFormat::Ssa => retime_ass(&text, &mut mapper),
        SubtitleFormat::Vtt => retime_timing_lines(&text, &mut mapper, true),
        SubtitleFormat::Srt => retime_timing_lines(&text, &mut mapper, false),
        SubtitleFormat::Ttml => None,
    }
}

fn retime_inline_vtt_timestamps(
    line: &str,
    orig_start_ms: i64,
    retimed_start_ms: i64,
    retimed_end_ms: i64,
    scale: f64,
) -> String {
    vtt_inline_ts_regex()
        .replace_all(line, |caps: &regex::Captures<'_>| {
            let Some(parsed) = parse_timestamp(&caps[1]) else {
                return caps[0].to_string();
            };
            let rel_ms = (((parsed.ms.saturating_sub(orig_start_ms)) as f64) * scale).round() as i64;
            let mapped = retimed_start_ms
                .saturating_add(rel_ms)
                .clamp(retimed_start_ms, retimed_end_ms);
            format!("<{}>", format_like(mapped, parsed))
        })
        .into_owned()
}

fn retime_timing_lines(
    text: &str,
    mapper: &mut TimelineTimeMapper,
    is_vtt: bool,
) -> Option<String> {
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    let re = timing_line_regex();
    let mut entries: Vec<TimingEntry> = Vec::new();
    let mut skipping_vtt_block = false;

    for (line_index, line) in lines.iter().enumerate() {
        if is_vtt {
            let trimmed = line.trim();
            if skipping_vtt_block {
                if trimmed.is_empty() {
                    skipping_vtt_block = false;
                }
                continue;
            }
            if is_webvtt_metadata_header(trimmed) {
                skipping_vtt_block = true;
                continue;
            }
        }
        let Some(cap) = re.captures(line) else {
            continue;
        };
        let Some(start) = parse_timestamp(&cap[2]) else {
            continue;
        };
        let Some(end) = parse_timestamp(&cap[4]) else {
            continue;
        };
        let original_end_ms = end.ms.max(start.ms.saturating_add(1));
        let (start_ms, raw_end_ms) = mapper.map_cue_interval(start.ms, original_end_ms);
        let end_ms = raw_end_ms.max(start_ms.saturating_add(1));
        entries.push(TimingEntry {
            line_index,
            lead: cap[1].to_string(),
            arrow: cap[3].to_string(),
            tail: cap[5].to_string(),
            start,
            end,
            original_start_ms: start.ms,
            original_end_ms,
            start_ms,
            end_ms,
        });
    }
    if entries.is_empty() {
        return None;
    }

    // Clamp newly introduced overlaps while leaving intentional source overlaps intact.
    for idx in 0..entries.len().saturating_sub(1) {
        let orig_end = entries[idx].original_end_ms;
        let orig_next_start = entries[idx + 1].original_start_ms;
        if orig_end > orig_next_start {
            continue;
        }
        let next_start = entries[idx + 1].start_ms;
        if entries[idx].end_ms > next_start && next_start > entries[idx].start_ms {
            entries[idx].end_ms = next_start;
        }
    }

    for entry_idx in 0..entries.len() {
        let next_timing_line = entries
            .get(entry_idx + 1)
            .map(|e| e.line_index)
            .unwrap_or(lines.len());
        let entry = &entries[entry_idx];
        lines[entry.line_index] = format!(
            "{}{}{}{}{}",
            entry.lead,
            format_like(entry.start_ms, entry.start),
            entry.arrow,
            format_like(entry.end_ms, entry.end),
            entry.tail,
        );
        if is_vtt {
            for body_line in &mut lines[(entry.line_index + 1)..next_timing_line] {
                if body_line.trim().is_empty() {
                    break;
                }
                if body_line.contains('<') {
                    *body_line = retime_inline_vtt_timestamps(
                        body_line,
                        entry.original_start_ms,
                        entry.start_ms,
                        entry.end_ms,
                        mapper.scale,
                    );
                }
            }
        }
    }

    Some(lines.join("\n"))
}

fn retime_ass(text: &str, mapper: &mut TimelineTimeMapper) -> Option<String> {
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    let mut in_events = false;
    let mut field_count = ASS_DEFAULT_FIELD_COUNT;
    let mut start_idx = ASS_DEFAULT_START_INDEX;
    let mut end_idx = ASS_DEFAULT_END_INDEX;
    let mut rewritten = 0usize;

    for line in &mut lines {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_events = trimmed.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if trimmed
            .get(..7)
            .is_some_and(|head| head.eq_ignore_ascii_case("Format:"))
        {
            let fields: Vec<String> = trimmed
                .get(7..)
                .unwrap_or("")
                .split(',')
                .map(|s| s.trim().to_string())
                .collect();
            field_count = fields.len().max(ASS_DEFAULT_START_INDEX + 1);
            start_idx = fields
                .iter()
                .position(|f| f.eq_ignore_ascii_case("Start"))
                .unwrap_or(ASS_DEFAULT_START_INDEX);
            end_idx = fields
                .iter()
                .position(|f| f.eq_ignore_ascii_case("End"))
                .unwrap_or(ASS_DEFAULT_END_INDEX);
            continue;
        }
        if trimmed
            .get(..9)
            .is_some_and(|head| head.eq_ignore_ascii_case("Dialogue:"))
        {
            let Some(colon) = line.find(':') else {
                continue;
            };
            let prefix = &line[..=colon];
            let mut parts: Vec<String> = line[colon + 1..]
                .splitn(field_count, ',')
                .map(|s| s.to_string())
                .collect();
            if parts.len() <= start_idx.max(end_idx) {
                continue;
            }
            let Some(start) = parse_timestamp(parts[start_idx].trim()) else {
                continue;
            };
            let Some(end) = parse_timestamp(parts[end_idx].trim()) else {
                continue;
            };
            let (start_ms, raw_end_ms) =
                mapper.map_cue_interval(start.ms, end.ms.max(start.ms.saturating_add(1)));
            let end_ms = raw_end_ms.max(start_ms.saturating_add(ASS_MIN_DURATION_MS));

            let lead_start: String = parts[start_idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            let lead_end: String = parts[end_idx]
                .chars()
                .take_while(|c| c.is_whitespace())
                .collect();
            parts[start_idx] = format!("{}{}", lead_start, format_ass(start_ms));
            parts[end_idx] = format!("{}{}", lead_end, format_ass(end_ms));
            *line = format!("{}{}", prefix, parts.join(","));
            rewritten += 1;
        }
    }

    if rewritten == 0 {
        None
    } else {
        Some(lines.join("\n"))
    }
}

fn parse_timestamp(raw: &str) -> Option<ParsedTimestamp> {
    let cap = ts_parts_regex().captures(raw.trim())?;
    let hours_text = cap.get(1).map(|m| m.as_str()).unwrap_or("");
    let hours: i64 = if hours_text.is_empty() {
        0
    } else {
        hours_text.parse().ok()?
    };
    let minutes: i64 = cap[2].parse().ok()?;
    let seconds: i64 = cap[3].parse().ok()?;
    if !(0..=999).contains(&hours) || minutes < 0 || seconds < 0 {
        return None;
    }
    let sep = cap
        .get(4)
        .and_then(|m| m.as_str().chars().next())
        .unwrap_or(',');
    let frac = cap.get(5).map(|m| m.as_str()).unwrap_or("");
    let millis: i64 = match frac.chars().count() {
        0 => 0,
        1 => frac.parse::<i64>().ok()?.checked_mul(100)?,
        2 => frac.parse::<i64>().ok()?.checked_mul(10)?,
        _ => frac.chars().take(3).collect::<String>().parse::<i64>().ok()?,
    };
    let total_sec = hours
        .checked_mul(3_600)?
        .checked_add(minutes.checked_mul(60)?)?
        .checked_add(seconds)?;
    let ms = total_sec.checked_mul(1_000)?.checked_add(millis)?;
    Some(ParsedTimestamp {
        ms,
        has_hours: !hours_text.is_empty(),
        separator: sep,
    })
}

fn format_srt_timestamp(ms: i64) -> String {
    let clamped = ms.max(0);
    let hours = clamped / 3_600_000;
    let minutes = (clamped / 60_000) % 60;
    let seconds = (clamped / 1_000) % 60;
    let millis = clamped % 1_000;
    format!("{hours:02}:{minutes:02}:{seconds:02},{millis:03}")
}

/// Serializes subtitle cues into standard SRT text.
pub fn format_srt_from_cues(cues: &[SubtitleCue]) -> Option<String> {
    if cues.is_empty() {
        return None;
    }
    let mut out = String::new();
    for (idx, cue) in cues.iter().enumerate() {
        let start_ms = cue.start_ms.max(0);
        let end_ms = cue.end_ms.max(start_ms.saturating_add(1));
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx + 1,
            format_srt_timestamp(start_ms),
            format_srt_timestamp(end_ms),
            cue.text.trim()
        ));
    }
    Some(out)
}

/// Serializes original TTML cues using retimed start/end boundaries into standard SRT text.
pub fn format_srt_from_retimed_cues(
    orig_cues: &[SubtitleCue],
    timeline: &TimelineRetimeResult,
) -> Option<String> {
    if orig_cues.is_empty() || orig_cues.len() != timeline.cues.len() {
        return None;
    }
    let mut out = String::new();
    for (idx, (orig, timed)) in orig_cues.iter().zip(timeline.cues.iter()).enumerate() {
        let start_ms = timed.start_ms.max(0);
        let end_ms = timed.end_ms.max(start_ms.saturating_add(1));
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            idx + 1,
            format_srt_timestamp(start_ms),
            format_srt_timestamp(end_ms),
            orig.text.trim()
        ));
    }
    Some(out)
}

fn format_like(ms: i64, original: ParsedTimestamp) -> String {
    let ms = ms.max(0);
    let hours = ms / 3_600_000;
    let minutes = (ms / 60_000) % 60;
    let seconds = (ms / 1_000) % 60;
    let millis = ms % 1_000;
    let clock = format!(
        "{:02}:{:02}{}{:03}",
        minutes, seconds, original.separator, millis
    );
    if original.has_hours || hours > 0 {
        format!("{:02}:{}", hours, clock)
    } else {
        clock
    }
}

fn format_ass(ms: i64) -> String {
    let ms = ms.max(0);
    let centis = ms.saturating_add(5) / 10;
    format!(
        "{}:{:02}:{:02}.{:02}",
        centis / 360_000,
        (centis / 6_000) % 60,
        (centis / 100) % 60,
        centis % 100
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subsync::aligner::build_delay_only_timeline;
    use crate::subsync::aligner::DelayOnlyAlignment;
    use crate::subsync::cue_parser::SubtitleCue;

    fn delay_timeline(offset_ms: f64, cues: &[SubtitleCue]) -> TimelineRetimeResult {
        build_delay_only_timeline(
            cues,
            &DelayOnlyAlignment {
                offset_ms,
                score: 1.0,
                margin: 0.5,
                segments_passed: 3,
                stable_segment_margin_override: false,
            },
        )
    }

    #[test]
    fn retimes_srt_and_vtt_preserving_settings_and_blocks() {
        let cues = vec![
            SubtitleCue::new(10_000, 12_000, "A".into()),
            SubtitleCue::new(13_000, 15_000, "B".into()),
        ];
        let tl = delay_timeline(1_500.0, &cues);

        let vtt = "WEBVTT\n\nSTYLE\n::cue { color: yellow; }\n\ncue-1\n00:10.000 --> 00:12.000 align:middle line:85%\nA\n\n00:13.000 --> 00:15.000\nB\n";
        let retimed = retime_subtitle_text(vtt, &tl).expect("retime vtt");
        assert!(retimed.contains("STYLE\n::cue { color: yellow; }"));
        assert!(retimed.contains("00:11.500 --> 00:13.500 align:middle line:85%"));
        assert!(retimed.contains("00:14.500 --> 00:16.500"));
    }

    #[test]
    fn retimes_ass_preserving_styles_fonts_comments_and_tags() {
        let cues = vec![SubtitleCue::new(10_000, 12_000, "Hello".into())];
        let tl = delay_timeline(-2_000.0, &cues);
        let ass = "\
[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname, Fontsize
Style: Default,Arial,22

[Fonts]
fontname: test.ttf

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Keep me unchanged
Dialogue: 0, 0:00:10.00, 0:00:12.00, Default, Speaker, 0, 0, 0, , {\\an8\\i1}Hello, world{\\i0}";

        let retimed = retime_subtitle_text(ass, &tl).expect("retime ass");
        assert!(retimed.contains("[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Arial,22"));
        assert!(retimed.contains("[Fonts]\nfontname: test.ttf"));
        assert!(retimed.contains("Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,Keep me unchanged"));
        assert!(retimed.contains("Dialogue: 0, 0:00:08.00, 0:00:10.00, Default, Speaker, 0, 0, 0, , {\\an8\\i1}Hello, world{\\i0}"));
    }

    #[test]
    fn handles_non_ascii_ass_lines_and_arabic_indic_digits_without_panicking() {
        let cues = vec![SubtitleCue::new(10_000, 12_000, "مرحبا".into())];
        let tl = delay_timeline(1_000.0, &cues);

        // 2-byte UTF-8 lines inside [Events] shorter than 7/9 bytes must not slice mid-char.
        let ass = "\
[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
م
ش
س،ب
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,مرحبا بكم";
        let retimed_ass = retime_subtitle_text(ass, &tl).expect("retime non-ascii ass");
        assert!(retimed_ass.contains("Dialogue: 0,0:00:11.00,0:00:13.00,Default,,0,0,0,,مرحبا بكم"));

        let arabic_digits = "1\n00:00:10,000 --> 00:00:12,000\nValid cue\n\n2\n٠٠:٠٠:٠١,١٢٣ --> ٠٠:٠٠:٠٢,٠٠٠\nIndic\n";
        let retimed_srt = retime_subtitle_text(arabic_digits, &tl).expect("no panic on Arabic-Indic digits");
        assert!(retimed_srt.contains("00:00:11,000 --> 00:00:13,000"));
    }

    #[test]
    fn formats_ttml_cues_into_retimed_srt() {
        let orig = vec![
            SubtitleCue::new(1_000, 3_000, "First line".into()),
            SubtitleCue::new(4_500, 6_250, "Second line".into()),
        ];
        let tl = delay_timeline(2_000.0, &orig);
        let srt = format_srt_from_retimed_cues(&orig, &tl).expect("format ttml as srt");
        assert!(srt.contains("1\n00:00:03,000 --> 00:00:05,000\nFirst line"));
        assert!(srt.contains("2\n00:00:06,500 --> 00:00:08,250\nSecond line"));
        assert!(!srt.contains("<tt"));
    }

    #[test]
    fn preserves_ass_signs_and_frame_typesetting_near_dialogue_and_rejects_overflow_timestamps() {
        use crate::subsync::aligner::RetimedCue;

        let dialogue_cues = vec![SubtitleCue::new(10_000, 12_000, "Dialogue".into())];
        let delay_tl = delay_timeline(2_000.0, &dialogue_cues);
        let ass = "\
[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Main line
Dialogue: 1,0:00:10.10,0:00:10.14,Signs,,0,0,0,,{\\pos(100,200)}Frame 1
Dialogue: 1,0:00:10.14,0:00:10.18,Signs,,0,0,0,,{\\pos(102,200)}Frame 2";

        let retimed_delay = retime_subtitle_text(ass, &delay_tl).expect("retime uniform delay");
        assert!(retimed_delay.contains("Dialogue: 0,0:00:12.00,0:00:14.00,Default"));
        assert!(retimed_delay.contains("Dialogue: 1,0:00:12.10,0:00:12.14,Signs"));
        assert!(retimed_delay.contains("Dialogue: 1,0:00:12.14,0:00:12.18,Signs"));

        // Also check non-uniform piecewise alignment within BOUNDARY_TOLERANCE_MS (500ms).
        let mut piecewise_tl = delay_timeline(2_500.0, &dialogue_cues);
        piecewise_tl.alignment_source = "dp-piecewise";
        piecewise_tl.cues = vec![RetimedCue {
            original_start_ms: 10_000,
            original_end_ms: 12_000,
            start_ms: 12_500,
            end_ms: 14_500,
        }];
        let retimed_pw = retime_subtitle_text(ass, &piecewise_tl).expect("retime piecewise");
        assert!(retimed_pw.contains("Dialogue: 1,0:00:12.60,0:00:12.64,Signs"));
        assert!(retimed_pw.contains("Dialogue: 1,0:00:12.64,0:00:12.68,Signs"));

        // Overflowing hour digits never panic and are skipped cleanly.
        assert!(parse_timestamp("9999999999999999:00:00,000").is_none());
        let bad_srt = "1\n9999999999999999:00:00,000 --> 9999999999999999:00:02,000\nBad\n\n2\n00:00:10,000 --> 00:00:12,000\nOk\n";
        let retimed_bad = retime_subtitle_text(bad_srt, &delay_tl).expect("retime valid cue");
        assert!(retimed_bad.contains("00:00:12,000 --> 00:00:14,000"));
    }

    #[test]
    fn retimes_vtt_inline_timestamps_preserves_metadata_arrows_and_interpolates_anchors() {
        use crate::subsync::aligner::RetimedCue;

        let cues = vec![SubtitleCue::new(10_000, 12_000, "Word Karaoke".into())];
        let tl = delay_timeline(1_500.0, &cues);
        let vtt = "WEBVTT\n\nNOTE\n00:01.000 --> 00:02.000 ignored in note\n\nSTYLE\n00:03.000 --> 00:04.000\n\n00:10.000 --> 00:12.000\nWord <00:10.500>Karaoke\n";
        let retimed = retime_subtitle_text_for_format(vtt, &tl, SubtitleFormat::Vtt).unwrap();
        assert!(retimed.contains("NOTE\n00:01.000 --> 00:02.000 ignored in note"));
        assert!(retimed.contains("STYLE\n00:03.000 --> 00:04.000"));
        assert!(retimed.contains("00:11.500 --> 00:13.500"));
        assert!(retimed.contains("<00:12.000>"));

        let mut piecewise_tl = delay_timeline(1_000.0, &cues);
        piecewise_tl.alignment_source = "dp-piecewise";
        piecewise_tl.cues = vec![
            RetimedCue {
                original_start_ms: 10_000,
                original_end_ms: 10_500,
                start_ms: 11_000,
                end_ms: 11_500,
            },
            RetimedCue {
                original_start_ms: 20_000,
                original_end_ms: 21_000,
                start_ms: 23_000,
                end_ms: 24_000,
            },
        ];
        let mut mapper = TimelineTimeMapper::from_result(&piecewise_tl);
        let (s, e) = mapper.map_cue_interval(15_250, 16_250);
        assert!(s > 11_500 && s < 23_000);
        assert!(e > s);
    }
}
