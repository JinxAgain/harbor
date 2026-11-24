//! Pure Rust embedded subtitle timeline indexer for MKV/WebM and MP4/MOV containers.
//!
//! Ported from NuvioMobile's `EmbeddedSubtitleTimelineLoader.kt`, extended with:
//! - Direct local filesystem random-access reads (`file://` and absolute paths)
//! - HTTP range reads supporting HTTPS, HTTP, LAN media servers, and local torrent streams
//! - Optional `ffprobe` subtitle-packet timestamp fallback ONLY when an MKV has non-PGS text
//!   subtitle tracks in `Tracks` with 0 entries in `Cues` (never touches audio!)
//! - 2-entry LRU cache (120s negative TTL) with in-flight deduplication

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use tokio::sync::{watch, OnceCell};

use crate::subsync::cue_parser::{filter_indexed_ass_dialogue_cues, SubtitleCue};
use crate::subsync::mp4_samples::{parse_moov_subtitles, Mp4SubtitleCodec, Mp4SubtitleSampleTable};
use crate::subsync::url_guard;

const TOTAL_TIMEOUT: Duration = Duration::from_secs(7);
const INITIAL_PROBE_BYTES: usize = 512 * 1024;
const HEADER_PROBE_BYTES: usize = 64;
const TAIL_PROBE_BYTES: usize = 4 * 1024 * 1024;
const MAX_SEEK_HEAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_INFO_BYTES: usize = 512 * 1024;
const MAX_TRACKS_BYTES: usize = 4 * 1024 * 1024;
const MAX_CUES_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_READ_BYTES: u64 = 25 * 1024 * 1024;
const MAX_RANGE_REQUESTS: usize = 16;
const MAX_SEEK_HEAD_HOPS: usize = 4;
const DEFAULT_TIMESTAMP_SCALE_NS: u64 = 1_000_000;
const DEFAULT_MP4_CUE_DURATION_MS: i64 = 5_000;
const LAST_MKV_CUE_ESTIMATED_DURATION_MS: i64 = 2_000;
const MAX_MKV_INTER_CUE_ESTIMATED_DURATION_MS: i64 = 4_000;
const MIN_INDEXED_CUES: usize = 8;
const MIN_INDEXED_SPAN_MS: i64 = 30_000;
const MAX_CACHE_ENTRIES: usize = 2;
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(120);
const MAX_MP4_MOOV_BYTES: usize = 24 * 1024 * 1024;
const MAX_MP4_TOP_LEVEL_BOXES: usize = 64;
const MP4_BOX_HEADER_BYTES: usize = 16;
const MP4_TYPE_MOOV: u32 = u32::from_be_bytes(*b"moov");
const FFPROBE_FALLBACK_TIMEOUT: Duration = Duration::from_secs(8);

// EBML IDs
#[cfg(test)]
const ID_EBML: u64 = 0x1A45_DFA3;
const ID_SEGMENT: u64 = 0x1853_8067;
const ID_SEEK_HEAD: u64 = 0x114D_9B74;
const ID_INFO: u64 = 0x1549_A966;
const ID_TRACKS: u64 = 0x1654_AE6B;
const ID_CUES: u64 = 0x1C53_BB6B;
const ID_CLUSTER: u64 = 0x1F43_B675;

const ID_SEEK: u64 = 0x4DBB;
const ID_SEEK_ID: u64 = 0x53AB;
const ID_SEEK_POSITION: u64 = 0x53AC;
const ID_TIMESTAMP_SCALE: u64 = 0x2AD7_B1;

const ID_TRACK_ENTRY: u64 = 0xAE;
const ID_TRACK_NUMBER: u64 = 0xD7;
const ID_TRACK_TYPE: u64 = 0x83;
const ID_FLAG_DEFAULT: u64 = 0x88;
const ID_FLAG_FORCED: u64 = 0x55AA;
const ID_FLAG_HEARING_IMPAIRED: u64 = 0x55AB;
const ID_FLAG_VISUAL_IMPAIRED: u64 = 0x55AC;
const ID_FLAG_TEXT_DESCRIPTIONS: u64 = 0x55AD;
const ID_FLAG_COMMENTARY: u64 = 0x55AF;
const ID_NAME: u64 = 0x536E;
const ID_LANGUAGE: u64 = 0x22B5_9C;
const ID_LANGUAGE_IETF: u64 = 0x22B5_9D;
const ID_CODEC_ID: u64 = 0x86;
const TRACK_TYPE_SUBTITLE: u64 = 17;

const ID_CUE_POINT: u64 = 0xBB;
const ID_CUE_TIME: u64 = 0xB3;
const ID_CUE_TRACK_POSITIONS: u64 = 0xB7;
const ID_CUE_TRACK: u64 = 0xF7;
const ID_CUE_DURATION: u64 = 0xB2;

const MATROSKA_PGS_CODEC_ID: &str = "S_HDMV/PGS";
const MATROSKA_ASS_CODEC_ID: &str = "S_TEXT/ASS";
const MATROSKA_SSA_CODEC_ID: &str = "S_TEXT/SSA";

#[derive(Debug, Clone)]
pub struct ReferenceTrack {
    pub key: String,
    #[allow(dead_code)]
    pub language: Option<String>,
    pub label: Option<String>,
    pub cues: Vec<SubtitleCue>,
    pub is_forced: bool,
    pub is_commentary: bool,
    pub is_descriptive: bool,
    pub is_sdh: bool,
    pub sampled: bool,
}

#[derive(Debug, Clone)]
pub struct IndexedEmbeddedTimeline {
    pub tracks: Vec<ReferenceTrack>,
    #[allow(dead_code)]
    pub source: String,
    #[allow(dead_code)]
    pub no_subtitle_tracks: bool,
    #[allow(dead_code)]
    pub bytes_read: u64,
    #[allow(dead_code)]
    pub range_requests: usize,
}

#[derive(Debug, Clone)]
pub enum ContainerLoadOutcome {
    Ready(IndexedEmbeddedTimeline),
    NoSubtitleTracks,
    NoUsableReference,
    Unavailable,
}

#[derive(Clone)]
enum CachedEntry {
    Positive(IndexedEmbeddedTimeline),
    NoSubtitleTracks { created_at: Instant },
    Negative { created_at: Instant },
}

#[derive(Default)]
struct CacheState {
    order: VecDeque<String>,
    entries: HashMap<String, CachedEntry>,
    in_flight: HashMap<String, watch::Receiver<Option<ContainerLoadOutcome>>>,
}

fn cache_state() -> &'static Mutex<CacheState> {
    static CACHE: OnceLock<Mutex<CacheState>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(CacheState::default()))
}

fn make_cache_key(source_url: &str, headers: &HashMap<String, String>) -> String {
    let mut pairs: Vec<(String, &str)> = headers
        .iter()
        .map(|(k, v)| (k.to_ascii_lowercase(), v.as_str()))
        .collect();
    pairs.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));
    let mut hasher = Sha256::new();
    hasher.update(source_url.as_bytes());
    hasher.update(b"\0");
    for (k, v) in pairs {
        hasher.update(k.as_bytes());
        hasher.update(b"\0");
        hasher.update(v.as_bytes());
        hasher.update(b"\0");
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    hex
}

struct InFlightCleanupGuard {
    key: String,
    tx: Option<watch::Sender<Option<ContainerLoadOutcome>>>,
}

impl InFlightCleanupGuard {
    fn complete(mut self, outcome: ContainerLoadOutcome) {
        let tx = self.tx.take();
        {
            let mut guard = cache_state().lock().unwrap_or_else(|p| p.into_inner());
            guard.in_flight.remove(&self.key);
            match &outcome {
                ContainerLoadOutcome::Ready(tl) => {
                    insert_lru(&mut guard, self.key.clone(), CachedEntry::Positive(tl.clone()));
                }
                ContainerLoadOutcome::NoSubtitleTracks => {
                    insert_lru(
                        &mut guard,
                        self.key.clone(),
                        CachedEntry::NoSubtitleTracks {
                            created_at: Instant::now(),
                        },
                    );
                }
                ContainerLoadOutcome::NoUsableReference => {
                    insert_lru(
                        &mut guard,
                        self.key.clone(),
                        CachedEntry::Negative {
                            created_at: Instant::now(),
                        },
                    );
                }
                ContainerLoadOutcome::Unavailable => {}
            }
        }
        if let Some(tx) = tx {
            let _ = tx.send(Some(outcome));
        }
    }
}

impl Drop for InFlightCleanupGuard {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let mut guard = cache_state().lock().unwrap_or_else(|p| p.into_inner());
            guard.in_flight.remove(&self.key);
            drop(guard);
            let _ = tx.send(Some(ContainerLoadOutcome::Unavailable));
        }
    }
}

pub async fn load_embedded_timeline(
    source_url: &str,
    headers: &HashMap<String, String>,
) -> ContainerLoadOutcome {
    if url_guard::validate_playback_media_url(source_url).is_err() {
        return ContainerLoadOutcome::Unavailable;
    }
    let key = make_cache_key(source_url, headers);

    let mut rx = {
        let mut guard = cache_state().lock().unwrap_or_else(|p| p.into_inner());
        if let Some(entry) = guard.entries.get(&key).cloned() {
            match entry {
                CachedEntry::Positive(tl) => {
                    touch_lru(&mut guard, &key);
                    return ContainerLoadOutcome::Ready(tl);
                }
                CachedEntry::NoSubtitleTracks { created_at } => {
                    if created_at.elapsed() < NEGATIVE_CACHE_TTL {
                        touch_lru(&mut guard, &key);
                        return ContainerLoadOutcome::NoSubtitleTracks;
                    }
                    guard.entries.remove(&key);
                    guard.order.retain(|k| k != &key);
                }
                CachedEntry::Negative { created_at } => {
                    if created_at.elapsed() < NEGATIVE_CACHE_TTL {
                        touch_lru(&mut guard, &key);
                        return ContainerLoadOutcome::NoUsableReference;
                    }
                    guard.entries.remove(&key);
                    guard.order.retain(|k| k != &key);
                }
            }
        }
        if let Some(existing_rx) = guard.in_flight.get(&key) {
            existing_rx.clone()
        } else {
            let (tx, rx) = watch::channel(None);
            guard.in_flight.insert(key.clone(), rx.clone());
            let key_owned = key.clone();
            let source_owned = source_url.to_string();
            let headers_owned = headers.clone();
            tokio::spawn(async move {
                let cleanup = InFlightCleanupGuard {
                    key: key_owned,
                    tx: Some(tx),
                };
                let outcome = load_and_classify(&source_owned, &headers_owned).await;
                cleanup.complete(outcome);
            });
            rx
        }
    };

    if let Some(res) = rx.borrow().clone() {
        return res;
    }
    while rx.changed().await.is_ok() {
        if let Some(res) = rx.borrow().clone() {
            return res;
        }
    }
    ContainerLoadOutcome::Unavailable
}

fn touch_lru(guard: &mut CacheState, key: &str) {
    guard.order.retain(|k| k != key);
    guard.order.push_back(key.to_string());
}

fn insert_lru(guard: &mut CacheState, key: String, entry: CachedEntry) {
    touch_lru(guard, &key);
    guard.entries.insert(key, entry);
    while guard.order.len() > MAX_CACHE_ENTRIES {
        if let Some(evict) = guard.order.pop_front() {
            guard.entries.remove(&evict);
        }
    }
}

