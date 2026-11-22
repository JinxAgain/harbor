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
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use tokio::sync::{watch, Mutex};

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
const MAX_TOTAL_READ_BYTES: u64 = 24 * 1024 * 1024;
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
    let mut pairs: Vec<(&String, &String)> = headers.iter().collect();
    pairs.sort_by(|a, b| a.0.to_ascii_lowercase().cmp(&b.0.to_ascii_lowercase()));
    let mut out = String::from(source_url);
    for (k, v) in pairs {
        out.push('|');
        out.push_str(&k.to_ascii_lowercase());
        out.push('=');
        out.push_str(v);
    }
    out
}

pub async fn load_embedded_timeline(
    source_url: &str,
    headers: &HashMap<String, String>,
) -> ContainerLoadOutcome {
    if url_guard::validate_playback_media_url(source_url).is_err() {
        return ContainerLoadOutcome::Unavailable;
    }
    let key = make_cache_key(source_url, headers);
    let mut tx_opt: Option<watch::Sender<Option<ContainerLoadOutcome>>> = None;
    let mut rx_wait: Option<watch::Receiver<Option<ContainerLoadOutcome>>> = None;

    {
        let mut guard = cache_state().lock().await;
        if let Some(entry) = guard.entries.get(&key).cloned() {
            match entry {
                CachedEntry::Positive(tl) => return ContainerLoadOutcome::Ready(tl),
                CachedEntry::NoSubtitleTracks { created_at } => {
                    if created_at.elapsed() < NEGATIVE_CACHE_TTL {
                        return ContainerLoadOutcome::NoSubtitleTracks;
                    }
                    guard.entries.remove(&key);
                }
                CachedEntry::Negative { created_at } => {
                    if created_at.elapsed() < NEGATIVE_CACHE_TTL {
                        return ContainerLoadOutcome::NoUsableReference;
                    }
                    guard.entries.remove(&key);
                }
            }
        }
        if let Some(existing_rx) = guard.in_flight.get(&key) {
            rx_wait = Some(existing_rx.clone());
        } else {
            let (tx, rx) = watch::channel(None);
            guard.in_flight.insert(key.clone(), rx);
            tx_opt = Some(tx);
        }
    }

    if let Some(mut rx) = rx_wait {
        if let Some(res) = rx.borrow().clone() {
            return res;
        }
        while rx.changed().await.is_ok() {
            if let Some(res) = rx.borrow().clone() {
                return res;
            }
        }
        return ContainerLoadOutcome::Unavailable;
    }

    let tx = tx_opt.expect("sender must exist for owning loader");
    let source_owned = source_url.to_string();
    let headers_owned = headers.clone();
    let outcome = load_and_classify(&source_owned, &headers_owned).await;

    let mut guard = cache_state().lock().await;
    guard.in_flight.remove(&key);
    match &outcome {
        ContainerLoadOutcome::Ready(tl) => {
            insert_lru(&mut guard, key, CachedEntry::Positive(tl.clone()));
        }
        ContainerLoadOutcome::NoSubtitleTracks => {
            insert_lru(
                &mut guard,
                key,
                CachedEntry::NoSubtitleTracks {
                    created_at: Instant::now(),
                },
            );
        }
        ContainerLoadOutcome::NoUsableReference => {
            insert_lru(
                &mut guard,
                key,
                CachedEntry::Negative {
                    created_at: Instant::now(),
                },
            );
        }
        ContainerLoadOutcome::Unavailable => {
            // Do not negatively cache timeouts / transient transport errors.
        }
    }
    let _ = tx.send(Some(outcome.clone()));
    outcome
}

fn insert_lru(guard: &mut CacheState, key: String, entry: CachedEntry) {
    guard.order.retain(|k| k != &key);
    guard.order.push_back(key.clone());
    guard.entries.insert(key, entry);
    while guard.order.len() > MAX_CACHE_ENTRIES {
        if let Some(evict) = guard.order.pop_front() {
            guard.entries.remove(&evict);
        }
    }
}

