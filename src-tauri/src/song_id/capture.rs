use std::f64::consts::PI;

pub const TARGET_SAMPLE_RATE: u32 = 16_000;

pub struct CapturedAudio {
    pub samples_16k: Vec<i16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleEncoding {
    Float32,
    Int16,
    Int24,
    Int32,
}

pub fn ensure_audible(samples_16k: &[i16]) -> Result<(), String> {
    if samples_16k.is_empty() {
        return Err(
            "Harbor heard silence on your default playback device. Play the scene with sound, and make sure Windows is playing it through the device set as default."
                .to_string(),
        );
    }
    let mut peak = 0i32;
    let mut energy = 0f64;
    let mut active_samples = 0usize;
    for &sample in samples_16k {
        let abs = (sample as i32).abs();
        if abs > peak {
            peak = abs;
        }
        if abs >= 40 {
            active_samples += 1;
        }
        let s = sample as f64;
        energy += s * s;
    }
    let rms = (energy / samples_16k.len() as f64).sqrt();
    let min_active = (samples_16k.len() / 100).max(1);
    // Require peak, RMS, and sustained active density so isolated DC clicks cannot bypass silence detection.
    if peak < 180 || rms < 25.0 || active_samples < min_active {
        return Err(
            "Harbor heard silence on your default playback device. Play the scene with sound, and make sure Windows is playing it through the device set as default."
                .to_string(),
        );
    }
    Ok(())
}

struct BiquadLowPass {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: f64,
    z2: f64,
}

impl BiquadLowPass {
    fn new(cutoff_hz: f64, sample_rate_hz: f64) -> Self {
        let k = (PI * cutoff_hz / sample_rate_hz).tan();
        let norm = 1.0 / (1.0 + std::f64::consts::SQRT_2 * k + k * k);
        let b0 = k * k * norm;
        let b1 = 2.0 * b0;
        let b2 = b0;
        let a1 = 2.0 * (k * k - 1.0) * norm;
        let a2 = (1.0 - std::f64::consts::SQRT_2 * k + k * k) * norm;
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, input: f64) -> f64 {
        let out = input * self.b0 + self.z1;
        self.z1 = input * self.b1 + self.z2 - self.a1 * out;
        self.z2 = input * self.b2 - self.a2 * out;
        out
    }
}

pub fn downmix_and_resample_to_16k(samples: &[f32], src_rate: u32, channels: u16) -> Vec<i16> {
    let ch = channels.max(1) as usize;
    let src_frames = samples.len() / ch;
    if src_frames == 0 || src_rate == 0 {
        return Vec::new();
    }

    let mut mono = Vec::with_capacity(src_frames);
    let inv_ch = 1.0 / ch as f32;
    for frame in samples.chunks_exact(ch) {
        let sum: f32 = frame.iter().copied().sum();
        mono.push(sum * inv_ch);
    }

    if src_rate == TARGET_SAMPLE_RATE {
        return mono
            .into_iter()
            .map(|s| (s.clamp(-1.0, 1.0) * 32767.0).round() as i16)
            .collect();
    }

    if src_rate > TARGET_SAMPLE_RATE {
        // Low-pass filter below Nyquist (8 kHz) before downsampling to prevent aliasing into Shazam bands.
        let mut lpf = BiquadLowPass::new(7_200.0, src_rate as f64);
        for sample in &mut mono {
            *sample = lpf.process(*sample as f64) as f32;
        }
    }

    let out_len = ((src_frames as u64) * (TARGET_SAMPLE_RATE as u64) / (src_rate as u64)) as usize;
    let mut out = Vec::with_capacity(out_len);
    let step = src_rate as f64 / TARGET_SAMPLE_RATE as f64;
    for i in 0..out_len {
        let pos = i as f64 * step;
        let idx = pos as usize;
        let frac = (pos - idx as f64) as f32;
        let a = mono[idx];
        let b = mono.get(idx + 1).copied().unwrap_or(a);
        let interp = a + (b - a) * frac;
        out.push((interp.clamp(-1.0, 1.0) * 32767.0).round() as i16);
    }
    out
}

pub fn encode_wav_16k_mono(samples: &[i16]) -> Result<Vec<u8>, String> {
    let data_bytes = samples
        .len()
        .checked_mul(2)
        .and_then(|len| u32::try_from(len).ok())
        .ok_or_else(|| "Audio clip is too large to encode as WAV".to_string())?;
    let riff_size = data_bytes
        .checked_add(36)
        .ok_or_else(|| "Audio clip is too large to encode as WAV".to_string())?;

    let mut out = Vec::with_capacity(44 + data_bytes as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&riff_size.to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // PCM fmt chunk size
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM format tag
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&TARGET_SAMPLE_RATE.to_le_bytes());
    out.extend_from_slice(&(TARGET_SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_bytes.to_le_bytes());
    for &sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(out)
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::mem::{size_of, ManuallyDrop};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, RPC_E_CHANGED_MODE, WAIT_OBJECT_0};
    use windows::Win32::Media::Audio::{
        ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
        IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
        IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator, MMDeviceEnumerator,
        AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
        AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        WAVEFORMATEX, WAVEFORMATEXTENSIBLE, WAVE_FORMAT_PCM,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IAgileObject,
        IAgileObject_Impl, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};
    use windows::Win32::System::Variant::VT_BLOB;
    use windows::core::{implement, Interface, GUID, HRESULT, PCWSTR};

    const WAVE_FORMAT_IEEE_FLOAT_TAG: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE_TAG: u16 = 0xfffe;
    const SUBTYPE_PCM: GUID = GUID::from_u128(0x00000001_0000_0010_8000_00aa00389b71);
    const SUBTYPE_IEEE_FLOAT: GUID = GUID::from_u128(0x00000003_0000_0010_8000_00aa00389b71);
    const BUFFER_DURATION_100NS: i64 = 1_000_000; // 100 ms shared loopback ring buffer
    const PROCESS_SILENT_ABORT_MS: u64 = 1_200;

    #[derive(Clone, Copy)]
    struct AudioFormat {
        sample_rate: u32,
        channels: u16,
        block_align: usize,
        encoding: SampleEncoding,
    }

    struct CoUninitGuard(bool);

    impl Drop for CoUninitGuard {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    struct HandleGuard(HANDLE);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_invalid() {
                let _ = unsafe { CloseHandle(self.0) };
            }
        }
    }

