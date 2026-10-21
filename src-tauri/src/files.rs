//! Reading the Outbox folder and the files being uploaded.

use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::ipc::Response;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    path: String,
    name: String,
    size_bytes: u64,
    modified_at: u64,
}

/// Plain files directly inside `path`, skipping folders and hidden files.
#[tauri::command]
pub async fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        for entry in fs::read_dir(&path).map_err(|e| describe(&path, e))? {
            let Ok(entry) = entry else { continue };
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            out.push(DirEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name,
                size_bytes: meta.len(),
                modified_at: modified_ms(&meta),
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Size and modified time of one file (for files added by hand).
#[tauri::command]
pub async fn file_info(path: String) -> Result<DirEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&path).map_err(|e| describe(&path, e))?;
        let name = Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        Ok(DirEntry { size_bytes: meta.len(), modified_at: modified_ms(&meta), name, path })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The whole file, sent to the web view as raw bytes (no JSON encoding).
#[tauri::command]
pub async fn read_file(path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || fs::read(&path).map(Response::new).map_err(|e| describe(&path, e)))
        .await
        .map_err(|e| e.to_string())?
}

/// Part of a file, so big videos upload without being loaded whole.
#[tauri::command]
pub async fn read_chunk(path: String, offset: u64, length: u64) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut file = File::open(&path).map_err(|e| describe(&path, e))?;
        file.seek(SeekFrom::Start(offset)).map_err(|e| describe(&path, e))?;
        let mut buf = Vec::with_capacity(length as usize);
        file.take(length).read_to_end(&mut buf).map_err(|e| describe(&path, e))?;
        Ok(Response::new(buf))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn describe(path: &str, err: std::io::Error) -> String {
    let name = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string());
    match err.kind() {
        std::io::ErrorKind::NotFound => format!("\"{name}\" isn't there anymore. Was it moved or deleted?"),
        std::io::ErrorKind::PermissionDenied => format!("Conduit isn't allowed to read \"{name}\"."),
        _ => format!("Couldn't read \"{name}\": {err}"),
    }
}
