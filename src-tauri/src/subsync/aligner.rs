//! Text-independent full-timeline subtitle aligner & delay preflight engine.
//!
//! Ported from NuvioMobile's `AutoSyncTimelineRetime.kt`, `AutoSyncDelayPreflight.kt`,
//! `AutoSyncReferenceConsistency.kt`, `AutoSyncNoFitTracker.kt`, and
//! `AutoSyncSampledReferenceAligner.kt`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::subsync::cue_parser::SubtitleCue;

const MIN_CUES: usize = 4;
const MAX_ALIGNMENT_CUES: usize = 25_000;
const BAND_RADIUS_CUES: usize = 28;

const SKIP_REFERENCE_COST: f64 = 1.35;
const SKIP_TARGET_COST: f64 = 1.85;
const GROUP_COMPLEXITY_COST: f64 = 0.10;

const START_END_TOLERANCE_MS: f64 = 1_250.0;
const MIDPOINT_TOLERANCE_MS: f64 = 1_500.0;
const DURATION_TOLERANCE_MS: f64 = 2_000.0;
const MAX_GROUP_COST: f64 = 8.0;

const MIN_TARGET_COVERAGE: f64 = 0.84;
const MIN_MATCHED_TARGET_CUES: usize = 20;
const MAX_AVERAGE_GROUP_COST: f64 = 2.35;
const MAX_LONGEST_TARGET_SKIP_RUN: usize = 12;

const PARTIAL_TARGET_SPAN_RATIO: f64 = 0.75;

const LOCAL_SHIFT_RADIUS_GROUPS: usize = 3;
const LOCAL_SHIFT_MAX_DEVIATION_MS: i64 = 250;

const ACTIVITY_COARSE_BIN_MS: i64 = 500;
const ACTIVITY_FINE_BIN_MS: i64 = 100;
const ACTIVITY_MAX_OFFSET_MS: i64 = 180_000;
const ACTIVITY_FINE_RADIUS_MS: i64 = 750;
const ACTIVITY_COARSE_PLATEAU_SCORE_EPSILON: f64 = 0.01;
const ACTIVITY_COARSE_PLATEAU_MAX_EXTENT_MS: i64 = 3_000;
const ACTIVITY_FINE_TIE_SCORE_EPSILON: f64 = 0.005;
const ACTIVITY_ONSET_MATCH_TOLERANCE_MS: i64 = 250;
const ACTIVITY_MAX_CUE_DURATION_MS: i64 = 20_000;
const ACTIVITY_MAX_TIMELINE_MS: i64 = 8 * 60 * 60 * 1_000;
const ACTIVITY_MIN_SCORE: f64 = 0.55;
const ACTIVITY_MIN_MARGIN: f64 = 0.02;
const ACTIVITY_DISTINCT_TRANSFORM_MS: f64 = 3_000.0;
const ACTIVITY_MIN_SCALE: f64 = 0.94;
const ACTIVITY_MAX_SCALE: f64 = 1.06;
const ACTIVITY_SCALE_DEDUP: f64 = 0.00035;

const DELAY_ONLY_SCALE_TOLERANCE: f64 = 0.0005;
const DELAY_ONLY_MIN_SCORE: f64 = 0.78;
const DELAY_ONLY_MIN_MARGIN: f64 = 0.02;
const DELAY_ONLY_MIN_SEGMENT_SCORE: f64 = 0.68;
const DELAY_ONLY_SEGMENT_SEARCH_RADIUS_MS: i64 = 1_000;
const DELAY_ONLY_MAX_SEGMENT_OFFSET_DELTA_MS: i64 = 500;
const DELAY_ONLY_DISTINCT_OFFSET_MS: i64 = 3_000;
const DELAY_ONLY_FAST_PATH_MIN_SCORE: f64 = 0.90;
const DELAY_ONLY_FAST_PATH_MIN_MARGIN: f64 = 0.04;
const DELAY_ONLY_FAST_PATH_REQUIRED_SEGMENTS: usize = 3;
const SMALL_SAMPLE_CUE_LIMIT: usize = 8;
const SMALL_SAMPLE_ACTIVITY_MIN_SCORE: f64 = 0.72;
const SMALL_SAMPLE_ACTIVITY_MIN_MARGIN: f64 = 0.03;
const SMALL_SAMPLE_REQUIRED_COVERAGE_SEGMENTS: usize = 2;

const DISCOVERED_MIN_TARGET_COVERAGE: f64 = 0.90;
const DISCOVERED_MAX_AVERAGE_GROUP_COST: f64 = 1.10;
const DISCOVERED_MIN_SIMPLE_GROUP_RATIO: f64 = 0.55;
const SEGMENTATION_IMBALANCE_RATIO: f64 = 1.60;
const SEGMENTATION_MIN_TIMELINE_COVERAGE: f64 = 0.80;
const COVERAGE_SEGMENT_MIN_COVERAGE: f64 = 0.72;
const COVERAGE_SEGMENT_MAX_AVERAGE_COST: f64 = 1.35;
const COVERAGE_SEGMENT_MIN_GROUPS: usize = 4;

const GROUPED_REPLY_MIN_REFERENCE_GAP_MS: i64 = 500;
const GROUPED_REPLY_MIN_EARLY_START_MS: i64 = 250;
const GROUPED_REPLY_MAX_START_ADJUSTMENT_MS: i64 = 1_250;
const GROUPED_REPLY_ENDPOINT_TOLERANCE_MS: i64 = 200;
const GROUPED_REPLY_CONTEXT_SHIFT_TOLERANCE_MS: i64 = 500;
const GROUPED_REPLY_MIN_RESULT_DURATION_MS: i64 = 800;
const GROUPED_REPLY_CONTEXT_GROUP_RADIUS: usize = 2;
const GROUPED_REPLY_REFERENCE_NEIGHBOR_RADIUS: usize = 2;

const GROUP_SHAPES: [(usize, usize); 6] = [(1, 1), (1, 2), (2, 1), (1, 3), (3, 1), (2, 2)];

const NO_FIT_MAX_ACTIVITY_MARGIN: f64 = 0.01;
const TRANSFORM_DISAGREEMENT_MS: f64 = 300.0;

#[inline]
fn is_cancelled(cancel: &AtomicBool) -> bool {
    cancel.load(Ordering::Relaxed)
}

#[derive(Debug, Clone)]
pub struct CueGroup {
    pub reference_start_index: usize,
    pub reference_count: usize,
    pub target_start_index: usize,
    pub target_count: usize,
    pub cost: f64,
}

#[derive(Debug, Clone)]
pub struct RetimedCue {
    pub original_start_ms: i64,
    pub original_end_ms: i64,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Debug, Clone)]
pub struct DelayOnlyAlignment {
    pub offset_ms: f64,
    pub score: f64,
    pub margin: f64,
    pub segments_passed: usize,
    pub stable_segment_margin_override: bool,
}

#[derive(Debug, Clone)]
pub struct TimelineRetimeResult {
    pub cues: Vec<RetimedCue>,
    pub groups: Vec<CueGroup>,
    pub target_coverage: f64,
    pub reference_coverage: f64,
    pub skipped_target_cues: usize,
    #[allow(dead_code)]
    pub skipped_reference_cues: usize,
    pub longest_target_skip_run: usize,
    pub average_group_cost: f64,
    pub one_to_one_groups: usize,
    pub one_to_two_groups: usize,
    pub two_to_one_groups: usize,
    pub one_to_three_groups: usize,
    pub three_to_one_groups: usize,
    pub two_to_two_groups: usize,
    pub confident: bool,
    pub alignment_source: &'static str,
    pub alignment_scale: f64,
    pub alignment_intercept_ms: f64,
    pub activity_score: f64,
    pub activity_margin: f64,
    pub coverage_segments_passed: usize,
    pub simple_group_ratio: f64,
    pub localized_mismatch_ignored: bool,
    pub median_group_residual_ms: f64,
    pub reject_reason: Option<String>,
}

impl TimelineRetimeResult {
    /// Largest correction applied anywhere in the subtitle's span.
    pub fn max_alignment_shift_ms(&self) -> f64 {
        let shift_at = |time_ms: i64| -> f64 {
            ((self.alignment_scale - 1.0) * (time_ms as f64) + self.alignment_intercept_ms).abs()
        };
        let Some(first) = self.cues.first() else {
            return self.alignment_intercept_ms.abs();
        };
        let last = self.cues.last().unwrap_or(first);
        let affine_max = shift_at(first.original_start_ms).max(shift_at(last.original_start_ms));
        let cue_max = self
            .cues
            .iter()
            .map(|c| (c.start_ms - c.original_start_ms).abs() as f64)
            .fold(0.0f64, f64::max);
        affine_max.max(cue_max)
    }

    pub fn is_no_fit(&self) -> bool {
        !self.confident && self.activity_margin < NO_FIT_MAX_ACTIVITY_MARGIN
    }
}

pub fn prefer_tighter_fit_on_disagreement(
    candidate: &TimelineRetimeResult,
    current: &TimelineRetimeResult,
) -> Option<bool> {
    if !candidate.confident || !current.confident {
        return None;
    }
    let first = candidate.cues.first()?.original_start_ms;
    let last = candidate.cues.last()?.original_start_ms;
    let gap_at = |time_ms: i64| -> f64 {
        ((candidate.alignment_scale - current.alignment_scale) * (time_ms as f64)
            + candidate.alignment_intercept_ms
            - current.alignment_intercept_ms)
            .abs()
    };
    if gap_at(first).max(gap_at(last)) <= TRANSFORM_DISAGREEMENT_MS {
        return None;
    }
    if candidate.median_group_residual_ms == current.median_group_residual_ms {
        return None;
    }
    Some(candidate.median_group_residual_ms < current.median_group_residual_ms)
}

#[derive(Clone)]
pub struct ActivityTimeline {
    pub bins_len: usize,
    pub packed: Vec<u64>,
    pub active_count: usize,
    pub prefix: Vec<i32>,
    pub first_active: usize,
    pub last_active: usize,
}

#[derive(Clone)]
pub struct PreparedActivity {
    pub coarse: ActivityTimeline,
    pub fine: ActivityTimeline,
    pub starts: Vec<i64>,
}

#[derive(Clone, Copy)]
struct ActivityCandidate {
    scale: f64,
    intercept_ms: i64,
    score: f64,
}

#[derive(Clone, Copy)]
pub struct DelayOnlySearchSeed {
    coarse: ActivityCandidate,
    margin: f64,
    fine: Option<ActivityCandidate>,
    plateau_start_ms: i64,
    plateau_end_ms: i64,
}

#[derive(Clone)]
pub struct DelayOnlySearchEvidence {
    coarse_scores: Vec<f64>,
    first_offset_bins: i32,
    seed: DelayOnlySearchSeed,
}

struct ActivityAlignment {
    scale: f64,
    intercept_ms: f64,
    score: f64,
    margin: f64,
    delay_only_seed: Option<DelayOnlySearchSeed>,
}

pub fn should_relax_delay_only_margin(
    sdh_reference: bool,
    reference_size: usize,
    target_size: usize,
) -> bool {
    sdh_reference || (reference_size as i64) * 2 >= (target_size as i64) * 3
}

pub fn prepare_unit_activity(cues: &[SubtitleCue]) -> Option<PreparedActivity> {
    if cues.len() < MIN_CUES {
        return None;
    }
    let coarse = build_activity_timeline(cues, 1.0, ACTIVITY_COARSE_BIN_MS)?;
    let fine = build_activity_timeline(cues, 1.0, ACTIVITY_FINE_BIN_MS)?;
    let mut starts: Vec<i64> = cues.iter().map(|c| c.start_ms.max(0)).collect();
    starts.sort_unstable();
    Some(PreparedActivity {
        coarse,
        fine,
        starts,
    })
}