    struct StreamGuard<'a>(&'a IAudioClient);

    impl Drop for StreamGuard<'_> {
        fn drop(&mut self) {
            let _ = unsafe { self.0.Stop() };
        }
    }

    struct MixFormatPtr(*mut WAVEFORMATEX);

    impl Drop for MixFormatPtr {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CoTaskMemFree(Some(self.0.cast())) };
            }
        }
    }

    #[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
    struct ActivationSignal {
        event_raw: usize,
    }

    impl IAgileObject_Impl for ActivationSignal_Impl {}

    impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationSignal_Impl {
        fn ActivateCompleted(
            &self,
            _activateoperation: windows::core::Ref<IActivateAudioInterfaceAsyncOperation>,
        ) -> windows::core::Result<()> {
            unsafe { SetEvent(HANDLE(self.event_raw as *mut _)) }
        }
    }

    fn init_com_mta() -> Result<CoUninitGuard, String> {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_ok() {
            Ok(CoUninitGuard(true))
        } else if hr == RPC_E_CHANGED_MODE {
            Err("COM apartment mode conflict on capture thread".to_string())
        } else {
            Err(format!("COM initialization failed: {hr:?}"))
        }
    }

    fn decode_samples(
        bytes: &[u8],
        frames: usize,
        channels: usize,
        block_align: usize,
        encoding: SampleEncoding,
        out: &mut Vec<f32>,
    ) {
        let bytes_per_sample = block_align / channels.max(1);
        for frame_idx in 0..frames {
            let frame_start = frame_idx * block_align;
            for ch_idx in 0..channels {
                let offset = frame_start + ch_idx * bytes_per_sample;
                let sample = match encoding {
                    SampleEncoding::Float32 => {
                        if offset + 4 <= bytes.len() {
                            f32::from_le_bytes([
                                bytes[offset],
                                bytes[offset + 1],
                                bytes[offset + 2],
                                bytes[offset + 3],
                            ])
                        } else {
                            0.0
                        }
                    }
                    SampleEncoding::Int16 => {
                        if offset + 2 <= bytes.len() {
                            i16::from_le_bytes([bytes[offset], bytes[offset + 1]]) as f32 / 32768.0
                        } else {
                            0.0
                        }
                    }
                    SampleEncoding::Int24 => {
                        if offset + 3 <= bytes.len() {
                            let val = ((bytes[offset] as i32) << 8)
                                | ((bytes[offset + 1] as i32) << 16)
                                | ((bytes[offset + 2] as i32) << 24);
                            (val >> 8) as f32 / 8_388_608.0
                        } else {
                            0.0
                        }
                    }
                    SampleEncoding::Int32 => {
                        if offset + 4 <= bytes.len() {
                            i32::from_le_bytes([
                                bytes[offset],
                                bytes[offset + 1],
                                bytes[offset + 2],
                                bytes[offset + 3],
                            ]) as f32
                                / 2_147_483_648.0
                        } else {
                            0.0
                        }
                    }
                };
                out.push(sample);
            }
        }
    }

    fn drain_client(
        client: &IAudioClient,
        format: AudioFormat,
        seconds: u32,
        abort_if_silent_early: bool,
    ) -> Result<CapturedAudio, String> {
        let event_handle = unsafe { CreateEventW(None, false, false, PCWSTR::null()) }
            .map_err(|e| format!("CreateEventW failed: {e}"))?;
        let event_guard = HandleGuard(event_handle);
        unsafe { client.SetEventHandle(event_guard.0) }
            .map_err(|e| format!("SetEventHandle failed: {e}"))?;

        let capture_client: IAudioCaptureClient = unsafe { client.GetService() }
            .map_err(|e| format!("GetService(IAudioCaptureClient) failed: {e}"))?;

        unsafe { client.Start() }.map_err(|e| format!("WASAPI start failed: {e}"))?;
        let _stream_guard = StreamGuard(client);

        let target_frames = format.sample_rate as usize * seconds as usize;
        let channels = format.channels as usize;
        let mut captured_frames = 0usize;
        let mut samples_f32 = Vec::with_capacity(target_frames * channels);
        let mut saw_non_silent_packet = false;

        let started = Instant::now();
        let deadline = started + Duration::from_secs(seconds as u64 + 2);

        while captured_frames < target_frames && Instant::now() < deadline {
            loop {
                let next_frames = unsafe { capture_client.GetNextPacketSize() }
                    .map_err(|e| format!("GetNextPacketSize failed: {e}"))?;
                if next_frames == 0 {
                    break;
                }

                let mut data_ptr = std::ptr::null_mut();
                let mut frames_read = 0u32;
                let mut flags = 0u32;
                unsafe {
                    capture_client.GetBuffer(
                        &mut data_ptr,
                        &mut frames_read,
                        &mut flags,
                        None,
                        None,
                    )
                }
                .map_err(|e| format!("GetBuffer failed: {e}"))?;

                let frames_usize = frames_read as usize;
                let is_silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0;
                if frames_usize > 0 {
                    if is_silent || data_ptr.is_null() {
                        samples_f32.resize(samples_f32.len() + frames_usize * channels, 0.0);
                    } else {
                        let byte_len = frames_usize * format.block_align;
                        let slice = unsafe { std::slice::from_raw_parts(data_ptr, byte_len) };
                        let prev_len = samples_f32.len();
                        decode_samples(
                            slice,
                            frames_usize,
                            channels,
                            format.block_align,
                            format.encoding,
                            &mut samples_f32,
                        );
                        if samples_f32[prev_len..]
                            .iter()
                            .any(|sample| sample.abs() > 0.002)
                        {
                            saw_non_silent_packet = true;
                        }
                    }
                    captured_frames += frames_usize;
                }

                unsafe { capture_client.ReleaseBuffer(frames_read) }
                    .map_err(|e| format!("ReleaseBuffer failed: {e}"))?;

                if captured_frames >= target_frames {
                    break;
                }
            }

            if captured_frames >= target_frames {
                break;
            }

            if abort_if_silent_early
                && !saw_non_silent_packet
                && started.elapsed() >= Duration::from_millis(PROCESS_SILENT_ABORT_MS)
            {
                return Err("process_loopback_silent".to_string());
            }

            let wait = unsafe { WaitForSingleObject(event_guard.0, 250) };
            let _ = wait == WAIT_OBJECT_0;
        }

        let min_frames = (format.sample_rate as usize) * (seconds.min(3) as usize);
        if captured_frames < min_frames {
            let got_secs = captured_frames as f32 / format.sample_rate.max(1) as f32;
            return Err(format!(
                "Harbor only captured {got_secs:.1}s before your playback device went quiet. Keep the scene playing while Harbor listens."
            ));
        }

        let keep_samples = (target_frames * channels).min(samples_f32.len());
        let samples_16k =
            downmix_and_resample_to_16k(&samples_f32[..keep_samples], format.sample_rate, format.channels);
        Ok(CapturedAudio { samples_16k })
    }

    fn capture_process_loopback(seconds: u32) -> Result<CapturedAudio, String> {
        let ready_event = unsafe { CreateEventW(None, true, false, PCWSTR::null()) }
            .map_err(|e| format!("CreateEventW failed: {e}"))?;
        let ready_guard = HandleGuard(ready_event);

        let handler: IActivateAudioInterfaceCompletionHandler = ActivationSignal {
            event_raw: ready_guard.0 .0 as usize,
        }
        .into();

        let mut activation_params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: std::process::id(),
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };

        // Never drop this PROPVARIANT: its BLOB pointer points to stack memory rather than CoTaskMem.
        let propvariant = ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: (&mut activation_params
                                as *mut AUDIOCLIENT_ACTIVATION_PARAMS)
                                .cast(),
                        },
                    },
                }),
            },
        });

        let op = unsafe {
            ActivateAudioInterfaceAsync(
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
                &IAudioClient::IID,
                Some(&*propvariant),
                &handler,
            )
        }
        .map_err(|e| format!("ActivateAudioInterfaceAsync failed: {e}"))?;

        if unsafe { WaitForSingleObject(ready_guard.0, 2000) } != WAIT_OBJECT_0 {
            return Err("Process loopback activation timed out".to_string());
        }

        let mut hr = HRESULT(0);
        let mut activated = None;
        unsafe { op.GetActivateResult(&mut hr, &mut activated) }
            .map_err(|e| format!("GetActivateResult failed: {e}"))?;
        hr.ok()
            .map_err(|e| format!("Process loopback activation error: {e}"))?;
        let client: IAudioClient = activated
            .ok_or_else(|| "Process loopback returned empty audio client".to_string())?
            .cast()
            .map_err(|e| format!("Cast to IAudioClient failed: {e}"))?;

        // Process loopback virtual devices reject GetMixFormat with E_NOTIMPL; pass a standard stereo PCM format.
        let sample_rate = 48_000u32;
        let channels = 2u16;
        let block_align = channels * 2;
        let wfx = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_PCM as u16,
            nChannels: channels,
            nSamplesPerSec: sample_rate,
            nAvgBytesPerSec: sample_rate * block_align as u32,
            nBlockAlign: block_align,
            wBitsPerSample: 16,
            cbSize: 0,
        };
        let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK
            | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                BUFFER_DURATION_100NS,
                0,
                &wfx,
                None,
            )
        }
        .map_err(|e| format!("Process loopback Initialize failed: {e}"))?;

        let audio = drain_client(
            &client,
            AudioFormat {
                sample_rate,
                channels,
                block_align: block_align as usize,
                encoding: SampleEncoding::Int16,
            },
            seconds,
            true,
        )?;
        ensure_audible(&audio.samples_16k)?;
        Ok(audio)
    }

    fn parse_mix_format(ptr: *const WAVEFORMATEX) -> Result<AudioFormat, String> {
        let base = unsafe { ptr.read_unaligned() };
        let channels = base.nChannels;
        let sample_rate = base.nSamplesPerSec;
        let block_align = base.nBlockAlign as usize;
        let bits = base.wBitsPerSample;
        let format_tag = base.wFormatTag;
        let cb_size = base.cbSize;

        let encoding = if format_tag == WAVE_FORMAT_IEEE_FLOAT_TAG && bits == 32 {
            SampleEncoding::Float32
        } else if format_tag == WAVE_FORMAT_PCM as u16 {
            match bits {
                16 => SampleEncoding::Int16,
                24 => SampleEncoding::Int24,
                32 => SampleEncoding::Int32,
                _ => return Err(format!("Unsupported PCM bit depth: {bits}")),
            }
        } else if format_tag == WAVE_FORMAT_EXTENSIBLE_TAG && cb_size >= 22 {
            let ext = unsafe { (ptr as *const WAVEFORMATEXTENSIBLE).read_unaligned() };
            let subformat = ext.SubFormat;
            if subformat == SUBTYPE_IEEE_FLOAT && bits == 32 {
                SampleEncoding::Float32
            } else if subformat == SUBTYPE_PCM {
                match bits {
                    16 => SampleEncoding::Int16,
                    24 => SampleEncoding::Int24,
                    32 => SampleEncoding::Int32,
                    _ => return Err(format!("Unsupported extensible PCM bit depth: {bits}")),
                }
            } else {
                return Err("Unsupported extensible WASAPI sample format".to_string());
            }
        } else {
            return Err(format!("Unsupported WASAPI format tag: {format_tag}"));
        };

        Ok(AudioFormat {
            sample_rate,
            channels,
            block_align,
            encoding,
        })
    }

    fn capture_default_loopback(seconds: u32) -> Result<CapturedAudio, String> {
        let enumerator: IMMDeviceEnumerator =
            unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
                .map_err(|e| format!("MMDeviceEnumerator failed: {e}"))?;
        let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
            .map_err(|e| format!("GetDefaultAudioEndpoint failed: {e}"))?;
        let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
            .map_err(|e| format!("AudioClient activation failed: {e}"))?;

        let raw_fmt = unsafe { client.GetMixFormat() }
            .map_err(|e| format!("GetMixFormat failed: {e}"))?;
        let _fmt_guard = MixFormatPtr(raw_fmt);
        let format = parse_mix_format(raw_fmt)?;

        // Shared loopback using the device's native mix format without AUTOCONVERTPCM avoids
        // the Windows 11 24H2 silent-buffer conversion bug.
        let stream_flags = AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        unsafe {
            client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                stream_flags,
                BUFFER_DURATION_100NS,
                0,
                raw_fmt,
                None,
            )
        }
        .map_err(|e| format!("WASAPI Initialize failed: {e}"))?;

        drain_client(&client, format, seconds, false)
    }

    // Pull in eConsole / eRender cleanly inside the inner module.
    use windows::Win32::Media::Audio::{eConsole, eRender};

    pub async fn capture_audio(seconds: u32) -> Result<CapturedAudio, String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        std::thread::Builder::new()
            .name("harbor-song-id-capture".to_string())
            .spawn(move || {
                let res = (|| -> Result<CapturedAudio, String> {
                    let _com = init_com_mta()?;
                    match capture_process_loopback(seconds) {
                        Ok(audio) => Ok(audio),
                        Err(_) => capture_default_loopback(seconds),
                    }
                })();
                let _ = tx.send(res);
            })
            .map_err(|e| format!("Failed to start audio capture thread: {e}"))?;

        rx.await
            .map_err(|_| "Audio capture thread terminated unexpectedly".to_string())?
    }
}

