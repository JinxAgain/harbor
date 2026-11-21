use super::capture::{CapturedAudio, TARGET_SAMPLE_RATE};
use super::{sanitize_https_url, SongResult, HTTP_CLIENT};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use realfft::{num_complex::Complex, RealFftPlanner, RealToComplex};
use serde_json::{json, Value};
use std::f64::consts::PI;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const FRAME_LENGTH: usize = 2048;
const HOP_LENGTH: usize = 128;
const BIN_COUNT: usize = FRAME_LENGTH / 2 + 1;
const HISTORY_LENGTH: usize = 256;

const PEAK_LAG: usize = 45;
const REFERENCE_LAG: usize = 48;
const FREQUENCY_NEIGHBOUR_DISTANCES: [usize; 4] = [2, 3, 6, 9];
const TIME_NEIGHBOUR_DISTANCES: [usize; 7] = [4, 7, 14, 21, 28, 35, 42];
const SPREAD_BACK_LAGS: [usize; 3] = [1, 3, 6];

const FIRST_PEAK_BIN: usize = 10;
const LAST_PEAK_BIN: usize = 1014;
const MIN_PEAK_POWER: f32 = 1.0 / 64.0;
const REFINED_BIN_HZ_NUMERATOR: u32 = 125;
const REFINED_BIN_HZ_DENOMINATOR: u32 = 1024;

const HEADER_LENGTH: usize = 48;
const HEADER_MAGIC: u32 = 0xcafe_2580;
const HEADER_SECOND_MAGIC: u32 = 0x9411_9c00;
const HEADER_FIXED_VALUE: u32 = 0x007c_0000;
const SAMPLE_RATE_ID_16K: u32 = 3 << 27;
const BODY_MAGIC: u32 = 0x4000_0000;
const BAND_MARKER_BASE: u32 = 0x6003_0040;
const FRAME_ESCAPE: u8 = 0xff;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Peak {
    frame: u32,
    magnitude: u16,
    refined_bin: u16,
}

#[derive(Clone)]
struct Frame {
    power: [f32; BIN_COUNT],
    spread: [f32; BIN_COUNT],
}

struct History {
    frames: Vec<Frame>,
    count: usize,
}

impl History {
    fn new() -> Self {
        let silence = Frame {
            power: [0.0; BIN_COUNT],
            spread: [0.0; BIN_COUNT],
        };
        Self {
            frames: vec![silence; HISTORY_LENGTH],
            count: 0,
        }
    }

    fn slot(&self, lag: usize) -> usize {
        (self.count + HISTORY_LENGTH - 1 - lag) % HISTORY_LENGTH
    }

    fn ago(&self, lag: usize) -> &Frame {
        &self.frames[self.slot(lag)]
    }

    fn ago_mut(&mut self, lag: usize) -> &mut Frame {
        let slot = self.slot(lag);
        &mut self.frames[slot]
    }
}

struct Spectrogram {
    fft: Arc<dyn RealToComplex<f32>>,
    window: Vec<f32>,
    samples: [i16; FRAME_LENGTH],
    time_buf: Vec<f32>,
    freq_buf: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    history: History,
    bands: [Vec<Peak>; 4],
}

