mod db;
mod library;
mod model;
mod protocol;

use library::Library;
use model::*;
use protocol::TransportStats;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let stats = Arc::new(TransportStats::default());
    let protocol_stats = stats.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
