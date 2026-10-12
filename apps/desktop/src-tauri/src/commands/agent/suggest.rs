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
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
};

const STATUS_ID: &str = "writer-mcp-status";
// MCP and plugin connections can take up to 30s, as in a Co-writer turn.
const STATUS_TIMEOUT: Duration = Duration::from_secs(60);
const SUGGEST_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, PartialEq, Serialize)]
pub struct McpServer {
    name: String,
    status: String,
    tools: Vec<String>,
}

fn command(binary: PathBuf, path: String, root: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(root)
        .env("PATH", path)
        .env_remove("CLAUDECODE")
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

fn status_command(binary: PathBuf, path: String, root: &Path) -> Command {
    let mut command = command(
        binary,
        path,
        root,
        &[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--tools",
            "",
        ],
    );
    command.stderr(Stdio::null());
    command
}

fn suggest_command(binary: PathBuf, path: String, root: &Path, system_prompt: &str) -> Command {
    command(
        binary,
        path,
        root,
        &[
            "-p",
            "--model",
            "haiku",
            "--effort",
            "low",
            "--tools",
            "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--output-format",
            "json",
            "--system-prompt",
            system_prompt,
        ],
    )
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
                tools: server["tools"]
                    .as_array()
                    .map(|tools| {
                        tools
                            .iter()
                            .filter_map(|tool| tool["name"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
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

/// Lists Claude Code's MCP servers and tools through the control protocol,
/// before any prompt is sent, so it costs no model call.
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

fn parse_result(stdout: &str, stderr: &str) -> Result<String, String> {
    let Some(value) = stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .find(|value| value["type"] == "result")
    else {
        let detail = stderr.trim().lines().last().unwrap_or("no output");
        return Err(format!("Claude Code returned no result: {detail}"));
    };
    let text = value["result"].as_str().unwrap_or_default();
    if value["is_error"] == true {
        Err(if text.is_empty() {
            "Claude Code could not complete the request".into()
        } else {
            text.to_string()
        })
    } else {
        Ok(text.to_string())
    }
}

/// One short, tool-less turn on the fastest model. The prompt goes over stdin
/// so note text doesn't appear in the process list.
#[tauri::command]
pub async fn claude_suggest(
    root: String,
    system_prompt: String,
    prompt: String,
) -> Result<String, AppError> {
    let (binary, path) = resolve_claude_env().await?;
    let mut child = suggest_command(binary, path, Path::new(&root), &system_prompt).spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or(AppError::Io("Claude Code has no input".into()))?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or(AppError::Io("Claude Code has no output".into()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or(AppError::Io("Claude Code has no output".into()))?;
    let run = async {
        stdin.write_all(prompt.as_bytes()).await?;
        drop(stdin);
        let (mut out, mut err) = (String::new(), String::new());
        tokio::try_join!(
            stdout.read_to_string(&mut out),
            stderr.read_to_string(&mut err)
        )?;
        child.wait().await?;
        Ok::<_, std::io::Error>((out, err))
    };
    match tokio::time::timeout(SUGGEST_TIMEOUT, run).await {
        Ok(output) => {
            let (out, err) = output?;
            parse_result(&out, &err).map_err(AppError::Io)
        }
        Err(_) => {
            kill_group(&mut child);
            Err(AppError::Io("Timed out waiting for Claude Code".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(command: &Command) -> Vec<&str> {
        command
            .as_std()
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect()
    }

    #[test]
    fn status_loads_configured_mcps_without_tools() {
        let command = status_command("/claude".into(), "/bin".into(), Path::new("/vault"));
        let args = args(&command);
        assert!(!args.contains(&"--strict-mcp-config"));
        assert!(!args.contains(&"--model"));
        assert!(args.windows(2).any(|pair| pair == ["--tools", ""]));
        assert_eq!(
            command.as_std().get_current_dir(),
            Some(Path::new("/vault"))
        );
    }

    #[test]
    fn suggest_runs_haiku_without_tools_or_mcps() {
        let command = suggest_command("/claude".into(), "/bin".into(), Path::new("/vault"), "sys");
        let args = args(&command);
        for pair in [
            ["--model", "haiku"],
            ["--tools", ""],
            ["--output-format", "json"],
            ["--system-prompt", "sys"],
        ] {
            assert!(args.windows(2).any(|window| window == pair), "{pair:?}");
        }
        assert!(args.contains(&"--strict-mcp-config"));
        assert!(args.contains(&"--no-session-persistence"));
    }

    #[test]
    fn parses_mcp_status_response() {
        let line = json!({"type": "control_response", "response": {"request_id": STATUS_ID, "subtype": "success", "response": {"mcpServers": [
            {"name": "plugin:base:glean", "status": "connected", "tools": [{"name": "search"}, {"name": "chat"}]},
            {"name": "claude.ai Gmail", "status": "needs-auth"},
            {"status": "connected"}
        ]}}});
        assert_eq!(
            parse_status(&line),
            Some(Ok(vec![
                McpServer {
                    name: "plugin:base:glean".into(),
                    status: "connected".into(),
                    tools: vec!["search".into(), "chat".into()],
                },
                McpServer {
                    name: "claude.ai Gmail".into(),
                    status: "needs-auth".into(),
                    tools: vec![],
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

    #[test]
    fn parses_print_results() {
        let ok = json!({"type": "result", "is_error": false, "result": "[]"}).to_string();
        assert_eq!(parse_result(&ok, ""), Ok("[]".into()));
        let failed =
            json!({"type": "result", "is_error": true, "result": "Not logged in"}).to_string();
        assert_eq!(parse_result(&failed, ""), Err("Not logged in".into()));
        assert_eq!(
            parse_result("", "warning\ncrashed\n"),
            Err("Claude Code returned no result: crashed".into())
        );
    }

    #[tokio::test]
    #[ignore = "requires terminal Claude Code sign-in and network"]
    async fn real_cli_lists_servers_and_suggests() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().to_string_lossy().to_string();
        let servers = claude_mcp_servers(root.clone()).await.unwrap();
        eprintln!("{} MCP servers", servers.len());
        let reply = claude_suggest(
            root,
            "Reply with only a JSON array of two strings.".into(),
            "Name two colours.".into(),
        )
        .await
        .unwrap();
        let parsed: Vec<String> = serde_json::from_str(reply.trim()).unwrap();
        assert_eq!(parsed.len(), 2);
    }
}
