//! MP4/MOV (`moov`) subtitle sample table indexer.
//!
//! Ported from NuvioMobile's `Mp4SubtitleSampleTables.kt`, following Media3 BoxParser semantics
//! (`tx3g` and `wvtt` sample timing, `ctts` signed offsets, sync samples, edit lists, and empty
//! sample filtering) so embedded MP4 subtitle timelines can be read without decoding media samples.

const HEADER_SIZE: usize = 8;
const INDEX_UNSET: i32 = -1;
const MAX_MP4_SAMPLES: usize = 500_000;

const TYPE_MOOV: u32 = u32::from_be_bytes(*b"moov");
const TYPE_MVHD: u32 = u32::from_be_bytes(*b"mvhd");
const TYPE_MVEX: u32 = u32::from_be_bytes(*b"mvex");
const TYPE_TRAK: u32 = u32::from_be_bytes(*b"trak");
const TYPE_TKHD: u32 = u32::from_be_bytes(*b"tkhd");
const TYPE_EDTS: u32 = u32::from_be_bytes(*b"edts");
const TYPE_ELST: u32 = u32::from_be_bytes(*b"elst");
const TYPE_MDIA: u32 = u32::from_be_bytes(*b"mdia");
const TYPE_MDHD: u32 = u32::from_be_bytes(*b"mdhd");
const TYPE_HDLR: u32 = u32::from_be_bytes(*b"hdlr");
const TYPE_MINF: u32 = u32::from_be_bytes(*b"minf");
const TYPE_STBL: u32 = u32::from_be_bytes(*b"stbl");
const TYPE_STSD: u32 = u32::from_be_bytes(*b"stsd");
const TYPE_STTS: u32 = u32::from_be_bytes(*b"stts");
const TYPE_CTTS: u32 = u32::from_be_bytes(*b"ctts");
const TYPE_STSS: u32 = u32::from_be_bytes(*b"stss");
const TYPE_STSC: u32 = u32::from_be_bytes(*b"stsc");
const TYPE_STSZ: u32 = u32::from_be_bytes(*b"stsz");
const TYPE_STZ2: u32 = u32::from_be_bytes(*b"stz2");
const TYPE_STCO: u32 = u32::from_be_bytes(*b"stco");
const TYPE_CO64: u32 = u32::from_be_bytes(*b"co64");

// Text sample entries Media3 recognizes; tx3g and wvtt can be indexed.
const TYPE_UPPER_TTML: u32 = u32::from_be_bytes(*b"TTML");
const TYPE_TX3G: u32 = u32::from_be_bytes(*b"tx3g");
const TYPE_WVTT: u32 = u32::from_be_bytes(*b"wvtt");
const TYPE_STPP: u32 = u32::from_be_bytes(*b"stpp");
const TYPE_C608: u32 = u32::from_be_bytes(*b"c608");
const TYPE_MP4S: u32 = u32::from_be_bytes(*b"mp4s");

const HANDLER_TEXT: u32 = u32::from_be_bytes(*b"text");
const HANDLER_SBTL: u32 = u32::from_be_bytes(*b"sbtl");
const HANDLER_SUBT: u32 = u32::from_be_bytes(*b"subt");
const HANDLER_CLCP: u32 = u32::from_be_bytes(*b"clcp");
const HANDLER_SUBP: u32 = u32::from_be_bytes(*b"subp");

const MICROS_PER_SECOND: i64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mp4SubtitleCodec {
    Tx3g,
    Wvtt,
}

#[derive(Debug, Clone)]
pub struct Mp4SubtitleSampleTable {
    pub track_id: i32,
    pub codec: Mp4SubtitleCodec,
    pub language: Option<String>,
    pub timestamps_us: Vec<i64>,
    pub sizes: Vec<i32>,
    pub duration_us: i64,
}

#[derive(Debug, Clone)]
pub struct Mp4SubtitleIndex {
    pub has_text_tracks: bool,
    pub tables: Vec<Mp4SubtitleSampleTable>,
}

#[derive(Clone, Copy)]
struct Mp4Box {
    box_type: u32,
    start: usize,
    end: usize,
    header_size: usize,
}

impl Mp4Box {
    fn data_start(self) -> usize {
        self.start + self.header_size
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    start: usize,
    end: usize,
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], b: Mp4Box) -> Self {
        Self {
            bytes,
            start: b.data_start(),
            end: b.end,
            position: 0,
        }
    }

    fn bytes_left(&self) -> usize {
        self.end.saturating_sub(self.start.saturating_add(self.position))
    }

    fn take(&mut self, count: usize) -> Option<usize> {
        let at = self.start.checked_add(self.position)?;
        let finish = at.checked_add(count)?;
        if at < self.start || finish > self.end || finish > self.bytes.len() {
            return None;
        }
        self.position += count;
        Some(at)
    }

    fn skip(&mut self, count: usize) -> Option<()> {
        self.take(count).map(|_| ())
    }

    fn read_u8(&mut self) -> Option<u8> {
        let at = self.take(1)?;
        Some(self.bytes[at])
    }

    fn read_u16(&mut self) -> Option<u16> {
        let at = self.take(2)?;
        Some(u16::from_be_bytes([self.bytes[at], self.bytes[at + 1]]))
    }

    fn read_i16(&mut self) -> Option<i16> {
        let at = self.take(2)?;
        Some(i16::from_be_bytes([self.bytes[at], self.bytes[at + 1]]))
    }

    fn read_i32(&mut self) -> Option<i32> {
        let at = self.take(4)?;
        Some(i32::from_be_bytes([
            self.bytes[at],
            self.bytes[at + 1],
            self.bytes[at + 2],
            self.bytes[at + 3],
        ]))
    }

    fn read_u32(&mut self) -> Option<u32> {
        let at = self.take(4)?;
        Some(u32::from_be_bytes([
            self.bytes[at],
            self.bytes[at + 1],
            self.bytes[at + 2],
            self.bytes[at + 3],
        ]))
    }

    fn read_u32_to_usize(&mut self) -> Option<usize> {
        let v = self.read_i32()?;
        if v < 0 {
            return None;
        }
        usize::try_from(v).ok()
    }

    fn read_i64(&mut self) -> Option<i64> {
        let at = self.take(8)?;
        Some(i64::from_be_bytes([
            self.bytes[at],
            self.bytes[at + 1],
            self.bytes[at + 2],
            self.bytes[at + 3],
            self.bytes[at + 4],
            self.bytes[at + 5],
            self.bytes[at + 6],
            self.bytes[at + 7],
        ]))
    }

    fn read_non_neg_i64(&mut self) -> Option<i64> {
        let v = self.read_i64()?;
        if v < 0 {
            return None;
        }
        Some(v)
    }
}

