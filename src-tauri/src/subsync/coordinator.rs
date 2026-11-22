//! AutoSync V2 coordinator & Tauri commands for embedded-subtitle synchronization.
//!
//! Ported from NuvioMobile's `AutomaticSubtitleSync.kt`, adapted cleanly for Harbor's
//! Tauri IPC, local/torrent/HTTP sources, credential vault, and temp file management.

use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use crate::subsync::aligner::{
    build_delay_only_timeline, evaluate_delay_preflight, find_outlier_references,
    find_sampled_delay_alignment, prefer_tighter_fit_on_disagreement, prepare_unit_activity,
    retime_with_discovery, DelayOnlyAlignment, DelayOnlySearchEvidence, PreparedActivity,
    TimelineRetimeResult,
};
use crate::subsync::container_index::{
    load_embedded_timeline, ContainerLoadOutcome, ReferenceTrack,
};
use crate::subsync::cue_parser::{
    decode_subtitle_bytes, parse_subtitles, SubtitleCue, SubtitleFormat,
};
use crate::subsync::text_retimer::{
    format_srt_from_cues, format_srt_from_retimed_cues, retime_subtitle_text,
};
use crate::subsync::url_guard;

const MAX_PARALLEL_CANDIDATE_DOWNLOADS: usize = 6;
const SUBTITLE_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15);
const HTTP_429_RETRY_DELAY: Duration = Duration::from_millis(900);
const MAX_SUBTITLE_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ARCHIVE_DOWNLOAD_BYTES: usize = 12 * 1024 * 1024;
const MAX_ARCHIVE_INFLATED_BYTES: usize = 32 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100;
const MIN_SELECTED_CUES: usize = 4;

const MIN_FULL_DIALOGUE_CUES: usize = 8;
const MIN_FULL_DIALOGUE_SPAN_MS: i64 = 30_000;
const MIN_FULL_DIALOGUE_DENSITY_PER_MINUTE: f64 = 2.0;
const MIN_INDEXED_REFERENCE_SPAN_MS: i64 = 45_000;

const CHEAP_REFERENCE_SAMPLE_CUES: usize = 24;
const CHEAP_TARGET_SAMPLE_CUES: usize = 32;
const CHEAP_REFERENCE_OFFSET_CANDIDATES: usize = 4;
const CHEAP_REFERENCE_MATCH_TOLERANCE_MS: i64 = 1_800;

const REFERENCE_SEARCH_CHECKPOINT: usize = 2;
const EXCEPTIONAL_MATCH_QUALITY: f64 = 0.95;
const EXCEPTIONAL_MATCH_TARGET_COVERAGE: f64 = 0.99;
const EXCEPTIONAL_MATCH_REFERENCE_COVERAGE: f64 = 0.97;
const EXCEPTIONAL_MATCH_SIMPLE_RATIO: f64 = 0.98;
const STRONG_CHECKPOINT_QUALITY: f64 = 0.92;
const STRONG_CHECKPOINT_TARGET_COVERAGE: f64 = 0.98;
const STRONG_CHECKPOINT_REFERENCE_COVERAGE: f64 = 0.90;
const PASSIVE_CHECKPOINT_QUALITY: f64 = 0.88;
const PASSIVE_CHECKPOINT_TARGET_COVERAGE: f64 = 0.96;
const PASSIVE_CHECKPOINT_REFERENCE_COVERAGE: f64 = 0.85;
const ASYMMETRIC_CHECKPOINT_QUALITY: f64 = 0.94;
const ASYMMETRIC_CHECKPOINT_TARGET_COVERAGE: f64 = 0.995;
const ASYMMETRIC_CHECKPOINT_REFERENCE_COVERAGE: f64 = 0.84;
const ASYMMETRIC_CHECKPOINT_SIMPLE_RATIO: f64 = 0.97;
const ASYMMETRIC_CHECKPOINT_MAX_GROUP_COST: f64 = 0.20;
const ASYMMETRIC_CHECKPOINT_MIN_REFERENCE_RATIO: f64 = 1.15;
const ASYMMETRIC_CHECKPOINT_MAX_TARGET_SKIP_RUN: usize = 2;
const NO_FIT_STOP_AFTER_SOURCES: usize = 3;

fn active_runs() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

struct RunGuard {
    run_id: String,
    cancel: Arc<AtomicBool>,
}

