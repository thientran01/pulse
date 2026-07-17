//! Audio-reactive core: WASAPI loopback capture → FFT → smoothed band
//! energies emitted as "audio-bands" events (~30Hz).
//!
//! Capture is PROCESS-SCOPED when it can be (loopback.rs: the playing app's
//! process tree via the process-loopback virtual device) so the bars ride
//! the SONG — device-wide loopback heard Discord voice and game SFX too,
//! and the auto-gain danced to whoever was loudest. The device-wide cpal
//! stream survives as the fallback when the AUMID→PID join misses (unknown
//! player, pre-2004 Windows), with a periodic upgrade retry.
//!
//! Lifecycle discipline (plan M4): capture runs ONLY while a Pulse window
//! is visible (the main widget OR the focus takeover — lib.rs widens the
//! gate) AND something is playing. The owner thread opens/drops the capture
//! on demand — dropping releases the device/stream entirely, so a hidden or
//! paused app costs zero audio work.

use crate::loopback;
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rustfft::{num_complex::Complex, FftPlanner};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const FFT_SIZE: usize = 2048;
const EMIT_INTERVAL: Duration = Duration::from_millis(33);
/// Band edges in Hz: bass, mid, high.
const BANDS: [(f32, f32); 3] = [(30.0, 150.0), (150.0, 2000.0), (2000.0, 8000.0)];
/// Log-spaced fine bins for the now-playing waveform separator's bars.
const SPECTRUM_BINS: usize = 16;
const SPECTRUM_LO_HZ: f32 = 40.0;
const SPECTRUM_HI_HZ: f32 = 8000.0;
const ATTACK: f32 = 0.55;
/// Release fast enough that a bar has visibly fallen before the next beat
/// lands (~0.3 → ~2.5 ticks to halve ≈ 80ms) — 0.12 blurred adjacent kicks
/// into one sway.
const RELEASE: f32 = 0.3;
/// Auto-gain reference decays slowly so quiet and loud tracks both animate.
const GAIN_DECAY: f32 = 0.995;
/// Broadband-RMS reference for the dynamics factor decays slower than the
/// per-bin gain (~11s half-life vs ~5s) so a quiet bridge stays visibly
/// quiet instead of re-gaining to full height mid-section.
const RMS_DECAY: f32 = 0.998;
/// How short a silent-adjacent passage can render: the dynamics factor
/// scales bar targets into [DYN_FLOOR, 1] so quiet sections still animate,
/// just visibly smaller.
const DYN_FLOOR: f32 = 0.35;
/// The dynamics factor tracks SECTIONS (verse vs drop), so its release is
/// deliberately much slower than the per-bin RELEASE (~760ms half-life vs
/// ~80ms): broadband RMS dips in the gaps between beats, and a fast release
/// here would duck every bar in lockstep — the pump the staggered bins
/// exist to avoid. Attack reuses ATTACK so a drop lands immediately.
const DYN_RELEASE: f32 = 0.03;

#[derive(Serialize, Clone, Copy, Default)]
pub struct Bands {
    pub bass: f32,
    pub mid: f32,
    pub high: f32,
    /// Overall level 0..1 (auto-gained RMS).
    pub level: f32,
    /// Log-spaced bins bass→high, each auto-gained/smoothed like the bands.
    pub spectrum: [f32; SPECTRUM_BINS],
}

/// Log-spaced bin edges: edge(i) = LO * (HI/LO)^(i/N).
fn spectrum_edges() -> [f32; SPECTRUM_BINS + 1] {
    let ratio = SPECTRUM_HI_HZ / SPECTRUM_LO_HZ;
    let mut edges = [0.0f32; SPECTRUM_BINS + 1];
    for (i, e) in edges.iter_mut().enumerate() {
        *e = SPECTRUM_LO_HZ * ratio.powf(i as f32 / SPECTRUM_BINS as f32);
    }
    edges
}

/// Latest samples ring (mono-mixed), written by whichever capture path is
/// live (the cpal callback or loopback.rs's process capture thread).
pub(crate) struct Ring {
    buf: Vec<f32>,
    pos: usize,
}

