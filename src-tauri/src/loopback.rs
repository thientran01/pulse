//! Process-scoped WASAPI loopback (Win10 2004+): capture ONLY the media
//! player's audio instead of the whole device mix. Classic device loopback
//! (audio.rs's cpal fallback) hears EVERYTHING the machine plays — Discord
//! voice, game SFX — so the waveform danced to friends' voices whenever they
//! out-shouted the song (reported live 2026-07-12). Here the capture is
//! scoped to the playing app's process tree via ActivateAudioInterfaceAsync
//! + VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, so the bars ride the SONG.
//!
//! Resolution: GSMTC names the playing app by AUMID but not PID; the audio
//! render-session list (IAudioSessionManager2) names PIDs but not AUMIDs.
//! `resolve_target` joins them — packaged apps (Apple Music) by
//! GetApplicationUserModelId equality, unpackaged (Spotify, most browsers)
//! by exe-stem heuristic against the AUMID. No match → the caller falls
//! back to device loopback: never worse than the old behavior.
//!
//! Quirk that shapes the API: a process-loopback stream delivers NO packets
//! while the target renders nothing (there's no shared mix to copy silence
//! from), so "no data" is a legitimate steady state — NOT a stalled stream.
//! The owner must skip its device-path stall watchdog on this path and
//! render staleness as silence (`ms_since_data`).
//!
//! Second quirk, harder: an app can hold an ACTIVE render session that delivers
//! only SILENCE (the AUDCLNT_BUFFERFLAGS_SILENT flag, or plain all-zero frames)
//! while its AUDIBLE audio renders somewhere the process-tree join can't see —
//! a spatial mixer (Dolby Atmos renders the PCM in the system spatial processor,
//! outside the app's process) or a sibling process in the same package. So
//! "delivered a packet" is NOT proof the join is good — only "delivered a packet
//! WITH SIGNAL" is. `last_data_ms` stamps on real energy alone (SILENCE_EPS), so
//! a silent-only stream reads as no-data and the owner can demote it to the
//! whole-mix device fallback (which taps the endpoint mix, when the audio is in
//! the shared mix at all).
//!
//! NOTE this is DISTINCT from the case that first sent us here. Apple Music's
//! flat waveform was confirmed live to be WASAPI EXCLUSIVE-mode playback
//! (bit-perfect lossless): it delivers NO packets at all — so the plain
//! `!has_data()` demote already covers it, this silent-PACKET gate is not what
//! rescues it — AND its audio bypasses the shared mix entirely, so NO loopback
//! (process OR device) can capture it. That case has no capture-side fix; see
//! docs/smtc-support-matrix.md finding 12. The silent-packet path here is the
//! separate, defensive case. The live_probe's session dump + per-session
//! capture is how we tell these apart (bypasses-shared-mix vs. wrong-pid).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, Ref, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, WAIT_TIMEOUT,
};
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::Storage::Packaging::Appx::GetApplicationUserModelId;
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
use windows::Win32::System::Threading::{
    CreateEventW, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
use windows::Win32::System::Variant::VT_BLOB;

use crate::audio::Ring;

/// Requested capture format. Process loopback has no device mix format to
/// inherit — the caller picks one and the audio engine converts. 48k stereo
/// f32 is the shared-mode engine's native shape on effectively every setup.
pub const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
/// mmreg.h WAVE_FORMAT_IEEE_FLOAT (the windows crate scatters it in modules
/// we don't otherwise need).
const FORMAT_IEEE_FLOAT: u16 = 0x0003;
/// Peak mono amplitude a packet must clear to count as REAL audio (see the
/// module's second quirk). ~-80 dBFS: true digital silence and a silent
/// keep-alive read as zero; even a quiet passage of real music sits well
/// above it. Only real audio stamps `last_data_ms` — so a process that
/// delivers packets but no signal (a silent session while the audible audio
/// renders elsewhere) demotes to the device fallback instead of stranding the
/// bars at zero forever.
const SILENCE_EPS: f32 = 1e-4;

/// A VT_BLOB PROPVARIANT in the documented C layout (propidlbase.h): vt +
/// three reserved words, then the union — BLOB is its largest-aligned arm we
/// use. Hand-rolled because the windows crate's managed PROPVARIANT hides
/// the raw union AND its Drop runs PropVariantClear, which CoTaskMemFree's a
/// VT_BLOB's pBlobData — here a pointer to the STACK. This struct has no
/// Drop; its address casts to the pointer type ActivateAudioInterfaceAsync
/// wants (layout-identical).
#[repr(C)]
struct BlobPropVariant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    blob: windows::Win32::System::Com::BLOB,
}

