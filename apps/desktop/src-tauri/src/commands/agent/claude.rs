use super::{AgentEvent, AgentProcess, Input, NoteClaims};
use crate::{error::AppError, state::AppState};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::OnceLock,
    time::Duration,
};
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, watch},
};

static CLAUDE_ENV: OnceLock<(PathBuf, String)> = OnceLock::new();

async fn resolve_claude_env() -> Result<(PathBuf, String), AppError> {
    if let Some(env) = CLAUDE_ENV.get() {
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
                "printf '\\n__WRITER_CLAUDE__\\n%s\\n%s\\n' \"$(command -v claude)\" \"$PATH\"",
            ])
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| AppError::Io("Timed out resolving Claude Code from your login shell".into()))??;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let framed = stdout.split_once("\n__WRITER_CLAUDE__\n").map(|(_, s)| s);
    let mut lines = framed.unwrap_or("").lines();
    let binary = PathBuf::from(lines.next().unwrap_or(""));
    let path = lines.next().unwrap_or("").to_string();
    if !output.status.success() || !binary.is_absolute() || !binary.is_file() || path.is_empty() {
        return Err(AppError::NotFound("Claude Code CLI not found. Install Claude Code and sign in in your terminal, then try again.".into()));
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
    .map_err(|_| AppError::Io("Timed out checking Claude Code capabilities".into()))??;
    let text = String::from_utf8_lossy(&version.stdout);
    let numbers: Vec<u32> = text
        .split_whitespace()
        .next()
        .unwrap_or("")
        .split('.')
        .filter_map(|part| part.parse().ok())
        .collect();
    if !version.status.success() || numbers.as_slice() < [2, 1, 296].as_slice() {
        return Err(AppError::Io("Parallel note agents require Claude Code 2.1.296 or newer. Update Claude Code in your terminal.".into()));
    }
    let _ = CLAUDE_ENV.set(env.clone());
    Ok(env)
}

fn kill_group(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        // The child owns a new process group. Kill tools as well as the CLI,
        // so a stopped Bash tool cannot write after the editor is unlocked.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
const INIT_ID: &str = "writer-initialize";
const HOOK_ID: &str = "writer-note-scope";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(3);
const EDIT_SAVE_FAILED: &str =
    "Writer could not save the user's latest edits to this note. Read it again before editing.";
// Normal CLI startup now includes MCP/plugin connections (typically up to 30s).
// Keep initialization bounded while allowing those connections to finish.
const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(60);

// These tools don't use Writer's built-in file edit path. MCP servers own their
// side effects; requests requiring permission retain the host approval flow.
fn uses_host_permission(tool: &str) -> bool {
    matches!(
        tool,
        "Read" | "Glob" | "Grep" | "WebSearch" | "WebFetch" | "ToolSearch" | "WaitForMcpServers"
    ) || tool
        .strip_prefix("mcp__")
        .and_then(|name| name.split_once("__"))
        .is_some_and(|(server, tool)| {
            !server.is_empty()
                && server
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
                && !tool.is_empty()
                && !tool.chars().any(|c| c.is_whitespace() || c.is_control())
        })
}

/// Resolves an edit target to its canonical path, through the nearest existing
/// ancestor when the file does not exist yet.
fn resolve_target(path: &Path) -> std::io::Result<(PathBuf, bool)> {
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

fn workspace_denial(root: &Path, target: &Path) -> Option<&'static str> {
    let Ok(relative) = target.strip_prefix(root) else {
        return Some("Writer can edit only notes inside this workspace.");
    };
    if relative
        .components()
        .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Some("Writer can't edit files in hidden folders.");
    }
    if !crate::open_target::is_markdown(target) {
        return Some("Writer can create and edit only Markdown notes.");
    }
    None
}

struct PendingTarget {
    path: PathBuf,
    exists: bool,
    tool_use_id: Option<String>,
}

enum Decision {
    Reply(Value),
    /// An approved edit to another note waits, like an own-note edit, until the UI has saved and locked it.
    Hold(AgentEvent),
}

enum Target {
    Allowed(PathBuf),
    NeedsApproval { path: PathBuf, exists: bool },
    Denied(String),
}