impl Spectrogram {
    fn new() -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FRAME_LENGTH);
        let time_buf = fft.make_input_vec();
        let freq_buf = fft.make_output_vec();
        let scratch = fft.make_scratch_vec();

        Self {
            fft,
            window: hann_window(),
            samples: [0; FRAME_LENGTH],
            time_buf,
            freq_buf,
            scratch,
            history: History::new(),
            bands: [Vec::new(), Vec::new(), Vec::new(), Vec::new()],
        }
    }

    fn push_hop(&mut self, hop: &[i16]) -> Result<(), String> {
        self.samples.copy_within(HOP_LENGTH.., 0);
        self.samples[FRAME_LENGTH - HOP_LENGTH..].copy_from_slice(hop);

        let power = self.power_spectrum()?;
        let mut spread = power;
        for (bin, triple) in power.windows(3).enumerate() {
            spread[bin] = triple[0].max(triple[1]).max(triple[2]);
        }

        self.history.count += 1;
        for lag in SPREAD_BACK_LAGS {
            let earlier = &mut self.history.ago_mut(lag).spread;
            for (earlier_val, &val) in earlier.iter_mut().zip(&spread) {
                *earlier_val = earlier_val.max(val);
            }
        }

        *self.history.ago_mut(0) = Frame { power, spread };

        if self.history.count > PEAK_LAG {
            pick_peaks(&self.history, &mut self.bands);
        }
        Ok(())
    }

    fn power_spectrum(&mut self) -> Result<[f32; BIN_COUNT], String> {
        for (dst, (&sample, &weight)) in self
            .time_buf
            .iter_mut()
            .zip(self.samples.iter().zip(&self.window))
        {
            *dst = sample as f32 * weight;
        }

        self.fft
            .process_with_scratch(&mut self.time_buf, &mut self.freq_buf, &mut self.scratch)
            .map_err(|e| format!("FFT processing failed: {e}"))?;

        let mut power = [0.0f32; BIN_COUNT];
        for (dst, coeff) in power.iter_mut().zip(&self.freq_buf) {
            *dst = (coeff.norm_sqr() / 131_072.0).max(1e-10);
        }
        Ok(power)
    }
}

fn hann_window() -> Vec<f32> {
    let period = (FRAME_LENGTH + 1) as f64;
    (1..=FRAME_LENGTH)
        .map(|pos| (PI * pos as f64 / period).sin().powi(2) as f32)
        .collect()
}

fn log_magnitude(power: f32) -> f32 {
    power.ln().max(MIN_PEAK_POWER) * 1477.3 + 6144.0
}

fn refine_bin(bin: usize, below: f32, peak: f32, above: f32) -> Option<u16> {
    let curvature = peak * 2.0 - below - above;
    if curvature <= 0.0 {
        return None;
    }
    let vertex_offset = (above - below) * 32.0 / curvature;
    Some((bin as i32 * 64 + vertex_offset as i32).clamp(0, u16::MAX as i32) as u16)
}

fn band_for_hz(frequency_hz: u32) -> Option<usize> {
    match frequency_hz {
        250..=519 => Some(0),
        520..=1449 => Some(1),
        1450..=3499 => Some(2),
        3500..=5500 => Some(3),
        _ => None,
    }
}

fn pick_peaks(history: &History, bands: &mut [Vec<Peak>; 4]) {
    let frame = (history.count - 1 - PEAK_LAG) as u32;
    let candidate = &history.ago(PEAK_LAG).power;
    let reference = &history.ago(REFERENCE_LAG).spread;

    let time_neighbours: Vec<&[f32; BIN_COUNT]> = TIME_NEIGHBOUR_DISTANCES
        .iter()
        .flat_map(|distance| [REFERENCE_LAG - distance, REFERENCE_LAG + distance])
        .map(|lag| &history.ago(lag).spread)
        .collect();

    for bin in FIRST_PEAK_BIN..=LAST_PEAK_BIN {
        let power = candidate[bin];
        let below = bin - 1;
        if power < MIN_PEAK_POWER || power < reference[below] {
            continue;
        }

        let beats_frequency = FREQUENCY_NEIGHBOUR_DISTANCES
            .iter()
            .all(|d| power > reference[below - d] && power > reference[below + d]);
        if !beats_frequency {
            continue;
        }

        let beats_time = time_neighbours.iter().all(|other| power > other[below]);
        if !beats_time {
            continue;
        }

        let magnitude = log_magnitude(power);
        let Some(refined_bin) = refine_bin(
            bin,
            log_magnitude(candidate[bin - 1]),
            magnitude,
            log_magnitude(candidate[bin + 1]),
        ) else {
            continue;
        };

        let frequency_hz =
            u32::from(refined_bin) * REFINED_BIN_HZ_NUMERATOR / REFINED_BIN_HZ_DENOMINATOR;
        let Some(band_idx) = band_for_hz(frequency_hz) else {
            continue;
        };

        bands[band_idx].push(Peak {
            frame,
            magnitude: magnitude.clamp(0.0, u16::MAX as f32) as u16,
            refined_bin,
        });
    }
}