/// The playing app plus a SYNCHRONIZE handle so the owner can cheaply ask
/// "is it still alive" every loop beat (a dead target delivers nothing
/// forever — indistinguishable from silence without this).
pub struct Target {
    pub pid: u32,
    handle: HANDLE,
}

// HANDLE is a plain kernel handle — thread-affinity-free.
unsafe impl Send for Target {}

impl Target {
    pub fn alive(&self) -> bool {
        unsafe { WaitForSingleObject(self.handle, 0) == WAIT_TIMEOUT }
    }
}

impl Drop for Target {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.handle);
        }
    }
}

/// AUMID of the process, via the two-call GetApplicationUserModelId dance.
/// Fails (None) for unpackaged processes — that's the signal to try the
/// exe-stem heuristic instead.
fn process_aumid(process: HANDLE) -> Option<String> {
    unsafe {
        let mut len = 0u32;
        let rc = GetApplicationUserModelId(process, &mut len, None);
        if rc != ERROR_INSUFFICIENT_BUFFER || len == 0 {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        let rc = GetApplicationUserModelId(process, &mut len, Some(PWSTR(buf.as_mut_ptr())));
        if rc != ERROR_SUCCESS {
            return None;
        }
        Some(String::from_utf16_lossy(
            &buf[..len.saturating_sub(1) as usize],
        ))
    }
}

/// Lowercased exe stem ("C:\...\Spotify.exe" → "spotify").
fn process_stem(process: HANDLE) -> Option<String> {
    unsafe {
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let file = path.rsplit(['\\', '/']).next()?;
        Some(
            file.trim_end_matches(".exe")
                .trim_end_matches(".EXE")
                .to_lowercase(),
        )
    }
}

/// Does this PID belong to the GSMTC session's app? Packaged apps match by
/// AUMID equality (Apple Music: "AppleInc.AppleMusicWin_...!App" on both
/// sides). Unpackaged apps have no package AUMID — GSMTC reports whatever
/// they set via SetCurrentProcessExplicitAppUserModelID, which for the
/// players we know is exe-derived: "Spotify.exe", Squirrel-installer ids
/// like "com.squirrel.Spotify.Spotify", "Chrome" — so a ≥4-char exe stem
/// appearing in the AUMID is the join (the candidate pool is only processes
/// with a live render session, so a loose contains stays honest). Misses
/// (e.g. Firefox's hashed AUMID) just mean device-loopback fallback.
fn pid_matches(pid: u32, aumid_lower: &str) -> bool {
    unsafe {
        let Ok(process) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let matched = (|| {
            if let Some(a) = process_aumid(process) {
                if a.to_lowercase() == aumid_lower {
                    return true;
                }
            }
            let Some(stem) = process_stem(process) else {
                return false;
            };
            aumid_lower == stem
                || aumid_lower == format!("{stem}.exe")
                || aumid_lower.starts_with(&format!("{stem}."))
                || (stem.len() >= 4 && aumid_lower.contains(&stem))
        })();
        let _ = CloseHandle(process);
        matched
    }
}

/// Find the PID rendering the playing app's audio: walk the default render
/// device's session list and match each session's process against the AUMID.
/// Prefers ACTIVE sessions (the one actually making sound right now) over
/// inactive ones; PID 0 (system sounds) is skipped. COM must already be
/// initialized on the calling thread (the audio owner thread does MTA once).
pub fn resolve_target(aumid: &str) -> Option<Target> {
    let aumid_lower = aumid.to_lowercase();
    let mut fallback: Option<u32> = None;
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
        let manager: windows::Win32::Media::Audio::IAudioSessionManager2 =
            device.Activate(CLSCTX_ALL, None).ok()?;
        let sessions = manager.GetSessionEnumerator().ok()?;
        let count = sessions.GetCount().ok()?;
        for i in 0..count {
            let Ok(control) = sessions.GetSession(i) else {
                continue;
            };
            let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                continue;
            };
            let pid = control2.GetProcessId().unwrap_or(0);
            if pid == 0 || !pid_matches(pid, &aumid_lower) {
                continue;
            }
            let active = control
                .GetState()
                .map(|s| s == AudioSessionStateActive)
                .unwrap_or(false);
            if active {
                return open_target(pid);
            }
            fallback.get_or_insert(pid);
        }
    }
    fallback.and_then(open_target)
}