struct Scope {
    note: PathBuf,
    root: PathBuf,
    owner: String,
    claims: NoteClaims,
    approved: HashSet<PathBuf>,
    initialized: bool,
    active: bool,
    sent: bool,
    seen: HashSet<String>,
    permissions: HashMap<String, Value>,
    // Allowed note edits wait here, as (allow, deny) replies, until the UI has saved and locked.
    edits: HashMap<String, (Value, Value)>,
    targets: HashMap<String, PendingTarget>,
}
impl Scope {
    fn new(note: PathBuf, root: PathBuf, owner: String, claims: NoteClaims) -> Self {
        Self {
            note,
            root,
            owner,
            claims,
            approved: HashSet::new(),
            initialized: false,
            active: false,
            sent: false,
            seen: HashSet::new(),
            permissions: HashMap::new(),
            edits: HashMap::new(),
            targets: HashMap::new(),
        }
    }
    async fn target(&self, tool: &str, input: &Value) -> Result<Target, String> {
        let path = input["file_path"]
            .as_str()
            .ok_or("Missing edit file path")?;
        let path = PathBuf::from(path);
        if !path.is_absolute()
            || path
                .components()
                .any(|part| part == std::path::Component::ParentDir)
        {
            return Ok(Target::Denied(
                "Edit path must be absolute, without \"..\".".into(),
            ));
        }
        let resolved = tokio::time::timeout(
            CONTROL_TIMEOUT,
            tauri::async_runtime::spawn_blocking(move || resolve_target(&path)),
        )
        .await
        .map_err(|_| "Timed out checking note edit scope")?
        .map_err(|e| e.to_string())?;
        let (canonical, exists) = match resolved {
            Ok(resolved) => resolved,
            Err(error) => return Ok(Target::Denied(error.to_string())),
        };
        #[cfg(test)]
        eprintln!(
            "[note-scope] target={canonical:?} assigned={:?} exists={exists}",
            self.note
        );
        if canonical == self.note || self.approved.contains(&canonical) {
            return Ok(Target::Allowed(canonical));
        }
        if let Some(reason) = workspace_denial(&self.root, &canonical) {
            return Ok(Target::Denied(reason.into()));
        }
        if !exists && tool != "Write" {
            return Ok(Target::Denied(
                "That note doesn't exist. Use Write to create it.".into(),
            ));
        }
        Ok(Target::NeedsApproval {
            path: canonical,
            exists,
        })
    }
    async fn hook(&self, request: &Value) -> Result<Value, String> {
        if request["callback_id"] != HOOK_ID {
            return Err("Unknown Writer scope callback".into());
        }
        let input = &request["input"];
        let tool = input["tool_name"]
            .as_str()
            .ok_or("Missing scope tool name")?;
        if !matches!(tool, "Edit" | "Write") && !uses_host_permission(tool) {
            return Err(format!("Unsupported scoped tool: {tool}"));
        }
        if !self.active {
            return Ok(denied_hook("No active Writer turn."));
        }
        if !matches!(tool, "Edit" | "Write") {
            return Ok(json!({}));
        }
        Ok(match self.target(tool, &input["tool_input"]).await? {
            Target::Allowed(path) => {
                let mut updated = input["tool_input"].clone();
                updated["file_path"] = json!(path);
                json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow", "updatedInput": updated}})
            }
            // Asking overrides the Edit/Write allow rule and routes to the host prompt.
            Target::NeedsApproval { .. } => {
                json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "ask"}})
            }
            Target::Denied(reason) => denied_hook(&reason),
        })
    }
    async fn permission(&mut self, id: &str, request: &Value) -> Result<Option<Value>, String> {
        let tool = request["tool_name"]
            .as_str()
            .ok_or("Missing permission tool")?;
        // Configured CLI hooks/rules can ask again after PreToolUse. Reuse the
        // same native guard; a host permission callback cannot expand edit scope.
        if matches!(tool, "Edit" | "Write") {
            if !self.active {
                return Ok(Some(
                    json!({"behavior": "deny", "message": "No active Writer turn."}),
                ));
            }
            if !request["input"].is_object() {
                return Err("Invalid tool permission input".into());
            }
            let mut input = request["input"].clone();
            return Ok(match self.target(tool, &input).await? {
                Target::Allowed(path) => {
                    input["file_path"] = json!(path);
                    Some(json!({"behavior": "allow", "updatedInput": input}))
                }
                Target::NeedsApproval { path, exists } => {
                    input["file_path"] = json!(path);
                    self.permissions.insert(id.into(), input);
                    let tool_use_id = request["tool_use_id"].as_str().map(String::from);
                    self.targets.insert(
                        id.into(),
                        PendingTarget {
                            path,
                            exists,
                            tool_use_id,
                        },
                    );
                    None
                }
                Target::Denied(reason) => Some(json!({"behavior": "deny", "message": reason})),
            });
        }
        if !self.active || !uses_host_permission(tool) {
            return Ok(Some(
                json!({"behavior": "deny", "message": "This tool is unavailable outside an active Writer turn or its permitted tool set."}),
            ));
        }
        let input = request["input"]
            .as_object()
            .ok_or("Invalid tool permission input")?;
        self.permissions.insert(id.into(), json!(input));
        Ok(None)
    }
    /// Holds an allowed Edit/Write reply; returns the event that asks the UI to prepare.
    fn defer_edit(&mut self, id: &str, request: &Value, reply: &Value) -> Option<AgentEvent> {
        let tool = request["input"]["tool_name"]
            .as_str()
            .or(request["tool_name"].as_str());
        if !matches!(tool, Some("Edit" | "Write")) {
            return None;
        }
        let tool_use_id = request["tool_use_id"]
            .as_str()
            .or(request["input"]["tool_use_id"].as_str())
            .map(String::from);
        self.hold_edit(id, tool_use_id, reply)
    }
    fn hold_edit(
        &mut self,
        id: &str,
        tool_use_id: Option<String>,
        reply: &Value,
    ) -> Option<AgentEvent> {
        let (deny, input) = if reply["hookSpecificOutput"]["permissionDecision"] == "allow" {
            (
                denied_hook(EDIT_SAVE_FAILED),
                &reply["hookSpecificOutput"]["updatedInput"],
            )
        } else if reply["behavior"] == "allow" {
            (
                json!({"behavior": "deny", "message": EDIT_SAVE_FAILED}),
                &reply["updatedInput"],
            )
        } else {
            return None;
        };
        let path = input["file_path"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.note.clone());
        self.edits.insert(id.into(), (reply.clone(), deny));
        Some(AgentEvent::EditStart {
            request_id: id.into(),
            tool_use_id,
            path,
        })
    }
    fn edit_ready(&mut self, id: &str, allow: bool) -> Result<Value, String> {
        let (allowed, denied) = self
            .edits
            .remove(id)
            .ok_or("Edit request is no longer pending")?;
        Ok(response(id, if allow { allowed } else { denied }))
    }
    /// Names the resolved note so the host can show what it is approving.
    fn annotate(&self, id: &str, request: &Value) -> Option<String> {
        let target = self.targets.get(id)?;
        let mut annotated = request.clone();
        annotated["writer_target"] = json!({"path": target.path, "exists": target.exists});
        Some(annotated.to_string())
    }
    fn forget(&mut self, id: &str) {
        self.permissions.remove(id);
        self.targets.remove(id);
        self.edits.remove(id);
    }
    fn decision(&mut self, id: &str, allow: bool) -> Result<Decision, String> {
        if !self.active {
            return Err("No active Writer turn".into());
        }
        let input = self
            .permissions
            .remove(id)
            .ok_or("Tool request is no longer pending")?;
        let target = self.targets.remove(id);
        if !allow {
            return Ok(Decision::Reply(response(
                id,
                json!({"behavior": "deny", "message": "Denied by the user in Writer."}),
            )));
        }
        let allowed = json!({"behavior": "allow", "updatedInput": input});
        let Some(target) = target else {
            return Ok(Decision::Reply(response(id, allowed)));
        };
        {
            let mut claims = self.claims.lock();
            if claims
                .get(&target.path)
                .is_some_and(|owner| owner != &self.owner)
            {
                return Ok(Decision::Reply(response(
                    id,
                    json!({"behavior": "deny", "message": "Another chat is editing this note."}),
                )));
            }
            claims.insert(target.path.clone(), self.owner.clone());
        }
        self.approved.insert(target.path);
        let event = self
            .hold_edit(id, target.tool_use_id, &allowed)
            .ok_or("Approved edit has no allow reply")?;
        Ok(Decision::Hold(event))
    }
    fn release(&self) {
        self.claims.lock().retain(|_, owner| owner != &self.owner);
    }
}
fn denied_hook(message: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": message}})
}
fn response(id: &str, value: Value) -> Value {
    json!({"type": "control_response", "response": {"subtype": "success", "request_id": id, "response": value}})
}
fn user_frame(line: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
    if value["type"] != "user"
        || value["message"]["role"] != "user"
        || !value["message"]["content"].is_string()
    {
        return Err(
            "Writer accepts only user messages; native code owns agent control replies".into(),
        );
    }
    Ok(())
}
async fn write_line(
    stdin: &mut tokio::process::ChildStdin,
    line: &str,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    if *cancel.borrow() {
        return Err("Claude stopped".into());
    }
    let bytes = format!("{line}\n");
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("Claude stopped".into()),
        result = tokio::time::timeout(CONTROL_TIMEOUT, stdin.write_all(bytes.as_bytes())) => result.map_err(|_| "Timed out writing to Claude Code".to_string())?.map_err(|e| e.to_string()),
    }
}
async fn run_process(
    mut child: Child,
    mut input: mpsc::Receiver<Input>,
    mut cancel: watch::Receiver<bool>,
    finished: watch::Sender<bool>,
    events: Channel<AgentEvent>,
    mut scope: Option<Scope>,
    mut ready: Option<oneshot::Sender<Result<(), String>>>,
) {
    let group_id = child.id();
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let stderr = child.stderr.take().expect("piped stderr");
    let err_events = events.clone();
    let err = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(message)) = lines.next_line().await {
            if err_events.send(AgentEvent::Stderr { message }).is_err() {
                break;
            }
        }
    });
    let initialize = json!({"type": "control_request", "request_id": INIT_ID, "request": {"subtype": "initialize", "hooks": {"PreToolUse": [{"matcher": "^(Read|Glob|Grep|Edit|Write|WebSearch|WebFetch|ToolSearch|WaitForMcpServers|mcp__.*)$", "hookCallbackIds": [HOOK_ID], "timeout": 60}]}}});
    let startup = if scope.is_some() {
        write_line(&mut stdin, &initialize.to_string(), &mut cancel).await
    } else {
        Ok(())
    };
    let initialization_deadline = tokio::time::sleep(INITIALIZATION_TIMEOUT);
    tokio::pin!(initialization_deadline);
    let mut failure = startup.err();
    let status = loop {
        if failure.is_some() || *cancel.borrow() {
            kill_group(&mut child);
            break child.wait().await;
        }
        tokio::select! {
            biased;
            _ = cancel.changed() => { kill_group(&mut child); break child.wait().await; }
            _ = &mut initialization_deadline, if scope.as_ref().is_some_and(|s| !s.initialized) => { failure = Some("Claude Code did not initialize Writer's edit scope".into()); }
            status = child.wait() => { break status; }
            next = input.recv() => {
                let Some(next) = next else { kill_group(&mut child); break child.wait().await; };
                let (line, ack) = match next {
                    Input::User { line, ack } => {
                        if let Some(scope) = scope.as_mut() {
                            if !scope.initialized || scope.sent {
                                let _ = ack.send(Err("This note process cannot accept another turn".into())); continue;
                            }
                            if let Err(error) = user_frame(&line) { let _ = ack.send(Err(error)); continue; }
                            scope.sent = true; scope.active = true;
                        }
                        (line, ack)
                    }
                    Input::Permission { request_id, allow, ack } => {
                        match scope.as_mut().ok_or_else(|| "No scoped process".to_string()).and_then(|s| s.decision(&request_id, allow)) {
                            Ok(Decision::Reply(value)) => (value.to_string(), ack),
                            Ok(Decision::Hold(event)) => {
                                if events.send(event).is_err() { failure = Some("Writer's event channel closed".into()); }
                                let _ = ack.send(Ok(()));
                                continue;
                            }
                            Err(error) => { let _ = ack.send(Err(error)); continue; }
                        }
                    }
                    Input::EditReady { request_id, allow, ack } => {
                        match scope.as_mut().ok_or_else(|| "No scoped process".to_string()).and_then(|s| s.edit_ready(&request_id, allow)) {
                            Ok(value) => (value.to_string(), ack),
                            Err(error) => { let _ = ack.send(Err(error)); continue; }
                        }
                    }
                };
                let write = write_line(&mut stdin, &line, &mut cancel).await;
                failure = write.as_ref().err().cloned();
                let _ = ack.send(write);
            }
            line = stdout.next_line() => {
                let mut line = match line { Ok(Some(line)) => line, Ok(None) => { kill_group(&mut child); break child.wait().await; }, Err(error) => { failure = Some(error.to_string()); continue; } };
                if let Some(scope) = scope.as_mut() {
                    let value: Value = match serde_json::from_str(&line) { Ok(value) => value, Err(error) => { failure = Some(format!("Invalid Claude stream: {error}")); continue; } };
                    if value["type"] == "control_response" {
                        if value["response"]["request_id"] != INIT_ID || value["response"]["subtype"] != "success" || scope.initialized {
                            failure = Some("Claude Code rejected Writer's edit-scope initialization".into()); continue;
                        }
                        scope.initialized = true;
                        if let Some(ready) = ready.take() { let _ = ready.send(Ok(())); }
                        continue;
                    }
                    if value["type"] == "control_cancel_request" {
                        if let Some(id) = value["request_id"].as_str() { scope.forget(id); }
                    }
                    if value["type"] == "control_request" {
                        let Some(id) = value["request_id"].as_str().filter(|id| !id.is_empty()) else { failure = Some("Missing native control request ID".into()); continue; };
                        if !scope.seen.insert(id.into()) { failure = Some("Duplicate native control request ID".into()); continue; }
                        let request = &value["request"];
                        let reply = match request["subtype"].as_str() {
                            Some("hook_callback") => scope.hook(request).await.map(Some),
                            Some("can_use_tool") => scope.permission(id, request).await,
                            _ => Err("Unsupported native control request".into()),
                        };
                        match reply {
                            Ok(Some(reply)) => {
                                if let Some(event) = scope.defer_edit(id, request, &reply) {
                                    if events.send(event).is_err() { failure = Some("Writer's event channel closed".into()); }
                                    continue;
                                }
                                failure = write_line(&mut stdin, &response(id, reply).to_string(), &mut cancel).await.err();
                                continue;
                            }
                            Ok(None) => { if let Some(annotated) = scope.annotate(id, &value) { line = annotated; } },
                            Err(error) => { failure = Some(error); continue; }
                        }
                    }
                    if value["type"] == "result" { scope.active = false; scope.permissions.clear(); scope.targets.clear(); scope.edits.clear(); }
                    if events.send(AgentEvent::Claude { line }).is_err() { failure = Some("Writer's event channel closed".into()); continue; }
                    if value["type"] == "result" { kill_group(&mut child); break child.wait().await; }
                } else if events.send(AgentEvent::Claude { line }).is_err() { failure = Some("Writer's event channel closed".into()); }
            }
        }
    };
    #[cfg(unix)]
    if let Some(pid) = group_id {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    if let Some(message) = failure.as_ref() {
        let _ = events.send(AgentEvent::Claude {
            line: json!({"type": "result", "is_error": true, "errors": [message]}).to_string(),
        });
    }
    if let Some(ready) = ready {
        let _ = ready.send(Err(failure.unwrap_or_else(|| {
            "Claude Code exited before edit-scope initialization".into()
        })));
    }
    // Preserve session/final output before signaling confirmed termination.
    while let Ok(Some(line)) = stdout.next_line().await {
        if serde_json::from_str::<Value>(&line)
            .ok()
            .is_some_and(|v| v["type"] != "control_request" && v["type"] != "control_response")
        {
            let _ = events.send(AgentEvent::Claude { line });
        }
    }
    let _ = err.await;
    if let Some(scope) = scope.as_ref() {
        scope.release();
    }
    let _ = events.send(AgentEvent::Exit {
        code: status.ok().and_then(|s| s.code()),
    });
    let _ = finished.send(true);
}