async fn load_and_classify(
    source_url: &str,
    headers: &HashMap<String, String>,
) -> ContainerLoadOutcome {
    if let Some(local_path) = url_guard::local_file_path(source_url) {
        let path_clone = local_path.clone();
        let headers_clone = headers.clone();
        let src_clone = source_url.to_string();
        return match tokio::time::timeout(TOTAL_TIMEOUT, async move {
            let mut reader = LocalSourceReader::open(path_clone)?;
            inspect_container(&mut reader, Some(&src_clone), Some(&headers_clone)).await
        })
        .await
        {
            Ok(Ok(outcome)) => outcome,
            Ok(Err(_)) => ContainerLoadOutcome::NoUsableReference,
            Err(_) => ContainerLoadOutcome::Unavailable,
        };
    }

    let src = source_url.to_string();
    let hdrs = headers.clone();
    match tokio::time::timeout(TOTAL_TIMEOUT, async move {
        let mut reader = HttpRangeReader::new(src.clone(), hdrs.clone())?;
        inspect_container(&mut reader, Some(&src), Some(&hdrs)).await
    })
    .await
    {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(TimedOrPermanent::Transient)) => ContainerLoadOutcome::Unavailable,
        Ok(Err(TimedOrPermanent::Permanent)) => ContainerLoadOutcome::NoUsableReference,
        Err(_) => ContainerLoadOutcome::Unavailable,
    }
}

enum TimedOrPermanent {
    Transient,
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
    fn open(path: PathBuf) -> Result<Self, TimedOrPermanent> {
        let meta = std::fs::metadata(&path).map_err(|_| TimedOrPermanent::Transient)?;
        Ok(Self {
            path,
            total_len: meta.len(),
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
    client: reqwest::Client,
    url: String,
    headers: Vec<(String, String)>,
    deadline: Instant,
    bytes_read: u64,
    requests: usize,
}

impl HttpRangeReader {
    fn new(url: String, raw_headers: HashMap<String, String>) -> Result<Self, TimedOrPermanent> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::limited(5))
            .connect_timeout(Duration::from_secs(4))
            .build()
            .map_err(|_| TimedOrPermanent::Transient)?;
        let headers = url_guard::safe_reqwest_headers(&raw_headers, true);
        Ok(Self {
            client,
            url,
            headers,
            deadline: Instant::now() + TOTAL_TIMEOUT,
            bytes_read: 0,
            requests: 0,
        })
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
        if (len as u64) > remaining_budget {
            return Err(TimedOrPermanent::Permanent);
        }
        let now = Instant::now();
        if now >= self.deadline {
            return Err(TimedOrPermanent::Transient);
        }
        let req_timeout = (self.deadline - now).min(Duration::from_secs(5));
        let end = start.checked_add(len as u64 - 1).ok_or(TimedOrPermanent::Permanent)?;
        self.requests += 1;

        let mut req = self
            .client
            .get(&self.url)
            .timeout(req_timeout)
            .header("Range", format!("bytes={start}-{end}"))
            .header("Accept-Encoding", "identity");
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }

        let mut resp = req.send().await.map_err(|_| TimedOrPermanent::Transient)?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(TimedOrPermanent::Permanent);
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

        let mut out = Vec::with_capacity(len.min(1024 * 1024));
        while out.len() < len {
            if Instant::now() >= self.deadline {
                return Err(TimedOrPermanent::Transient);
            }
            if self.remaining_byte_budget() == 0 {
                return Err(TimedOrPermanent::Permanent);
            }
            let Some(chunk) = resp.chunk().await.map_err(|_| TimedOrPermanent::Transient)? else {
                break;
            };
            let take = chunk
                .len()
                .min(len - out.len())
                .min(self.remaining_byte_budget() as usize);
            if take == 0 {
                return Err(TimedOrPermanent::Permanent);
            }
            out.extend_from_slice(&chunk[..take]);
            self.bytes_read += take as u64;
        }
        if out.is_empty() || (require_exact && out.len() != len) {
            return Err(TimedOrPermanent::Permanent);
        }
        let total_length = content_range
            .and_then(|cr| cr.total)
            .or(if status == 200 { content_length } else { None });
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
    if trimmed.len() < 6 || !trimmed[..6].eq_ignore_ascii_case("bytes ") {
        return None;
    }
    let (range_part, total_part) = trimmed[6..].split_once('/')?;
    let (s_str, e_str) = range_part.split_once('-')?;
    let start = s_str.trim().parse::<u64>().ok();
    let end = e_str.trim().parse::<u64>().ok();
    let total = if total_part.trim() == "*" {
        None
    } else {
        total_part.trim().parse::<u64>().ok()
    };
    if let (Some(s), Some(e)) = (start, end) {
        if e < s {
            return None;
        }
    }
    Some(ContentRange { start, end, total })
}

async fn inspect_container(
    reader: &mut dyn RandomAccessReader,
    ffprobe_url: Option<&str>,
    ffprobe_headers: Option<&HashMap<String, String>>,
) -> Result<ContainerLoadOutcome, TimedOrPermanent> {
    let initial = reader
        .read_range(0, INITIAL_PROBE_BYTES, false, false)
        .await?;

    let Some(segment) = find_segment(&initial.bytes) else {
        return load_mp4_index(reader, &initial).await;
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
                _ => continue,
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
            None => fetch_element_at(reader, info_pos, ID_INFO, MAX_INFO_BYTES)
                .await
                .unwrap_or(None),
        };
        info_bytes
            .as_deref()
            .map(parse_timestamp_scale_ns)
            .unwrap_or(DEFAULT_TIMESTAMP_SCALE_NS)
    } else {
        DEFAULT_TIMESTAMP_SCALE_NS
    };

