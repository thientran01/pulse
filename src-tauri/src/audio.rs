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
use std::time::{Duration, Instant};
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
        // Sanitize at the one ingest point both capture paths share: a single
        // non-finite sample (a driver/format edge case can emit NaN/Inf)
        // propagates through the FFT into smoothed[] and STICKS there — serde
        // renders a NaN band as `null` and the bars freeze until the next pause
        // resets the envelope.
        self.buf[self.pos] = if frame_mean.is_finite() {
            frame_mean
        } else {
            0.0
        };
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
/// Device-fallback stall watchdog: first reopen after this long without a
/// callback frame — the one-off "default device changed / stream silently
/// died" case recovers at this latency.
const STALL_BASE: Duration = Duration::from_secs(2);
/// A reopen the endpoint answers with ZERO frames is FRUITLESS, and WASAPI
/// device loopback legitimately delivers no callbacks while nothing renders
/// locally (GSMTC playing with the audio on a phone/speaker — the DeviceTag
/// case): reopening can't help, so consecutive fruitless reopens double the
/// next stall threshold (2s → 4s → 8s …) up to this cap instead of cycling
/// the device open/close every 2s all session. Any real frame progress, a
/// target change, or a landed process join resets to STALL_BASE, so genuine
/// device-swap recovery keeps its first-reopen latency.
const STALL_CAP: Duration = Duration::from_secs(60);
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
/// A demote is sticky but NOT permanent (it used to clear only on an AUMID
/// change — so a single transient activation blip, or >10s of digital silence
/// at open, stranded a player on whole-mix Discord-bleed capture for the whole
/// session). After this BASE window the AUMID is retried with a process-scoped
/// join; it's wide enough that a genuinely-uncapturable target (exclusive mode,
/// sibling-process render) isn't re-resolved every loop.
const DEMOTE_EXPIRY: Duration = Duration::from_secs(90);
/// Backoff ceiling for a PERMANENT mis-join. Without it, a target whose process
/// capture activates but never delivers packets retries every DEMOTE_EXPIRY
/// forever — each retry opens the silent capture and flattens the waveform for
/// DEMOTE_AFTER_MS (~10s flat every 90s). Each consecutive silent re-demote of
/// the same AUMID instead doubles its retry window (90s → 180s → … → this cap;
/// stamp_demote), so a permanent mis-join settles to one brief flat per ~10min.
/// A target that changes, or a retry that actually delivers signal, resets to
/// the base window — so transient failures still recover at DEMOTE_EXPIRY.
const DEMOTE_EXPIRY_CAP: Duration = Duration::from_secs(600);

/// True while `aumid` is under an UNEXPIRED demote — its stored window (which
/// grows with the backoff, see stamp_demote) hasn't elapsed. Expired → false,
/// so the next open retries the process join; the stamp is deliberately LEFT in
/// place (not cleared) so a re-demote reads its window as the doubling base. A
/// target change or a genuine recovery clears it (see the demoted decl).
fn is_demoted(demoted: &Option<(String, Instant, Duration)>, aumid: &str) -> bool {
    match demoted {
        Some((d, since, expiry)) => d == aumid && since.elapsed() < *expiry,
        None => false,
    }
}

/// Stamp (or re-stamp) the sticky demote for `aumid`. Re-demoting the SAME
/// target — a consecutive expiry-retry that opened the process capture and it
/// still never delivered — doubles the retry window (capped at
/// DEMOTE_EXPIRY_CAP); a first demote, or one after the target changed/
/// recovered (`prev` None or a different AUMID), starts at the base window.
fn stamp_demote(
    prev: &Option<(String, Instant, Duration)>,
    aumid: String,
) -> (String, Instant, Duration) {
    let expiry = match prev {
        Some((d, _, e)) if *d == aumid => (*e * 2).min(DEMOTE_EXPIRY_CAP),
        _ => DEMOTE_EXPIRY,
    };
    (aumid, Instant::now(), expiry)
}