impl RunGuard {
    fn register(run_id: String) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = active_runs().lock() {
            map.insert(run_id.clone(), cancel.clone());
        }
        Self { run_id, cancel }
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = active_runs().lock() {
            if let Some(existing) = map.get(&self.run_id) {
                if Arc::ptr_eq(existing, &self.cancel) {
                    map.remove(&self.run_id);
                }
            }
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AutoSyncMode {
    Quick,
    Thorough,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutoSyncCandidateScope {
    StartupSearch,
    SelectedThenSearch,
    SelectedOnly,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadAuthInput {
    #[allow(dead_code)]
    pub kind: String,
    pub credential_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleCandidateInput {
    pub url: String,
    pub local_path: Option<String>,
    pub inline_text: Option<String>,
    pub format: Option<String>,
    pub lang: Option<String>,
    #[allow(dead_code)]
    pub title: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub local_trusted: Option<bool>,
    pub download_auth: Option<DownloadAuthInput>,
    pub sub_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignSubtitlesRequest {
    pub run_id: String,
    pub media_url: String,
    pub media_headers: Option<HashMap<String, String>>,
    pub mode: AutoSyncMode,
    pub tolerance_ms: i64,
    pub scope: AutoSyncCandidateScope,
    pub selected_track: SubtitleCandidateInput,
    pub candidates: Vec<SubtitleCandidateInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PrefetchStatus {
    Ready,
    NoSubtitleTracks,
    NoUsableReference,
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrefetchEmbeddedResponse {
    pub status: PrefetchStatus,
    pub track_count: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AlignOutcome {
    Synced,
    WithinTolerance,
    NoFit,
    NoSubtitleTracks,
    NoUsableReference,
    Inconclusive,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlignSubtitlesResponse {
    pub outcome: AlignOutcome,
    pub chosen_url: Option<String>,
    pub chosen_sub_id: Option<String>,
    pub retimed_path: Option<String>,
    pub retimed_text: Option<String>,
    pub format: Option<SubtitleFormat>,
    pub selected_original_path: Option<String>,
    pub selected_original_text: Option<String>,
    pub selected_original_format: Option<SubtitleFormat>,
    pub median_offset_ms: i64,
    pub max_shift_ms: i64,
    pub scale: f64,
    pub within_tolerance: bool,
    pub matched_cue_count: usize,
    pub total_cue_count: usize,
    pub reference_track_label: Option<String>,
}

impl AlignSubtitlesResponse {
    fn empty(outcome: AlignOutcome) -> Self {
        Self {
            outcome,
            chosen_url: None,
            chosen_sub_id: None,
            retimed_path: None,
            retimed_text: None,
            format: None,
            selected_original_path: None,
            selected_original_text: None,
            selected_original_format: None,
            median_offset_ms: 0,
            max_shift_ms: 0,
            scale: 1.0,
            within_tolerance: false,
            matched_cue_count: 0,
            total_cue_count: 0,
            reference_track_label: None,
        }
    }
}

#[tauri::command]
pub async fn subsync_prefetch_embedded(
    media_url: String,
    media_headers: Option<HashMap<String, String>>,
) -> Result<PrefetchEmbeddedResponse, String> {
    let hdrs = media_headers.unwrap_or_default();
    match load_embedded_timeline(&media_url, &hdrs).await {
        ContainerLoadOutcome::Ready(tl) => Ok(PrefetchEmbeddedResponse {
            status: PrefetchStatus::Ready,
            track_count: tl.tracks.len(),
        }),
        ContainerLoadOutcome::NoSubtitleTracks => Ok(PrefetchEmbeddedResponse {
            status: PrefetchStatus::NoSubtitleTracks,
            track_count: 0,
        }),
        ContainerLoadOutcome::NoUsableReference => Ok(PrefetchEmbeddedResponse {
            status: PrefetchStatus::NoUsableReference,
            track_count: 0,
        }),
        ContainerLoadOutcome::Unavailable => Ok(PrefetchEmbeddedResponse {
            status: PrefetchStatus::Unavailable,
            track_count: 0,
        }),
    }
}

#[tauri::command]
pub fn subsync_cancel(run_id: String) -> Result<(), String> {
    if let Ok(map) = active_runs().lock() {
        if let Some(flag) = map.get(&run_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn subsync_align_subtitles(
    request: AlignSubtitlesRequest,
) -> Result<AlignSubtitlesResponse, String> {
    let guard = RunGuard::register(request.run_id.clone());
    let cancel = guard.cancel.clone();
    let media_headers = request.media_headers.clone().unwrap_or_default();

    let loaded_selected_fut = load_candidate_subtitle(&request.selected_track, cancel.clone());
    let container_fut = load_embedded_timeline(&request.media_url, &media_headers);

    let (container_outcome, loaded_selected) = tokio::join!(container_fut, loaded_selected_fut);
    if cancel.load(Ordering::Relaxed) {
        return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Cancelled));
    }

    let timeline = match container_outcome {
        ContainerLoadOutcome::Ready(tl) => tl,
        ContainerLoadOutcome::NoSubtitleTracks => {
            return Ok(AlignSubtitlesResponse::empty(AlignOutcome::NoSubtitleTracks));
        }
        ContainerLoadOutcome::NoUsableReference => {
            return Ok(AlignSubtitlesResponse::empty(AlignOutcome::NoUsableReference));
        }
        ContainerLoadOutcome::Unavailable => {
            return Ok(AlignSubtitlesResponse::empty(AlignOutcome::NoUsableReference));
        }
    };

    let cancel_prep = cancel.clone();
    let (primary_refs, forced_refs, ref_activity_cache) = tokio::task::spawn_blocking(move || {
        let (mut primary_refs, mut forced_refs) =
            select_and_filter_references(&timeline.tracks, &cancel_prep);
        if cancel_prep.load(Ordering::Relaxed) {
            return (Vec::new(), Vec::new(), HashMap::new());
        }
        if primary_refs.is_empty() && !forced_refs.is_empty() {
            primary_refs = std::mem::take(&mut forced_refs);
        }
        let mut ref_activity_cache: HashMap<String, Option<PreparedActivity>> = HashMap::new();
        for track in primary_refs.iter().chain(forced_refs.iter()) {
            if !ref_activity_cache.contains_key(&track.key) {
                let act = if track.sampled {
                    None
                } else {
                    prepare_unit_activity(&track.cues)
                };
                ref_activity_cache.insert(track.key.clone(), act);
            }
        }
        (primary_refs, forced_refs, ref_activity_cache)
    })
    .await
    .map_err(|e| format!("autosync reference prep failed: {e}"))?;

    if cancel.load(Ordering::Relaxed) {
        return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Cancelled));
    }
    if primary_refs.is_empty() && forced_refs.is_empty() {
        return Ok(AlignSubtitlesResponse::empty(AlignOutcome::NoUsableReference));
    }

    let primary_refs = Arc::new(primary_refs);
    let forced_refs = Arc::new(forced_refs);
    let ref_activity_cache = Arc::new(ref_activity_cache);
    let aggressive = request.mode == AutoSyncMode::Thorough;

    let selected_only_list = match loaded_selected {
        Some(sel) => vec![(0usize, request.selected_track.clone(), sel)],
        None => Vec::new(),
    };

    match request.scope {
        AutoSyncCandidateScope::SelectedOnly => {
            if selected_only_list.is_empty() {
                return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Inconclusive));
            }
            let eval = evaluate_pool_blocking(
                selected_only_list,
                Some(request.selected_track.url.clone()),
                primary_refs,
                forced_refs,
                ref_activity_cache,
                aggressive,
                cancel,
            )
            .await?;
            finalize_pool_response(&request, eval, &request.selected_track.url).await
        }
        AutoSyncCandidateScope::SelectedThenSearch => {
            let mut selected_confirmed_no_fit = false;
            if !selected_only_list.is_empty() {
                let first_eval = evaluate_pool_blocking(
                    selected_only_list,
                    Some(request.selected_track.url.clone()),
                    Arc::clone(&primary_refs),
                    Arc::clone(&forced_refs),
                    Arc::clone(&ref_activity_cache),
                    aggressive,
                    Arc::clone(&cancel),
                )
                .await?;
                if cancel.load(Ordering::Relaxed) {
                    return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Cancelled));
                }
                if first_eval.winner.is_some() {
                    return finalize_pool_response(
                        &request,
                        first_eval,
                        &request.selected_track.url,
                    )
                    .await;
                }
                selected_confirmed_no_fit = first_eval.confirmed_no_fit;
                if request.candidates.is_empty() {
                    let outcome = if selected_confirmed_no_fit {
                        AlignOutcome::NoFit
                    } else {
                        AlignOutcome::Inconclusive
                    };
                    return Ok(AlignSubtitlesResponse::empty(outcome));
                }
            }
            // Selected track did not align cleanly (or failed to load) -> search same-language alternatives.
            let loaded_alts = load_candidates_parallel(&request.candidates, 0, &cancel).await;
            if cancel.load(Ordering::Relaxed) {
                return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Cancelled));
            }
            if loaded_alts.is_empty() {
                let outcome = if selected_confirmed_no_fit {
                    AlignOutcome::NoFit
                } else {
                    AlignOutcome::Inconclusive
                };
                return Ok(AlignSubtitlesResponse::empty(outcome));
            }
            let alt_eval = evaluate_pool_blocking(
                loaded_alts,
                None,
                primary_refs,
                forced_refs,
                ref_activity_cache,
                aggressive,
                cancel,
            )
            .await?;
            finalize_pool_response(&request, alt_eval, &request.selected_track.url).await
        }
        AutoSyncCandidateScope::StartupSearch => {
            let mut pool: Vec<(usize, SubtitleCandidateInput, LoadedSubtitle)> = selected_only_list;
            if !pool.is_empty() && !request.candidates.is_empty() {
                let selected_eval = evaluate_pool_blocking(
                    pool.clone(),
                    Some(request.selected_track.url.clone()),
                    Arc::clone(&primary_refs),
                    Arc::clone(&forced_refs),
                    Arc::clone(&ref_activity_cache),
                    aggressive,
                    Arc::clone(&cancel),
                )
                .await?;
                if cancel.load(Ordering::Relaxed) {
                    return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Cancelled));
                }
                if let Some(ref w) = selected_eval.winner {
                    let fast_accept = is_exceptional_match(&w.reference, &w.timeline)
                        || (!aggressive
                            && (is_strong_checkpoint(&w.reference, &w.timeline, false)
                                || is_asymmetric_checkpoint(
                                    &w.reference,
                                    &w.timeline,
                                    w.loaded.cues.len(),
                                )));
                    if fast_accept {
                        return finalize_pool_response(
                            &request,
                            selected_eval,
                            &request.selected_track.url,
                        )
                        .await;
                    }
                }
            }

            let loaded_alts = load_candidates_parallel(&request.candidates, 1, &cancel).await;
            if cancel.load(Ordering::Relaxed) {
                return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Cancelled));
            }
            let mut seen_urls = HashSet::new();
            for item in &pool {
                seen_urls.insert(item.1.url.clone());
            }
            for item in loaded_alts {
                if seen_urls.insert(item.1.url.clone()) {
                    pool.push(item);
                }
            }
            if pool.is_empty() {
                return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Inconclusive));
            }
            let eval = evaluate_pool_blocking(
                pool,
                Some(request.selected_track.url.clone()),
                primary_refs,
                forced_refs,
                ref_activity_cache,
                aggressive,
                cancel,
            )
            .await?;
            finalize_pool_response(&request, eval, &request.selected_track.url).await
        }
    }
}

#[derive(Clone)]
struct LoadedSubtitle {
    format: SubtitleFormat,
    cues: Vec<SubtitleCue>,
    raw_body: String,
}

struct PoolWinner {
    candidate: SubtitleCandidateInput,
    loaded: LoadedSubtitle,
    reference: ReferenceTrack,
    timeline: TimelineRetimeResult,
}

struct PoolEvalResult {
    winner: Option<PoolWinner>,
    confirmed_no_fit: bool,
}

struct FamilyState {
    members: Vec<(usize, SubtitleCandidateInput, LoadedSubtitle)>,
    ranked_refs: Vec<(ReferenceTrack, f64, f64)>,
    evidence_map: HashMap<String, (DelayOnlySearchEvidence, Option<DelayOnlyAlignment>)>,
    preflight_champ_key: Option<String>,
    evaluated_pairs: usize,
    no_fit_pairs: usize,
    completed_usable: usize,
    abandoned: bool,
    no_fit_sources: Vec<PreparedActivity>,
    best: Option<(ReferenceTrack, TimelineRetimeResult, f64)>,
}

async fn evaluate_pool_blocking(
    items: Vec<(usize, SubtitleCandidateInput, LoadedSubtitle)>,
    selected_url: Option<String>,
    primary_refs: Arc<Vec<ReferenceTrack>>,
    forced_refs: Arc<Vec<ReferenceTrack>>,
    ref_activity_cache: Arc<HashMap<String, Option<PreparedActivity>>>,
    aggressive: bool,
    cancel: Arc<AtomicBool>,
) -> Result<PoolEvalResult, String> {
    tokio::task::spawn_blocking(move || {
        evaluate_pool(
            &items,
            selected_url.as_deref(),
            &primary_refs,
            &forced_refs,
            &ref_activity_cache,
            aggressive,
            &cancel,
        )
    })
    .await
    .map_err(|e| format!("autosync pool evaluation failed: {e}"))
}