fn encode_peaks(peaks: &[Peak]) -> Vec<u8> {
    let mut encoded = Vec::with_capacity(peaks.len() * 5);
    let mut prev_frame = 0u32;

    for peak in peaks {
        let mut delta = peak.frame.saturating_sub(prev_frame);
        if delta >= u32::from(FRAME_ESCAPE) {
            encoded.push(FRAME_ESCAPE);
            encoded.extend_from_slice(&peak.frame.to_le_bytes());
            delta = 0;
        }
        encoded.push(delta as u8);
        encoded.extend_from_slice(&peak.magnitude.to_le_bytes());
        encoded.extend_from_slice(&peak.refined_bin.to_le_bytes());
        prev_frame = peak.frame;
    }

    encoded
}

fn encode_signature_bytes(sample_count: usize, bands: &[Vec<Peak>; 4]) -> Vec<u8> {
    let mut body = Vec::new();
    for (band_idx, peaks) in bands.iter().enumerate() {
        if peaks.is_empty() {
            continue;
        }
        let encoded = encode_peaks(peaks);
        body.extend_from_slice(&(BAND_MARKER_BASE + band_idx as u32).to_le_bytes());
        body.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
        body.extend_from_slice(&encoded);
        body.resize(body.len().next_multiple_of(4), 0);
    }

    let body_length = (body.len() + 8) as u32;
    let padded_sample_count =
        (sample_count as u32).saturating_add(TARGET_SAMPLE_RATE * 24 / 100);

    let words = [
        HEADER_MAGIC,
        0,
        body_length,
        HEADER_SECOND_MAGIC,
        0,
        0,
        0,
        SAMPLE_RATE_ID_16K,
        0,
        0,
        padded_sample_count,
        HEADER_FIXED_VALUE,
        BODY_MAGIC,
        body_length,
    ];

    let mut signature = Vec::with_capacity(HEADER_LENGTH + body_length as usize);
    for word in words {
        signature.extend_from_slice(&word.to_le_bytes());
    }
    signature.extend_from_slice(&body);

    let crc = crc32fast::hash(&signature[8..]);
    signature[4..8].copy_from_slice(&crc.to_le_bytes());
    signature
}

pub fn generate_signature(samples_16k: &[i16]) -> Result<(String, u32), String> {
    if samples_16k.len() < FRAME_LENGTH {
        return Err("Audio clip is too short for acoustic fingerprinting".to_string());
    }

    let mut spectrogram = Spectrogram::new();
    for hop in samples_16k.chunks_exact(HOP_LENGTH) {
        spectrogram.push_hop(hop)?;
    }

    let payload = encode_signature_bytes(samples_16k.len(), &spectrogram.bands);
    let duration_ms = (samples_16k.len() as f32 / TARGET_SAMPLE_RATE as f32 * 1000.0) as u32;
    Ok((
        format!("data:audio/vnd.shazam.sig;base64,{}", B64.encode(payload)),
        duration_ms,
    ))
}