#[cfg(windows)]
pub use win::capture_audio;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_audible_rejects_silence_and_single_dc_clicks() {
        assert!(ensure_audible(&[]).is_err());
        assert!(ensure_audible(&vec![0i16; 16_000]).is_err());

        // Single loud click in 1 second of silence has high peak but tiny RMS.
        let mut click = vec![0i16; 16_000];
        click[500] = 12_000;
        assert!(ensure_audible(&click).is_err());

        // Real audible tone passes both peak and RMS thresholds.
        let tone: Vec<i16> = (0..16_000)
            .map(|i| ((2.0 * PI * 440.0 * i as f64 / 16_000.0).sin() * 4000.0) as i16)
            .collect();
        assert!(ensure_audible(&tone).is_ok());
    }

    #[test]
    fn downmix_and_resample_converts_48k_stereo_to_16k_mono_preserving_duration_and_pitch() {
        let src_rate = 48_000u32;
        let duration_secs = 2usize;
        let frames = src_rate as usize * duration_secs;
        let mut stereo = Vec::with_capacity(frames * 2);
        for i in 0..frames {
            let s = (2.0 * PI * 1000.0 * i as f64 / src_rate as f64).sin() as f32 * 0.6;
            stereo.push(s);
            stereo.push(s);
        }

        let out = downmix_and_resample_to_16k(&stereo, src_rate, 2);
        assert_eq!(out.len(), TARGET_SAMPLE_RATE as usize * duration_secs);
        assert!(ensure_audible(&out).is_ok());

        // Count positive-going zero crossings over the second half (past filter warmup) to verify 1 kHz pitch.
        let slice = &out[16_000..];
        let crossings = slice
            .windows(2)
            .filter(|w| w[0] <= 0 && w[1] > 0)
            .count();
        assert!(
            (995..=1005).contains(&crossings),
            "expected ~1000 crossings, got {crossings}"
        );
    }

    #[test]
    fn encode_wav_16k_mono_writes_valid_riff_header_and_size() {
        let samples = vec![123i16, -456i16, 789i16];
        let wav = encode_wav_16k_mono(&samples).expect("wav");
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]),
            16_000
        );
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(
            u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]),
            6
        );
        assert_eq!(wav.len(), 50);
    }
}