pub fn retime_with_discovery(
    reference: &[SubtitleCue],
    target: &[SubtitleCue],
    sdh_reference: bool,
    prepared_reference_activity: Option<&PreparedActivity>,
    prepared_target_activity: Option<&PreparedActivity>,
    precomputed_delay_only: Option<&DelayOnlyAlignment>,
    precomputed_delay_only_evidence: Option<&DelayOnlySearchEvidence>,
    allow_precomputed_delay_fast_path: bool,
    cancel: &AtomicBool,
) -> Option<TimelineRetimeResult> {
    if is_cancelled(cancel) {
        return None;
    }
    let allow_ambiguous_delay_margin =
        should_relax_delay_only_margin(sdh_reference, reference.len(), target.len());
    let owned_ref;
    let ref_act = match prepared_reference_activity {
        Some(a) => a,
        None => {
            owned_ref = prepare_unit_activity(reference)?;
            &owned_ref
        }
    };
    let owned_tgt;
    let tgt_act = match prepared_target_activity {
        Some(a) => a,
        None => {
            owned_tgt = prepare_unit_activity(target)?;
            &owned_tgt
        }
    };

    if let Some(fast) = precomputed_delay_only.filter(|a| {
        allow_precomputed_delay_fast_path
            && !allow_ambiguous_delay_margin
            && a.score >= DELAY_ONLY_FAST_PATH_MIN_SCORE
            && a.margin >= DELAY_ONLY_FAST_PATH_MIN_MARGIN
            && a.segments_passed >= DELAY_ONLY_FAST_PATH_REQUIRED_SEGMENTS
    }) {
        if let Some(fast_res) = retime_with_seed(reference, target, 1.0, fast.offset_ms, cancel) {
            let validated_fast = finalize_discovered_result(
                fast_res,
                reference.len(),
                target.len(),
                1.0,
                fast.offset_ms,
                fast.score,
                fast.margin,
                true,
                false,
            );
            if validated_fast.confident {
                return Some(with_validated_delay_only_cues(validated_fast, target, fast));
            }
        }
    }

    if is_cancelled(cancel) {
        return None;
    }

    let alignment = discover_activity_alignment(
        reference,
        target,
        ref_act,
        tgt_act,
        precomputed_delay_only_evidence,
        cancel,
    )?;

    if is_cancelled(cancel) {
        return None;
    }

    let delay_only = if (alignment.scale - 1.0).abs() <= DELAY_ONLY_SCALE_TOLERANCE {
        let candidate = if let Some(pre) = precomputed_delay_only {
            Some(pre.clone())
        } else {
            find_delay_only_alignment_prepared(
                ref_act,
                tgt_act,
                target.len(),
                allow_ambiguous_delay_margin,
                alignment.delay_only_seed.as_ref(),
                !allow_ambiguous_delay_margin,
                cancel,
            )
        };
        candidate.filter(|d| (alignment.scale - 1.0).abs() <= 1e-6 || d.score >= alignment.score - 0.01)
    } else {
        None
    };

    let candidate_scale = if delay_only.is_some() {
        1.0
    } else {
        alignment.scale
    };
    let candidate_intercept_ms = delay_only
        .as_ref()
        .map(|d| d.offset_ms)
        .unwrap_or(alignment.intercept_ms);
    let candidate_score = delay_only
        .as_ref()
        .map(|d| d.score)
        .unwrap_or(alignment.score);
    let candidate_margin = delay_only
        .as_ref()
        .map(|d| d.margin)
        .unwrap_or(alignment.margin);

    let Some(seeded) = retime_with_seed(
        reference,
        target,
        candidate_scale,
        candidate_intercept_ms,
        cancel,
    ) else {
        if is_cancelled(cancel) {
            return None;
        }
        return Some(TimelineRetimeResult {
            cues: Vec::new(),
            groups: Vec::new(),
            target_coverage: 0.0,
            reference_coverage: 0.0,
            skipped_target_cues: target.len(),
            skipped_reference_cues: reference.len(),
            longest_target_skip_run: target.len(),
            average_group_cost: 0.0,
            one_to_one_groups: 0,
            one_to_two_groups: 0,
            two_to_one_groups: 0,
            one_to_three_groups: 0,
            three_to_one_groups: 0,
            two_to_two_groups: 0,
            confident: false,
            alignment_source: if delay_only.is_some() {
                "delay-only-validated"
            } else {
                "activity-correlation"
            },
            alignment_scale: candidate_scale,
            alignment_intercept_ms: candidate_intercept_ms,
            activity_score: candidate_score,
            activity_margin: candidate_margin,
            coverage_segments_passed: 0,
            simple_group_ratio: 0.0,
            localized_mismatch_ignored: false,
            median_group_residual_ms: 0.0,
            reject_reason: Some("dp-no-path".into()),
        });
    };

    let allow_ambiguous_final = allow_ambiguous_delay_margin
        || delay_only
            .as_ref()
            .is_some_and(|d| d.stable_segment_margin_override);
    let mut finalized = finalize_discovered_result(
        seeded,
        reference.len(),
        target.len(),
        candidate_scale,
        candidate_intercept_ms,
        candidate_score,
        candidate_margin,
        delay_only.is_some(),
        allow_ambiguous_final,
    );

    if finalized.confident && delay_only.is_none() {
        finalized = refine_grouped_reply_timing(reference, target, finalized, cancel);
    }

    if finalized.confident {
        if let Some(ref d) = delay_only {
            return Some(with_validated_delay_only_cues(finalized, target, d));
        }
    }
    Some(finalized)
}

fn finalize_discovered_result(
    mut result: TimelineRetimeResult,
    reference_size: usize,
    target_size: usize,
    candidate_scale: f64,
    candidate_intercept_ms: f64,
    candidate_activity_score: f64,
    candidate_activity_margin: f64,
    delay_only: bool,
    allow_ambiguous_delay_margin: bool,
) -> TimelineRetimeResult {
    let coverage_segments = coverage_segments_passed(&result, target_size);
    let simple_ratio = structural_group_ratio(&result, reference_size, target_size);
    let small_sample = target_size < SMALL_SAMPLE_CUE_LIMIT;
    let required_score = if small_sample {
        SMALL_SAMPLE_ACTIVITY_MIN_SCORE
    } else {
        ACTIVITY_MIN_SCORE
    };
    let required_margin = if small_sample {
        SMALL_SAMPLE_ACTIVITY_MIN_MARGIN
    } else {
        ACTIVITY_MIN_MARGIN
    };
    let required_segments = if small_sample {
        SMALL_SAMPLE_REQUIRED_COVERAGE_SEGMENTS
    } else {
        3
    };
    let margin_ok = candidate_activity_margin >= required_margin
        || (delay_only && allow_ambiguous_delay_margin);

    let matched_target_count = target_size.saturating_sub(result.skipped_target_cues);
    let skip_run_only_failure = !result.confident
        && result.longest_target_skip_run > MAX_LONGEST_TARGET_SKIP_RUN
        && matched_target_count >= MIN_MATCHED_TARGET_CUES.min(target_size)
        && result.target_coverage >= MIN_TARGET_COVERAGE
        && result.average_group_cost <= MAX_AVERAGE_GROUP_COST;

    let mut reasons: Vec<String> = Vec::new();
    if !skip_run_only_failure {
        if let Some(ref r) = result.reject_reason {
            reasons.push(r.clone());
        }
    }
    if candidate_activity_score < required_score {
        reasons.push(format!(
            "activityScore={}<{}",
            round3(candidate_activity_score),
            required_score
        ));
    }
    if !margin_ok {
        reasons.push(format!(
            "activityMargin={}<{}",
            round3(candidate_activity_margin),
            required_margin
        ));
    }
    if coverage_segments < required_segments {
        reasons.push(format!(
            "coverageSegments={}<{}",
            coverage_segments, required_segments
        ));
    }
    if result.target_coverage < DISCOVERED_MIN_TARGET_COVERAGE {
        reasons.push(format!(
            "targetCoverage={}<{}",
            round3(result.target_coverage),
            DISCOVERED_MIN_TARGET_COVERAGE
        ));
    }
    if result.average_group_cost > DISCOVERED_MAX_AVERAGE_GROUP_COST {
        reasons.push(format!(
            "avgGroupCost={}>{}",
            round3(result.average_group_cost),
            DISCOVERED_MAX_AVERAGE_GROUP_COST
        ));
    }
    if simple_ratio < DISCOVERED_MIN_SIMPLE_GROUP_RATIO {
        reasons.push(format!(
            "simpleRatio={}<{}",
            round3(simple_ratio),
            DISCOVERED_MIN_SIMPLE_GROUP_RATIO
        ));
    }

    let confirmed = reasons.is_empty();
    result.confident = confirmed;
    result.localized_mismatch_ignored = confirmed && skip_run_only_failure;
    result.reject_reason = if reasons.is_empty() {
        None
    } else {
        Some(reasons.join(","))
    };
    result.alignment_source = if delay_only {
        "delay-only-validated"
    } else {
        "activity-correlation"
    };
    result.alignment_scale = candidate_scale;
    result.alignment_intercept_ms = candidate_intercept_ms;
    result.activity_score = candidate_activity_score;
    result.activity_margin = candidate_activity_margin;
    result.coverage_segments_passed = coverage_segments;
    result.simple_group_ratio = simple_ratio;
    result
}

fn with_validated_delay_only_cues(
    mut result: TimelineRetimeResult,
    target: &[SubtitleCue],
    alignment: &DelayOnlyAlignment,
) -> TimelineRetimeResult {
    result.cues = build_uniform_delay_cues(target, alignment.offset_ms.round() as i64);
    result
}

fn build_uniform_delay_cues(target: &[SubtitleCue], offset_ms: i64) -> Vec<RetimedCue> {
    target
        .iter()
        .map(|cue| {
            let start = cue.start_ms.saturating_add(offset_ms).max(0);
            let end = cue.end_ms.saturating_add(offset_ms).max(start.saturating_add(1));
            RetimedCue {
                original_start_ms: cue.start_ms,
                original_end_ms: cue.end_ms,
                start_ms: start,
                end_ms: end,
            }
        })
        .collect()
}

pub fn build_delay_only_timeline(
    target: &[SubtitleCue],
    alignment: &DelayOnlyAlignment,
) -> TimelineRetimeResult {
    TimelineRetimeResult {
        cues: build_uniform_delay_cues(target, alignment.offset_ms.round() as i64),
        groups: Vec::new(),
        target_coverage: 1.0,
        reference_coverage: alignment.score,
        skipped_target_cues: 0,
        skipped_reference_cues: 0,
        longest_target_skip_run: 0,
        average_group_cost: 0.0,
        one_to_one_groups: 0,
        one_to_two_groups: 0,
        two_to_one_groups: 0,
        one_to_three_groups: 0,
        three_to_one_groups: 0,
        two_to_two_groups: 0,
        confident: true,
        alignment_source: "sampled-delay",
        alignment_scale: 1.0,
        alignment_intercept_ms: alignment.offset_ms,
        activity_score: alignment.score,
        activity_margin: alignment.margin,
        coverage_segments_passed: alignment.segments_passed,
        simple_group_ratio: 1.0,
        localized_mismatch_ignored: false,
        median_group_residual_ms: 0.0,
        reject_reason: None,
    }
}

pub fn prepare_delay_only_search_evidence(
    reference_activity: &PreparedActivity,
    target_activity: &PreparedActivity,
    cancel: &AtomicBool,
) -> Option<DelayOnlySearchEvidence> {
    let (range_start, range_end) =
        coarse_offset_range(&reference_activity.coarse, &target_activity.coarse);
    let len = usize::try_from(range_end - range_start + 1).ok()?;
    let mut scores = vec![f64::NAN; len];
    let mut candidates = Vec::with_capacity(len);

    for offset_bins in range_start..=range_end {
        if (offset_bins - range_start) & 63 == 0 && is_cancelled(cancel) {
            return None;
        }
        let Some(score) = score_activity_offset(
            &reference_activity.coarse,
            &target_activity.coarse,
            offset_bins,
        ) else {
            continue;
        };
        let idx = (offset_bins - range_start) as usize;
        scores[idx] = score;
        candidates.push(ActivityCandidate {
            scale: 1.0,
            intercept_ms: i64::from(offset_bins) * ACTIVITY_COARSE_BIN_MS,
            score,
        });
    }

    let mut seed = build_delay_only_search_seed(&candidates)?;
    seed.fine = fine_activity_best(
        &reference_activity.fine,
        &target_activity.fine,
        &reference_activity.starts,
        &target_activity.starts,
        1.0,
        seed.plateau_start_ms,
        seed.plateau_end_ms,
        cancel,
    );
    Some(DelayOnlySearchEvidence {
        coarse_scores: scores,
        first_offset_bins: range_start,
        seed,
    })
}

