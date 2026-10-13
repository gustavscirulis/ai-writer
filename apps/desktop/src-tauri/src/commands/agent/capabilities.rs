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

const INITIALIZE_ID: &str = "writer-initialize";
const STATUS_ID: &str = "writer-mcp-status";
// MCP and plugin connections can take up to 30s, as in a Co-writer turn.
const STATUS_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Serialize)]
pub struct McpServer {
    name: String,
    status: String,
}

/// A skill or custom command the user can run by typing `/name`.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    name: String,
    description: String,
    argument_hint: String,
    aliases: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    mcp_servers: Vec<McpServer>,
    skills: Vec<Skill>,
}

#[derive(Debug, PartialEq)]
enum Reply {
    Skills(Vec<Skill>),
    Servers(Vec<McpServer>),
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

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

// Built-ins like /clear or /model manage a terminal session Writer doesn't have, and
// MCP prompts carry spaces in their names, so only user-runnable commands are listed.
fn parse_skills(body: &Value) -> Result<Vec<Skill>, String> {
    let commands = body["commands"]
        .as_array()
        .ok_or("Claude Code sent an unreadable skill list")?;
    Ok(commands
        .iter()
        .filter(|command| command["builtin"] != true)
        .filter_map(|command| {
            let name = command["name"].as_str()?;
            if name.is_empty() || name.contains(char::is_whitespace) {
                return None;
            }
            Some(Skill {
                name: name.to_string(),
                description: text(&command["description"]),
                argument_hint: text(&command["argumentHint"]),
                aliases: command["aliases"]
                    .as_array()
                    .map(|aliases| {
                        aliases
                            .iter()
                            .filter_map(|a| a.as_str())
                            .map(String::from)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

fn parse_servers(body: &Value) -> Result<Vec<McpServer>, String> {
    let servers = body["mcpServers"]
        .as_array()
        .ok_or("Claude Code sent an unreadable MCP server list")?;
    Ok(servers
        .iter()
        .filter_map(|server| {
            Some(McpServer {
                name: server["name"].as_str()?.to_string(),
                status: text(&server["status"]),
            })
        })
        .collect())
}

fn parse_reply(value: &Value) -> Option<Result<Reply, String>> {
    let response = &value["response"];
    if value["type"] != "control_response" {
        return None;
    }
    let id = response["request_id"].as_str()?;
    let failure = match id {
        INITIALIZE_ID => "Claude Code could not list its skills",
        STATUS_ID => "Claude Code could not list its MCP servers",
        _ => return None,
    };
    if response["subtype"] != "success" {
        return Some(Err(response["error"]
            .as_str()
            .unwrap_or(failure)
            .to_string()));
    }
    let body = &response["response"];
    Some(if id == INITIALIZE_ID {
        parse_skills(body).map(Reply::Skills)
    } else {
        parse_servers(body).map(Reply::Servers)
    })
}

async fn read_capabilities(child: &mut Child) -> Result<Capabilities, String> {
    let mut stdin = child.stdin.take().ok_or("Claude Code has no input")?;
    let stdout = child.stdout.take().ok_or("Claude Code has no output")?;
    let requests = [
        json!({"type": "control_request", "request_id": INITIALIZE_ID, "request": {"subtype": "initialize"}}),
        json!({"type": "control_request", "request_id": STATUS_ID, "request": {"subtype": "mcp_status"}}),
    ];
    for request in requests {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
    }
    let (mut skills, mut servers) = (None, None);
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await.map_err(|e| e.to_string())? {
        let Some(reply) = serde_json::from_str(&line)
            .ok()
            .and_then(|v| parse_reply(&v))
        else {
            continue;
        };
        match reply? {
            Reply::Skills(list) => skills = Some(list),
            Reply::Servers(list) => servers = Some(list),
        }
        if let (Some(skills), Some(mcp_servers)) = (&mut skills, &mut servers) {
            return Ok(Capabilities {
                mcp_servers: std::mem::take(mcp_servers),
                skills: std::mem::take(skills),
            });
        }
    }
    Err("Claude Code exited before listing its MCP servers and skills".into())
}

/// Lists Claude Code's MCP servers and skills through the control protocol,
/// before any prompt is sent, so it costs no model call.
#[tauri::command]
pub async fn claude_capabilities(root: String) -> Result<Capabilities, AppError> {
    let (binary, path) = resolve_claude_env().await?;
    let mut child = status_command(binary, path, Path::new(&root)).spawn()?;
    let result = tokio::time::timeout(STATUS_TIMEOUT, read_capabilities(&mut child)).await;
    kill_group(&mut child);
    let _ = child.wait().await;
    result
        .map_err(|_| AppError::Io("Timed out listing Claude Code's MCP servers and skills".into()))?
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
            parse_reply(&line),
            Some(Ok(Reply::Servers(vec![
                McpServer {
                    name: "plugin:base:glean".into(),
                    status: "connected".into(),
                },
                McpServer {
                    name: "claude.ai Gmail".into(),
                    status: "needs-auth".into(),
                },
            ])))
        );
    }

    #[test]
    fn lists_skills_from_initialize_without_builtins() {
        let line = json!({"type": "control_response", "response": {"request_id": INITIALIZE_ID, "subtype": "success", "response": {"commands": [
            {"name": "ux-copy", "description": "Write UX copy (user)", "argumentHint": ""},
            {"name": "pdf", "description": "PDFs", "argumentHint": "<file>", "aliases": ["anthropic-skills:pdf"]},
            {"name": "clear", "description": "Start a new session", "argumentHint": "[name]", "builtin": true},
            {"name": "claude.ai Figma:rules (MCP)", "description": "MCP prompt", "argumentHint": ""},
            {"description": "nameless"}
        ]}}});
        assert_eq!(
            parse_reply(&line),
            Some(Ok(Reply::Skills(vec![
                Skill {
                    name: "ux-copy".into(),
                    description: "Write UX copy (user)".into(),
                    argument_hint: String::new(),
                    aliases: vec![],
                },
                Skill {
                    name: "pdf".into(),
                    description: "PDFs".into(),
                    argument_hint: "<file>".into(),
                    aliases: vec!["anthropic-skills:pdf".into()],
                },
            ])))
        );
    }

    #[test]
    fn ignores_other_lines_and_reports_errors() {
        let other = json!({"type": "control_response", "response": {"request_id": "other", "subtype": "success"}});
        assert_eq!(parse_reply(&other), None);
        assert_eq!(parse_reply(&json!({"type": "system"})), None);
        let failed = json!({"type": "control_response", "response": {"request_id": STATUS_ID, "subtype": "error", "error": "nope"}});
        assert_eq!(parse_reply(&failed), Some(Err("nope".into())));
        let failed = json!({"type": "control_response", "response": {"request_id": INITIALIZE_ID, "subtype": "error"}});
        assert_eq!(
            parse_reply(&failed),
            Some(Err("Claude Code could not list its skills".into()))
        );
        for id in [STATUS_ID, INITIALIZE_ID] {
            let malformed = json!({"type": "control_response", "response": {"request_id": id, "subtype": "success", "response": {}}});
            assert!(matches!(parse_reply(&malformed), Some(Err(_))));
        }
    }

    #[tokio::test]
    #[ignore = "requires terminal Claude Code sign-in and network"]
    async fn real_cli_lists_servers_and_skills() {
        let root = tempfile::tempdir().unwrap();
        let capabilities = claude_capabilities(root.path().to_string_lossy().to_string())
            .await
            .unwrap();
        eprintln!(
            "{} MCP servers, {} skills",
            capabilities.mcp_servers.len(),
            capabilities.skills.len()
        );
        assert!(capabilities
            .mcp_servers
            .iter()
            .all(|server| !server.name.is_empty()));
        assert!(!capabilities.skills.is_empty());
    }
}
