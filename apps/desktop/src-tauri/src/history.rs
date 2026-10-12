//! Per-note version history stored as plain markdown files inside the vault:
//! `{root}/.writer/history/{relative note path}/{created_ms}-{source}.md`.
//! One file per version keeps synced vaults (iCloud, Dropbox) conflict-free,
//! and the file's mtime is the version's last-updated time.

use parking_lot::Mutex;
use serde::Serialize;
use std::fs::{self, File};
use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const HISTORY_DIR: [&str; 2] = [".writer", "history"];
const USER_IDLE_MS: u64 = 5 * 60 * 1000;
const USER_SPAN_MS: u64 = 60 * 60 * 1000;
const HOUR_MS: u64 = 60 * 60 * 1000;
const DAY_MS: u64 = 24 * HOUR_MS;

/// Serializes read-modify-write cycles so concurrent saves and captures of the
/// same note never interleave between "read latest" and "write version".
static RECORD_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    User,
    Agent,
    Restore,
    External,
}

const ALL_SOURCES: [Source; 4] = [
    Source::User,
    Source::Agent,
    Source::Restore,
    Source::External,
];

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::User => "user",
            Source::Agent => "agent",
            Source::Restore => "restore",
            Source::External => "external",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Source::User),
            "agent" => Some(Source::Agent),
            "restore" => Some(Source::Restore),
            "external" => Some(Source::External),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMeta {
    pub id: String,
    pub created_at: u64,
    pub updated_at: u64,
    pub source: Source,
}

pub fn history_root(root: &Path) -> PathBuf {
    HISTORY_DIR
        .iter()
        .fold(root.to_path_buf(), |p, c| p.join(c))
}

fn note_dir(root: &Path, rel: &Path) -> PathBuf {
    history_root(root).join(rel)
}

/// The note's path relative to the workspace root, or `None` when the path
/// is outside the root, hidden, or not a markdown file.
pub fn relative_note(root: &Path, path: &Path) -> Option<PathBuf> {
    let canonical = fs::canonicalize(path).ok().or_else(|| {
        let parent = fs::canonicalize(path.parent()?).ok()?;
        Some(parent.join(path.file_name()?))
    })?;
    let rel = canonical.strip_prefix(root).ok()?;
    let is_markdown = rel
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    let visible = rel.components().all(|c| match c {
        Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
        _ => false,
    });
    (is_markdown && visible).then(|| rel.to_path_buf())
}

/// Relative path of any entry (file or folder) under the root, for moves.
pub fn relative_entry(root: &Path, path: &Path) -> Option<PathBuf> {
    let rel = path.strip_prefix(root).ok()?;
    let visible = rel.components().all(|c| match c {
        Component::Normal(name) => !name.to_string_lossy().starts_with('.'),
        _ => false,
    });
    (visible && rel.components().next().is_some()).then(|| rel.to_path_buf())
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn parse_id(id: &str) -> Option<(u64, Source)> {
    let (created, source) = id.split_once('-')?;
    Some((created.parse().ok()?, Source::parse(source)?))
}

fn version_meta(path: &Path) -> Option<VersionMeta> {
    if path.extension()? != "md" {
        return None;
    }
    let id = path.file_stem()?.to_str()?.to_string();
    let (created_at, source) = parse_id(&id)?;
    let updated_at = fs::metadata(path)
        .and_then(|m| m.modified())
        .map(millis)
        .unwrap_or(created_at);
    Some(VersionMeta {
        id,
        created_at,
        updated_at: updated_at.max(created_at),
        source,
    })
}

fn list_dir(dir: &Path) -> io::Result<Vec<VersionMeta>> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut versions: Vec<VersionMeta> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().ok()?.is_file() {
                return None;
            }
            version_meta(&entry.path())
        })
        .collect();
    versions.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    Ok(versions)
}

/// Versions of a note, newest first.
pub fn list(root: &Path, rel: &Path) -> io::Result<Vec<VersionMeta>> {
    list_dir(&note_dir(root, rel))
}

pub fn read(root: &Path, rel: &Path, id: &str) -> io::Result<String> {
    if parse_id(id).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Invalid version id: {id}"),
        ));
    }
    fs::read_to_string(note_dir(root, rel).join(format!("{id}.md")))
}

fn write_version(path: &Path, content: &str, now: SystemTime) -> io::Result<()> {
    let dir = path.parent().ok_or_else(|| io::Error::other("No parent"))?;
    let temp = dir.join(format!(".~{}", uuid::Uuid::new_v4()));
    fs::write(&temp, content)?;
    File::options().write(true).open(&temp)?.set_modified(now)?;
    fs::rename(&temp, path)
}