fn evaluate_pool(
    items: &[(usize, SubtitleCandidateInput, LoadedSubtitle)],
    selected_url: Option<&str>,
    primary_refs: &[ReferenceTrack],
    forced_refs: &[ReferenceTrack],
    ref_activity_cache: &HashMap<String, Option<PreparedActivity>>,
    aggressive: bool,
    cancel: &AtomicBool,
) -> PoolEvalResult {
    // 1. Group candidates into timing families by constant cue shift equivalence.
    let mut families: Vec<FamilyState> = Vec::new();
    for (idx, cand, loaded) in items {
        if cancel.load(Ordering::Relaxed) {
            return PoolEvalResult {
                winner: None,
                confirmed_no_fit: false,
            };
        }
        let existing_idx = families.iter().position(|fam| {
            constant_timeline_shift_ms(&fam.members[0].2.cues, &loaded.cues).is_some()
        });
        if let Some(fi) = existing_idx {
            families[fi].members.push((*idx, cand.clone(), loaded.clone()));
            continue;
        }

        let target_act = prepare_unit_activity(&loaded.cues);
        let preflight = target_act.as_ref().map(|tgt_act| {
            let ref_inputs: Vec<(String, &PreparedActivity, usize, bool)> = primary_refs
                .iter()
                .filter_map(|r| {
                    let act = ref_activity_cache.get(&r.key)?.as_ref()?;
                    Some((r.key.clone(), act, r.cues.len(), r.is_sdh))
                })
                .collect();
            evaluate_delay_preflight(&ref_inputs, loaded.cues.len(), tgt_act, cancel)
        });
        let pref_key = preflight
            .as_ref()
            .and_then(|p| p.best_reference_key.clone());
        let evidence_map = preflight
            .map(|p| p.evidence_by_reference_key)
            .unwrap_or_default();
        let ranked = rank_reference_candidates(&loaded.cues, primary_refs, pref_key.as_deref());

        families.push(FamilyState {
            members: vec![(*idx, cand.clone(), loaded.clone())],
            ranked_refs: ranked,
            evidence_map,
            preflight_champ_key: pref_key,
            evaluated_pairs: 0,
            no_fit_pairs: 0,
            completed_usable: 0,
            abandoned: false,
            no_fit_sources: Vec::new(),
            best: None,
        });
    }

    // 2. Evaluate pairs per family using Nuvio checkpoints.
    let mut overall_best: Option<(usize, ReferenceTrack, TimelineRetimeResult)> = None;

    for f_idx in 0..families.len() {
        if cancel.load(Ordering::Relaxed) {
            return PoolEvalResult {
                winner: None,
                confirmed_no_fit: false,
            };
        }
        let target_cues = families[f_idx].members[0].2.cues.clone();
        let target_act = prepare_unit_activity(&target_cues);
        let total_ranked = families[f_idx].ranked_refs.len();

        for r_idx in 0..total_ranked {
            if families[f_idx].abandoned || cancel.load(Ordering::Relaxed) {
                break;
            }
            let (ref_track, cheap_aff, _suit) = families[f_idx].ranked_refs[r_idx].clone();
            let ev_opt = families[f_idx].evidence_map.get(&ref_track.key);
            let hint = ev_opt.and_then(|(_, a)| a.as_ref());
            let hint_score = hint.map(|h| h.score);
            let ev = ev_opt.map(|(e, _)| e);
            let is_champ = families[f_idx].preflight_champ_key.as_deref() == Some(&ref_track.key);
            let ref_act = ref_activity_cache.get(&ref_track.key).and_then(|o| o.as_ref());

            let res = if ref_track.sampled {
                find_sampled_delay_alignment(&ref_track.cues, &target_cues)
                    .map(|al| build_delay_only_timeline(&target_cues, &al))
            } else {
                retime_with_discovery(
                    &ref_track.cues,
                    &target_cues,
                    ref_track.is_sdh,
                    ref_act,
                    target_act.as_ref(),
                    hint,
                    ev,
                    is_champ,
                    cancel,
                )
            };

            let fam = &mut families[f_idx];
            fam.evaluated_pairs += 1;
            let is_no_fit = res.as_ref().is_none_or(|r| r.is_no_fit());
            if !ref_track.sampled && res.is_some() && is_no_fit {
                fam.no_fit_pairs += 1;
            }

            if let Some(ref tl) = res {
                fam.completed_usable += 1;
                let better_in_fam = match &fam.best {
                    None => true,
                    Some((cur_t, cur_tl, _)) => {
                        is_better_match(&ref_track, tl, cur_t, cur_tl, true)
                    }
                };
                if better_in_fam {
                    let sched = cheap_aff.max(hint_score.unwrap_or(f64::NEG_INFINITY));
                    fam.best = Some((ref_track.clone(), tl.clone(), sched));
                }
            }

            if !fam.abandoned
                && fam.best.as_ref().is_none_or(|(_, b, _)| !b.confident)
                && is_no_fit
            {
                if let Some(r_act) = ref_act {
                    if fam
                        .no_fit_sources
                        .iter()
                        .all(|prev| !crate::subsync::aligner::is_same_source_activity(prev, r_act))
                    {
                        fam.no_fit_sources.push(r_act.clone());
                        if fam.no_fit_sources.len() >= NO_FIT_STOP_AFTER_SOURCES {
                            fam.abandoned = true;
                        }
                    }
                }
            }

            // Update overall best and check early-stop checkpoints against the winning reference.
            if let Some((ref f_trk, ref f_tl, _)) = fam.best {
                if f_tl.confident {
                    let better_overall = match &overall_best {
                        None => true,
                        Some((best_fi, cur_trk, cur_tl)) => is_better_match(
                            f_trk,
                            f_tl,
                            cur_trk,
                            cur_tl,
                            *best_fi == f_idx,
                        ),
                    };
                    if better_overall {
                        overall_best = Some((f_idx, f_trk.clone(), f_tl.clone()));
                    }
                }
            }

            if let Some((ref best_trk, ref best_tl, _)) = fam.best {
                if is_exceptional_match(best_trk, best_tl) {
                    break;
                }
                let req_attempts = REFERENCE_SEARCH_CHECKPOINT.min(total_ranked);
                if fam.completed_usable >= req_attempts
                    && (is_strong_checkpoint(best_trk, best_tl, aggressive)
                        || is_asymmetric_checkpoint(best_trk, best_tl, target_cues.len()))
                {
                    break;
                }
            }
        }

        // Quick-mode global early exit or top-priority family exceptional match.
        if let Some((best_fi, ref best_trk, ref best_tl)) = overall_best {
            if best_fi == f_idx {
                let fam = &families[f_idx];
                let req_attempts = REFERENCE_SEARCH_CHECKPOINT.min(total_ranked);
                let quick_strong = !aggressive
                    && fam.completed_usable >= req_attempts
                    && (is_strong_checkpoint(best_trk, best_tl, false)
                        || is_asymmetric_checkpoint(best_trk, best_tl, target_cues.len()));
                if is_exceptional_match(best_trk, best_tl) || quick_strong {
                    break;
                }
            }
        }
    }

    // 3. Forced-reference fallback only if no confident match was found yet.
    if overall_best.is_none() && !forced_refs.is_empty() && !cancel.load(Ordering::Relaxed) {
        for (f_idx, fam) in families.iter().enumerate() {
            let target_cues = &fam.members[0].2.cues;
            let target_act = prepare_unit_activity(target_cues);
            let ranked = rank_reference_candidates(target_cues, forced_refs, None);
            for (ref_track, _, _) in ranked {
                if cancel.load(Ordering::Relaxed) {
                    return PoolEvalResult {
                        winner: None,
                        confirmed_no_fit: false,
                    };
                }
                let ref_act = ref_activity_cache.get(&ref_track.key).and_then(|o| o.as_ref());
                if let Some(tl) = retime_with_discovery(
                    &ref_track.cues,
                    target_cues,
                    ref_track.is_sdh,
                    ref_act,
                    target_act.as_ref(),
                    None,
                    None,
                    true,
                    cancel,
                ) {
                    if tl.confident {
                        let better = match &overall_best {
                            None => true,
                            Some((best_fi, cur_trk, cur_tl)) => is_better_match(
                                &ref_track,
                                &tl,
                                cur_trk,
                                cur_tl,
                                *best_fi == f_idx,
                            ),
                        };
                        if better {
                            overall_best = Some((f_idx, ref_track, tl));
                        }
                    }
                }
            }
        }
    }

    if let Some((win_fi, win_ref, win_tl)) = overall_best {
        let fam = &families[win_fi];
        let win_member = fam
            .members
            .iter()
            .min_by_key(|(idx, _, _)| *idx)
            .expect("family has member");
        let rep_cues = &fam.members[0].2.cues;
        let final_tl = if win_member.0 == fam.members[0].0 {
            win_tl
        } else {
            reuse_shift_equivalent_match(&win_tl, rep_cues, &win_member.2.cues).unwrap_or(win_tl)
        };
        return PoolEvalResult {
            winner: Some(PoolWinner {
                candidate: win_member.1.clone(),
                loaded: win_member.2.clone(),
                reference: win_ref,
                timeline: final_tl,
            }),
            confirmed_no_fit: false,
        };
    }

    let confirmed_no_fit = if let Some(sel_url) = selected_url {
        families
            .iter()
            .find(|fam| fam.members.iter().any(|(_, c, _)| c.url == sel_url))
            .is_some_and(|fam| {
                fam.evaluated_pairs > 0
                    && fam.no_fit_pairs == fam.evaluated_pairs
                    && (fam.abandoned || fam.evaluated_pairs >= fam.ranked_refs.len())
            })
    } else {
        !families.is_empty()
            && families.iter().all(|fam| {
                fam.evaluated_pairs > 0
                    && fam.no_fit_pairs == fam.evaluated_pairs
                    && (fam.abandoned || fam.evaluated_pairs >= fam.ranked_refs.len())
            })
    };

    PoolEvalResult {
        winner: None,
        confirmed_no_fit,
    }
}

