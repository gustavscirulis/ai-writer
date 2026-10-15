use super::scope::{
    self, checked_answers, question_texts, resolve_target, Remember, Target, DECLINED_QUESTIONS,
    NOTE_CLAIMED,
};
use super::{allowed_tools, AgentEvent, Answer, Input, NoteClaims};
use crate::{error::AppError, state::AppState};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::{mpsc, oneshot, watch},
};

static CLAUDE_ENV: OnceLock<(PathBuf, String)> = OnceLock::new();
const CLAUDE_CLI: super::cli_env::Cli = super::cli_env::Cli {
    binary: "claude",
    name: "Claude Code",
    min_version: &[2, 1, 296],
    update_hint: "Update Claude Code in your terminal.",
    cache: &CLAUDE_ENV,
};

pub(super) async fn resolve_claude_env() -> Result<(PathBuf, String), AppError> {
    super::cli_env::resolve(&CLAUDE_CLI).await
}

pub(super) fn kill_group(child: &mut Child) {
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
    "Co-writer could not save the user's latest edits to this note. Read it again before editing.";
// Normal CLI startup now includes MCP/plugin connections (typically up to 30s).
// Keep initialization bounded while allowing those connections to finish.
const INITIALIZATION_TIMEOUT: Duration = Duration::from_secs(60);

// These tools don't use Co-writer's built-in file edit path. MCP servers own their
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

/// Tools that wait on the user's answer rather than an allow/deny decision.
fn interactive_tool(tool: &str) -> bool {
    matches!(tool, "AskUserQuestion" | "ExitPlanMode")
}

const PLANNING: &str =
    "Plan mode: present your plan with ExitPlanMode and wait for the user's approval before editing notes.";

/// Claude Code writes plan-mode plans to `plans/` in its config folder.
fn plans_dir() -> Option<PathBuf> {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))?;
    resolve_target(&config.join("plans"))
        .ok()
        .map(|(path, _)| path)
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

