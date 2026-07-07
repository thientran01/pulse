//! M0 feasibility spike: what do Apple Music / Spotify actually honor over GSMTC?
//! Throwaway CLI — the deliverable is docs/smtc-support-matrix.md in the repo root.
//!
//! Usage:
//!   smtc-spike list
//!   smtc-spike probe <app-match>
//!   smtc-spike playpause <app-match>
//!   smtc-spike next <app-match>
//!   smtc-spike prev <app-match>
//!   smtc-spike seekrel <app-match> <delta-secs>   (negative = rewind)
//!   smtc-spike watch <app-match> <secs>           (does reported position advance?)

use std::thread::sleep;
use std::time::Duration;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM};
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP,
    VIRTUAL_KEY, VK_CONTROL, VK_LEFT, VK_RIGHT,
};
use windows::Win32::Foundation::{LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible,
    SendMessageW, SetForegroundWindow, WM_APPCOMMAND,
};

const APPCOMMAND_MEDIA_FAST_FORWARD: isize = 49;
const APPCOMMAND_MEDIA_REWIND: isize = 50;

static mut FOUND_HWND: Option<HWND> = None;
static mut ALL_TITLED: Vec<(isize, String)> = Vec::new();

unsafe extern "system" fn enum_all_cb(hwnd: HWND, _l: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf);
        if n > 0 {
            let title = String::from_utf16_lossy(&buf[..n as usize]);
            ALL_TITLED.push((hwnd.0 as isize, title));
        }
    }
    BOOL(1)
}

/// Windows plausibly belonging to Apple Music (main window + MiniPlayer).
fn am_windows() -> Vec<(isize, String)> {
    unsafe {
        ALL_TITLED = Vec::new();
        let _ = EnumWindows(Some(enum_all_cb), LPARAM(0));
        ALL_TITLED
            .iter()
            .filter(|(_, t)| t.contains("Apple Music") || t.contains("MiniPlayer"))
            .cloned()
            .collect()
    }
}

mod uia {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
    };
    use windows::Win32::System::Variant::{VARIANT, VT_I4};
    use windows::Win32::UI::Accessibility::{
        CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationRangeValuePattern,
        TreeScope_Descendants, UIA_RangeValuePatternId, UIA_SliderControlTypeId,
        UIA_ControlTypePropertyId,
    };

    /// VT_I4 VARIANT — windows-rs 0.61's Win32 VARIANT has no From impls.
    fn variant_i32(value: i32) -> VARIANT {
        let mut v = VARIANT::default();
        unsafe {
            (*v.Anonymous.Anonymous).vt = VT_I4;
            (*v.Anonymous.Anonymous).Anonymous.lVal = value;
        }
        v
    }

    pub struct SliderInfo {
        pub name: String,
        pub automation_id: String,
        pub min: f64,
        pub max: f64,
        pub value: f64,
        pub read_only: bool,
    }

    pub fn init() -> windows::core::Result<IUIAutomation> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)
        }
    }

    pub fn find_sliders(
        uia: &IUIAutomation,
        hwnd: isize,
    ) -> windows::core::Result<Vec<(IUIAutomationElement, SliderInfo)>> {
        unsafe {
            let root = uia.ElementFromHandle(HWND(hwnd as _))?;
            let cond = uia.CreatePropertyCondition(
                UIA_ControlTypePropertyId,
                &variant_i32(UIA_SliderControlTypeId.0),
            )?;
            let found = root.FindAll(TreeScope_Descendants, &cond)?;
            let mut out = Vec::new();
            for i in 0..found.Length()? {
                let el = found.GetElement(i)?;
                let name = el.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                let automation_id = el.CurrentAutomationId().map(|s| s.to_string()).unwrap_or_default();
                let Ok(unk) = el.GetCurrentPattern(UIA_RangeValuePatternId) else {
                    continue;
                };
                let Ok(range) = windows::core::Interface::cast::<IUIAutomationRangeValuePattern>(&unk) else {
                    continue;
                };
                let info = SliderInfo {
                    name,
                    automation_id,
                    min: range.CurrentMinimum().unwrap_or(f64::NAN),
                    max: range.CurrentMaximum().unwrap_or(f64::NAN),
                    value: range.CurrentValue().unwrap_or(f64::NAN),
                    read_only: range.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(true),
                };
                out.push((el, info));
            }
            Ok(out)
        }
    }

    pub fn set_value(el: &IUIAutomationElement, value: f64) -> windows::core::Result<()> {
        unsafe {
            let unk = el.GetCurrentPattern(UIA_RangeValuePatternId)?;
            let range: IUIAutomationRangeValuePattern = windows::core::Interface::cast(&unk)?;
            range.SetValue(value)
        }
    }
}

