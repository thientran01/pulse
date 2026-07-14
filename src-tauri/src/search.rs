/*
 * The summon search — Pulse's FIRST second window (multi-window pioneer;
 * focus mode reuses these seams). Created ONCE, hidden, at setup: WebView2
 * cold-creation costs hundreds of ms, and a summon hotkey that lags is a
 * dead feature. Show = center high on the CURSOR's monitor (the summon's
 * context) + focus; hide = plain hide; blur (lib.rs's Focused(false)
 * handler) and Esc (frontend → search_hide) both dismiss.
 *
 * Visibility here is deliberately OUTSIDE lib.rs's VisIntent /
 * apply_visibility — that composition owns the MAIN window's intent
 * (manual hide vs conceal); the search window has exactly two states and this
 * module is its one show/hide owner (the grep rule's second, window-scoped
 * ledger). The search window never joins the dock/corner system, the hit
 * watcher, or the presence conceal: it is a normal focusable window that
 * exists only while summoned.
 *
 * Multi-window invariants the rest of the codebase now carries for this
 * window (grep anchors): capabilities/default.json lists the label;
 * window-state's denylist excludes it (a launcher recenters per summon,
 * never restores a stale position); dock::on_moved is label-guarded to
 * "main"; UiReactive votes are keyed per window label.
 */
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL: &str = "search";
/// Born at this logical size, never resized (house rule). The webview keeps
/// a shadow gutter inside it; the visible shell is smaller. Sized between
/// Raycast and the first cut's 560×420 (Thien's live call, 2026-07-12 —
/// "too small and hard to read"); the type/row scale in Search.tsx steps
/// up with it.
const W: f64 = 680.0;
const H: f64 = 520.0;

/// Setup-time create-once-hidden. A failure downgrades gracefully: the
/// hotkey and tray simply find no window.
pub fn init(app: &AppHandle) {
    let result = WebviewWindowBuilder::new(
        app,
        LABEL,
        // The query routes main.tsx to the Search root — same param works
        // in a plain browser for mock iteration.
        WebviewUrl::App("index.html?window=search".into()),
    )
    .title("Palette — Search")
    .inner_size(W, H)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .visible(false)
    .build();
    match result {
        Ok(win) => {
            // DWM cross-fades layered (transparent) windows on hide() —
            // show is instant, hide isn't, and the asymmetric fade-out read
            // as a heavy exit (Thien's live feedback, 2026-07-12). This
            // per-window attribute kills DWM transitions both ways.
            #[cfg(windows)]
            if let Ok(hwnd) = win.hwnd() {
                use windows::Win32::Graphics::Dwm::{
                    DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED,
                };
                let disable: windows::core::BOOL = true.into();
                let _ = unsafe {
                    DwmSetWindowAttribute(
                        windows::Win32::Foundation::HWND(hwnd.0),
                        DWMWA_TRANSITIONS_FORCEDISABLED,
                        std::ptr::from_ref(&disable).cast(),
                        std::mem::size_of::<windows::core::BOOL>() as u32,
                    )
                };
            }
        }
        Err(e) => {
            log::error!("search: window create failed ({e}) — summon disabled this run");
        }
    }
}

pub fn toggle(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    if win.is_visible().unwrap_or(false) {
        hide(app);
    } else {
        show(app);
    }
}

pub fn show(app: &AppHandle) {
    let Some(win) = app.get_webview_window(LABEL) else { return };
    // Launcher seat: horizontally centered, upper third — on the monitor the
    // cursor is on. Physical pixels throughout; any failure falls back to a
    // plain center().
    let centered = (|| {
        let pos = win.cursor_position().ok()?;
        let mon = app.monitor_from_point(pos.x, pos.y).ok()??;
        let scale = mon.scale_factor();
        let (w, h) = ((W * scale) as i32, (H * scale) as i32);
        let x = mon.position().x + (mon.size().width as i32 - w) / 2;
        let y = mon.position().y + (mon.size().height as i32 - h) / 3;
        win.set_position(tauri::PhysicalPosition::new(x, y)).ok()
    })();
    if centered.is_none() {
        let _ = win.center();
    }
    let _ = win.show();
    let _ = win.set_focus();
    // The webview re-focuses its input, select-alls the stale query, and
    // recomputes the resurfacing rows on this signal.
    let _ = app.emit_to(LABEL, "search-shown", ());
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(LABEL) {
        let _ = win.hide();
    }
}

/// Esc / background click / post-play dismiss, from the search webview.
#[tauri::command]
pub async fn search_hide(app: AppHandle) {
    hide(&app);
}