pub(crate) fn parse_response(status: u16, raw: &str) -> Result<Option<SongResult>, String> {
    if status == 429 {
        return Err(
            "Shazam rate limit reached. Wait a moment or switch provider in Settings.".to_string(),
        );
    }
    if !(200..300).contains(&status) {
        return Err(format!("Shazam returned HTTP {status}"));
    }

    let json: Value =
        serde_json::from_str(raw).map_err(|e| format!("Shazam response was unreadable: {e}"))?;
    let matches_empty = json["matches"]
        .as_array()
        .map(|items| items.is_empty())
        .unwrap_or(true);
    let track = &json["track"];
    if matches_empty && track.is_null() {
        return Ok(None);
    }
    let title = track["title"].as_str().unwrap_or("").trim().to_string();
    let artist = track["subtitle"].as_str().unwrap_or("").trim().to_string();
    if title.is_empty() && artist.is_empty() {
        return Ok(None);
    }

    let mut album = String::new();
    if let Some(sections) = track["sections"].as_array() {
        for section in sections {
            if let Some(meta) = section["metadata"].as_array() {
                for entry in meta {
                    if entry["title"].as_str() == Some("Album") {
                        if let Some(text) = entry["text"].as_str() {
                            album = text.trim().to_string();
                            break;
                        }
                    }
                }
            }
            if !album.is_empty() {
                break;
            }
        }
    }

    let artwork = sanitize_https_url(
        track["images"]["coverarthq"]
            .as_str()
            .or_else(|| track["images"]["coverart"].as_str())
            .unwrap_or(""),
    );
    let link = sanitize_https_url(
        track["url"]
            .as_str()
            .or_else(|| track["share"]["href"].as_str())
            .unwrap_or(""),
    );

    Ok(Some(SongResult {
        title,
        artist,
        album,
        artwork,
        link,
        provider: "shazam".to_string(),
    }))
}