impl Ring {
    pub(crate) fn new() -> Self {
        Ring {
            buf: vec![0.0; FFT_SIZE],
            pos: 0,
        }
    }
    pub(crate) fn push_frame(&mut self, frame_mean: f32) {
        self.buf[self.pos] = frame_mean;
        self.pos = (self.pos + 1) % self.buf.len();
    }
    /// Snapshot in chronological order.
    pub(crate) fn snapshot(&self) -> Vec<f32> {
        let mut out = Vec::with_capacity(self.buf.len());
        out.extend_from_slice(&self.buf[self.pos..]);
        out.extend_from_slice(&self.buf[..self.pos]);
        out
    }
}

/// The AUMID of the GSMTC session the media loop is currently riding — the
/// process-scoped capture's target. Written by the media loop every beat
/// (same cadence as the capture switch); read by the owner thread when it
/// opens capture and each health check, so a player change re-scopes.
static TARGET_AUMID: Mutex<String> = Mutex::new(String::new());

pub fn set_target(aumid: &str) {
    let mut t = TARGET_AUMID
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if *t != aumid {
        aumid.clone_into(&mut t);
    }
}

fn target_aumid() -> String {
    TARGET_AUMID
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
}

fn open_loopback(
    ring: Arc<Mutex<Ring>>,
    frames: Arc<std::sync::atomic::AtomicU64>,
) -> Option<(cpal::Stream, f32)> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    let config = device.default_output_config().ok()?;
    // cpal panics INSIDE the audio callback on a type mismatch — degrade to
    // "no visuals" instead for the rare non-F32 shared-mode mix format.
    if config.sample_format() != cpal::SampleFormat::F32 {
        log::warn!(
            "audio loopback: unsupported sample format {:?}",
            config.sample_format()
        );
        return None;
    }
    let sample_rate = config.sample_rate().0 as f32;
    let channels = config.channels() as usize;
    // Building an INPUT stream on an OUTPUT device = WASAPI loopback.
    // The Mutex hold inside the callback is a few µs (push into a fixed ring);
    // snapshot() on the reader side is equally short — contention risk is
    // negligible at 30Hz reads.
    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _| {
                frames.fetch_add(1, Ordering::Relaxed);
                let mut ring = match ring.lock() {
                    Ok(r) => r,
                    Err(p) => p.into_inner(),
                };
                for frame in data.chunks(channels.max(1)) {
                    let mean = frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32;
                    ring.push_frame(mean);
                }
            },
            |e| log::warn!("audio loopback stream error: {e}"),
            None,
        )
        .ok()?;
    stream.play().ok()?;
    Some((stream, sample_rate))
}

/// RMS energy of one frequency range. At high sample rates (96/192kHz) the
/// narrow low log bins fall below the FFT's resolution — clamping `hi_bin`
/// up to `lo_bin` merges them into the nearest real bin (neighbors read the
/// same energy) instead of leaving them permanently dead-zero.
fn range_energy(spectrum: &[Complex<f32>], sample_rate: f32, lo_hz: f32, hi_hz: f32) -> f32 {
    let bin_hz = sample_rate / FFT_SIZE as f32;
    let lo_bin = ((lo_hz / bin_hz) as usize).clamp(1, FFT_SIZE / 2 - 1);
    let hi_bin = ((hi_hz / bin_hz) as usize).clamp(lo_bin, FFT_SIZE / 2 - 1);
    let sum: f32 = spectrum[lo_bin..=hi_bin].iter().map(|c| c.norm_sqr()).sum();
    (sum / (hi_bin - lo_bin + 1) as f32).sqrt()
}

fn band_energies(spectrum: &[Complex<f32>], sample_rate: f32) -> [f32; 3] {
    let mut out = [0.0f32; 3];
    for (i, (lo, hi)) in BANDS.iter().enumerate() {
        out[i] = range_energy(spectrum, sample_rate, *lo, *hi);
    }
    out
}