pub fn find_delay_only_alignment_prepared(
    reference_activity: &PreparedActivity,
    target_activity: &PreparedActivity,
    target_size: usize,
    allow_ambiguous_margin: bool,
    seed_opt: Option<&DelayOnlySearchSeed>,
    allow_stable_segment_margin_override: bool,
    cancel: &AtomicBool,
) -> Option<DelayOnlyAlignment> {
    let owned_evidence;
    let seed = match seed_opt {
        Some(s) => s,
        None => {
            owned_evidence =
                prepare_delay_only_search_evidence(reference_activity, target_activity, cancel)?;
            &owned_evidence.seed
        }
    };
    let margin = seed.margin;
    let margin_accepted = allow_ambiguous_margin || margin >= DELAY_ONLY_MIN_MARGIN;
    if !margin_accepted && !allow_stable_segment_margin_override {
        return None;
    }
    let best = seed
        .fine
        .or_else(|| {
            fine_activity_best(
                &reference_activity.fine,
                &target_activity.fine,
                &reference_activity.starts,
                &target_activity.starts,
                1.0,
                seed.plateau_start_ms,
                seed.plateau_end_ms,
                cancel,
            )
        })
        .unwrap_or(seed.coarse);
    if best.score < DELAY_ONLY_MIN_SCORE {
        return None;
    }

    let global_offset_bins =
        ((best.intercept_ms as f64) / (ACTIVITY_FINE_BIN_MS as f64)).round() as i32;
    let local_radius_bins = (DELAY_ONLY_SEGMENT_SEARCH_RADIUS_MS / ACTIVITY_FINE_BIN_MS) as i32;
    let max_delta_bins = (DELAY_ONLY_MAX_SEGMENT_OFFSET_DELTA_MS / ACTIVITY_FINE_BIN_MS) as i32;

    let mut available_segments = 0usize;
    let mut passed_segments = 0usize;
    for segment in 0..3 {
        if is_cancelled(cancel) {
            return None;
        }
        if allow_ambiguous_margin {
            let Some(cov) = target_activity_coverage_at_offset_segment(
                &reference_activity.fine,
                &target_activity.fine,
                global_offset_bins,
                segment,
            ) else {
                continue;
            };
            available_segments += 1;
            if cov >= DELAY_ONLY_MIN_SEGMENT_SCORE {
                passed_segments += 1;
            }
            continue;
        }

        let mut segment_best = f64::NEG_INFINITY;
        let mut segment_near = f64::NEG_INFINITY;
        let mut has_score = false;
        for delta in -local_radius_bins..=local_radius_bins {
            let cand_bins = global_offset_bins + delta;
            let Some(score) = score_activity_offset_segment(
                &reference_activity.fine,
                &target_activity.fine,
                cand_bins,
                segment,
            ) else {
                continue;
            };
            has_score = true;
            if score > segment_best {
                segment_best = score;
            }
            if delta.abs() <= max_delta_bins && score > segment_near {
                segment_near = score;
            }
        }
        if !has_score {
            continue;
        }
        available_segments += 1;
        if segment_best >= DELAY_ONLY_MIN_SEGMENT_SCORE
            && segment_near >= segment_best - ACTIVITY_FINE_TIE_SCORE_EPSILON
        {
            passed_segments += 1;
        }
    }

    let required_segments = if target_size < SMALL_SAMPLE_CUE_LIMIT {
        2
    } else {
        3
    };
    if available_segments < required_segments || passed_segments < required_segments {
        return None;
    }

    Some(DelayOnlyAlignment {
        offset_ms: best.intercept_ms as f64,
        score: best.score,
        margin,
        segments_passed: passed_segments,
        stable_segment_margin_override: !margin_accepted
            && allow_stable_segment_margin_override
            && !allow_ambiguous_margin,
    })
}

pub struct DelayPreflightResult {
    pub best_reference_key: Option<String>,
    #[allow(dead_code)]
    pub best_alignment: Option<DelayOnlyAlignment>,
    pub evidence_by_reference_key: HashMap<String, (DelayOnlySearchEvidence, Option<DelayOnlyAlignment>)>,
}

/// Evaluates delay-only preflight across all eligible references, carrying search evidence forward.
pub fn evaluate_delay_preflight(
    references: &[(String, &PreparedActivity, usize, bool)],
    target_size: usize,
    target_activity: &PreparedActivity,
    cancel: &AtomicBool,
) -> DelayPreflightResult {
    let mut best_key: Option<String> = None;
    let mut best_align: Option<DelayOnlyAlignment> = None;
    let mut evidence_map = HashMap::with_capacity(references.len());

    for &(ref key, ref_act, ref_size, is_sdh) in references {
        if is_cancelled(cancel) {
            break;
        }
        let Some(evidence) =
            prepare_delay_only_search_evidence(ref_act, target_activity, cancel)
        else {
            continue;
        };
        let relax = should_relax_delay_only_margin(is_sdh, ref_size, target_size);
        let alignment = find_delay_only_alignment_prepared(
            ref_act,
            target_activity,
            target_size,
            relax,
            Some(&evidence.seed),
            false,
            cancel,
        );
        if let Some(ref cand) = alignment {
            let better = match best_align {
                None => true,
                Some(ref cur) => {
                    cand.score > cur.score
                        || (cand.score == cur.score && cand.margin > cur.margin)
                        || (cand.score == cur.score
                            && cand.margin == cur.margin
                            && cand.segments_passed > cur.segments_passed)
                }
            };
            if better {
                best_key = Some(key.clone());
                best_align = Some(cand.clone());
            }
        }
        evidence_map.insert(key.clone(), (evidence, alignment));
    }

    DelayPreflightResult {
        best_reference_key: best_key,
        best_alignment: best_align,
        evidence_by_reference_key: evidence_map,
    }
}

/// Groups references by near-identical 100ms activity (~90% Jaccard overlap) and flags outlier
/// mistimed tracks when >= 3 independent sources are present and 2 agree near 0 offset.
pub fn find_outlier_references(
    references: &[(String, &PreparedActivity, usize)],
    cancel: &AtomicBool,
) -> HashSet<String> {
    const MAX_CHECKED_REFS: usize = 8;
    const MAX_CHECKED_SOURCES: usize = 6;
    const MAX_AGREEING_OFFSET_MS: f64 = 1_000.0;

    let mut sources: Vec<Vec<(String, &PreparedActivity, usize)>> = Vec::new();
    for item in references.iter().take(MAX_CHECKED_REFS) {
        if let Some(group) = sources
            .iter_mut()
            .find(|grp| is_same_source_activity(grp[0].1, item.1))
        {
            group.push(item.clone());
        } else {
            sources.push(vec![item.clone()]);
        }
    }
    if sources.len() > MAX_CHECKED_SOURCES {
        sources.truncate(MAX_CHECKED_SOURCES);
    }
    if sources.len() < 3 {
        return HashSet::new();
    }

    let n = sources.len();
    let mut agrees = vec![vec![false; n]; n];
    for first in 0..n {
        for second in (first + 1)..n {
            if is_cancelled(cancel) {
                return HashSet::new();
            }
            let first_item = &sources[first][0];
            let second_item = &sources[second][0];
            let (dense, sparse) = if first_item.2 >= second_item.2 {
                (first_item, second_item)
            } else {
                (second_item, first_item)
            };
            let agree = find_delay_only_alignment_prepared(
                dense.1,
                sparse.1,
                sparse.2,
                false,
                None,
                false,
                cancel,
            )
            .is_some_and(|a| a.offset_ms.abs() <= MAX_AGREEING_OFFSET_MS);
            agrees[first][second] = agree;
            agrees[second][first] = agree;
        }
    }

    let mut outliers = HashSet::new();
    for candidate in 0..n {
        if agrees[candidate].iter().any(|&v| v) {
            continue;
        }
        let others_agree = (0..n).any(|first| {
            first != candidate
                && (0..n).any(|second| second != candidate && second != first && agrees[first][second])
        });
        if others_agree {
            for (key, _, _) in &sources[candidate] {
                outliers.insert(key.clone());
            }
        }
    }
    outliers
}

pub fn is_same_source_activity(first: &PreparedActivity, second: &PreparedActivity) -> bool {
    const SAME_SOURCE_MIN_OVERLAP: f64 = 0.90;
    let a = &first.fine.packed;
    let b = &second.fine.packed;
    let words = a.len().max(b.len());
    let mut intersection = 0u64;
    let mut union = 0u64;
    for w in 0..words {
        let left = a.get(w).copied().unwrap_or(0);
        let right = b.get(w).copied().unwrap_or(0);
        intersection += u64::from((left & right).count_ones());
        union += u64::from((left | right).count_ones());
    }
    if union == 0 {
        false
    } else {
        (intersection as f64) / (union as f64) >= SAME_SOURCE_MIN_OVERLAP
    }
}

/// Conservative constant-delay matcher for sparse embedded subtitle timelines.
pub fn find_sampled_delay_alignment(
    reference: &[SubtitleCue],
    target: &[SubtitleCue],
    cancel: &AtomicBool,
) -> Option<DelayOnlyAlignment> {
    const MAX_OFFSET_MS: i64 = 180_000;
    const HIST_BIN_MS: i64 = 250;
    const MATCH_TOL_MS: i64 = 1_250;
    const DISTINCT_OFFSET_MS: i64 = 3_000;
    const MIN_MATCHED_CUES: usize = 8;
    const MIN_COVERAGE: f64 = 0.68;
    const MIN_MARGIN: f64 = 0.08;
    const REQUIRED_SEGMENTS: usize = 3;
    const MAX_HIST_CANDIDATES: usize = 12;

    if reference.len() < MIN_MATCHED_CUES
        || target.len() < MIN_MATCHED_CUES
        || reference.len() > MAX_ALIGNMENT_CUES
        || target.len() > MAX_ALIGNMENT_CUES
        || is_cancelled(cancel)
    {
        return None;
    }
    let mut ref_starts: Vec<i64> = reference.iter().map(|c| c.start_ms).collect();
    let mut tgt_starts: Vec<i64> = target.iter().map(|c| c.start_ms).collect();
    ref_starts.sort_unstable();
    tgt_starts.sort_unstable();

    let mut histogram: HashMap<i64, usize> = HashMap::new();
    for (i, &ref_ms) in ref_starts.iter().enumerate() {
        if i & 0xff == 0 && is_cancelled(cancel) {
            return None;
        }
        let min_t = ref_ms.saturating_sub(MAX_OFFSET_MS);
        let max_t = ref_ms.saturating_add(MAX_OFFSET_MS);
        let mut idx = tgt_starts.partition_point(|&v| v < min_t);
        while idx < tgt_starts.len() && tgt_starts[idx] <= max_t {
            let bin = (((ref_ms.saturating_sub(tgt_starts[idx])) as f64) / (HIST_BIN_MS as f64))
                .round() as i64;
            *histogram.entry(bin).or_insert(0) += 1;
            idx += 1;
        }
    }
    if is_cancelled(cancel) {
        return None;
    }

    let mut hist_entries: Vec<(i64, usize)> = histogram.into_iter().collect();
    hist_entries.sort_by(|a, b| {
        b.1.cmp(&a.1)
            .then_with(|| a.0.abs().cmp(&b.0.abs()))
            .then_with(|| a.0.cmp(&b.0))
    });

    let mut seeds: Vec<i64> = Vec::new();
    for (bin, _) in hist_entries {
        let offset = bin * HIST_BIN_MS;
        if seeds
            .iter()
            .all(|&s| (s - offset).abs() >= DISTINCT_OFFSET_MS)
        {
            seeds.push(offset);
            if seeds.len() >= MAX_HIST_CANDIDATES {
                break;
            }
        }
    }

    let match_cues = |offset_ms: i64| -> Vec<(i64, i64)> {
        let mut matches = Vec::new();
        let mut min_tgt_idx = 0usize;
        for &r_ms in &ref_starts {
            let expected = r_ms.saturating_sub(offset_ms);
            let mut idx = tgt_starts
                .partition_point(|&v| v < expected.saturating_sub(MATCH_TOL_MS))
                .max(min_tgt_idx);
            let mut best_idx = None;
            let mut best_res = i64::MAX;
            while idx < tgt_starts.len() && tgt_starts[idx] <= expected.saturating_add(MATCH_TOL_MS) {
                let res = tgt_starts[idx].saturating_add(offset_ms).abs_diff(r_ms) as i64;
                if res < best_res {
                    best_res = res;
                    best_idx = Some(idx);
                }
                idx += 1;
            }
            if let Some(b_idx) = best_idx {
                matches.push((r_ms, tgt_starts[b_idx]));
                min_tgt_idx = b_idx + 1;
            }
        }
        matches
    };

    #[derive(Clone, Copy)]
    struct Cand {
        offset_ms: i64,
        matches: usize,
        score: f64,
        segments: usize,
    }

    let mut evaluated: Vec<Cand> = seeds
        .into_iter()
        .map(|seed_off| {
            let initial = match_cues(seed_off);
            if initial.is_empty() {
                return Cand {
                    offset_ms: seed_off,
                    matches: 0,
                    score: 0.0,
                    segments: 0,
                };
            }
            let mut diffs: Vec<i64> = initial.iter().map(|(r, t)| r - t).collect();
            diffs.sort_unstable();
            let refined = diffs[diffs.len() / 2];
            let final_m = match_cues(refined);
            let score = (final_m.len() as f64) / (ref_starts.len() as f64);
            let first = ref_starts[0];
            let span = (ref_starts[ref_starts.len() - 1] - first).max(1);
            let mut seg_seen = [false; 3];
            for &(r_ms, _) in &final_m {
                let seg = (((r_ms - first) * 3) / (span + 1)).clamp(0, 2) as usize;
                seg_seen[seg] = true;
            }
            Cand {
                offset_ms: refined,
                matches: final_m.len(),
                score,
                segments: seg_seen.into_iter().filter(|&v| v).count(),
            }
        })
        .collect();
    evaluated.sort_by(|a, b| b.score.total_cmp(&a.score));

    let best = *evaluated.first()?;
    let second_score = evaluated
        .iter()
        .find(|c| (c.offset_ms - best.offset_ms).abs() >= DISTINCT_OFFSET_MS)
        .map(|c| c.score)
        .unwrap_or(0.0);
    let margin = best.score - second_score;
    if best.matches < MIN_MATCHED_CUES
        || best.score < MIN_COVERAGE
        || best.segments < REQUIRED_SEGMENTS
        || margin < MIN_MARGIN
    {
        return None;
    }
    Some(DelayOnlyAlignment {
        offset_ms: best.offset_ms as f64,
        score: best.score,
        margin,
        segments_passed: best.segments,
        stable_segment_margin_override: false,
    })
}