fn open_target(pid: u32) -> Option<Target> {
    unsafe {
        OpenProcess(PROCESS_SYNCHRONIZE, false, pid)
            .ok()
            .map(|handle| Target { pid, handle })
    }
}

/// Signals the activation-done event; ActivateAudioInterfaceAsync invokes it
/// on an arbitrary MTA thread.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateDone(std::sync::mpsc::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateDone_Impl {
    fn ActivateCompleted(
        &self,
        _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

/// Activate an IAudioClient on the process-loopback virtual device for
/// `pid`'s process tree. INCLUDE mode: children too — players commonly
/// render audio in a child of the process GSMTC/the session list names.
fn activate_process_client(pid: u32) -> Option<IAudioClient> {
    unsafe {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        let raw = BlobPropVariant {
            vt: VT_BLOB.0,
            reserved1: 0,
            reserved2: 0,
            reserved3: 0,
            blob: windows::Win32::System::Com::BLOB {
                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pBlobData: &params as *const _ as *mut u8,
            },
        };

        let (tx, rx) = std::sync::mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = ActivateDone(tx).into();
        let op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&raw as *const _ as *const _),
            &handler,
        )
        .ok()?;
        rx.recv_timeout(Duration::from_secs(2)).ok()?;

        let mut hr = windows::core::HRESULT(0);
        let mut unknown: Option<windows::core::IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unknown).ok()?;
        hr.ok().ok()?;
        unknown?.cast().ok()
    }
}

/// A live process-scoped capture: its own thread owns every COM object
/// (activation → capture loop → drop), pushing mono-mixed frames into the
/// shared ring exactly like the cpal callback does. Dropping stops it.
pub struct ProcessCapture {
    stop: Arc<AtomicBool>,
    /// Thread exited (device error, activation loss) — owner should reopen.
    done: Arc<AtomicBool>,
    /// ms since the last delivered packet, against `epoch`. Staleness is
    /// SILENCE on this path, not a stall (see module docs).
    last_data_ms: Arc<AtomicU64>,
    epoch: Instant,
    join: Option<std::thread::JoinHandle<()>>,
    target: Target,
    pub sample_rate: f32,
}

impl ProcessCapture {
    pub fn open(
        target: Target,
        ring: Arc<Mutex<Ring>>,
        frames: Arc<AtomicU64>,
    ) -> Option<ProcessCapture> {
        let stop = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let last_data_ms = Arc::new(AtomicU64::new(0));
        let epoch = Instant::now();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<bool>();

        let pid = target.pid;
        let t_stop = stop.clone();
        let t_done = done.clone();
        let t_last = last_data_ms.clone();
        let join = std::thread::spawn(move || {
            // MTA: audio interfaces are agile and the activation callback
            // arrives on a worker. S_FALSE (already initialized) is fine.
            let com = unsafe {
                windows::Win32::System::Com::CoInitializeEx(
                    None,
                    windows::Win32::System::Com::COINIT_MULTITHREADED,
                )
            };
            capture_loop(pid, ring, frames, t_stop, t_last, epoch, ready_tx);
            t_done.store(true, Ordering::Relaxed);
            if com.is_ok() {
                unsafe { windows::Win32::System::Com::CoUninitialize() };
            }
        });

        // 5s comfortably covers the 2s activation wait plus the setup calls
        // after it. On timeout the thread is DETACHED, never joined: a
        // wedged WASAPI call would make join() wedge the OWNER (the thread
        // that renders the bars) — the zombie exits on its own when the call
        // returns, and it can't touch the ring (a failed ready handshake
        // means it never entered the packet loop).
        if ready_rx.recv_timeout(Duration::from_secs(5)) != Ok(true) {
            stop.store(true, Ordering::Relaxed);
            return None;
        }
        Some(ProcessCapture {
            stop,
            done,
            last_data_ms,
            epoch,
            join: Some(join),
            target,
            sample_rate: SAMPLE_RATE as f32,
        })
    }