async fn finalize_pool_response(
    request: &AlignSubtitlesRequest,
    eval: PoolEvalResult,
    selected_url: &str,
) -> Result<AlignSubtitlesResponse, String> {
    let Some(winner) = eval.winner else {
        let outcome = if eval.confirmed_no_fit {
            AlignOutcome::NoFit
        } else {
            AlignOutcome::Inconclusive
        };
        return Ok(AlignSubtitlesResponse::empty(outcome));
    };

    let tl = &winner.timeline;
    let max_shift_ms = tl.max_alignment_shift_ms().round() as i64;
    let median_offset_ms = compute_median_shift_ms(tl);
    // Tolerance 0 means "Off" — always apply the per-cue retiming result rather than skipping.
    let within_tolerance = request.tolerance_ms > 0 && max_shift_ms <= request.tolerance_ms;
    let total_cue_count = tl.cues.len();
    let matched_cue_count = total_cue_count.saturating_sub(tl.skipped_target_cues);
    let chosen_is_selected = winner.candidate.url == selected_url;

    if within_tolerance && chosen_is_selected {
        return Ok(AlignSubtitlesResponse {
            outcome: AlignOutcome::WithinTolerance,
            chosen_url: Some(winner.candidate.url),
            chosen_sub_id: winner.candidate.sub_id,
            retimed_path: None,
            retimed_text: None,
            format: Some(winner.loaded.format),
            selected_original_path: None,
            selected_original_text: None,
            selected_original_format: None,
            median_offset_ms,
            max_shift_ms,
            scale: tl.alignment_scale,
            within_tolerance: true,
            matched_cue_count,
            total_cue_count,
            reference_track_label: winner.reference.label,
        });
    }

    let (out_format, final_text) = match winner.loaded.format {
        SubtitleFormat::Ttml => {
            let Some(srt) = (if within_tolerance {
                format_srt_from_cues(&winner.loaded.cues)
            } else {
                format_srt_from_retimed_cues(&winner.loaded.cues, tl)
            }) else {
                return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Inconclusive));
            };
            (SubtitleFormat::Srt, srt)
        }
        other => {
            if within_tolerance {
                (other, winner.loaded.raw_body.clone())
            } else {
                let Some(retimed) = retime_subtitle_text(&winner.loaded.raw_body, tl) else {
                    return Ok(AlignSubtitlesResponse::empty(AlignOutcome::Inconclusive));
                };
                (other, retimed)
            }
        }
    };

    let retimed_path = write_autosync_temp_file(
        "autosync_",
        &request.media_url,
        selected_url,
        out_format.ext(),
        &final_text,
    )?;

    let (selected_original_path, selected_original_text, selected_original_format) =
        if chosen_is_selected {
            let orig_pair = match winner.loaded.format {
                SubtitleFormat::Ttml => {
                    format_srt_from_cues(&winner.loaded.cues).map(|s| (SubtitleFormat::Srt, s))
                }
                other => Some((other, winner.loaded.raw_body.clone())),
            };
            if let Some((orig_fmt, orig_text)) = orig_pair {
                let orig_path = write_autosync_temp_file(
                    "autosync_orig_",
                    &request.media_url,
                    selected_url,
                    orig_fmt.ext(),
                    &orig_text,
                )
                .ok();
                (orig_path, Some(orig_text), Some(orig_fmt))
            } else {
                (None, None, None)
            }
        } else {
            (None, None, None)
        };

    Ok(AlignSubtitlesResponse {
        outcome: AlignOutcome::Synced,
        chosen_url: Some(winner.candidate.url),
        chosen_sub_id: winner.candidate.sub_id,
        retimed_path: Some(retimed_path),
        retimed_text: Some(final_text),
        format: Some(out_format),
        selected_original_path,
        selected_original_text,
        selected_original_format,
        median_offset_ms,
        max_shift_ms,
        scale: tl.alignment_scale,
        within_tolerance,
        matched_cue_count,
        total_cue_count,
        reference_track_label: winner.reference.label,
    })
}

fn compute_median_shift_ms(tl: &TimelineRetimeResult) -> i64 {
    if (tl.alignment_scale - 1.0).abs() <= 1e-6 && tl.alignment_source.contains("delay-only") {
        return tl.alignment_intercept_ms.round() as i64;
    }
    let mut diffs: Vec<i64> = tl
        .cues
        .iter()
        .map(|c| c.start_ms - c.original_start_ms)
        .collect();
    if diffs.is_empty() {
        return tl.alignment_intercept_ms.round() as i64;
    }
    diffs.sort_unstable();
    diffs[diffs.len() / 2]
}

fn sha256_hex16(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut s = String::with_capacity(16);
    for b in &digest[..8] {
        use std::fmt::Write;
        let _ = write!(&mut s, "{b:02x}");
    }
    s
}

fn autosync_temp_dir() -> PathBuf {
    std::env::temp_dir().join("harbor-subs").join("prepared")
}

fn write_autosync_temp_file(
    file_prefix: &str,
    media_url: &str,
    track_key: &str,
    ext: &str,
    contents: &str,
) -> Result<String, String> {
    let dir = autosync_temp_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create temp dir: {e}"))?;
    let media_track_hash = sha256_hex16(&format!("{media_url}\0{track_key}"));
    let content_hash = sha256_hex16(contents);
    let prefix = format!("{file_prefix}{media_track_hash}_");
    let file_name = format!("{prefix}{content_hash}.{ext}");
    let target_path = dir.join(&file_name);

    // Clean stale autosync temp files for the same media + track key so repeated runs don't leak.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(&prefix) && name_str != file_name {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

    std::fs::write(&target_path, contents.as_bytes())
        .map_err(|e| format!("write retimed subtitle: {e}"))?;
    Ok(target_path.to_string_lossy().into_owned())
}

// ---------- Reference Selection, Ranking & Family Deduplication ----------

fn select_and_filter_references(
    tracks: &[ReferenceTrack],
    cancel: &AtomicBool,
) -> (Vec<ReferenceTrack>, Vec<ReferenceTrack>) {
    let mut primary = Vec::new();
    let mut forced = Vec::new();
    for track in tracks {
        let cues = track.cues.len();
        let span = reference_span_ms(&track.cues);
        let density = if span <= 0 {
            0.0
        } else {
            (cues as f64) * 60_000.0 / (span as f64)
        };
        let label_lower = track.label.as_deref().unwrap_or("").to_ascii_lowercase();
        let is_commentary = track.is_commentary || label_lower.contains("commentary");
        let is_descriptive = track.is_descriptive
            || label_lower.contains("audio description")
            || label_lower.contains("descriptive subtitle");
        let is_forced = track.is_forced
            || label_lower.contains("forced")
            || label_lower.contains("foreign only")
            || label_lower.contains("signs only")
            || label_lower.contains("songs only");

        let candidate = cues >= MIN_FULL_DIALOGUE_CUES
            && span >= MIN_FULL_DIALOGUE_SPAN_MS
            && span >= MIN_INDEXED_REFERENCE_SPAN_MS
            && !is_commentary
            && !is_descriptive
            && (track.sampled || density >= MIN_FULL_DIALOGUE_DENSITY_PER_MINUTE);
        if !candidate {
            continue;
        }
        if is_forced {
            forced.push(track.clone());
        } else {
            primary.push(track.clone());
        }
    }

    primary.sort_by(|a, b| {
        reference_rank_score(b)
            .total_cmp(&reference_rank_score(a))
            .then_with(|| a.is_sdh.cmp(&b.is_sdh))
            .then_with(|| a.key.cmp(&b.key))
    });
    forced.sort_by(|a, b| {
        reference_rank_score(b)
            .total_cmp(&reference_rank_score(a))
            .then_with(|| a.key.cmp(&b.key))
    });

    if primary.len() >= 3 {
        let acts: Vec<(String, Option<PreparedActivity>, usize)> = primary
            .iter()
            .map(|t| (t.key.clone(), prepare_unit_activity(&t.cues), t.cues.len()))
            .collect();
        let inputs: Vec<(String, &PreparedActivity, usize)> = acts
            .iter()
            .filter_map(|(k, a_opt, sz)| a_opt.as_ref().map(|a| (k.clone(), a, *sz)))
            .collect();
        let outliers = find_outlier_references(&inputs, cancel);
        if !outliers.is_empty() && outliers.len() < primary.len() {
            primary.retain(|t| !outliers.contains(&t.key));
        }
    }

    (primary, forced)
}