fn discover_activity_alignment(
    reference: &[SubtitleCue],
    target: &[SubtitleCue],
    reference_activity: &PreparedActivity,
    target_activity: &PreparedActivity,
    precomputed_unit_evidence: Option<&DelayOnlySearchEvidence>,
    cancel: &AtomicBool,
) -> Option<ActivityAlignment> {
    if reference.len() < MIN_CUES
        || target.len() < MIN_CUES
        || reference.len() > MAX_ALIGNMENT_CUES
        || target.len() > MAX_ALIGNMENT_CUES
    {
        return None;
    }
    if !reference.windows(2).all(|w| w[0].start_ms <= w[1].start_ms)
        || !target.windows(2).all(|w| w[0].start_ms <= w[1].start_ms)
    {
        return None;
    }

    let ref_coarse = &reference_activity.coarse;
    let mut coarse_candidates: Vec<ActivityCandidate> = Vec::new();
    let mut unit_scale_candidates: Vec<ActivityCandidate> = Vec::new();

    for scale in activity_scale_candidates(reference, target) {
        if is_cancelled(cancel) {
            return None;
        }
        if (scale - 1.0).abs() == 0.0 {
            if let Some(evidence) = precomputed_unit_evidence {
                for (idx, &score) in evidence.coarse_scores.iter().enumerate() {
                    if idx & 63 == 0 && is_cancelled(cancel) {
                        return None;
                    }
                    if score.is_nan() {
                        continue;
                    }
                    let offset_bins = evidence.first_offset_bins + idx as i32;
                    let cand = ActivityCandidate {
                        scale: 1.0,
                        intercept_ms: i64::from(offset_bins) * ACTIVITY_COARSE_BIN_MS,
                        score,
                    };
                    coarse_candidates.push(cand);
                    unit_scale_candidates.push(cand);
                }
                continue;
            }
        }

        let owned_target;
        let tgt_coarse = if (scale - 1.0).abs() == 0.0 {
            &target_activity.coarse
        } else {
            let Some(t) = build_activity_timeline(target, scale, ACTIVITY_COARSE_BIN_MS) else {
                continue;
            };
            owned_target = t;
            &owned_target
        };

        let (range_start, range_end) = coarse_offset_range(ref_coarse, tgt_coarse);
        for offset_bins in range_start..=range_end {
            if (offset_bins - range_start) & 63 == 0 && is_cancelled(cancel) {
                return None;
            }
            let Some(score) = score_activity_offset(ref_coarse, tgt_coarse, offset_bins) else {
                continue;
            };
            let cand = ActivityCandidate {
                scale,
                intercept_ms: i64::from(offset_bins) * ACTIVITY_COARSE_BIN_MS,
                score,
            };
            coarse_candidates.push(cand);
            if (scale - 1.0).abs() == 0.0 {
                unit_scale_candidates.push(cand);
            }
        }
    }

    let best_idx = coarse_candidates
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| {
            a.score
                .total_cmp(&b.score)
                .then_with(|| (b.scale - 1.0).abs().total_cmp(&(a.scale - 1.0).abs()))
                .then_with(|| b.intercept_ms.abs().cmp(&a.intercept_ms.abs()))
        })
        .map(|(idx, _)| idx)?;
    let coarse_best = coarse_candidates[best_idx];

    let target_start_ms = target.iter().map(|c| c.start_ms).min().unwrap_or(0) as f64;
    let target_end_ms = target.iter().map(|c| c.end_ms).max().unwrap_or(0) as f64;
    let second_score = coarse_candidates
        .iter()
        .enumerate()
        .filter(|&(idx, cand)| {
            idx != best_idx
                && is_distinct_activity_transform(coarse_best, *cand, target_start_ms, target_end_ms)
        })
        .map(|(_, cand)| cand.score)
        .max_by(|a, b| a.total_cmp(b))
        .unwrap_or(0.0);
    let mut margin = coarse_best.score - second_score;

    let owned_fine;
    let tgt_fine = if (coarse_best.scale - 1.0).abs() == 0.0 {
        &target_activity.fine
    } else {
        owned_fine = build_activity_timeline(target, coarse_best.scale, ACTIVITY_FINE_BIN_MS)?;
        &owned_fine
    };

    let (plateau_start, plateau_end) = coarse_plateau_ms(&coarse_candidates, best_idx);
    let fine_best = fine_activity_best(
        &reference_activity.fine,
        tgt_fine,
        &reference_activity.starts,
        &target_activity.starts,
        coarse_best.scale,
        plateau_start,
        plateau_end,
        cancel,
    );
    let mut best = fine_best.unwrap_or(coarse_best);

    let mut unit_seed = if let Some(ev) = precomputed_unit_evidence {
        let mut s = ev.seed;
        if (coarse_best.scale - 1.0).abs() != 0.0 {
            s.fine = None;
        }
        Some(s)
    } else {
        build_delay_only_search_seed(&unit_scale_candidates)
    };

    if let Some(ref mut s) = unit_seed {
        if (coarse_best.scale - 1.0).abs() > 0.0 && (coarse_best.scale - 1.0).abs() <= 0.002 {
            let unit_fine = fine_activity_best(
                &reference_activity.fine,
                &target_activity.fine,
                &reference_activity.starts,
                &target_activity.starts,
                1.0,
                s.plateau_start_ms,
                s.plateau_end_ms,
                cancel,
            );
            if let Some(uf) = unit_fine {
                let unit_onsets = onset_agreement(
                    &reference_activity.starts,
                    &target_activity.starts,
                    uf.scale,
                    uf.intercept_ms,
                );
                let best_onsets = onset_agreement(
                    &reference_activity.starts,
                    &target_activity.starts,
                    best.scale,
                    best.intercept_ms,
                );
                if uf.score > best.score + ACTIVITY_FINE_TIE_SCORE_EPSILON
                    || ((best.score - uf.score).abs() <= ACTIVITY_FINE_TIE_SCORE_EPSILON
                        && unit_onsets >= best_onsets)
                {
                    best = uf;
                    s.fine = Some(uf);
                    let second_unit_score = coarse_candidates
                        .iter()
                        .filter(|&&cand| {
                            let near_unit_scale =
                                (cand.scale - 1.0).abs() > 0.0 && (cand.scale - 1.0).abs() <= 0.002;
                            !near_unit_scale
                                && is_distinct_activity_transform(
                                    s.coarse,
                                    cand,
                                    target_start_ms,
                                    target_end_ms,
                                )
                        })
                        .map(|cand| cand.score)
                        .max_by(|a, b| a.total_cmp(b))
                        .unwrap_or(0.0);
                    margin = s.coarse.score - second_unit_score;
                }
            }
        } else if (best.scale - 1.0).abs() == 0.0 {
            s.fine = s.fine.or(fine_best);
        }
    }

    Some(ActivityAlignment {
        scale: best.scale,
        intercept_ms: best.intercept_ms as f64,
        score: best.score,
        margin,
        delay_only_seed: unit_seed,
    })
}

fn coarse_plateau_ms(candidates: &[ActivityCandidate], best_idx: usize) -> (i64, i64) {
    let best = candidates[best_idx];
    let floor = best.score - ACTIVITY_COARSE_PLATEAU_SCORE_EPSILON;
    let extent = |step: isize| -> i64 {
        let mut edge = best.intercept_ms;
        let mut idx = best_idx as isize + step;
        while idx >= 0 && (idx as usize) < candidates.len() {
            let cand = candidates[idx as usize];
            if cand.scale != best.scale
                || cand.intercept_ms != edge + (step as i64) * ACTIVITY_COARSE_BIN_MS
                || cand.score < floor
                || (cand.intercept_ms - best.intercept_ms).abs()
                    > ACTIVITY_COARSE_PLATEAU_MAX_EXTENT_MS
            {
                break;
            }
            edge = cand.intercept_ms;
            idx += step;
        }
        edge
    };
    (extent(-1), extent(1))
}

fn fine_activity_best(
    reference_fine: &ActivityTimeline,
    target_fine: &ActivityTimeline,
    reference_starts: &[i64],
    target_starts: &[i64],
    scale: f64,
    plateau_start_ms: i64,
    plateau_end_ms: i64,
    cancel: &AtomicBool,
) -> Option<ActivityCandidate> {
    let mut candidates = Vec::new();
    let mut fine_best: Option<ActivityCandidate> = None;
    let start_bin = (plateau_start_ms - ACTIVITY_FINE_RADIUS_MS).div_euclid(ACTIVITY_FINE_BIN_MS);
    let end_bin = (plateau_end_ms + ACTIVITY_FINE_RADIUS_MS + ACTIVITY_FINE_BIN_MS - 1)
        .div_euclid(ACTIVITY_FINE_BIN_MS);
    for offset_bins_i64 in start_bin..=end_bin {
        if is_cancelled(cancel) {
            return None;
        }
        let Ok(offset_bins) = i32::try_from(offset_bins_i64) else {
            continue;
        };
        if let Some(score) = score_activity_offset(reference_fine, target_fine, offset_bins) {
            let cand = ActivityCandidate {
                scale,
                intercept_ms: i64::from(offset_bins) * ACTIVITY_FINE_BIN_MS,
                score,
            };
            candidates.push(cand);
            if fine_best.is_none_or(|cur| cand.score > cur.score) {
                fine_best = Some(cand);
            }
        }
    }
    let best = fine_best?;
    let mut chosen = best;
    let mut chosen_onsets = -1.0f64;
    for cand in candidates {
        if cand.score < best.score - ACTIVITY_FINE_TIE_SCORE_EPSILON {
            continue;
        }
        if is_cancelled(cancel) {
            return None;
        }
        let onsets = onset_agreement(reference_starts, target_starts, scale, cand.intercept_ms);
        if onsets > chosen_onsets || (onsets == chosen_onsets && cand.score > chosen.score) {
            chosen = cand;
            chosen_onsets = onsets;
        }
    }
    Some(chosen)
}

fn onset_agreement(
    reference_starts: &[i64],
    target_starts: &[i64],
    scale: f64,
    intercept_ms: i64,
) -> f64 {
    if reference_starts.is_empty() {
        return 0.0;
    }
    let tol = ACTIVITY_ONSET_MATCH_TOLERANCE_MS;
    let mut agreement = 0.0;
    let mut cursor = 0usize;
    for &start in target_starts {
        let mapped = ((start as f64) * scale).round() as i64 + intercept_ms;
        while cursor < reference_starts.len() && reference_starts[cursor] < mapped {
            cursor += 1;
        }
        let mut nearest = i64::MAX;
        if let Some(&right) = reference_starts.get(cursor) {
            nearest = nearest.min(right.saturating_sub(mapped));
        }
        if let Some(&left) = cursor.checked_sub(1).and_then(|p| reference_starts.get(p)) {
            nearest = nearest.min(mapped.saturating_sub(left));
        }
        if nearest <= tol {
            agreement += ((tol - nearest) as f64) / (tol as f64);
        }
    }
    agreement
}

fn build_delay_only_search_seed(candidates: &[ActivityCandidate]) -> Option<DelayOnlySearchSeed> {
    let best_idx = candidates
        .iter()
        .enumerate()
        .max_by(|(_, a), (_, b)| a.score.total_cmp(&b.score))
        .map(|(i, _)| i)?;
    let coarse = candidates[best_idx];
    let second_score = candidates
        .iter()
        .filter(|c| (c.intercept_ms - coarse.intercept_ms).abs() >= DELAY_ONLY_DISTINCT_OFFSET_MS)
        .map(|c| c.score)
        .max_by(|a, b| a.total_cmp(b))
        .unwrap_or(0.0);
    let (p_start, p_end) = coarse_plateau_ms(candidates, best_idx);
    Some(DelayOnlySearchSeed {
        coarse,
        margin: coarse.score - second_score,
        fine: None,
        plateau_start_ms: p_start,
        plateau_end_ms: p_end,
    })
}

