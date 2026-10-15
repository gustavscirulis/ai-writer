use crate::error::AppError;
use std::{path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};
use tokio::process::Command;

/// An agent CLI found through the user's login shell, with the PATH it runs under.
pub struct Cli {
    /// Binary name looked up with `command -v`.
    pub binary: &'static str,
    /// Product name for errors, such as "Claude Code".
    pub name: &'static str,
    pub min_version: &'static [u32],
    /// How to update, ending a sentence: "Update Claude Code in your terminal."
    pub update_hint: &'static str,
    pub cache: &'static OnceLock<(PathBuf, String)>,
}

fn version_numbers(text: &str) -> Vec<u32> {
    // `claude --version` prints "2.1.296 (Claude Code)", `codex --version` "codex-cli 0.162.1".
    text.split_whitespace()
        .find(|word| word.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or("")
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect()
}

/// Successful lookups are cached; a failed one is retried on the next turn.
pub async fn resolve(cli: &Cli) -> Result<(PathBuf, String), AppError> {
    if let Some(env) = cli.cache.get() {
        return Ok(env.clone());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let output = tokio::time::timeout(
        Duration::from_secs(8),
        Command::new(shell)
            .args([
                "-l",
                "-i",
                "-c",
                &format!(
                    "printf '\\n__WRITER_CLI__\\n%s\\n%s\\n' \"$(command -v {})\" \"$PATH\"",
                    cli.binary
                ),
            ])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        AppError::Io(format!(
            "Timed out resolving {} from your login shell",
            cli.name
        ))
    })??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let framed = stdout.split_once("\n__WRITER_CLI__\n").map(|(_, s)| s);
    let mut lines = framed.unwrap_or("").lines();
    let binary = PathBuf::from(lines.next().unwrap_or(""));
    let path = lines.next().unwrap_or("").to_string();
    if !output.status.success() || !binary.is_absolute() || !binary.is_file() || path.is_empty() {
        return Err(AppError::NotFound(format!(
            "{name} CLI not found. Install {name} and sign in in your terminal, then try again.",
            name = cli.name
        )));
    }
    let env = (binary, path);
    let version = tokio::time::timeout(
        Duration::from_secs(8),
        Command::new(&env.0)
            .arg("--version")
            .env("PATH", &env.1)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| AppError::Io(format!("Timed out checking the {} version", cli.name)))??;
    let text = String::from_utf8_lossy(&version.stdout);
    if !version.status.success() || version_numbers(&text).as_slice() < cli.min_version {
        let reported = if version.status.success() {
            text.trim().to_string()
        } else {
            String::from_utf8_lossy(&version.stderr).trim().to_string()
        };
        eprintln!(
            "{}: {} --version failed the check: {reported:?} ({})",
            cli.binary,
            env.0.display(),
            version.status
        );
        let minimum = cli
            .min_version
            .iter()
            .map(u32::to_string)
            .collect::<Vec<_>>()
            .join(".");
        return Err(AppError::Io(format!(
            "Co-writer requires {} {minimum} or newer, but {} reports “{reported}”. {}",
            cli.name,
            env.0.display(),
            cli.update_hint
        )));
    }
    let _ = cli.cache.set(env.clone());
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::version_numbers;

    #[test]
    fn reads_versions_from_either_cli() {
        assert_eq!(version_numbers("2.1.296 (Claude Code)\n"), [2, 1, 296]);
        assert_eq!(version_numbers("codex-cli 0.162.1\n"), [0, 162, 1]);
        assert!(version_numbers("").is_empty());
    }
}