unsafe extern "system" fn enum_cb(hwnd: HWND, _l: LPARAM) -> BOOL {
    if IsWindowVisible(hwnd).as_bool() {
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(hwnd, &mut buf);
        let title = String::from_utf16_lossy(&buf[..n as usize]);
        if title.contains("Apple Music") {
            FOUND_HWND = Some(hwnd);
            return BOOL(0); // stop
        }
    }
    BOOL(1)
}

fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    // Arrow keys are extended keys; without the flag some apps see numpad arrows.
    let extended = matches!(vk, VK_LEFT | VK_RIGHT);
    let mut flags = if up { KEYEVENTF_KEYUP } else { Default::default() };
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// Focus-flick the Apple Music window, send Ctrl+(Shift)+Left/Right, restore focus.
fn am_keystroke_seek(forward: bool, with_modifier: Option<&str>) -> Result<(), String> {
    unsafe {
        FOUND_HWND = None;
        let _ = EnumWindows(Some(enum_cb), LPARAM(0));
        let am = FOUND_HWND.ok_or("no visible 'Apple Music' window")?;
        let prev = GetForegroundWindow();
        let prev_thread = GetWindowThreadProcessId(prev, None);
        let me = GetCurrentThreadId();
        let attached = AttachThreadInput(me, prev_thread, true).as_bool();
        let mut set = SetForegroundWindow(am).as_bool();
        if !set {
            // Modifier-tap hack: receiving synthesized input grants us foreground
            // rights. Ctrl (not Alt — Alt toggles XAML key-tip mode and can eat
            // the next real accelerator).
            SendInput(&[key(VK_CONTROL, false), key(VK_CONTROL, true)], std::mem::size_of::<INPUT>() as i32);
            sleep(Duration::from_millis(30));
            set = SetForegroundWindow(am).as_bool();
        }
        println!("attach={attached} set_foreground={set}");
        sleep(Duration::from_millis(80));
        let arrow = if forward { VK_RIGHT } else { VK_LEFT };
        let modifier = match with_modifier {
            Some("shift") => Some(VIRTUAL_KEY(0x10)),
            Some("alt") => Some(VIRTUAL_KEY(0x12)),
            _ => None,
        };
        let mut inputs = vec![key(VK_CONTROL, false)];
        if let Some(m) = modifier {
            inputs.push(key(m, false));
        }
        inputs.extend([key(arrow, false), key(arrow, true)]);
        if let Some(m) = modifier {
            inputs.push(key(m, true));
        }
        inputs.push(key(VK_CONTROL, true));
        let sent = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
        println!("sent {sent}/{} inputs", inputs.len());
        sleep(Duration::from_millis(80));
        let _ = SetForegroundWindow(prev);
        if attached {
            let _ = AttachThreadInput(me, prev_thread, false);
        }
    }
    Ok(())
}

const TICKS_PER_SEC: i64 = 10_000_000; // WinRT TimeSpan = 100ns ticks

fn manager() -> windows::core::Result<Manager> {
    Manager::RequestAsync()?.get()
}

fn find_session(m: &Manager, needle: &str) -> Option<Session> {
    let needle = needle.to_lowercase();
    m.GetSessions().ok()?.into_iter().find(|s| {
        s.SourceAppUserModelId()
            .map(|id| id.to_string().to_lowercase().contains(&needle))
            .unwrap_or(false)
    })
}

fn fmt_ticks(ticks: i64) -> String {
    let secs = ticks / TICKS_PER_SEC;
    format!("{}:{:02}.{:03}", secs / 60, secs % 60, (ticks % TICKS_PER_SEC) / 10_000)
}