fn reference_rank_score(track: &ReferenceTrack) -> f64 {
    let span = reference_span_ms(&track.cues).max(1) as f64;
    let density = ((track.cues.len() as f64) * 60_000.0 / span).min(20.0);
    let sdh_penalty = if track.is_sdh { 5.0 } else { 0.0 };
    (track.cues.len() as f64) * 2.0 + density * 1.5 - sdh_penalty
}

fn reference_span_ms(cues: &[SubtitleCue]) -> i64 {
    if cues.len() < 2 {
        0
    } else {
        cues.last().unwrap().end_ms - cues.first().unwrap().start_ms
    }
}

fn rank_reference_candidates(
    target: &[SubtitleCue],
    reference_tracks: &[ReferenceTrack],
    preferred_key: Option<&str>,
) -> Vec<(ReferenceTrack, f64, f64)> {
    // Deduplicate tracks with identical timestamps.
    let mut deduped: Vec<ReferenceTrack> = Vec::new();
    for track in reference_tracks {
        let dup = deduped.iter().position(|existing| {
            existing.cues.len() == track.cues.len()
                && existing
                    .cues
                    .iter()
                    .zip(track.cues.iter())
                    .all(|(l, r)| l.start_ms == r.start_ms && l.end_ms == r.end_ms)
        });
        if let Some(pos) = dup {
            if deduped[pos].is_sdh && !track.is_sdh {
                deduped[pos] = track.clone();
            }
        } else {
            deduped.push(track.clone());
        }
    }

    let mut ranked: Vec<(ReferenceTrack, f64, f64)> = deduped
        .into_iter()
        .map(|t| {
            let aff = cheap_reference_affinity(&t.cues, target);
            let suit = reference_suitability_score(&t, target);
            (t, aff, suit)
        })
        .collect();

    ranked.sort_by(|a, b| {
        let pref_a = u8::from(preferred_key.is_some_and(|k| k == a.0.key));
        let pref_b = u8::from(preferred_key.is_some_and(|k| k == b.0.key));
        pref_b
            .cmp(&pref_a)
            .then_with(|| b.1.total_cmp(&a.1))
            .then_with(|| b.2.total_cmp(&a.2))
            .then_with(|| a.0.is_sdh.cmp(&b.0.is_sdh))
            .then_with(|| a.0.key.cmp(&b.0.key))
    });
    ranked
}

fn reference_suitability_score(track: &ReferenceTrack, target: &[SubtitleCue]) -> f64 {
    if track.cues.is_empty() || target.is_empty() {
        return 0.0;
    }
    let small = track.cues.len().min(target.len()) as f64;
    let large = track.cues.len().max(target.len()) as f64;
    let cue_ratio = small / large.max(1.0);
    let r_span = reference_span_ms(&track.cues).max(1) as f64;
    let t_span = reference_span_ms(target).max(1) as f64;
    let span_ratio = r_span.min(t_span) / r_span.max(t_span);
    let non_sdh_bonus = if track.is_sdh { 0.0 } else { 0.08 };
    cue_ratio * 0.60 + span_ratio * 0.32 + non_sdh_bonus
}

fn cheap_reference_affinity(reference: &[SubtitleCue], target: &[SubtitleCue]) -> f64 {
    if reference.len() < 4 || target.len() < 4 {
        return 0.0;
    }
    let ref_sample = evenly_sample_cues(reference, CHEAP_REFERENCE_SAMPLE_CUES);
    let tgt_sample = evenly_sample_cues(target, CHEAP_TARGET_SAMPLE_CUES);
    if ref_sample.is_empty() || tgt_sample.is_empty() {
        return 0.0;
    }
    let mut scales = vec![
        1.0,
        25.0 / 23.976,
        23.976 / 25.0,
        25.0 / 24.0,
        24.0 / 25.0,
        24.0 / 23.976,
        23.976 / 24.0,
    ];
    let r_span = reference.last().unwrap().start_ms - reference.first().unwrap().start_ms;
    let t_span = target.last().unwrap().start_ms - target.first().unwrap().start_ms;
    if r_span > 0 && t_span > 0 {
        let obs = (r_span as f64) / (t_span as f64);
        if obs.is_finite()
            && (0.94..=1.06).contains(&obs)
            && scales.iter().all(|&s| (s - obs).abs() >= 0.00035)
        {
            scales.push(obs);
        }
    }

    let mut best_score = 0.0f64;
    for scale in scales {
        let mut offsets = Vec::with_capacity(CHEAP_REFERENCE_OFFSET_CANDIDATES);
        for anchor in 0..CHEAP_REFERENCE_OFFSET_CANDIDATES {
            let r_i = (anchor * (ref_sample.len() - 1)) / (CHEAP_REFERENCE_OFFSET_CANDIDATES - 1);
            let t_i = (anchor * (tgt_sample.len() - 1)) / (CHEAP_REFERENCE_OFFSET_CANDIDATES - 1);
            let off = ref_sample[r_i].start_ms
                - ((tgt_sample[t_i].start_ms as f64) * scale).round() as i64;
            if !offsets.contains(&off) {
                offsets.push(off);
            }
        }
        for offset_ms in offsets {
            let mut hits = 0usize;
            let mut res_total = 0i64;
            for cue in &tgt_sample {
                let shifted = ((cue.start_ms as f64) * scale).round() as i64 + offset_ms;
                let ins = reference.partition_point(|c| c.start_ms < shifted);
                let mut nearest = i64::MAX;
                if ins < reference.len() {
                    nearest = (reference[ins].start_ms - shifted).abs();
                }
                if ins > 0 {
                    nearest = nearest.min((reference[ins - 1].start_ms - shifted).abs());
                }
                if nearest <= CHEAP_REFERENCE_MATCH_TOLERANCE_MS {
                    hits += 1;
                    res_total += nearest;
                }
            }
            if hits == 0 {
                continue;
            }
            let part = (hits as f64) / (tgt_sample.len() as f64);
            let mean_res = (res_total as f64) / (hits as f64);
            let res_score = (-mean_res / 900.0).exp();
            let score = part * 0.80 + res_score * 0.20;
            if score > best_score {
                best_score = score;
            }
        }
    }
    best_score.clamp(0.0, 1.0)
}

fn evenly_sample_cues(cues: &[SubtitleCue], max_samples: usize) -> Vec<SubtitleCue> {
    if cues.len() <= max_samples {
        return cues.to_vec();
    }
    if max_samples <= 1 {
        return vec![cues[0].clone()];
    }
    let last_idx = cues.len() - 1;
    let mut out = Vec::with_capacity(max_samples);
    let mut last_start = i64::MIN;
    for s in 0..max_samples {
        let idx = (s * last_idx) / (max_samples - 1);
        let c = &cues[idx];
        if c.start_ms != last_start {
            last_start = c.start_ms;
            out.push(c.clone());
        }
    }
    out
}

fn constant_timeline_shift_ms(rep: &[SubtitleCue], cand: &[SubtitleCue]) -> Option<i64> {
    if rep.len() < MIN_SELECTED_CUES || rep.len() != cand.len() {
        return None;
    }
    let shift = cand[0].start_ms - rep[0].start_ms;
    for (l, r) in rep.iter().zip(cand.iter()) {
        if r.start_ms - l.start_ms != shift || r.end_ms - l.end_ms != shift {
            return None;
        }
    }
    Some(shift)
}

fn reuse_shift_equivalent_match(
    tl: &TimelineRetimeResult,
    rep_target: &[SubtitleCue],
    target: &[SubtitleCue],
) -> Option<TimelineRetimeResult> {
    let shift = constant_timeline_shift_ms(rep_target, target)?;
    if tl.cues.len() != target.len() {
        return None;
    }
    let mut out = tl.clone();
    for (i, cue) in out.cues.iter_mut().enumerate() {
        cue.original_start_ms = target[i].start_ms;
        cue.original_end_ms = target[i].end_ms;
    }
    out.alignment_intercept_ms -= tl.alignment_scale * (shift as f64);
    Some(out)
}

fn direct_quality_score(track: &ReferenceTrack, tl: &TimelineRetimeResult) -> f64 {
    let cost_score = 1.0 / (1.0 + tl.average_group_cost.max(0.0));
    let skip_pen = (tl.longest_target_skip_run.min(20) as f64) * 0.004;
    let sdh_pen = if track.is_sdh { 0.010 } else { 0.0 };
    tl.target_coverage * 0.42 + tl.reference_coverage * 0.15 + cost_score * 0.23 + tl.simple_group_ratio * 0.20
        - skip_pen
        - sdh_pen
}