    pub fn done(&self) -> bool {
        self.done.load(Ordering::Relaxed)
    }

    pub fn target_alive(&self) -> bool {
        self.target.alive()
    }

    pub fn ms_since_data(&self) -> u64 {
        let now = self.epoch.elapsed().as_millis() as u64;
        now.saturating_sub(self.last_data_ms.load(Ordering::Relaxed))
    }

    /// Has this capture EVER delivered a packet WITH SIGNAL (peak > SILENCE_EPS)?
    /// A join that has is correct (later silence is the target really rendering
    /// nothing); one that never has picked the wrong process OR joined a
    /// silent-keep-alive session (Apple Music, whose audible audio renders in a
    /// sibling process) — either way the owner's demote signal.
    pub fn has_data(&self) -> bool {
        self.last_data_ms.load(Ordering::Relaxed) != 0
    }
}

impl Drop for ProcessCapture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_loop(
    pid: u32,
    ring: Arc<Mutex<Ring>>,
    frames: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    last_data_ms: Arc<AtomicU64>,
    epoch: Instant,
    ready_tx: std::sync::mpsc::Sender<bool>,
) {
    let Some(client) = activate_process_client(pid) else {
        let _ = ready_tx.send(false);
        return;
    };
    unsafe {
        let format = WAVEFORMATEX {
            wFormatTag: FORMAT_IEEE_FLOAT,
            nChannels: CHANNELS,
            nSamplesPerSec: SAMPLE_RATE,
            nAvgBytesPerSec: SAMPLE_RATE * CHANNELS as u32 * 4,
            nBlockAlign: CHANNELS * 4,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        // 20ms buffer, per the ApplicationLoopback sample. EVENTCALLBACK:
        // the engine signals per packet; 200ms wait timeouts keep the stop
        // flag responsive through silent stretches.
        if client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                200_000,
                0,
                &format,
                None,
            )
            .is_err()
        {
            let _ = ready_tx.send(false);
            return;
        }
        let Ok(event) = CreateEventW(None, false, false, None) else {
            let _ = ready_tx.send(false);
            return;
        };
        let ok = client.SetEventHandle(event).is_ok();
        let capture: Option<IAudioCaptureClient> = client.GetService().ok();
        let started = ok && capture.is_some() && client.Start().is_ok();
        let _ = ready_tx.send(started);
        if started {
            let capture = capture.unwrap();
            let channels = CHANNELS as usize;
            'outer: while !stop.load(Ordering::Relaxed) {
                let _ = WaitForSingleObject(event, 200);
                loop {
                    let packet = match capture.GetNextPacketSize() {
                        Ok(n) => n,
                        Err(_) => break 'outer, // device invalidated etc.
                    };
                    if packet == 0 {
                        break;
                    }
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut n_frames = 0u32;
                    let mut flags = 0u32;
                    if capture
                        .GetBuffer(&mut data, &mut n_frames, &mut flags, None, None)
                        .is_err()
                    {
                        break 'outer;
                    }
                    if n_frames > 0 {
                        let silent = flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0;
                        let samples = std::slice::from_raw_parts(
                            data as *const f32,
                            n_frames as usize * channels,
                        );
                        let mut ring = match ring.lock() {
                            Ok(r) => r,
                            Err(p) => p.into_inner(),
                        };
                        let mut peak = 0.0f32;
                        for frame in samples.chunks(channels) {
                            let mean = if silent {
                                0.0
                            } else {
                                frame.iter().copied().sum::<f32>() / frame.len().max(1) as f32
                            };
                            peak = peak.max(mean.abs());
                            ring.push_frame(mean);
                        }
                        drop(ring);
                        frames.fetch_add(1, Ordering::Relaxed);
                        // "Data" means REAL audio, not a mere delivered packet:
                        // an app rendering spatial audio (Apple Music Atmos)
                        // holds a SILENT keep-alive session in its own process
                        // while the audible PCM is mixed downstream. Stamping
                        // last_data_ms on those silent packets would keep
                        // has_data() true and strand the capture — the owner
                        // could never demote to the device fallback that CAN
                        // hear the endpoint mix. So only signal above
                        // SILENCE_EPS counts. max(1): 0 is has_data's "never
                        // delivered" sentinel, and a first packet CAN land
                        // inside the epoch's first millisecond.
                        if peak > SILENCE_EPS {
                            last_data_ms.store(
                                (epoch.elapsed().as_millis() as u64).max(1),
                                Ordering::Relaxed,
                            );
                        }
                    }
                    if capture.ReleaseBuffer(n_frames).is_err() {
                        break 'outer;
                    }
                }
            }
            let _ = client.Stop();
        }
        let _ = CloseHandle(event);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    /// Exe stem of a pid (best-effort), for naming a joined/enumerated process.
    fn pid_exe(pid: u32) -> String {
        if pid == 0 {
            return "(system)".into();
        }
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(h) => {
                    let stem = process_stem(h).unwrap_or_default();
                    let _ = CloseHandle(h);
                    stem
                }
                Err(_) => String::new(),
            }
        }
    }

    /// One render session on the default endpoint.
    struct SessionInfo {
        pid: u32,
        exe: String,
        active: bool,
        aumid: String,
    }

    /// Diagnostic: every render session on the DEFAULT endpoint — pid, exe,
    /// active-state, AUMID. Apple Music splits the GSMTC process from the audio
    /// process (AppleMusic.exe vs AMPLibraryAgent.exe); this dump is how we see
    /// WHICH process actually renders a player's audio and whether our AUMID
    /// join can reach it. Test-only.
    fn debug_render_sessions() -> Vec<SessionInfo> {
        let mut out = Vec::new();
        unsafe {
            let Ok(enumerator) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            else {
                return out;
            };
            let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) else {
                return out;
            };
            let Ok(manager) = device
                .Activate::<windows::Win32::Media::Audio::IAudioSessionManager2>(CLSCTX_ALL, None)
            else {
                return out;
            };
            let Ok(sessions) = manager.GetSessionEnumerator() else {
                return out;
            };
            let count = sessions.GetCount().unwrap_or(0);
            for i in 0..count {
                let Ok(control) = sessions.GetSession(i) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let pid = control2.GetProcessId().unwrap_or(0);
                let active = control
                    .GetState()
                    .map(|s| s == AudioSessionStateActive)
                    .unwrap_or(false);
                let aumid = if pid != 0 {
                    match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                        Ok(h) => {
                            let a = process_aumid(h).unwrap_or_default();
                            let _ = CloseHandle(h);
                            a
                        }
                        Err(_) => String::new(),
                    }
                } else {
                    String::new()
                };
                out.push(SessionInfo {
                    pid,
                    exe: pid_exe(pid),
                    active,
                    aumid,
                });
            }
        }
        out
    }

    /// Process-capture `pid`'s tree for `secs` and return (packets, rms). rms>0
    /// means that process's audio is capturable via process loopback.
    fn capture_pid_rms(pid: u32, secs: u64) -> Option<(u64, f32)> {
        let target = open_target(pid)?;
        let ring = Arc::new(Mutex::new(Ring::new()));
        let frames = Arc::new(AtomicU64::new(0));
        let _cap = ProcessCapture::open(target, ring.clone(), frames.clone())?;
        std::thread::sleep(Duration::from_secs(secs));
        let packets = frames.load(Ordering::Relaxed);
        let samples = ring
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot();
        let rms = (samples.iter().map(|s| s * s).sum::<f32>() / samples.len().max(1) as f32).sqrt();
        Some((packets, rms))
    }

    /// Live probe — needs music actually playing. Dumps the render-session
    /// topology, reports the AUMID join Palette would make, then DIRECTLY
    /// process-captures every ACTIVE session to find whichever process actually
    /// renders the audio (regardless of AUMID). Passive (no window, no
    /// single-instance claim), safe to run beside the installed app.
    /// Run: cargo test --lib live_probe -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_probe() {
        unsafe {
            let _ = windows::Win32::System::Com::CoInitializeEx(
                None,
                windows::Win32::System::Com::COINIT_MULTITHREADED,
            );
        }
        let me = std::process::id();
        let Some((aumid, _, _, status)) = crate::media::tick_key() else {
            eprintln!("probe: no GSMTC session — start music first");
            return;
        };
        eprintln!("probe: GSMTC session {aumid:?} status={status}");

        let sessions = debug_render_sessions();
        eprintln!("probe: render sessions on the DEFAULT endpoint:");
        for s in &sessions {
            eprintln!(
                "  pid={} exe={:?} active={} aumid={:?}",
                s.pid, s.exe, s.active, s.aumid
            );
        }
        if !sessions
            .iter()
            .any(|s| s.active && s.pid != 0 && s.pid != me)
        {
            eprintln!(
                "probe: NO ACTIVE non-self render session on the default endpoint. If the app is playing + audible, its audio is NOT on this endpoint's SHARED mix — WASAPI exclusive-mode (bit-perfect) or a DIFFERENT output device. Neither process nor device loopback can capture that."
            );
        }

        // What Palette's AUMID join resolves to today (the current behavior).
        match resolve_target(&aumid) {
            Some(t) => eprintln!("probe: AUMID join → pid={} exe={:?}", t.pid, pid_exe(t.pid)),
            None => eprintln!("probe: AUMID join → NO MATCH (rides the device-mix fallback)"),
        }

        // The decisive test: process-capture each ACTIVE session's process
        // directly. If the player's real audio process (e.g. AMPLibraryAgent
        // for Apple Music) shows rms>0 here, the audio IS process-capturable
        // and the fix is to JOIN that pid (package-family match). If every
        // active session reads rms≈0 while the app is audibly playing, the
        // audio bypasses the shared mix (exclusive mode / other endpoint) and
        // NO loopback can see it.
        eprintln!("probe: direct process-capture of each ACTIVE session (2s each):");
        let mut any_real = false;
        for s in sessions
            .iter()
            .filter(|s| s.active && s.pid != 0 && s.pid != me)
        {
            match capture_pid_rms(s.pid, 2) {
                Some((packets, rms)) => {
                    let real = rms > SILENCE_EPS;
                    any_real |= real;
                    eprintln!(
                        "  pid={} exe={:?}: packets={packets} rms={rms:.5} {}",
                        s.pid,
                        s.exe,
                        if real {
                            "← REAL AUDIO (capturable — join this pid)"
                        } else {
                            "(silent to process loopback)"
                        }
                    );
                }
                None => eprintln!("  pid={} exe={:?}: capture failed to open", s.pid, s.exe),
            }
        }
        eprintln!(
            "probe: VERDICT — {}",
            if any_real {
                "an active session IS process-capturable. Fix = resolve_target should join that process (match the package family, not one AUMID). No whole-mix bleed."
            } else {
                "no active session yielded real audio via loopback. The app's audio bypasses the shared mix (WASAPI exclusive-mode or a non-default endpoint) — loopback cannot capture it; the honest options are a resting dot for that case or asking the app to play in shared mode."
            }
        );
    }
}