fn probe(s: &Session) -> windows::core::Result<()> {
    println!("app_id: {}", s.SourceAppUserModelId()?);

    match s.TryGetMediaPropertiesAsync()?.get() {
        Ok(p) => {
            println!("title:  {}", p.Title().unwrap_or_default());
            println!("artist: {}", p.Artist().unwrap_or_default());
            println!("album:  {}", p.AlbumTitle().unwrap_or_default());
            let thumb = p.Thumbnail().is_ok();
            println!("thumbnail_ref_present: {thumb}");
        }
        Err(e) => println!("media_properties: ERROR {e}"),
    }

    let info = s.GetPlaybackInfo()?;
    println!("status: {:?}", info.PlaybackStatus()?);
    let c = info.Controls()?;
    println!("controls:");
    println!("  play/pause_toggle: {}", c.IsPlayPauseToggleEnabled()?);
    println!("  next: {}  prev: {}", c.IsNextEnabled()?, c.IsPreviousEnabled()?);
    println!("  playback_position (seek): {}", c.IsPlaybackPositionEnabled()?);
    println!("  fast_forward: {}  rewind: {}", c.IsFastForwardEnabled()?, c.IsRewindEnabled()?);

    let t = s.GetTimelineProperties()?;
    println!("timeline:");
    println!("  position: {}", fmt_ticks(t.Position()?.Duration));
    println!("  start–end: {} – {}", fmt_ticks(t.StartTime()?.Duration), fmt_ticks(t.EndTime()?.Duration));
    println!("  min–max_seek: {} – {}", fmt_ticks(t.MinSeekTime()?.Duration), fmt_ticks(t.MaxSeekTime()?.Duration));
    Ok(())
}