fn is_better_match(
    cand_trk: &ReferenceTrack,
    cand_tl: &TimelineRetimeResult,
    cur_trk: &ReferenceTrack,
    cur_tl: &TimelineRetimeResult,
    same_target: bool,
) -> bool {
    if cand_tl.confident != cur_tl.confident {
        return cand_tl.confident;
    }
    if same_target {
        if let Some(pref) = prefer_tighter_fit_on_disagreement(cand_tl, cur_tl) {
            return pref;
        }
    }
    let q_cand = direct_quality_score(cand_trk, cand_tl);
    let q_cur = direct_quality_score(cur_trk, cur_tl);
    if (q_cand - q_cur).abs() > 1e-12 {
        q_cand > q_cur
    } else {
        cand_trk.key < cur_trk.key
    }
}

fn is_exceptional_match(track: &ReferenceTrack, tl: &TimelineRetimeResult) -> bool {
    tl.confident
        && direct_quality_score(track, tl) >= EXCEPTIONAL_MATCH_QUALITY
        && tl.target_coverage >= EXCEPTIONAL_MATCH_TARGET_COVERAGE
        && tl.reference_coverage >= EXCEPTIONAL_MATCH_REFERENCE_COVERAGE
        && tl.simple_group_ratio >= EXCEPTIONAL_MATCH_SIMPLE_RATIO
}

fn is_strong_checkpoint(track: &ReferenceTrack, tl: &TimelineRetimeResult, aggressive: bool) -> bool {
    let (q, tc, rc) = if aggressive {
        (
            STRONG_CHECKPOINT_QUALITY,
            STRONG_CHECKPOINT_TARGET_COVERAGE,
            STRONG_CHECKPOINT_REFERENCE_COVERAGE,
        )
    } else {
        (
            PASSIVE_CHECKPOINT_QUALITY,
            PASSIVE_CHECKPOINT_TARGET_COVERAGE,
            PASSIVE_CHECKPOINT_REFERENCE_COVERAGE,
        )
    };
    tl.confident
        && direct_quality_score(track, tl) >= q
        && tl.target_coverage >= tc
        && tl.reference_coverage >= rc
}

fn is_asymmetric_checkpoint(
    track: &ReferenceTrack,
    tl: &TimelineRetimeResult,
    target_cues: usize,
) -> bool {
    if target_cues == 0 {
        return false;
    }
    let ref_ratio = (track.cues.len() as f64) / (target_cues as f64);
    tl.confident
        && ref_ratio >= ASYMMETRIC_CHECKPOINT_MIN_REFERENCE_RATIO
        && direct_quality_score(track, tl) >= ASYMMETRIC_CHECKPOINT_QUALITY
        && tl.target_coverage >= ASYMMETRIC_CHECKPOINT_TARGET_COVERAGE
        && tl.reference_coverage >= ASYMMETRIC_CHECKPOINT_REFERENCE_COVERAGE
        && tl.average_group_cost <= ASYMMETRIC_CHECKPOINT_MAX_GROUP_COST
        && tl.simple_group_ratio >= ASYMMETRIC_CHECKPOINT_SIMPLE_RATIO
        && tl.longest_target_skip_run <= ASYMMETRIC_CHECKPOINT_MAX_TARGET_SKIP_RUN
}

// ---------- Subtitle Downloading & Archive Extraction ----------

async fn load_candidates_parallel(
    candidates: &[SubtitleCandidateInput],
    start_index: usize,
    cancel: &Arc<AtomicBool>,
) -> Vec<(usize, SubtitleCandidateInput, LoadedSubtitle)> {
    let sem = Arc::new(Semaphore::new(MAX_PARALLEL_CANDIDATE_DOWNLOADS));
    let mut handles = Vec::with_capacity(candidates.len());
    for (offset, cand) in candidates.iter().cloned().enumerate() {
        let sem_c = sem.clone();
        let cancel_c = cancel.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem_c.acquire().await.ok()?;
            if cancel_c.load(Ordering::Relaxed) {
                return None;
            }
            let loaded = load_candidate_subtitle(&cand, cancel_c).await?;
            Some((start_index + offset, cand, loaded))
        }));
    }
    let mut out = Vec::new();
    for h in handles {
        if let Ok(Some(item)) = h.await {
            out.push(item);
        }
    }
    out.sort_by_key(|(idx, _, _)| *idx);
    out
}

async fn load_candidate_subtitle(
    cand: &SubtitleCandidateInput,
    cancel: Arc<AtomicBool>,
) -> Option<LoadedSubtitle> {
    if cancel.load(Ordering::Relaxed) {
        return None;
    }

    if let Some(ref inline) = cand.inline_text {
        let (fmt, cues) = parse_subtitles(inline, Some(&cand.url), cand.format.as_deref());
        if cues.len() >= MIN_SELECTED_CUES {
            return Some(LoadedSubtitle {
                format: fmt,
                cues,
                raw_body: inline.clone(),
            });
        }
    }

    if let Some(ref lp) = cand.local_path {
        if let Some(path) = url_guard::local_file_path(lp).or_else(|| Some(PathBuf::from(lp))) {
            if let Some(bytes) = read_local_file_limited(&path, MAX_SUBTITLE_RESPONSE_BYTES).await {
                let text = decode_subtitle_bytes(&bytes, cand.lang.as_deref());
                let (fmt, cues) = parse_subtitles(
                    &text,
                    Some(&path.to_string_lossy()),
                    cand.format.as_deref(),
                );
                if cues.len() >= MIN_SELECTED_CUES {
                    return Some(LoadedSubtitle {
                        format: fmt,
                        cues,
                        raw_body: text,
                    });
                }
            }
        }
    }

    // Check if url itself is a local file path.
    if let Some(local_path) = url_guard::local_file_path(&cand.url) {
        if let Some(bytes) = read_local_file_limited(&local_path, MAX_SUBTITLE_RESPONSE_BYTES).await {
            let text = decode_subtitle_bytes(&bytes, cand.lang.as_deref());
            let (fmt, cues) =
                parse_subtitles(&text, Some(&cand.url), cand.format.as_deref());
            if cues.len() >= MIN_SELECTED_CUES {
                return Some(LoadedSubtitle {
                    format: fmt,
                    cues,
                    raw_body: text,
                });
            }
        }
        return None;
    }

    let raw_bytes = download_subtitle_bytes_with_429_retry(cand, &cancel).await?;
    if cancel.load(Ordering::Relaxed) {
        return None;
    }
    let is_zip = raw_bytes.starts_with(b"PK\x03\x04") || raw_bytes.starts_with(b"PK\x05\x06");
    if is_zip {
        return extract_best_subtitle_from_zip(&raw_bytes, cand.lang.as_deref());
    }
    if raw_bytes.len() > MAX_SUBTITLE_RESPONSE_BYTES {
        return None;
    }
    let text = decode_subtitle_bytes(&raw_bytes, cand.lang.as_deref());
    let (fmt, cues) = parse_subtitles(&text, Some(&cand.url), cand.format.as_deref());
    if cues.len() < MIN_SELECTED_CUES {
        return None;
    }
    Some(LoadedSubtitle {
        format: fmt,
        cues,
        raw_body: text,
    })
}

async fn read_local_file_limited(path: &std::path::Path, max_bytes: usize) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt as _;
    let file = tokio::fs::File::open(path).await.ok()?;
    let mut limited = file.take((max_bytes + 1) as u64);
    let mut buf = Vec::new();
    limited.read_to_end(&mut buf).await.ok()?;
    if buf.len() > max_bytes {
        None
    } else {
        Some(buf)
    }
}

async fn download_subtitle_bytes_with_429_retry(
    cand: &SubtitleCandidateInput,
    cancel: &AtomicBool,
) -> Option<Vec<u8>> {
    let allow_local = cand.local_trusted.unwrap_or(false);
    let parsed_url = url_guard::validate_subtitle_candidate_url(&cand.url, allow_local).ok()?;

    let credential = cand
        .download_auth
        .as_ref()
        .and_then(|a| crate::subtitle_credentials::resolve(&a.credential_id).ok());

    let first = fetch_with_redirects(
        parsed_url.clone(),
        cand.headers.as_ref(),
        credential.as_ref(),
        allow_local,
    )
    .await;
    match first {
        Ok((200..=299, bytes)) => Some(bytes),
        Ok((429, _)) => {
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            tokio::time::sleep(HTTP_429_RETRY_DELAY).await;
            if cancel.load(Ordering::Relaxed) {
                return None;
            }
            match fetch_with_redirects(
                parsed_url,
                cand.headers.as_ref(),
                credential.as_ref(),
                allow_local,
            )
            .await
            {
                Ok((200..=299, bytes)) => Some(bytes),
                _ => None,
            }
        }
        _ => None,
    }
}