fn build_activity_timeline(
    cues: &[SubtitleCue],
    scale: f64,
    bin_ms: i64,
) -> Option<ActivityTimeline> {
    if !scale.is_finite() || !(ACTIVITY_MIN_SCALE..=ACTIVITY_MAX_SCALE).contains(&scale) {
        return None;
    }
    if cues.is_empty() || bin_ms <= 0 {
        return None;
    }

    let mut scaled: Vec<(i64, i64)> = Vec::with_capacity(cues.len());
    let mut max_end_ms = 0i64;
    for cue in cues {
        let safe_start = cue.start_ms.max(0);
        let safe_end = cue
            .end_ms
            .max(safe_start.saturating_add(1))
            .min(safe_start.saturating_add(ACTIVITY_MAX_CUE_DURATION_MS));
        let start = ((safe_start as f64) * scale).round() as i64;
        let start = start.max(0);
        let end = (((safe_end as f64) * scale).round() as i64).max(start.saturating_add(1));
        if end > ACTIVITY_MAX_TIMELINE_MS {
            continue;
        }
        scaled.push((start, end));
        max_end_ms = max_end_ms.max(end);
    }
    if scaled.len() < MIN_CUES {
        return None;
    }

    let bin_count = (((max_end_ms + 1) as f64) / (bin_ms as f64)).ceil() as usize;
    let bin_count = bin_count.max(1);
    let mut bins = vec![false; bin_count];
    for (start, end) in scaled {
        let first = ((start / bin_ms) as usize).min(bin_count - 1);
        let last_excl = (((end as f64) / (bin_ms as f64)).ceil() as usize).clamp(first + 1, bin_count);
        for b in &mut bins[first..last_excl] {
            *b = true;
        }
    }

    let active_count = bins.iter().filter(|&&b| b).count();
    if active_count == 0 {
        return None;
    }

    let mut prefix = vec![0i32; bin_count + 1];
    let mut packed = vec![0u64; (bin_count + 63) >> 6];
    let mut first_active = None;
    let mut last_active = 0usize;
    for (idx, &is_act) in bins.iter().enumerate() {
        if is_act {
            if first_active.is_none() {
                first_active = Some(idx);
            }
            last_active = idx;
            packed[idx >> 6] |= 1u64 << (idx & 63);
            prefix[idx + 1] = prefix[idx] + 1;
        } else {
            prefix[idx + 1] = prefix[idx];
        }
    }

    Some(ActivityTimeline {
        bins_len: bin_count,
        packed,
        active_count,
        prefix,
        first_active: first_active?,
        last_active,
    })
}

fn count_shifted_activity_intersection(
    reference: &ActivityTimeline,
    target: &ActivityTimeline,
    offset_bins: i32,
    source_start: usize,
    source_end: usize,
) -> i32 {
    if source_end < source_start {
        return 0;
    }
    let first_word = source_start >> 6;
    let last_word = source_end >> 6;
    let mut intersection = 0i32;
    for word_idx in first_word..=last_word {
        let start_bit = ((word_idx as isize) << 6) + offset_bins as isize;
        let aligned_ref = packed_activity_window(&reference.packed, start_bit);
        let first_bit = if word_idx == first_word {
            (source_start & 63) as u32
        } else {
            0
        };
        let last_bit = if word_idx == last_word {
            (source_end & 63) as u32
        } else {
            63
        };
        let mask = activity_range_mask(first_bit, last_bit);
        intersection += (target.packed[word_idx] & aligned_ref & mask).count_ones() as i32;
    }
    intersection
}

#[inline]
fn packed_activity_window(packed: &[u64], start_bit: isize) -> u64 {
    let word_idx = start_bit.div_euclid(64);
    let bit_offset = start_bit.rem_euclid(64) as u32;
    let low = usize::try_from(word_idx)
        .ok()
        .and_then(|i| packed.get(i).copied())
        .unwrap_or(0);
    if bit_offset == 0 {
        return low;
    }
    let high = usize::try_from(word_idx + 1)
        .ok()
        .and_then(|i| packed.get(i).copied())
        .unwrap_or(0);
    (low >> bit_offset) | (high << (64 - bit_offset))
}

#[inline]
fn activity_range_mask(first_bit: u32, last_bit: u32) -> u64 {
    let lower = u64::MAX << first_bit;
    let upper = if last_bit >= 63 {
        u64::MAX
    } else {
        (1u64 << (last_bit + 1)) - 1
    };
    lower & upper
}

fn score_activity_offset(
    reference: &ActivityTimeline,
    target: &ActivityTimeline,
    offset_bins: i32,
) -> Option<f64> {
    let ref_last = reference.bins_len.checked_sub(1)? as i32;
    let tgt_last = target.bins_len.checked_sub(1)? as i32;
    let source_start_i = 0.max(-offset_bins);
    let source_end_i = tgt_last.min(ref_last - offset_bins);
    if source_end_i < source_start_i {
        return None;
    }
    let source_start = source_start_i as usize;
    let source_end = source_end_i as usize;
    let visible_target = target.prefix[source_end + 1] - target.prefix[source_start];
    if visible_target <= 0 {
        return None;
    }

    let intersection = count_shifted_activity_intersection(
        reference,
        target,
        offset_bins,
        source_start,
        source_end,
    );

    let ref_win_start_i = 0.max(target.first_active as i32 + offset_bins);
    let ref_win_end_i = ref_last.min(target.last_active as i32 + offset_bins);
    if ref_win_end_i < ref_win_start_i {
        return None;
    }
    let ref_win_start = ref_win_start_i as usize;
    let ref_win_end = ref_win_end_i as usize;
    let ref_in_window = reference.prefix[ref_win_end + 1] - reference.prefix[ref_win_start];
    if ref_in_window <= 0 {
        return None;
    }

    let precision = (intersection as f64) / (visible_target as f64);
    let recall = (intersection as f64) / (ref_in_window as f64);
    let visibility = ((visible_target as f64) / (target.active_count as f64)).clamp(0.0, 1.0);
    Some((precision * 0.72 + recall * 0.28) * (0.85 + 0.15 * visibility))
}

fn target_activity_coverage_at_offset_segment(
    reference: &ActivityTimeline,
    target: &ActivityTimeline,
    offset_bins: i32,
    segment: usize,
) -> Option<f64> {
    if segment >= 3 {
        return None;
    }
    let active_span = target.last_active.checked_sub(target.first_active)? + 1;
    let seg_start = target.first_active + active_span * segment / 3;
    let seg_end = if segment == 2 {
        target.last_active
    } else {
        let seg_end_excl = target.first_active + active_span * (segment + 1) / 3;
        if seg_end_excl <= seg_start {
            return None;
        }
        seg_end_excl - 1
    };
    if seg_end < seg_start {
        return None;
    }
    let visible = target.prefix[seg_end + 1] - target.prefix[seg_start];
    if visible <= 0 {
        return None;
    }
    let intersection =
        count_shifted_activity_intersection(reference, target, offset_bins, seg_start, seg_end);
    Some((intersection as f64) / (visible as f64))
}

fn score_activity_offset_segment(
    reference: &ActivityTimeline,
    target: &ActivityTimeline,
    offset_bins: i32,
    segment: usize,
) -> Option<f64> {
    if segment >= 3 {
        return None;
    }
    let ref_last = reference.bins_len.checked_sub(1)? as i32;
    let active_span = target.last_active.checked_sub(target.first_active)? + 1;
    let seg_start = target.first_active + active_span * segment / 3;
    let seg_end = if segment == 2 {
        target.last_active
    } else {
        let seg_end_excl = target.first_active + active_span * (segment + 1) / 3;
        if seg_end_excl <= seg_start {
            return None;
        }
        seg_end_excl - 1
    };
    if seg_end < seg_start {
        return None;
    }
    let visible = target.prefix[seg_end + 1] - target.prefix[seg_start];
    if visible <= 0 {
        return None;
    }
    let intersection =
        count_shifted_activity_intersection(reference, target, offset_bins, seg_start, seg_end);

    let ref_win_start = 0.max(seg_start as i32 + offset_bins) as usize;
    let ref_win_end_i = ref_last.min(seg_end as i32 + offset_bins);
    if ref_win_end_i < ref_win_start as i32 {
        return None;
    }
    let ref_win_end = ref_win_end_i as usize;
    let ref_in_window = reference.prefix[ref_win_end + 1] - reference.prefix[ref_win_start];
    if ref_in_window <= 0 {
        return None;
    }
    let precision = (intersection as f64) / (visible as f64);
    let recall = (intersection as f64) / (ref_in_window as f64);
    Some(precision * 0.72 + recall * 0.28)
}

fn activity_scale_candidates(reference: &[SubtitleCue], target: &[SubtitleCue]) -> Vec<f64> {
    let mut candidates = vec![
        1.0,
        25.0 / 23.976,
        23.976 / 25.0,
        25.0 / 24.0,
        24.0 / 25.0,
        24.0 / 23.976,
        23.976 / 24.0,
    ];
    let ref_span = reference.last().map(|c| c.start_ms).unwrap_or(0)
        - reference.first().map(|c| c.start_ms).unwrap_or(0);
    let tgt_span = target.last().map(|c| c.start_ms).unwrap_or(0)
        - target.first().map(|c| c.start_ms).unwrap_or(0);
    if ref_span > 0 && tgt_span > 0 {
        let ratio = (ref_span as f64) / (tgt_span as f64);
        if ratio.is_finite()
            && (ACTIVITY_MIN_SCALE..=ACTIVITY_MAX_SCALE).contains(&ratio)
            && candidates.iter().all(|&u| (u - ratio).abs() >= ACTIVITY_SCALE_DEDUP)
        {
            candidates.push(ratio);
        }
    }
    candidates.sort_by(|a, b| a.total_cmp(b));
    candidates
}

fn coarse_offset_range(reference: &ActivityTimeline, target: &ActivityTimeline) -> (i32, i32) {
    let base_bins = (ACTIVITY_MAX_OFFSET_MS / ACTIVITY_COARSE_BIN_MS) as i32;
    let ref_span = (reference.last_active as i64 - reference.first_active as i64) as f64;
    let tgt_span = (target.last_active as i64 - target.first_active as i64) as f64;
    if tgt_span >= ref_span * PARTIAL_TARGET_SPAN_RATIO {
        return (-base_bins, base_bins);
    }
    let start = (-base_bins).min(reference.first_active as i32 - target.first_active as i32 - base_bins);
    let end = base_bins.max(reference.last_active as i32 - target.last_active as i32 + base_bins);
    (start, end)
}

fn is_distinct_activity_transform(
    first: ActivityCandidate,
    second: ActivityCandidate,
    target_start_ms: f64,
    target_end_ms: f64,
) -> bool {
    let start_diff = (target_start_ms * first.scale + first.intercept_ms as f64
        - (target_start_ms * second.scale + second.intercept_ms as f64))
        .abs();
    let end_diff = (target_end_ms * first.scale + first.intercept_ms as f64
        - (target_end_ms * second.scale + second.intercept_ms as f64))
        .abs();
    start_diff.max(end_diff) >= ACTIVITY_DISTINCT_TRANSFORM_MS
}

// ---------- Seeded Banded DP ----------

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
enum Step {
    Unreachable = 0,
    Start = 1,
    Group = 2,
    SkipReference = 3,
    SkipTarget = 4,
}

struct BandedDpRows {
    row_count: usize,
    row_starts: Vec<usize>,
    row_ends: Vec<usize>,
    row_offsets: Vec<usize>,
    min_reachable_ref: Vec<usize>,
    costs: Vec<f64>,
    prev_ref: Vec<i32>,
    prev_tgt: Vec<i32>,
    ref_counts: Vec<u8>,
    tgt_counts: Vec<u8>,
    step_codes: Vec<Step>,
    local_group_costs: Vec<f64>,
}

const MAX_BANDED_DP_CELLS: usize = 4_000_000;

