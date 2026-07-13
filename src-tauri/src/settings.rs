/*
 * app_data/settings.json — the shared key-value settings file, read-modify-
 * write. Grew out of lib.rs's companion-only helpers: save_companion used to
 * write `{"companion": on}` WHOLESALE, which was fine while companion was the
 * only key and a silent clobber the moment a second one existed (the Last.fm
 * key is the second). All writers go through set_value now.
 *
 * Writes are serialized by a module mutex — two tray toggles can't interleave
 * their read-modify-write. The file is tiny, writers are rare (tray clicks,
 * hand edits while the app is closed), and hand edits during a live write
 * lose politely (last writer wins whole-file).
 */
use std::path::PathBuf;
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager};

static WRITE_GATE: Mutex<()> = Mutex::new(());

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

fn read_root(app: &AppHandle) -> Value {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn get_value(app: &AppHandle, key: &str) -> Option<Value> {
    read_root(app).get(key).cloned()
}

pub fn get_string(app: &AppHandle, key: &str) -> Option<String> {
    get_value(app, key)?.as_str().map(str::to_string)
}

pub fn get_bool(app: &AppHandle, key: &str, default: bool) -> bool {
    get_value(app, key).and_then(|v| v.as_bool()).unwrap_or(default)
}

pub fn set_value(app: &AppHandle, key: &str, value: Value) {
    let _gate = WRITE_GATE.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(p) = path(app) else { return };
    let mut root = read_root(app);
    root.as_object_mut()
        .expect("read_root always yields an object")
        .insert(key.to_string(), value);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // In-session behavior rides in-memory state either way; a failed write
    // only surfaces at next launch — say so instead of diverging silently.
    if let Err(e) = std::fs::write(&p, root.to_string()) {
        eprintln!("settings: {key} not persisted: {e}");
    }
}