struct Scope {
    note: Option<PathBuf>,
    root: PathBuf,
    owner: String,
    claims: NoteClaims,
    approved: HashSet<PathBuf>,
    /// Tools the user always allows; they skip the host prompt.
    always: HashSet<String>,
    /// Saves an always-allowed tool before its request is answered.
    remember: Option<Remember>,
    attached: HashSet<PathBuf>,
    /// The turn started in plan mode and its plan isn't approved yet.
    planning: bool,
    /// Canonical folder of Claude Code's plan files, while planning.
    plans: Option<PathBuf>,
    initialized: bool,
    active: bool,
    sent: bool,
    seen: HashSet<String>,
    permissions: HashMap<String, (String, Value)>,
    // Allowed note edits wait here, as (allow, deny) replies, until the UI has saved and locked.
    edits: HashMap<String, (Value, Value)>,
    targets: HashMap<String, PendingTarget>,
}
impl Scope {
    fn new(note: Option<PathBuf>, root: PathBuf, owner: String, claims: NoteClaims) -> Self {
        Self {
            note,
            root,
            owner,
            claims,
            approved: HashSet::new(),
            always: HashSet::new(),
            remember: None,
            attached: HashSet::new(),
            planning: false,
            plans: None,
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
        let (canonical, exists) = match scope::resolve(PathBuf::from(path)).await? {
            Ok(resolved) => resolved,
            Err(reason) => return Ok(Target::Denied(reason)),
        };
        #[cfg(test)]
        eprintln!(
            "[note-scope] target={canonical:?} assigned={:?} exists={exists}",
            self.note
        );
        if self.planning {
            let plan_file = self.plans.as_deref().is_some_and(|plans| {
                canonical.parent() == Some(plans) && crate::open_target::is_markdown(&canonical)
            });
            return Ok(if plan_file {
                Target::PlanFile
            } else {
                Target::Denied(PLANNING.into())
            });
        }
        Ok(scope::classify(
            self.note.as_deref(),
            &self.approved,
            &self.root,
            canonical,
            exists,
            (tool != "Write").then_some("That note doesn't exist. Use Write to create it."),
        ))
    }
    /// A Read of a file the user attached this turn needs no further approval.
    async fn attached_read(&self, input: &Value) -> Result<bool, String> {
        let Some(path) = input["file_path"]
            .as_str()
            .filter(|_| !self.attached.is_empty())
        else {
            return Ok(false);
        };
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Ok(false);
        }
        let resolved = tokio::time::timeout(
            CONTROL_TIMEOUT,
            tauri::async_runtime::spawn_blocking(move || path.canonicalize()),
        )
        .await
        .map_err(|_| "Timed out checking an attached file")?
        .map_err(|e| e.to_string())?;
        Ok(resolved.is_ok_and(|path| self.attached.contains(&path)))
    }
    async fn hook(&self, request: &Value) -> Result<Value, String> {
        if request["callback_id"] != HOOK_ID {
            return Err("Unknown Co-writer scope callback".into());
        }
        let input = &request["input"];
        let tool = input["tool_name"]
            .as_str()
            .ok_or("Missing scope tool name")?;
        if !matches!(tool, "Edit" | "Write") && !uses_host_permission(tool) {
            return Err(format!("Unsupported scoped tool: {tool}"));
        }
        if !self.active {
            return Ok(denied_hook("No active Co-writer turn."));
        }
        if tool == "Read" && self.attached_read(&input["tool_input"]).await? {
            return Ok(
                json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "allow"}}),
            );
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
            // Claude Code's plan mode decides its own plan file.
            Target::PlanFile => json!({}),
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
                    json!({"behavior": "deny", "message": "No active Co-writer turn."}),
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
                    if self.always.contains(tool) {
                        return Ok(Some(if self.claim(path) {
                            json!({"behavior": "allow", "updatedInput": input})
                        } else {
                            json!({"behavior": "deny", "message": NOTE_CLAIMED})
                        }));
                    }
                    self.permissions.insert(id.into(), (tool.into(), input));
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
                Target::PlanFile => Some(json!({"behavior": "allow", "updatedInput": input})),
                Target::Denied(reason) => Some(json!({"behavior": "deny", "message": reason})),
            });
        }
        if interactive_tool(tool) && self.active {
            let input = request["input"]
                .as_object()
                .ok_or("Invalid tool permission input")?;
            if tool == "ExitPlanMode" && !self.planning {
                return Ok(Some(
                    json!({"behavior": "deny", "message": "Plan mode is off, so there is no plan to approve. Carry on with the task."}),
                ));
            }
            if tool == "AskUserQuestion" && question_texts(&request["input"]).is_err() {
                return Ok(Some(
                    json!({"behavior": "deny", "message": "Co-writer couldn't show these questions to the user."}),
                ));
            }
            self.permissions
                .insert(id.into(), (tool.into(), json!(input)));
            return Ok(None);
        }
        if !self.active || !uses_host_permission(tool) {
            return Ok(Some(
                json!({"behavior": "deny", "message": "This tool is unavailable outside an active Co-writer turn or its permitted tool set."}),
            ));
        }
        let input = request["input"]
            .as_object()
            .ok_or("Invalid tool permission input")?;
        if self.always.contains(tool) {
            return Ok(Some(json!({"behavior": "allow", "updatedInput": input})));
        }
        if tool == "Read" && self.attached_read(&request["input"]).await? {
            return Ok(Some(json!({"behavior": "allow", "updatedInput": input})));
        }
        self.permissions
            .insert(id.into(), (tool.into(), json!(input)));
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
        // While planning, the only allowed write is the plan file, which isn't a note.
        if self.planning {
            return None;
        }
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
            .or_else(|| self.note.clone())?;
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
    fn decision(&mut self, id: &str, allow: bool, always: bool) -> Result<Decision, String> {
        if !self.active {
            return Err("No active Co-writer turn".into());
        }
        if self
            .permissions
            .get(id)
            .is_some_and(|(tool, _)| interactive_tool(tool))
        {
            return Err("This request needs an answer, not an approval".into());
        }
        let pending = "Tool request is no longer pending";
        let (tool, _) = self.permissions.get(id).ok_or(pending)?;
        // A failed save leaves the request pending, so the user can retry or allow once.
        if let (true, true, Some(remember)) = (allow, always, &self.remember) {
            remember(tool)?;
        }
        let (tool, input) = self.permissions.remove(id).ok_or(pending)?;
        let target = self.targets.remove(id);
        if !allow {
            return Ok(Decision::Reply(response(
                id,
                json!({"behavior": "deny", "message": "Denied by the user in Co-writer."}),
            )));
        }
        if always {
            self.always.insert(tool);
        }
        let allowed = json!({"behavior": "allow", "updatedInput": input});
        let Some(target) = target else {
            return Ok(Decision::Reply(response(id, allowed)));
        };
        if !self.claim(target.path) {
            return Ok(Decision::Reply(response(
                id,
                json!({"behavior": "deny", "message": NOTE_CLAIMED}),
            )));
        }
        let event = self
            .hold_edit(id, target.tool_use_id, &allowed)
            .ok_or("Approved edit has no allow reply")?;
        Ok(Decision::Hold(event))
    }
    fn answer(&mut self, id: &str, answer: Answer) -> Result<Decision, String> {
        let answers = match answer {
            Answer::Tool { allow, always } => return self.decision(id, allow, always),
            Answer::Questions { answers } => answers,
            Answer::Plan { approve, feedback } => return self.plan_decision(id, approve, feedback),
        };
        let mut input = self.interactive_input(id, "AskUserQuestion")?;
        let reply = match answers {
            Some(answers) => {
                checked_answers(&input, &answers)?;
                input["answers"] = json!(answers);
                json!({"behavior": "allow", "updatedInput": input})
            }
            None => json!({"behavior": "deny", "message": DECLINED_QUESTIONS}),
        };
        self.permissions.remove(id);
        Ok(Decision::Reply(response(id, reply)))
    }
    fn plan_decision(
        &mut self,
        id: &str,
        approve: bool,
        feedback: Option<String>,
    ) -> Result<Decision, String> {
        let input = self.interactive_input(id, "ExitPlanMode")?;
        let message = scope::keep_planning(feedback.as_deref())?;
        let reply = if approve {
            self.planning = false;
            json!({"behavior": "allow", "updatedInput": input})
        } else {
            json!({"behavior": "deny", "message": message})
        };
        self.permissions.remove(id);
        Ok(Decision::Reply(response(id, reply)))
    }
    /// A copy of the retained input; the request stays pending until a valid answer.
    fn interactive_input(&self, id: &str, expected: &str) -> Result<Value, String> {
        if !self.active {
            return Err("No active Co-writer turn".into());
        }
        match self.permissions.get(id) {
            Some((tool, input)) if tool == expected => Ok(input.clone()),
            Some(_) => Err("That answer doesn't fit this request".into()),
            None => Err("Tool request is no longer pending".into()),
        }
    }
    /// Claims another note for this chat; false when a different chat holds it.
    fn claim(&mut self, path: PathBuf) -> bool {
        if !scope::claim(&self.claims, &self.owner, &path) {
            return false;
        }
        self.approved.insert(path);
        true
    }
    fn release(&self) {
        scope::release(&self.claims, &self.owner);
    }
}
fn denied_hook(message: &str) -> Value {
    json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": message}})
}
fn response(id: &str, value: Value) -> Value {
    json!({"type": "control_response", "response": {"subtype": "success", "request_id": id, "response": value}})
}
fn user_frame(content: &str) -> String {
    json!({"type": "user", "message": {"role": "user", "content": content}}).to_string()
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
            _ = &mut initialization_deadline, if scope.as_ref().is_some_and(|s| !s.initialized) => { failure = Some("Claude Code did not initialize Co-writer's edit scope".into()); }
            status = child.wait() => { break status; }
            next = input.recv() => {
                let Some(next) = next else { kill_group(&mut child); break child.wait().await; };
                let (line, ack) = match next {
                    Input::User { content, files, ack } => {
                        if let Some(scope) = scope.as_mut() {
                            if !scope.initialized || scope.sent {
                                let _ = ack.send(Err("This note process cannot accept another turn".into())); continue;
                            }
                            scope.sent = true; scope.active = true; scope.attached.extend(files);
                        }
                        (user_frame(&content), ack)
                    }
                    Input::Permission { request_id, answer, ack } => {
                        match scope.as_mut().ok_or_else(|| "No scoped process".to_string()).and_then(|s| s.answer(&request_id, answer)) {
                            Ok(Decision::Reply(value)) => (value.to_string(), ack),
                            Ok(Decision::Hold(event)) => {
                                if events.send(event).is_err() { failure = Some("Co-writer's event channel closed".into()); }
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
                            failure = Some("Claude Code rejected Co-writer's edit-scope initialization".into()); continue;
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
                                    if events.send(event).is_err() { failure = Some("Co-writer's event channel closed".into()); }
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
                    if events.send(AgentEvent::Line { line }).is_err() { failure = Some("Co-writer's event channel closed".into()); continue; }
                    if value["type"] == "result" { kill_group(&mut child); break child.wait().await; }
                } else if events.send(AgentEvent::Line { line }).is_err() { failure = Some("Co-writer's event channel closed".into()); }
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
        let _ = events.send(AgentEvent::Line {
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
            let _ = events.send(AgentEvent::Line { line });
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

const MODEL_SETTING: &str = "co-writer.model";

/// The `--model` alias to pass, or `None` to keep the CLI's configured model.
fn configured_model(settings: &crate::config::Settings) -> Result<Option<String>, AppError> {
    let model = settings
        .get_global_or_default(MODEL_SETTING)
        .and_then(crate::config::ConfigValue::as_str)
        .ok_or_else(|| AppError::Io(format!("Setting {MODEL_SETTING} must be a string")))?;
    if model == "default" {
        return Ok(None);
    }
    let known = crate::config::settings_schema()
        .into_iter()
        .find(|def| def.key == MODEL_SETTING)
        .and_then(|def| def.options)
        .is_some_and(|options| options.iter().any(|option| option == model));
    if !known {
        return Err(AppError::Io(format!(
            "Unknown Co-writer model \"{model}\". Choose one in Settings → Co-writer."
        )));
    }
    Ok(Some(model.into()))
}

fn scoped_command(
    binary: PathBuf,
    path: String,
    root: &std::path::Path,
    resume_session_id: Option<String>,
    model: Option<&str>,
    plan: bool,
    has_note: bool,
) -> Command {
    let mut command = Command::new(binary);
    command.current_dir(root).env("PATH", path).env_remove("CLAUDECODE")
        .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", if plan { "plan" } else { "manual" }, "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--tools", "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,ToolSearch,WaitForMcpServers,AskUserQuestion,ExitPlanMode", "--allowedTools", "Edit", "Write", "--append-system-prompt", &super::system_prompt(has_note, "Write")])
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    if let Some(session) = resume_session_id {
        command.args(["--resume", &session]);
    }
    if let Some(model) = model {
        command.args(["--model", model]);
    }
    command
}

pub(super) fn always_allow_set(tools: Vec<String>) -> Result<HashSet<String>, String> {
    tools
        .into_iter()
        .map(|tool| {
            if matches!(tool.as_str(), "Edit" | "Write") || uses_host_permission(&tool) {
                Ok(tool)
            } else {
                Err(format!("Co-writer can't always allow {tool}"))
            }
        })
        .collect()
}

// Tauri maps each argument to an IPC field.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn claude_start(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    root: String,
    epoch: u64,
    note_path: Option<String>,
    resume_session_id: Option<String>,
    plan: bool,
    on_event: Channel<AgentEvent>,
) -> Result<String, AppError> {
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    let (always, model) = allowed_tools::with_settings(&app, &label, |settings| {
        Ok((allowed_tools::load(settings)?, configured_model(settings)?))
    })?;
    let remember: Remember = Arc::new(move |tool| {
        allowed_tools::with_settings(&app, &label, |settings| {
            allowed_tools::allow(settings, tool)
        })
        .map_err(|e| e.to_string())
    });
    let plans = match plan {
        true => tauri::async_runtime::spawn_blocking(plans_dir)
            .await
            .map_err(|e| AppError::Io(e.to_string()))?,
        false => None,
    };
    let start = super::Start {
        webview: &webview,
        state: &state,
        root,
        epoch,
        note_path,
        provider: "claude-code",
        on_event,
    };
    super::launch(
        start,
        resolve_claude_env(),
        move |(binary, path), launch| {
            let has_note = launch.note.is_some();
            let child = scoped_command(
                binary,
                path,
                &launch.root,
                resume_session_id,
                model.as_deref(),
                plan,
                has_note,
            )
            .spawn()?;
            tauri::async_runtime::spawn(run_process(
                child,
                launch.input,
                launch.cancel,
                launch.finished,
                launch.events,
                Some(Scope {
                    always,
                    remember: Some(remember),
                    planning: plan,
                    plans,
                    ..Scope::new(launch.note, launch.scope_root, launch.id, launch.claims)
                }),
                Some(launch.ready),
            ));
            Ok(())
        },
    )
    .await
}
#[cfg(all(test, unix))]
mod tests {
    use super::super::AgentProcess;
    use super::scope::{ANSWER_LIMIT, FEEDBACK_LIMIT, KEEP_PLANNING};
    use super::*;
    use std::path::Path;
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
        Scope::new(Some(note), root, "test".into(), NoteClaims::default())
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
                files: Vec::new(),
                content: "x".repeat(8 * 1024 * 1024),
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
    async fn a_scope_without_a_note_asks_before_every_write() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "old").unwrap();
        let mut scope = Scope::new(None, root.clone(), "w".into(), NoteClaims::default());
        scope.active = true;
        let write_hook = |path: PathBuf| json!({"callback_id": HOOK_ID, "input": {"tool_name": "Write", "tool_input": {"file_path": path, "content": "new"}}});
        for reply in [
            scope.hook(&edit_hook(&root.join("a.md"))).await.unwrap(),
            scope.hook(&write_hook(root.join("a.md"))).await.unwrap(),
            scope.hook(&write_hook(root.join("new.md"))).await.unwrap(),
        ] {
            assert_eq!(reply["hookSpecificOutput"]["permissionDecision"], "ask");
        }
        let prompt = super::super::system_prompt(false, "Write");
        assert!(prompt.contains("No note is open") && prompt.contains("with Write"));
        assert!(!prompt.contains(super::super::NOTE_SCOPE));
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
            assert!(scope.decision("own-note", true, false).is_err());
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
        assert!(scope.decision("write", true, false).is_err());
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
        let mut scope = Scope::new(
            Some(root.join("a.md")),
            root.clone(),
            "a".into(),
            claims.clone(),
        );
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
        })) = scope.decision("create", true, false)
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
            scope.decision("busy", true, false).unwrap().reply()["response"]["response"]
                ["behavior"],
            "deny"
        );
        assert!(!scope.approved.contains(&root.join("b.md")));
        assert!(scope
            .permission("denied", &write(root.join("b.md")))
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            scope.decision("denied", false, false).unwrap().reply()["response"]["response"]
                ["behavior"],
            "deny"
        );
        scope.release();
        assert_eq!(claims.lock().len(), 1);
        assert!(claims.lock().contains_key(&root.join("b.md")));
    }
    #[tokio::test]
    async fn always_allowed_tools_skip_the_prompt_but_not_scope() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        for name in ["a.md", "b.md", "c.md", "d.md"] {
            std::fs::write(root.join(name), name).unwrap();
        }
        let claims = NoteClaims::default();
        let mut scope = Scope {
            always: always_allow_set(vec!["Write".into()]).unwrap(),
            ..Scope::new(
                Some(root.join("a.md")),
                root.clone(),
                "a".into(),
                claims.clone(),
            )
        };
        scope.active = true;
        let read = |path: &str| json!({"tool_name": "Read", "input": {"file_path": path}});
        let write = |path: PathBuf| json!({"tool_name": "Write", "input": {"file_path": path, "content": "new"}});

        assert!(scope
            .permission("r1", &read("/x.md"))
            .await
            .unwrap()
            .is_none());
        assert!(scope.decision("r1", true, true).is_ok());
        assert_eq!(
            scope
                .permission("r2", &read("/y.md"))
                .await
                .unwrap()
                .unwrap(),
            json!({"behavior": "allow", "updatedInput": {"file_path": "/y.md"}})
        );
        let grep = json!({"tool_name": "Grep", "input": {"pattern": "x"}});
        assert!(scope.permission("g", &grep).await.unwrap().is_none());

        let mut request = write(dir.path().join("b.md"));
        request["tool_use_id"] = json!("toolu_b");
        let reply = scope.permission("w1", &request).await.unwrap().unwrap();
        assert_eq!(reply["updatedInput"]["file_path"], json!(root.join("b.md")));
        assert!(matches!(
            scope.defer_edit("w1", &request, &reply),
            Some(AgentEvent::EditStart { path, .. }) if path == root.join("b.md")
        ));
        assert_eq!(
            claims.lock().get(&root.join("b.md")).map(String::as_str),
            Some("a")
        );

        claims.lock().insert(root.join("c.md"), "c".into());
        assert_eq!(
            scope
                .permission("w2", &write(root.join("c.md")))
                .await
                .unwrap()
                .unwrap()["behavior"],
            "deny"
        );
        assert_eq!(
            scope
                .permission("w3", &write(root.join("b.txt")))
                .await
                .unwrap()
                .unwrap()["behavior"],
            "deny"
        );
        let edit = json!({"tool_name": "Edit", "input": {"file_path": root.join("d.md")}});
        assert!(scope.permission("e", &edit).await.unwrap().is_none());

        assert!(always_allow_set(vec!["Bash".into()]).is_err());
        assert!(always_allow_set(vec!["mcp__notes__search".into(), "Read".into()]).is_ok());
    }
    #[tokio::test]
    async fn always_allow_is_saved_before_the_reply_and_a_failed_save_keeps_the_request() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        let saved = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
        let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
        let (log, failing) = (saved.clone(), fail.clone());
        let mut scope = Scope {
            remember: Some(Arc::new(move |tool| {
                if failing.load(std::sync::atomic::Ordering::SeqCst) {
                    return Err("disk full".into());
                }
                log.lock().push(tool.into());
                Ok(())
            })),
            ..Scope::new(
                Some(root.join("a.md")),
                root,
                "a".into(),
                NoteClaims::default(),
            )
        };
        scope.active = true;
        let read = json!({"tool_name": "Read", "input": {"file_path": "/x.md"}});
        assert!(scope.permission("r1", &read).await.unwrap().is_none());

        assert!(matches!(scope.decision("r1", true, true), Err(e) if e == "disk full"));
        assert!(!scope.always.contains("Read"));
        fail.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(scope.decision("r1", true, false).is_ok());
        assert!(saved.lock().is_empty());

        assert!(scope.permission("r2", &read).await.unwrap().is_none());
        assert!(scope.decision("r2", true, true).is_ok());
        assert_eq!(*saved.lock(), vec!["Read"]);
        assert!(scope.always.contains("Read"));
    }
    #[tokio::test]
    async fn attached_files_are_readable_this_turn_without_a_prompt() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let note = workspace.path().join("a.md");
        std::fs::write(&note, "a").unwrap();
        let attached = outside.path().join("diagram.png");
        let other = outside.path().join("secret.txt");
        std::fs::write(&attached, "png").unwrap();
        std::fs::write(&other, "secret").unwrap();
        let alias = outside.path().join("alias.png");
        std::os::unix::fs::symlink(&attached, &alias).unwrap();
        let read_hook = |path: &Path| json!({"callback_id": HOOK_ID, "input": {"tool_name": "Read", "tool_input": {"file_path": path}}});
        let read = |path: &Path| json!({"tool_name": "Read", "input": {"file_path": path}});

        let mut scope = test_scope(note.canonicalize().unwrap());
        scope.active = true;
        scope.attached.insert(attached.canonicalize().unwrap());
        for path in [&attached, &alias] {
            assert_eq!(
                scope.hook(&read_hook(path)).await.unwrap()["hookSpecificOutput"]
                    ["permissionDecision"],
                "allow"
            );
        }
        assert_eq!(
            scope
                .permission("attached", &read(&attached))
                .await
                .unwrap()
                .unwrap()["behavior"],
            "allow"
        );
        // Anything else still goes to the CLI's rules and the host prompt.
        assert_eq!(scope.hook(&read_hook(&other)).await.unwrap(), json!({}));
        assert!(scope
            .permission("other", &read(&other))
            .await
            .unwrap()
            .is_none());
        scope.active = false;
        assert_eq!(
            scope.hook(&read_hook(&attached)).await.unwrap()["hookSpecificOutput"]
                ["permissionDecision"],
            "deny"
        );

        let mut next = test_scope(note.canonicalize().unwrap());
        next.active = true;
        assert_eq!(next.hook(&read_hook(&attached)).await.unwrap(), json!({}));
    }
    #[tokio::test]
    async fn controls_are_native_and_permissions_are_process_local_and_single_use() {
        let mut a = test_scope("/a.md".into());
        let mut b = test_scope("/b.md".into());
        a.active = true;
        b.active = true;
        assert_eq!(
            serde_json::from_str::<Value>(&user_frame("hello")).unwrap(),
            json!({"type": "user", "message": {"role": "user", "content": "hello"}})
        );
        assert!(a
            .permission(
                "read-a",
                &json!({"tool_name": "Read", "input": {"file_path": "/context.md"}})
            )
            .await
            .unwrap()
            .is_none());
        assert!(b.decision("read-a", true, false).is_err());
        assert_eq!(
            a.decision("read-a", true, false).unwrap().reply()["response"]["response"]
                ["updatedInput"]["file_path"],
            "/context.md"
        );
        assert!(a.decision("read-a", true, false).is_err());
        a.active = false;
        assert_eq!(
            a.permission("late", &json!({"tool_name":"Read"}))
                .await
                .unwrap()
                .unwrap()["behavior"],
            "deny"
        );
    }
    #[tokio::test]
    async fn questions_need_answers_to_exactly_the_questions_asked() {
        let mut scope = test_scope("/a.md".into());
        scope.active = true;
        let questions = json!([
            {"question": "Which tone?", "header": "Tone", "multiSelect": false, "options": [{"label": "Warm", "description": ""}]},
            {"question": "Which length?", "header": "Length", "multiSelect": false, "options": [{"label": "Short", "description": ""}]}
        ]);
        let ask = json!({"tool_name": "AskUserQuestion", "input": {"questions": questions}});
        let answers = |pairs: &[(&str, &str)]| Answer::Questions {
            answers: Some(
                pairs
                    .iter()
                    .map(|(q, a)| (q.to_string(), a.to_string()))
                    .collect(),
            ),
        };
        assert!(scope.permission("ask", &ask).await.unwrap().is_none());
        assert!(scope.decision("ask", true, false).is_err());
        for wrong in [
            answers(&[("Which tone?", "Warm")]),
            answers(&[("Which tone?", "Warm"), ("Which colour?", "Red")]),
            answers(&[("Which tone?", "Warm"), ("Which length?", " ")]),
            answers(&[
                ("Which tone?", "Warm"),
                ("Which length?", &"x".repeat(ANSWER_LIMIT + 1)),
            ]),
        ] {
            assert!(scope.answer("ask", wrong).is_err());
        }
        let reply = scope
            .answer(
                "ask",
                answers(&[("Which tone?", "Warm"), ("Which length?", "A page or so")]),
            )
            .unwrap()
            .reply();
        assert_eq!(
            reply["response"]["response"],
            json!({"behavior": "allow", "updatedInput": {"questions": questions, "answers": {"Which tone?": "Warm", "Which length?": "A page or so"}}})
        );
        assert!(scope
            .answer("ask", Answer::Questions { answers: None })
            .is_err());

        assert!(scope.permission("decline", &ask).await.unwrap().is_none());
        assert_eq!(
            scope
                .answer("decline", Answer::Questions { answers: None })
                .unwrap()
                .reply()["response"]["response"],
            json!({"behavior": "deny", "message": DECLINED_QUESTIONS})
        );
        assert!(scope
            .permission(
                "read",
                &json!({"tool_name": "Read", "input": {"file_path": "/x.md"}})
            )
            .await
            .unwrap()
            .is_none());
        assert!(scope
            .answer("read", Answer::Questions { answers: None })
            .is_err());
        let empty = json!({"tool_name": "AskUserQuestion", "input": {"questions": []}});
        assert_eq!(
            scope.permission("empty", &empty).await.unwrap().unwrap()["behavior"],
            "deny"
        );
        assert!(always_allow_set(vec!["AskUserQuestion".into()]).is_err());
        scope.active = false;
        assert_eq!(
            scope.permission("late", &ask).await.unwrap().unwrap()["behavior"],
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
            Some("opus"),
            false,
            true,
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
                "Read,Glob,Grep,Edit,Write,WebSearch,WebFetch,ToolSearch,WaitForMcpServers,AskUserQuestion,ExitPlanMode",
            ],
            ["--permission-mode", "manual"],
            ["--permission-prompts", "host"],
            ["--permission-prompt-tool", "stdio"],
            ["--resume", "session"],
            ["--model", "opus"],
        ] {
            assert!(args.windows(2).any(|args| args == pair));
        }
        assert!(args
            .windows(3)
            .any(|args| args == ["--allowedTools", "Edit", "Write"]));
        assert!(args
            .windows(2)
            .any(|args| args[0] == "--append-system-prompt"
                && args[1].contains(crate::embed_protocol::EMBED_AUTHORING_GUIDE)));
        assert_eq!(
            command.as_std().get_current_dir().unwrap(),
            std::path::Path::new("/vault")
        );
        let planning = scoped_command(
            "/claude".into(),
            "/bin".into(),
            std::path::Path::new("/vault"),
            None,
            None,
            true,
            true,
        );
        let planning_args: Vec<_> = planning
            .as_std()
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert!(planning_args
            .windows(2)
            .any(|args| args == ["--permission-mode", "plan"]));
        assert!(!planning_args.contains(&"--model"));
    }
    #[test]
    fn model_setting_keeps_the_cli_default_unless_an_alias_is_chosen() {
        let dir = tempfile::tempdir().unwrap();
        let mut settings = crate::config::Settings::new(dir.path().to_path_buf()).unwrap();
        assert_eq!(configured_model(&settings).unwrap(), None);
        settings
            .set_global(
                MODEL_SETTING,
                crate::config::ConfigValue::String("sonnet".into()),
            )
            .unwrap();
        assert_eq!(
            configured_model(&settings).unwrap().as_deref(),
            Some("sonnet")
        );
        settings
            .set_global(
                MODEL_SETTING,
                crate::config::ConfigValue::String("--debug".into()),
            )
            .unwrap();
        assert!(configured_model(&settings).is_err());
    }
    #[tokio::test]
    async fn plan_mode_blocks_note_edits_until_the_user_approves_the_plan() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let note = root.join("a.md");
        std::fs::write(&note, "old").unwrap();
        let plans = root.join(".claude/plans");
        let mut scope = Scope {
            planning: true,
            plans: Some(plans.clone()),
            ..test_scope(note.clone())
        };
        scope.active = true;
        let decision = |reply: Value| reply["hookSpecificOutput"]["permissionDecision"].clone();
        let write_hook = |path: &std::path::Path| json!({"callback_id": HOOK_ID, "input": {"tool_name": "Write", "tool_input": {"file_path": path, "content": "plan"}}});
        assert_eq!(
            decision(scope.hook(&edit_hook(&note)).await.unwrap()),
            "deny"
        );
        assert_eq!(
            decision(scope.hook(&write_hook(&root.join("b.md"))).await.unwrap()),
            "deny"
        );
        let own = json!({"tool_name": "Edit", "input": {"file_path": note, "old_string": "old", "new_string": "new"}});
        assert_eq!(
            scope.permission("own", &own).await.unwrap().unwrap()["message"],
            PLANNING
        );
        // Claude Code writes its plan file itself; it is neither a note nor held for the UI.
        let plan_file = plans.join("calm-otter.md");
        let hook = write_hook(&plan_file);
        let reply = scope.hook(&hook).await.unwrap();
        assert_eq!(reply, json!({}));
        let request =
            json!({"tool_name": "Write", "input": {"file_path": plan_file, "content": "plan"}});
        let reply = scope
            .permission("plan-file", &request)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply["behavior"], "allow");
        assert!(scope.defer_edit("plan-file", &request, &reply).is_none());
        for path in [plans.join("nested/x.md"), plans.join("x.txt")] {
            assert_eq!(
                decision(scope.hook(&write_hook(&path)).await.unwrap()),
                "deny"
            );
        }

        let exit = json!({"tool_name": "ExitPlanMode", "input": {"plan": "# Plan", "planFilePath": plan_file}});
        let plan = |approve, feedback: Option<&str>| Answer::Plan {
            approve,
            feedback: feedback.map(String::from),
        };
        assert!(scope.permission("exit", &exit).await.unwrap().is_none());
        assert!(scope.decision("exit", true, false).is_err());
        assert!(scope
            .answer("exit", Answer::Questions { answers: None })
            .is_err());
        assert!(scope
            .answer("exit", plan(false, Some(&"x".repeat(FEEDBACK_LIMIT + 1))))
            .is_err());
        assert_eq!(
            scope
                .answer("exit", plan(false, Some("  Make it a poem. ")))
                .unwrap()
                .reply()["response"]["response"],
            json!({"behavior": "deny", "message": format!("{KEEP_PLANNING} Their feedback: Make it a poem.")})
        );
        assert!(scope.planning);
        assert!(scope.permission("exit-2", &exit).await.unwrap().is_none());
        assert_eq!(
            scope.answer("exit-2", plan(true, None)).unwrap().reply()["response"]["response"],
            json!({"behavior": "allow", "updatedInput": exit["input"]})
        );
        assert!(!scope.planning);
        assert_eq!(
            decision(scope.hook(&edit_hook(&note)).await.unwrap()),
            "allow"
        );
        assert_eq!(
            scope.permission("late-exit", &exit).await.unwrap().unwrap()["behavior"],
            "deny"
        );
        assert!(always_allow_set(vec!["ExitPlanMode".into()]).is_err());
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
            assert!(other.decision("allow", true, false).is_err());
            let reply = scope.decision("allow", true, false).unwrap().reply();
            assert_eq!(reply["response"]["response"]["behavior"], "allow");
            assert_eq!(reply["response"]["response"]["updatedInput"], input);
            assert!(scope.decision("allow", true, false).is_err());
            assert!(scope.permission("deny", &request).await.unwrap().is_none());
            assert_eq!(
                scope.decision("deny", false, false).unwrap().reply()["response"]["response"]
                    ["behavior"],
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
            assert!(scope.decision("unsupported", true, false).is_err());
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
                files: Vec::new(),
                content: "use MCP".into(),
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
                    answer: Answer::Tool {
                        allow,
                        always: false,
                    },
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
                files: Vec::new(),
                content: "edit".into(),
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
                    files: Vec::new(),
                    content: "edit".into(),
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
                    files: Vec::new(),
                    content: "edit".into(),
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
    /// Explicit manual integration check: attached files outside the workspace
    /// are read without a host prompt, whatever their type.
    #[tokio::test]
    #[ignore = "requires terminal Claude Code sign-in and network"]
    async fn real_cli_reads_attached_files() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let generated = std::process::Command::new("/usr/bin/python3")
            .arg(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/attachments.py"
            ))
            .arg(outside.path())
            .status()
            .unwrap();
        assert!(generated.success());
        let note = workspace.path().join("note.md");
        std::fs::write(&note, "Draft").unwrap();
        let note = note.canonicalize().unwrap();
        let files: Vec<PathBuf> = ["swatch.png", "brief.pdf", "fruit.csv"]
            .iter()
            .map(|name| outside.path().join(name).canonicalize().unwrap())
            .collect();
        let (binary, path) = resolve_claude_env().await.unwrap();
        let child = scoped_command(binary, path, workspace.path(), None, None, false, true)
            .spawn()
            .unwrap();
        let (input, rx) = mpsc::channel(4);
        let (_cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let (ready, initialized) = oneshot::channel();
        let frames = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let capture = frames.clone();
        let decisions = input.clone();
        let events = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                let event: Value = serde_json::from_str(&body).unwrap();
                if let Some(line) = event["line"].as_str() {
                    let value: Value = serde_json::from_str(line).unwrap();
                    if value["type"] == "control_request" {
                        let id = value["request_id"].as_str().unwrap().to_string();
                        let tx = decisions.clone();
                        tokio::spawn(async move {
                            let (ack, reply) = oneshot::channel();
                            let _ = tx
                                .send(Input::Permission {
                                    request_id: id,
                                    answer: Answer::Tool {
                                        allow: false,
                                        always: false,
                                    },
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
            Some(test_scope(note.clone())),
            Some(ready),
        ));
        initialized.await.unwrap().unwrap();
        let context = json!({"openFile": note, "attachments": [], "files": files});
        let prompt = format!("<writer_context>{context}</writer_context>\n\nAnswer in one line, without editing anything: the colour of the image, the codename in the PDF, and the fruit in the CSV.");
        let (ack, sent) = oneshot::channel();
        input
            .send(Input::User {
                content: prompt.clone(),
                files: files.clone(),
                ack,
            })
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(120), async {
            while !*done.borrow_and_update() {
                done.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        task.await.unwrap();
        let frames = frames.lock().unwrap();
        let prompts: Vec<_> = frames
            .iter()
            .filter(|v| v["type"] == "control_request")
            .collect();
        assert!(prompts.is_empty(), "Attached reads prompted: {prompts:?}");
        let answer = frames
            .iter()
            .find(|v| v["type"] == "result")
            .and_then(|v| v["result"].as_str())
            .unwrap_or_default()
            .to_lowercase();
        println!("Claude answered: {answer}");
        for expected in ["red", "pineapple-42", "mango"] {
            assert!(answer.contains(expected), "Missing {expected}: {answer}");
        }
    }
    #[tokio::test]
    #[ignore = "requires terminal Claude Code sign-in and network"]
    async fn real_cli_plan_mode_asks_plans_and_edits_after_approval() {
        let workspace = tempfile::tempdir().unwrap();
        let note = workspace.path().join("trip.md");
        std::fs::write(
            &note,
            "# Trip\n\nWe went to Riga. It rained. We ate soup.\n",
        )
        .unwrap();
        let note = note.canonicalize().unwrap();
        let original = std::fs::read_to_string(&note).unwrap();
        let (binary, path) = resolve_claude_env().await.unwrap();
        let child = scoped_command(binary, path, workspace.path(), None, None, true, true)
            .spawn()
            .unwrap();
        let (input, rx) = mpsc::channel(4);
        let (_cancel, cancel_rx) = watch::channel(false);
        let (finished, mut done) = watch::channel(false);
        let (ready, initialized) = oneshot::channel();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let capture = seen.clone();
        let replies = input.clone();
        let watched = note.clone();
        let unchanged = original.clone();
        let events = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(body) = body else {
                return Ok(());
            };
            let event: Value = serde_json::from_str(&body).unwrap();
            let tx = replies.clone();
            if event["type"] == "edit_start" {
                let request_id = event["requestId"].as_str().unwrap().to_string();
                capture.lock().unwrap().push("edit".into());
                tokio::spawn(async move {
                    let (ack, _) = oneshot::channel();
                    let _ = tx
                        .send(Input::EditReady {
                            request_id,
                            allow: true,
                            ack,
                        })
                        .await;
                });
                return Ok(());
            }
            let Some(line) = event["line"].as_str() else {
                return Ok(());
            };
            let value: Value = serde_json::from_str(line).unwrap();
            if value["type"] != "control_request" {
                return Ok(());
            }
            let request = &value["request"];
            let tool = request["tool_name"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let answer = match tool.as_str() {
                "AskUserQuestion" => Answer::Questions {
                    answers: Some(
                        request["input"]["questions"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|q| {
                                let label = q["options"][0]["label"].as_str().unwrap_or("Any");
                                (
                                    q["question"].as_str().unwrap().to_string(),
                                    label.to_string(),
                                )
                            })
                            .collect(),
                    ),
                },
                "ExitPlanMode" => {
                    assert!(request["input"]["plan"]
                        .as_str()
                        .is_some_and(|p| !p.is_empty()));
                    assert_eq!(std::fs::read_to_string(&watched).unwrap(), unchanged);
                    Answer::Plan {
                        approve: true,
                        feedback: None,
                    }
                }
                _ => Answer::Tool {
                    allow: false,
                    always: false,
                },
            };
            capture.lock().unwrap().push(tool);
            let request_id = value["request_id"].as_str().unwrap().to_string();
            tokio::spawn(async move {
                let (ack, _) = oneshot::channel();
                let _ = tx
                    .send(Input::Permission {
                        request_id,
                        answer,
                        ack,
                    })
                    .await;
            });
            Ok(())
        });
        let task = tokio::spawn(run_process(
            child,
            rx,
            cancel_rx,
            finished,
            events,
            Some(Scope {
                planning: true,
                plans: plans_dir(),
                ..test_scope(note.clone())
            }),
            Some(ready),
        ));
        initialized.await.unwrap().unwrap();
        let context = json!({"openFile": note, "attachments": []});
        let prompt = format!("<writer_context>{context}</writer_context>\n\nTurn this note into a short story with sections. First ask me one question about the tone with AskUserQuestion, then plan it and present the plan for approval.");
        let (ack, sent) = oneshot::channel();
        input
            .send(Input::User {
                content: prompt.clone(),
                files: Vec::new(),
                ack,
            })
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(240), async {
            while !*done.borrow_and_update() {
                done.changed().await.unwrap();
            }
        })
        .await
        .unwrap();
        task.await.unwrap();
        let seen = seen.lock().unwrap();
        println!("Host requests: {seen:?}");
        let exit = seen.iter().position(|tool| tool == "ExitPlanMode");
        assert!(exit.is_some(), "Claude never presented a plan: {seen:?}");
        assert!(seen.iter().any(|tool| tool == "AskUserQuestion"));
        assert!(seen[exit.unwrap()..].iter().any(|tool| tool == "edit"));
        assert_ne!(std::fs::read_to_string(&note).unwrap(), original);
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
            let child = scoped_command(
                binary.clone(),
                path.clone(),
                dir.path(),
                None,
                None,
                false,
                true,
            )
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
                                        answer: Answer::Tool {
                                            allow,
                                            always: false,
                                        },
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
                    files: Vec::new(),
                    content: prompt.clone(),
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