/// Record `content` as a version. Consecutive user saves coalesce into one
/// version while editing stays active; agent writes coalesce while
/// `same_group` (the same Claude turn). Returns `true` when history changed.
pub fn record(
    root: &Path,
    rel: &Path,
    content: &str,
    source: Source,
    same_group: bool,
    now: SystemTime,
) -> io::Result<bool> {
    let _guard = RECORD_LOCK.lock();
    let dir = note_dir(root, rel);
    let latest = list_dir(&dir)?.into_iter().next();
    if let Some(latest) = &latest {
        if fs::read_to_string(dir.join(format!("{}.md", latest.id)))? == content {
            return Ok(false);
        }
    }
    let now_ms = millis(now);
    let coalesce = latest.filter(|latest| match (latest.source, source) {
        (Source::User, Source::User) => {
            now_ms.saturating_sub(latest.updated_at) < USER_IDLE_MS
                && now_ms.saturating_sub(latest.created_at) < USER_SPAN_MS
        }
        (Source::Agent, Source::Agent) => same_group,
        _ => false,
    });
    let id = match coalesce {
        Some(latest) => latest.id,
        None => {
            fs::create_dir_all(&dir)?;
            // Version ids double as a total order, so creation times stay unique.
            let mut created = now_ms;
            while ALL_SOURCES
                .iter()
                .any(|s| dir.join(format!("{created}-{}.md", s.as_str())).exists())
            {
                created += 1;
            }
            format!("{created}-{}", source.as_str())
        }
    };
    write_version(&dir.join(format!("{id}.md")), content, now)?;
    Ok(true)
}

/// Move a note's (or folder's) history alongside a rename. Merges into an
/// existing target so history left behind by an earlier note is kept.
pub fn move_history(root: &Path, old_rel: &Path, new_rel: &Path) -> io::Result<()> {
    let _guard = RECORD_LOCK.lock();
    let from = note_dir(root, old_rel);
    if !from.exists() {
        return Ok(());
    }
    merge_move(&from, &note_dir(root, new_rel))
}

fn merge_move(from: &Path, to: &Path) -> io::Result<()> {
    if !to.exists() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent)?;
        }
        return fs::rename(from, to);
    }
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            merge_move(&entry.path(), &target)?;
        } else if !target.exists() {
            fs::rename(entry.path(), target)?;
        }
    }
    fs::remove_dir_all(from)
}

/// Thin out old versions: everything from the last day, then the newest per
/// hour for a week, per day for 90 days, per week after that. Agent and
/// restore versions, and each note's newest version, are always kept.
pub fn prune(root: &Path, now: SystemTime) -> io::Result<usize> {
    let _guard = RECORD_LOCK.lock();
    prune_dir(&history_root(root), millis(now))
}

