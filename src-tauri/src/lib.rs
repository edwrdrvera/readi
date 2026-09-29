mod db;
mod library;
mod model;
mod prefs;
mod protocol;

use library::Library;
use model::*;
use protocol::TransportStats;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

type Lib<'a> = State<'a, Arc<Library>>;

#[derive(Serialize)]
struct BookDetail {
    book: BookSummary,
    progress: Option<Progress>,
    toc: Vec<TocItem>,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ImportOutcome {
    Imported { path: String, result: ImportResult },
    Failed { path: String, reason: String },
}

#[tauri::command]
fn list_books(lib: Lib) -> Result<Vec<BookSummary>, String> {
    db::list_books(&lib.conn.lock().unwrap())
}

#[tauri::command]
async fn import_books(lib: Lib<'_>, paths: Vec<String>) -> Result<Vec<ImportOutcome>, String> {
    let lib = lib.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| match lib.import(&PathBuf::from(&path)) {
                Ok(result) => ImportOutcome::Imported { path, result },
                Err(reason) => ImportOutcome::Failed { path, reason },
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_book(lib: Lib, id: i64) -> Result<BookDetail, String> {
    let conn = lib.conn.lock().unwrap();
    db::mark_opened(&conn, id)?;
    Ok(BookDetail {
        book: db::get_book(&conn, id)?.ok_or("Book not found")?,
        progress: db::get_progress(&conn, id)?,
        toc: db::get_toc(&conn, id)?,
    })
}

#[tauri::command]
fn save_progress(lib: Lib, id: i64, locator: Locator, percent: f64) -> Result<i64, String> {
    db::save_progress(&lib.conn.lock().unwrap(), id, &locator, percent)
}

#[tauri::command]
fn claim_extraction_job(lib: Lib, reclaim_stale: bool) -> Result<Option<BookSummary>, String> {
    let conn = lib.conn.lock().unwrap();
    match db::claim_job(&conn, reclaim_stale)? {
        Some(id) => db::get_book(&conn, id),
        None => Ok(None),
    }
}

#[tauri::command]
fn submit_metadata(lib: Lib, id: i64, metadata: ExtractedMetadata) -> Result<(), String> {
    db::save_metadata(&lib.conn.lock().unwrap(), id, &metadata)
}

#[tauri::command]
fn submit_text(lib: Lib, id: i64, extractor_version: u32, segments: Vec<TextSegment>) -> Result<IndexState, String> {
    db::replace_text(&lib.conn.lock().unwrap(), id, extractor_version, &segments)
}

#[tauri::command]
fn fail_extraction(lib: Lib, id: i64, error: String) -> Result<(), String> {
    db::fail_job(&lib.conn.lock().unwrap(), id, &error)
}

#[tauri::command]
fn transport_stats(stats: State<Arc<TransportStats>>, id: i64) -> protocol::Stats {
    stats.0.lock().unwrap().get(&id).copied().unwrap_or_default()
}

#[tauri::command]
fn count_text_matches(lib: Lib, id: i64, word: String) -> Result<i64, String> {
    db::search_count(&lib.conn.lock().unwrap(), id, &word)
}

#[tauri::command]
fn get_prefs(lib: Lib, book_id: Option<i64>) -> Result<prefs::PrefsState, String> {
    let conn = lib.conn.lock().unwrap();
    Ok(prefs::PrefsState {
        defaults: prefs::get_defaults(&conn)?,
        overrides: match book_id {
            Some(id) => prefs::get_overrides(&conn, id)?,
            None => prefs::Overrides::default(),
        },
    })
}

#[tauri::command]
fn set_default_prefs(lib: Lib, prefs: prefs::Prefs) -> Result<(), String> {
    prefs::set_defaults(&lib.conn.lock().unwrap(), &prefs)
}

#[tauri::command]
fn set_book_pref(lib: Lib, book_id: i64, key: prefs::PrefKey, value: serde_json::Value) -> Result<(), String> {
    prefs::set_book_pref(&lib.conn.lock().unwrap(), book_id, key, value)
}

#[tauri::command]
fn reset_book_prefs(lib: Lib, book_id: i64) -> Result<(), String> {
    prefs::reset_book_prefs(&lib.conn.lock().unwrap(), book_id)
}

/// Packaged-app self test, enabled only when READI_SELFTEST names a report path.
#[derive(Serialize)]
struct SelfTestConfig {
    phase: String,
    fixtures: Vec<String>,
    sha256: serde_json::Value,
}

#[tauri::command]
fn selftest_config() -> Option<SelfTestConfig> {
    std::env::var("READI_SELFTEST").ok()?;
    Some(SelfTestConfig {
        phase: std::env::var("READI_SELFTEST_PHASE").unwrap_or_else(|_| "first".into()),
        fixtures: std::env::var("READI_SELFTEST_FIXTURES")
            .unwrap_or_default()
            .split(':')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        sha256: std::env::var("READI_SELFTEST_SHA").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
    })
}

#[tauri::command]
fn selftest_log(line: String) {
    use std::io::Write;
    if let Ok(path) = std::env::var("READI_SELFTEST") {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{path}.log")) {
            let _ = writeln!(f, "{} {line}", db::now());
        }
    }
}

#[tauri::command]
fn selftest_report(report: serde_json::Value) -> Result<(), String> {
    let path = std::env::var("READI_SELFTEST").map_err(|_| "self test disabled")?;
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&report).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

/// (command id, label, accelerator). The id is the frontend registry id; the
/// frontend owns `when` and `run`, so a menu click only carries the id.
type Item = (&'static str, &'static str, Option<&'static str>);

const FILE: &[Item] = &[("library.import", "Import\u{2026}", Some("CmdOrCtrl+O"))];
const VIEW: &[Item] = &[
    ("sidebar.toggle", "Toggle Contents", Some("CmdOrCtrl+\\")),
    ("mode.toggle", "Toggle Vertical/Horizontal", Some("CmdOrCtrl+Shift+V")),
    ("theme.light", "Light", Some("CmdOrCtrl+1")),
    ("theme.dark", "Dark", Some("CmdOrCtrl+2")),
    ("theme.sepia", "Sepia", Some("CmdOrCtrl+3")),
    ("text.bigger", "Larger", Some("CmdOrCtrl+=")),
    ("text.smaller", "Smaller", Some("CmdOrCtrl+-")),
];
const GO: &[Item] = &[("nav.back", "Back", Some("CmdOrCtrl+[")), ("library.return", "Return to Library", None)];

fn custom_items(app: &AppHandle, items: &[Item]) -> tauri::Result<Vec<MenuItem<Wry>>> {
    items.iter().map(|(id, label, accel)| MenuItem::with_id(app, *id, *label, true, *accel)).collect()
}

fn submenu(app: &AppHandle, title: &str, items: &[Item]) -> tauri::Result<Submenu<Wry>> {
    let items = custom_items(app, items)?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = items.iter().map(|i| i as _).collect();
    Submenu::with_items(app, title, true, &refs)
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let name = app.package_info().name.clone();
    let app_menu = Submenu::with_items(
        app,
        &name,
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;
    Menu::with_items(
        app,
        &[&app_menu, &submenu(app, "File", FILE)?, &edit, &submenu(app, "View", VIEW)?, &submenu(app, "Go", GO)?, &window],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let stats = Arc::new(TransportStats::default());
    let protocol_stats = stats.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .menu(|app| build_menu(app))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if [FILE, VIEW, GO].iter().any(|g| g.iter().any(|(i, ..)| *i == id)) {
                let _ = app.emit("menu-command", id);
            }
        })
        .setup(move |app| {
            let data_dir = match std::env::var("READI_DATA_DIR") {
                Ok(d) => PathBuf::from(d),
                Err(_) => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&data_dir)?;
            let lib = Library::open(&data_dir).map_err(|e| format!("Cannot open library: {e}"))?;
            app.manage(Arc::new(lib));
            app.manage(stats);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("book", move |ctx, request, responder| {
            let lib = ctx.app_handle().state::<Arc<Library>>().inner().clone();
            let stats = protocol_stats.clone();
            tauri::async_runtime::spawn_blocking(move || {
                responder.respond(protocol::handle(&lib, &stats, &request));
            });
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_books,
            open_book,
            save_progress,
            claim_extraction_job,
            submit_metadata,
            submit_text,
            fail_extraction,
            transport_stats,
            count_text_matches,
            get_prefs,
            set_default_prefs,
            set_book_pref,
            reset_book_prefs,
            selftest_config,
            selftest_report,
            selftest_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