pub fn parse_moov_subtitles(moov: &[u8]) -> Option<Mp4SubtitleIndex> {
    let root = read_box_at(moov, 0, moov.len())?;
    if root.box_type != TYPE_MOOV || root.end != moov.len() {
        return None;
    }
    let root_children = children(moov, root)?;
    if root_children.iter().any(|c| c.box_type == TYPE_MVEX) {
        // Fragmented MP4 carries timing inside moof fragments, not a complete moov index.
        return None;
    }
    let mvhd = root_children.iter().copied().find(|c| c.box_type == TYPE_MVHD);

    let mut tables = Vec::new();
    let mut has_text_tracks = false;
    for &trak in &root_children {
        if trak.box_type != TYPE_TRAK {
            continue;
        }
        let Some(mdia) = text_track_mdia(moov, trak) else {
            continue;
        };
        has_text_tracks = true;
        let mvhd_box = mvhd?;
        if let Some(Some(table)) = parse_text_track(moov, trak, mdia, mvhd_box) {
            tables.push(table);
        }
    }
    Some(Mp4SubtitleIndex {
        has_text_tracks,
        tables,
    })
}

fn read_box_at(bytes: &[u8], offset: usize, limit: usize) -> Option<Mp4Box> {
    if offset.checked_add(HEADER_SIZE)? > limit || limit > bytes.len() {
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
    let (size, header_size): (u64, usize) = match size32 {
        0 => ((limit - offset) as u64, HEADER_SIZE),
        1 => {
            if offset.checked_add(16)? > limit {
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
        other => (other, HEADER_SIZE),
    };
    if size < header_size as u64 {
        return None;
    }
    let end = (offset as u64).checked_add(size)?;
    if end > limit as u64 {
        return None;
    }
    Some(Mp4Box {
        box_type,
        start: offset,
        end: usize::try_from(end).ok()?,
        header_size,
    })
}

fn children(bytes: &[u8], parent: Mp4Box) -> Option<Vec<Mp4Box>> {
    let mut result = Vec::new();
    let mut pos = parent.data_start();
    while pos < parent.end {
        let child = read_box_at(bytes, pos, parent.end)?;
        if child.end <= pos {
            return None;
        }
        result.push(child);
        pos = child.end;
    }
    Some(result)
}

fn child(bytes: &[u8], parent: Mp4Box, box_type: u32) -> Option<Mp4Box> {
    children(bytes, parent)?
        .into_iter()
        .find(|b| b.box_type == box_type)
}

fn is_text_handler(handler: u32) -> bool {
    matches!(
        handler,
        HANDLER_TEXT | HANDLER_SBTL | HANDLER_SUBT | HANDLER_CLCP | HANDLER_SUBP
    )
}

fn text_track_mdia(bytes: &[u8], trak: Mp4Box) -> Option<Mp4Box> {
    let mdia = child(bytes, trak, TYPE_MDIA)?;
    let hdlr = child(bytes, mdia, TYPE_HDLR)?;
    let mut r = Reader::new(bytes, hdlr);
    r.position = 8;
    let handler = r.read_u32()?;
    if is_text_handler(handler) {
        Some(mdia)
    } else {
        None
    }
}

fn full_box_version(full_box: u32) -> u8 {
    ((full_box >> 24) & 0xff) as u8
}

fn parse_tkhd_track_id(bytes: &[u8], tkhd: Mp4Box) -> Option<i32> {
    let mut r = Reader::new(bytes, tkhd);
    let version = full_box_version(r.read_u32()?);
    r.skip(if version == 0 { 8 } else { 16 })?;
    r.read_i32()
}

fn parse_mvhd_timescale(bytes: &[u8], mvhd: Mp4Box) -> Option<i64> {
    let mut r = Reader::new(bytes, mvhd);
    let version = full_box_version(r.read_u32()?);
    r.skip(if version == 0 { 8 } else { 16 })?;
    Some(i64::from(r.read_u32()?))
}

struct Mdhd {
    timescale: i64,
    language: Option<String>,
}

fn parse_mdhd(bytes: &[u8], mdhd: Mp4Box) -> Option<Mdhd> {
    let mut r = Reader::new(bytes, mdhd);
    let version = full_box_version(r.read_u32()?);
    r.skip(if version == 0 { 8 } else { 16 })?;
    let timescale = i64::from(r.read_u32()?);
    r.skip(if version == 0 { 4 } else { 8 })?;
    let code = r.read_u16()?;
    let c0 = (((code >> 10) & 0x1f) as u8).saturating_add(0x60);
    let c1 = (((code >> 5) & 0x1f) as u8).saturating_add(0x60);
    let c2 = ((code & 0x1f) as u8).saturating_add(0x60);
    let chars = [c0, c1, c2];
    let language = if chars.iter().all(|b| b.is_ascii_lowercase()) {
        std::str::from_utf8(&chars).ok().map(|s| s.to_string())
    } else {
        None
    };
    Some(Mdhd {
        timescale,
        language,
    })
}

fn parse_stsd_codec(bytes: &[u8], stsd: Mp4Box) -> Option<Option<Mp4SubtitleCodec>> {
    let mut r = Reader::new(bytes, stsd);
    r.position = 4;
    let entry_count = r.read_i32()?;
    if entry_count < 0 {
        return None;
    }
    let mut last_text_type = 0u32;
    for _ in 0..entry_count {
        let entry_start = r.position;
        let entry_size = r.read_i32()?;
        if entry_size <= 8 {
            return None;
        }
        let entry_type = r.read_u32()?;
        if matches!(
            entry_type,
            TYPE_UPPER_TTML | TYPE_TX3G | TYPE_WVTT | TYPE_STPP | TYPE_C608 | TYPE_MP4S
        ) {
            last_text_type = entry_type;
        }
        r.position = entry_start.checked_add(entry_size as usize)?;
    }
    let codec = match last_text_type {
        TYPE_TX3G => Some(Mp4SubtitleCodec::Tx3g),
        TYPE_WVTT => Some(Mp4SubtitleCodec::Wvtt),
        _ => None,
    };
    Some(codec)
}

struct EditList {
    durations: Vec<i64>,
    media_times: Vec<i64>,
}

const MAX_ELST_ENTRIES: usize = 4_096;

fn parse_elst(bytes: &[u8], elst: Mp4Box) -> Option<EditList> {
    let mut r = Reader::new(bytes, elst);
    let version = full_box_version(r.read_u32()?);
    let entry_count = r.read_u32_to_usize()?;
    let entry_size = if version == 1 { 20 } else { 12 };
    if entry_count > MAX_ELST_ENTRIES || entry_count > r.bytes_left() / entry_size {
        return None;
    }
    let mut durations = Vec::with_capacity(entry_count.min(4096));
    let mut media_times = Vec::with_capacity(entry_count.min(4096));
    for _ in 0..entry_count {
        let duration = if version == 1 {
            r.read_non_neg_i64()?
        } else {
            i64::from(r.read_u32()?)
        };
        let media_time = if version == 1 {
            r.read_i64()?
        } else {
            i64::from(r.read_i32()?)
        };
        let media_rate_integer = r.read_i16()?;
        if media_time != -1 && media_rate_integer != 1 {
            return None;
        }
        r.skip(2)?;
        durations.push(duration);
        media_times.push(media_time);
    }
    Some(EditList {
        durations,
        media_times,
    })
}

enum SampleSizes<'a> {
    Stsz {
        reader: Reader<'a>,
        fixed_size: Option<i32>,
        sample_count: usize,
    },
    Stz2 {
        reader: Reader<'a>,
        field_size: usize,
        sample_count: usize,
        sample_index: usize,
        current_byte: u8,
    },
}

impl<'a> SampleSizes<'a> {
    fn from_stsz(bytes: &'a [u8], box_stsz: Mp4Box) -> Option<Self> {
        let mut r = Reader::new(bytes, box_stsz);
        r.position = 4;
        let fixed_raw = r.read_u32_to_usize()?;
        let fixed_size = if fixed_raw == 0 {
            None
        } else {
            Some(i32::try_from(fixed_raw).ok()?)
        };
        let sample_count = r.read_u32_to_usize()?;
        Some(Self::Stsz {
            reader: r,
            fixed_size,
            sample_count,
        })
    }

    fn from_stz2(bytes: &'a [u8], box_stz2: Mp4Box) -> Option<Self> {
        let mut r = Reader::new(bytes, box_stz2);
        r.position = 4;
        let field_size = r.read_u32_to_usize()? & 0xff;
        let sample_count = r.read_u32_to_usize()?;
        Some(Self::Stz2 {
            reader: r,
            field_size,
            sample_count,
            sample_index: 0,
            current_byte: 0,
        })
    }

    fn sample_count(&self) -> usize {
        match self {
            Self::Stsz { sample_count, .. } | Self::Stz2 { sample_count, .. } => *sample_count,
        }
    }

    fn read_next_size(&mut self) -> Option<i32> {
        match self {
            Self::Stsz {
                reader, fixed_size, ..
            } => {
                if let Some(fixed) = fixed_size {
                    Some(*fixed)
                } else {
                    i32::try_from(reader.read_u32_to_usize()?).ok()
                }
            }
            Self::Stz2 {
                reader,
                field_size,
                sample_index,
                current_byte,
                ..
            } => match *field_size {
                8 => Some(i32::from(reader.read_u8()?)),
                16 => Some(i32::from(reader.read_u16()?)),
                _ => {
                    let idx = *sample_index;
                    *sample_index = idx + 1;
                    if idx.is_multiple_of(2) {
                        *current_byte = reader.read_u8()?;
                        Some(i32::from((*current_byte & 0xf0) >> 4))
                    } else {
                        Some(i32::from(*current_byte & 0x0f))
                    }
                }
            },
        }
    }
}

struct ChunkIterator<'a> {
    stsc: Reader<'a>,
    chunk_offsets: Reader<'a>,
    chunk_offsets_are_longs: bool,
    length: i32,
    index: i32,
    num_samples: usize,
    next_change_index: i32,
    remaining_changes: i32,
}

impl<'a> ChunkIterator<'a> {
    fn new(
        mut stsc: Reader<'a>,
        mut chunk_offsets: Reader<'a>,
        chunk_offsets_are_longs: bool,
    ) -> Option<Self> {
        chunk_offsets.position = 4;
        let length = i32::try_from(chunk_offsets.read_u32_to_usize()?).ok()?;
        stsc.position = 4;
        let remaining_changes = i32::try_from(stsc.read_u32_to_usize()?).ok()?;
        if remaining_changes > 0 && stsc.read_i32()? != 1 {
            return None;
        }
        Some(Self {
            stsc,
            chunk_offsets,
            chunk_offsets_are_longs,
            length,
            index: -1,
            num_samples: 0,
            next_change_index: 0,
            remaining_changes,
        })
    }

    fn move_next(&mut self) -> Option<bool> {
        self.index += 1;
        if self.index >= self.length {
            return Some(false);
        }
        if self.chunk_offsets_are_longs {
            self.chunk_offsets.read_non_neg_i64()?;
        } else {
            self.chunk_offsets.read_u32()?;
        }
        if self.index == self.next_change_index && self.remaining_changes > 0 {
            self.num_samples = self.stsc.read_u32_to_usize()?;
            self.stsc.skip(4)?; // sample_description_index
            self.remaining_changes -= 1;
            self.next_change_index = if self.remaining_changes > 0 {
                i32::try_from(self.stsc.read_u32_to_usize()?).ok()? - 1
            } else {
                INDEX_UNSET
            };
        }
        Some(true)
    }
}

fn parse_text_track(
    bytes: &[u8],
    trak: Mp4Box,
    mdia: Mp4Box,
    mvhd: Mp4Box,
) -> Option<Option<Mp4SubtitleSampleTable>> {
    let tkhd = child(bytes, trak, TYPE_TKHD)?;
    let track_id = parse_tkhd_track_id(bytes, tkhd)?;
    let movie_timescale = parse_mvhd_timescale(bytes, mvhd)?;
    let minf = child(bytes, mdia, TYPE_MINF)?;
    let stbl = child(bytes, minf, TYPE_STBL)?;
    let mdhd = parse_mdhd(bytes, child(bytes, mdia, TYPE_MDHD)?)?;
    if mdhd.timescale <= 0 || movie_timescale <= 0 {
        return None;
    }
    let stsd = child(bytes, stbl, TYPE_STSD)?;
    let Some(codec) = parse_stsd_codec(bytes, stsd)? else {
        return Some(None);
    };
    let edits = if let Some(edts) = child(bytes, trak, TYPE_EDTS) {
        if let Some(elst) = child(bytes, edts, TYPE_ELST) {
            Some(parse_elst(bytes, elst)?)
        } else {
            None
        }
    } else {
        None
    };

    let table = parse_stbl(bytes, stbl, track_id, codec, mdhd, movie_timescale, edits)?;
    Some(Some(table))
}

fn parse_stbl(
    bytes: &[u8],
    stbl: Mp4Box,
    track_id: i32,
    codec: Mp4SubtitleCodec,
    mdhd: Mdhd,
    movie_timescale: i64,
    edits: Option<EditList>,
) -> Option<Mp4SubtitleSampleTable> {
    let mut sample_sizes = if let Some(stsz) = child(bytes, stbl, TYPE_STSZ) {
        SampleSizes::from_stsz(bytes, stsz)?
    } else if let Some(stz2) = child(bytes, stbl, TYPE_STZ2) {
        SampleSizes::from_stz2(bytes, stz2)?
    } else {
        return None;
    };

    let mut sample_count = sample_sizes.sample_count();
    if sample_count == 0 {
        return Some(Mp4SubtitleSampleTable {
            track_id,
            codec,
            language: mdhd.language,
            timestamps_us: Vec::new(),
            sizes: Vec::new(),
            duration_us: 0,
        });
    }
    if sample_count > MAX_MP4_SAMPLES {
        return None;
    }

    let stco_opt = child(bytes, stbl, TYPE_STCO);
    let chunk_offsets_are_longs = stco_opt.is_none();
    let chunk_box = stco_opt.or_else(|| child(bytes, stbl, TYPE_CO64))?;
    let stsc = Reader::new(bytes, child(bytes, stbl, TYPE_STSC)?);
    let mut stts = Reader::new(bytes, child(bytes, stbl, TYPE_STTS)?);
    let mut stss = child(bytes, stbl, TYPE_STSS).map(|b| Reader::new(bytes, b));
    let mut ctts = child(bytes, stbl, TYPE_CTTS).map(|b| Reader::new(bytes, b));

    let mut chunk_iter = ChunkIterator::new(stsc, Reader::new(bytes, chunk_box), chunk_offsets_are_longs)?;

    stts.position = 4;
    let stts_entries = stts.read_u32_to_usize()?;
    if stts_entries == 0 {
        return None;
    }
    let mut remaining_delta_changes = stts_entries;
    let mut remaining_samples_at_delta = 0usize;
    let mut timestamp_delta_units = 0i64;

    let mut remaining_offset_changes = 0usize;
    let mut remaining_samples_at_offset = 0usize;
    let mut timestamp_offset_units = 0i64;
    if let Some(ref mut ctts_r) = ctts {
        ctts_r.position = 4;
        remaining_offset_changes = ctts_r.read_u32_to_usize()?;
    }

    let mut next_sync_idx = INDEX_UNSET;
    let mut remaining_sync_samples = 0usize;
    if let Some(ref mut stss_r) = stss {
        stss_r.position = 4;
        remaining_sync_samples = stss_r.read_u32_to_usize()?;
        if remaining_sync_samples > 0 {
            next_sync_idx = i32::try_from(stss_r.read_u32_to_usize()?).ok()? - 1;
        } else {
            stss = None;
        }
    }

    let prealloc = sample_count.min(16_384);
    let mut sizes = Vec::with_capacity(prealloc);
    let mut timestamps = Vec::with_capacity(prealloc);
    let mut key_frames = Vec::with_capacity(prealloc);
    let mut timestamp_units = 0i64;
    let mut remaining_in_chunk = 0usize;

    for i in 0..sample_count {
        let mut chunk_complete = true;
        while remaining_in_chunk == 0 {
            chunk_complete = chunk_iter.move_next()?;
            if !chunk_complete {
                break;
            }
            remaining_in_chunk = chunk_iter.num_samples;
        }
        if !chunk_complete {
            sample_count = i;
            break;
        }

        if let Some(ref mut ctts_r) = ctts {
            while remaining_samples_at_offset == 0 && remaining_offset_changes > 0 {
                remaining_samples_at_offset = ctts_r.read_u32_to_usize()?;
                timestamp_offset_units = i64::from(ctts_r.read_i32()?);
                remaining_offset_changes -= 1;
            }
            remaining_samples_at_offset = remaining_samples_at_offset.saturating_sub(1);
        }

        while remaining_samples_at_delta == 0 && remaining_delta_changes > 0 {
            remaining_samples_at_delta = stts.read_u32_to_usize()?;
            timestamp_delta_units = i64::from(stts.read_u32()?);
            remaining_delta_changes -= 1;
        }

        sizes.push(sample_sizes.read_next_size()?);
        timestamps.push(timestamp_units.saturating_add(timestamp_offset_units));

        let mut is_key = stss.is_none();
        if i as i32 == next_sync_idx {
            is_key = true;
            remaining_sync_samples -= 1;
            if remaining_sync_samples > 0 {
                if let Some(ref mut stss_r) = stss {
                    next_sync_idx = i32::try_from(stss_r.read_u32_to_usize()?).ok()? - 1;
                }
            }
        }
        key_frames.push(is_key);

        timestamp_units = timestamp_units.saturating_add(timestamp_delta_units);
        remaining_samples_at_delta = remaining_samples_at_delta.saturating_sub(1);
        remaining_in_chunk -= 1;
    }

    sizes.truncate(sample_count);
    timestamps.truncate(sample_count);
    key_frames.truncate(sample_count);
    if sample_count == 0 {
        return Some(Mp4SubtitleSampleTable {
            track_id,
            codec,
            language: mdhd.language,
            timestamps_us: Vec::new(),
            sizes: Vec::new(),
            duration_us: 0,
        });
    }

    let duration_units = timestamp_units.saturating_add(timestamp_offset_units);
    let timescale = mdhd.timescale;
    let duration_us = scale_large_timestamp(duration_units, MICROS_PER_SECOND, timescale);

    let Some(edits) = edits else {
        for ts in &mut timestamps {
            *ts = scale_large_timestamp(*ts, MICROS_PER_SECOND, timescale);
        }
        return Some(Mp4SubtitleSampleTable {
            track_id,
            codec,
            language: mdhd.language,
            timestamps_us: timestamps,
            sizes,
            duration_us,
        });
    };

    if edits.durations.len() == 1 && edits.durations[0] == 0 {
        let edit_start_time = edits.media_times[0];
        for ts in &mut timestamps {
            *ts = scale_large_timestamp(
                ts.saturating_sub(edit_start_time),
                MICROS_PER_SECOND,
                timescale,
            );
        }
        let shifted_duration = scale_large_timestamp(
            duration_units.saturating_sub(edit_start_time),
            MICROS_PER_SECOND,
            timescale,
        );
        return Some(Mp4SubtitleSampleTable {
            track_id,
            codec,
            language: mdhd.language,
            timestamps_us: timestamps,
            sizes,
            duration_us: shifted_duration,
        });
    }

    let edit_count = edits.durations.len();
    let mut start_indices = vec![0isize; edit_count];
    let mut end_indices = vec![0isize; edit_count];
    let kf_len = key_frames.len();
    let mut prev_key = vec![-1isize; kf_len];
    let mut last_kf = -1isize;
    for (idx, &is_kf) in key_frames.iter().enumerate() {
        if is_kf {
            last_kf = idx as isize;
        }
        prev_key[idx] = last_kf;
    }
    let mut next_key = vec![kf_len as isize; kf_len];
    let mut next_kf = kf_len as isize;
    for idx in (0..kf_len).rev() {
        if key_frames[idx] {
            next_kf = idx as isize;
        }
        next_key[idx] = next_kf;
    }
    for i in 0..edit_count {
        let edit_media_time = edits.media_times[i];
        if edit_media_time == -1 {
            continue;
        }
        let mut s_idx = binary_search_floor(&timestamps, edit_media_time, true, true);
        let e_idx = if edits.durations[i] == 0 {
            // ISO 14496-12 Section 8.6.6: segment_duration == 0 means the edit lasts until media end.
            timestamps.len() as isize
        } else {
            let edit_duration = scale_large_timestamp(edits.durations[i], timescale, movie_timescale);
            binary_search_ceil(
                &timestamps,
                edit_media_time.saturating_add(edit_duration),
                false,
                false,
            )
        };
        let initial_start = s_idx;
        if s_idx >= 0 && (s_idx as usize) < kf_len {
            s_idx = prev_key[s_idx as usize];
        } else if s_idx >= kf_len as isize {
            s_idx = if kf_len > 0 { prev_key[kf_len - 1] } else { -1 };
        }
        if s_idx < 0 {
            if initial_start >= 0 && (initial_start as usize) < kf_len {
                let nk = next_key[initial_start as usize];
                s_idx = if nk < e_idx { nk } else { e_idx };
            } else {
                s_idx = initial_start;
            }
        }
        start_indices[i] = s_idx;
        end_indices[i] = e_idx;
    }

    let mut edited_timestamps = Vec::new();
    let mut edited_sizes = Vec::new();
    let mut pts = 0i64;
    let mut edited_duration_us = 0i64;
    for i in 0..edit_count {
        let edit_media_time = edits.media_times[i];
        let pts_us = scale_large_timestamp(pts, MICROS_PER_SECOND, movie_timescale);
        if edit_media_time != -1 && end_indices[i] > start_indices[i] {
            for j in start_indices[i]..end_indices[i] {
                if j >= 0 && (j as usize) < timestamps.len() {
                    if edited_timestamps.len() >= MAX_MP4_SAMPLES {
                        return None;
                    }
                    let time_in_segment_us = scale_large_timestamp(
                        timestamps[j as usize].saturating_sub(edit_media_time),
                        MICROS_PER_SECOND,
                        timescale,
                    );
                    edited_timestamps.push(pts_us.saturating_add(time_in_segment_us));
                    edited_sizes.push(sizes[j as usize]);
                }
            }
        }
        if edits.durations[i] == 0 && edit_media_time != -1 {
            let remaining_us = scale_large_timestamp(
                duration_units.saturating_sub(edit_media_time),
                MICROS_PER_SECOND,
                timescale,
            );
            edited_duration_us = edited_duration_us.max(pts_us.saturating_add(remaining_us));
            break;
        }
        pts = pts.saturating_add(edits.durations[i]);
        edited_duration_us = edited_duration_us.max(scale_large_timestamp(
            pts,
            MICROS_PER_SECOND,
            movie_timescale,
        ));
    }
    Some(Mp4SubtitleSampleTable {
        track_id,
        codec,
        language: mdhd.language,
        timestamps_us: edited_timestamps,
        sizes: edited_sizes,
        duration_us: edited_duration_us,
    })
}

/// Scales `value * multiplier / divisor` with 128-bit arithmetic (truncating toward zero),
/// matching Media3 `Util.scaleLargeTimestamp` without overflowing 64-bit intermediate products.
pub fn scale_large_timestamp(value: i64, multiplier: i64, divisor: i64) -> i64 {
    if value == 0 || multiplier == 0 || divisor == 0 {
        return 0;
    }
    let num = (value as i128).saturating_mul(multiplier as i128);
    let scaled = num / (divisor as i128);
    scaled.clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

fn binary_search_floor(array: &[i64], value: i64, inclusive: bool, stay_in_bounds: bool) -> isize {
    let mut index: isize = match array.binary_search(&value) {
        Ok(mut pos) => {
            while pos > 0 && array[pos - 1] == value {
                pos -= 1;
            }
            if inclusive {
                pos as isize
            } else {
                (pos as isize) - 1
            }
        }
        Err(ins) => (ins as isize) - 1,
    };
    if stay_in_bounds {
        index = index.max(0);
    }
    index
}

fn binary_search_ceil(array: &[i64], value: i64, inclusive: bool, stay_in_bounds: bool) -> isize {
    let mut index: isize = match array.binary_search(&value) {
        Ok(mut pos) => {
            while pos + 1 < array.len() && array[pos + 1] == value {
                pos += 1;
            }
            if inclusive {
                pos as isize
            } else {
                (pos as isize) + 1
            }
        }
        Err(ins) => ins as isize,
    };
    if stay_in_bounds {
        index = index.min(array.len() as isize - 1);
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_bytes(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let size = (8 + payload.len()) as u32;
        let mut out = Vec::with_capacity(8 + payload.len());
        out.extend_from_slice(&size.to_be_bytes());
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    fn full_box(kind: &[u8; 4], version: u8, flags: u32, payload: &[u8]) -> Vec<u8> {
        let vf = ((version as u32) << 24) | (flags & 0x00ff_ffff);
        let mut body = Vec::with_capacity(4 + payload.len());
        body.extend_from_slice(&vf.to_be_bytes());
        body.extend_from_slice(payload);
        box_bytes(kind, &body)
    }

    fn build_synthetic_moov(
        codec_fourcc: &[u8; 4],
        sample_sizes: &[u32],
        sample_deltas: &[(u32, i32)],
        elst_entries: Option<&[(u32, i32, i16)]>,
    ) -> Vec<u8> {
        // mvhd (version 0): 8 bytes creation/mod, timescale=1000
        let mut mvhd_payload = vec![0u8; 96];
        mvhd_payload[8..12].copy_from_slice(&1000u32.to_be_bytes());
        let mvhd = full_box(b"mvhd", 0, 0, &mvhd_payload);

        // tkhd (version 0): track_id = 3 at offset 8
        let mut tkhd_payload = vec![0u8; 80];
        tkhd_payload[8..12].copy_from_slice(&3i32.to_be_bytes());
        let tkhd = full_box(b"tkhd", 0, 1, &tkhd_payload);

        // mdhd (version 0): timescale = 1000, duration = 60000, language = "eng" (0x15c7)
        let mut mdhd_payload = vec![0u8; 20];
        mdhd_payload[8..12].copy_from_slice(&1000u32.to_be_bytes());
        mdhd_payload[12..16].copy_from_slice(&60000u32.to_be_bytes());
        let eng: u16 = ((b'e' - 0x60) as u16) << 10
            | ((b'n' - 0x60) as u16) << 5
            | ((b'g' - 0x60) as u16);
        mdhd_payload[16..18].copy_from_slice(&eng.to_be_bytes());
        let mdhd = full_box(b"mdhd", 0, 0, &mdhd_payload);

        // hdlr: sbtl
        let mut hdlr_payload = vec![0u8; 20];
        hdlr_payload[4..8].copy_from_slice(b"sbtl");
        let hdlr = full_box(b"hdlr", 0, 0, &hdlr_payload);

        // stsd: 1 entry
        let entry = box_bytes(codec_fourcc, &[0u8; 8]);
        let mut stsd_payload = Vec::new();
        stsd_payload.extend_from_slice(&1i32.to_be_bytes());
        stsd_payload.extend_from_slice(&entry);
        let stsd = full_box(b"stsd", 0, 0, &stsd_payload);

        // stts
        let mut stts_payload = Vec::new();
        stts_payload.extend_from_slice(&(sample_deltas.len() as u32).to_be_bytes());
        for (count, delta) in sample_deltas {
            stts_payload.extend_from_slice(&count.to_be_bytes());
            stts_payload.extend_from_slice(&delta.to_be_bytes());
        }
        let stts = full_box(b"stts", 0, 0, &stts_payload);

        // stsc: chunk 1 has all samples
        let mut stsc_payload = Vec::new();
        stsc_payload.extend_from_slice(&1u32.to_be_bytes());
        stsc_payload.extend_from_slice(&1u32.to_be_bytes());
        stsc_payload.extend_from_slice(&(sample_sizes.len() as u32).to_be_bytes());
        stsc_payload.extend_from_slice(&1u32.to_be_bytes());
        let stsc = full_box(b"stsc", 0, 0, &stsc_payload);

        // stsz
        let mut stsz_payload = Vec::new();
        stsz_payload.extend_from_slice(&0u32.to_be_bytes());
        stsz_payload.extend_from_slice(&(sample_sizes.len() as u32).to_be_bytes());
        for sz in sample_sizes {
            stsz_payload.extend_from_slice(&sz.to_be_bytes());
        }
        let stsz = full_box(b"stsz", 0, 0, &stsz_payload);

        // stco: 1 chunk at offset 1024
        let mut stco_payload = Vec::new();
        stco_payload.extend_from_slice(&1u32.to_be_bytes());
        stco_payload.extend_from_slice(&1024u32.to_be_bytes());
        let stco = full_box(b"stco", 0, 0, &stco_payload);

        let mut stbl_body = Vec::new();
        stbl_body.extend_from_slice(&stsd);
        stbl_body.extend_from_slice(&stts);
        stbl_body.extend_from_slice(&stsc);
        stbl_body.extend_from_slice(&stsz);
        stbl_body.extend_from_slice(&stco);
        let stbl = box_bytes(b"stbl", &stbl_body);
        let minf = box_bytes(b"minf", &stbl);
        let mut mdia_body = Vec::new();
        mdia_body.extend_from_slice(&mdhd);
        mdia_body.extend_from_slice(&hdlr);
        mdia_body.extend_from_slice(&minf);
        let mdia = box_bytes(b"mdia", &mdia_body);

        let mut trak_body = Vec::new();
        trak_body.extend_from_slice(&tkhd);
        if let Some(entries) = elst_entries {
            let mut elst_payload = Vec::new();
            elst_payload.extend_from_slice(&(entries.len() as u32).to_be_bytes());
            for (dur, media_time, rate) in entries {
                elst_payload.extend_from_slice(&dur.to_be_bytes());
                elst_payload.extend_from_slice(&media_time.to_be_bytes());
                elst_payload.extend_from_slice(&rate.to_be_bytes());
                elst_payload.extend_from_slice(&0i16.to_be_bytes());
            }
            let elst = full_box(b"elst", 0, 0, &elst_payload);
            trak_body.extend_from_slice(&box_bytes(b"edts", &elst));
        }
        trak_body.extend_from_slice(&mdia);
        let trak = box_bytes(b"trak", &trak_body);

        let mut moov_body = Vec::new();
        moov_body.extend_from_slice(&mvhd);
        moov_body.extend_from_slice(&trak);
        box_bytes(b"moov", &moov_body)
    }

    #[test]
    fn parses_tx3g_sample_table_and_sizes() {
        let moov = build_synthetic_moov(b"tx3g", &[2, 24, 2, 18], &[(4, 1500)], None);
        let idx = parse_moov_subtitles(&moov).expect("parse moov");
        assert!(idx.has_text_tracks);
        assert_eq!(idx.tables.len(), 1);
        let table = &idx.tables[0];
        assert_eq!(table.track_id, 3);
        assert_eq!(table.codec, Mp4SubtitleCodec::Tx3g);
        assert_eq!(table.language.as_deref(), Some("eng"));
        assert_eq!(table.timestamps_us, vec![0, 1_500_000, 3_000_000, 4_500_000]);
        assert_eq!(table.sizes, vec![2, 24, 2, 18]);
        assert_eq!(table.duration_us, 6_000_000);
    }

    #[test]
    fn applies_zero_duration_edit_list_shift() {
        let moov = build_synthetic_moov(
            b"wvtt",
            &[8, 30, 8],
            &[(3, 2000)],
            Some(&[(0, 500, 1)]),
        );
        let idx = parse_moov_subtitles(&moov).expect("parse wvtt with elst");
        assert_eq!(idx.tables[0].codec, Mp4SubtitleCodec::Wvtt);
        assert_eq!(
            idx.tables[0].timestamps_us,
            vec![-500_000, 1_500_000, 3_500_000]
        );
    }

    #[test]
    fn scales_large_timestamps_without_overflow() {
        // 100 hours at 90kHz -> microseconds
        let ticks = 100i64 * 3600 * 90_000;
        let us = scale_large_timestamp(ticks, 1_000_000, 90_000);
        assert_eq!(us, 100 * 3600 * 1_000_000);
    }

    #[test]
    fn empty_chunk_with_edit_list_does_not_panic() {
        let mut stsc_zero = build_synthetic_moov(
            b"tx3g",
            &[12, 14],
            &[(2, 1000)],
            Some(&[(1000, 0, 1)]),
        );
        // Zero out entries in stsc or construct an empty chunk table via sample_count = 0 in stsc:
        // Replace stsc (1 chunk, 2 samples) -> (1 chunk, 0 samples) so chunk loop truncates sample_count = 0.
        let needle = [0, 0, 0, 1u8, 0, 0, 0, 2u8, 0, 0, 0, 1u8];
        if let Some(pos) = stsc_zero.windows(needle.len()).position(|w| w == needle) {
            stsc_zero[pos + 7] = 0;
        }
        let idx = parse_moov_subtitles(&stsc_zero).expect("empty chunk table returns empty track");
        assert!(idx.has_text_tracks);
        assert_eq!(idx.tables.len(), 1);
        assert!(idx.tables[0].timestamps_us.is_empty());
    }

    #[test]
    fn elst_with_absurd_entry_count_and_min_media_time_never_panics_or_ooms() {
        // Corrupt elst claiming 999_999 entries in a 16-byte box -> rejected safely without prealloc OOM.
        let mut moov = build_synthetic_moov(
            b"tx3g",
            &[10, 12],
            &[(2, 1000)],
            Some(&[(1000, 0, 1)]),
        );
        let needle = b"elst";
        if let Some(pos) = moov.windows(needle.len()).position(|w| w == needle) {
            // Version/flags at pos+4..pos+8, entry_count at pos+8..pos+12
            moov[pos + 8..pos + 12].copy_from_slice(&999_999u32.to_be_bytes());
        }
        // parse_elst rejects the bogus header cleanly -> corrupt track is skipped safely without OOMing.
        let idx = parse_moov_subtitles(&moov).expect("moov stays valid");
        assert!(idx.has_text_tracks);
        assert!(idx.tables.is_empty());

        // Zero-duration shift with i32::MIN media_time does not overflow/panic.
        let moov_shift = build_synthetic_moov(
            b"tx3g",
            &[10, 12],
            &[(2, 1000)],
            Some(&[(0, i32::MIN, 1)]),
        );
        assert!(parse_moov_subtitles(&moov_shift).is_some());
    }

    #[test]
    fn elst_expansion_exceeding_max_samples_skips_track_safely() {
        // 600 samples repeated 1_000 times = 600_000 > MAX_MP4_SAMPLES (500_000) -> skipped safely.
        let sizes = vec![10u32; 600];
        let edits = vec![(600_000u32, 0i32, 1i16); 1_000];
        let moov = build_synthetic_moov(b"tx3g", &sizes, &[(600, 1000)], Some(&edits));
        let idx = parse_moov_subtitles(&moov).expect("moov skips oversized track");
        assert!(idx.has_text_tracks);
        assert!(idx.tables.is_empty());
    }

    #[test]
    fn dwell_edit_chapter_track_does_not_abort_valid_subtitle_track() {
        // Track 1: tx3g track with dwell edit (media_rate = 0 -> parse_elst returns None).
        let bad_moov = build_synthetic_moov(
            b"tx3g",
            &[10, 12],
            &[(2, 1000)],
            Some(&[(1000, 0, 0)]),
        );
        // Track 2: valid tx3g subtitle track.
        let good_moov = build_synthetic_moov(b"tx3g", &[10, 12, 14], &[(3, 1000)], None);

        let bad_root = Mp4Box {
            box_type: TYPE_MOOV,
            start: 0,
            end: bad_moov.len(),
            header_size: HEADER_SIZE,
        };
        let bad_trak = children(&bad_moov, bad_root)
            .unwrap()
            .into_iter()
            .find(|b| b.box_type == TYPE_TRAK)
            .unwrap();

        let good_root = Mp4Box {
            box_type: TYPE_MOOV,
            start: 0,
            end: good_moov.len(),
            header_size: HEADER_SIZE,
        };
        let good_children = children(&good_moov, good_root).unwrap();
        let good_mvhd = good_children.iter().find(|b| b.box_type == TYPE_MVHD).unwrap();
        let good_trak = good_children.iter().find(|b| b.box_type == TYPE_TRAK).unwrap();

        let mut body = Vec::new();
        body.extend_from_slice(&good_moov[good_mvhd.start..good_mvhd.end]);
        body.extend_from_slice(&bad_moov[bad_trak.start..bad_trak.end]);
        body.extend_from_slice(&good_moov[good_trak.start..good_trak.end]);
        let combined = {
            let mut out = Vec::with_capacity(8 + body.len());
            out.extend_from_slice(&((8 + body.len()) as u32).to_be_bytes());
            out.extend_from_slice(b"moov");
            out.extend_from_slice(&body);
            out
        };

        let idx = parse_moov_subtitles(&combined).expect("valid track survives bad chapter track");
        assert!(idx.has_text_tracks);
        assert_eq!(idx.tables.len(), 1);
        assert_eq!(idx.tables[0].timestamps_us.len(), 3);
    }

    #[test]
    fn parse_elst_supports_leading_dwell_entry_and_open_ended_tail() {
        let moov = build_synthetic_moov(
            b"tx3g",
            &[10, 12, 14],
            &[(3, 1000)],
            Some(&[(500, -1, 0), (0, 0, 1)]),
        );
        let idx = parse_moov_subtitles(&moov).expect("dwell + open-ended elst");
        assert_eq!(idx.tables.len(), 1);
        assert_eq!(idx.tables[0].timestamps_us, vec![500_000, 1_500_000, 2_500_000]);
    }
}