impl BandedDpRows {
    fn try_new(target_size: usize, reference_size: usize, centers: &[usize]) -> Option<Self> {
        let row_count = target_size + 1;
        let mut row_starts = vec![0usize; row_count];
        let mut row_ends = vec![0usize; row_count];
        let mut row_offsets = vec![0usize; row_count + 1];
        let mut total_cells = 0usize;
        for tgt_idx in 0..=target_size {
            let start = if tgt_idx == 0 {
                0
            } else {
                centers[tgt_idx].saturating_sub(BAND_RADIUS_CUES)
            };
            // Extend each row at least up to the next row's center so SkipReference bridges >58-cue gaps.
            let next_center = if tgt_idx < target_size {
                centers[tgt_idx + 1]
            } else {
                centers[tgt_idx]
            };
            let end = (centers[tgt_idx] + BAND_RADIUS_CUES)
                .max(next_center)
                .min(reference_size);
            row_starts[tgt_idx] = start;
            row_ends[tgt_idx] = end;
            row_offsets[tgt_idx] = total_cells;
            total_cells = total_cells.checked_add(end.saturating_sub(start) + 1)?;
            if total_cells > MAX_BANDED_DP_CELLS {
                return None;
            }
        }
        row_offsets[row_count] = total_cells;
        Some(Self {
            row_count,
            row_starts,
            row_ends,
            row_offsets,
            min_reachable_ref: vec![usize::MAX; row_count],
            costs: vec![f64::INFINITY; total_cells],
            prev_ref: vec![-1; total_cells],
            prev_tgt: vec![-1; total_cells],
            ref_counts: vec![0; total_cells],
            tgt_counts: vec![0; total_cells],
            step_codes: vec![Step::Unreachable; total_cells],
            local_group_costs: vec![0.0; total_cells],
        })
    }

    fn set_start(&mut self) {
        if let Some(cell) = self.index_of(0, 0) {
            self.costs[cell] = 0.0;
            self.step_codes[cell] = Step::Start;
            self.min_reachable_ref[0] = 0;
        }
    }

    #[inline]
    fn index_of(&self, target_index: usize, reference_index: usize) -> Option<usize> {
        if target_index >= self.row_count {
            return None;
        }
        let start = self.row_starts[target_index];
        let end = self.row_ends[target_index];
        if reference_index < start || reference_index > end {
            return None;
        }
        Some(self.row_offsets[target_index] + reference_index - start)
    }

    #[inline]
    fn is_reachable(&self, cell: usize) -> bool {
        self.step_codes[cell] != Step::Unreachable
    }

    #[allow(clippy::too_many_arguments)]
    fn write(
        &mut self,
        cell: usize,
        target_index: usize,
        reference_index: usize,
        cost: f64,
        prev_ref: usize,
        prev_tgt: usize,
        ref_count: usize,
        tgt_count: usize,
        step: Step,
        local_group_cost: f64,
    ) {
        self.costs[cell] = cost;
        self.prev_ref[cell] = prev_ref as i32;
        self.prev_tgt[cell] = prev_tgt as i32;
        self.ref_counts[cell] = ref_count as u8;
        self.tgt_counts[cell] = tgt_count as u8;
        self.step_codes[cell] = step;
        self.local_group_costs[cell] = local_group_cost;
        if reference_index < self.min_reachable_ref[target_index] {
            self.min_reachable_ref[target_index] = reference_index;
        }
    }
}

struct BacktrackStep {
    step: Step,
    prev_ref: usize,
    prev_tgt: usize,
    ref_count: usize,
    tgt_count: usize,
    local_group_cost: f64,
}

fn retime_with_seed(
    reference: &[SubtitleCue],
    target: &[SubtitleCue],
    coarse_scale: f64,
    coarse_intercept_ms: f64,
    cancel: &AtomicBool,
) -> Option<TimelineRetimeResult> {
    if reference.len() < MIN_CUES
        || target.len() < MIN_CUES
        || reference.len() > MAX_ALIGNMENT_CUES
        || target.len() > MAX_ALIGNMENT_CUES
    {
        return None;
    }
    if !reference.windows(2).all(|w| w[0].start_ms <= w[1].start_ms)
        || !target.windows(2).all(|w| w[0].start_ms <= w[1].start_ms)
    {
        return None;
    }
    if !coarse_scale.is_finite() || !(0.85..=1.15).contains(&coarse_scale) {
        return None;
    }
    if !coarse_intercept_ms.is_finite() {
        return None;
    }

    let ref_len = reference.len();
    let tgt_len = target.len();
    let mut ref_starts = Vec::with_capacity(ref_len);
    let mut ref_ends = Vec::with_capacity(ref_len);
    let mut est_end_prefix = Vec::with_capacity(ref_len + 1);
    est_end_prefix.push(0i32);
    for (i, cue) in reference.iter().enumerate() {
        if i & 0xff == 0 && is_cancelled(cancel) {
            return None;
        }
        ref_starts.push(cue.start_ms as f64);
        ref_ends.push(cue.end_ms as f64);
        let prev = *est_end_prefix.last().unwrap_or(&0);
        est_end_prefix.push(prev + i32::from(cue.estimated_end));
    }

    let mut tgt_tx_starts = Vec::with_capacity(tgt_len);
    let mut tgt_tx_ends = Vec::with_capacity(tgt_len);
    for (i, cue) in target.iter().enumerate() {
        if i & 0xff == 0 && is_cancelled(cancel) {
            return None;
        }
        tgt_tx_starts.push(transform_time_f64(cue.start_ms, coarse_scale, coarse_intercept_ms));
        tgt_tx_ends.push(transform_time_f64(cue.end_ms, coarse_scale, coarse_intercept_ms));
    }

    let mut centers = Vec::with_capacity(tgt_len + 1);
    for &tx_start in &tgt_tx_starts {
        let pred = (tx_start.round() as i64).max(0);
        centers.push(lower_bound_reference(reference, pred));
    }
    let pred_end = (tgt_tx_ends[tgt_len - 1].round() as i64).max(0);
    centers.push(lower_bound_reference(reference, pred_end));

    let mut rows = BandedDpRows::try_new(tgt_len, ref_len, &centers)?;
    let mut final_row_costs: HashMap<usize, f64> = HashMap::new();
    rows.set_start();

    for tgt_idx in 0..=tgt_len {
        if is_cancelled(cancel) {
            return None;
        }
        let min_r = rows.min_reachable_ref[tgt_idx];
        if min_r == usize::MAX {
            continue;
        }
        let row_max = rows.row_ends[tgt_idx];
        let mut ref_idx = min_r;
        while ref_idx <= row_max {
            let Some(cell_idx) = rows.index_of(tgt_idx, ref_idx) else {
                ref_idx += 1;
                continue;
            };
            if !rows.is_reachable(cell_idx) {
                ref_idx += 1;
                continue;
            }
            let cell_cost = rows.costs[cell_idx];

            if ref_idx < ref_len && ref_idx + 1 <= row_max {
                relax(
                    &mut rows,
                    &mut final_row_costs,
                    tgt_len,
                    tgt_idx,
                    ref_idx + 1,
                    cell_cost + SKIP_REFERENCE_COST,
                    ref_idx,
                    tgt_idx,
                    1,
                    0,
                    Step::SkipReference,
                    0.0,
                );
            }
            if tgt_idx < tgt_len && rows.index_of(tgt_idx + 1, ref_idx).is_some() {
                relax(
                    &mut rows,
                    &mut final_row_costs,
                    tgt_len,
                    tgt_idx + 1,
                    ref_idx,
                    cell_cost + SKIP_TARGET_COST,
                    ref_idx,
                    tgt_idx,
                    0,
                    1,
                    Step::SkipTarget,
                    0.0,
                );
            }

            for (r_cnt, t_cnt) in GROUP_SHAPES {
                let next_ref = ref_idx + r_cnt;
                let next_tgt = tgt_idx + t_cnt;
                if next_ref > ref_len || next_tgt > tgt_len {
                    continue;
                }
                if rows.index_of(next_tgt, next_ref).is_none() {
                    continue;
                }
                let g_cost = group_cost(
                    &ref_starts,
                    &ref_ends,
                    &est_end_prefix,
                    ref_idx,
                    r_cnt,
                    &tgt_tx_starts,
                    &tgt_tx_ends,
                    tgt_idx,
                    t_cnt,
                );
                if !g_cost.is_finite() || g_cost > MAX_GROUP_COST {
                    continue;
                }
                let complexity = GROUP_COMPLEXITY_COST * ((r_cnt + t_cnt - 2) as f64);
                relax(
                    &mut rows,
                    &mut final_row_costs,
                    tgt_len,
                    next_tgt,
                    next_ref,
                    cell_cost + g_cost + complexity,
                    ref_idx,
                    tgt_idx,
                    r_cnt,
                    t_cnt,
                    Step::Group,
                    g_cost,
                );
            }

            ref_idx += 1;
        }
    }

    let (&final_ref_idx, _) = final_row_costs
        .iter()
        .min_by(|a, b| a.1.total_cmp(b.1).then_with(|| a.0.cmp(b.0)))?;

    let steps = backtrack(&rows, final_ref_idx, tgt_len)?;
    let groups: Vec<CueGroup> = steps
        .into_iter()
        .filter(|s| s.step == Step::Group)
        .map(|s| CueGroup {
            reference_start_index: s.prev_ref,
            reference_count: s.ref_count,
            target_start_index: s.prev_tgt,
            target_count: s.tgt_count,
            cost: s.local_group_cost,
        })
        .collect();
    if groups.is_empty() {
        return None;
    }

    let mut matched_target = vec![false; tgt_len];
    let mut matched_ref = vec![false; ref_len];
    let mut retimed: Vec<RetimedCue> = target
        .iter()
        .map(|cue| {
            let s = transform_time(cue.start_ms, coarse_scale, coarse_intercept_ms);
            let e = transform_time(cue.end_ms, coarse_scale, coarse_intercept_ms).max(s + 1);
            RetimedCue {
                original_start_ms: cue.start_ms,
                original_end_ms: cue.end_ms,
                start_ms: s,
                end_ms: e,
            }
        })
        .collect();

    let raw_shifts: Vec<i64> = groups
        .iter()
        .map(|g| reference[g.reference_start_index].start_ms - retimed[g.target_start_index].start_ms)
        .collect();
    let group_shifts = reject_local_shift_outliers(&raw_shifts);

    for (g_idx, group) in groups.iter().enumerate() {
        for flag in &mut matched_target[group.target_start_index..group.target_start_index + group.target_count] {
            *flag = true;
        }
        for flag in &mut matched_ref[group.reference_start_index..group.reference_start_index + group.reference_count] {
            *flag = true;
        }
        transplant_group_timing(group, &mut retimed, group_shifts[g_idx]);
    }

    // Keep output monotonic even if source cues had backwards timestamps.
    for idx in 0..retimed.len() {
        let prev_start = if idx > 0 {
            retimed[idx - 1].start_ms
        } else {
            i64::MIN
        };
        let cue = &mut retimed[idx];
        let start = cue.start_ms.max(prev_start);
        let end = cue.end_ms.max(start + 1);
        cue.start_ms = start;
        cue.end_ms = end;
    }

    // Never introduce a new overlap between sequential source cues.
    for idx in 0..retimed.len().saturating_sub(1) {
        if target[idx].end_ms > target[idx + 1].start_ms {
            continue;
        }
        let next_start = retimed[idx + 1].start_ms;
        if retimed[idx].end_ms > next_start && next_start > retimed[idx].start_ms {
            retimed[idx].end_ms = next_start;
        }
    }

    let matched_target_count = matched_target.iter().filter(|&&v| v).count();
    let matched_ref_count = matched_ref.iter().filter(|&&v| v).count();
    let target_coverage = (matched_target_count as f64) / (tgt_len as f64);
    let reference_coverage = (matched_ref_count as f64) / (ref_len as f64);
    let skipped_target = tgt_len - matched_target_count;
    let skipped_reference = ref_len - matched_ref_count;
    let longest_skip_run = longest_false_run(&matched_target);
    let average_group_cost =
        groups.iter().map(|g| g.cost).sum::<f64>() / (groups.len() as f64);

    let mut group_residuals: Vec<f64> = groups
        .iter()
        .map(|g| (ref_starts[g.reference_start_index] - tgt_tx_starts[g.target_start_index]).abs())
        .collect();
    group_residuals.sort_by(|a, b| a.total_cmp(b));
    let median_residual = group_residuals[group_residuals.len() / 2];

    let min_matched = MIN_MATCHED_TARGET_CUES.min(tgt_len);
    let mut reject_reasons: Vec<String> = Vec::new();
    if matched_target_count < min_matched {
        reject_reasons.push(format!("matchedTarget={}<{}", matched_target_count, min_matched));
    }
    if target_coverage < MIN_TARGET_COVERAGE {
        reject_reasons.push(format!(
            "targetCoverage={}<{}",
            round3(target_coverage),
            MIN_TARGET_COVERAGE
        ));
    }
    if average_group_cost > MAX_AVERAGE_GROUP_COST {
        reject_reasons.push(format!(
            "avgGroupCost={}>{}",
            round3(average_group_cost),
            MAX_AVERAGE_GROUP_COST
        ));
    }
    if longest_skip_run > MAX_LONGEST_TARGET_SKIP_RUN {
        reject_reasons.push(format!(
            "targetSkipRun={}>{}",
            longest_skip_run, MAX_LONGEST_TARGET_SKIP_RUN
        ));
    }
    let confident = reject_reasons.is_empty();

    let (mut c11, mut c12, mut c21, mut c13, mut c31, mut c22) = (0, 0, 0, 0, 0, 0);
    for g in &groups {
        match (g.reference_count, g.target_count) {
            (1, 1) => c11 += 1,
            (1, 2) => c12 += 1,
            (2, 1) => c21 += 1,
            (1, 3) => c13 += 1,
            (3, 1) => c31 += 1,
            (2, 2) => c22 += 1,
            _ => {}
        }
    }

    Some(TimelineRetimeResult {
        cues: retimed,
        groups,
        target_coverage,
        reference_coverage,
        skipped_target_cues: skipped_target,
        skipped_reference_cues: skipped_reference,
        longest_target_skip_run: longest_skip_run,
        average_group_cost,
        one_to_one_groups: c11,
        one_to_two_groups: c12,
        two_to_one_groups: c21,
        one_to_three_groups: c13,
        three_to_one_groups: c31,
        two_to_two_groups: c22,
        confident,
        alignment_source: "provided",
        alignment_scale: coarse_scale,
        alignment_intercept_ms: coarse_intercept_ms,
        activity_score: 0.0,
        activity_margin: 0.0,
        coverage_segments_passed: 0,
        simple_group_ratio: 0.0,
        localized_mismatch_ignored: false,
        median_group_residual_ms: median_residual,
        reject_reason: if reject_reasons.is_empty() {
            None
        } else {
            Some(reject_reasons.join(","))
        },
    })
}