fn scoped_command(
    binary: PathBuf,
    path: String,
    root: &std::path::Path,
    resume_session_id: Option<String>,
) -> Command {
    let mut command = Command::new(binary);
    command.current_dir(root).env("PATH", path).env_remove("CLAUDECODE")
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "manual", "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--tools", "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,ToolSearch,WaitForMcpServers", "--allowedTools", "Edit", "Write", "--append-system-prompt", "You assist a writer in a Markdown editor. Read workspace files for context. Edit the assigned openFile in writer_context freely. Create or edit other notes only when the user asks; each one needs the user's approval, so use absolute paths to Markdown files inside the workspace. Use configured MCP tools when relevant, but do not use them to edit workspace files. Preserve frontmatter and formatting unless asked to change them. Report changes."])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    if let Some(session) = resume_session_id {
        command.args(["--resume", &session]);
    }
    command
}

#[tauri::command]
pub async fn claude_start(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    root: String,
    epoch: u64,
    note_path: String,
    resume_session_id: Option<String>,
    on_event: Channel<AgentEvent>,
) -> Result<String, AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    let agent_epoch = workspace
        .agent_epoch
        .load(std::sync::atomic::Ordering::SeqCst);
    let (binary, path) = resolve_claude_env().await?;
    if !webview
        .is_visible()
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        return Err(AppError::Io(
            "Chat startup canceled because the window is closed".into(),
        ));
    }
    let root = PathBuf::from(root);
    let paths = (root.clone(), PathBuf::from(note_path));
    let (scope_root, note) = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, std::io::Error>((paths.0.canonicalize()?, paths.1.canonicalize()?))
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))??;
    let (ready_tx, ready_rx) = oneshot::channel();
    let id = workspace
        .with_workspace_snapshot(&root, epoch, || {
            let mut registry = workspace.agents.lock();
            if workspace
                .agent_epoch
                .load(std::sync::atomic::Ordering::SeqCst)
                != agent_epoch
            {
                return Err(AppError::Io("Chat startup was canceled".into()));
            }
            registry.retain(|_, process| !*process.finished.borrow());
            let mut claims = workspace.agent_claims.lock();
            if claims.contains_key(&note) {
                return Err(AppError::Io("An agent is already editing this note".into()));
            }
            let mut command = scoped_command(binary, path, &root, resume_session_id);
            let child = command.spawn()?;
            let (tx, rx) = mpsc::channel(1);
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let (finished_tx, finished_rx) = watch::channel(false);
            let id = uuid::Uuid::new_v4().to_string();
            claims.insert(note.clone(), id.clone());
            drop(claims);
            registry.insert(
                id.clone(),
                AgentProcess {
                    input: tx,
                    cancel: cancel_tx,
                    finished: finished_rx,
                },
            );
            tauri::async_runtime::spawn(run_process(
                child,
                rx,
                cancel_rx,
                finished_tx,
                on_event.clone(),
                Some(Scope::new(
                    note,
                    scope_root,
                    id.clone(),
                    workspace.agent_claims.clone(),
                )),
                Some(ready_tx),
            ));
            Ok(id)
        })
        .ok_or(AppError::NoWorkspace)??;
    // Publish cancellation ownership before waiting for MCP/plugin initialization.
    if let Err(error) = on_event.send(AgentEvent::Started {
        process_id: id.clone(),
    }) {
        stop_process(&workspace, &id).await;
        return Err(AppError::Io(error.to_string()));
    }
    match ready_rx.await {
        Ok(Ok(())) => Ok(id),
        failure => {
            stop_process(&workspace, &id).await;
            let message = match failure {
                Ok(Err(message)) => message,
                Err(error) => error.to_string(),
                Ok(Ok(())) => unreachable!(),
            };
            Err(AppError::Io(message))
        }
    }
}
async fn deliver(
    state: &crate::state::WorkspaceState,
    process_id: &str,
    build: impl FnOnce(oneshot::Sender<Result<(), String>>) -> Input,
) -> Result<(), AppError> {
    let tx = state
        .agents
        .lock()
        .get(process_id)
        .ok_or_else(|| AppError::Io("Chat process is no longer active".into()))?
        .input
        .clone();
    let (ack, result) = oneshot::channel();
    tx.send(build(ack))
        .await
        .map_err(|_| AppError::Io("Claude Code exited".into()))?;
    result
        .await
        .map_err(|_| AppError::Io("Claude Code exited".into()))?
        .map_err(AppError::Io)
}
#[tauri::command]
pub async fn claude_send(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    line: String,
) -> Result<(), AppError> {
    user_frame(&line).map_err(AppError::Io)?;
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    deliver(&workspace, &process_id, |ack| Input::User { line, ack }).await
}
#[tauri::command]
pub async fn claude_decide_permission(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    request_id: String,
    allow: bool,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    deliver(&workspace, &process_id, |ack| Input::Permission {
        request_id,
        allow,
        ack,
    })
    .await
}
#[tauri::command]
pub async fn claude_edit_ready(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    request_id: String,
    allow: bool,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    deliver(&workspace, &process_id, |ack| Input::EditReady {
        request_id,
        allow,
        ack,
    })
    .await
}
async fn stop_process(workspace: &crate::state::WorkspaceState, process_id: &str) {
    let mut finished = {
        let registry = workspace.agents.lock();
        let Some(process) = registry.get(process_id) else {
            return;
        };
        process.stop();
        process.finished.clone()
    };
    while !*finished.borrow_and_update() {
        if finished.changed().await.is_err() {
            break;
        }
    }
    workspace.agents.lock().remove(process_id);
}
#[tauri::command]
pub async fn claude_stop(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    stop_process(&workspace, &process_id).await;
    Ok(())
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    impl Decision {
        fn reply(self) -> Value {
            match self {
                Decision::Reply(value) => value,
                Decision::Hold(_) => panic!("decision was held for the UI"),
            }
        }
    }
    fn test_scope(note: PathBuf) -> Scope {
        let root = note.parent().unwrap();
        let root = root.canonicalize().unwrap_or_else(|_| root.into());
        Scope::new(note, root, "test".into(), NoteClaims::default())
    }
    fn shell(script: &str, dir: &std::path::Path) -> Child {
        Command::new("/bin/sh")
            .args(["-c", script])
            .current_dir(dir)
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }
    #[tokio::test]
    async fn cancellation_reaps_process_and_prevents_delayed_tool_writes() {
        let dir = tempfile::tempdir().unwrap();
        let child = shell(
            "(sleep 0.4; echo late > note.md) & echo ready; wait",
            dir.path(),
        );
        let (_input, rx) = mpsc::channel(1);
        let (cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let ready = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let signal = ready.clone();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(json) = body {
                if json.contains("ready") {
                    signal.store(true, std::sync::atomic::Ordering::SeqCst);
                }
            }
            Ok(())
        });
        let task = tokio::spawn(run_process(
            child, rx, cancel_rx, finished, events, None, None,
        ));
        tokio::time::timeout(Duration::from_secs(2), async {
            while !ready.load(std::sync::atomic::Ordering::SeqCst) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        cancel.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), done.changed())
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!dir.path().join("note.md").exists());
    }
    #[tokio::test]
    async fn cancellation_interrupts_a_blocked_stdin_write() {
        let dir = tempfile::tempdir().unwrap();
        let child = shell("sleep 10", dir.path());
        let (input, rx) = mpsc::channel(1);
        let (cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let task = tokio::spawn(run_process(
            child,
            rx,
            cancel_rx,
            finished,
            Channel::new(|_| Ok(())),
            None,
            None,
        ));
        let (ack, outcome) = oneshot::channel();
        input
            .send(Input::User {
                line: "x".repeat(8 * 1024 * 1024),
                ack,
            })
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), done.changed())
            .await
            .unwrap()
            .unwrap();
        assert!(outcome.await.unwrap().is_err());
        task.await.unwrap();
    }
    #[test]
    fn teardown_retains_completion_and_invalidates_pending_starts() {
        let state = crate::state::WorkspaceState::default();
        let (input, _) = mpsc::channel(1);
        let (cancel, cancellation) = watch::channel(false);
        let (_finished, completion) = watch::channel(false);
        state.agents.lock().insert(
            "old".into(),
            AgentProcess {
                input,
                cancel,
                finished: completion,
            },
        );
        state.stop_agent();
        assert!(*cancellation.borrow());
        assert!(!state.agents.lock().is_empty());
        assert_eq!(
            state.agent_epoch.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }

    fn edit_hook(path: &std::path::Path) -> Value {
        json!({"callback_id": HOOK_ID, "input": {"tool_name": "Edit", "tool_input": {"file_path": path, "old_string": "old", "new_string": "new"}}})
    }
    #[tokio::test]
    async fn scope_resolves_aliases_and_denies_other_documents_without_override() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("a.md");
        let other = dir.path().join("b.md");
        std::fs::write(&note, "old").unwrap();
        std::fs::write(&other, "old").unwrap();
        let alias = dir.path().join("alias.md");
        std::os::unix::fs::symlink(&note, &alias).unwrap();
        let mut scope = test_scope(note.canonicalize().unwrap());
        assert_eq!(
            scope.hook(&edit_hook(&note)).await.unwrap()["hookSpecificOutput"]
                ["permissionDecision"],
            "deny"
        );
        scope.active = true;
        let allowed = scope.hook(&edit_hook(&alias)).await.unwrap();
        assert_eq!(allowed["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(
            allowed["hookSpecificOutput"]["updatedInput"]["file_path"],
            json!(note.canonicalize().unwrap())
        );
        for tool in ["Edit", "Write"] {
            let input = json!({"file_path": alias, "old_string": "old", "new_string": "new", "content": "new"});
            let reply = scope
                .permission("own-note", &json!({"tool_name": tool, "input": input}))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(reply["behavior"], "allow");
            let mut canonical_input = input;
            canonical_input["file_path"] = json!(note.canonicalize().unwrap());
            assert_eq!(reply["updatedInput"], canonical_input);
            assert!(scope.decision("own-note", true).is_err());
        }
        let decision = |reply: Value| reply["hookSpecificOutput"]["permissionDecision"].clone();
        let write_hook = |path: &std::path::Path| json!({"callback_id": HOOK_ID, "input": {"tool_name": "Write", "tool_input": {"file_path": path, "content": "new"}}});
        let new_note = dir.path().join("new.md");
        for reply in [
            scope.hook(&edit_hook(&other)).await.unwrap(),
            scope.hook(&write_hook(&other)).await.unwrap(),
            scope.hook(&write_hook(&new_note)).await.unwrap(),
        ] {
            assert_eq!(decision(reply), "ask");
        }
        assert_eq!(
            decision(scope.hook(&edit_hook(&new_note)).await.unwrap()),
            "deny"
        );
        std::fs::create_dir(dir.path().join(".obsidian")).unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("missing.md"),
            dir.path().join("dangling.md"),
        )
        .unwrap();
        for path in [
            PathBuf::from("a.md"),
            dir.path().join("sub/../b.md"),
            dir.path().join("new.txt"),
            dir.path().join(".obsidian/new.md"),
            dir.path().join("dangling.md"),
            std::env::temp_dir().join("outside-writer-workspace.md"),
        ] {
            assert_eq!(
                decision(scope.hook(&edit_hook(&path)).await.unwrap()),
                "deny"
            );
        }
        assert_eq!(
            scope
                .permission(
                    "write",
                    &json!({"tool_name": "Write", "input": {"file_path": dir.path().join("new.txt")}})
                )
                .await
                .unwrap()
                .unwrap()["behavior"],
            "deny"
        );
        assert!(scope.decision("write", true).is_err());
        assert!(scope.hook(&json!({"callback_id": "forged"})).await.is_err());
        assert!(scope
            .hook(&json!({"callback_id": HOOK_ID, "input": {"tool_name": "Bash"}}))
            .await
            .is_err());
        scope.active = false;
        assert_eq!(
            scope
                .permission(
                    "finished-write",
                    &json!({"tool_name": "Write", "input": {"file_path": note, "content": "late"}})
                )
                .await
                .unwrap()
                .unwrap()["behavior"],
            "deny"
        );
    }
    #[tokio::test]
    async fn allowed_note_edits_wait_for_the_ui_and_denials_reply_immediately() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("a.md");
        std::fs::write(&note, "old").unwrap();
        let mut scope = test_scope(note.canonicalize().unwrap());
        scope.active = true;
        let mut hook = edit_hook(&note);
        hook["tool_use_id"] = json!("toolu_1");
        let reply = scope.hook(&hook).await.unwrap();
        let Some(AgentEvent::EditStart {
            request_id,
            tool_use_id,
            path,
        }) = scope.defer_edit("edit", &hook, &reply)
        else {
            panic!("allowed edit did not wait for the UI");
        };
        assert_eq!(
            (request_id.as_str(), tool_use_id.as_deref()),
            ("edit", Some("toolu_1"))
        );
        assert_eq!(path, note.canonicalize().unwrap());
        assert_eq!(
            scope.edit_ready("edit", true).unwrap()["response"]["response"],
            reply
        );
        assert!(scope.edit_ready("edit", true).is_err());
        let request = json!({"tool_name": "Write", "input": {"file_path": note, "content": "new"}});
        let reply = scope.permission("write", &request).await.unwrap().unwrap();
        assert!(scope.defer_edit("write", &request, &reply).is_some());
        assert_eq!(
            scope.edit_ready("write", false).unwrap()["response"]["response"]["behavior"],
            "deny"
        );
        let other = edit_hook(&dir.path().join("b.md"));
        let denied = scope.hook(&other).await.unwrap();
        assert!(scope.defer_edit("other", &other, &denied).is_none());
        let read = json!({"callback_id": HOOK_ID, "input": {"tool_name": "Read"}});
        assert!(scope.defer_edit("read", &read, &json!({})).is_none());
    }
    #[tokio::test]
    async fn other_notes_need_one_approval_and_an_unclaimed_note() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("b.md"), "b").unwrap();
        let claims = NoteClaims::default();
        let mut scope = Scope::new(root.join("a.md"), root.clone(), "a".into(), claims.clone());
        scope.active = true;
        let write = |path: PathBuf| json!({"tool_name": "Write", "input": {"file_path": path, "content": "new"}});
        let created = root.join("notes/new.md");
        assert!(scope
            .permission("annotate", &write(dir.path().join("notes/new.md")))
            .await
            .unwrap()
            .is_none());
        let line = scope
            .annotate("annotate", &json!({"type": "control_request"}))
            .unwrap();
        let line: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(
            line["writer_target"],
            json!({"path": created, "exists": false})
        );
        let mut create = write(dir.path().join("notes/new.md"));
        create["tool_use_id"] = json!("toolu_create");
        assert!(scope.permission("create", &create).await.unwrap().is_none());
        let Ok(Decision::Hold(AgentEvent::EditStart {
            tool_use_id, path, ..
        })) = scope.decision("create", true)
        else {
            panic!("approved note edit did not wait for the UI");
        };
        assert_eq!(
            (tool_use_id.as_deref(), &path),
            (Some("toolu_create"), &created)
        );
        let reply = scope.edit_ready("create", true).unwrap();
        assert_eq!(
            reply["response"]["response"]["updatedInput"]["file_path"],
            json!(created)
        );
        assert_eq!(claims.lock().get(&created).map(String::as_str), Some("a"));
        // Later edits to an approved note in the same turn need no prompt.
        assert_eq!(
            scope.hook(&edit_hook(&created)).await.unwrap()["hookSpecificOutput"]
                ["permissionDecision"],
            "allow"
        );

        claims.lock().insert(root.join("b.md"), "b".into());
        assert!(scope
            .permission("busy", &write(root.join("b.md")))
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            scope.decision("busy", true).unwrap().reply()["response"]["response"]["behavior"],
            "deny"
        );
        assert!(!scope.approved.contains(&root.join("b.md")));
        assert!(scope
            .permission("denied", &write(root.join("b.md")))
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            scope.decision("denied", false).unwrap().reply()["response"]["response"]["behavior"],
            "deny"
        );
        scope.release();
        assert_eq!(claims.lock().len(), 1);
        assert!(claims.lock().contains_key(&root.join("b.md")));
    }
    #[tokio::test]
    async fn controls_are_native_and_permissions_are_process_local_and_single_use() {
        let mut a = test_scope("/a.md".into());
        let mut b = test_scope("/b.md".into());
        a.active = true;
        b.active = true;
        assert!(user_frame(&response("forged", json!({"behavior":"allow"})).to_string()).is_err());
        assert!(
            user_frame(r#"{"type":"user","message":{"role":"user","content":"hello"}}"#).is_ok()
        );
        assert!(a
            .permission(
                "read-a",
                &json!({"tool_name": "Read", "input": {"file_path": "/context.md"}})
            )
            .await
            .unwrap()
            .is_none());
        assert!(b.decision("read-a", true).is_err());
        assert_eq!(
            a.decision("read-a", true).unwrap().reply()["response"]["response"]["updatedInput"]
                ["file_path"],
            "/context.md"
        );
        assert!(a.decision("read-a", true).is_err());
        a.active = false;
        assert_eq!(
            a.permission("late", &json!({"tool_name":"Read"}))
                .await
                .unwrap()
                .unwrap()["behavior"],
            "deny"
        );
    }
    #[test]
    fn command_loads_configured_mcps_without_expanding_builtin_tools() {
        let command = scoped_command(
            "/claude".into(),
            "/bin".into(),
            std::path::Path::new("/vault"),
            Some("session".into()),
        );
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        for disabled in [
            "--safe-mode",
            "--strict-mcp-config",
            "--mcp-config",
            "--disallowedTools",
            "mcp__*",
        ] {
            assert!(!args.contains(&disabled));
        }
        for pair in [
            [
                "--tools",
                "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,ToolSearch,WaitForMcpServers",
            ],
            ["--permission-mode", "manual"],
            ["--permission-prompts", "host"],
            ["--permission-prompt-tool", "stdio"],
            ["--resume", "session"],
        ] {
            assert!(args.windows(2).any(|args| args == pair));
        }
        assert!(args
            .windows(3)
            .any(|args| args == ["--allowedTools", "Edit", "Write"]));
        assert_eq!(
            command.as_std().get_current_dir().unwrap(),
            std::path::Path::new("/vault")
        );
    }
    #[tokio::test]
    async fn read_web_mcp_and_discovery_permissions_preserve_inputs_and_note_scope() {
        for (tool, input) in [
            (
                "mcp__search__query",
                json!({"query": "writer", "options": {"limit": 3}, "items": [1, 2]}),
            ),
            (
                "mcp__server_name__nested__tool",
                json!({"payload": {"text": "original"}}),
            ),
            (
                "ToolSearch",
                json!({"query": "select:mcp__search__query", "max_results": 1}),
            ),
            ("WaitForMcpServers", json!({})),
            (
                "WebSearch",
                json!({"query": "IANA example domains", "allowed_domains": ["iana.org"], "blocked_domains": []}),
            ),
            (
                "WebFetch",
                json!({"url": "https://example.com", "prompt": "Summarize the purpose of this page."}),
            ),
        ] {
            let mut scope = test_scope("/note.md".into());
            let mut other = test_scope("/other.md".into());
            let hook = json!({"callback_id": HOOK_ID, "input": {"tool_name": tool}});
            let request = json!({"tool_name": tool, "input": input});
            assert_eq!(
                scope.hook(&hook).await.unwrap()["hookSpecificOutput"]["permissionDecision"],
                "deny"
            );
            assert_eq!(
                scope
                    .permission("inactive", &request)
                    .await
                    .unwrap()
                    .unwrap()["behavior"],
                "deny"
            );
            scope.active = true;
            other.active = true;
            assert_eq!(scope.hook(&hook).await.unwrap(), json!({}));
            assert!(scope.permission("allow", &request).await.unwrap().is_none());
            assert!(other.decision("allow", true).is_err());
            let reply = scope.decision("allow", true).unwrap().reply();
            assert_eq!(reply["response"]["response"]["behavior"], "allow");
            assert_eq!(reply["response"]["response"]["updatedInput"], input);
            assert!(scope.decision("allow", true).is_err());
            assert!(scope.permission("deny", &request).await.unwrap().is_none());
            assert_eq!(
                scope.decision("deny", false).unwrap().reply()["response"]["response"]["behavior"],
                "deny"
            );
            assert!(scope
                .permission("bad-input", &json!({"tool_name": tool, "input": []}))
                .await
                .is_err());
        }
        let mut scope = test_scope("/note.md".into());
        scope.active = true;
        for tool in [
            "mcp",
            "mcp__",
            "mcp__server",
            "mcp____tool",
            "mcp__server__",
            "mcp__bad server__record",
            "mcp__fixture__record\n",
            "mcp__fixture__bad\ttool",
            "Bash",
            "Agent",
            "NotebookEdit",
            "WebSearchExtra",
            "WebFetchExtra",
        ] {
            assert!(scope
                .hook(&json!({"callback_id": HOOK_ID, "input": {"tool_name": tool}}))
                .await
                .is_err());
            assert_eq!(
                scope
                    .permission("unsupported", &json!({"tool_name": tool, "input": {}}))
                    .await
                    .unwrap()
                    .unwrap()["behavior"],
                "deny"
            );
            assert!(scope.decision("unsupported", true).is_err());
        }
    }
    const INITIALIZED: &str = r#"{"type":"control_response","response":{"subtype":"success","request_id":"writer-initialize","response":{}}}"#;
    async fn wait_done(done: &mut watch::Receiver<bool>) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while !*done.borrow_and_update() {
                done.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
    }
    #[tokio::test]
    async fn mcp_actor_routes_hook_approvals_and_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let permission = |id| json!({"type": "control_request", "request_id": id, "request": {"subtype": "can_use_tool", "tool_name": "mcp__fixture__record", "input": {"payload": {"text": "original", "values": [1, 2]}}}});
        let hook = json!({"type": "control_request", "request_id": "hook", "request": {"subtype": "hook_callback", "callback_id": HOOK_ID, "input": {"tool_name": "mcp__fixture__record"}}});
        let script = format!("read init; printf '%s\\n' \"$init\" > initialize.json; printf '%s\\n' '{INITIALIZED}'; read user; printf '%s\\n' '{hook}'; read hook_reply; printf '%s\\n' '{}' '{{\"type\":\"control_cancel_request\",\"request_id\":\"canceled\"}}' '{}' '{}'; read allowed; printf '%s\\n' \"$allowed\" > allowed.json; read denied; printf '%s\\n' \"$denied\" > denied.json; echo '{{\"type\":\"result\",\"is_error\":false}}'", permission("canceled"), permission("allow"), permission("deny"));
        let child = shell(&script, dir.path());
        let (input, rx) = mpsc::channel(4);
        let (_cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let (ready, initialized) = oneshot::channel();
        let (capture, mut frames) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                let event: Value = serde_json::from_str(&body).unwrap();
                if let Some(line) = event["line"].as_str() {
                    let _ = capture.send(serde_json::from_str::<Value>(line).unwrap());
                }
            }
            Ok(())
        });
        let task = tokio::spawn(run_process(
            child,
            rx,
            cancel_rx,
            finished,
            events,
            Some(test_scope(dir.path().join("note.md"))),
            Some(ready),
        ));
        initialized.await.unwrap().unwrap();
        let (ack, sent) = oneshot::channel();
        input
            .send(Input::User {
                line: json!({"type":"user","message":{"role":"user","content":"use MCP"}})
                    .to_string(),
                ack,
            })
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
        // Wait until the actor has received cancellation and both remaining requests.
        for expected in ["canceled", "canceled", "allow", "deny"] {
            let frame = tokio::time::timeout(Duration::from_secs(2), frames.recv())
                .await
                .unwrap()
                .unwrap();
            assert_eq!(frame["request_id"], expected);
        }
        for (id, allow, success) in [
            ("canceled", true, false),
            ("allow", true, true),
            ("allow", true, false),
            ("deny", false, true),
        ] {
            let (ack, decided) = oneshot::channel();
            input
                .send(Input::Permission {
                    request_id: id.into(),
                    allow,
                    ack,
                })
                .await
                .unwrap();
            assert_eq!(decided.await.unwrap().is_ok(), success);
        }
        wait_done(&mut done).await;
        task.await.unwrap();
        let initialize: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("initialize.json")).unwrap(),
        )
        .unwrap();
        let matcher = regex_lite::Regex::new(
            initialize["request"]["hooks"]["PreToolUse"][0]["matcher"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        for tool in [
            "WebSearch",
            "WebFetch",
            "Read",
            "Edit",
            "Write",
            "mcp__fixture__record",
        ] {
            assert!(matcher.is_match(tool), "Native hook is missing {tool}");
        }
        for tool in ["WebSearchExtra", "WebFetchExtra", "Bash", "Agent"] {
            assert!(!matcher.is_match(tool));
        }
        let allowed: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.path().join("allowed.json")).unwrap(),
        )
        .unwrap();
        let denied: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("denied.json")).unwrap())
                .unwrap();
        assert_eq!(allowed["response"]["request_id"], "allow");
        assert_eq!(
            allowed["response"]["response"]["updatedInput"],
            permission("allow")["request"]["input"]
        );
        assert_eq!(denied["response"]["request_id"], "deny");
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
    }
    #[tokio::test]
    async fn actor_holds_note_edit_until_the_ui_is_ready() {
        let dir = tempfile::tempdir().unwrap();
        let note = dir.path().join("note.md");
        std::fs::write(&note, "old").unwrap();
        let note = note.canonicalize().unwrap();
        let hook = json!({"type": "control_request", "request_id": "edit", "request": {"subtype": "hook_callback", "callback_id": HOOK_ID, "tool_use_id": "toolu_1", "input": {"tool_name": "Edit", "tool_input": {"file_path": note, "old_string": "old", "new_string": "new"}}}});
        let script = format!("read init; printf '%s\\n' '{INITIALIZED}'; read user; printf '%s\\n' '{hook}'; read reply; printf '%s\\n' \"$reply\" > reply.json; echo '{{\"type\":\"result\",\"is_error\":false}}'");
        let child = shell(&script, dir.path());
        let (input, rx) = mpsc::channel(4);
        let (_cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let (ready, initialized) = oneshot::channel();
        let (capture, mut starts) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                let event: Value = serde_json::from_str(&body).unwrap();
                if event["type"] == "edit_start" {
                    let _ = capture.send(event);
                }
            }
            Ok(())
        });
        let task = tokio::spawn(run_process(
            child,
            rx,
            cancel_rx,
            finished,
            events,
            Some(test_scope(note)),
            Some(ready),
        ));
        initialized.await.unwrap().unwrap();
        let (ack, sent) = oneshot::channel();
        input
            .send(Input::User {
                line: json!({"type":"user","message":{"role":"user","content":"edit"}}).to_string(),
                ack,
            })
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
        let start = tokio::time::timeout(Duration::from_secs(2), starts.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(start["requestId"], "edit");
        assert_eq!(start["toolUseId"], "toolu_1");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!dir.path().join("reply.json").exists());
        let (ack, decided) = oneshot::channel();
        input
            .send(Input::EditReady {
                request_id: "edit".into(),
                allow: true,
                ack,
            })
            .await
            .unwrap();
        decided.await.unwrap().unwrap();
        wait_done(&mut done).await;
        task.await.unwrap();
        let reply: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("reply.json")).unwrap())
                .unwrap();
        assert_eq!(reply["response"]["request_id"], "edit");
        assert_eq!(
            reply["response"]["response"]["hookSpecificOutput"]["permissionDecision"],
            "allow"
        );
    }
    #[tokio::test]
    async fn scoped_protocol_failures_reap_before_releasing_ownership() {
        let dir = tempfile::tempdir().unwrap();
        for emitted in [
            "not JSON",
            r#"{"type":"control_request","request_id":"bad","request":{"subtype":"hook_callback","callback_id":"forged"}}"#,
            r#"{"type":"control_request","request_id":"bad","request":{"subtype":"hook_callback","callback_id":"writer-note-scope","input":{"tool_name":"Edit","tool_input":{}}}}"#,
            r#"{"type":"control_request","request_id":"reply","request":{"subtype":"hook_callback","callback_id":"writer-note-scope","input":{"tool_name":"Read","tool_input":{}}}}"#,
        ] {
            let script = format!("read init; printf '%s\\n' '{}'; read user; exec 0<&-; printf '%s\\n' '{}'; (sleep 0.4; echo late > forbidden.md) & wait", INITIALIZED, emitted);
            let child = shell(&script, dir.path());
            let (input, rx) = mpsc::channel(1);
            let (_cancel, cancel_rx) = watch::channel(false);
            let (finished, mut done) = watch::channel(false);
            let (ready, initialized) = oneshot::channel();
            let errors = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let capture = errors.clone();
            let events = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                    capture.lock().unwrap().push(body);
                }
                Ok(())
            });
            let task = tokio::spawn(run_process(
                child,
                rx,
                cancel_rx,
                finished,
                events,
                Some(test_scope(dir.path().join("a.md"))),
                Some(ready),
            ));
            initialized.await.unwrap().unwrap();
            let (ack, sent) = oneshot::channel();
            input
                .send(Input::User {
                    line: json!({"type":"user","message":{"role":"user","content":"edit"}})
                        .to_string(),
                    ack,
                })
                .await
                .unwrap();
            sent.await.unwrap().unwrap();
            wait_done(&mut done).await;
            task.await.unwrap();
            assert!(errors.lock().unwrap().iter().any(|body| {
                let event: Value = serde_json::from_str(body).unwrap();
                event["line"]
                    .as_str()
                    .and_then(|line| serde_json::from_str::<Value>(line).ok())
                    .is_some_and(|v| {
                        v["type"] == "result"
                            && v["is_error"] == true
                            && v["errors"]
                                .as_array()
                                .is_some_and(|errors| !errors.is_empty())
                    })
            }));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!dir.path().join("forbidden.md").exists());
    }
    #[tokio::test]
    async fn rejected_initialization_never_admits_a_prompt_and_reaps() {
        let dir = tempfile::tempdir().unwrap();
        for reply in [
            r#"{"type":"control_response","response":{"subtype":"error","request_id":"writer-initialize","error":"unsupported hooks"}}"#,
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"wrong-initialize","response":{}}}"#,
        ] {
            let child = shell(
                &format!(
                    "read init; printf '%s\\n' '{}'; (sleep 0.4; echo late > forbidden.md) & wait",
                    reply
                ),
                dir.path(),
            );
            let (_input, rx) = mpsc::channel(1);
            let (_cancel, cancel_rx) = watch::channel(false);
            let (finished, mut done) = watch::channel(false);
            let (ready, initialized) = oneshot::channel();
            let task = tokio::spawn(run_process(
                child,
                rx,
                cancel_rx,
                finished,
                Channel::new(|_| Ok(())),
                Some(test_scope(dir.path().join("a.md"))),
                Some(ready),
            ));
            assert!(initialized
                .await
                .unwrap()
                .unwrap_err()
                .contains("initialization"));
            wait_done(&mut done).await;
            task.await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!dir.path().join("forbidden.md").exists());
    }
    #[tokio::test]
    async fn cancellation_interrupts_mcp_startup_before_initialization_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let child = shell(
            "read init; echo '{\"type\":\"system\",\"subtype\":\"test_startup\"}'; sleep 100",
            dir.path(),
        );
        let (_input, rx) = mpsc::channel(1);
        let (cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let (ready, initialized) = oneshot::channel();
        let (started, mut startup) = mpsc::unbounded_channel();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                if body.contains("test_startup") {
                    let _ = started.send(());
                }
            }
            Ok(())
        });
        let task = tokio::spawn(run_process(
            child,
            rx,
            cancel_rx,
            finished,
            events,
            Some(test_scope(dir.path().join("note.md"))),
            Some(ready),
        ));
        tokio::time::timeout(Duration::from_secs(2), startup.recv())
            .await
            .unwrap()
            .unwrap();
        cancel.send(true).unwrap();
        wait_done(&mut done).await;
        assert!(initialized.await.unwrap().is_err());
        task.await.unwrap();
    }
    #[tokio::test]
    async fn independent_scoped_actors_can_stop_one_and_complete_the_other() {
        let dir = tempfile::tempdir().unwrap();
        let mut actors = Vec::new();
        for name in ["a", "b"] {
            let script = format!("read init; printf '%s\\n' '{}'; read user; sleep 0.2; echo '{{\"type\":\"result\",\"is_error\":false}}'; (sleep 0.4; echo late > {}.md) & wait", INITIALIZED, name);
            let child = shell(&script, dir.path());
            let (input, rx) = mpsc::channel(1);
            let (cancel, cancel_rx) = watch::channel(false);
            let (finished, done) = watch::channel(false);
            let (ready, initialized) = oneshot::channel();
            let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
            let capture = frames.clone();
            let events = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                    let event: Value = serde_json::from_str(&body).unwrap();
                    if let Some(line) = event["line"].as_str() {
                        capture
                            .lock()
                            .unwrap()
                            .push(serde_json::from_str(line).unwrap());
                    }
                }
                Ok(())
            });
            let task = tokio::spawn(run_process(
                child,
                rx,
                cancel_rx,
                finished,
                events,
                Some(test_scope(dir.path().join(format!("{name}.md")))),
                Some(ready),
            ));
            initialized.await.unwrap().unwrap();
            let (ack, sent) = oneshot::channel();
            input
                .send(Input::User {
                    line: json!({"type":"user","message":{"role":"user","content":"edit"}})
                        .to_string(),
                    ack,
                })
                .await
                .unwrap();
            sent.await.unwrap().unwrap();
            actors.push((input, cancel, done, task, frames));
        }
        actors[0].1.send(true).unwrap();
        wait_done(&mut actors[0].2).await;
        assert!(!*actors[1].2.borrow());
        wait_done(&mut actors[1].2).await;
        assert!(actors[0]
            .4
            .lock()
            .unwrap()
            .iter()
            .all(|v| v["type"] != "result"));
        assert!(actors[1]
            .4
            .lock()
            .unwrap()
            .iter()
            .any(|v| v["type"] == "result" && v["is_error"] == false));
        for (_, _, _, task, _) in actors {
            task.await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!dir.path().join("a.md").exists());
        assert!(!dir.path().join("b.md").exists());
    }
    /// Explicit manual integration check: uses the locally installed, signed-in CLI.
    #[tokio::test]
    #[ignore = "requires terminal Claude Code sign-in, network and permitted session plugins"]
    async fn real_cli_two_note_scope() {
        const FIXTURE_TOOL: &str = "mcp__plugin_writer-fixture_writer-fixture__record";
        let dir = tempfile::tempdir().unwrap();
        let (binary, path) = resolve_claude_env().await.unwrap();
        let server = dir.path().join("mcp-server.py");
        std::fs::write(
            &server,
            include_str!("../../../tests/fixtures/mcp-server.py"),
        )
        .unwrap();
        // A session plugin also works on machines that restrict MCP sources to
        // plugins. Keep managed policy intact; do not override MCP discovery.
        let plugin = dir.path().join("fixture-plugin");
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"writer-fixture","version":"1.0.0"}"#,
        )
        .unwrap();
        std::fs::write(plugin.join(".mcp.json"), json!({"mcpServers": {"writer-fixture": {"command": "/usr/bin/python3", "args": [server, dir.path()]}}}).to_string()).unwrap();
        let forbidden = dir.path().join("context.md");
        std::fs::write(&forbidden, "UNCHANGED").unwrap();
        let mut actors = Vec::new();
        for name in ["a", "b"] {
            let note = dir.path().join(format!("{name}.md"));
            std::fs::write(&note, "Original").unwrap();
            let canonical = note.canonicalize().unwrap();
            let child = scoped_command(binary.clone(), path.clone(), dir.path(), None)
                .args(["--plugin-dir", plugin.to_str().unwrap()])
                .spawn()
                .unwrap();
            let (input, rx) = mpsc::channel(4);
            let (_cancel, cancel_rx) = watch::channel(false);
            let (finished, done) = watch::channel(false);
            let (ready, initialized) = oneshot::channel();
            let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
            let capture = frames.clone();
            let decisions = input.clone();
            let allow_mcp = name == "a";
            let events = Channel::new(move |body| {
                if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                    let event: Value = serde_json::from_str(&body).unwrap();
                    if event["type"] == "edit_start" {
                        let id = event["requestId"].as_str().unwrap().to_string();
                        let tx = decisions.clone();
                        tokio::spawn(async move {
                            let (ack, reply) = oneshot::channel();
                            let _ = tx
                                .send(Input::EditReady {
                                    request_id: id,
                                    allow: true,
                                    ack,
                                })
                                .await;
                            let _ = reply.await;
                        });
                    }
                    if let Some(line) = event["line"].as_str() {
                        let value: Value = serde_json::from_str(line).unwrap();
                        if value["type"] == "control_request" {
                            let id = value["request_id"].as_str().unwrap().to_string();
                            let tool = value["request"]["tool_name"].as_str().unwrap();
                            let allow = if tool == FIXTURE_TOOL {
                                allow_mcp
                            } else if tool == "Write" {
                                value["writer_target"]["path"]
                                    .as_str()
                                    .is_some_and(|path| path.ends_with("/created-a.md"))
                            } else {
                                matches!(
                                    tool,
                                    "Read"
                                        | "Glob"
                                        | "Grep"
                                        | "WebSearch"
                                        | "WebFetch"
                                        | "ToolSearch"
                                        | "WaitForMcpServers"
                                )
                            };
                            let tx = decisions.clone();
                            tokio::spawn(async move {
                                let (ack, reply) = oneshot::channel();
                                let _ = tx
                                    .send(Input::Permission {
                                        request_id: id,
                                        allow,
                                        ack,
                                    })
                                    .await;
                                let _ = reply.await;
                            });
                        }
                        capture.lock().unwrap().push(value);
                    }
                }
                Ok(())
            });
            let task = tokio::spawn(run_process(
                child,
                rx,
                cancel_rx,
                finished,
                events,
                Some(test_scope(canonical.clone())),
                Some(ready),
            ));
            initialized.await.unwrap().unwrap();
            let prompt = format!("<writer_context>{{\"openFile\":\"{}\"}}</writer_context>\nUse Write to replace your assigned note with exactly REVISED-{name}. Then test the native scope guard by attempting Write on {} with content FORBIDDEN. This is a guard test: attempt that tool call once and report its denial. Then create the new note {}/created-{name}.md with Write and content CREATED. If its permission is denied, report that without retrying. Next use ToolSearch (if needed) to find {FIXTURE_TOOL} and call it exactly once with note={name}. If its permission is denied, report that without retrying. Do not use other MCP tools. Finish after these checks.", canonical.display(), forbidden.display(), dir.path().display());
            let (ack, sent) = oneshot::channel();
            input
                .send(Input::User {
                    line: json!({"type":"user","message":{"role":"user","content":prompt}})
                        .to_string(),
                    ack,
                })
                .await
                .unwrap();
            sent.await.unwrap().unwrap();
            println!("Started note {name}");
            actors.push((_cancel, input, done, task, note, frames));
        }
        for (_, _, mut done, task, note, frames) in actors {
            tokio::time::timeout(Duration::from_secs(90), async {
                while !*done.borrow_and_update() {
                    done.changed().await.unwrap();
                }
            })
            .await
            .unwrap();
            task.await.unwrap();
            let frames = frames.lock().unwrap();
            assert!(
                frames
                    .iter()
                    .any(|v| v["type"] == "result" && v["is_error"] == false),
                "CLI turn failed: {frames:?}"
            );
            assert_eq!(
                std::fs::read_to_string(&note).unwrap().trim(),
                format!("REVISED-{}", note.file_stem().unwrap().to_string_lossy())
            );
            assert!(
                frames
                    .iter()
                    .any(|v| v["type"] == "control_request"
                        && v["request"]["tool_name"] == FIXTURE_TOOL),
                "MCP approval did not reach the host"
            );
            assert!(
                frames.iter().any(|v| v["type"] == "control_request"
                    && v["request"]["tool_name"] == "Write"
                    && v["writer_target"]["exists"] == false),
                "New-note approval did not reach the host"
            );
            println!(
                "Verified {} edit with context unchanged",
                note.file_name().unwrap().to_string_lossy()
            );
        }
        assert_eq!(std::fs::read_to_string(forbidden).unwrap(), "UNCHANGED");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("created-a.md"))
                .unwrap()
                .trim(),
            "CREATED"
        );
        assert!(
            !dir.path().join("created-b.md").exists(),
            "Denied note creation executed"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("mcp-a.txt")).unwrap(),
            "EXECUTED"
        );
        assert!(
            !dir.path().join("mcp-b.txt").exists(),
            "Denied MCP tool executed"
        );
    }
}