/// A live capture, either scope. Process is the wanted path (only the
/// player's audio); Device is the whole-mix fallback (the pre-scoping
/// behavior) when the AUMID→PID join can't land.
enum Capture {
    /// The capture plus the AUMID it was scoped to — a player change
    /// (Spotify → Apple Music) must re-resolve, not keep riding the old app.
    Process(loopback::ProcessCapture, String),
    /// The stream is never read — held for its Drop (drop = stop capture).
    Device(#[allow(dead_code)] cpal::Stream),
}

/// Process-path staleness horizon: no packets for this long renders as
/// silence (a process-loopback stream legitimately delivers nothing while
/// the target is quiet — FFT'ing the stale ring would freeze the bars at
/// their last heights instead of letting them fall).
const SILENCE_AFTER_MS: u64 = 250;
/// While on the Device fallback, retry the process-scoped upgrade this
/// often — the player's audio session often appears a beat after playback
/// starts, and a missed join at open time shouldn't stick for the session.
const UPGRADE_RETRY: Duration = Duration::from_secs(5);
/// A process capture that has NEVER delivered a packet WITH SIGNAL this long
/// into playback either joined the wrong process (multi-profile browsers can
/// alias an AUMID) or joined a session that only renders SILENCE while the
/// audible audio goes elsewhere (a spatial mixer, or a sibling process —
/// loopback.rs's second quirk). The right join delivers real audio within the
/// first beat of a playing track. Demote that AUMID to the Device fallback,
/// stickily (re-resolving would pick the same silent PID and strand the bars at
/// zero again), until the playing app changes — the whole-mix fallback captures
/// the endpoint IF the audio is in the shared mix at all. It is NOT for
/// exclusive-mode playback (Apple Music bit-perfect lossless): that bypasses the
/// shared mix and is uncapturable by any loopback — see docs/smtc-support-matrix.md
/// finding 12. A capture that has delivered signal is never demoted: its later
/// silence is the target really rendering nothing.
const DEMOTE_AFTER_MS: u64 = 10_000;

/// Owner thread: opens/drops the capture as the switch flips, runs the
/// FFT + smoothing + emit loop while on.
pub fn spawn(app: AppHandle, switch: Arc<AtomicBool>) {
    std::thread::spawn(move || {
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(FFT_SIZE);
        // Hann window, precomputed.
        let window: Vec<f32> = (0..FFT_SIZE)
            .map(|i| {
                let x = (i as f32 / (FFT_SIZE - 1) as f32) * std::f32::consts::TAU;
                0.5 * (1.0 - x.cos())
            })
            .collect();

        // COM for loopback.rs's session enumeration on this thread (cpal
        // inits its own MTA per stream thread; S_FALSE double-init is fine).
        let com = unsafe {
            windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            )
        };
        let _ = com; // held for the thread's lifetime (it never exits)

        let mut active: Option<(Capture, f32, Arc<Mutex<Ring>>)> = None;
        let mut last_upgrade = std::time::Instant::now();
        // The one AUMID currently demoted to Device capture (see
        // DEMOTE_AFTER_MS). Cleared when the target moves off it.
        let mut demoted: Option<String> = None;
        let mut smoothed = [0.0f32; 3];
        let mut gain_ref = [1e-4f32; 3];
        let spec_edges = spectrum_edges();
        let mut smoothed_spec = [0.0f32; SPECTRUM_BINS];
        let mut gain_spec = [1e-4f32; SPECTRUM_BINS];
        let mut rms_ref = 1e-4f32;
        let mut smoothed_dyn = 0.0f32;
        let mut scratch = vec![Complex::default(); FFT_SIZE];
        // Stream-health watchdog: the callback bumps `frames`; if it stalls
        // while we're supposedly capturing (default device changed, stream
        // silently died — cpal never signals this), drop and reopen.
        let frames = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let mut last_frames = 0u64;
        let mut last_progress = std::time::Instant::now();

        loop {
            let want = switch.load(Ordering::Relaxed);
            if !want {
                if active.is_some() {
                    active = None; // drops the capture, releases the device
                    smoothed = [0.0; 3];
                    smoothed_spec = [0.0; SPECTRUM_BINS];
                    smoothed_dyn = 0.0;
                    let _ = app.emit("audio-bands", Bands::default());
                }
            } else if active.is_none() {
                // Open: process-scoped first (the playing app's tree only),
                // whole-mix device loopback as the fallback.
                let ring = Arc::new(Mutex::new(Ring::new()));
                let aumid = target_aumid();
                if demoted.as_deref().is_some_and(|d| d != aumid) {
                    demoted = None;
                }
                let process = if aumid.is_empty() || demoted.is_some() {
                    None
                } else {
                    loopback::resolve_target(&aumid).and_then(|t| {
                        loopback::ProcessCapture::open(t, ring.clone(), frames.clone())
                    })
                };
                if let Some(cap) = process {
                    let rate = cap.sample_rate;
                    active = Some((Capture::Process(cap, aumid), rate, ring));
                } else if let Some((stream, rate)) = open_loopback(ring.clone(), frames.clone()) {
                    if !aumid.is_empty() {
                        log::warn!(
                            "audio: no process-loopback join for {aumid:?} — device-mix fallback"
                        );
                    }
                    last_upgrade = std::time::Instant::now();
                    active = Some((Capture::Device(stream), rate, ring));
                } else {
                    // Device unavailable — retry lazily, don't spin.
                    std::thread::sleep(Duration::from_secs(5));
                }
                if active.is_some() {
                    last_frames = frames.load(Ordering::Relaxed);
                    last_progress = std::time::Instant::now();
                }
            } else {
                // Health check on the live capture. Decide with a short
                // borrow, act after it drops.
                enum Act {
                    Keep,
                    Reopen,
                    Demote(String),
                    TryUpgrade(String),
                }
                let act = match &active.as_ref().expect("checked some").0 {
                    // NO stall watchdog here: a quiet target legitimately
                    // delivers nothing (module docs). Reopen only on real
                    // endings — capture thread died, target process exited,
                    // or the playing app changed out from under the scope —
                    // plus the wrong-join demote (a real player is never
                    // THIS silent mid-playback).
                    Capture::Process(p, aumid) => {
                        // A capture that died having NEVER delivered is a
                        // broken join — demote, don't reopen: a plain reopen
                        // would re-run the full resolution+activation at
                        // loop cadence against the same broken target.
                        if p.done() && !p.has_data() {
                            Act::Demote(aumid.clone())
                        } else if p.done() || !p.target_alive() || *aumid != target_aumid() {
                            Act::Reopen
                        } else if !p.has_data() && p.ms_since_data() > DEMOTE_AFTER_MS {
                            Act::Demote(aumid.clone())
                        } else {
                            Act::Keep
                        }
                    }
                    Capture::Device(_) => {
                        let now_frames = frames.load(Ordering::Relaxed);
                        if now_frames != last_frames {
                            last_frames = now_frames;
                            last_progress = std::time::Instant::now();
                        }
                        if last_progress.elapsed() > Duration::from_secs(2) {
                            log::warn!(
                                "audio loopback stalled — reopening against current default device"
                            );
                            Act::Reopen
                        } else if last_upgrade.elapsed() > UPGRADE_RETRY {
                            last_upgrade = std::time::Instant::now();
                            let aumid = target_aumid();
                            if aumid.is_empty() || demoted.as_deref() == Some(&aumid) {
                                Act::Keep
                            } else {
                                Act::TryUpgrade(aumid)
                            }
                        } else {
                            Act::Keep
                        }
                    }
                };
                match act {
                    Act::Keep => {}
                    Act::Reopen => {
                        active = None; // next iteration reopens with fresh resolution
                        continue;
                    }
                    Act::Demote(aumid) => {
                        log::warn!("audio: process capture for {aumid:?} never delivered — device-mix fallback");
                        demoted = Some(aumid);
                        active = None; // reopens demoted (Device) next iteration
                        continue;
                    }
                    Act::TryUpgrade(aumid) => {
                        // The player's session may have appeared since we fell
                        // back — swap up to the scoped capture when it has.
                        // A no-session miss keeps retrying (resolution is a
                        // cheap enumeration); a join that resolved but FAILED
                        // to activate demotes stickily — retrying it would
                        // stutter the working Device stream with a blocking
                        // multi-second activation attempt every 5s.
                        match loopback::resolve_target(&aumid) {
                            None => {}
                            Some(t) => {
                                let ring = Arc::new(Mutex::new(Ring::new()));
                                if let Some(cap) =
                                    loopback::ProcessCapture::open(t, ring.clone(), frames.clone())
                                {
                                    let rate = cap.sample_rate;
                                    active = Some((Capture::Process(cap, aumid), rate, ring));
                                    last_frames = frames.load(Ordering::Relaxed);
                                    last_progress = std::time::Instant::now();
                                } else {
                                    log::warn!("audio: process activation failed for {aumid:?} — staying on device mix");
                                    demoted = Some(aumid);
                                }
                            }
                        }
                    }
                }
            }

            let Some((cap, rate, ring)) = &active else {
                std::thread::sleep(Duration::from_millis(250));
                continue;
            };

            // Process-path staleness reads as SILENCE (zero samples), so the
            // bars fall instead of freezing on the last-heard spectrum.
            let stale =
                matches!(cap, Capture::Process(p, _) if p.ms_since_data() > SILENCE_AFTER_MS);
            let samples = if stale {
                vec![0.0; FFT_SIZE]
            } else {
                let ring = ring
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                ring.snapshot()
            };
            for (i, s) in samples.iter().enumerate() {
                scratch[i] = Complex::new(s * window[i], 0.0);
            }
            fft.process(&mut scratch);
            let raw = band_energies(&scratch, *rate);

            // Dynamics factor: broadband RMS against a slow peak reference.
            // Per-bin auto-gain (below) erases loud-vs-quiet across song
            // sections — every bin re-normalizes to its own recent peak — so
            // this factor scales the *visual* targets back down during quiet
            // passages. sqrt eases the curve (half amplitude → ~0.7, not 0.5).
            let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt();
            rms_ref = (rms_ref * RMS_DECAY).max(rms).max(1e-4);
            let dyn_target = (rms / rms_ref).clamp(0.0, 1.0).sqrt();
            let dk = if dyn_target > smoothed_dyn {
                ATTACK
            } else {
                DYN_RELEASE
            };
            smoothed_dyn += (dyn_target - smoothed_dyn) * dk;
            let dyn_scale = DYN_FLOOR + (1.0 - DYN_FLOOR) * smoothed_dyn;

            let mut norm = [0.0f32; 3];
            for i in 0..3 {
                gain_ref[i] = (gain_ref[i] * GAIN_DECAY).max(raw[i]).max(1e-4);
                let target = (raw[i] / gain_ref[i]).clamp(0.0, 1.0);
                let k = if target > smoothed[i] {
                    ATTACK
                } else {
                    RELEASE
                };
                smoothed[i] += (target - smoothed[i]) * k;
                norm[i] = smoothed[i];
            }
            let mut spectrum = [0.0f32; SPECTRUM_BINS];
            for i in 0..SPECTRUM_BINS {
                let raw_e = range_energy(&scratch, *rate, spec_edges[i], spec_edges[i + 1]);
                gain_spec[i] = (gain_spec[i] * GAIN_DECAY).max(raw_e).max(1e-4);
                let target = (raw_e / gain_spec[i]).clamp(0.0, 1.0);
                let k = if target > smoothed_spec[i] {
                    ATTACK
                } else {
                    RELEASE
                };
                smoothed_spec[i] += (target - smoothed_spec[i]) * k;
                spectrum[i] = smoothed_spec[i];
            }
            // `level` stays UNSCALED — it drives the separator's wake/sleep
            // (frontend WAKE_LEVEL), and a quiet passage is still "playing".
            // Only the visual targets (bands + spectrum) take the dynamics.
            let bands = Bands {
                bass: norm[0] * dyn_scale,
                mid: norm[1] * dyn_scale,
                high: norm[2] * dyn_scale,
                level: (norm[0] * 0.5 + norm[1] * 0.35 + norm[2] * 0.15).clamp(0.0, 1.0),
                spectrum: spectrum.map(|s| s * dyn_scale),
            };
            let _ = app.emit("audio-bands", bands);
            std::thread::sleep(EMIT_INTERVAL);
        }
    });
}