fn prune_dir(dir: &Path, now_ms: u64) -> io::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if entry.file_type()?.is_dir() {
            removed += prune_dir(&entry.path(), now_ms)?;
        }
    }
    let mut last_bucket = None;
    for (index, version) in list_dir(dir)?.into_iter().enumerate() {
        let age = now_ms.saturating_sub(version.created_at);
        if index == 0 || age < DAY_MS || matches!(version.source, Source::Agent | Source::Restore) {
            continue;
        }
        let bucket = if age < 7 * DAY_MS {
            (HOUR_MS, version.created_at / HOUR_MS)
        } else if age < 90 * DAY_MS {
            (DAY_MS, version.created_at / DAY_MS)
        } else {
            (7 * DAY_MS, version.created_at / (7 * DAY_MS))
        };
        if last_bucket == Some(bucket) {
            fs::remove_file(dir.join(format!("{}.md", version.id)))?;
            removed += 1;
        } else {
            last_bucket = Some(bucket);
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;

    fn at(ms: u64) -> SystemTime {
        UNIX_EPOCH + Duration::from_millis(ms)
    }

    const T0: u64 = 1_760_000_000_000;
    const MIN: u64 = 60 * 1000;

    fn workspace() -> (TempDir, PathBuf) {
        let dir = TempDir::new().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    fn rec(root: &Path, content: &str, source: Source, same: bool, ms: u64) -> bool {
        record(root, Path::new("note.md"), content, source, same, at(ms)).unwrap()
    }

    fn sources(root: &Path) -> Vec<Source> {
        list(root, Path::new("note.md"))
            .unwrap()
            .into_iter()
            .map(|v| v.source)
            .collect()
    }

    #[test]
    fn identical_content_is_not_recorded() {
        let (_d, root) = workspace();
        assert!(rec(&root, "a", Source::User, false, T0));
        assert!(!rec(&root, "a", Source::External, false, T0 + 10 * MIN));
        assert_eq!(sources(&root), vec![Source::User]);
    }

    #[test]
    fn user_saves_coalesce_while_active() {
        let (_d, root) = workspace();
        rec(&root, "a", Source::User, false, T0);
        rec(&root, "ab", Source::User, false, T0 + 4 * MIN);
        rec(&root, "abc", Source::User, false, T0 + 8 * MIN);
        let versions = list(&root, Path::new("note.md")).unwrap();
        assert_eq!(versions.len(), 1);
        assert_eq!(versions[0].updated_at, T0 + 8 * MIN);
        assert_eq!(
            read(&root, Path::new("note.md"), &versions[0].id).unwrap(),
            "abc"
        );
    }

    #[test]
    fn user_saves_split_after_idle_or_long_span() {
        let (_d, root) = workspace();
        rec(&root, "a", Source::User, false, T0);
        rec(&root, "ab", Source::User, false, T0 + 6 * MIN);
        assert_eq!(sources(&root).len(), 2);
        let mut t = T0 + 6 * MIN;
        for i in 0..20 {
            t += 4 * MIN;
            rec(&root, &format!("ab{i}"), Source::User, false, t);
        }
        assert_eq!(sources(&root).len(), 3);
    }

    #[test]
    fn agent_writes_coalesce_per_turn_and_seal_user_runs() {
        let (_d, root) = workspace();
        rec(&root, "a", Source::User, false, T0);
        rec(&root, "b", Source::Agent, false, T0 + MIN);
        rec(&root, "c", Source::Agent, true, T0 + 2 * MIN);
        rec(&root, "d", Source::Agent, false, T0 + 3 * MIN);
        rec(&root, "e", Source::User, false, T0 + 3 * MIN);
        assert_eq!(
            sources(&root),
            vec![Source::User, Source::Agent, Source::Agent, Source::User]
        );
    }

    #[test]
    fn restore_and_external_always_start_a_version() {
        let (_d, root) = workspace();
        rec(&root, "a", Source::User, false, T0);
        rec(&root, "b", Source::Restore, false, T0 + MIN);
        rec(&root, "c", Source::External, false, T0 + MIN);
        rec(&root, "d", Source::User, false, T0 + MIN);
        assert_eq!(
            sources(&root),
            vec![
                Source::User,
                Source::External,
                Source::Restore,
                Source::User
            ]
        );
    }

    #[test]
    fn prune_thins_old_user_versions_but_keeps_agent_restore_and_newest() {
        let (_d, root) = workspace();
        let old = T0 - 30 * DAY_MS;
        rec(&root, "1", Source::User, false, old);
        rec(&root, "2", Source::Agent, false, old + MIN);
        rec(&root, "3", Source::User, false, old + 2 * MIN);
        rec(&root, "4", Source::Restore, false, old + 3 * MIN);
        rec(&root, "5", Source::External, false, old + 4 * MIN);
        rec(&root, "6", Source::User, false, T0 - 2 * HOUR_MS);
        rec(&root, "7", Source::External, false, T0 - HOUR_MS);
        let removed = prune(&root, at(T0)).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(
            sources(&root),
            vec![
                Source::External,
                Source::User,
                Source::External,
                Source::Restore,
                Source::Agent
            ]
        );
    }

    #[test]
    fn move_history_follows_file_and_folder_renames() {
        let (_d, root) = workspace();
        record(
            &root,
            Path::new("a/note.md"),
            "x",
            Source::User,
            false,
            at(T0),
        )
        .unwrap();
        move_history(&root, Path::new("a/note.md"), Path::new("a/renamed.md")).unwrap();
        assert_eq!(list(&root, Path::new("a/renamed.md")).unwrap().len(), 1);
        move_history(&root, Path::new("a"), Path::new("b")).unwrap();
        assert_eq!(list(&root, Path::new("b/renamed.md")).unwrap().len(), 1);
        assert!(list(&root, Path::new("a/renamed.md")).unwrap().is_empty());
    }

    #[test]
    fn move_history_merges_into_existing_history() {
        let (_d, root) = workspace();
        record(&root, Path::new("a.md"), "a", Source::User, false, at(T0)).unwrap();
        record(
            &root,
            Path::new("b.md"),
            "b",
            Source::User,
            false,
            at(T0 + 1),
        )
        .unwrap();
        move_history(&root, Path::new("a.md"), Path::new("b.md")).unwrap();
        assert_eq!(list(&root, Path::new("b.md")).unwrap().len(), 2);
    }

    #[test]
    fn relative_note_skips_outside_hidden_and_non_markdown_paths() {
        let (_d, root) = workspace();
        fs::create_dir_all(root.join(".writer")).unwrap();
        fs::write(root.join("n.md"), "").unwrap();
        fs::write(root.join("n.txt"), "").unwrap();
        fs::write(root.join(".writer/x.md"), "").unwrap();
        assert_eq!(
            relative_note(&root, &root.join("n.md")),
            Some("n.md".into())
        );
        assert_eq!(
            relative_note(&root, &root.join("new.md")),
            Some("new.md".into())
        );
        assert_eq!(relative_note(&root, &root.join("n.txt")), None);
        assert_eq!(relative_note(&root, &root.join(".writer/x.md")), None);
        let outside = TempDir::new().unwrap();
        assert_eq!(relative_note(&root, &outside.path().join("o.md")), None);
    }

    #[test]
    fn read_rejects_ids_that_escape_the_note_directory() {
        let (_d, root) = workspace();
        assert!(read(&root, Path::new("note.md"), "../../secret").is_err());
    }
}
