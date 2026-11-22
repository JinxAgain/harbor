//! Lossless subtitle text retimer & piecewise boundary mapper.
//!
//! Ported from NuvioMobile's `AutoSyncTimelineTimeMapper.kt` and `AutoSyncSubtitleTextRetimer.kt`.
//! Rewrites only timestamp fields in SRT, WebVTT, and ASS/SSA, keeping all styles, fonts,
//! cue settings, override tags, comments, and markup untouched.

use regex::Regex;
use std::sync::OnceLock;

use crate::subsync::aligner::TimelineRetimeResult;

const BOUNDARY_TOLERANCE_MS: i64 = 500;
const ASS_DEFAULT_FIELD_COUNT: usize = 10;
const ASS_DEFAULT_START_INDEX: usize = 1;
const ASS_DEFAULT_END_INDEX: usize = 2;
const ASS_MIN_DURATION_MS: i64 = 10;

#[derive(Clone, Copy)]
struct TimingBoundary {
    original_ms: i64,
    retimed_ms: i64,
}

pub struct TimelineTimeMapper {
    start_boundaries: Vec<TimingBoundary>,
    end_boundaries: Vec<TimingBoundary>,
    scale: f64,
    intercept_ms: f64,
}

impl TimelineTimeMapper {
    pub fn from_result(timeline: &TimelineRetimeResult) -> Self {
        let mut start_boundaries: Vec<TimingBoundary> = timeline
            .cues
            .iter()
            .map(|c| TimingBoundary {
                original_ms: c.original_start_ms,
                retimed_ms: c.start_ms,
            })
            .collect();
        start_boundaries.sort_by_key(|b| b.original_ms);

        let mut end_boundaries: Vec<TimingBoundary> = timeline
            .cues
            .iter()
            .map(|c| TimingBoundary {
                original_ms: c.original_end_ms,
                retimed_ms: c.end_ms,
            })
            .collect();
        end_boundaries.sort_by_key(|b| b.original_ms);

        Self {
            start_boundaries,
            end_boundaries,
            scale: timeline.alignment_scale,
            intercept_ms: timeline.alignment_intercept_ms,
        }
    }

    pub fn map_start_ms(&self, original_ms: i64) -> i64 {
        self.map_time(original_ms, &self.start_boundaries)
    }

    pub fn map_end_ms(&self, original_ms: i64) -> i64 {
        self.map_time(original_ms, &self.end_boundaries)
    }

    fn map_time(&self, original_ms: i64, boundaries: &[TimingBoundary]) -> i64 {
        if !boundaries.is_empty() {
            let low = boundaries.partition_point(|b| b.original_ms < original_ms);
            let first = low.saturating_sub(2);
            let last = (low + 2).min(boundaries.len() - 1);
            let mut best: Option<TimingBoundary> = None;
            let mut best_error = i64::MAX;
            for cand in &boundaries[first..=last] {
                let err = (cand.original_ms - original_ms).abs();
                if err < best_error {
                    best = Some(*cand);
                    best_error = err;
                }
            }
            if let Some(b) = best {
                if best_error <= BOUNDARY_TOLERANCE_MS {
                    return b.retimed_ms.max(0);
                }
            }
        }
        (((original_ms as f64) * self.scale + self.intercept_ms).round() as i64).max(0)
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
            r"^(\s*)((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?)(\s*-->\s*)((?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?)(.*)$",
        )
        .unwrap()
    })
}

fn ts_parts_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:(\d+):)?(\d{1,2}):(\d{2})(?:([.,])(\d+))?$").unwrap())
}

fn ttml_root_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)<tt[\s>]").unwrap())
}

fn ass_events_header_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?im)^[ \t]*\[Events\][ \t]*$").unwrap())
}

pub fn retime_subtitle_text(body: &str, timeline: &TimelineRetimeResult) -> Option<String> {
    let text = body
        .replace('\u{FEFF}', "")
        .replace("\r\n", "\n")
        .replace('\r', "\n");
    let head: String = text.chars().take(512).collect();
    if ttml_root_regex().is_match(&head) {
        return None;
    }
    let mapper = TimelineTimeMapper::from_result(timeline);
    if ass_events_header_regex().is_match(&text) {
        retime_ass(&text, &mapper)
    } else {
        retime_timing_lines(&text, &mapper)
    }
}

fn retime_timing_lines(text: &str, mapper: &TimelineTimeMapper) -> Option<String> {
    let mut lines: Vec<String> = text.split('\n').map(|s| s.to_string()).collect();
    let re = timing_line_regex();
    let mut entries: Vec<TimingEntry> = Vec::new();

    for (line_index, line) in lines.iter().enumerate() {
        let Some(cap) = re.captures(line) else {
            continue;
        };
        let Some(start) = parse_timestamp(&cap[2]) else {
            continue;
        };
        let Some(end) = parse_timestamp(&cap[4]) else {
            continue;
        };
        let original_end_ms = end.ms.max(start.ms + 1);
        let start_ms = mapper.map_start_ms(start.ms);
        let end_ms = mapper.map_end_ms(original_end_ms).max(start_ms + 1);
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

    for entry in entries {
        lines[entry.line_index] = format!(
            "{}{}{}{}{}",
            entry.lead,
            format_like(entry.start_ms, entry.start),
            entry.arrow,
            format_like(entry.end_ms, entry.end),
            entry.tail,
        );
    }

    Some(lines.join("\n"))
}

fn retime_ass(text: &str, mapper: &TimelineTimeMapper) -> Option<String> {
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
        if trimmed.len() >= 7 && trimmed[..7].eq_ignore_ascii_case("Format:") {
            let fields: Vec<String> = trimmed[7..]
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
        if trimmed.len() >= 9 && trimmed[..9].eq_ignore_ascii_case("Dialogue:") {
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
            let start_ms = mapper.map_start_ms(start.ms);
            let end_ms = mapper
                .map_end_ms(end.ms.max(start.ms + 1))
                .max(start_ms + ASS_MIN_DURATION_MS);

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
    let sep = cap
        .get(4)
        .and_then(|m| m.as_str().chars().next())
        .unwrap_or(',');
    let frac = cap.get(5).map(|m| m.as_str()).unwrap_or("");
    let millis = match frac.len() {
        0 => 0,
        1 => frac.parse::<i64>().ok()? * 100,
        2 => frac.parse::<i64>().ok()? * 10,
        _ => frac[..3].parse::<i64>().ok()?,
    };
    let ms = ((hours * 3_600 + minutes * 60 + seconds) * 1_000) + millis;
    Some(ParsedTimestamp {
        ms,
        has_hours: !hours_text.is_empty(),
        separator: sep,
    })
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
    let centis = (ms + 5) / 10;
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
}