pub async fn recognize(audio: &CapturedAudio) -> Result<Option<SongResult>, String> {
    let (uri, sample_ms) = generate_signature(&audio.samples_16k)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let uuid1 = Uuid::new_v4().to_string().to_uppercase();
    let uuid2 = Uuid::new_v4().to_string().to_uppercase();
    let url = format!(
        "https://amp.shazam.com/discovery/v5/en-US/US/iphone/-/tag/{uuid1}/{uuid2}?sync=true&webv3=true&sampling=true&connected=&shazamapiversion=v3&sharehub=true&hubv5minorversion=v5.1&hidelb=true&video=v3"
    );

    let body = json!({
        "signature": {
            "samplems": sample_ms,
            "uri": uri,
        },
        "timestamp": timestamp,
        "timezone": "Europe/Paris",
    });

    let resp = HTTP_CLIENT
        .post(&url)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US")
        .header("X-Shazam-Platform", "IPHONE")
        .header("X-Shazam-AppVersion", "14.1.0")
        .header(
            "User-Agent",
            "Dalvik/2.1.0 (Linux; U; Android 6.0.1; SM-G920F Build/MMB29K)",
        )
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Shazam: {e}"))?;

    let status = resp.status().as_u16();
    let raw = resp
        .text()
        .await
        .map_err(|e| format!("Could not read Shazam reply: {e}"))?;
    parse_response(status, &raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_u32(bytes: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
    }

    #[test]
    fn signature_has_valid_header_crc_and_frequency_bands() {
        // Synthesize 7 seconds with tones in all four frequency bands so every band collects peaks.
        let samples: Vec<i16> = (0..(TARGET_SAMPLE_RATE as usize * 7))
            .map(|i| {
                let t = i as f64 / TARGET_SAMPLE_RATE as f64;
                let amp = 0.5 + 0.5 * (2.0 * PI * 1.5 * t).sin();
                let s = (2.0 * PI * 360.0 * t).sin()
                    + (2.0 * PI * 980.0 * t).sin()
                    + (2.0 * PI * 2200.0 * t).sin()
                    + 0.8 * (2.0 * PI * 4200.0 * t).sin();
                (s * amp * 4000.0) as i16
            })
            .collect();

        let (uri, duration_ms) = generate_signature(&samples).expect("signature");
        assert_eq!(duration_ms, 7000);
        let b64 = uri
            .strip_prefix("data:audio/vnd.shazam.sig;base64,")
            .expect("data uri prefix");
        let raw = B64.decode(b64).expect("valid base64");
        assert!(raw.len() > HEADER_LENGTH + 8);
        assert_eq!(read_u32(&raw, 0), HEADER_MAGIC);
        assert_eq!(read_u32(&raw, 4), crc32fast::hash(&raw[8..]));
        // Both body-length fields equal bytes after the 48-byte header.
        let body_len = raw.len() - HEADER_LENGTH;
        assert_eq!(read_u32(&raw, 8) as usize, body_len);
        assert_eq!(read_u32(&raw, HEADER_LENGTH + 4) as usize, body_len);
        assert_eq!(read_u32(&raw, 12), HEADER_SECOND_MAGIC);
        assert_eq!(read_u32(&raw, 28), SAMPLE_RATE_ID_16K);
        assert_eq!(
            read_u32(&raw, 40) as usize,
            samples.len() + 3840
        );
        assert_eq!(read_u32(&raw, 44), HEADER_FIXED_VALUE);
        assert_eq!(read_u32(&raw, HEADER_LENGTH), BODY_MAGIC);
    }

    #[test]
    fn encode_peaks_escapes_large_frame_gaps_with_trailing_zero_delta() {
        let bands = [
            vec![
                Peak {
                    frame: 0,
                    magnitude: 0x1234,
                    refined_bin: 0x5678,
                },
                Peak {
                    frame: 300,
                    magnitude: 0x0003,
                    refined_bin: 0x0004,
                },
            ],
            Vec::new(),
            Vec::new(),
            Vec::new(),
        ];

        let encoded = encode_signature_bytes(128_000, &bands);
        let first_band = HEADER_LENGTH + 8;
        assert_eq!(read_u32(&encoded, first_band), BAND_MARKER_BASE);
        // Peak 1 (5 bytes) + escape (1) + frame u32 (4) + delta zero (1) + mag (2) + bin (2) = 15 bytes -> padded to 16.
        assert_eq!(read_u32(&encoded, first_band + 4), 15);
        assert_eq!(encoded.len(), first_band + 8 + 16);
        assert_eq!(*encoded.last().unwrap(), 0);

        let second_peak = first_band + 8 + 5;
        let mut expected = vec![FRAME_ESCAPE];
        expected.extend_from_slice(&300u32.to_le_bytes());
        expected.extend_from_slice(&[0, 3, 0, 4, 0]);
        assert_eq!(&encoded[second_peak..second_peak + 10], expected.as_slice());
    }

    #[test]
    fn parse_response_extracts_metadata_and_sanitizes_urls() {
        let body = r#"{
            "matches": [{"id": "123"}],
            "track": {
                "title": "Running Up That Hill",
                "subtitle": "Kate Bush",
                "url": "https://www.shazam.com/track/123",
                "images": {
                    "coverarthq": "https://is1.mzstatic.com/image/thumb/cover.jpg"
                },
                "sections": [
                    {
                        "type": "SONG",
                        "metadata": [
                            {"title": "Album", "text": "Hounds of Love"}
                        ]
                    }
                ]
            }
        }"#;
        let song = parse_response(200, body)
            .expect("ok")
            .expect("some song");
        assert_eq!(song.title, "Running Up That Hill");
        assert_eq!(song.artist, "Kate Bush");
        assert_eq!(song.album, "Hounds of Love");
        assert_eq!(
            song.artwork,
            "https://is1.mzstatic.com/image/thumb/cover.jpg"
        );
        assert_eq!(song.link, "https://www.shazam.com/track/123");
        assert_eq!(song.provider, "shazam");
    }

    #[test]
    fn parse_response_handles_empty_matches_and_rate_limits() {
        assert!(parse_response(200, r#"{"matches":[]}"#)
            .expect("ok")
            .is_none());
        let err = parse_response(429, "Too Many Requests").unwrap_err();
        assert!(err.contains("rate limit"));
        assert!(parse_response(503, "unavailable").is_err());
    }
}