fn main() -> windows::core::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let m = manager()?;

    match args.first().map(String::as_str) {
        Some("list") => {
            let current = m
                .GetCurrentSession()
                .ok()
                .and_then(|s| s.SourceAppUserModelId().ok())
                .map(|h| h.to_string())
                .unwrap_or_default();
            for s in m.GetSessions()? {
                let id = s.SourceAppUserModelId()?.to_string();
                let marker = if id == current { "  <- current" } else { "" };
                println!("{id}{marker}");
            }
        }
        Some("probe") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            probe(&s)?;
        }
        Some("playpause") | Some("next") | Some("prev") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            let ok = match args[0].as_str() {
                "playpause" => s.TryTogglePlayPauseAsync()?.get()?,
                "next" => s.TrySkipNextAsync()?.get()?,
                _ => s.TrySkipPreviousAsync()?.get()?,
            };
            println!("{} accepted: {ok}", args[0]);
            sleep(Duration::from_millis(700));
            println!("status_after: {:?}", s.GetPlaybackInfo()?.PlaybackStatus()?);
        }
        Some("seekrel") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            let delta: i64 = args[2].parse().expect("delta secs");
            let before = s.GetTimelineProperties()?.Position()?.Duration;
            let target = before + delta * TICKS_PER_SEC;
            let ok = s.TryChangePlaybackPositionAsync(target)?.get()?;
            println!("seek accepted: {ok}");
            println!("before: {}", fmt_ticks(before));
            println!("target: {}", fmt_ticks(target));
            sleep(Duration::from_millis(900));
            let after = s.GetTimelineProperties()?.Position()?.Duration;
            println!("after:  {}  (moved {:+.1}s)", fmt_ticks(after), (after - before) as f64 / TICKS_PER_SEC as f64);
        }
        Some("art") => {
            use windows::Storage::Streams::{Buffer, DataReader, InputStreamOptions};
            let s = find_session(&m, &args[1]).expect("no session matches");
            let props = s.TryGetMediaPropertiesAsync()?.get()?;
            let thumb = props.Thumbnail()?;
            let stream = thumb.OpenReadAsync()?.get()?;
            let size = stream.Size()?;
            let mime = stream.ContentType().map(|h| h.to_string()).unwrap_or_default();
            const CHUNK: u32 = 262_144;
            let mut bytes: Vec<u8> = Vec::with_capacity(size as usize);
            let mut reads = 0;
            while (bytes.len() as u64) < size {
                let b = Buffer::Create(CHUNK)?;
                let b = stream.ReadAsync(&b, CHUNK, InputStreamOptions::ReadAhead)?.get()?;
                let len = b.Length()? as usize;
                if len == 0 {
                    break;
                }
                let r = DataReader::FromBuffer(&b)?;
                let mut part = vec![0u8; len];
                r.ReadBytes(&mut part)?;
                bytes.extend_from_slice(&part);
                reads += 1;
            }
            let head = bytes.iter().take(4).map(|b| format!("{b:02x}")).collect::<String>();
            let tail = bytes.iter().rev().take(2).map(|b| format!("{b:02x}")).collect::<Vec<_>>();
            println!(
                "mime={mime} declared={size}B read={}B in {reads} read(s) head={head} tail={}{}",
                bytes.len(),
                tail.get(1).cloned().unwrap_or_default(),
                tail.first().cloned().unwrap_or_default(),
            );
        }
        Some("uialist") => {
            let u = uia::init().expect("UIA init failed");
            for (hwnd, title) in am_windows() {
                println!("window {hwnd:#x} \"{title}\"");
                match uia::find_sliders(&u, hwnd) {
                    Ok(sliders) if sliders.is_empty() => println!("  (no RangeValue sliders)"),
                    Ok(sliders) => {
                        for (_, s) in sliders {
                            println!(
                                "  slider name={:?} id={:?} min={} max={} value={} read_only={}",
                                s.name, s.automation_id, s.min, s.max, s.value, s.read_only
                            );
                        }
                    }
                    Err(e) => println!("  UIA error: {e}"),
                }
            }
        }
        Some("uiaseek") => {
            // uiaseek <delta-secs> — pick the scrubber (max ≈ SMTC duration),
            // SetValue, verify via the SMTC timeline.
            let delta: f64 = args.get(1).and_then(|s| s.parse().ok()).expect("delta secs");
            let s = find_session(&m, "applemusic").expect("no Apple Music session");
            let t = s.GetTimelineProperties()?;
            let dur_s = t.EndTime()?.Duration as f64 / TICKS_PER_SEC as f64;
            let before = t.Position()?.Duration;
            let before_s = before as f64 / TICKS_PER_SEC as f64;

            let u = uia::init().expect("UIA init failed");
            let mut done = false;
            for (hwnd, title) in am_windows() {
                let Ok(sliders) = uia::find_sliders(&u, hwnd) else { continue };
                for (el, info) in sliders {
                    let looks_like_scrubber = !info.read_only
                        && info.max > 30.0
                        && (info.max - dur_s).abs() < 3.0;
                    println!(
                        "window \"{title}\" slider {:?}/{:?} max={} (dur={dur_s:.0}) -> scrubber? {looks_like_scrubber}",
                        info.name, info.automation_id, info.max
                    );
                    if !looks_like_scrubber || done {
                        continue;
                    }
                    let target = (info.value + delta).clamp(info.min, info.max);
                    println!("SetValue {:.1} -> {:.1}", info.value, target);
                    match uia::set_value(&el, target) {
                        Ok(()) => done = true,
                        Err(e) => println!("SetValue failed: {e}"),
                    }
                }
            }
            if !done {
                println!("no scrubber accepted SetValue");
            }
            sleep(Duration::from_millis(1200));
            let after = s.GetTimelineProperties()?.Position()?.Duration;
            println!("smtc before: {}", fmt_ticks(before));
            println!(
                "smtc after:  {}  (moved {:+.1}s incl ~1.2s playback, wanted {delta:+.1}s from {before_s:.1}s)",
                fmt_ticks(after),
                (after - before) as f64 / TICKS_PER_SEC as f64
            );
        }
        Some("uiaseek2") => {
            // uiaseek2 <delta-secs> <window-title-match> — seek via ONE window's
            // scrubber; read back slider value + SMTC at +0.3s and +1.5s.
            let delta: f64 = args.get(1).and_then(|s| s.parse().ok()).expect("delta secs");
            let title_match = args.get(2).map(String::as_str).expect("window match");
            let s = find_session(&m, "applemusic").expect("no Apple Music session");
            println!("status: {:?}", s.GetPlaybackInfo()?.PlaybackStatus()?);
            let u = uia::init().expect("UIA init failed");
            let win = am_windows()
                .into_iter()
                .find(|(_, t)| t.to_lowercase().contains(&title_match.to_lowercase()))
                .expect("no matching AM window");
            println!("targeting window \"{}\"", win.1);
            let sliders = uia::find_sliders(&u, win.0).expect("find_sliders failed");
            let (el, info) = sliders
                .into_iter()
                .find(|(_, i)| !i.read_only && i.max > 30.0)
                .expect("no writable scrubber in this window");
            let target = (info.value + delta).clamp(info.min, info.max);
            let smtc_before = s.GetTimelineProperties()?.Position()?.Duration;
            println!(
                "slider {:?} value {:.1} -> SetValue {:.1} | smtc {}",
                info.automation_id, info.value, target, fmt_ticks(smtc_before)
            );
            uia::set_value(&el, target).expect("SetValue failed");
            for wait_ms in [300u64, 1200] {
                sleep(Duration::from_millis(wait_ms));
                let slider_now = uia::find_sliders(&u, win.0)
                    .ok()
                    .and_then(|v| v.into_iter().find(|(_, i)| !i.read_only && i.max > 30.0))
                    .map(|(_, i)| i.value)
                    .unwrap_or(f64::NAN);
                let smtc_now = s.GetTimelineProperties()?.Position()?.Duration;
                println!(
                    "  +{}ms: slider={slider_now:.1} smtc={}",
                    wait_ms,
                    fmt_ticks(smtc_now)
                );
            }
        }
        Some("amappcmd") => {
            let s = find_session(&m, "applemusic").expect("no Apple Music session");
            let forward = args.get(1).map(String::as_str) != Some("back");
            let before = s.GetTimelineProperties()?.Position()?.Duration;
            unsafe {
                FOUND_HWND = None;
                let _ = EnumWindows(Some(enum_cb), LPARAM(0));
                let am = FOUND_HWND.expect("no visible 'Apple Music' window");
                let cmd = if forward { APPCOMMAND_MEDIA_FAST_FORWARD } else { APPCOMMAND_MEDIA_REWIND };
                let res: LRESULT = SendMessageW(am, WM_APPCOMMAND, Some(WPARAM(0)), Some(LPARAM(cmd << 16)));
                println!("appcommand result: {}", res.0);
            }
            sleep(Duration::from_millis(900));
            let after = s.GetTimelineProperties()?.Position()?.Duration;
            println!("before: {}", fmt_ticks(before));
            println!("after:  {}  (moved {:+.1}s incl ~1s playback)", fmt_ticks(after), (after - before) as f64 / TICKS_PER_SEC as f64);
        }
        Some("amseek") => {
            let s = find_session(&m, "applemusic").expect("no Apple Music session");
            let forward = args.get(1).map(String::as_str) != Some("back");
            let modifier = args.get(2).map(String::as_str);
            let before = s.GetTimelineProperties()?.Position()?.Duration;
            am_keystroke_seek(forward, modifier).expect("keystroke seek failed");
            sleep(Duration::from_millis(900));
            let after = s.GetTimelineProperties()?.Position()?.Duration;
            println!("before: {}", fmt_ticks(before));
            println!("after:  {}  (moved {:+.1}s incl ~1s playback)", fmt_ticks(after), (after - before) as f64 / TICKS_PER_SEC as f64);
        }
        Some("watch") => {
            let s = find_session(&m, &args[1]).expect("no session matches");
            let secs: u64 = args[2].parse().expect("secs");
            for _ in 0..secs {
                let t = s.GetTimelineProperties()?;
                println!(
                    "pos={} status={:?} last_updated_ticks={}",
                    fmt_ticks(t.Position()?.Duration),
                    s.GetPlaybackInfo()?.PlaybackStatus()?,
                    t.LastUpdatedTime()?.UniversalTime
                );
                sleep(Duration::from_secs(1));
            }
        }
        _ => println!("usage: smtc-spike list | probe <app> | playpause <app> | next <app> | prev <app> | seekrel <app> <secs> | watch <app> <secs>"),
    }
    Ok(())
}