enum InspectResult {
    Outcome(ContainerLoadOutcome),
    NeedsLocalFfprobeFallback {
        tracks: Vec<MatroskaSubtitleTrack>,
        bytes_read: u64,
        range_requests: usize,
    },
}

async fn load_and_classify(
    source_url: &str,
    headers: &HashMap<String, String>,
) -> ContainerLoadOutcome {
    if let Some(local_path) = url_guard::local_file_path(source_url) {
        let path_clone = local_path.clone();
        let inspect_res = tokio::time::timeout(TOTAL_TIMEOUT, async move {
            let mut reader = LocalSourceReader::open(path_clone).await?;
            inspect_container(&mut reader, true).await
        })
        .await;
        return match inspect_res {
            Ok(Ok(InspectResult::Outcome(outcome))) => outcome,
            Ok(Ok(InspectResult::NeedsLocalFfprobeFallback {
                tracks,
                bytes_read,
                range_requests,
            })) => {
                if let Some(ref_tracks) = ffprobe_mkv_text_subtitles(&local_path, &tracks).await {
                    ContainerLoadOutcome::Ready(IndexedEmbeddedTimeline {
                        tracks: ref_tracks,
                        source: "ffprobe-subtitle-packets".to_string(),
                        no_subtitle_tracks: false,
                        bytes_read,
                        range_requests,
                    })
                } else {
                    ContainerLoadOutcome::NoUsableReference
                }
            }
            Ok(Err(TimedOrPermanent::Transient)) | Ok(Err(TimedOrPermanent::Blocked)) => {
                ContainerLoadOutcome::Unavailable
            }
            Ok(Err(TimedOrPermanent::Permanent)) => ContainerLoadOutcome::NoUsableReference,
            Err(_) => ContainerLoadOutcome::Unavailable,
        };
    }

    let src = source_url.to_string();
    let hdrs = headers.clone();
    match tokio::time::timeout(TOTAL_TIMEOUT, async move {
        let mut reader = HttpRangeReader::new(src, hdrs)?;
        inspect_container(&mut reader, false).await
    })
    .await
    {
        Ok(Ok(InspectResult::Outcome(outcome))) => outcome,
        Ok(Ok(InspectResult::NeedsLocalFfprobeFallback { .. })) => {
            ContainerLoadOutcome::NoUsableReference
        }
        Ok(Err(TimedOrPermanent::Transient)) | Ok(Err(TimedOrPermanent::Blocked)) => {
            ContainerLoadOutcome::Unavailable
        }
        Ok(Err(TimedOrPermanent::Permanent)) => ContainerLoadOutcome::NoUsableReference,
        Err(_) => ContainerLoadOutcome::Unavailable,
    }
}

#[derive(Debug)]
enum TimedOrPermanent {
    Transient,
    Blocked,
    Permanent,
}

impl From<()> for TimedOrPermanent {
    fn from(_: ()) -> Self {
        Self::Permanent
    }
}

struct RangeResponse {
    bytes: Vec<u8>,
    total_length: Option<u64>,
}

#[async_trait::async_trait]
trait RandomAccessReader: Send {
    async fn read_range(
        &mut self,
        start: u64,
        len: usize,
        require_partial: bool,
        require_exact: bool,
    ) -> Result<RangeResponse, TimedOrPermanent>;
    fn bytes_read(&self) -> u64;
    fn requests_made(&self) -> usize;
    fn remaining_byte_budget(&self) -> u64;
}

struct LocalSourceReader {
    path: PathBuf,
    total_len: u64,
    bytes_read: u64,
    requests: usize,
}

impl LocalSourceReader {
    async fn open(path: PathBuf) -> Result<Self, TimedOrPermanent> {
        let meta_len = tokio::task::spawn_blocking({
            let p = path.clone();
            move || std::fs::metadata(&p).map(|m| m.len())
        })
        .await
        .map_err(|_| TimedOrPermanent::Transient)?
        .map_err(|_| TimedOrPermanent::Transient)?;
        Ok(Self {
            path,
            total_len: meta_len,
            bytes_read: 0,
            requests: 0,
        })
    }
}

#[async_trait::async_trait]
impl RandomAccessReader for LocalSourceReader {
    async fn read_range(
        &mut self,
        start: u64,
        len: usize,
        _require_partial: bool,
        require_exact: bool,
    ) -> Result<RangeResponse, TimedOrPermanent> {
        if len == 0 || start >= self.total_len {
            return Err(TimedOrPermanent::Permanent);
        }
        if self.requests >= MAX_RANGE_REQUESTS || self.remaining_byte_budget() == 0 {
            return Err(TimedOrPermanent::Permanent);
        }
        let max_avail = (self.total_len - start)
            .min(len as u64)
            .min(self.remaining_byte_budget()) as usize;
        if require_exact && max_avail < len {
            return Err(TimedOrPermanent::Permanent);
        }
        self.requests += 1;
        let path = self.path.clone();
        let buf = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, std::io::Error> {
            let mut file = std::fs::File::open(&path)?;
            file.seek(SeekFrom::Start(start))?;
            let mut out = vec![0u8; max_avail];
            let mut read_total = 0usize;
            while read_total < out.len() {
                let n = file.read(&mut out[read_total..])?;
                if n == 0 {
                    break;
                }
                read_total += n;
            }
            out.truncate(read_total);
            Ok(out)
        })
        .await
        .map_err(|_| TimedOrPermanent::Transient)?
        .map_err(|_| TimedOrPermanent::Transient)?;

        if buf.is_empty() || (require_exact && buf.len() != len) {
            return Err(TimedOrPermanent::Permanent);
        }
        self.bytes_read += buf.len() as u64;
        Ok(RangeResponse {
            bytes: buf,
            total_length: Some(self.total_len),
        })
    }

    fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    fn requests_made(&self) -> usize {
        self.requests
    }

    fn remaining_byte_budget(&self) -> u64 {
        MAX_TOTAL_READ_BYTES.saturating_sub(self.bytes_read)
    }
}

struct HttpRangeReader {
    url: url::Url,
    allow_local: bool,
    headers: Vec<(String, String)>,
    cached_client: Option<(String, u16, bool, bool, reqwest::Client)>,
    deadline: Instant,
    bytes_read: u64,
    requests: usize,
    expected_total_length: Option<u64>,
}

impl HttpRangeReader {
    fn new(url_str: String, raw_headers: HashMap<String, String>) -> Result<Self, TimedOrPermanent> {
        let parsed = url::Url::parse(&url_str).map_err(|_| TimedOrPermanent::Permanent)?;
        let allow_local = url_guard::is_explicit_local_or_lan_host(&parsed);
        url_guard::check_http_url(&parsed, allow_local).map_err(|_| TimedOrPermanent::Blocked)?;
        let headers = url_guard::safe_reqwest_headers(&raw_headers, true);
        Ok(Self {
            url: parsed,
            allow_local,
            headers,
            cached_client: None,
            deadline: Instant::now() + TOTAL_TIMEOUT,
            bytes_read: 0,
            requests: 0,
            expected_total_length: None,
        })
    }

    async fn resolve_client_for_url(
        &self,
        target: &url::Url,
        allow_local: bool,
    ) -> Result<(reqwest::Client, bool, Option<(String, u16, bool, bool, reqwest::Client)>), TimedOrPermanent> {
        let host_key = target
            .host_str()
            .ok_or(TimedOrPermanent::Permanent)?
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        let port_key = target
            .port_or_known_default()
            .ok_or(TimedOrPermanent::Permanent)?;
        if let Some((
            ref cached_host,
            cached_port,
            cached_any_public,
            cached_all_public,
            ref cached,
        )) = self.cached_client
        {
            if cached_host == &host_key
                && cached_port == port_key
                && (allow_local || cached_all_public)
            {
                return Ok((cached.clone(), cached_any_public, None));
            }
        }
        let (resolved_host, addrs) =
            url_guard::resolve_and_validate_http_target(target, allow_local)
                .await
                .map_err(|e| {
                    if e == "dns-lookup-failed" {
                        TimedOrPermanent::Transient
                    } else {
                        TimedOrPermanent::Blocked
                    }
                })?;
        let any_public = url_guard::any_addr_is_public(&addrs);
        let all_public = addrs.iter().all(|addr| url_guard::check_ip(addr.ip(), false).is_ok());
        let client = url_guard::build_pinned_http_client(
            &resolved_host,
            &addrs,
            Duration::from_secs(4),
            None,
            None,
            true,
        )
        .map_err(|_| TimedOrPermanent::Transient)?;
        Ok((
            client.clone(),
            any_public,
            Some((host_key, port_key, any_public, all_public, client)),
        ))
    }
}

