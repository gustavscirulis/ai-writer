use crate::error::AppError;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const PASTED_DIR: &str = "chat-attachments";
const PASTED_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

fn display_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

/// Canonical regular files, so a Read grant matches what the CLI resolves.
pub fn resolve_attachments(paths: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut resolved = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(raw);
        let canonical = path
            .canonicalize()
            .map_err(|_| format!("Couldn't find {}.", display_name(&path)))?;
        if !canonical.is_file() {
            return Err(format!(
                "{} is a folder. Attach files instead.",
                display_name(&path)
            ));
        }
        if !resolved.contains(&canonical) {
            resolved.push(canonical);
        }
    }
    Ok(resolved)
}

/// Errors are plain messages because the composer shows them as written.
#[tauri::command]
pub async fn resolve_chat_files(paths: Vec<String>) -> Result<Vec<String>, String> {
    let resolved = tauri::async_runtime::spawn_blocking(move || resolve_attachments(&paths))
        .await
        .map_err(|e| e.to_string())??;
    Ok(resolved
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
pub async fn save_chat_image(
    app: AppHandle,
    image_data: Vec<u8>,
    format: String,
) -> Result<String, AppError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Io(e.to_string()))?
        .join(PASTED_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        save_chat_image_impl(&dir, &image_data, &format, SystemTime::now())
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
}

pub fn save_chat_image_impl(
    dir: &Path,
    image_data: &[u8],
    format: &str,
    now: SystemTime,
) -> Result<String, AppError> {
    fs::create_dir_all(dir)?;
    prune(dir, now);
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    let (year, month, day, hour, min, sec) = super::images::epoch_to_datetime(secs);
    let ext = match format {
        "jpeg" | "jpg" => "jpg",
        "webp" => "webp",
        "gif" => "gif",
        _ => "png",
    };
    let name = format!(
        "Pasted image {year:04}{month:02}{day:02}-{hour:02}{min:02}{sec:02}-{}.{ext}",
        &uuid::Uuid::new_v4().to_string()[..4]
    );
    let path = dir.join(name);
    fs::write(&path, image_data)?;
    let canonical = path.canonicalize()?;
    Ok(canonical.to_string_lossy().into_owned())
}

/// Older pastes are dropped so the cache can't grow forever; their chats keep the transcript.
fn prune(dir: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let expired = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > PASTED_MAX_AGE);
        if expired {
            if let Err(error) = fs::remove_file(entry.path()) {
                eprintln!("[chat] Could not prune {:?}: {error}", entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_files_and_rejects_folders_and_missing_paths() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("report.pdf");
        fs::write(&file, b"%PDF").unwrap();
        let raw = file.to_string_lossy().into_owned();
        let resolved = resolve_attachments(&[raw.clone(), raw]).unwrap();
        assert_eq!(resolved, vec![file.canonicalize().unwrap()]);

        let folder = dir.path().to_string_lossy().into_owned();
        let error = resolve_attachments(&[folder]).unwrap_err();
        assert!(
            error.ends_with("is a folder. Attach files instead."),
            "{error}"
        );

        let missing = dir.path().join("gone.png").to_string_lossy().into_owned();
        assert_eq!(
            resolve_attachments(&[missing]).unwrap_err(),
            "Couldn't find gone.png."
        );
    }

    #[test]
    fn saves_pasted_images_and_prunes_old_ones() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::now();
        let old = save_chat_image_impl(dir.path(), b"old", "png", now).unwrap();
        let later = now + PASTED_MAX_AGE + Duration::from_secs(60);
        let saved = save_chat_image_impl(dir.path(), b"new", "jpeg", later).unwrap();
        assert!(saved.ends_with(".jpg"));
        assert!(Path::new(&saved)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("Pasted image "));
        assert_eq!(fs::read(&saved).unwrap(), b"new");
        assert!(!Path::new(&old).exists());
    }
}
