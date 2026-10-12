use super::claude::{kill_group, resolve_claude_env};
use crate::error::AppError;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

const STATUS_ID: &str = "writer-mcp-status";
// MCP and plugin connections can take up to 30s, as in a Co-writer turn.
const STATUS_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Serialize)]
pub struct McpServer {
    name: String,
    status: String,
}

fn status_command(binary: PathBuf, path: String, root: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(root)
        .env("PATH", path)
        .env_remove("CLAUDECODE")
        .args([
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--tools",
            "",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

fn parse_status(value: &Value) -> Option<Result<Vec<McpServer>, String>> {
    let response = &value["response"];
    if value["type"] != "control_response" || response["request_id"] != STATUS_ID {
        return None;
    }
    if response["subtype"] != "success" {
        return Some(Err(response["error"]
            .as_str()
            .unwrap_or("Claude Code could not list its MCP servers")
            .to_string()));
    }
    let Some(servers) = response["response"]["mcpServers"].as_array() else {
        return Some(Err("Claude Code sent an unreadable MCP server list".into()));
    };
    Some(Ok(servers
        .iter()
        .filter_map(|server| {
            Some(McpServer {
                name: server["name"].as_str()?.to_string(),
                status: server["status"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect()))
}

async fn read_status(child: &mut Child) -> Result<Vec<McpServer>, String> {
    let mut stdin = child.stdin.take().ok_or("Claude Code has no input")?;
    let stdout = child.stdout.take().ok_or("Claude Code has no output")?;
    let requests = [
        json!({"type": "control_request", "request_id": "writer-initialize", "request": {"subtype": "initialize"}}),
        json!({"type": "control_request", "request_id": STATUS_ID, "request": {"subtype": "mcp_status"}}),
    ];
    for request in requests {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        if let Some(result) = serde_json::from_str(&line)
            .ok()
            .and_then(|v| parse_status(&v))
        {
            return result;
        }
    }
    Err("Claude Code exited before listing its MCP servers".into())
}

/// Lists Claude Code's MCP servers through the control protocol, before any
/// prompt is sent, so it costs no model call.
#[tauri::command]
pub async fn claude_mcp_servers(root: String) -> Result<Vec<McpServer>, AppError> {
    let (binary, path) = resolve_claude_env().await?;
    let mut child = status_command(binary, path, Path::new(&root)).spawn()?;
    let result = tokio::time::timeout(STATUS_TIMEOUT, read_status(&mut child)).await;
    kill_group(&mut child);
    let _ = child.wait().await;
    result
        .map_err(|_| AppError::Io("Timed out listing Claude Code's MCP servers".into()))?
        .map_err(AppError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_loads_configured_mcps_without_tools() {
        let command = status_command("/claude".into(), "/bin".into(), Path::new("/vault"));
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert!(!args.contains(&"--strict-mcp-config"));
        assert!(!args.contains(&"--model"));
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(Path::new("/vault"))
        );
    }

    #[test]
    fn parses_mcp_status_response() {
        let line = json!({"type": "control_response", "response": {"request_id": STATUS_ID, "subtype": "success", "response": {"mcpServers": [
            {"name": "plugin:base:glean", "status": "connected", "tools": [{"name": "search"}]},
            {"name": "claude.ai Gmail", "status": "needs-auth"},
            {"status": "connected"}
        ]}}});
        assert_eq!(
            parse_status(&line),
            Some(Ok(vec![
                McpServer {
                    name: "plugin:base:glean".into(),
                    status: "connected".into(),
                },
                McpServer {
                    name: "claude.ai Gmail".into(),
                    status: "needs-auth".into(),
                },
            ]))
        );
    }

    #[test]
    fn ignores_other_lines_and_reports_status_errors() {
        let other = json!({"type": "control_response", "response": {"request_id": "writer-initialize", "subtype": "success"}});
        assert_eq!(parse_status(&other), None);
        assert_eq!(parse_status(&json!({"type": "system"})), None);
        let failed = json!({"type": "control_response", "response": {"request_id": STATUS_ID, "subtype": "error", "error": "nope"}});
        assert_eq!(parse_status(&failed), Some(Err("nope".into())));
        let malformed = json!({"type": "control_response", "response": {"request_id": STATUS_ID, "subtype": "success", "response": {}}});
        assert!(matches!(parse_status(&malformed), Some(Err(_))));
    }

    #[tokio::test]
    #[ignore = "requires terminal Claude Code sign-in and network"]
    async fn real_cli_lists_servers() {
        let root = tempfile::tempdir().unwrap();
        let servers = claude_mcp_servers(root.path().to_string_lossy().to_string())
            .await
            .unwrap();
        eprintln!("{} MCP servers", servers.len());
        assert!(servers.iter().all(|server| !server.name.is_empty()));
    }
}
