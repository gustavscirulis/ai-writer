//! One-time import of upstream Writer's app data on the first launch of
//! Co-writer. See `SPECs/rename-to-co-writer.md`.

use std::fs;
use std::io;
use std::path::Path;

const LEGACY_IDENTIFIER: &str = "com.writer-computer";
const SKIPPED_FILES: &[&str] = &["telemetry.json", "updater-dismissed-version.json"];

/// Runs before Tauri starts so plugins that read their state at startup
/// (window state, store) see the imported files.
pub fn import(identifier: &str) {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let support = Path::new(&home).join("Library/Application Support");
        if let Err(err) = import_from(&support.join(LEGACY_IDENTIFIER), &support.join(identifier)) {
            eprintln!("could not import settings from Writer: {err}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = identifier;
}

/// Copies `legacy` to `target` unless `target` already exists. The copy goes
/// to a staging folder first so a failure never leaves a partial `target`.
fn import_from(legacy: &Path, target: &Path) -> io::Result<bool> {
    if target.exists() || !legacy.is_dir() {
        return Ok(false);
    }
    let mut staging_name = target.file_name().unwrap_or_default().to_os_string();
    staging_name.push(".importing");
    let staging = target.with_file_name(staging_name);
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let result = copy_dir(legacy, &staging, true).and_then(|()| fs::rename(&staging, target));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result.map(|()| true)
}

fn copy_dir(from: &Path, to: &Path, top_level: bool) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if top_level && SKIPPED_FILES.iter().any(|skipped| name == *skipped) {
            continue;
        }
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            copy_dir(&entry.path(), &to.join(&name), false)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn legacy_dir(root: &Path) -> std::path::PathBuf {
        let legacy = root.join(LEGACY_IDENTIFIER);
        fs::create_dir_all(legacy.join("nested")).unwrap();
        fs::write(legacy.join("config"), "theme = dark").unwrap();
        fs::write(legacy.join(".window-state.json"), "{}").unwrap();
        fs::write(legacy.join("nested/chats.json"), "[]").unwrap();
        fs::write(legacy.join("telemetry.json"), "{}").unwrap();
        fs::write(legacy.join("updater-dismissed-version.json"), "\"0.7.3\"").unwrap();
        legacy
    }

    #[test]
    fn copies_legacy_data_and_skips_stale_files() {
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_dir(root.path());
        let target = root.path().join("com.gustavscirulis.cowriter");

        assert!(import_from(&legacy, &target).unwrap());

        assert_eq!(
            fs::read_to_string(target.join("config")).unwrap(),
            "theme = dark"
        );
        assert!(target.join(".window-state.json").exists());
        assert!(target.join("nested/chats.json").exists());
        assert!(!target.join("telemetry.json").exists());
        assert!(!target.join("updater-dismissed-version.json").exists());
        assert!(legacy.join("config").exists());
        assert!(!root
            .path()
            .join("com.gustavscirulis.cowriter.importing")
            .exists());
    }

    #[test]
    fn leaves_an_existing_target_alone() {
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_dir(root.path());
        let target = root.path().join("com.gustavscirulis.cowriter");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("config"), "theme = light").unwrap();

        assert!(!import_from(&legacy, &target).unwrap());
        assert_eq!(
            fs::read_to_string(target.join("config")).unwrap(),
            "theme = light"
        );
    }

    #[test]
    fn does_nothing_without_legacy_data() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("com.gustavscirulis.cowriter");

        assert!(!import_from(&root.path().join(LEGACY_IDENTIFIER), &target).unwrap());
        assert!(!target.exists());
    }

    #[test]
    fn replaces_a_stale_staging_folder() {
        let root = tempfile::tempdir().unwrap();
        let legacy = legacy_dir(root.path());
        let target = root.path().join("com.gustavscirulis.cowriter");
        let staging = root.path().join("com.gustavscirulis.cowriter.importing");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("leftover"), "x").unwrap();

        assert!(import_from(&legacy, &target).unwrap());
        assert!(!target.join("leftover").exists());
        assert!(!staging.exists());
    }
}
