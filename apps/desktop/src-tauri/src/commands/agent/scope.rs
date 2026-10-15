//! Rules every agent shares: which notes an edit may touch, which chat holds a
//! note, and what answers fit an agent's questions.
use super::NoteClaims;
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::{Path, PathBuf},
    time::Duration,
};

pub const NOTE_CLAIMED: &str = "Another chat is editing this note.";
pub const KEEP_PLANNING: &str = "The user wants to keep planning. Revise the plan before editing.";
pub const DECLINED_QUESTIONS: &str = "The user chose not to answer.";
pub const FEEDBACK_LIMIT: usize = 4000;
pub const ANSWER_LIMIT: usize = 2000;
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(3);

/// Saves an always-allowed tool before its request is answered.
pub type Remember = std::sync::Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;

/// Resolves an edit target to its canonical path, through the nearest existing
/// ancestor when the file does not exist yet.
pub fn resolve_target(path: &Path) -> std::io::Result<(PathBuf, bool)> {
    let mut missing = Vec::new();
    let mut ancestor = path;
    loop {
        match ancestor.canonicalize() {
            Ok(mut resolved) => {
                resolved.extend(missing.iter().rev());
                return Ok((resolved, missing.is_empty()));
            }
            // A dangling link would let Write create a file wherever it points.
            Err(error)
                if error.kind() != std::io::ErrorKind::NotFound
                    || ancestor.symlink_metadata().is_ok() =>
            {
                return Err(error)
            }
            Err(_) => {}
        }
        let (Some(name), Some(parent)) = (ancestor.file_name(), ancestor.parent()) else {
            return Err(std::io::ErrorKind::NotFound.into());
        };
        missing.push(name);
        ancestor = parent;
    }
}

pub fn workspace_denial(root: &Path, target: &Path) -> Option<&'static str> {
    let Ok(relative) = target.strip_prefix(root) else {
        return Some("Co-writer can edit only notes inside this workspace.");
    };
    if relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Some("Co-writer can't edit files in hidden folders.");
    }
    if !crate::open_target::is_markdown(target) {
        return Some("Co-writer can create and edit only Markdown notes.");
    }
    None
}

pub enum Target {
    Allowed(PathBuf),
    /// Claude Code's own plan file, the only file it may write while planning.
    PlanFile,
    NeedsApproval {
        path: PathBuf,
        exists: bool,
    },
    Denied(String),
}

/// Canonical path and existence of an absolute edit path; the inner error is a denial.
pub async fn resolve(path: PathBuf) -> Result<Result<(PathBuf, bool), String>, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Ok(Err("Edit path must be absolute, without \"..\".".into()));
    }
    let resolved = tokio::time::timeout(
        RESOLVE_TIMEOUT,
        tauri::async_runtime::spawn_blocking(move || resolve_target(&path)),
    )
    .await
    .map_err(|_| "Timed out checking note edit scope")?
    .map_err(|e| e.to_string())?;
    Ok(resolved.map_err(|error| error.to_string()))
}

/// The chat's note and notes it approved are editable; other workspace notes need
/// approval. `missing` denies a target that doesn't exist yet, with its reason.
pub fn classify(
    note: Option<&Path>,
    approved: &HashSet<PathBuf>,
    root: &Path,
    canonical: PathBuf,
    exists: bool,
    missing: Option<&str>,
) -> Target {
    if note == Some(canonical.as_path()) || approved.contains(&canonical) {
        return Target::Allowed(canonical);
    }
    if let Some(reason) = workspace_denial(root, &canonical) {
        return Target::Denied(reason.into());
    }
    if let (false, Some(reason)) = (exists, missing) {
        return Target::Denied(reason.into());
    }
    Target::NeedsApproval {
        path: canonical,
        exists,
    }
}

/// Claims a note for `owner`; false when a different chat holds it.
pub fn claim(claims: &NoteClaims, owner: &str, path: &Path) -> bool {
    let mut claims = claims.lock();
    if claims.get(path).is_some_and(|holder| holder != owner) {
        return false;
    }
    claims.insert(path.to_path_buf(), owner.into());
    true
}

pub fn release(claims: &NoteClaims, owner: &str) {
    claims.lock().retain(|_, holder| holder != owner);
}

pub fn question_texts(input: &Value) -> Result<BTreeSet<&str>, String> {
    input["questions"]
        .as_array()
        .filter(|questions| !questions.is_empty())
        .ok_or("The agent asked no questions")?
        .iter()
        .map(|question| {
            question["question"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .ok_or_else(|| "The agent asked a question without text".to_string())
        })
        .collect()
}

/// Answers must cover exactly the questions asked, so the UI can't add or rename any.
pub fn checked_answers(input: &Value, answers: &BTreeMap<String, String>) -> Result<(), String> {
    let questions = question_texts(input)?;
    if !answers
        .keys()
        .map(String::as_str)
        .eq(questions.iter().copied())
    {
        return Err("Answers don't match the agent's questions".into());
    }
    if answers
        .values()
        .any(|answer| answer.trim().is_empty() || answer.chars().count() > ANSWER_LIMIT)
    {
        return Err(format!(
            "Each answer needs between 1 and {ANSWER_LIMIT} characters"
        ));
    }
    Ok(())
}

/// What the agent hears when the user keeps planning, with their trimmed feedback.
pub fn keep_planning(feedback: Option<&str>) -> Result<String, String> {
    let feedback = feedback.map(str::trim).filter(|text| !text.is_empty());
    if feedback.is_some_and(|text| text.chars().count() > FEEDBACK_LIMIT) {
        return Err(format!(
            "Feedback can be at most {FEEDBACK_LIMIT} characters"
        ));
    }
    Ok(match feedback {
        Some(feedback) => format!("{KEEP_PLANNING} Their feedback: {feedback}"),
        None => KEEP_PLANNING.into(),
    })
}