    let Some(&tracks_pos) = resolved.get(&ID_TRACKS).or_else(|| direct_positions.get(&ID_TRACKS)) else {
        return Ok(ContainerLoadOutcome::NoUsableReference);
    };
    let Some(tracks_bytes) = (match extract_element_from_probe(&initial.bytes, tracks_pos, ID_TRACKS, MAX_TRACKS_BYTES) {
        Some(b) => Some(b),
        None => fetch_element_at(reader, tracks_pos, ID_TRACKS, MAX_TRACKS_BYTES).await?,
    }) else {
        return Ok(ContainerLoadOutcome::NoUsableReference);
    };
    let subtitle_tracks = parse_subtitle_tracks(&tracks_bytes);
    if subtitle_tracks.is_empty() {
        return Ok(ContainerLoadOutcome::NoSubtitleTracks);
    }

    let cues_pos = resolved.get(&ID_CUES).or_else(|| direct_positions.get(&ID_CUES)).copied();
    let parsed_cues = if let Some(pos) = cues_pos {
        let cues_bytes = match extract_element_from_probe(&initial.bytes, pos, ID_CUES, MAX_CUES_BYTES) {
            Some(b) => Some(b),
            None => fetch_element_at(reader, pos, ID_CUES, MAX_CUES_BYTES).await?,
        };
        cues_bytes.map(|b| parse_subtitle_cue_timelines(&b, &subtitle_tracks, timestamp_scale_ns))
    } else {
        None
    };
    let parsed_cues = match parsed_cues {
        Some(map) if map.values().any(|tl| !tl.is_empty()) => map,
        _ => find_and_parse_cues_near_end(
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
        // Optional lightweight ffprobe packet timestamp fallback ONLY when MKV has non-PGS text
        // subtitle tracks in Tracks but 0 subtitle entries indexed in Cues.
        if let Some(url) = ffprobe_url {
            let empty_hdrs = HashMap::new();
            let hdrs = ffprobe_headers.unwrap_or(&empty_hdrs);
            if let Some(ref_tracks) = ffprobe_mkv_text_subtitles(url, hdrs, &subtitle_tracks).await {
                return Ok(ContainerLoadOutcome::Ready(IndexedEmbeddedTimeline {
                    tracks: ref_tracks,
                    source: "ffprobe-subtitle-packets".to_string(),
                    no_subtitle_tracks: false,
                    bytes_read: reader.bytes_read(),
                    range_requests: reader.requests_made(),
                }));
            }
        }
        return Ok(ContainerLoadOutcome::NoUsableReference);
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
        return Ok(ContainerLoadOutcome::NoUsableReference);
    }

    Ok(ContainerLoadOutcome::Ready(IndexedEmbeddedTimeline {
        tracks: reference_tracks,
        source: "matroska-cues".to_string(),
        no_subtitle_tracks: false,
        bytes_read: reader.bytes_read(),
        range_requests: reader.requests_made(),
    }))
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
        let owned_header;
        let (header_bytes, header_offset): (&[u8], usize) =
            if position.saturating_add(MP4_BOX_HEADER_BYTES as u64) <= initial.bytes.len() as u64 {
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

async fn ffprobe_mkv_text_subtitles(
    source_url: &str,
    headers: &HashMap<String, String>,
    tracks: &[MatroskaSubtitleTrack],
) -> Option<Vec<ReferenceTrack>> {
    let ffprobe = crate::transcode::locate_ffprobe()?;
    // Try up to 2 non-PGS text tracks (dialogue preferred).
    let text_indices: Vec<(usize, &MatroskaSubtitleTrack)> = tracks
        .iter()
        .enumerate()
        .filter(|(_, t)| {
            !t.codec_id
                .as_deref()
                .is_some_and(|c| c.eq_ignore_ascii_case(MATROSKA_PGS_CODEC_ID) || c.contains("VOBSUB") || c.contains("PGS"))
        })
        .take(2)
        .collect();
    if text_indices.is_empty() {
        return None;
    }

    let header_blob = url_guard::safe_header_blob(headers);
    let ua = url_guard::user_agent(headers);
    let is_http = source_url.starts_with("http://") || source_url.starts_with("https://");

    let mut out = Vec::new();
    for (sub_ordinal, track) in text_indices {
        let mut cmd = tokio::process::Command::new(&ffprobe);
        cmd.arg("-v").arg("error");
        if is_http {
            if let Some(ref u) = ua {
                cmd.arg("-user_agent").arg(u);
            }
            if !header_blob.is_empty() {
                cmd.arg("-headers").arg(&header_blob);
            }
        }
        cmd.arg("-select_streams")
            .arg(format!("s:{}", sub_ordinal))
            .arg("-show_entries")
            .arg("packet=pts_time,duration_time")
            .arg("-of")
            .arg("csv=p=0")
            .arg(source_url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }
        let Ok(Ok(output)) = tokio::time::timeout(FFPROBE_FALLBACK_TIMEOUT, cmd.output()).await
        else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let mut cues = Vec::new();
        for line in text.lines() {
            let mut parts = line.split(',');
            let Some(pts_s) = parts.next().and_then(|s| s.trim().parse::<f64>().ok()) else {
                continue;
            };
            if !pts_s.is_finite() || pts_s < 0.0 {
                continue;
            }
            let start_ms = (pts_s * 1_000.0).round() as i64;
            let dur_s = parts
                .next()
                .and_then(|s| s.trim().parse::<f64>().ok())
                .filter(|d| d.is_finite() && *d > 0.0);
            let estimated = dur_s.is_none();
            let dur_ms = dur_s.map(|d| (d * 1_000.0).round() as i64).unwrap_or(2_500);
            cues.push(SubtitleCue {
                start_ms,
                end_ms: start_ms + dur_ms.max(1),
                text: String::new(),
                estimated_end: estimated,
            });
        }
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
                .unwrap_or_else(|| build_fallback_track_label(track));
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
    for (trk_num, mut pending) in pending_by_track {
        pending.sort_by_key(|c| c.start_ms);
        pending.dedup_by_key(|c| c.start_ms);
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
    for rel_offset in offsets {
        let abs = start + rel_offset as u64;
        if let Some(cues_bytes) = fetch_element_at(reader, abs, ID_CUES, MAX_CUES_BYTES).await? {
            let parsed = parse_subtitle_cue_timelines(&cues_bytes, subtitle_tracks, timestamp_scale_ns);
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
    if !(1..=8).contains(&sz) {
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
}

