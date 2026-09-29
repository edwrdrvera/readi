mod db;
mod library;
mod model;

use library::Library;
use model::*;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

type Lib<'a> = State<'a, Arc<Library>>;

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ImportOutcome {
    Imported { path: String, result: ImportResult },
    Failed { path: String, reason: String },
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_books,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