#[async_trait::async_trait]
impl RandomAccessReader for HttpRangeReader {
    async fn read_range(
        &mut self,
        start: u64,
        len: usize,
        require_partial: bool,
        require_exact: bool,
    ) -> Result<RangeResponse, TimedOrPermanent> {
        if len == 0 || self.requests >= MAX_RANGE_REQUESTS {
            return Err(TimedOrPermanent::Permanent);
        }
        let remaining_budget = self.remaining_byte_budget();
        if remaining_budget == 0 {
            return Err(TimedOrPermanent::Permanent);
        }
        let effective_len = if require_exact {
            if (len as u64) > remaining_budget {
                return Err(TimedOrPermanent::Permanent);
            }
            len
        } else {
            len.min(remaining_budget as usize)
        };
        if effective_len == 0 {
            return Err(TimedOrPermanent::Permanent);
        }
        let now = Instant::now();
        if now >= self.deadline {
            return Err(TimedOrPermanent::Transient);
        }
        let end = start
            .checked_add(effective_len as u64 - 1)
            .ok_or(TimedOrPermanent::Permanent)?;
        self.requests += 1;

        let mut current_url = self.url.clone();
        let mut current_headers = self.headers.clone();
        let mut allow_local = self.allow_local;
        let mut redirected = false;
        let mut final_resp: Option<reqwest::Response> = None;

        for _hop in 0..=5 {
            let now = Instant::now();
            if now >= self.deadline {
                return Err(TimedOrPermanent::Transient);
            }
            let req_timeout = (self.deadline - now).min(Duration::from_secs(5));
            let (client, resolved_public, candidate_cache) = self
                .resolve_client_for_url(&current_url, allow_local)
                .await?;
            // Latch allow_local off permanently once any hop touches a public IP so public
            // origins can never redirect back into loopback or private LAN services.
            if resolved_public {
                allow_local = false;
            }

            let mut req = client
                .get(current_url.clone())
                .timeout(req_timeout)
                .header("Range", format!("bytes={start}-{end}"))
                .header("Accept-Encoding", "identity");
            for (k, v) in &current_headers {
                req = req.header(k.as_str(), v.as_str());
            }

            let resp = req.send().await.map_err(|_| TimedOrPermanent::Transient)?;
            let status = resp.status().as_u16();
            if matches!(status, 301 | 302 | 303 | 307 | 308) {
                let loc = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or(TimedOrPermanent::Permanent)?;
                let next_url = current_url
                    .join(loc)
                    .map_err(|_| TimedOrPermanent::Permanent)?;
                if !url_guard::is_explicit_local_or_lan_host(&next_url) {
                    allow_local = false;
                }
                url_guard::check_http_url(&next_url, allow_local)
                    .map_err(|_| TimedOrPermanent::Blocked)?;
                if current_url.scheme() == "https" && next_url.scheme() == "http" {
                    return Err(TimedOrPermanent::Blocked);
                }
                if !crate::http_redirect::same_origin(&current_url, &next_url) {
                    current_headers
                        .retain(|(k, _)| crate::http_redirect::safe_cross_origin_header(k));
                }
                current_url = next_url;
                redirected = true;
                continue;
            }
            if (200..300).contains(&status) {
                self.allow_local = allow_local;
                if let Some(entry) = candidate_cache {
                    self.cached_client = Some(entry);
                }
                if redirected {
                    self.url = current_url.clone();
                    self.headers = current_headers.clone();
                }
            }
            final_resp = Some(resp);
            break;
        }

        let mut resp = final_resp.ok_or(TimedOrPermanent::Permanent)?;
        let status = resp.status().as_u16();
        if matches!(status, 408 | 429 | 500..=599) {
            return Err(TimedOrPermanent::Transient);
        }
        if !(200..300).contains(&status) {
            return Err(TimedOrPermanent::Permanent);
        }
        if let Some(ce) = resp
            .headers()
            .get(reqwest::header::CONTENT_ENCODING)
            .and_then(|v| v.to_str().ok())
        {
            if !ce.trim().is_empty() && !ce.trim().eq_ignore_ascii_case("identity") {
                return Err(TimedOrPermanent::Permanent);
            }
        }
        if (require_partial || start > 0) && status != 206 {
            return Err(TimedOrPermanent::Permanent);
        }

        let content_range = resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_content_range);
        if status == 206 {
            let Some(cr) = content_range else {
                return Err(TimedOrPermanent::Permanent);
            };
            if cr.start != Some(start) {
                return Err(TimedOrPermanent::Permanent);
            }
        }
        let content_length = resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());

        let mut out = Vec::with_capacity(effective_len.min(1024 * 1024));
        while out.len() < effective_len {
            if Instant::now() >= self.deadline {
                return Err(TimedOrPermanent::Transient);
            }
            if self.remaining_byte_budget() == 0 {
                return Err(TimedOrPermanent::Permanent);
            }
            let Some(chunk) = resp.chunk().await.map_err(|_| TimedOrPermanent::Transient)? else {
                break;
            };
            if chunk.is_empty() {
                continue;
            }
            let take = chunk
                .len()
                .min(effective_len - out.len())
                .min(self.remaining_byte_budget() as usize);
            if take == 0 {
                return Err(TimedOrPermanent::Permanent);
            }
            out.extend_from_slice(&chunk[..take]);
            self.bytes_read += take as u64;
        }
        if out.is_empty() || (require_exact && out.len() != effective_len) {
            return Err(TimedOrPermanent::Permanent);
        }
        let total_length = content_range
            .and_then(|cr| cr.total)
            .or(if status == 200 { content_length } else { None });
        if let Some(total) = total_length {
            if let Some(prev) = self.expected_total_length {
                if prev != total {
                    return Err(TimedOrPermanent::Permanent);
                }
            } else {
                self.expected_total_length = Some(total);
            }
        }
        Ok(RangeResponse {
            bytes: out,
            total_length,
        })
    }

    fn bytes_read(&self) -> u64 {
        self.bytes_read
    }

    fn requests_made(&self) -> usize {
        self.requests
    }

    fn remaining_byte_budget(&self) -> u64 {
        MAX_TOTAL_READ_BYTES.saturating_sub(self.bytes_read)
    }
}

#[derive(Clone, Copy)]
struct ContentRange {
    start: Option<u64>,
    #[allow(dead_code)]
    end: Option<u64>,
    total: Option<u64>,
}

fn parse_content_range(value: &str) -> Option<ContentRange> {
    let trimmed = value.trim();
    if !trimmed
        .get(..6)
        .is_some_and(|head| head.eq_ignore_ascii_case("bytes "))
    {
        return None;
    }
    let (range_part, total_part) = trimmed.get(6..)?.split_once('/')?;
    let (s_str, e_str) = range_part.split_once('-')?;
    let start = s_str.trim().parse::<u64>().ok()?;
    let end = e_str.trim().parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    let total_str = total_part.trim();
    let total = if total_str == "*" {
        None
    } else {
        let t = total_str.parse::<u64>().ok()?;
        if end >= t {
            return None;
        }
        Some(t)
    };
    Some(ContentRange {
        start: Some(start),
        end: Some(end),
        total,
    })
}

async fn inspect_container(
    reader: &mut dyn RandomAccessReader,
    allow_local_ffprobe: bool,
) -> Result<InspectResult, TimedOrPermanent> {
    let initial = reader
        .read_range(0, INITIAL_PROBE_BYTES, false, false)
        .await?;

    let Some(segment) = find_segment(&initial.bytes) else {
        return Ok(InspectResult::Outcome(load_mp4_index(reader, &initial).await?));
    };

    let segment_data_start = segment.data_start as u64;
    let direct_positions = find_initial_top_level_positions(&initial.bytes, segment);
    let mut resolved = direct_positions.clone();

    let mut seek_queue: VecDeque<u64> = VecDeque::new();
    if let Some(&pos) = direct_positions.get(&ID_SEEK_HEAD) {
        seek_queue.push_back(pos);
    }
    let mut visited_seek_heads = HashSet::new();
    let mut hops = 0usize;
    while let Some(pos) = seek_queue.pop_front() {
        if hops >= MAX_SEEK_HEAD_HOPS {
            break;
        }
        if !visited_seek_heads.insert(pos) {
            continue;
        }
        hops += 1;
        let bytes = match extract_element_from_probe(&initial.bytes, pos, ID_SEEK_HEAD, MAX_SEEK_HEAD_BYTES) {
            Some(b) => b,
            None => match fetch_element_at(reader, pos, ID_SEEK_HEAD, MAX_SEEK_HEAD_BYTES).await {
                Ok(Some(b)) => b,
                Ok(None) | Err(TimedOrPermanent::Permanent) => continue,
                Err(e @ (TimedOrPermanent::Transient | TimedOrPermanent::Blocked)) => {
                    return Err(e);
                }
            },
        };
        for (id, rel_pos) in parse_seek_head(&bytes) {
            let abs = segment_data_start.saturating_add(rel_pos);
            let inserted = !resolved.contains_key(&id);
            resolved.entry(id).or_insert(abs);
            if id == ID_SEEK_HEAD && (inserted || !visited_seek_heads.contains(&abs)) {
                seek_queue.push_back(abs);
            }
        }
    }

    let timestamp_scale_ns = if let Some(&info_pos) = resolved.get(&ID_INFO).or_else(|| direct_positions.get(&ID_INFO)) {
        let info_bytes = match extract_element_from_probe(&initial.bytes, info_pos, ID_INFO, MAX_INFO_BYTES) {
            Some(b) => Some(b),
            None => match fetch_element_at(reader, info_pos, ID_INFO, MAX_INFO_BYTES).await {
                Ok(b) => b,
                Err(TimedOrPermanent::Permanent) => None,
                Err(e @ (TimedOrPermanent::Transient | TimedOrPermanent::Blocked)) => {
                    return Err(e);
                }
            },
        };
        info_bytes
            .as_deref()
            .map(parse_timestamp_scale_ns)
            .unwrap_or(DEFAULT_TIMESTAMP_SCALE_NS)
    } else {
        DEFAULT_TIMESTAMP_SCALE_NS
    };

    let Some(&tracks_pos) = resolved.get(&ID_TRACKS).or_else(|| direct_positions.get(&ID_TRACKS)) else {
        return Ok(InspectResult::Outcome(ContainerLoadOutcome::NoUsableReference));
    };
    let Some(tracks_bytes) = (match extract_element_from_probe(&initial.bytes, tracks_pos, ID_TRACKS, MAX_TRACKS_BYTES) {
        Some(b) => Some(b),
        None => fetch_element_at(reader, tracks_pos, ID_TRACKS, MAX_TRACKS_BYTES).await?,
    }) else {
        return Ok(InspectResult::Outcome(ContainerLoadOutcome::NoUsableReference));
    };
    let subtitle_tracks = parse_subtitle_tracks(&tracks_bytes);
    if subtitle_tracks.is_empty() {
        return Ok(InspectResult::Outcome(ContainerLoadOutcome::NoSubtitleTracks));
    }

    let cues_pos = resolved.get(&ID_CUES).or_else(|| direct_positions.get(&ID_CUES)).copied();
    let parsed_cues = if let Some(pos) = cues_pos {
        let cues_bytes = match extract_element_from_probe(&initial.bytes, pos, ID_CUES, MAX_CUES_BYTES) {
            Some(b) => Some(b),
            None => match fetch_element_at(reader, pos, ID_CUES, MAX_CUES_BYTES).await {
                Ok(b) => b,
                Err(TimedOrPermanent::Permanent) => None,
                Err(e @ (TimedOrPermanent::Transient | TimedOrPermanent::Blocked)) => {
                    return Err(e);
                }
            },
        };
        cues_bytes.map(|b| parse_subtitle_cue_timelines(&b, &subtitle_tracks, timestamp_scale_ns))
    } else {
        None
    };
    let parsed_cues = match parsed_cues {
        Some(map) => map,
        None => find_and_parse_cues_near_end(
            reader,
            initial.total_length,
            initial.bytes.len() as u64,
            &subtitle_tracks,
            timestamp_scale_ns,
        )
        .await?
        .unwrap_or_default(),
    };

    if subtitle_tracks
        .iter()
        .all(|t| parsed_cues.get(&t.number).is_none_or(|c| c.is_empty()))
    {
        // Local MKV files with text tracks in Tracks but 0 indexed entries in Cues fall back
        // to ffprobe subtitle packet reading outside the EBML probe budget.
        if allow_local_ffprobe {
            return Ok(InspectResult::NeedsLocalFfprobeFallback {
                tracks: subtitle_tracks,
                bytes_read: reader.bytes_read(),
                range_requests: reader.requests_made(),
            });
        }
        return Ok(InspectResult::Outcome(ContainerLoadOutcome::NoUsableReference));
    }

    let mut reference_tracks = Vec::new();
    for track in &subtitle_tracks {
        let Some(raw_cues) = parsed_cues.get(&track.number) else {
            continue;
        };
        let mut sorted = raw_cues.clone();
        sorted.sort_by_key(|c| c.start_ms);
        sorted.dedup_by_key(|c| c.start_ms);

        let cues = if is_matroska_ass_codec(track.codec_id.as_deref()) {
            filter_indexed_ass_dialogue_cues(sorted)
        } else {
            sorted
        };
        if cues.len() < MIN_INDEXED_CUES {
            continue;
        }
        let span_ms = cues.last().unwrap().start_ms - cues.first().unwrap().start_ms;
        if span_ms < MIN_INDEXED_SPAN_MS {
            continue;
        }
        let lang = track
            .language_ietf
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or(track.language.as_deref().filter(|s| !s.trim().is_empty()))
            .map(|s| s.to_string());
        let label = track
            .name
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| build_fallback_track_label(track));
        reference_tracks.push(ReferenceTrack {
            key: format!("mkv-cues:{}", track.number),
            language: lang,
            label: Some(label),
            cues,
            is_forced: track.forced,
            is_commentary: track.commentary,
            is_descriptive: track.visual_impaired || track.text_descriptions,
            is_sdh: track.hearing_impaired,
            sampled: false,
        });
    }

    if reference_tracks.is_empty() {
        if allow_local_ffprobe {
            return Ok(InspectResult::NeedsLocalFfprobeFallback {
                tracks: subtitle_tracks,
                bytes_read: reader.bytes_read(),
                range_requests: reader.requests_made(),
            });
        }
        return Ok(InspectResult::Outcome(ContainerLoadOutcome::NoUsableReference));
    }

    Ok(InspectResult::Outcome(ContainerLoadOutcome::Ready(
        IndexedEmbeddedTimeline {
            tracks: reference_tracks,
            source: "matroska-cues".to_string(),
            no_subtitle_tracks: false,
            bytes_read: reader.bytes_read(),
            range_requests: reader.requests_made(),
        },
    )))
}