fn relax(
    rows: &mut BandedDpRows,
    final_row_costs: &mut HashMap<usize, f64>,
    final_target_idx: usize,
    to_tgt: usize,
    to_ref: usize,
    cand_cost: f64,
    prev_ref: usize,
    prev_tgt: usize,
    ref_count: usize,
    tgt_count: usize,
    step: Step,
    local_group_cost: f64,
) {
    let Some(cell) = rows.index_of(to_tgt, to_ref) else {
        return;
    };
    let cur = rows.costs[cell];
    if !rows.is_reachable(cell) || cand_cost + 1e-9 < cur {
        rows.write(
            cell,
            to_tgt,
            to_ref,
            cand_cost,
            prev_ref,
            prev_tgt,
            ref_count,
            tgt_count,
            step,
            local_group_cost,
        );
        if to_tgt == final_target_idx {
            final_row_costs.insert(to_ref, cand_cost);
        }
    }
}

fn backtrack(
    rows: &BandedDpRows,
    final_ref_idx: usize,
    final_tgt_idx: usize,
) -> Option<Vec<BacktrackStep>> {
    let mut rev = Vec::new();
    let mut ref_idx = final_ref_idx;
    let mut tgt_idx = final_tgt_idx;
    let mut guard = 0usize;
    let guard_limit = rows.row_count * 8 + final_ref_idx * 2 + 32;
    while ref_idx != 0 || tgt_idx != 0 {
        guard += 1;
        if guard > guard_limit {
            return None;
        }
        let cell = rows.index_of(tgt_idx, ref_idx)?;
        if !rows.is_reachable(cell) {
            return None;
        }
        let step = rows.step_codes[cell];
        if step == Step::Start || step == Step::Unreachable {
            return None;
        }
        let prev_ref = usize::try_from(rows.prev_ref[cell]).ok()?;
        let prev_tgt = usize::try_from(rows.prev_tgt[cell]).ok()?;
        rev.push(BacktrackStep {
            step,
            prev_ref,
            prev_tgt,
            ref_count: usize::from(rows.ref_counts[cell]),
            tgt_count: usize::from(rows.tgt_counts[cell]),
            local_group_cost: rows.local_group_costs[cell],
        });
        ref_idx = prev_ref;
        tgt_idx = prev_tgt;
    }
    rev.reverse();
    Some(rev)
}

#[inline]
fn lower_bound_reference(reference: &[SubtitleCue], time_ms: i64) -> usize {
    reference.partition_point(|c| c.start_ms < time_ms)
}

#[inline]
fn transform_time_f64(time_ms: i64, scale: f64, intercept_ms: f64) -> f64 {
    (time_ms as f64) * scale + intercept_ms
}

#[inline]
fn transform_time(time_ms: i64, scale: f64, intercept_ms: f64) -> i64 {
    (transform_time_f64(time_ms, scale, intercept_ms).round() as i64).max(0)
}

#[allow(clippy::too_many_arguments)]
fn group_cost(
    ref_starts: &[f64],
    ref_ends: &[f64],
    est_end_prefix: &[i32],
    ref_idx: usize,
    ref_count: usize,
    tgt_tx_starts: &[f64],
    tgt_tx_ends: &[f64],
    tgt_idx: usize,
    tgt_count: usize,
) -> f64 {
    let r_start = ref_starts[ref_idx];
    let r_end = ref_ends[ref_idx + ref_count - 1];
    let t_start = tgt_tx_starts[tgt_idx];
    let t_end = tgt_tx_ends[tgt_idx + tgt_count - 1];

    let r_dur = (r_end - r_start).max(1.0);
    let t_dur = (t_end - t_start).max(1.0);
    let r_mid = (r_start + r_end) * 0.5;
    let t_mid = (t_start + t_end) * 0.5;

    let start_err = (r_start - t_start).abs() / START_END_TOLERANCE_MS;
    let end_err = (r_end - t_end).abs() / START_END_TOLERANCE_MS;
    let mid_err = (r_mid - t_mid).abs() / MIDPOINT_TOLERANCE_MS;
    let dur_err = (r_dur - t_dur).abs() / DURATION_TOLERANCE_MS;
    let est_end = est_end_prefix[ref_idx + ref_count] != est_end_prefix[ref_idx];

    if est_end {
        start_err * 0.58 + end_err * 0.16 + mid_err * 0.16 + dur_err * 0.10
    } else {
        start_err * 0.34 + end_err * 0.34 + mid_err * 0.18 + dur_err * 0.14
    }
}

fn reject_local_shift_outliers(shifts: &[i64]) -> Vec<i64> {
    let window_size = LOCAL_SHIFT_RADIUS_GROUPS * 2 + 1;
    if shifts.len() < window_size {
        return shifts.to_vec();
    }
    let mut win = Vec::with_capacity(window_size);
    (0..shifts.len())
        .map(|idx| {
            let from = idx.saturating_sub(LOCAL_SHIFT_RADIUS_GROUPS);
            let to = (idx + LOCAL_SHIFT_RADIUS_GROUPS).min(shifts.len() - 1);
            win.clear();
            win.extend_from_slice(&shifts[from..=to]);
            win.sort_unstable();
            let median = win[win.len() / 2];
            if (shifts[idx] - median).abs() <= LOCAL_SHIFT_MAX_DEVIATION_MS {
                shifts[idx]
            } else {
                median
            }
        })
        .collect()
}

fn transplant_group_timing(group: &CueGroup, output: &mut [RetimedCue], group_shift_ms: i64) {
    let start_idx = group.target_start_index;
    let end_idx = start_idx + group.target_count;
    for cue in &mut output[start_idx..end_idx] {
        let dur = (cue.end_ms - cue.start_ms).max(1);
        let new_start = cue.start_ms.saturating_add(group_shift_ms).max(0);
        cue.start_ms = new_start;
        cue.end_ms = new_start.saturating_add(dur);
    }
}

