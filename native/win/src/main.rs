// odak-capture (Windows). Same protocol and output files as the macOS helper:
//   odak-capture record --out DIR --fps 60 --bounds x,y,w,h --scale 1.5 [--system-audio] [--mic]
//   stdout: JSON lines {"event":"started"} … {"event":"finished", …} | {"event":"error", …}
//   stdin:  "stop" (or EOF) ends the recording.
// Screen: Windows Graphics Capture with the cursor disabled, H.264 MP4 via Media Foundation.
// Cursor: GetCursorPos / GetAsyncKeyState polled every ~4 ms. Audio: WASAPI loopback (system)
// and default capture device (mic) written as 16-bit WAV. Everything is stamped with QPC time,
// the clock Windows Graphics Capture uses for frame timestamps.

use serde::Serialize;
use serde_json::json;
use std::io::Write;

mod wav;

pub fn emit(v: serde_json::Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

#[derive(Serialize, Clone, Copy)]
pub struct CursorSample { pub t: f64, pub x: f64, pub y: f64 }
#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ClickEvent { pub t: f64, pub x: f64, pub y: f64, pub is_down: bool, pub button: u8 }
#[derive(Serialize, Default)]
pub struct CursorTrack { pub samples: Vec<CursorSample>, pub clicks: Vec<ClickEvent> }

#[cfg(not(windows))]
fn main() {
    emit(json!({"event": "error", "message": "Bu yardımcı yalnızca Windows içindir."}));
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("record") => {
            if let Err(e) = win::record(&args) {
                emit(json!({"event": "error", "message": e}));
                std::process::exit(1);
            }
            std::process::exit(0);
        }
        Some("permission") => { emit(json!({"event": "permission", "granted": true})); }
        _ => { emit(json!({"event": "error", "message": "kullanım: odak-capture record|permission"})); std::process::exit(2); }
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::wav::WavWriter;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::{MonitorFromPoint, MONITOR_DEFAULTTONEAREST};
    use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON};
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
    use windows_capture::encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType};
    use windows_capture::frame::Frame;
    use windows_capture::graphics_capture_api::InternalCaptureControl;
    use windows_capture::monitor::Monitor;
    use windows_capture::settings::{
        ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings, MinimumUpdateIntervalSettings,
        SecondaryWindowSettings, Settings,
    };

    /// QPC time in 100 ns units (the unit of SystemRelativeTime and WASAPI's QPC positions).
    pub fn qpc_100ns() -> i64 {
        let (mut c, mut f) = (0i64, 0i64);
        unsafe { let _ = QueryPerformanceCounter(&mut c); let _ = QueryPerformanceFrequency(&mut f); }
        ((c as i128) * 10_000_000 / (f.max(1) as i128)) as i64
    }

    /// State shared by the capture, cursor and audio threads.
    pub struct Shared {
        pub t0: AtomicI64, // QPC (100 ns) of the first video frame; 0 until known
        pub frames: AtomicU64,
        pub last: AtomicI64, // timestamp of the latest video frame sent to the encoder
        pub stop: AtomicBool,
        pub error: Mutex<Option<String>>,
    }

    struct Flags { shared: Arc<Shared>, path: PathBuf, width: u32, height: u32, fps: u32, hevc: bool }

    struct Handler { encoder: Option<VideoEncoder>, shared: Arc<Shared> }

    impl GraphicsCaptureApiHandler for Handler {
        type Flags = Flags;
        type Error = Box<dyn std::error::Error + Send + Sync>;

        fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
            let f = ctx.flags;
            let bitrate = ((f.width as u64 * f.height as u64 * f.fps as u64) / 12).clamp(10_000_000, 60_000_000) as u32;
            let video = VideoSettingsBuilder::new(f.width, f.height)
                .sub_type(if f.hevc { VideoSettingsSubType::HEVC } else { VideoSettingsSubType::H264 })
                .bitrate(bitrate)
                .frame_rate(f.fps);
            let encoder = VideoEncoder::new(video, AudioSettingsBuilder::new().disabled(true), ContainerSettingsBuilder::new(), &f.path)?;
            Ok(Self { encoder: Some(encoder), shared: f.shared })
        }

        fn on_frame_arrived(&mut self, frame: &mut Frame, _control: InternalCaptureControl) -> Result<(), Self::Error> {
            if self.shared.stop.load(Ordering::SeqCst) { return Ok(()); }
            let ts = frame.timestamp()?.Duration;
            let _ = self.shared.t0.compare_exchange(0, ts, Ordering::SeqCst, Ordering::SeqCst);
            if let Some(enc) = self.encoder.as_mut() { enc.send_frame(frame)?; }
            self.shared.last.store(ts, Ordering::SeqCst);
            self.shared.frames.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn arg<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).map(String::as_str)
    }

    pub fn record(args: &[String]) -> Result<(), String> {
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
            timeBeginPeriod(1);
        }
        let out = PathBuf::from(arg(args, "--out").ok_or("--out eksik")?);
        let fps: u32 = arg(args, "--fps").and_then(|s| s.parse().ok()).unwrap_or(60);
        let scale: f64 = arg(args, "--scale").and_then(|s| s.parse().ok()).unwrap_or(1.0);
        let b: Vec<i32> = arg(args, "--bounds").unwrap_or("0,0,0,0").split(',').filter_map(|s| s.trim().parse().ok()).collect();
        let bounds = if b.len() == 4 { RECT { left: b[0], top: b[1], right: b[0] + b[2], bottom: b[1] + b[3] } } else { RECT::default() };
        let system_audio = args.iter().any(|a| a == "--system-audio");
        let mic = args.iter().any(|a| a == "--mic");

        let center = POINT { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
        let hmon = unsafe { MonitorFromPoint(center, MONITOR_DEFAULTTONEAREST) };
        let monitor = Monitor::from_raw_hmonitor(hmon.0);
        let mw = monitor.width().map_err(|e| e.to_string())?;
        let mh = monitor.height().map_err(|e| e.to_string())?;
        let (width, height) = ((mw / 2) * 2, (mh / 2) * 2);
        let hevc = width > 4096 || height > 2304; // beyond H.264's limits
        let bw = if b.len() == 4 && b[2] > 0 { b[2] as f64 } else { width as f64 };
        let bh = if b.len() == 4 && b[3] > 0 { b[3] as f64 } else { height as f64 };

        let shared = Arc::new(Shared { t0: AtomicI64::new(0), frames: AtomicU64::new(0), last: AtomicI64::new(0), stop: AtomicBool::new(false), error: Mutex::new(None) });
        let make_settings = |border: DrawBorderSettings| Settings::new(
            monitor, CursorCaptureSettings::WithoutCursor, border, SecondaryWindowSettings::Default,
            MinimumUpdateIntervalSettings::Custom(Duration::from_millis((1000 / fps.max(1)) as u64)),
            DirtyRegionSettings::Default, ColorFormat::Bgra8,
            Flags { shared: shared.clone(), path: out.join("screen.mp4"), width, height, fps, hevc },
        );
        // Removing the yellow capture border needs Windows 11; fall back to the default on Windows 10.
        let control = match Handler::start_free_threaded(make_settings(DrawBorderSettings::WithoutBorder)) {
            Ok(c) => c,
            Err(_) => Handler::start_free_threaded(make_settings(DrawBorderSettings::Default)).map_err(|e| format!("Ekran yakalama başlatılamadı: {e}"))?,
        };
        let callback = control.callback();

        let cursor_thread = {
            let shared = shared.clone();
            thread::spawn(move || cursor_loop(&shared))
        };
        let mut audio_threads = Vec::new();
        if system_audio { audio_threads.push(spawn_audio(true, out.join("system.wav"), shared.clone())); }
        if mic { audio_threads.push(spawn_audio(false, out.join("mic.wav"), shared.clone())); }

        let started = Instant::now();
        while shared.frames.load(Ordering::SeqCst) == 0 {
            if control.is_finished() || started.elapsed() > Duration::from_secs(10) {
                shared.stop.store(true, Ordering::SeqCst);
                return Err("Ekrandan görüntü alınamadı.".into());
            }
            thread::sleep(Duration::from_millis(10));
        }
        let t0 = shared.t0.load(Ordering::SeqCst);
        let unix_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0);
        emit(json!({"event": "started", "t0": unix_ms - (qpc_100ns() - t0) as f64 / 1e4}));

        // Wait for "stop" on stdin (EOF also stops, e.g. when the app quits).
        {
            let shared = shared.clone();
            thread::spawn(move || {
                let mut line = String::new();
                loop {
                    line.clear();
                    match std::io::stdin().read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) if line.trim() == "stop" => break,
                        _ => {}
                    }
                }
                shared.stop.store(true, Ordering::SeqCst);
            });
        }
        while !shared.stop.load(Ordering::SeqCst) {
            if control.is_finished() { shared.stop.store(true, Ordering::SeqCst); *shared.error.lock().unwrap() = Some("Ekran yakalama beklenmedik şekilde durdu.".into()); }
            thread::sleep(Duration::from_millis(20));
        }
        let end = qpc_100ns();
        let _ = control.stop();
        let encoder = callback.lock().encoder.take();
        if let Some(enc) = encoder { enc.finish().map_err(|e| format!("Video dosyası tamamlanamadı: {e}"))?; }

        let t0 = shared.t0.load(Ordering::SeqCst);
        let duration = (end - t0) as f64 / 1e7;
        let mut names: Vec<Option<String>> = Vec::new();
        for h in audio_threads {
            names.push(h.join().ok().flatten().map(|w| { let n = w.path.file_name().unwrap().to_string_lossy().to_string(); w.finish(duration).ok().map(|_| n) }).flatten());
        }
        let raw = cursor_thread.join().unwrap_or_default();
        let (sx, sy) = (width as f64 / bw, height as f64 / bh);
        let track = raw.track(t0, duration, bounds, sx, sy, width as f64, height as f64);
        std::fs::write(out.join("cursor.json"), serde_json::to_vec(&track).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let (sys_name, mic_name) = {
            let mut it = names.into_iter();
            (if system_audio { it.next().flatten() } else { None }, if mic { it.next().flatten() } else { None })
        };
        unsafe { timeEndPeriod(1); }
        if let Some(e) = shared.error.lock().unwrap().take() { if t0 == 0 { return Err(e); } }
        emit(json!({
            "event": "finished", "video": "screen.mp4", "cursor": "cursor.json",
            "systemAudio": sys_name, "microphone": mic_name, "duration": duration,
            "width": width, "height": height, "pixelsPerPoint": scale * sx,
            // Diagnostics: frames handed to the encoder and the last one's time on the recording's clock.
            "frames": shared.frames.load(Ordering::SeqCst),
            "lastFrame": (shared.last.load(Ordering::SeqCst) - t0) as f64 / 1e7,
        }));
        Ok(())
    }

    #[derive(Default)]
    pub struct RawCursor { samples: Vec<(i64, i32, i32)>, clicks: Vec<(i64, i32, i32, bool, u8)> }

    impl RawCursor {
        fn track(&self, t0: i64, duration: f64, b: RECT, sx: f64, sy: f64, w: f64, h: f64) -> CursorTrack {
            let px = |x: i32, y: i32| (((x - b.left) as f64 * sx).clamp(0.0, w), ((y - b.top) as f64 * sy).clamp(0.0, h));
            let t = |q: i64| (q - t0) as f64 / 1e7;
            let mut out = CursorTrack::default();
            let mut before: Option<CursorSample> = None;
            for &(q, x, y) in &self.samples {
                let (cx, cy) = px(x, y);
                let tt = t(q);
                if tt < 0.0 { before = Some(CursorSample { t: 0.0, x: cx, y: cy }); continue; }
                if tt > duration { break; }
                if out.samples.is_empty() && tt > 0.0 { if let Some(b) = before { out.samples.push(b); } }
                out.samples.push(CursorSample { t: tt, x: cx, y: cy });
            }
            if out.samples.is_empty() { if let Some(b) = before { out.samples.push(b); } }
            for &(q, x, y, down, button) in &self.clicks {
                let tt = t(q);
                if tt < 0.0 || tt > duration { continue; }
                let (cx, cy) = px(x, y);
                out.clicks.push(ClickEvent { t: tt, x: cx, y: cy, is_down: down, button });
            }
            out
        }
    }

    fn cursor_loop(shared: &Shared) -> RawCursor {
        let mut raw = RawCursor::default();
        let (mut left, mut right) = (false, false);
        while !shared.stop.load(Ordering::SeqCst) {
            let now = qpc_100ns();
            let mut p = POINT::default();
            if unsafe { GetCursorPos(&mut p) }.is_ok() {
                let same = raw.samples.last().map_or(false, |&(q, x, y)| x == p.x && y == p.y && now - q < 2_500_000);
                if !same { raw.samples.push((now, p.x, p.y)); }
            }
            let l = unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000 != 0;
            let r = unsafe { GetAsyncKeyState(VK_RBUTTON.0 as i32) } as u16 & 0x8000 != 0;
            if l != left { raw.clicks.push((now, p.x, p.y, l, 0)); left = l; }
            if r != right { raw.clicks.push((now, p.x, p.y, r, 1)); right = r; }
            thread::sleep(Duration::from_millis(4));
        }
        raw
    }

    /// Captures the default render device (loopback = system audio) or the default capture
    /// device (microphone) into a WAV aligned to the first video frame.
    fn spawn_audio(loopback: bool, path: PathBuf, shared: Arc<Shared>) -> thread::JoinHandle<Option<WavWriter>> {
        thread::spawn(move || match capture_audio(loopback, &path, &shared) {
            Ok(w) => Some(w),
            Err(e) => {
                emit(json!({"event": "warning", "message": format!("{} kaydedilemedi: {e}", if loopback { "Sistem sesi" } else { "Mikrofon" })}));
                None
            }
        })
    }

    fn capture_audio(loopback: bool, path: &Path, shared: &Shared) -> windows::core::Result<WavWriter> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(if loopback { eRender } else { eCapture }, eConsole)?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            let fmt_ptr = client.GetMixFormat()?;
            let fmt = *fmt_ptr;
            let channels = fmt.nChannels as usize;
            let rate = fmt.nSamplesPerSec;
            let bits = fmt.wBitsPerSample;
            let is_float = fmt.wFormatTag == 3 /* WAVE_FORMAT_IEEE_FLOAT */
                || (fmt.wFormatTag == 0xFFFE /* EXTENSIBLE */ && {
                    let ext = *(fmt_ptr as *const WAVEFORMATEXTENSIBLE);
                    let sub = ext.SubFormat;
                    sub.data1 == 3 // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT
                });
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, if loopback { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 },
                              2_000_000, 0, fmt_ptr, None)?;
            CoTaskMemFree(Some(fmt_ptr as *const _));
            let capture: IAudioCaptureClient = client.GetService()?;
            let mut wav = WavWriter::create(path, rate, channels as u16).map_err(|e| windows::core::Error::new(windows::core::HRESULT(-1), e.to_string()))?;
            client.Start()?;
            let mut samples: Vec<f32> = Vec::new();
            while !shared.stop.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(10));
                loop {
                    if capture.GetNextPacketSize()? == 0 { break; }
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let (mut frames, mut flags, mut devpos, mut qpc) = (0u32, 0u32, 0u64, 0u64);
                    capture.GetBuffer(&mut data, &mut frames, &mut flags, Some(&mut devpos), Some(&mut qpc))?;
                    let t0 = shared.t0.load(Ordering::SeqCst);
                    if t0 != 0 && frames > 0 {
                        let n = frames as usize * channels;
                        samples.clear();
                        if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                            samples.resize(n, 0.0);
                        } else if is_float && bits == 32 {
                            samples.extend_from_slice(std::slice::from_raw_parts(data as *const f32, n));
                        } else if bits == 16 {
                            samples.extend(std::slice::from_raw_parts(data as *const i16, n).iter().map(|&s| s as f32 / 32768.0));
                        } else if bits == 32 {
                            samples.extend(std::slice::from_raw_parts(data as *const i32, n).iter().map(|&s| s as f32 / 2147483648.0));
                        } else {
                            samples.resize(n, 0.0);
                        }
                        let start = ((qpc as i64 - t0) as f64 / 1e7 * rate as f64).round() as i64;
                        let _ = wav.append(start, &samples);
                    }
                    capture.ReleaseBuffer(frames)?;
                }
            }
            let _ = client.Stop();
            Ok(wav)
        }
    }
}