async fn load_mp4_index(
    reader: &mut dyn RandomAccessReader,
    initial: &RangeResponse,
) -> Result<ContainerLoadOutcome, TimedOrPermanent> {
    let Some((moov_pos, moov_size)) = find_mp4_moov(reader, initial).await? else {
        return Ok(ContainerLoadOutcome::NoUsableReference);
    };
    if moov_size == 0 || moov_size > MAX_MP4_MOOV_BYTES as u64 {
        return Ok(ContainerLoadOutcome::NoUsableReference);
    }
    let moov_end = moov_pos.saturating_add(moov_size);
    let moov_bytes = if moov_end <= initial.bytes.len() as u64 {
        initial.bytes[moov_pos as usize..moov_end as usize].to_vec()
    } else {
        reader
            .read_range(moov_pos, moov_size as usize, moov_pos > 0, true)
            .await?
            .bytes
    };

    let Some(index) = parse_moov_subtitles(&moov_bytes) else {
        return Ok(ContainerLoadOutcome::NoUsableReference);
    };
    if !index.has_text_tracks {
        return Ok(ContainerLoadOutcome::NoSubtitleTracks);
    }
    let reference_tracks: Vec<ReferenceTrack> = index
        .tables
        .iter()
        .filter_map(build_mp4_reference_track)
        .collect();
    if reference_tracks.is_empty() {
        return Ok(ContainerLoadOutcome::NoUsableReference);
    }
    Ok(ContainerLoadOutcome::Ready(IndexedEmbeddedTimeline {
        tracks: reference_tracks,
        source: "mp4-sample-table".to_string(),
        no_subtitle_tracks: false,
        bytes_read: reader.bytes_read(),
        range_requests: reader.requests_made(),
    }))
}

async fn find_mp4_moov(
    reader: &mut dyn RandomAccessReader,
    initial: &RangeResponse,
) -> Result<Option<(u64, u64)>, TimedOrPermanent> {
    let mut position = 0u64;
    let mut first_box = true;
    for _ in 0..MAX_MP4_TOP_LEVEL_BOXES {
        if let Some(total) = initial.total_length {
            if position >= total {
                return Ok(None);
            }
        }
        let initial_len = initial.bytes.len() as u64;
        let can_use_initial_8 = position.saturating_add(8) <= initial_len && {
            let off = position as usize;
            let size32 = u32::from_be_bytes([
                initial.bytes[off],
                initial.bytes[off + 1],
                initial.bytes[off + 2],
                initial.bytes[off + 3],
            ]);
            size32 != 1 || position.saturating_add(MP4_BOX_HEADER_BYTES as u64) <= initial_len
        };
        let owned_header;
        let (header_bytes, header_offset): (&[u8], usize) = if can_use_initial_8 {
            (&initial.bytes, position as usize)
        } else {
            owned_header = reader
                .read_range(position, MP4_BOX_HEADER_BYTES, position > 0, false)
                .await?
                .bytes;
            (&owned_header, 0)
        };

        let extends_to_end = initial
            .total_length
            .and_then(|t| t.checked_sub(position))
            .filter(|&v| v > 0)
            .unwrap_or(u64::MAX);
        let Some((box_type, size, _hdr_size)) =
            read_mp4_box_header(header_bytes, header_offset, extends_to_end)
        else {
            return Ok(None);
        };
        if first_box {
            if !is_plausible_mp4_top_level(box_type) {
                return Ok(None);
            }
            first_box = false;
        }
        if box_type == MP4_TYPE_MOOV {
            return Ok(Some((position, size)));
        }
        if size == 0 {
            return Ok(None);
        }
        let Some(next) = position.checked_add(size) else {
            return Ok(None);
        };
        position = next;
    }
    Ok(None)
}

fn read_mp4_box_header(bytes: &[u8], offset: usize, extends_to_end: u64) -> Option<(u32, u64, usize)> {
    if offset.checked_add(8)? > bytes.len() {
        return None;
    }
    let size32 = u32::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ]) as u64;
    let box_type = u32::from_be_bytes([
        bytes[offset + 4],
        bytes[offset + 5],
        bytes[offset + 6],
        bytes[offset + 7],
    ]);
    let (size, hdr_size) = match size32 {
        0 => (extends_to_end, 8),
        1 => {
            if offset.checked_add(16)? > bytes.len() {
                return None;
            }
            let high = bytes[offset + 8];
            if (high & 0x80) != 0 {
                return None;
            }
            let sz = u64::from_be_bytes([
                bytes[offset + 8],
                bytes[offset + 9],
                bytes[offset + 10],
                bytes[offset + 11],
                bytes[offset + 12],
                bytes[offset + 13],
                bytes[offset + 14],
                bytes[offset + 15],
            ]);
            (sz, 16)
        }
        other => (other, 8),
    };
    if size < hdr_size as u64 {
        return None;
    }
    Some((box_type, size, hdr_size))
}

fn is_plausible_mp4_top_level(box_type: u32) -> bool {
    matches!(
        &box_type.to_be_bytes(),
        b"ftyp"
            | b"moov"
            | b"mdat"
            | b"free"
            | b"skip"
            | b"wide"
            | b"pnot"
            | b"uuid"
            | b"pdin"
            | b"moof"
            | b"sidx"
            | b"styp"
    )
}

fn build_mp4_reference_track(table: &Mp4SubtitleSampleTable) -> Option<ReferenceTrack> {
    let mut cues = Vec::with_capacity(table.timestamps_us.len());
    for (idx, &start_us) in table.timestamps_us.iter().enumerate() {
        let size = table.sizes[idx];
        let is_empty = match table.codec {
            Mp4SubtitleCodec::Tx3g => size <= 2,
            Mp4SubtitleCodec::Wvtt => size <= 8,
        };
        if is_empty || start_us < 0 {
            continue;
        }
        let next_us = if idx + 1 < table.timestamps_us.len() {
            table.timestamps_us[idx + 1]
        } else {
            table.duration_us
        };
        let end_us = if next_us <= start_us {
            start_us.saturating_add(DEFAULT_MP4_CUE_DURATION_MS * 1_000)
        } else {
            next_us
        };
        let start_ms = start_us / 1_000;
        let end_ms = (end_us / 1_000).max(start_ms + 1);
        cues.push(SubtitleCue::new(start_ms, end_ms, String::new()));
    }
    cues.sort_by_key(|c| c.start_ms);
    cues.dedup_by_key(|c| c.start_ms);
    if cues.len() < MIN_INDEXED_CUES {
        return None;
    }
    if cues.last().unwrap().start_ms - cues.first().unwrap().start_ms < MIN_INDEXED_SPAN_MS {
        return None;
    }
    let language = table
        .language
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string());
    let label = format!("{} [Full]", language.as_deref().unwrap_or("Subtitle"));
    Some(ReferenceTrack {
        key: format!("mp4-samples:{}", table.track_id),
        language,
        label: Some(label),
        cues,
        is_forced: false,
        is_commentary: false,
        is_descriptive: false,
        is_sdh: false,
        sampled: false,
    })
}

async fn cached_ffprobe_path() -> Option<PathBuf> {
    static FFPROBE_PATH: OnceCell<Option<PathBuf>> = OnceCell::const_new();
    FFPROBE_PATH
        .get_or_init(|| async {
            tokio::task::spawn_blocking(crate::transcode::locate_ffprobe)
                .await
                .ok()
                .flatten()
        })
        .await
        .clone()
}

fn select_ffprobe_text_tracks(tracks: &[MatroskaSubtitleTrack]) -> Vec<(usize, MatroskaSubtitleTrack)> {
    let mut candidates: Vec<(usize, MatroskaSubtitleTrack)> = tracks
        .iter()
        .cloned()
        .enumerate()
        .filter(|(_, t)| {
            !t.codec_id.as_deref().is_some_and(|c| {
                let up = c.to_ascii_uppercase();
                up == MATROSKA_PGS_CODEC_ID || up.contains("VOBSUB") || up.contains("PGS")
            })
        })
        .collect();
    candidates.sort_by_key(|(ord, t)| {
        let name_lower = t.name.as_deref().unwrap_or("").to_ascii_lowercase();
        let is_commentary = t.commentary || name_lower.contains("commentary");
        let is_descriptive = t.visual_impaired
            || t.text_descriptions
            || name_lower.contains("audio description")
            || name_lower.contains("descriptive subtitle");
        let is_forced = t.forced
            || name_lower.contains("forced")
            || name_lower.contains("foreign only")
            || name_lower.contains("signs only")
            || name_lower.contains("songs only");
        let tier = if is_commentary || is_descriptive {
            3u8
        } else if is_forced {
            2u8
        } else if t.hearing_impaired {
            1u8
        } else {
            0u8
        };
        (tier, !t.is_default, *ord)
    });
    candidates.truncate(2);
    candidates
}

const MAX_FFPROBE_STDOUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_FFPROBE_CUES_PER_STREAM: usize = 50_000;
const MAX_FFPROBE_STREAM_BUCKETS: usize = 32;

#[derive(Default)]
struct FfprobeCompactAccumulator {
    stream_indices: Vec<u32>,
    packets_by_stream: HashMap<u32, Vec<SubtitleCue>>,
}

impl FfprobeCompactAccumulator {
    fn feed_line(&mut self, line: &str) {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("stream|") {
            if self.stream_indices.len() >= MAX_FFPROBE_STREAM_BUCKETS {
                return;
            }
            for part in rest.split('|') {
                if let Some(idx_str) = part.strip_prefix("index=") {
                    if let Ok(idx) = idx_str.trim().parse::<u32>() {
                        self.stream_indices.push(idx);
                        break;
                    }
                }
            }
            return;
        }

        if let Some(rest) = trimmed.strip_prefix("packet|") {
            let mut stream_index: Option<u32> = None;
            let mut pts_s: Option<f64> = None;
            let mut dur_s: Option<f64> = None;
            for part in rest.split('|') {
                if let Some(v) = part.strip_prefix("stream_index=") {
                    stream_index = v.trim().parse::<u32>().ok();
                } else if let Some(v) = part.strip_prefix("pts_time=") {
                    pts_s = v.trim().parse::<f64>().ok();
                } else if let Some(v) = part.strip_prefix("duration_time=") {
                    dur_s = v.trim().parse::<f64>().ok();
                }
            }
            let (Some(s_idx), Some(pts)) = (stream_index, pts_s) else {
                return;
            };
            if !pts.is_finite() || pts < 0.0 || pts > 3_600_000.0 {
                return;
            }
            if !self.packets_by_stream.contains_key(&s_idx)
                && self.packets_by_stream.len() >= MAX_FFPROBE_STREAM_BUCKETS
            {
                return;
            }
            let bucket = self.packets_by_stream.entry(s_idx).or_default();
            if bucket.len() >= MAX_FFPROBE_CUES_PER_STREAM {
                return;
            }
            let start_ms = (pts * 1_000.0).round() as i64;
            let valid_dur = dur_s.filter(|d| d.is_finite() && *d > 0.0 && *d <= 86_400.0);
            let estimated = valid_dur.is_none();
            let dur_ms = valid_dur
                .map(|d| (d * 1_000.0).round() as i64)
                .unwrap_or(2_500);
            bucket.push(SubtitleCue {
                start_ms,
                end_ms: start_ms.saturating_add(dur_ms.max(1)),
                text: String::new(),
                estimated_end: estimated,
            });
        }
    }

