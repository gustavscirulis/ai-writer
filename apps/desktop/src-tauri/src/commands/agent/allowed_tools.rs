//! Tools the user always allows in Co-writer, saved in global settings. Native
//! code is the only writer, and every access reloads the file under the global
//! settings lock, so windows can't overwrite each other's changes.

use super::claude::always_allow_set;
use crate::{
    commands::settings::with_global_settings_mut, config::ConfigValue, config::Settings,
    error::AppError, state::AppState,
};
use std::collections::HashSet;
use tauri::{AppHandle, Manager, WebviewWindow};

const KEY: &str = "co-writer.allowed-tools";

fn listed(settings: &Settings) -> Vec<String> {
    settings
        .get_global_or_default(KEY)
        .and_then(ConfigValue::as_list)
        .map(<[String]>::to_vec)
        .unwrap_or_default()
}

fn reload(settings: &mut Settings) -> Result<Vec<String>, AppError> {
    settings.reload_global()?;
    Ok(listed(settings))
}

pub(super) fn load(settings: &mut Settings) -> Result<HashSet<String>, AppError> {
    always_allow_set(reload(settings)?)
        .map_err(|e| AppError::Io(format!("{e}. Remove it in Settings → Co-writer.")))
}

pub(super) fn allow(settings: &mut Settings, tool: &str) -> Result<(), AppError> {
    let mut tools = reload(settings)?;
    if tools.iter().any(|entry| entry == tool) {
        return Ok(());
    }
    tools.push(tool.into());
    Ok(settings.set_global(KEY, ConfigValue::List(tools))?)
}

fn revoke(settings: &mut Settings, tool: &str) -> Result<Vec<String>, AppError> {
    let mut tools = reload(settings)?;
    tools.retain(|entry| entry != tool);
    if tools.is_empty() {
        settings.reset_global(KEY)
    } else {
        settings.set_global(KEY, ConfigValue::List(tools.clone()))
    }?;
    Ok(tools)
}

pub(super) fn with_settings<T>(
    app: &AppHandle,
    label: &str,
    f: impl FnOnce(&mut Settings) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let state = app.state::<AppState>();
    with_global_settings_mut(state.inner(), &state.get_or_create(label), f)
}

/// Lists every saved entry, including any Writer would reject, so they can be revoked.
#[tauri::command]
pub fn co_writer_allowed_tools(webview: WebviewWindow) -> Result<Vec<String>, AppError> {
    with_settings(webview.app_handle(), webview.label(), reload)
}

/// Takes effect from the next turn; a running turn keeps the tools it started with.
#[tauri::command]
pub fn co_writer_revoke_tool(
    webview: WebviewWindow,
    tool: String,
) -> Result<Vec<String>, AppError> {
    with_settings(webview.app_handle(), webview.label(), |settings| {
        revoke(settings, &tool)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_tools_persist_dedupe_and_revoke_across_windows() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = Settings::new(dir.path().into()).unwrap();
        let mut b = Settings::new(dir.path().into()).unwrap();

        allow(&mut a, "Read").unwrap();
        allow(&mut b, "mcp__notes__search").unwrap();
        allow(&mut a, "Read").unwrap();
        assert_eq!(
            load(&mut b).unwrap(),
            HashSet::from(["Read".into(), "mcp__notes__search".into()])
        );

        assert_eq!(revoke(&mut a, "Read").unwrap(), vec!["mcp__notes__search"]);
        assert_eq!(
            revoke(&mut b, "mcp__notes__search").unwrap(),
            Vec::<String>::new()
        );
        let raw = std::fs::read_to_string(a.global_path()).unwrap();
        assert!(!raw.contains(KEY), "{raw}");
        assert!(load(&mut a).unwrap().is_empty());
    }

    #[test]
    fn an_invalid_saved_tool_fails_explicitly_but_stays_listed() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = Settings::new(dir.path().into()).unwrap();
        std::fs::write(settings.global_path(), format!("{KEY} = Bash\n")).unwrap();

        let error = load(&mut settings).unwrap_err().to_string();
        assert!(
            error.contains("Bash") && error.contains("Settings"),
            "{error}"
        );
        assert_eq!(reload(&mut settings).unwrap(), vec!["Bash"]);
    }
}
