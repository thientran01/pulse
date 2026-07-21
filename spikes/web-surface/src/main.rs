//! Palette "web surface" spike — the hosted-web tier of the parked Surfaces
//! concept (vault: Ideas/Palette Surfaces.md), standing alone off the 1.0 path.
//!
//! A minimal always-on-top window hosting a real site in WebView2. Answers the
//! spike questions live: DRM playback (Netflix), login persistence (own
//! WebView2 profile, independent of any installed browser), always-on-top over
//! borderless-fullscreen games, and window-drag/resize feel with native
//! decorations. Deliberately NO Palette chrome — frameless + dock grammar +
//! Search summoning belong to the post-1.0 design pass.
//!
//! Usage: web-surface [url]        (default: https://www.netflix.com/)
//! Seat + profile live in %APPDATA%\palette-web-surface-spike\.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf};

use tao::{
    dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
};
use wry::{WebContext, WebViewBuilder};

const DEFAULT_URL: &str = "https://www.netflix.com/";
const DEFAULT_SIZE: LogicalSize<f64> = LogicalSize::new(560.0, 345.0);

fn data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("palette-web-surface-spike")
}

fn seat_path() -> PathBuf {
    data_dir().join("seat.txt")
}

/// "x y w h" in physical pixels. Plain text keeps the spike dependency-free.
fn load_seat() -> Option<(i32, i32, u32, u32)> {
    let s = fs::read_to_string(seat_path()).ok()?;
    let mut it = s.split_whitespace().filter_map(|t| t.parse::<i64>().ok());
    let (x, y) = (it.next()?, it.next()?);
    let (w, h) = (it.next()?, it.next()?);
    // A stale seat from a detached monitor can strand the window; sanity-floor
    // the size and let Windows clamp the position on show.
    if w < 200 || h < 120 {
        return None;
    }
    Some((x as i32, y as i32, w as u32, h as u32))
}

fn save_seat(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) {
    let _ = fs::create_dir_all(data_dir());
    let _ = fs::write(
        seat_path(),
        format!("{} {} {} {}", pos.x, pos.y, size.width, size.height),
    );
}

fn main() -> wry::Result<()> {
    let url = std::env::args()
        .nth(1)
        .unwrap_or_else(|| DEFAULT_URL.to_string());

    let event_loop = EventLoopBuilder::<String>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    let mut builder = WindowBuilder::new()
        .with_title("web surface")
        .with_always_on_top(true);
    builder = match load_seat() {
        Some((x, y, w, h)) => builder
            .with_position(PhysicalPosition::new(x, y))
            .with_inner_size(PhysicalSize::new(w, h)),
        None => builder.with_inner_size(DEFAULT_SIZE),
    };
    let window = builder.build(&event_loop).expect("window creation failed");

    // Own WebView2 profile: Netflix login persists across runs and stays
    // independent of Edge/Chrome. Deleting the folder is the full reset.
    let mut web_context = WebContext::new(Some(data_dir().join("profile")));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_url(&url)
        .with_document_title_changed_handler(move |title| {
            let _ = proxy.send_event(title);
        })
        .build(&window)?;

    event_loop.run(move |event, _target, control_flow| {
        *control_flow = ControlFlow::Wait;
        // The webview must live as long as the loop; referencing it here keeps
        // it owned by the closure.
        let _keep_alive = &webview;
        match event {
            Event::UserEvent(title) => {
                window.set_title(&format!("{title} — web surface"));
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                if let Ok(pos) = window.outer_position() {
                    save_seat(pos, window.inner_size());
                }
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    })
}