    fn finish(mut self, text_indices: Vec<(usize, MatroskaSubtitleTrack)>) -> Option<Vec<ReferenceTrack>> {
        let mut out = Vec::new();
        for (sub_ordinal, track) in text_indices {
            let Some(&stream_idx) = self.stream_indices.get(sub_ordinal) else {
                continue;
            };
            let Some(mut cues) = self.packets_by_stream.remove(&stream_idx) else {
                continue;
            };
            cues.sort_by_key(|c| c.start_ms);
            cues.dedup_by_key(|c| c.start_ms);
            if is_matroska_ass_codec(track.codec_id.as_deref()) {
                cues = filter_indexed_ass_dialogue_cues(cues);
            }
            if cues.len() >= MIN_INDEXED_CUES
                && cues.last().unwrap().start_ms - cues.first().unwrap().start_ms >= MIN_INDEXED_SPAN_MS
            {
                let lang = track
                    .language_ietf
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .or(track.language.as_deref().filter(|s| !s.trim().is_empty()))
                    .map(|s| s.to_string());
                let label = track
                    .name
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| build_fallback_track_label(&track));
                out.push(ReferenceTrack {
                    key: format!("ffprobe-pkts:{}", track.number),
                    language: lang,
                    label: Some(label),
                    cues,
                    is_forced: track.forced,
                    is_commentary: track.commentary,
                    is_descriptive: track.visual_impaired || track.text_descriptions,
                    is_sdh: track.hearing_impaired,
                    sampled: false,
                });
            }
        }
        if out.is_empty() {
            None
        } else {
            Some(out)
        }
    }
}

async fn ffprobe_single_mkv_text_track(
    ffprobe: &Path,
    local_path: &Path,
    sub_ordinal: usize,
    track: MatroskaSubtitleTrack,
) -> Option<ReferenceTrack> {
    use tokio::io::AsyncBufReadExt as _;

    let select_spec = format!("s:{sub_ordinal}");
    let mut cmd = tokio::process::Command::new(ffprobe);
    cmd.kill_on_drop(true);
    cmd.arg("-v")
        .arg("error")
        .arg("-protocol_whitelist")
        .arg("file")
        .arg("-f")
        .arg("matroska")
        .arg("-select_streams")
        .arg(&select_spec)
        .arg("-show_entries")
        .arg("stream=index:packet=stream_index,pts_time,duration_time")
        .arg("-of")
        .arg("compact=p=1")
        .arg("-i")
        .arg(local_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    crate::proc_guard::configure_command(&mut cmd);

    let mut child = cmd.spawn().ok()?;
    crate::proc_guard::adopt(&child);
    let stdout = child.stdout.take()?;

    let read_res = tokio::time::timeout(FFPROBE_FALLBACK_TIMEOUT, async {
        let mut acc = FfprobeCompactAccumulator::default();
        let mut reader = tokio::io::BufReader::new(stdout).lines();
        let mut total_bytes = 0usize;
        while let Ok(Some(line)) = reader.next_line().await {
            total_bytes = total_bytes.saturating_add(line.len() + 1);
            if total_bytes > MAX_FFPROBE_STDOUT_BYTES {
                drop(reader);
                let _ = child.kill().await;
                let _ = child.wait().await;
                return None;
            }
            acc.feed_line(&line);
        }
        let status = child.wait().await.ok()?;
        if !status.success() {
            return None;
        }
        Some(acc)
    })
    .await;

    let acc = match read_res {
        Ok(Some(a)) => a,
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return None;
        }
    };

    acc.finish(vec![(0, track)]).and_then(|mut v| v.pop())
}