/// Owner thread: opens/drops the capture as the switch flips, runs the
/// FFT + smoothing + emit loop while on.
pub fn spawn(app: AppHandle, switch: Arc<AtomicBool>) {
    std::thread::Builder::new()
        .name("audio-owner".into())
        .spawn(move || {
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
        // The one AUMID currently demoted to Device capture: (aumid, stamped-at,
        // retry window that applies). The window is the base DEMOTE_EXPIRY,
        // doubled per consecutive silent re-demote up to DEMOTE_EXPIRY_CAP
        // (stamp_demote). Cleared when the target moves off it (open branch) or
        // a retry genuinely recovers (the Process health arm's has_data reset).
        // An EXPIRED stamp is left in place — its window is the next backoff's
        // base, and is_demoted already reads it as not-demoted.
        let mut demoted: Option<(String, Instant, Duration)> = None;
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
        // Fruitless-reopen backoff (see STALL_CAP) + one-warn-per-episode
        // gates: a silent endpoint otherwise wrote the stall warn AND the
        // no-join warn every ~2s cycle (~3.6k lines/hour). An "episode" ends
        // when frames progress, the target AUMID moves, or a process-scoped
        // join lands — each resets all three so the next episode warns once
        // again at Warn level and starts at the base first-reopen latency.
        let mut stall_threshold = STALL_BASE;
        let mut stall_warned = false;
        let mut fallback_warned = false;
        let mut stall_target = String::new();

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
                if demoted.as_ref().is_some_and(|(d, _, _)| *d != aumid) {
                    demoted = None; // target moved off the demoted AUMID
                }
                if aumid != stall_target {
                    // A fresh target opening = a fresh episode: base stall
                    // latency, warns re-armed. (The Device arm's identical
                    // reset covers a target that moves mid-capture; this one
                    // covers an episode that STARTS here — it must not
                    // inherit the previous target's backoff.)
                    stall_target = aumid.clone();
                    stall_threshold = STALL_BASE;
                    stall_warned = false;
                    fallback_warned = false;
                }
                let process = if aumid.is_empty() || is_demoted(&demoted, &aumid) {
                    None
                } else {
                    loopback::resolve_target(&aumid).and_then(|t| {
                        loopback::ProcessCapture::open(t, ring.clone(), frames.clone())
                    })
                };
                if let Some(cap) = process {
                    let rate = cap.sample_rate;
                    // A landed join ends any stall episode: the Device-arm
                    // resets can't run while a Process capture holds the
                    // slot, so without this a later same-AUMID fall back to
                    // Device inherits a capped threshold + pre-suppressed
                    // warns from BEFORE the interlude.
                    stall_threshold = STALL_BASE;
                    stall_warned = false;
                    fallback_warned = false;
                    active = Some((Capture::Process(cap, aumid), rate, ring));
                } else if let Some((stream, rate)) = open_loopback(ring.clone(), frames.clone()) {
                    if !aumid.is_empty() {
                        // Warn once per fallback episode: a silent-endpoint
                        // reopen cycle re-enters here every pass, and each
                        // cycle re-missing the same join is not news.
                        if !fallback_warned {
                            fallback_warned = true;
                            log::warn!(
                                "audio: no process-loopback join for {aumid:?} — device-mix fallback"
                            );
                        } else {
                            log::debug!(
                                "audio: still no process-loopback join for {aumid:?} — device-mix fallback"
                            );
                        }
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
                        // A capture now delivering signal is a genuine recovery
                        // — drop any lingering demote for this target so a
                        // future mis-join retries at the base window (the
                        // backoff is for CONSECUTIVE silent re-demotes only).
                        if p.has_data() && demoted.as_ref().is_some_and(|(d, _, _)| d == aumid) {
                            demoted = None;
                        }
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
                            // Real packets: the endpoint is audible — restore
                            // the first-reopen latency and re-arm the
                            // per-episode warns.
                            stall_threshold = STALL_BASE;
                            stall_warned = false;
                            fallback_warned = false;
                        }
                        let aumid = target_aumid();
                        if aumid != stall_target {
                            // Target moved (player change): a fresh endpoint
                            // deserves the base latency and a fresh warn.
                            stall_target = aumid.clone();
                            stall_threshold = STALL_BASE;
                            stall_warned = false;
                            fallback_warned = false;
                        }
                        if last_progress.elapsed() > stall_threshold {
                            // Fire the reopen and pre-double the next wait:
                            // a reopen that delivers frames resets to base
                            // above, so only a FRUITLESS one (silent
                            // endpoint) keeps the doubled threshold — the
                            // cadence decays 2s→4s→…→cap instead of
                            // churning.
                            stall_threshold = (stall_threshold * 2).min(STALL_CAP);
                            if !stall_warned {
                                stall_warned = true;
                                log::warn!(
                                    "audio loopback stalled — reopening against current default device"
                                );
                            } else {
                                log::debug!(
                                    "audio loopback still silent — reopen backoff now {}s",
                                    stall_threshold.as_secs()
                                );
                            }
                            Act::Reopen
                        } else if last_upgrade.elapsed() > UPGRADE_RETRY {
                            last_upgrade = std::time::Instant::now();
                            if aumid.is_empty() || is_demoted(&demoted, &aumid) {
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
                        demoted = Some(stamp_demote(&demoted, aumid));
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
                                    // Same episode-end as the open-branch
                                    // join: the upgrade proves the target
                                    // deliverable, so a later Device
                                    // fallback is a NEW episode.
                                    stall_threshold = STALL_BASE;
                                    stall_warned = false;
                                    fallback_warned = false;
                                } else {
                                    log::warn!("audio: process activation failed for {aumid:?} — staying on device mix");
                                    demoted = Some(stamp_demote(&demoted, aumid));
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
        })
        .expect("spawn audio-owner thread");
}
