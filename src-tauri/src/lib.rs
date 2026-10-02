mod annotations;
mod db;
mod jobs;
mod library;
mod model;
mod prefs;
mod protocol;
mod search;
mod watch;

use jobs::{Jobs, LibraryEvent};
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
    locations: Vec<Location>,
}

#[tauri::command]
fn list_books(lib: Lib) -> Result<Vec<BookSummary>, String> {
    db::list_books(&lib.conn.lock().unwrap())
}

#[tauri::command]
fn import_books(jobs: State<Arc<Jobs>>, paths: Vec<String>) -> Result<Vec<ImportJob>, String> {
    jobs.enqueue(paths)
}

#[tauri::command]
fn list_import_jobs(jobs: State<Arc<Jobs>>) -> Result<Vec<ImportJob>, String> {
    jobs.list()
}

#[tauri::command]
fn cancel_import(jobs: State<Arc<Jobs>>, job_id: i64) -> Result<(), String> {
    jobs.cancel(job_id)
}

#[tauri::command]
fn get_locations(lib: Lib, id: i64) -> Result<Vec<Location>, String> {
    lib.locations(id)
}

#[tauri::command]
async fn locate_book(lib: Lib<'_>, id: i64, path: String) -> Result<BookSummary, String> {
    let lib = lib.inner().clone();
    tauri::async_runtime::spawn_blocking(move || lib.locate_book(id, &PathBuf::from(path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn remove_book(lib: Lib, id: i64) -> Result<(), String> {
    lib.remove_book(id)
}

#[tauri::command]
fn remove_managed_copy(lib: Lib, id: i64) -> Result<(), String> {
    lib.remove_managed_copy(id)
}

#[tauri::command]
fn set_reading_state(lib: Lib, id: i64, state: ReadingState) -> Result<(), String> {
    db::set_reading_state(&lib.conn.lock().unwrap(), id, state)
}

#[tauri::command]
fn list_collections(lib: Lib) -> Result<Vec<Collection>, String> {
    db::list_collections(&lib.conn.lock().unwrap())
}

#[tauri::command]
fn create_collection(lib: Lib, name: String) -> Result<Collection, String> {
    db::create_collection(&lib.conn.lock().unwrap(), &name)
}

#[tauri::command]
fn rename_collection(lib: Lib, id: i64, name: String) -> Result<(), String> {
    db::rename_collection(&lib.conn.lock().unwrap(), id, &name)
}

#[tauri::command]
fn delete_collection(lib: Lib, id: i64) -> Result<(), String> {
    db::delete_collection(&lib.conn.lock().unwrap(), id)
}

#[tauri::command]
fn set_collection_membership(lib: Lib, collection_id: i64, book_ids: Vec<i64>, member: bool) -> Result<(), String> {
    db::set_collection_membership(&lib.conn.lock().unwrap(), collection_id, &book_ids, member)
}

#[tauri::command]
fn get_ui_settings(lib: Lib) -> Result<UiSettings, String> {
    db::get_ui_settings(&lib.conn.lock().unwrap())
}

#[tauri::command]
fn set_ui_settings(lib: Lib, settings: UiSettings) -> Result<(), String> {
    db::set_ui_settings(&lib.conn.lock().unwrap(), &settings)
}

#[tauri::command]
fn claim_cover_job(lib: Lib) -> Result<Option<BookSummary>, String> {
    let conn = lib.conn.lock().unwrap();
    match db::claim_cover(&conn)? {
        Some(id) => db::get_book(&conn, id),
        None => Ok(None),
    }
}

#[tauri::command]
fn submit_cover(lib: Lib, id: i64, bytes: Option<Vec<u8>>) -> Result<(), String> {
    lib.submit_cover(id, bytes)
}

#[tauri::command]
fn open_book(lib: Lib, id: i64) -> Result<BookDetail, String> {
    let locations = lib.locations(id)?;
    let conn = lib.conn.lock().unwrap();
    db::mark_opened(&conn, id)?;
    Ok(BookDetail {
        book: db::get_book(&conn, id)?.ok_or("Book not found")?,
        progress: db::get_progress(&conn, id)?,
        toc: db::get_toc(&conn, id)?,
        locations,
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
fn retry_extraction(app: AppHandle, lib: Lib, id: i64) -> Result<(), String> {
    db::retry_job(&lib.conn.lock().unwrap(), id)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn reindex_book(app: AppHandle, lib: Lib, id: i64) -> Result<(), String> {
    db::reindex_book(&lib.conn.lock().unwrap(), id)?;
    let _ = app.emit("library-changed", ());
    Ok(())
}

#[tauri::command]
fn search_book(lib: Lib, id: i64, query: String) -> Result<BookSearch, String> {
    search::search_book(&lib.conn.lock().unwrap(), id, &query)
}

#[tauri::command]
fn search_library(lib: Lib, query: String) -> Result<LibrarySearch, String> {
    search::search_library(&lib.conn.lock().unwrap(), &query)
}

#[tauri::command]
fn list_annotations(lib: Lib, book_id: i64) -> Result<Vec<Annotation>, String> {
    annotations::list(&lib.conn.lock().unwrap(), book_id)
}

#[tauri::command]
fn create_annotation(lib: Lib, annotation: NewAnnotation) -> Result<Annotation, String> {
    annotations::create(&lib.conn.lock().unwrap(), annotation)
}

#[tauri::command]
fn update_annotation(lib: Lib, id: i64, patch: AnnotationPatch) -> Result<Annotation, String> {
    annotations::update(&lib.conn.lock().unwrap(), id, patch)
}

#[tauri::command]
fn delete_annotation(lib: Lib, id: i64) -> Result<(), String> {
    annotations::delete(&lib.conn.lock().unwrap(), id)
}

#[tauri::command]
fn set_anchor_states(lib: Lib, states: Vec<(i64, AnchorState)>) -> Result<(), String> {
    annotations::set_anchor_states(&lib.conn.lock().unwrap(), &states)
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
    /// M3 phases: generated inputs and watch dirs, from READI_SELFTEST_M3.
    m3: serde_json::Value,
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
        m3: std::env::var("READI_SELFTEST_M3").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default(),
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
// These have no accelerator: the frontend keydown handler owns ⌘K, ⌘F, ⌘⇧F, and ⌘D so the self test can drive them.
const GO: &[Item] = &[
    ("nav.back", "Back", Some("CmdOrCtrl+[")),
    ("library.return", "Return to Library", None),
    ("palette.open", "Command Palette\u{2026}", None),
    ("search.book", "Find in Book\u{2026}", None),
    ("search.library", "Search Library\u{2026}", None),
    ("bookmark.add", "Add Bookmark", None),
];

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
            let lib = match Library::open(&data_dir) {
                Ok(lib) => Arc::new(lib),
                Err(e) => {
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(format!(
                            "{e}.\n\nYour books and reading data have not been changed. The library is in:\n{}",
                            data_dir.display()
                        ))
                        .title("Readi can't open your library")
                        .kind(MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            let handle = app.handle().clone();
            let jobs = Jobs::new(
                lib.clone(),
                Arc::new(move |event| {
                    let _ = match event {
                        LibraryEvent::ImportJob(job) => handle.emit("import-job", job),
                        LibraryEvent::LibraryChanged => handle.emit("library-changed", ()),
                    };
                }),
            );
            jobs.spawn_worker();
            app.manage(jobs);
            app.manage(watch::start(app.handle().clone(), lib.clone()));
            app.manage(lib);
            app.manage(stats);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("book", move |ctx, request, responder| {
            let lib = ctx.app_handle().state::<Arc<Library>>().inner().clone();
            let stats = protocol_stats.clone();
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let rescan = || app.state::<watch::Scanner>().rescan();
                responder.respond(protocol::handle(&lib, &stats, &request, &rescan));
            });
        })
        .invoke_handler(tauri::generate_handler![
            list_books,
            import_books,
            list_import_jobs,
            cancel_import,
            get_locations,
            locate_book,
            remove_book,
            remove_managed_copy,
            set_reading_state,
            list_collections,
            create_collection,
            rename_collection,
            delete_collection,
            set_collection_membership,
            get_ui_settings,
            set_ui_settings,
            claim_cover_job,
            submit_cover,
            open_book,
            save_progress,
            claim_extraction_job,
            submit_metadata,
            submit_text,
            fail_extraction,
            retry_extraction,
            reindex_book,
            search_book,
            search_library,
            list_annotations,
            create_annotation,
            update_annotation,
            delete_annotation,
            set_anchor_states,
            transport_stats,
            count_text_matches,
            get_prefs,
            set_default_prefs,
            set_book_pref,
            reset_book_prefs,
            selftest_config,
            selftest_report,
            selftest_log,
            watch::list_watched_folders,
            watch::add_watched_folder,
            watch::remove_watched_folder,
            watch::set_folder_collection,
            watch::rescan_watched_folders,
            watch::list_exclusions,
            watch::restore_exclusion,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = event {
                open_with(app, urls);
            }
        });
}

/// Finder's Open With. Files opened at launch can arrive before the frontend
/// listens; the jobs are persisted, so it lists them when it starts.
#[cfg(target_os = "macos")]
fn open_with(app: &AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls
        .iter()
        .filter_map(|u| u.to_file_path().ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if let Some(jobs) = app.try_state::<Arc<Jobs>>() {
        if let Err(e) = jobs.enqueue(paths) {
            eprintln!("open with: {e}");
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}