async fn ffprobe_mkv_text_subtitles(
    local_path: &Path,
    tracks: &[MatroskaSubtitleTrack],
) -> Option<Vec<ReferenceTrack>> {
    let ffprobe = cached_ffprobe_path().await?;
    let text_indices = select_ffprobe_text_tracks(tracks);
    if text_indices.is_empty() {
        return None;
    }

    let mut out = Vec::new();
    for (sub_ordinal, track) in text_indices {
        if let Some(ref_track) =
            ffprobe_single_mkv_text_track(&ffprobe, local_path, sub_ordinal, track).await
        {
            out.push(ref_track);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

// ---------- MKV EBML Helpers ----------

#[derive(Clone, Copy)]
struct EbmlElement {
    id: u64,
    size: Option<u64>,
    #[allow(dead_code)]
    header_start: usize,
    data_start: usize,
    header_size: usize,
}

impl EbmlElement {
    fn end_within(self, limit: usize) -> Option<usize> {
        let sz = self.size?;
        let end = (self.data_start as u64).checked_add(sz)?;
        if end > limit as u64 {
            return None;
        }
        usize::try_from(end).ok()
    }
}

#[derive(Clone)]
struct MatroskaSubtitleTrack {
    number: i32,
    name: Option<String>,
    language: Option<String>,
    language_ietf: Option<String>,
    codec_id: Option<String>,
    #[allow(dead_code)]
    is_default: bool,
    forced: bool,
    hearing_impaired: bool,
    visual_impaired: bool,
    text_descriptions: bool,
    commentary: bool,
}

#[derive(Clone, Copy)]
struct PendingCue {
    start_ms: i64,
    explicit_duration_ms: Option<i64>,
}

fn find_segment(bytes: &[u8]) -> Option<EbmlElement> {
    let mut pos = 0usize;
    for _ in 0..32 {
        if pos >= bytes.len() {
            return None;
        }
        let el = read_element(bytes, pos, bytes.len())?;
        if el.id == ID_SEGMENT {
            return Some(el);
        }
        pos = el.end_within(bytes.len())?;
    }
    None
}

fn find_initial_top_level_positions(bytes: &[u8], segment: EbmlElement) -> HashMap<u64, u64> {
    let mut map = HashMap::new();
    let mut pos = segment.data_start;
    for _ in 0..128 {
        if pos >= bytes.len() {
            break;
        }
        let Some(el) = read_element(bytes, pos, bytes.len()) else {
            break;
        };
        match el.id {
            ID_SEEK_HEAD | ID_INFO | ID_TRACKS | ID_CUES => {
                map.entry(el.id).or_insert(pos as u64);
            }
            ID_CLUSTER => break,
            _ => {}
        }
        let Some(end) = el.end_within(bytes.len()) else {
            break;
        };
        if end <= pos {
            break;
        }
        pos = end;
    }
    map
}

fn parse_seek_head(bytes: &[u8]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    let Some(root) = read_element(bytes, 0, bytes.len()) else {
        return out;
    };
    if root.id != ID_SEEK_HEAD {
        return out;
    }
    let Some(root_end) = root.end_within(bytes.len()) else {
        return out;
    };
    for_each_child(bytes, root.data_start, root_end, |seek| {
        if seek.id != ID_SEEK {
            return;
        }
        let Some(seek_end) = seek.end_within(root_end) else {
            return;
        };
        let mut target_id = None;
        let mut rel_pos = None;
        for_each_child(bytes, seek.data_start, seek_end, |child| match child.id {
            ID_SEEK_ID => target_id = read_binary_id(bytes, child),
            ID_SEEK_POSITION => rel_pos = read_unsigned(bytes, child),
            _ => {}
        });
        if let (Some(id), Some(pos)) = (target_id, rel_pos) {
            out.push((id, pos));
        }
    });
    out
}

fn parse_timestamp_scale_ns(bytes: &[u8]) -> u64 {
    let Some(root) = read_element(bytes, 0, bytes.len()) else {
        return DEFAULT_TIMESTAMP_SCALE_NS;
    };
    if root.id != ID_INFO {
        return DEFAULT_TIMESTAMP_SCALE_NS;
    }
    let Some(root_end) = root.end_within(bytes.len()) else {
        return DEFAULT_TIMESTAMP_SCALE_NS;
    };
    let mut scale = DEFAULT_TIMESTAMP_SCALE_NS;
    for_each_child(bytes, root.data_start, root_end, |child| {
        if child.id == ID_TIMESTAMP_SCALE {
            if let Some(v) = read_unsigned(bytes, child).filter(|&v| v > 0) {
                scale = v;
            }
        }
    });
    scale
}

fn parse_subtitle_tracks(bytes: &[u8]) -> Vec<MatroskaSubtitleTrack> {
    let mut out = Vec::new();
    let Some(root) = read_element(bytes, 0, bytes.len()) else {
        return out;
    };
    if root.id != ID_TRACKS {
        return out;
    }
    let Some(root_end) = root.end_within(bytes.len()) else {
        return out;
    };
    for_each_child(bytes, root.data_start, root_end, |entry| {
        if entry.id != ID_TRACK_ENTRY {
            return;
        }
        let Some(entry_end) = entry.end_within(root_end) else {
            return;
        };
        let mut number = None;
        let mut track_type = None;
        let mut name = None;
        let mut language = None;
        let mut language_ietf = None;
        let mut codec_id = None;
        let mut is_default = true;
        let mut forced = false;
        let mut hearing_impaired = false;
        let mut visual_impaired = false;
        let mut text_descriptions = false;
        let mut commentary = false;

        for_each_child(bytes, entry.data_start, entry_end, |child| match child.id {
            ID_TRACK_NUMBER => number = read_unsigned(bytes, child).and_then(|v| i32::try_from(v).ok()),
            ID_TRACK_TYPE => track_type = read_unsigned(bytes, child),
            ID_NAME => name = read_utf8(bytes, child),
            ID_LANGUAGE => language = read_utf8(bytes, child),
            ID_LANGUAGE_IETF => language_ietf = read_utf8(bytes, child),
            ID_CODEC_ID => codec_id = read_utf8(bytes, child),
            ID_FLAG_DEFAULT => is_default = read_unsigned(bytes, child) != Some(0),
            ID_FLAG_FORCED => forced = read_unsigned(bytes, child) == Some(1),
            ID_FLAG_HEARING_IMPAIRED => hearing_impaired = read_unsigned(bytes, child) == Some(1),
            ID_FLAG_VISUAL_IMPAIRED => visual_impaired = read_unsigned(bytes, child) == Some(1),
            ID_FLAG_TEXT_DESCRIPTIONS => text_descriptions = read_unsigned(bytes, child) == Some(1),
            ID_FLAG_COMMENTARY => commentary = read_unsigned(bytes, child) == Some(1),
            _ => {}
        });

        if let (Some(num), Some(TRACK_TYPE_SUBTITLE)) = (number, track_type) {
            out.push(MatroskaSubtitleTrack {
                number: num,
                name,
                language,
                language_ietf,
                codec_id,
                is_default,
                forced,
                hearing_impaired,
                visual_impaired,
                text_descriptions,
                commentary,
            });
        }
    });
    out
}

fn parse_subtitle_cue_timelines(
    cues_bytes: &[u8],
    subtitle_tracks: &[MatroskaSubtitleTrack],
    timestamp_scale_ns: u64,
) -> HashMap<i32, Vec<SubtitleCue>> {
    let Some(root) = read_element(cues_bytes, 0, cues_bytes.len()) else {
        return HashMap::new();
    };
    if root.id != ID_CUES {
        return HashMap::new();
    }
    let Some(root_end) = root.end_within(cues_bytes.len()) else {
        return HashMap::new();
    };
    let track_nums: HashSet<i32> = subtitle_tracks.iter().map(|t| t.number).collect();
    let mut pending_by_track: HashMap<i32, Vec<PendingCue>> =
        track_nums.iter().map(|&n| (n, Vec::new())).collect();

    for_each_child(cues_bytes, root.data_start, root_end, |cue_point| {
        if cue_point.id != ID_CUE_POINT {
            return;
        }
        let Some(point_end) = cue_point.end_within(root_end) else {
            return;
        };
        let mut cue_time_ticks = None;
        let mut positions: Vec<(i32, Option<u64>)> = Vec::new();
        for_each_child(cues_bytes, cue_point.data_start, point_end, |child| match child.id {
            ID_CUE_TIME => cue_time_ticks = read_unsigned(cues_bytes, child),
            ID_CUE_TRACK_POSITIONS => {
                if let Some(pos_end) = child.end_within(point_end) {
                    let mut trk = None;
                    let mut dur = None;
                    for_each_child(cues_bytes, child.data_start, pos_end, |p_child| match p_child.id {
                        ID_CUE_TRACK => trk = read_unsigned(cues_bytes, p_child).and_then(|v| i32::try_from(v).ok()),
                        ID_CUE_DURATION => dur = read_unsigned(cues_bytes, p_child),
                        _ => {}
                    });
                    if let Some(t) = trk {
                        positions.push((t, dur));
                    }
                }
            }
            _ => {}
        });

        let Some(time_ticks) = cue_time_ticks else {
            return;
        };
        let Some(start_ms) = ticks_to_ms(time_ticks, timestamp_scale_ns) else {
            return;
        };
        for (trk, dur_ticks) in positions {
            if !track_nums.contains(&trk) {
                continue;
            }
            let explicit_duration_ms = dur_ticks
                .and_then(|d| ticks_to_ms(d, timestamp_scale_ns))
                .filter(|&d| d > 0);
            if let Some(list) = pending_by_track.get_mut(&trk) {
                list.push(PendingCue {
                    start_ms,
                    explicit_duration_ms,
                });
            }
        }
    });

    for list in pending_by_track.values_mut() {
        list.sort_by_key(|c| c.start_ms);
        list.dedup_by_key(|c| c.start_ms);
    }

    let mut peer_counts: Vec<usize> = subtitle_tracks
        .iter()
        .filter(|t| {
            !t.codec_id
                .as_deref()
                .is_some_and(|c| c.eq_ignore_ascii_case(MATROSKA_PGS_CODEC_ID))
                && !t.forced
                && !t.commentary
        })
        .filter_map(|t| pending_by_track.get(&t.number).map(|v| v.len()).filter(|&n| n >= MIN_INDEXED_CUES))
        .collect();
    peer_counts.sort_unstable();
    let peer_dialogue_count = if peer_counts.is_empty() {
        None
    } else {
        Some(peer_counts[peer_counts.len() / 2])
    };

    let tracks_by_num: HashMap<i32, &MatroskaSubtitleTrack> =
        subtitle_tracks.iter().map(|t| (t.number, t)).collect();
    let mut out = HashMap::new();
    for (trk_num, pending) in pending_by_track {
        let is_pgs = tracks_by_num
            .get(&trk_num)
            .and_then(|t| t.codec_id.as_deref())
            .is_some_and(|c| c.eq_ignore_ascii_case(MATROSKA_PGS_CODEC_ID));
        let timeline = if is_pgs {
            build_pgs_indexed_timeline(&pending, peer_dialogue_count)
        } else {
            build_default_indexed_timeline(&pending)
        };
        out.insert(trk_num, timeline);
    }
    out
}

fn build_pgs_indexed_timeline(
    sorted: &[PendingCue],
    peer_dialogue_cue_count: Option<usize>,
) -> Vec<SubtitleCue> {
    if sorted.len() < 2 {
        return Vec::new();
    }
    let paired_count = sorted.len() / 2;
    let explicit_dur_count = sorted
        .iter()
        .filter(|c| c.explicit_duration_ms.unwrap_or(0) > 0)
        .count();
    let should_pair = if let Some(peer) = peer_dialogue_cue_count {
        let raw_delta = sorted.len().abs_diff(peer) as u64;
        let paired_delta = paired_count.abs_diff(peer) as u64;
        paired_delta * 3 <= raw_delta * 2
    } else {
        (explicit_dur_count as u64) * 4 < (sorted.len() as u64) * 3
    };

    if !should_pair {
        return build_default_indexed_timeline(sorted);
    }

    let mut cues = Vec::with_capacity(paired_count);
    let mut idx = 0usize;
    while idx + 1 < sorted.len() {
        let display = sorted[idx];
        let clear = sorted[idx + 1];
        if clear.start_ms > display.start_ms {
            let explicit_end = display
                .explicit_duration_ms
                .and_then(|d| display.start_ms.checked_add(d));
            let end_ms = explicit_end.map(|e| e.min(clear.start_ms)).unwrap_or(clear.start_ms);
            if end_ms > display.start_ms {
                cues.push(SubtitleCue::new(display.start_ms, end_ms, String::new()));
            }
        }
        idx += 2;
    }
    cues
}

fn build_default_indexed_timeline(sorted: &[PendingCue]) -> Vec<SubtitleCue> {
    sorted
        .iter()
        .enumerate()
        .map(|(idx, cue)| {
            let (dur, estimated) = match cue.explicit_duration_ms {
                Some(d) => (d, false),
                None => {
                    let est = match sorted.get(idx + 1) {
                        Some(next) if next.start_ms > cue.start_ms => (next.start_ms - cue.start_ms)
                            .min(MAX_MKV_INTER_CUE_ESTIMATED_DURATION_MS)
                            .max(1),
                        _ => LAST_MKV_CUE_ESTIMATED_DURATION_MS,
                    };
                    (est, true)
                }
            };
            SubtitleCue {
                start_ms: cue.start_ms,
                end_ms: cue.start_ms.saturating_add(dur),
                text: String::new(),
                estimated_end: estimated,
            }
        })
        .collect()
}

fn is_matroska_ass_codec(codec_id: Option<&str>) -> bool {
    codec_id.is_some_and(|c| {
        c.eq_ignore_ascii_case(MATROSKA_ASS_CODEC_ID)
            || c.eq_ignore_ascii_case(MATROSKA_SSA_CODEC_ID)
    })
}

fn build_fallback_track_label(track: &MatroskaSubtitleTrack) -> String {
    let lang = track
        .language_ietf
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or(track.language.as_deref().filter(|s| !s.trim().is_empty()))
        .unwrap_or("Subtitle");
    let suffix = if track.commentary {
        " [Commentary]"
    } else if track.forced {
        " [Forced]"
    } else if track.hearing_impaired {
        " [SDH]"
    } else {
        " [Full]"
    };
    format!("{lang}{suffix}")
}

fn ticks_to_ms(ticks: u64, timestamp_scale_ns: u64) -> Option<i64> {
    if timestamp_scale_ns == 0 {
        return None;
    }
    let ms = ((ticks as u128) * (timestamp_scale_ns as u128)) / 1_000_000;
    i64::try_from(ms).ok()
}

fn extract_element_from_probe(
    initial: &[u8],
    abs_pos: u64,
    expected_id: u64,
    max_bytes: usize,
) -> Option<Vec<u8>> {
    let start = usize::try_from(abs_pos).ok()?;
    if start >= initial.len() {
        return None;
    }
    let header = read_element(initial, start, initial.len())?;
    if header.id != expected_id {
        return None;
    }
    let total_size = (header.header_size as u64).checked_add(header.size?)?;
    if total_size == 0 || total_size > max_bytes as u64 {
        return None;
    }
    let end = start.checked_add(usize::try_from(total_size).ok()?)?;
    if end > initial.len() {
        return None;
    }
    Some(initial[start..end].to_vec())
}

async fn fetch_element_at(
    reader: &mut dyn RandomAccessReader,
    abs_pos: u64,
    expected_id: u64,
    max_bytes: usize,
) -> Result<Option<Vec<u8>>, TimedOrPermanent> {
    let probe = reader
        .read_range(abs_pos, HEADER_PROBE_BYTES, abs_pos > 0, false)
        .await?;
    let Some(header) = read_element(&probe.bytes, 0, probe.bytes.len()) else {
        return Ok(None);
    };
    if header.id != expected_id {
        return Ok(None);
    }
    let Some(sz) = header.size else {
        return Ok(None);
    };
    let Some(total) = (header.header_size as u64).checked_add(sz) else {
        return Ok(None);
    };
    if total == 0 || total > max_bytes as u64 || total > reader.remaining_byte_budget() {
        return Ok(None);
    }
    let total_usize = usize::try_from(total).map_err(|_| TimedOrPermanent::Permanent)?;
    if total_usize <= probe.bytes.len() {
        return Ok(Some(probe.bytes[..total_usize].to_vec()));
    }
    Ok(Some(
        reader
            .read_range(abs_pos, total_usize, abs_pos > 0, true)
            .await?
            .bytes,
    ))
}

async fn find_and_parse_cues_near_end(
    reader: &mut dyn RandomAccessReader,
    total_length: Option<u64>,
    initial_probe_len: u64,
    subtitle_tracks: &[MatroskaSubtitleTrack],
    timestamp_scale_ns: u64,
) -> Result<Option<HashMap<i32, Vec<SubtitleCue>>>, TimedOrPermanent> {
    let Some(file_len) = total_length.filter(|&l| l > 0) else {
        return Ok(None);
    };
    if file_len <= initial_probe_len {
        return Ok(None);
    }
    let start = file_len
        .saturating_sub(TAIL_PROBE_BYTES as u64)
        .max(initial_probe_len.saturating_sub(HEADER_PROBE_BYTES as u64));
    let tail_len = (file_len - start).min(TAIL_PROBE_BYTES as u64) as usize;
    let tail = reader.read_range(start, tail_len, true, false).await?;
    let mut offsets = find_element_id_offsets(&tail.bytes, ID_CUES);
    offsets.reverse();
    const MAX_TAIL_CUES_ATTEMPTS: usize = 32;
    for rel_offset in offsets.into_iter().take(MAX_TAIL_CUES_ATTEMPTS) {
        let cues_slice: Option<&[u8]> = read_element(&tail.bytes, rel_offset, tail.bytes.len())
            .filter(|el| el.id == ID_CUES)
            .and_then(|el| {
                let total_size = (el.header_size as u64).checked_add(el.size?)?;
                if total_size == 0 || total_size > MAX_CUES_BYTES as u64 {
                    return None;
                }
                let end = rel_offset.checked_add(usize::try_from(total_size).ok()?)?;
                if end > tail.bytes.len() {
                    return None;
                }
                Some(&tail.bytes[rel_offset..end])
            });
        let owned_cues;
        let cues_bytes: Option<&[u8]> = if let Some(slice) = cues_slice {
            Some(slice)
        } else {
            if start.saturating_add(tail.bytes.len() as u64) >= file_len {
                continue;
            }
            let abs = start + rel_offset as u64;
            match fetch_element_at(reader, abs, ID_CUES, MAX_CUES_BYTES).await {
                Ok(b) => {
                    owned_cues = b;
                    owned_cues.as_deref()
                }
                Err(TimedOrPermanent::Permanent) => continue,
                Err(e @ (TimedOrPermanent::Transient | TimedOrPermanent::Blocked)) => {
                    return Err(e);
                }
            }
        };
        if let Some(cues_bytes) = cues_bytes {
            let parsed =
                parse_subtitle_cue_timelines(cues_bytes, subtitle_tracks, timestamp_scale_ns);
            if parsed.values().any(|c| c.len() >= MIN_INDEXED_CUES) {
                return Ok(Some(parsed));
            }
        }
    }
    Ok(None)
}

fn find_element_id_offsets(bytes: &[u8], id: u64) -> Vec<usize> {
    let id_bytes = element_id_bytes(id);
    if id_bytes.is_empty() || bytes.len() < id_bytes.len() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for idx in 0..=(bytes.len() - id_bytes.len()) {
        if bytes[idx..idx + id_bytes.len()] == id_bytes[..] {
            if let Some(el) = read_element(bytes, idx, bytes.len()) {
                if el.id == id && el.size.is_some() {
                    out.push(idx);
                }
            }
        }
    }
    out
}

fn element_id_bytes(id: u64) -> Vec<u8> {
    let mut len = 1usize;
    while len < 8 && id >= (1u64 << (len * 8)) {
        len += 1;
    }
    (0..len)
        .map(|i| ((id >> ((len - i - 1) * 8)) & 0xff) as u8)
        .collect()
}

fn for_each_child<F: FnMut(EbmlElement)>(bytes: &[u8], start: usize, end_excl: usize, mut action: F) {
    let mut pos = start;
    for _ in 0..1_000_000 {
        if pos >= end_excl {
            break;
        }
        let Some(child) = read_element(bytes, pos, end_excl) else {
            break;
        };
        let Some(end) = child.end_within(end_excl) else {
            break;
        };
        action(child);
        if end <= pos {
            break;
        }
        pos = end;
    }
}

fn read_element(bytes: &[u8], offset: usize, limit: usize) -> Option<EbmlElement> {
    if offset >= limit || limit > bytes.len() {
        return None;
    }
    let id_len = vint_length(bytes[offset])?;
    if id_len > 4 || offset + id_len >= limit {
        return None;
    }
    let mut id = 0u64;
    for &b in &bytes[offset..offset + id_len] {
        id = (id << 8) | u64::from(b);
    }
    let size_offset = offset + id_len;
    let size_len = vint_length(bytes[size_offset])?;
    if size_len > 8 || size_offset + size_len > limit {
        return None;
    }
    let marker_mask = 1u8 << (8 - size_len);
    let mut size_val = u64::from(bytes[size_offset] & (marker_mask - 1));
    for &b in &bytes[size_offset + 1..size_offset + size_len] {
        size_val = (size_val << 8) | u64::from(b);
    }
    let unknown_val = (1u64 << (7 * size_len)) - 1;
    let size = if size_val == unknown_val {
        None
    } else {
        Some(size_val)
    };
    let data_start = size_offset + size_len;
    Some(EbmlElement {
        id,
        size,
        header_start: offset,
        data_start,
        header_size: data_start - offset,
    })
}

fn vint_length(first_byte: u8) -> Option<usize> {
    if first_byte == 0 {
        return None;
    }
    let mut mask = 0x80u8;
    let mut len = 1usize;
    while (first_byte & mask) == 0 {
        mask >>= 1;
        len += 1;
        if len > 8 {
            return None;
        }
    }
    Some(len)
}

fn read_unsigned(bytes: &[u8], el: EbmlElement) -> Option<u64> {
    let sz = el.size?;
    if sz > 8 {
        return None;
    }
    if sz == 0 {
        return Some(0);
    }
    let end = el.data_start.checked_add(sz as usize)?;
    if end > bytes.len() {
        return None;
    }
    let mut val = 0u64;
    for &b in &bytes[el.data_start..end] {
        val = (val << 8) | u64::from(b);
    }
    Some(val)
}

fn read_binary_id(bytes: &[u8], el: EbmlElement) -> Option<u64> {
    let sz = el.size?;
    if !(1..=4).contains(&sz) {
        return None;
    }
    let end = el.data_start.checked_add(sz as usize)?;
    if end > bytes.len() {
        return None;
    }
    let mut val = 0u64;
    for &b in &bytes[el.data_start..end] {
        val = (val << 8) | u64::from(b);
    }
    Some(val)
}

fn read_utf8(bytes: &[u8], el: EbmlElement) -> Option<String> {
    let sz = el.size?;
    let len = usize::try_from(sz).ok()?;
    let end = el.data_start.checked_add(len)?;
    if end > bytes.len() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&bytes[el.data_start..end])
            .trim_end_matches('\0')
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ebml_vint_size(val: usize) -> Vec<u8> {
        if val < 0x7f {
            vec![0x80 | (val as u8)]
        } else if val < 0x3fff {
            let v = 0x4000 | (val as u16);
            v.to_be_bytes().to_vec()
        } else {
            let v = 0x1000_0000 | (val as u32);
            v.to_be_bytes().to_vec()
        }
    }

    fn ebml_el(id: u64, payload: &[u8]) -> Vec<u8> {
        let mut out = element_id_bytes(id);
        out.extend_from_slice(&ebml_vint_size(payload.len()));
        out.extend_from_slice(payload);
        out
    }

    fn ebml_uint(id: u64, val: u64) -> Vec<u8> {
        let bytes = val.to_be_bytes();
        let first_nz = bytes.iter().position(|&b| b != 0).unwrap_or(7);
        ebml_el(id, &bytes[first_nz..])
    }

    fn build_synthetic_mkv(with_duration: bool, tail_cues: bool) -> Vec<u8> {
        let ebml_hdr = ebml_el(ID_EBML, &ebml_uint(0x4286, 1));
        let info = ebml_el(ID_INFO, &ebml_uint(ID_TIMESTAMP_SCALE, 1_000_000));

        let mut trk_entry_body = Vec::new();
        trk_entry_body.extend_from_slice(&ebml_uint(ID_TRACK_NUMBER, 3));
        trk_entry_body.extend_from_slice(&ebml_uint(ID_TRACK_TYPE, TRACK_TYPE_SUBTITLE));
        trk_entry_body.extend_from_slice(&ebml_el(ID_LANGUAGE_IETF, b"en"));
        trk_entry_body.extend_from_slice(&ebml_el(ID_CODEC_ID, b"S_TEXT/UTF8"));
        let tracks = ebml_el(ID_TRACKS, &ebml_el(ID_TRACK_ENTRY, &trk_entry_body));

        let mut cues_body = Vec::new();
        for i in 0..16u64 {
            let mut pos_body = Vec::new();
            pos_body.extend_from_slice(&ebml_uint(ID_CUE_TRACK, 3));
            if with_duration {
                pos_body.extend_from_slice(&ebml_uint(ID_CUE_DURATION, 1_500));
            }
            let mut pt_body = Vec::new();
            pt_body.extend_from_slice(&ebml_uint(ID_CUE_TIME, i * 3_000 + 1_000));
            pt_body.extend_from_slice(&ebml_el(ID_CUE_TRACK_POSITIONS, &pos_body));
            cues_body.extend_from_slice(&ebml_el(ID_CUE_POINT, &pt_body));
        }
        let cues = ebml_el(ID_CUES, &cues_body);

        let mut seg_body = Vec::new();
        seg_body.extend_from_slice(&info);
        seg_body.extend_from_slice(&tracks);
        if tail_cues {
            // Padding > INITIAL_PROBE_BYTES (512 KiB) so Cues sits at file tail beyond SeekHead
            let filler = vec![0u8; 600 * 1024];
            seg_body.extend_from_slice(&ebml_el(ID_CLUSTER, &filler));
        }
        seg_body.extend_from_slice(&cues);

        let mut full = Vec::new();
        full.extend_from_slice(&ebml_hdr);
        full.extend_from_slice(&ebml_el(ID_SEGMENT, &seg_body));
        full
    }

    #[tokio::test]
    async fn parses_local_mkv_cues_with_and_without_durations_and_tail_scan() {
        let dir = std::env::temp_dir().join(format!("harbor-mkv-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let p1 = dir.join("head.mkv");
        std::fs::write(&p1, build_synthetic_mkv(true, false)).unwrap();
        let out1 = load_embedded_timeline(p1.to_str().unwrap(), &HashMap::new()).await;
        match out1 {
            ContainerLoadOutcome::Ready(tl) => {
                assert_eq!(tl.source, "matroska-cues");
                assert_eq!(tl.tracks.len(), 1);
                assert_eq!(tl.tracks[0].cues.len(), 16);
                assert_eq!(tl.tracks[0].cues[0].start_ms, 1_000);
                assert_eq!(tl.tracks[0].cues[0].end_ms, 2_500);
                assert!(!tl.tracks[0].cues[0].estimated_end);
            }
            other => panic!("unexpected outcome: {:?}", other),
        }

        let p2 = dir.join("tail_no_dur.mkv");
        std::fs::write(&p2, build_synthetic_mkv(false, true)).unwrap();
        let out2 = load_embedded_timeline(p2.to_str().unwrap(), &HashMap::new()).await;
        match out2 {
            ContainerLoadOutcome::Ready(tl) => {
                assert_eq!(tl.tracks[0].cues.len(), 16);
                assert!(tl.tracks[0].cues[0].estimated_end);
                assert_eq!(tl.tracks[0].cues[0].start_ms, 1_000);
                assert_eq!(tl.tracks[0].cues[0].end_ms, 4_000);
            }
            other => panic!("unexpected tail outcome: {:?}", other),
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pgs_pairing_combines_display_and_clear_packets() {
        let mut pts = Vec::new();
        for i in 0..10 {
            pts.push(PendingCue {
                start_ms: i * 4_000 + 1_000,
                explicit_duration_ms: None,
            });
            pts.push(PendingCue {
                start_ms: i * 4_000 + 2_400,
                explicit_duration_ms: None,
            });
        }
        let paired = build_pgs_indexed_timeline(&pts, Some(10));
        assert_eq!(paired.len(), 10);
        assert_eq!(paired[0].start_ms, 1_000);
        assert_eq!(paired[0].end_ms, 2_400);
    }

    #[test]
    fn make_cache_key_delimiters_cannot_collide() {
        let k1 = make_cache_key("http://a|b=c", &HashMap::new());
        let mut h2 = HashMap::new();
        h2.insert("b".to_string(), "c".to_string());
        let k2 = make_cache_key("http://a", &h2);
        assert_ne!(k1, k2);
    }

    #[tokio::test]
    async fn tail_cues_recovers_after_false_positive_id_cues_bytes() {
        let mut bytes = build_synthetic_mkv(true, true);
        // Append false-positive ID_CUES bytes with an absurd size AFTER the real Cues element
        // so reverse offset scan encounters the false positive first.
        bytes.extend_from_slice(&element_id_bytes(ID_CUES));
        bytes.extend_from_slice(&[0x1F, 0xFF, 0xFF, 0xFF]);

        let dir = std::env::temp_dir().join(format!("harbor-mkv-fp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("false_pos.mkv");
        std::fs::write(&path, bytes).unwrap();

        match load_embedded_timeline(path.to_str().unwrap(), &HashMap::new()).await {
            ContainerLoadOutcome::Ready(tl) => {
                assert_eq!(tl.tracks.len(), 1);
                assert_eq!(tl.tracks[0].cues.len(), 16);
            }
            other => panic!("expected tail Cues recovery, got {:?}", other),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn http_range_reader_strips_headers_cross_origin_and_blocks_ssrf_redirects() {
        use axum::{extract::Request, http::HeaderMap, routing::get, Router};
        use std::sync::{Arc, Mutex as StdMutex};

        let mkv = Arc::new(build_synthetic_mkv(true, false));
        let seen_auth = Arc::new(StdMutex::new(Vec::<Option<String>>::new()));
        let mkv_c = mkv.clone();
        let seen_c = seen_auth.clone();

        let target_router = Router::new().route(
            "/video.mkv",
            get(move |headers: HeaderMap| {
                let data = mkv_c.clone();
                let seen = seen_c.clone();
                async move {
                    let auth = headers
                        .get("authorization")
                        .and_then(|v| v.to_str().ok())
                        .map(|s| s.to_string());
                    seen.lock().unwrap().push(auth);
                    let total = data.len();
                    let range = headers
                        .get("range")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("bytes=0-1023");
                    let spec = range.trim_start_matches("bytes=");
                    let (s_str, e_str) = spec.split_once('-').unwrap_or(("0", ""));
                    let start = s_str.parse::<usize>().unwrap_or(0).min(total.saturating_sub(1));
                    let end = e_str
                        .parse::<usize>()
                        .unwrap_or(total - 1)
                        .min(total - 1);
                    let slice = data[start..=end].to_vec();
                    let content_range = format!("bytes {start}-{end}/{total}");
                    (
                        axum::http::StatusCode::PARTIAL_CONTENT,
                        [("content-range", content_range)],
                        slice,
                    )
                }
            }),
        );
        let t_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let t_url = format!("http://{}", t_listener.local_addr().unwrap());
        let t_task = tokio::spawn(async move { axum::serve(t_listener, target_router).await.unwrap() });

        let dest = format!("{t_url}/video.mkv");
        let redir_router = Router::new()
            .route(
                "/start",
                get(move |_req: Request| {
                    let loc = dest.clone();
                    async move { (axum::http::StatusCode::FOUND, [("location", loc)]) }
                }),
            )
            .route(
                "/ssrf",
                get(|| async {
                    (
                        axum::http::StatusCode::FOUND,
                        [("location", "http://169.254.169.254/latest/meta-data/")],
                    )
                }),
            );
        let r_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let r_url = format!("http://{}", r_listener.local_addr().unwrap());
        let r_task = tokio::spawn(async move { axum::serve(r_listener, redir_router).await.unwrap() });

        let mut hdrs = HashMap::new();
        hdrs.insert("Authorization".to_string(), "Bearer top-secret".to_string());
        let out = load_embedded_timeline(&format!("{r_url}/start"), &hdrs).await;
        match out {
            ContainerLoadOutcome::Ready(tl) => assert_eq!(tl.tracks[0].cues.len(), 16),
            other => panic!("expected Ready, got {:?}", other),
        }
        let captured = seen_auth.lock().unwrap().clone();
        assert!(!captured.is_empty());
        assert!(captured.iter().all(|v| v.is_none()));

        let mut reader = HttpRangeReader::new(format!("{r_url}/ssrf"), HashMap::new()).unwrap();
        let ssrf_res = reader.read_range(0, 128, false, false).await;
        assert!(matches!(ssrf_res, Err(TimedOrPermanent::Blocked)));

        t_task.abort();
        r_task.abort();
    }

    #[tokio::test]
    async fn cancelling_in_flight_caller_does_not_poison_second_caller() {
        use axum::{routing::get, Router};
        use std::sync::Arc;

        let mkv = Arc::new(build_synthetic_mkv(true, false));
        let mkv_c = mkv.clone();
        let router = Router::new().route(
            "/slow.mkv",
            get(move || {
                let data = mkv_c.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(80)).await;
                    let len = data.len();
                    (
                        axum::http::StatusCode::PARTIAL_CONTENT,
                        [("content-range", format!("bytes 0-{}/{}", len - 1, len))],
                        (*data).clone(),
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/slow.mkv", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let url1 = url.clone();
        let first = tokio::time::timeout(
            Duration::from_millis(15),
            load_embedded_timeline(&url1, &HashMap::new()),
        )
        .await;
        assert!(first.is_err());

        let second = load_embedded_timeline(&url, &HashMap::new()).await;
        assert!(matches!(second, ContainerLoadOutcome::Ready(_)));
        let key = make_cache_key(&url, &HashMap::new());
        assert!(!cache_state().lock().unwrap().in_flight.contains_key(&key));

        task.abort();
    }

    #[tokio::test]
    async fn cache_hit_promotes_key_to_mru_tail() {
        let mut guard = CacheState {
            entries: HashMap::new(),
            order: VecDeque::new(),
            in_flight: HashMap::new(),
        };
        let dummy = IndexedEmbeddedTimeline {
            tracks: Vec::new(),
            source: "test".to_string(),
            no_subtitle_tracks: false,
            bytes_read: 0,
            range_requests: 0,
        };
        insert_lru(&mut guard, "a".to_string(), CachedEntry::Positive(dummy.clone()));
        insert_lru(&mut guard, "b".to_string(), CachedEntry::Positive(dummy.clone()));
        touch_lru(&mut guard, "a");
        insert_lru(&mut guard, "c".to_string(), CachedEntry::Positive(dummy));
        assert!(guard.entries.contains_key("a"));
        assert!(!guard.entries.contains_key("b"));
        assert!(guard.entries.contains_key("c"));

        // Ensure ffprobe selection skips forced/commentary/bitmap tracks when full dialogue exists.
        let tracks = vec![
            MatroskaSubtitleTrack {
                number: 1,
                name: Some("English (Forced)".to_string()),
                language: Some("eng".to_string()),
                language_ietf: None,
                codec_id: Some("S_TEXT/UTF8".to_string()),
                is_default: true,
                forced: true,
                hearing_impaired: false,
                visual_impaired: false,
                text_descriptions: false,
                commentary: false,
            },
            MatroskaSubtitleTrack {
                number: 2,
                name: Some("Director Commentary".to_string()),
                language: Some("eng".to_string()),
                language_ietf: None,
                codec_id: Some("S_TEXT/UTF8".to_string()),
                is_default: false,
                forced: false,
                hearing_impaired: false,
                visual_impaired: false,
                text_descriptions: false,
                commentary: true,
            },
            MatroskaSubtitleTrack {
                number: 3,
                name: Some("English".to_string()),
                language: Some("eng".to_string()),
                language_ietf: None,
                codec_id: Some("S_TEXT/ASS".to_string()),
                is_default: false,
                forced: false,
                hearing_impaired: false,
                visual_impaired: false,
                text_descriptions: false,
                commentary: false,
            },
        ];
        let picked = select_ffprobe_text_tracks(&tracks);
        assert_eq!(picked[0].0, 2);
        assert_eq!(picked[0].1.number, 3);
        assert_eq!(picked[1].0, 0);
        assert_eq!(picked[1].1.number, 1);

        // Non-exact range read clamps to remaining byte budget instead of failing.
        let bytes = vec![b'X'; 64];
        let dir = std::env::temp_dir().join(format!("harbor-range-clamp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file_path = dir.join("small.bin");
        std::fs::write(&file_path, &bytes).unwrap();
        let mut reader = LocalSourceReader::open(file_path).await.unwrap();
        let got = reader.read_range(0, 128, false, false).await.unwrap();
        assert_eq!(got.bytes.len(), 64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn transient_http_429_and_503_are_unavailable_and_never_negatively_cached() {
        use axum::{http::StatusCode, routing::get, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let mkv = Arc::new(build_synthetic_mkv(true, false));
        let hits = Arc::new(AtomicUsize::new(0));
        let mkv_c = mkv.clone();
        let hits_c = hits.clone();

        let router = Router::new().route(
            "/flaky.mkv",
            get(move || {
                use axum::response::IntoResponse;
                let n = hits_c.fetch_add(1, Ordering::SeqCst);
                let data = mkv_c.clone();
                async move {
                    if n == 0 {
                        return (StatusCode::TOO_MANY_REQUESTS, Vec::<u8>::new()).into_response();
                    }
                    if n == 1 {
                        return (StatusCode::SERVICE_UNAVAILABLE, Vec::<u8>::new()).into_response();
                    }
                    let len = data.len();
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [("content-range", format!("bytes 0-{}/{}", len - 1, len))],
                        (*data).clone(),
                    )
                        .into_response()
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/flaky.mkv", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let first = load_embedded_timeline(&url, &HashMap::new()).await;
        assert!(matches!(first, ContainerLoadOutcome::Unavailable));

        let second = load_embedded_timeline(&url, &HashMap::new()).await;
        assert!(matches!(second, ContainerLoadOutcome::Unavailable));

        let third = load_embedded_timeline(&url, &HashMap::new()).await;
        assert!(matches!(third, ContainerLoadOutcome::Ready(_)));
        assert!(hits.load(Ordering::SeqCst) >= 3);

        task.abort();
    }

    #[tokio::test]
    async fn public_http_stream_starts_with_allow_local_false_and_blocks_loopback_target() {
        use axum::{http::StatusCode, routing::get, Router};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };

        let remote_reader =
            HttpRangeReader::new("https://cdn.example.com/movie.mkv".to_string(), HashMap::new())
                .unwrap();
        assert!(!remote_reader.allow_local);

        let loopback_hits = Arc::new(AtomicUsize::new(0));
        let hits_c = loopback_hits.clone();
        let router = Router::new().route(
            "/secret.mkv",
            get(move || {
                let c = hits_c.clone();
                async move {
                    c.fetch_add(1, Ordering::SeqCst);
                    (StatusCode::PARTIAL_CONTENT, b"secret".to_vec())
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let loopback_url = url::Url::parse(&format!(
            "http://{}/secret.mkv",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        // Once allow_local has latched to false (as happens after touching any public origin),
        // redirecting to loopback must be blocked before any TCP connection is opened.
        let mut latched = remote_reader;
        latched.url = loopback_url;
        let res = latched.read_range(0, 64, false, false).await;
        assert!(matches!(res, Err(TimedOrPermanent::Blocked)));
        assert_eq!(loopback_hits.load(Ordering::SeqCst), 0);

        task.abort();
    }

    #[test]
    fn ebml_zero_byte_unsigned_vint_and_compact_ffprobe_accumulator() {
        let zero_el = EbmlElement {
            id: 0x53ac,
            size: Some(0),
            header_start: 0,
            data_start: 3,
            header_size: 3,
        };
        assert_eq!(read_unsigned(&[], zero_el), Some(0));

        let mut acc = FfprobeCompactAccumulator::default();
        acc.feed_line("stream|index=0");
        acc.feed_line("packet|stream_index=0|pts_time=12.5|duration_time=1.5");
        acc.feed_line("packet|stream_index=0|pts_time=-5.0|duration_time=1.0");
        acc.feed_line("packet|stream_index=0|pts_time=20.0");
        assert_eq!(acc.stream_indices, vec![0]);
        let cues = acc.packets_by_stream.get(&0).expect("stream 0 bucket");
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_ms, 12_500);
        assert_eq!(cues[0].end_ms, 14_000);
        assert!(!cues[0].estimated_end);
        assert_eq!(cues[1].start_ms, 20_000);
        assert!(cues[1].estimated_end);

        // parse_content_range rejects malformed bounds and end >= total.
        assert!(parse_content_range("bytes 0-99/100").is_some());
        assert!(parse_content_range("bytes 0-99/*").is_some());
        assert!(parse_content_range("bytes 0-garbage/bad").is_none());
        assert!(parse_content_range("bytes 50-10/100").is_none());
        assert!(parse_content_range("bytes 0-100/100").is_none());
    }
}

