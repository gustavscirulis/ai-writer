use crate::commands::fs::{read_file_impl, write_file_impl};
use crate::error::AppError;
use crate::history::{self, Source, VersionMeta};
use crate::state::{AppState, WorkspaceState};
use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
struct HistoryChanged {
    path: String,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

fn note(state: &WorkspaceState, path: &str) -> Result<(PathBuf, PathBuf), AppError> {
    let (root, _) = state.workspace_snapshot().ok_or(AppError::NoWorkspace)?;
    let rel = history::relative_note(&root, Path::new(path))
        .ok_or_else(|| AppError::InvalidPath(path.to_string()))?;
    Ok((root, rel))
}

fn emit_changed(app: &tauri::AppHandle, root: &Path, rel: &Path) {
    let path = root.join(rel).to_string_lossy().into_owned();
    let _ = app.emit("history:changed", HistoryChanged { path });
}

/// Record a version and track the agent turn it belongs to. Only a recorded
/// change moves the group, so the no-op baseline captured before each Claude
/// edit doesn't split one turn into a version per edit.
fn record_grouped(
    groups: &mut HashMap<PathBuf, String>,
    root: &Path,
    rel: &Path,
    content: &str,
    source: Source,
    group: Option<String>,
    now: SystemTime,
) -> io::Result<bool> {
    let same_group = group.is_some() && groups.get(rel) == group.as_ref();
    let changed = history::record(root, rel, content, source, same_group, now)?;
    if changed {
        match group {
            Some(group) if source == Source::Agent => {
                groups.insert(rel.to_path_buf(), group);
            }
            _ => {
                groups.remove(rel);
            }
        }
    }
    Ok(changed)
}

fn record(
    app: &tauri::AppHandle,
    state: &WorkspaceState,
    root: &Path,
    rel: &Path,
    content: &str,
    source: Source,
    group: Option<String>,
) -> Result<(), AppError> {
    let mut groups = state.history_groups.lock();
    let changed = record_grouped(
        &mut groups,
        root,
        rel,
        content,
        source,
        group,
        SystemTime::now(),
    )?;
    drop(groups);
    if changed {
        emit_changed(app, root, rel);
    }
    Ok(())
}

/// Record a version for a note saved through `write_file`. History is a
/// secondary record, so a failure is logged and never fails the save.
pub fn record_user_save(
    app: &tauri::AppHandle,
    state: &WorkspaceState,
    path: &Path,
    content: &str,
) {
    let Some((root, _)) = state.workspace_snapshot() else {
        return;
    };
    let Some(rel) = history::relative_note(&root, path) else {
        return;
    };
    if let Err(e) = record(app, state, &root, &rel, content, Source::User, None) {
        eprintln!("[history] Failed to record {}: {e}", path.display());
    }
}

/// Move history alongside a rename of a note or folder inside the workspace.
pub fn move_entry_history(state: &WorkspaceState, from: &Path, to: &Path) {
    let Some((root, _)) = state.workspace_snapshot() else {
        return;
    };
    let (Some(old_rel), Some(new_rel)) = (
        history::relative_entry(&root, from),
        history::relative_entry(&root, to),
    ) else {
        return;
    };
    if let Err(e) = history::move_history(&root, &old_rel, &new_rel) {
        eprintln!("[history] Failed to move {}: {e}", from.display());
    }
}

pub fn prune_workspace_history(root: &Path) {
    if let Err(e) = history::prune(root, SystemTime::now()) {
        eprintln!("[history] Failed to prune {}: {e}", root.display());
    }
}

fn window_state(app: &tauri::AppHandle, webview: &tauri::Webview) -> Arc<WorkspaceState> {
    app.state::<AppState>().get_or_create(webview.label())
}

#[tauri::command]
pub async fn history_list(
    path: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<Vec<VersionMeta>, AppError> {
    let state = window_state(&app, &webview);
    blocking(move || {
        let (root, rel) = note(&state, &path)?;
        Ok(history::list(&root, &rel)?)
    })
    .await
}

#[tauri::command]
pub async fn history_read(
    path: String,
    id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, AppError> {
    let state = window_state(&app, &webview);
    blocking(move || {
        let (root, rel) = note(&state, &path)?;
        Ok(history::read(&root, &rel, &id)?)
    })
    .await
}

/// Record the note's current disk content. `group` coalesces agent writes
/// from the same Claude turn into one version. Paths without history (no
/// workspace, outside it, not markdown) are skipped rather than rejected.
#[tauri::command]
pub async fn history_capture(
    path: String,
    source: String,
    group: Option<String>,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let source = match Source::parse(&source) {
        Some(source @ (Source::Agent | Source::External)) => source,
        _ => return Err(AppError::InvalidPath(format!("Invalid source: {source}"))),
    };
    let state = window_state(&app, &webview);
    blocking(move || {
        let Ok((root, rel)) = note(&state, &path) else {
            return Ok(());
        };
        let content = match read_file_impl(&root.join(&rel).to_string_lossy()) {
            Ok(file) => file.content,
            Err(AppError::NotFound(_)) => return Ok(()),
            Err(e) => return Err(e),
        };
        record(&app, &state, &root, &rel, &content, source, group)
    })
    .await
}

/// Write a stored version back to the note and record it as a new version.
#[tauri::command]
pub async fn history_restore(
    path: String,
    id: String,
    webview: tauri::Webview,
    app: tauri::AppHandle,
) -> Result<String, AppError> {
    let state = window_state(&app, &webview);
    let label = webview.label().to_string();
    blocking(move || {
        let (root, rel) = note(&state, &path)?;
        let content = history::read(&root, &rel, &id)?;
        let target = root.join(&rel);
        crate::watcher::record_write(&state, &target);
        let result = write_file_impl(&target.to_string_lossy(), &content)?;
        state.update_index_modified_at(&target, result.modified_at);
        let _ = app.emit_to(label, "sidebar:metadata-changed", &result);
        record(&app, &state, &root, &rel, &content, Source::Restore, None)?;
        Ok(content)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, UNIX_EPOCH};
    use tempfile::TempDir;

    #[test]
    fn baselines_between_edits_keep_one_version_per_turn() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let rel = Path::new("note.md");
        let mut groups = HashMap::new();
        let mut minute = 0;
        let mut rec = |content: &str, source: Source, turn: Option<&str>| {
            minute += 1;
            let now = UNIX_EPOCH + Duration::from_secs(1_760_000_000 + minute * 60);
            let group = turn.map(str::to_string);
            record_grouped(&mut groups, &root, rel, content, source, group, now).unwrap()
        };
        // Each Claude edit is preceded by an `external` baseline, a no-op mid-turn.
        let steps = [
            ("a", Source::User, None),
            ("a", Source::External, None),
            ("b", Source::Agent, Some("t1")),
            ("b", Source::External, None),
            ("c", Source::Agent, Some("t1")),
            ("d", Source::User, None),
            ("e", Source::Agent, Some("t1")),
            ("e", Source::External, None),
            ("f", Source::Agent, Some("t2")),
            ("g", Source::External, None),
            ("h", Source::Agent, Some("t2")),
            ("h", Source::Agent, Some("t3")),
            ("i", Source::Agent, Some("t3")),
        ];
        for (content, source, turn) in steps {
            rec(content, source, turn);
        }
        let versions: Vec<(Source, String)> = history::list(&root, rel)
            .unwrap()
            .into_iter()
            .rev()
            .map(|v| (v.source, history::read(&root, rel, &v.id).unwrap()))
            .collect();
        let expected = [
            (Source::User, "a"),
            (Source::Agent, "c"),
            (Source::User, "d"),
            (Source::Agent, "e"),
            (Source::Agent, "f"),
            (Source::External, "g"),
            (Source::Agent, "h"),
            (Source::Agent, "i"),
        ];
        let expected: Vec<(Source, String)> = expected
            .into_iter()
            .map(|(s, c)| (s, c.to_string()))
            .collect();
        assert_eq!(versions, expected);
    }
}