async fn fetch_with_redirects(
    initial_url: url::Url,
    headers: Option<&HashMap<String, String>>,
    credential: Option<&crate::subtitle_credentials::ResolvedSubtitleCredential>,
    allow_local: bool,
) -> Result<(u16, Vec<u8>), String> {
    let mut current_url = initial_url;
    let empty_hdrs = HashMap::new();
    let mut safe_hdrs = url_guard::safe_reqwest_headers(headers.unwrap_or(&empty_hdrs), false);
    let mut active_credential = credential;

    for _hop in 0..=5 {
        let (host, addrs) =
            url_guard::resolve_and_validate_http_target(&current_url, allow_local).await?;
        let client = url_guard::build_pinned_http_client(
            &host,
            &addrs,
            Duration::from_secs(5),
            Some(SUBTITLE_DOWNLOAD_TIMEOUT),
        )?;

        let (req_url, cred_hdr) = match active_credential {
            Some(cred) => {
                crate::subtitle_credentials::apply_to_request(&current_url, cred)
                    .unwrap_or_else(|_| (current_url.clone(), None))
            }
            None => (current_url.clone(), None),
        };
        let mut req = client.get(req_url).header("Accept", "*/*");
        for (k, v) in &safe_hdrs {
            req = req.header(k.as_str(), v.as_str());
        }
        if let Some((ck, cv)) = cred_hdr {
            req = req.header(ck.as_str(), cv.as_str());
        }

        let mut resp = req.send().await.map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if matches!(status, 301 | 302 | 303 | 307 | 308) {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "redirect missing location".to_string())?;
            let next_url = current_url.join(loc).map_err(|e| e.to_string())?;
            url_guard::validate_subtitle_candidate_url(next_url.as_str(), allow_local)?;
            if current_url.scheme() == "https" && next_url.scheme() == "http" {
                return Err("https downgrade blocked".into());
            }
            if !crate::http_redirect::same_origin(&current_url, &next_url) {
                active_credential = None;
                safe_hdrs.retain(|(k, _)| crate::http_redirect::safe_cross_origin_header(k));
            }
            current_url = next_url;
            continue;
        }
        let mut buf = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            if buf.len() + chunk.len() > MAX_ARCHIVE_DOWNLOAD_BYTES {
                return Err("subtitle payload exceeded limit".into());
            }
            buf.extend_from_slice(&chunk);
        }
        return Ok((status, buf));
    }
    Err("too many redirects".into())
}

