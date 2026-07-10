//! P0 presence spike: what does Windows actually report about the user's context?
//! Throwaway CLI — the deliverable is docs/presence-signal-matrix.md in the repo root.
//!
//! Prints a 1Hz line of every raw signal the presence engine would consume:
//! foreground window (hwnd → pid → exe → title/class), its rect vs its monitor's
//! rect vs the monitor's WORK-AREA rect (the maximized-vs-fullscreen hypothesis),
//! SHQueryUserNotificationState, and GetLastInputInfo idle seconds.
//!
//! Usage:
//!   presence-spike            1Hz table until Ctrl+C
//!   presence-spike changes    print only when the derived verdicts change

use std::thread::sleep;
use std::time::Duration;
use windows::Win32::Foundation::{CloseHandle, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::Shell::SHQueryUserNotificationState;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowTextW,
    GetWindowThreadProcessId,
};
use windows::core::PWSTR;

fn exe_name(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return format!("<pid {pid}: open failed>");
        };
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let name = if QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .is_ok()
        {
            let full = String::from_utf16_lossy(&buf[..len as usize]);
            full.rsplit('\\').next().unwrap_or(&full).to_string()
        } else {
            format!("<pid {pid}: query failed>")
        };
        let _ = CloseHandle(handle);
        name
    }
}

fn rect_str(r: &RECT) -> String {
    format!("({},{})-({},{})", r.left, r.top, r.right, r.bottom)
}

/// rect covers `outer` entirely (allowing it to overhang, which borderless
/// fullscreen sometimes does by a pixel of border).
fn covers(inner: &RECT, outer: &RECT) -> bool {
    inner.left <= outer.left
        && inner.top <= outer.top
        && inner.right >= outer.right
        && inner.bottom >= outer.bottom
}

fn quns_name(v: i32) -> &'static str {
    match v {
        1 => "NOT_PRESENT",
        2 => "BUSY",
        3 => "RUNNING_D3D_FULL_SCREEN",
        4 => "PRESENTATION_MODE",
        5 => "ACCEPTS_NOTIFICATIONS",
        6 => "QUIET_TIME",
        7 => "APP",
        _ => "UNKNOWN",
    }
}

fn idle_secs() -> f64 {
    unsafe {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !GetLastInputInfo(&mut lii).as_bool() {
            return -1.0;
        }
        // Wrapping subtraction: GetTickCount wraps at ~49.7 days and the
        // presence engine must survive that, so the spike proves the math.
        let elapsed = GetTickCount().wrapping_sub(lii.dwTime);
        elapsed as f64 / 1000.0
    }
}

struct Tick {
    line: String,
    verdict: String,
}

fn sample() -> Tick {
    unsafe {
        let quns = SHQueryUserNotificationState()
            .map(|s| s.0)
            .unwrap_or(-1);
        let idle = idle_secs();

        let hwnd = GetForegroundWindow();
        if hwnd == HWND::default() {
            // Lock screen / UAC secure desktop land here. The engine must treat
            // this as "hold current state", never "not fullscreen".
            return Tick {
                line: format!(
                    "fg=<none — secure desktop?>  quns={}({quns})  idle={idle:.0}s",
                    quns_name(quns)
                ),
                verdict: "NO_FOREGROUND".into(),
            };
        }

        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let exe = exe_name(pid);

        let mut title_buf = [0u16; 128];
        let n = GetWindowTextW(hwnd, &mut title_buf);
        let title = String::from_utf16_lossy(&title_buf[..n as usize]);

        let mut class_buf = [0u16; 128];
        let n = GetClassNameW(hwnd, &mut class_buf);
        let class = String::from_utf16_lossy(&class_buf[..n as usize]);

        let mut rect = RECT::default();
        let _ = GetWindowRect(hwnd, &mut rect);

        let hmon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        let _ = GetMonitorInfoW(hmon, &mut mi);

        let covers_monitor = covers(&rect, &mi.rcMonitor);
        let covers_work = covers(&rect, &mi.rcWork);
        // The hypothesis under test: fullscreen covers the MONITOR rect;
        // maximized covers only the WORK AREA (taskbar-height difference).
        // Caveat measured in the matrix: auto-hidden taskbar makes them equal.
        let rect_verdict = if covers_monitor {
            "RECT_FULLSCREEN"
        } else if covers_work {
            "RECT_MAXIMIZED"
        } else {
            "RECT_WINDOWED"
        };

        let shell_class = matches!(class.as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd");

        Tick {
            line: format!(
                "fg={exe} pid={pid} class={class}{} title=\"{}\"\n    rect={} mon={} work={} → {rect_verdict}\n    quns={}({quns})  idle={idle:.0}s",
                if shell_class { " [SHELL]" } else { "" },
                title.chars().take(60).collect::<String>(),
                rect_str(&rect),
                rect_str(&mi.rcMonitor),
                rect_str(&mi.rcWork),
                quns_name(quns),
            ),
            verdict: format!("{exe}|{rect_verdict}|quns={}", quns_name(quns)),
        }
    }
}

fn main() {
    let changes_only = std::env::args().nth(1).as_deref() == Some("changes");
    println!(
        "presence-spike — 1Hz raw presence signals{}. Ctrl+C to stop.\n",
        if changes_only { " (transitions only)" } else { "" }
    );
    let mut last_verdict = String::new();
    loop {
        let tick = sample();
        let changed = tick.verdict != last_verdict;
        if !changes_only || changed {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            println!(
                "[{:02}:{:02}:{:02}]{} {}",
                (now / 3600) % 24,
                (now / 60) % 60,
                now % 60,
                if changed { " *" } else { "  " },
                tick.line
            );
        }
        last_verdict = tick.verdict;
        sleep(Duration::from_secs(1));
    }
}