fn coverage_segments_passed(result: &TimelineRetimeResult, target_size: usize) -> usize {
    if target_size < MIN_CUES || result.groups.is_empty() {
        return 0;
    }
    let mut matched = vec![false; target_size];
    let mut costs: [Vec<f64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for g in &result.groups {
        let g_end = (g.target_start_index + g.target_count).min(target_size);
        for m in &mut matched[g.target_start_index..g_end] {
            *m = true;
        }
        let midpoint = g.target_start_index + (g.target_count - 1) / 2;
        let seg = ((midpoint * 3) / target_size.max(1)).min(2);
        costs[seg].push(g.cost);
    }
    let mut passed = 0usize;
    for seg in 0..3 {
        let start = seg * target_size / 3;
        let end = if seg == 2 {
            target_size
        } else {
            (seg + 1) * target_size / 3
        };
        let len = (end - start).max(1);
        let matched_count = matched[start..end].iter().filter(|&&m| m).count();
        let coverage = (matched_count as f64) / (len as f64);
        let avg_cost = if costs[seg].is_empty() {
            f64::INFINITY
        } else {
            costs[seg].iter().sum::<f64>() / (costs[seg].len() as f64)
        };
        let required_groups = ((len * 2) / 3).max(2).min(COVERAGE_SEGMENT_MIN_GROUPS).min(len);
        if coverage >= COVERAGE_SEGMENT_MIN_COVERAGE
            && avg_cost <= COVERAGE_SEGMENT_MAX_AVERAGE_COST
            && costs[seg].len() >= required_groups
        {
            passed += 1;
        }
    }
    passed
}

fn structural_group_ratio(
    result: &TimelineRetimeResult,
    reference_size: usize,
    target_size: usize,
) -> f64 {
    if result.groups.is_empty() {
        return 0.0;
    }
    let mut compatible = result.one_to_one_groups
        + result.one_to_two_groups
        + result.two_to_one_groups
        + result.two_to_two_groups;
    let enough_cov = result.target_coverage >= SEGMENTATION_MIN_TIMELINE_COVERAGE
        && result.reference_coverage >= SEGMENTATION_MIN_TIMELINE_COVERAGE;
    if enough_cov {
        let ref_per_tgt = (reference_size as f64) / (target_size.max(1) as f64);
        let tgt_per_ref = (target_size as f64) / (reference_size.max(1) as f64);
        if ref_per_tgt >= SEGMENTATION_IMBALANCE_RATIO {
            compatible += result.three_to_one_groups;
        }
        if tgt_per_ref >= SEGMENTATION_IMBALANCE_RATIO {
            compatible += result.one_to_three_groups;
        }
    }
    (compatible as f64) / (result.groups.len() as f64)
}

fn refine_grouped_reply_timing(
    reference: &[SubtitleCue],
    target: &[SubtitleCue],
    mut result: TimelineRetimeResult,
    cancel: &AtomicBool,
) -> TimelineRetimeResult {
    if !result.confident || result.two_to_two_groups == 0 || result.cues.len() != target.len() {
        return result;
    }
    let is_valid_cue = |c: &SubtitleCue| c.start_ms >= 0 && c.end_ms > c.start_ms;
    let is_valid_retimed = |c: &RetimedCue| c.start_ms >= 0 && c.end_ms > c.start_ms;

    for g_idx in 0..result.groups.len() {
        if g_idx & 0xff == 0 && is_cancelled(cancel) {
            return result;
        }
        let g = result.groups[g_idx].clone();
        if g.reference_count != 2 || g.target_count != 2 {
            continue;
        }
        let r0_idx = g.reference_start_index;
        let r1_idx = r0_idx + 1;
        let t0_idx = g.target_start_index;
        let t1_idx = t0_idx + 1;
        if r1_idx >= reference.len() || t1_idx >= target.len() {
            continue;
        }
        let r0 = &reference[r0_idx];
        let r1 = &reference[r1_idx];
        let t0 = &target[t0_idx];
        let t1 = &target[t1_idx];
        if !is_valid_cue(r0) || !is_valid_cue(r1) || !is_valid_cue(t0) || !is_valid_cue(t1) {
            continue;
        }
        if r0.estimated_end || r1.estimated_end {
            continue;
        }
        let ref_gap = r1.start_ms - r0.end_ms;
        if r0.start_ms >= r1.start_ms
            || ref_gap < GROUPED_REPLY_MIN_REFERENCE_GAP_MS
            || has_ambiguous_reference_gap(reference, r0_idx, r1_idx)
        {
            continue;
        }
        if t0.start_ms >= t1.start_ms
            || t0.end_ms > t1.start_ms
            || (t0_idx > 0 && target[t0_idx - 1].end_ms > t0.start_ms)
            || (t1_idx + 1 < target.len() && t1.end_ms > target[t1_idx + 1].start_ms)
        {
            continue;
        }
        let out0 = &result.cues[t0_idx];
        let out1 = &result.cues[t1_idx];
        if !is_valid_retimed(out0)
            || !is_valid_retimed(out1)
            || out0.original_start_ms != t0.start_ms
            || out0.original_end_ms != t0.end_ms
            || out1.original_start_ms != t1.start_ms
            || out1.original_end_ms != t1.end_ms
            || out0.end_ms > out1.start_ms
        {
            continue;
        }
        if (out0.start_ms - r0.start_ms).abs() > GROUPED_REPLY_ENDPOINT_TOLERANCE_MS
            || (out1.end_ms - r1.end_ms).abs() > GROUPED_REPLY_ENDPOINT_TOLERANCE_MS
        {
            continue;
        }
        let start_adj = r1.start_ms - out1.start_ms;
        if !(GROUPED_REPLY_MIN_EARLY_START_MS..=GROUPED_REPLY_MAX_START_ADJUSTMENT_MS)
            .contains(&start_adj)
        {
            continue;
        }
        let local_shift = r0.start_ms
            - transform_time(
                t0.start_ms,
                result.alignment_scale,
                result.alignment_intercept_ms,
            );
        if !has_supporting_simple_group(
            reference,
            target,
            &result.groups,
            g_idx,
            -1,
            local_shift,
            result.alignment_scale,
            result.alignment_intercept_ms,
        ) || !has_supporting_simple_group(
            reference,
            target,
            &result.groups,
            g_idx,
            1,
            local_shift,
            result.alignment_scale,
            result.alignment_intercept_ms,
        ) {
            continue;
        }
        let proposed_start = r1.start_ms;
        if proposed_start < out0.end_ms
            || proposed_start >= out1.end_ms
            || (t1_idx + 1 < result.cues.len() && proposed_start >= result.cues[t1_idx + 1].start_ms)
        {
            continue;
        }
        let cur_dur = out1.end_ms - out1.start_ms;
        let prop_dur = out1.end_ms - proposed_start;
        if prop_dur < GROUPED_REPLY_MIN_RESULT_DURATION_MS || prop_dur * 2 < cur_dur {
            continue;
        }
        result.cues[t1_idx].start_ms = proposed_start;
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn has_supporting_simple_group(
    reference: &[SubtitleCue],
    target: &[SubtitleCue],
    groups: &[CueGroup],
    group_index: usize,
    direction: isize,
    expected_shift_ms: i64,
    scale: f64,
    intercept_ms: f64,
) -> bool {
    for dist in 1..=GROUPED_REPLY_CONTEXT_GROUP_RADIUS {
        let neighbor_idx = group_index as isize + direction * (dist as isize);
        if neighbor_idx < 0 || (neighbor_idx as usize) >= groups.len() {
            break;
        }
        let neighbor = &groups[neighbor_idx as usize];
        if neighbor.reference_count != 1 || neighbor.target_count != 1 {
            continue;
        }
        let r_cue = &reference[neighbor.reference_start_index];
        let t_cue = &target[neighbor.target_start_index];
        if r_cue.start_ms < 0 || r_cue.end_ms <= r_cue.start_ms || t_cue.start_ms < 0 || t_cue.end_ms <= t_cue.start_ms {
            continue;
        }
        let neighbor_shift = r_cue.start_ms - transform_time(t_cue.start_ms, scale, intercept_ms);
        return (neighbor_shift - expected_shift_ms).abs() <= GROUPED_REPLY_CONTEXT_SHIFT_TOLERANCE_MS;
    }
    false
}

fn has_ambiguous_reference_gap(reference: &[SubtitleCue], r0_idx: usize, r1_idx: usize) -> bool {
    let r0 = &reference[r0_idx];
    let r1 = &reference[r1_idx];
    let gap_start = r0.end_ms;
    let gap_end = r1.start_ms;
    let start_i = r0_idx.saturating_sub(GROUPED_REPLY_REFERENCE_NEIGHBOR_RADIUS);
    let end_i = (r1_idx + GROUPED_REPLY_REFERENCE_NEIGHBOR_RADIUS).min(reference.len() - 1);
    for (idx, cue) in reference.iter().enumerate().take(end_i + 1).skip(start_i) {
        if idx == r0_idx || idx == r1_idx {
            continue;
        }
        if cue.start_ms < 0 || cue.end_ms <= cue.start_ms {
            return true;
        }
        if cue.start_ms < gap_end && cue.end_ms > gap_start {
            return true;
        }
        if (cue.start_ms - r1.start_ms).abs() <= GROUPED_REPLY_ENDPOINT_TOLERANCE_MS {
            return true;
        }
    }
    false
}

fn longest_false_run(values: &[bool]) -> usize {
    let mut longest = 0usize;
    let mut cur = 0usize;
    for &v in values {
        if v {
            cur = 0;
        } else {
            cur += 1;
            longest = longest.max(cur);
        }
    }
    longest
}

#[inline]
fn round3(value: f64) -> f64 {
    (value * 1_000.0).round() / 1_000.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_dialogue_cues(count: usize, offset_ms: i64, scale: f64) -> Vec<SubtitleCue> {
        let mut cues = Vec::with_capacity(count);
        let mut t = 2_000i64;
        let mut rng: u64 = 0x9e37_79b9_7f4a_7c15;
        for i in 0..count {
            rng = rng
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let r1 = (rng >> 33) as i64;
            let dur = 900 + (r1 % 1_900);
            rng = rng
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            let r2 = (rng >> 33) as i64;
            let gap = if i % 11 == 5 {
                8_500 + (r2 % 4_500)
            } else {
                800 + (r2 % 5_700)
            };
            let start = ((t as f64) * scale).round() as i64 + offset_ms;
            let end = (((t + dur) as f64) * scale).round() as i64 + offset_ms;
            cues.push(SubtitleCue::new(
                start.max(0),
                end.max(start + 100),
                format!("Cue {i}"),
            ));
            t += dur + gap;
        }
        cues
    }

    #[test]
    fn aligns_constant_positive_and_negative_offsets() {
        let cancel = AtomicBool::new(false);
        let reference = make_dialogue_cues(80, 0, 1.0);

        let late_target = make_dialogue_cues(80, 2_400, 1.0);
        let res = retime_with_discovery(
            &reference,
            &late_target,
            false,
            None,
            None,
            None,
            None,
            true,
            &cancel,
        )
        .expect("late result");
        assert!(res.confident, "expected confident, got {:?}", res.reject_reason);
        assert!((res.alignment_scale - 1.0).abs() < 1e-4);
        assert!((res.alignment_intercept_ms - (-2_400.0)).abs() <= 200.0);

        let early_target: Vec<SubtitleCue> = make_dialogue_cues(80, 5_000, 1.0)
            .into_iter()
            .map(|c| {
                let mut shifted = c;
                shifted.start_ms -= 1_800;
                shifted.end_ms -= 1_800;
                shifted
            })
            .collect();
        let ref_shifted = make_dialogue_cues(80, 5_000, 1.0);
        let res2 = retime_with_discovery(
            &ref_shifted,
            &early_target,
            false,
            None,
            None,
            None,
            None,
            true,
            &cancel,
        )
        .expect("early result");
        assert!(res2.confident, "expected confident, got {:?}", res2.reject_reason);
        assert!((res2.alignment_intercept_ms - 1_800.0).abs() <= 200.0);
    }

    #[test]
    fn aligns_pal_ntsc_fps_drift() {
        let cancel = AtomicBool::new(false);
        let reference = make_dialogue_cues(100, 0, 1.0);
        let pal_target = make_dialogue_cues(100, 1_500, 23.976 / 25.0);
        let res = retime_with_discovery(
            &reference,
            &pal_target,
            false,
            None,
            None,
            None,
            None,
            true,
            &cancel,
        )
        .expect("fps result");
        assert!(res.confident, "expected confident, got {:?}", res.reject_reason);
        assert!((res.alignment_scale - (25.0 / 23.976)).abs() < 0.002);
    }

    #[test]
    fn aligns_split_one_to_two_cues_with_estimated_mkv_ends() {
        let cancel = AtomicBool::new(false);
        let mut reference = make_dialogue_cues(70, 0, 1.0);
        for r in &mut reference {
            r.estimated_end = true;
            r.end_ms = r.start_ms + 2_000;
        }
        let mut target = Vec::new();
        for (i, r) in reference.iter().enumerate() {
            if i % 7 == 2 {
                // Split one reference cue into two consecutive target cues, delayed by 1.2s
                target.push(SubtitleCue::new(
                    r.start_ms + 1_200,
                    r.start_ms + 1_200 + 800,
                    format!("SplitA {i}"),
                ));
                target.push(SubtitleCue::new(
                    r.start_ms + 1_200 + 820,
                    r.start_ms + 1_200 + 1_800,
                    format!("SplitB {i}"),
                ));
            } else {
                target.push(SubtitleCue::new(
                    r.start_ms + 1_200,
                    r.start_ms + 1_200 + 1_500,
                    format!("Normal {i}"),
                ));
            }
        }
        let res = retime_with_discovery(
            &reference,
            &target,
            false,
            None,
            None,
            None,
            None,
            true,
            &cancel,
        )
        .expect("1:2 result");
        assert!(res.confident, "expected confident, got {:?}", res.reject_reason);
        assert!(res.one_to_two_groups > 0);
    }

    #[test]
    fn rejects_unrelated_movie_as_no_fit() {
        let cancel = AtomicBool::new(false);
        let reference = make_dialogue_cues(80, 0, 1.0);
        let unrelated: Vec<SubtitleCue> = (0..80)
            .map(|i| {
                let s = (i as i64) * 5_432 + ((i as i64 * 19) % 11) * 410 + 700;
                SubtitleCue::new(s, s + 1_400, format!("Unrelated {i}"))
            })
            .collect();
        let res = retime_with_discovery(
            &reference,
            &unrelated,
            false,
            None,
            None,
            None,
            None,
            true,
            &cancel,
        );
        if let Some(r) = res {
            assert!(!r.confident, "unrelated cues must not be confident");
            assert!(r.is_no_fit());
        }
    }

    #[test]
    fn detects_outlier_mistimed_reference_among_three_sources() {
        let cancel = AtomicBool::new(false);
        let ref_a = make_dialogue_cues(70, 0, 1.0);
        let ref_b = make_dialogue_cues(70, 300, 1.0); // within 1000ms of A
        let ref_bad = make_dialogue_cues(70, 8_500, 1.0); // outlier > 1000ms

        let act_a = prepare_unit_activity(&ref_a).unwrap();
        let act_b = prepare_unit_activity(&ref_b).unwrap();
        let act_bad = prepare_unit_activity(&ref_bad).unwrap();

        let refs = vec![
            ("a".to_string(), &act_a, ref_a.len()),
            ("b".to_string(), &act_b, ref_b.len()),
            ("bad".to_string(), &act_bad, ref_bad.len()),
        ];
        let outliers = find_outlier_references(&refs, &cancel);
        assert!(outliers.contains("bad"));
        assert!(!outliers.contains("a"));
        assert!(!outliers.contains("b"));
    }

    #[test]
    fn stops_early_when_cancelled() {
        let cancel = AtomicBool::new(true);
        let reference = make_dialogue_cues(40, 0, 1.0);
        let target = make_dialogue_cues(40, 2_000, 1.0);
        assert!(retime_with_discovery(
            &reference,
            &target,
            false,
            None,
            None,
            None,
            None,
            true,
            &cancel,
        )
        .is_none());
    }

    #[test]
    fn skips_stray_eight_hour_cue_and_detects_first_position_outlier_symmetrically() {
        let cancel = AtomicBool::new(false);
        let mut reference = make_dialogue_cues(65, 0, 1.0);
        let target = make_dialogue_cues(65, 1_500, 1.0);
        reference.push(SubtitleCue::new(
            9 * 3_600_000,
            9 * 3_600_000 + 2_000,
            "Corrupt outro watermark".into(),
        ));
        let res = retime_with_discovery(
            &reference, &target, false, None, None, None, None, true, &cancel,
        )
        .expect("result with >8h outlier skipped");
        assert!(res.confident, "stray >8h cue must not abort valid track");

        let ref_a = make_dialogue_cues(70, 0, 1.0);
        let ref_b = make_dialogue_cues(70, 300, 1.0);
        let ref_bad = make_dialogue_cues(70, 8_500, 1.0);
        let act_a = prepare_unit_activity(&ref_a).unwrap();
        let act_b = prepare_unit_activity(&ref_b).unwrap();
        let act_bad = prepare_unit_activity(&ref_bad).unwrap();
        let refs = vec![
            ("bad".to_string(), &act_bad, ref_bad.len()),
            ("a".to_string(), &act_a, ref_a.len()),
            ("b".to_string(), &act_b, ref_b.len()),
        ];
        let outliers = find_outlier_references(&refs, &cancel);
        assert!(outliers.contains("bad"));
        assert!(!outliers.contains("a"));
        assert!(!outliers.contains("b"));
    }

    #[test]
    fn retime_with_seed_rejects_unsorted_cues_and_sampled_respects_cancel() {
        let cancel = AtomicBool::new(false);
        let reference = make_dialogue_cues(20, 0, 1.0);
        let mut unsorted_target = make_dialogue_cues(20, 0, 1.0);
        unsorted_target.swap(2, 15);
        assert!(retime_with_seed(&reference, &unsorted_target, 1.0, 0.0, &cancel).is_none());

        let cancelled = AtomicBool::new(true);
        let target = make_dialogue_cues(20, 0, 1.0);
        assert!(find_sampled_delay_alignment(&reference, &target, &cancelled).is_none());
    }
}