fn is_safe_archive_entry_name(name: &str) -> bool {
    if name.is_empty()
        || name.contains('\0')
        || name.starts_with('/')
        || name.starts_with('\\')
    {
        return false;
    }
    if name.split(['/', '\\']).any(|seg| seg == "..") {
        return false;
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    true
}

fn extract_best_subtitle_from_zip(
    zip_bytes: &[u8],
    lang_hint: Option<&str>,
) -> Option<LoadedSubtitle> {
    let reader = Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(reader).ok()?;
    let count = archive.len().min(MAX_ARCHIVE_ENTRIES);
    let mut total_inflated = 0usize;
    let mut best: Option<(i32, LoadedSubtitle)> = None;

    for i in 0..count {
        let Ok(mut entry) = archive.by_index(i) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if !is_safe_archive_entry_name(&name) {
            continue;
        }
        let lower = name.to_ascii_lowercase();
        let format_score = if lower.ends_with(".srt") {
            3
        } else if lower.ends_with(".ass") || lower.ends_with(".ssa") {
            2
        } else if lower.ends_with(".vtt") {
            1
        } else {
            continue;
        };
        if entry.size() > MAX_SUBTITLE_RESPONSE_BYTES as u64 {
            continue;
        }
        let mut bytes = Vec::with_capacity((entry.size() as usize).min(MAX_SUBTITLE_RESPONSE_BYTES));
        let mut limited = (&mut entry).take((MAX_SUBTITLE_RESPONSE_BYTES + 1) as u64);
        if limited.read_to_end(&mut bytes).is_err() || bytes.len() > MAX_SUBTITLE_RESPONSE_BYTES {
            continue;
        }
        total_inflated += bytes.len();
        if total_inflated > MAX_ARCHIVE_INFLATED_BYTES {
            break;
        }
        if bytes.starts_with(b"PK\x03\x04") {
            continue;
        }
        let text = decode_subtitle_bytes(&bytes, lang_hint);
        // Infer format from the extracted entry name and content rather than overriding with an
        // outer candidate hint (e.g. an archive labeled "srt" containing an `.ass` file).
        let (fmt, cues) = parse_subtitles(&text, Some(&name), None);
        if cues.len() < MIN_SELECTED_CUES {
            continue;
        }
        let score = format_score * 10 + (cues.len().min(1000) as i32);
        if best.as_ref().is_none_or(|(bs, _)| score > *bs) {
            best = Some((
                score,
                LoadedSubtitle {
                    format: fmt,
                    cues,
                    raw_body: text,
                },
            ));
        }
    }

    best.map(|(_, loaded)| loaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subsync::aligner::build_delay_only_timeline;
    use crate::subsync::aligner::DelayOnlyAlignment;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn sample_delay_timeline(cues: &[SubtitleCue], offset_ms: f64) -> TimelineRetimeResult {
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

    fn base_request(tolerance_ms: i64, selected_url: &str) -> AlignSubtitlesRequest {
        AlignSubtitlesRequest {
            run_id: format!("test-{}", uuid::Uuid::new_v4()),
            media_url: "https://media.example/test.mkv".to_string(),
            media_headers: None,
            mode: AutoSyncMode::Quick,
            tolerance_ms,
            scope: AutoSyncCandidateScope::SelectedOnly,
            selected_track: SubtitleCandidateInput {
                url: selected_url.to_string(),
                local_path: None,
                inline_text: None,
                format: None,
                lang: Some("en".to_string()),
                title: None,
                headers: None,
                local_trusted: Some(false),
                download_auth: None,
                sub_id: None,
            },
            candidates: Vec::new(),
        }
    }

    fn make_reference_track() -> ReferenceTrack {
        ReferenceTrack {
            key: "mkv-cues:3".to_string(),
            language: Some("en".to_string()),
            label: Some("English".to_string()),
            cues: Vec::new(),
            is_forced: false,
            is_commentary: false,
            is_descriptive: false,
            is_sdh: false,
            sampled: false,
        }
    }

    #[test]
    fn archive_entry_name_check_allows_dots_and_blocks_traversal() {
        assert!(is_safe_archive_entry_name("Movie..2024.en.srt"));
        assert!(is_safe_archive_entry_name("subs/Movie..2024.ass"));
        assert!(!is_safe_archive_entry_name("../evil.srt"));
        assert!(!is_safe_archive_entry_name("a/../evil.srt"));
        assert!(!is_safe_archive_entry_name("a\\..\\evil.srt"));
        assert!(!is_safe_archive_entry_name("/abs/sub.srt"));
        assert!(!is_safe_archive_entry_name("C:\\abs\\sub.srt"));
        assert!(!is_safe_archive_entry_name("null\0byte.srt"));
    }

    #[test]
    fn zip_extraction_detects_ass_format_even_if_outer_candidate_was_srt() {
        let ass = "\
[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Line 1
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,Line 2
Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,Line 3
Dialogue: 0,0:00:10.00,0:00:12.00,Default,,0,0,0,,Line 4
";
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut zw = ZipWriter::new(&mut cursor);
            zw.start_file("movie.ass", SimpleFileOptions::default())
                .unwrap();
            zw.write_all(ass.as_bytes()).unwrap();
            zw.finish().unwrap();
        }
        let zip_bytes = cursor.into_inner();
        let loaded = extract_best_subtitle_from_zip(&zip_bytes, Some("en"))
            .expect("extract ass from zip");
        assert_eq!(loaded.format, SubtitleFormat::Ass);
        assert_eq!(loaded.cues.len(), 4);
    }

    #[tokio::test]
    async fn finalize_ttml_outputs_retimed_srt_and_local_backup_in_prepared_dir() {
        let ttml_body = "<tt><body><div><p begin=\"1.0s\" end=\"3.0s\">Hello TTML</p></div></body></tt>";
        let (_, cues) = parse_subtitles(ttml_body, Some("sub.ttml"), None);
        assert_eq!(cues.len(), 1);
        let tl = sample_delay_timeline(&cues, 1500.0);
        let req = base_request(0, "https://subs.example/sub.ttml");
        let eval = PoolEvalResult {
            winner: Some(PoolWinner {
                candidate: req.selected_track.clone(),
                loaded: LoadedSubtitle {
                    format: SubtitleFormat::Ttml,
                    cues,
                    raw_body: ttml_body.to_string(),
                },
                reference: make_reference_track(),
                timeline: tl,
            }),
            confirmed_no_fit: false,
        };

        let resp = finalize_pool_response(&req, eval, &req.selected_track.url)
            .await
            .expect("finalize");
        assert_eq!(resp.outcome, AlignOutcome::Synced);
        assert_eq!(resp.format, Some(SubtitleFormat::Srt));
        let text = resp.retimed_text.as_deref().expect("srt text");
        assert!(text.contains("00:00:02,500 --> 00:00:04,500"));
        assert!(!text.contains("<tt"));
        let retimed_path = resp.retimed_path.expect("retimed path");
        assert!(retimed_path.contains("prepared"));
        assert!(retimed_path.ends_with(".srt"));
        let orig_path = resp.selected_original_path.expect("orig backup path");
        assert!(orig_path.contains("prepared"));
        assert_eq!(resp.selected_original_format, Some(SubtitleFormat::Srt));
        assert!(resp
            .selected_original_text
            .as_deref()
            .unwrap()
            .contains("00:00:01,000 --> 00:00:03,000"));
        let _ = std::fs::remove_file(retimed_path);
        let _ = std::fs::remove_file(orig_path);
    }

    #[tokio::test]
    async fn tolerance_zero_does_not_skip_and_failed_retime_is_inconclusive() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\nLine one\n";
        let (_, cues) = parse_subtitles(srt, Some("a.srt"), None);
        let tl_zero = sample_delay_timeline(&cues, 0.0);

        let req_zero = base_request(0, "https://subs.example/a.srt");
        let res_zero = finalize_pool_response(
            &req_zero,
            PoolEvalResult {
                winner: Some(PoolWinner {
                    candidate: req_zero.selected_track.clone(),
                    loaded: LoadedSubtitle {
                        format: SubtitleFormat::Srt,
                        cues: cues.clone(),
                        raw_body: srt.to_string(),
                    },
                    reference: make_reference_track(),
                    timeline: tl_zero.clone(),
                }),
                confirmed_no_fit: false,
            },
            &req_zero.selected_track.url,
        )
        .await
        .unwrap();
        assert_eq!(res_zero.outcome, AlignOutcome::Synced);
        if let Some(p) = res_zero.retimed_path {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = res_zero.selected_original_path {
            let _ = std::fs::remove_file(p);
        }

        let req_tol = base_request(100, "https://subs.example/a.srt");
        let res_tol = finalize_pool_response(
            &req_tol,
            PoolEvalResult {
                winner: Some(PoolWinner {
                    candidate: req_tol.selected_track.clone(),
                    loaded: LoadedSubtitle {
                        format: SubtitleFormat::Srt,
                        cues: cues.clone(),
                        raw_body: srt.to_string(),
                    },
                    reference: make_reference_track(),
                    timeline: tl_zero,
                }),
                confirmed_no_fit: false,
            },
            &req_tol.selected_track.url,
        )
        .await
        .unwrap();
        assert_eq!(res_tol.outcome, AlignOutcome::WithinTolerance);

        // Non-retimeable raw body must return Inconclusive instead of raw XML/text as Synced.
        let req_bad = base_request(0, "https://subs.example/bad.srt");
        let res_bad = finalize_pool_response(
            &req_bad,
            PoolEvalResult {
                winner: Some(PoolWinner {
                    candidate: req_bad.selected_track.clone(),
                    loaded: LoadedSubtitle {
                        format: SubtitleFormat::Srt,
                        cues,
                        raw_body: "not valid timestamps".to_string(),
                    },
                    reference: make_reference_track(),
                    timeline: sample_delay_timeline(
                        &[SubtitleCue::new(1000, 3000, "Line one".into())],
                        2000.0,
                    ),
                }),
                confirmed_no_fit: false,
            },
            &req_bad.selected_track.url,
        )
        .await
        .unwrap();
        assert_eq!(res_bad.outcome, AlignOutcome::Inconclusive);
    }

    #[tokio::test]
    async fn fetch_with_redirects_strips_custom_headers_across_origins() {
        use axum::{http::HeaderMap, routing::get, Router};
        use std::sync::{Arc, Mutex as StdMutex};

        let captured = Arc::new(StdMutex::new(HashMap::<String, String>::new()));
        let cap_c = captured.clone();
        let target_router = Router::new().route(
            "/sub.srt",
            get(move |headers: HeaderMap| {
                let cap = cap_c.clone();
                async move {
                    let mut map = cap.lock().unwrap();
                    for (k, v) in headers.iter() {
                        if let Ok(s) = v.to_str() {
                            map.insert(k.to_string(), s.to_string());
                        }
                    }
                    "1\n00:00:01,000 --> 00:00:03,000\nOK\n"
                }
            }),
        );
        let t_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let t_url = format!("http://{}/sub.srt", t_listener.local_addr().unwrap());
        let t_task = tokio::spawn(async move { axum::serve(t_listener, target_router).await.unwrap() });

        let t_dest = t_url.clone();
        let redir_router = Router::new().route(
            "/start",
            get(move || {
                let loc = t_dest.clone();
                async move { (axum::http::StatusCode::FOUND, [("location", loc)]) }
            }),
        );
        let r_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let r_url = format!("http://{}/start", r_listener.local_addr().unwrap());
        let r_task = tokio::spawn(async move { axum::serve(r_listener, redir_router).await.unwrap() });

        let mut hdrs = HashMap::new();
        hdrs.insert("Authorization".to_string(), "Bearer secret".to_string());
        hdrs.insert("X-Custom-Token".to_string(), "secret-token".to_string());
        hdrs.insert("Cookie".to_string(), "session=secret".to_string());
        hdrs.insert("User-Agent".to_string(), "HarborTest/1.0".to_string());

        let (status, body) = fetch_with_redirects(
            url::Url::parse(&r_url).unwrap(),
            Some(&hdrs),
            None,
            true,
        )
        .await
        .expect("redirect fetch");
        assert_eq!(status, 200);
        assert!(!body.is_empty());

        let seen = captured.lock().unwrap();
        assert!(!seen.contains_key("authorization"));
        assert!(!seen.contains_key("x-custom-token"));
        assert!(!seen.contains_key("cookie"));
        assert_eq!(seen.get("user-agent").map(String::as_str), Some("HarborTest/1.0"));

        t_task.abort();
        r_task.abort();
    }

    #[tokio::test]
    async fn selected_then_search_returns_inconclusive_when_selected_and_alts_fail_to_load() {
        // Minimal valid MKV with 1 subtitle track and 16 Cues over >= 45s span.
        let mkv = {
            fn vint_sz(val: usize) -> Vec<u8> {
                if val < 0x7f {
                    vec![0x80 | (val as u8)]
                } else {
                    let v = 0x4000 | (val as u16);
                    v.to_be_bytes().to_vec()
                }
            }
            fn el(id: &[u8], payload: &[u8]) -> Vec<u8> {
                let mut out = id.to_vec();
                out.extend_from_slice(&vint_sz(payload.len()));
                out.extend_from_slice(payload);
                out
            }
            fn u_el(id: &[u8], val: u64) -> Vec<u8> {
                let b = val.to_be_bytes();
                let nz = b.iter().position(|&x| x != 0).unwrap_or(7);
                el(id, &b[nz..])
            }
            let ebml = el(&[0x1A, 0x45, 0xDF, 0xA3], &u_el(&[0x42, 0x86], 1));
            let info = el(&[0x15, 0x49, 0xA9, 0x66], &u_el(&[0x2A, 0xD7, 0xB1], 1_000_000));
            let mut trk = Vec::new();
            trk.extend_from_slice(&u_el(&[0xD7], 3));
            trk.extend_from_slice(&u_el(&[0x83], 17));
            trk.extend_from_slice(&el(&[0x22, 0xB5, 0x9D], b"en"));
            trk.extend_from_slice(&el(&[0x86], b"S_TEXT/UTF8"));
            let tracks = el(&[0x16, 0x54, 0xAE, 0x6B], &el(&[0xAE], &trk));
            let mut cues_body = Vec::new();
            for i in 0..16u64 {
                let mut pos = u_el(&[0xF7], 3);
                pos.extend_from_slice(&u_el(&[0xB2], 1_500));
                let mut pt = u_el(&[0xB3], i * 4_000 + 1_000);
                pt.extend_from_slice(&el(&[0xB7], &pos));
                cues_body.extend_from_slice(&el(&[0xBB], &pt));
            }
            let cues = el(&[0x1C, 0x53, 0xBB, 0x6B], &cues_body);
            let mut seg = Vec::new();
            seg.extend_from_slice(&info);
            seg.extend_from_slice(&tracks);
            seg.extend_from_slice(&cues);
            let mut out = ebml;
            out.extend_from_slice(&el(&[0x18, 0x53, 0x80, 0x67], &seg));
            out
        };
        let dir = std::env::temp_dir().join(format!("harbor-coord-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mkv_path = dir.join("movie.mkv");
        std::fs::write(&mkv_path, mkv).unwrap();

        let missing = dir.join("missing.srt");
        let missing_alt = dir.join("missing_alt.srt");
        let mut req = base_request(0, missing.to_str().unwrap());
        req.media_url = mkv_path.to_str().unwrap().to_string();
        req.scope = AutoSyncCandidateScope::SelectedThenSearch;
        req.candidates = vec![SubtitleCandidateInput {
            url: missing_alt.to_str().unwrap().to_string(),
            local_path: None,
            inline_text: None,
            format: None,
            lang: Some("en".to_string()),
            title: None,
            headers: None,
            local_trusted: Some(true),
            download_auth: None,
            sub_id: None,
        }];

        let resp = subsync_align_subtitles(req).await.expect("align cmd");
        assert_eq!(resp.outcome, AlignOutcome::Inconclusive);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

