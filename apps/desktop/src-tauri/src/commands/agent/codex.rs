//! Runs Co-writer on the user's Codex CLI through `codex app-server`, which
//! speaks JSON-RPC over stdio. Native code answers every server request, so
//! the UI only ever answers the prompts forwarded to it as `writer/request`.
use super::claude::kill_group;
use super::scope::{self, Remember, Target};
use super::{allowed_tools, cli_env, AgentEvent, Answer, Input, NoteClaims};
use crate::{error::AppError, state::AppState};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, OnceLock},
    time::Duration,
};
use tauri::{ipc::Channel, Manager, State, WebviewWindow};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, watch},
};

static CODEX_ENV: OnceLock<(PathBuf, String)> = OnceLock::new();
const CODEX_CLI: cli_env::Cli = cli_env::Cli {
    binary: "codex",
    name: "Codex",
    min_version: &[0, 162, 1],
    update_hint: "Update Codex in your terminal.",
    cache: &CODEX_ENV,
};

pub(super) async fn resolve_codex_env() -> Result<(PathBuf, String), AppError> {
    cli_env::resolve(&CODEX_CLI).await
}

const WRITE_TIMEOUT: Duration = Duration::from_secs(3);
// Startup connects the user's MCP servers before the thread is ready.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);
const MODEL_SETTING: &str = "co-writer.codex-model";
/// Codex's built-in read-only profile; managed configs can't widen it per thread.
const READ_ONLY: &str = ":read-only";
const CODEX_RULES: &str = "Edit files only with apply_patch, one file per patch, and never move, rename or delete files; Co-writer reviews each patch before it applies. Shell commands run read-only, so never use them to write files.";
const IMPLEMENT: &str = "The user approved the plan. Implement it now.";
const SANDBOX_REFUSED: &str = "Codex didn't start in its read-only sandbox, so Co-writer stopped it. Check the permission settings in your Codex config.";
/// Notifications the UI renders; the rest, like command output deltas, stay native.
const FORWARDED: &[&str] = &[
    "turn/started",
    "turn/completed",
    "item/started",
    "item/completed",
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
];

pub(super) fn app_server_command(binary: PathBuf, path: String, root: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(root)
        .env("PATH", path)
        .args(["app-server", "-c", "web_search=\"live\""])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    command
}

/// The model id to request, or `None` to keep the CLI's configured model.
fn configured_model(settings: &crate::config::Settings) -> Result<Option<String>, AppError> {
    let model = settings
        .get_global_or_default(MODEL_SETTING)
        .and_then(crate::config::ConfigValue::as_str)
        .ok_or_else(|| AppError::Io(format!("Setting {MODEL_SETTING} must be a string")))?;
    Ok((model != "default").then(|| model.to_string()))
}

fn developer_instructions(has_note: bool) -> String {
    format!(
        "{} {CODEX_RULES}",
        super::system_prompt(has_note, "apply_patch")
    )
}

pub(super) fn initialize_params() -> Value {
    json!({
        "clientInfo": {"name": "co-writer", "title": "Co-writer", "version": env!("CARGO_PKG_VERSION")},
        "capabilities": {"experimentalApi": true, "requestAttestation": false},
    })
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().to_string()
}

fn reply(rpc: &Value, result: Value) -> Value {
    json!({"id": rpc, "result": result})
}

fn decision(rpc: &Value, decision: &str) -> Value {
    reply(rpc, json!({ "decision": decision }))
}

fn request_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// The `/name` a message starts with, the way the UI sends a skill.
fn skill_name(text: &str) -> Option<&str> {
    text.strip_prefix('/')?
        .split_whitespace()
        .next()
        .filter(|name| !name.is_empty())
}

enum Call {
    Initialize,
    Skills,
    Models,
    Thread,
    Turn,
}

enum Pending {
    /// A patch to another note, waiting for the user's approval.
    Approval {
        rpc: Value,
        tool: &'static str,
        path: PathBuf,
        item: String,
    },
    /// An allowed patch, waiting until the UI has saved and locked the note.
    Edit {
        rpc: Value,
    },
    Mcp {
        rpc: Value,
        tool: String,
    },
    Questions {
        rpc: Value,
        /// Question text to Codex's question id.
        ids: BTreeMap<String, String>,
        input: Value,
    },
    /// A finished plan-mode turn, held until the user approves its plan.
    Plan,
}

struct Thread {
    id: String,
    model: Value,
    effort: Value,
}

/// What one message or input makes the actor do.
#[derive(Default)]
struct Step {
    writes: Vec<Value>,
    events: Vec<AgentEvent>,
    /// The turn is over, so the process is reaped.
    done: bool,
}
impl Step {
    fn line(&mut self, value: Value) {
        self.events.push(AgentEvent::Line {
            line: value.to_string(),
        });
    }
    fn notice(&mut self, message: String) {
        self.events.push(AgentEvent::Stderr { message });
    }
}

struct Codex {
    /// The folder Codex runs in, as the UI named it.
    cwd: PathBuf,
    root: PathBuf,
    note: Option<PathBuf>,
    owner: String,
    claims: NoteClaims,
    approved: HashSet<PathBuf>,
    always: HashSet<String>,
    remember: Option<Remember>,
    resume: Option<String>,
    model: Option<String>,
    planning: bool,
    next_id: u64,
    calls: HashMap<u64, Call>,
    skills: HashMap<String, String>,
    thread: Option<Thread>,
    sent: bool,
    active: bool,
    plan: Option<String>,
    plans: u32,
    /// Patch changes by item id, from `item/started`, for the approval that follows.
    changes: HashMap<String, Value>,
    /// Running MCP calls by item id, as (server, tool).
    mcp_calls: HashMap<String, (String, String)>,
    pending: HashMap<String, Pending>,
}

impl Codex {
    fn new(
        cwd: PathBuf,
        root: PathBuf,
        note: Option<PathBuf>,
        owner: String,
        claims: NoteClaims,
    ) -> Self {
        Self {
            cwd,
            root,
            note,
            owner,
            claims,
            approved: HashSet::new(),
            always: HashSet::new(),
            remember: None,
            resume: None,
            model: None,
            planning: false,
            next_id: 0,
            calls: HashMap::new(),
            skills: HashMap::new(),
            thread: None,
            sent: false,
            active: false,
            plan: None,
            plans: 0,
            changes: HashMap::new(),
            mcp_calls: HashMap::new(),
            pending: HashMap::new(),
        }
    }

    fn ready(&self) -> bool {
        self.thread.is_some()
    }

    fn call(&mut self, step: &mut Step, method: &str, params: Value, call: Call) {
        self.next_id += 1;
        self.calls.insert(self.next_id, call);
        step.writes
            .push(json!({"id": self.next_id, "method": method, "params": params}));
    }

    fn start(&mut self) -> Step {
        let mut step = Step::default();
        self.call(
            &mut step,
            "initialize",
            initialize_params(),
            Call::Initialize,
        );
        step
    }

    fn after_skills(&mut self, step: &mut Step) {
        if self.model.is_some() {
            self.call(step, "model/list", json!({}), Call::Models);
        } else {
            self.open_thread(step);
        }
    }

    fn open_thread(&mut self, step: &mut Step) {
        let mut params = json!({
            "cwd": self.cwd,
            "permissions": READ_ONLY,
            "approvalPolicy": "on-request",
            "developerInstructions": developer_instructions(self.note.is_some()),
        });
        if let Some(model) = &self.model {
            params["model"] = json!(model);
        }
        if let Some(thread) = &self.resume {
            params["threadId"] = json!(thread);
            params["excludeTurns"] = json!(true);
            self.call(step, "thread/resume", params, Call::Thread);
        } else {
            params["experimentalRawEvents"] = json!(false);
            params["persistExtendedHistory"] = json!(false);
            self.call(step, "thread/start", params, Call::Thread);
        }
    }

    fn turn(&mut self, step: &mut Step, text: &str) -> Result<(), String> {
        let thread = self
            .thread
            .as_ref()
            .ok_or("Codex hasn't started a thread")?;
        let mut input = vec![json!({"type": "text", "text": text, "text_elements": []})];
        if let Some((name, path)) =
            skill_name(text).and_then(|name| Some((name, self.skills.get(name)?)))
        {
            input.push(json!({"type": "skill", "name": name, "path": path}));
        }
        let mode = if self.planning { "plan" } else { "default" };
        // Sent every turn: a resumed thread may still be in the mode it last ran in.
        let params = json!({
            "threadId": thread.id,
            "input": input,
            "collaborationMode": {"mode": mode, "settings": {"model": thread.model, "reasoning_effort": thread.effort, "developer_instructions": null}},
        });
        self.plan = None;
        self.call(step, "turn/start", params, Call::Turn);
        Ok(())
    }

    fn user(&mut self, content: &str) -> Result<Step, String> {
        if !self.ready() || self.sent {
            return Err("This note process cannot accept another turn".into());
        }
        let mut step = Step::default();
        self.turn(&mut step, content)?;
        self.sent = true;
        self.active = true;
        Ok(step)
    }

    async fn message(&mut self, line: &str) -> Result<Step, String> {
        let value: Value =
            serde_json::from_str(line).map_err(|e| format!("Invalid Codex stream: {e}"))?;
        match (value["method"].as_str(), value.get("id")) {
            (Some(method), Some(rpc)) => self.request(method, rpc, &value["params"]).await,
            (Some(method), None) => Ok(self.notification(method, &value, line)),
            (None, Some(_)) => self.response(&value),
            (None, None) => Err("Codex sent a message Co-writer can't read".into()),
        }
    }

    fn response(&mut self, value: &Value) -> Result<Step, String> {
        let call = value["id"]
            .as_u64()
            .and_then(|id| self.calls.remove(&id))
            .ok_or("Codex answered a request Co-writer didn't send")?;
        let mut step = Step::default();
        if let Some(error) = value.get("error") {
            let message = error["message"]
                .as_str()
                .unwrap_or("Codex rejected a request")
                .to_string();
            let Call::Skills = call else {
                return Err(message);
            };
            // Skills only add `/name` shortcuts, so a turn can run without them.
            step.notice(format!("Codex couldn't list its skills: {message}"));
            self.after_skills(&mut step);
            return Ok(step);
        }
        let result = &value["result"];
        match call {
            Call::Initialize => {
                step.writes.push(json!({"method": "initialized"}));
                let params = json!({"cwds": [self.cwd]});
                self.call(&mut step, "skills/list", params, Call::Skills);
            }
            Call::Skills => {
                self.skills = parse_skills(result)
                    .into_iter()
                    .map(|skill| (skill.name, skill.path))
                    .collect();
                self.after_skills(&mut step);
            }
            Call::Models => {
                let model = self.model.as_deref().unwrap_or_default();
                if !parse_models(result).iter().any(|known| known.id == model) {
                    return Err(format!(
                        "Unknown Codex model \"{model}\". Choose one in Settings → Co-writer."
                    ));
                }
                self.open_thread(&mut step);
            }
            Call::Thread => {
                if result["sandbox"]["type"] != "readOnly" {
                    return Err(SANDBOX_REFUSED.into());
                }
                let id = result["thread"]["id"]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Codex started a thread without an ID")?;
                self.thread = Some(Thread {
                    id: id.into(),
                    model: result["model"].clone(),
                    effort: result["reasoningEffort"].clone(),
                });
                step.line(json!({"method": "writer/thread", "params": {"threadId": id}}));
            }
            Call::Turn => {}
        }
        Ok(step)
    }

    fn notification(&mut self, method: &str, value: &Value, line: &str) -> Step {
        let mut step = Step::default();
        let params = &value["params"];
        // Sub-agents run in threads of their own; only this thread's turn is shown.
        let own = self
            .thread
            .as_ref()
            .is_some_and(|thread| params["threadId"] == thread.id.as_str());
        let item = &params["item"];
        let id = item["id"].as_str().unwrap_or_default();
        match method {
            "item/started" => match item["type"].as_str() {
                Some("fileChange") => {
                    self.changes.insert(id.into(), item["changes"].clone());
                }
                Some("mcpToolCall") => {
                    self.mcp_calls
                        .insert(id.into(), (text(&item["server"]), text(&item["tool"])));
                }
                _ => {}
            },
            "item/completed" => {
                self.changes.remove(id);
                self.mcp_calls.remove(id);
                if own && self.planning && item["type"] == "plan" {
                    self.plan = item["text"]
                        .as_str()
                        .filter(|plan| !plan.trim().is_empty())
                        .map(String::from);
                }
            }
            "serverRequest/resolved" => {
                // Codex withdrew a request it had asked, such as when the turn ended.
                if let Some(key) = request_key(&params["requestId"]) {
                    if self.pending.remove(&key).is_some() {
                        step.line(json!({"method": "writer/cancel", "params": {"requestId": key}}));
                    }
                }
            }
            "turn/completed" if own => {
                let plan = (self.planning && params["turn"]["status"] == "completed")
                    .then(|| self.plan.take())
                    .flatten();
                if let Some(plan) = plan {
                    self.plans += 1;
                    let key = format!("writer-plan-{}", self.plans);
                    self.pending.insert(key.clone(), Pending::Plan);
                    step.line(json!({"method": "writer/request", "params": {"requestId": key, "tool": "ExitPlanMode", "input": {"plan": plan}}}));
                    return step;
                }
                self.active = false;
                self.pending.clear();
                step.done = true;
            }
            "configWarning" => {
                let details = text(&params["details"]);
                let summary = text(&params["summary"]);
                step.notice(if details.is_empty() {
                    summary
                } else {
                    format!("{summary} {details}")
                });
            }
            "warning" => step.notice(text(&params["message"])),
            _ => {}
        }
        if own && FORWARDED.contains(&method) {
            step.events.push(AgentEvent::Line { line: line.into() });
        }
        step
    }

    async fn request(&mut self, method: &str, rpc: &Value, params: &Value) -> Result<Step, String> {
        let key = request_key(rpc).ok_or("Codex sent a request without an ID")?;
        if self.pending.contains_key(&key) {
            return Err("Codex reused a pending request ID".into());
        }
        let mut step = Step::default();
        match method {
            "item/fileChange/requestApproval" => self.patch(&mut step, key, rpc, params).await?,
            // The read-only sandbox is the shell's whole scope.
            "item/commandExecution/requestApproval" => step.writes.push(decision(rpc, "decline")),
            "item/permissions/requestApproval" => step
                .writes
                .push(reply(rpc, json!({"permissions": {}, "scope": "turn"}))),
            "mcpServer/elicitation/request" => self.mcp(&mut step, key, rpc, params),
            "item/tool/requestUserInput" => self.questions(&mut step, key, rpc, params),
            _ => step.writes.push(json!({"id": rpc, "error": {"code": -32601, "message": format!("Co-writer doesn't support {method}")}})),
        }
        Ok(step)
    }

    /// Allows a one-file patch to the chat's note or an approved note, asks about other
    /// workspace notes and declines the rest, since a decline is all Codex can be told.
    async fn patch(
        &mut self,
        step: &mut Step,
        key: String,
        rpc: &Value,
        params: &Value,
    ) -> Result<(), String> {
        let item = text(&params["itemId"]);
        let changes = self
            .changes
            .get(&item)
            .and_then(Value::as_array)
            .filter(|changes| changes.len() == 1);
        let change = match changes {
            Some(changes) if self.active && !self.planning && params["grantRoot"].is_null() => {
                &changes[0]
            }
            _ => {
                step.writes.push(decision(rpc, "decline"));
                return Ok(());
            }
        };
        let creates = match (
            change["kind"]["type"].as_str(),
            &change["kind"]["move_path"],
        ) {
            (Some("add"), _) => true,
            (Some("update"), Value::Null) => false,
            _ => {
                step.writes.push(decision(rpc, "decline"));
                return Ok(());
            }
        };
        let path = self.cwd.join(text(&change["path"]));
        let target = match scope::resolve(path).await? {
            Ok((canonical, exists)) => scope::classify(
                self.note.as_deref(),
                &self.approved,
                &self.root,
                canonical,
                exists,
                (!creates).then_some("That note doesn't exist."),
            ),
            Err(reason) => Target::Denied(reason),
        };
        let tool = if creates { "Write" } else { "Edit" };
        match target {
            Target::Allowed(path) => self.hold(step, key, rpc.clone(), item, path),
            Target::NeedsApproval { path, .. } if self.always.contains(tool) => {
                if self.claim(&path) {
                    self.hold(step, key, rpc.clone(), item, path);
                } else {
                    step.writes.push(decision(rpc, "decline"));
                }
            }
            Target::NeedsApproval { path, exists } => {
                step.line(json!({"method": "writer/request", "params": {"requestId": key, "tool": tool, "input": {"file_path": path}, "target": {"path": path, "exists": exists}}}));
                self.pending.insert(
                    key,
                    Pending::Approval {
                        rpc: rpc.clone(),
                        tool,
                        path,
                        item,
                    },
                );
            }
            Target::PlanFile | Target::Denied(_) => step.writes.push(decision(rpc, "decline")),
        }
        Ok(())
    }

    fn hold(&mut self, step: &mut Step, key: String, rpc: Value, item: String, path: PathBuf) {
        step.events.push(AgentEvent::EditStart {
            request_id: key.clone(),
            tool_use_id: Some(item),
            path,
        });
        self.pending.insert(key, Pending::Edit { rpc });
    }

    fn claim(&mut self, path: &Path) -> bool {
        if !scope::claim(&self.claims, &self.owner, path) {
            return false;
        }
        self.approved.insert(path.to_path_buf());
        true
    }

    /// MCP tools are named `mcp__server__tool`, as for Claude, so one saved list serves both.
    fn mcp(&mut self, step: &mut Step, key: String, rpc: &Value, params: &Value) {
        let decline = reply(
            rpc,
            json!({"action": "decline", "content": null, "_meta": null}),
        );
        let server = text(&params["serverName"]);
        // The request doesn't name its call, so it must match the server's only running tool.
        let tools: HashSet<&str> = self
            .mcp_calls
            .values()
            .filter(|(name, _)| *name == server)
            .map(|(_, tool)| tool.as_str())
            .collect();
        let tool = match (params["_meta"]["codex_approval_kind"].as_str(), tools.len()) {
            (Some("mcp_tool_call"), 1) if self.active => {
                format!(
                    "mcp__{server}__{}",
                    tools.into_iter().next().unwrap_or_default()
                )
            }
            _ => return step.writes.push(decline),
        };
        if self.always.contains(&tool) {
            return step.writes.push(reply(
                rpc,
                json!({"action": "accept", "content": {}, "_meta": null}),
            ));
        }
        let meta = &params["_meta"];
        let input = if meta["tool_params"].is_object() {
            meta["tool_params"].clone()
        } else {
            json!({})
        };
        step.line(json!({"method": "writer/request", "params": {"requestId": key, "tool": tool, "input": input, "description": meta["tool_description"]}}));
        self.pending.insert(
            key,
            Pending::Mcp {
                rpc: rpc.clone(),
                tool,
            },
        );
    }

    fn questions(&mut self, step: &mut Step, key: String, rpc: &Value, params: &Value) {
        let asked = params["questions"].as_array().cloned().unwrap_or_default();
        let ids: BTreeMap<String, String> = asked
            .iter()
            .map(|question| (text(&question["question"]), text(&question["id"])))
            .collect();
        let input = json!({"questions": asked.iter().map(|question| json!({
            "question": question["question"],
            "header": question["header"],
            "options": question["options"].as_array().cloned().unwrap_or_default(),
            "multiSelect": false,
        })).collect::<Vec<_>>()});
        let readable = self.active
            && ids.len() == asked.len()
            && ids.values().all(|id| !id.is_empty())
            && scope::question_texts(&input).is_ok();
        if !readable {
            return step.writes.push(reply(rpc, json!({"answers": {}})));
        }
        step.line(json!({"method": "writer/request", "params": {"requestId": key, "tool": "AskUserQuestion", "input": input}}));
        self.pending.insert(
            key,
            Pending::Questions {
                rpc: rpc.clone(),
                ids,
                input,
            },
        );
    }

    fn answer(&mut self, key: &str, answer: Answer) -> Result<Step, String> {
        if !self.active {
            return Err("No active Co-writer turn".into());
        }
        let pending = self
            .pending
            .get(key)
            .ok_or("Tool request is no longer pending")?;
        let mut step = Step::default();
        match (pending, answer) {
            (Pending::Approval { .. } | Pending::Mcp { .. }, Answer::Tool { allow, always }) => {
                let tool = match pending {
                    Pending::Approval { tool, .. } => tool.to_string(),
                    Pending::Mcp { tool, .. } => tool.clone(),
                    _ => unreachable!("matched above"),
                };
                // A failed save leaves the request pending, so the user can retry or allow once.
                if let (true, true, Some(remember)) = (allow, always, &self.remember) {
                    remember(&tool)?;
                }
                if allow && always {
                    self.always.insert(tool);
                }
                match self.pending.remove(key) {
                    Some(Pending::Approval {
                        rpc, path, item, ..
                    }) => {
                        if allow && self.claim(&path) {
                            self.hold(&mut step, key.into(), rpc, item, path);
                        } else {
                            step.writes.push(decision(&rpc, "decline"));
                        }
                    }
                    Some(Pending::Mcp { rpc, .. }) => {
                        let action = if allow { "accept" } else { "decline" };
                        let content = if allow { json!({}) } else { Value::Null };
                        step.writes.push(reply(
                            &rpc,
                            json!({"action": action, "content": content, "_meta": null}),
                        ));
                    }
                    _ => unreachable!("matched above"),
                }
            }
            (Pending::Questions { input, .. }, Answer::Questions { answers }) => {
                if let Some(answers) = &answers {
                    scope::checked_answers(input, answers)?;
                }
                let Some(Pending::Questions { rpc, ids, .. }) = self.pending.remove(key) else {
                    unreachable!("matched above");
                };
                let replies: BTreeMap<&String, Value> = answers
                    .iter()
                    .flatten()
                    .filter_map(|(question, answer)| {
                        Some((ids.get(question)?, json!({"answers": [answer]})))
                    })
                    .collect();
                step.writes.push(reply(&rpc, json!({ "answers": replies })));
                step.line(json!({"method": "writer/resolved", "params": {"requestId": key, "error": answers.is_none(), "answers": answers}}));
            }
            (Pending::Plan, Answer::Plan { approve, feedback }) => {
                let message = scope::keep_planning(feedback.as_deref())?;
                self.pending.remove(key);
                step.line(json!({"method": "writer/resolved", "params": {"requestId": key, "error": !approve}}));
                if approve {
                    self.planning = false;
                    self.turn(&mut step, IMPLEMENT)?;
                } else {
                    self.turn(&mut step, &message)?;
                }
            }
            (Pending::Questions { .. } | Pending::Plan, Answer::Tool { .. }) => {
                return Err("This request needs an answer, not an approval".into())
            }
            _ => return Err("That answer doesn't fit this request".into()),
        }
        Ok(step)
    }

    fn edit_ready(&mut self, key: &str, allow: bool) -> Result<Step, String> {
        let Some(Pending::Edit { .. }) = self.pending.get(key) else {
            return Err("Edit request is no longer pending".into());
        };
        let Some(Pending::Edit { rpc }) = self.pending.remove(key) else {
            unreachable!("checked above");
        };
        let mut step = Step::default();
        step.writes
            .push(decision(&rpc, if allow { "accept" } else { "decline" }));
        Ok(step)
    }

    fn release(&self) {
        scope::release(&self.claims, &self.owner);
    }
}

async fn write(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let bytes = format!("{value}\n");
    tokio::time::timeout(WRITE_TIMEOUT, stdin.write_all(bytes.as_bytes()))
        .await
        .map_err(|_| "Timed out writing to Codex".to_string())?
        .map_err(|e| e.to_string())
}

/// Writes the step's messages and sends its events; `Err` ends the process.
async fn apply(
    step: Step,
    stdin: &mut ChildStdin,
    events: &Channel<AgentEvent>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<bool, String> {
    for event in step.events {
        events
            .send(event)
            .map_err(|_| "Co-writer's event channel closed".to_string())?;
    }
    for value in &step.writes {
        if *cancel.borrow() {
            return Err("Codex stopped".into());
        }
        tokio::select! {
            biased;
            _ = cancel.changed() => return Err("Codex stopped".into()),
            result = write(stdin, value) => result?,
        }
    }
    Ok(step.done)
}

async fn run_process(
    mut child: Child,
    mut input: mpsc::Receiver<Input>,
    mut cancel: watch::Receiver<bool>,
    finished: watch::Sender<bool>,
    events: Channel<AgentEvent>,
    mut codex: Codex,
    ready: oneshot::Sender<Result<(), String>>,
) {
    let group_id = child.id();
    let mut stdin = child.stdin.take().expect("piped stdin");
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
    let stderr = child.stderr.take().expect("piped stderr");
    // Codex logs internal tracing here; its user-facing warnings arrive as notifications.
    let err = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            eprintln!("codex: {line}");
        }
    });
    let mut ready = Some(ready);
    let deadline = tokio::time::sleep(STARTUP_TIMEOUT);
    tokio::pin!(deadline);
    let first = codex.start();
    let mut failure = apply(first, &mut stdin, &events, &mut cancel).await.err();
    let status = loop {
        if failure.is_some() || *cancel.borrow() {
            kill_group(&mut child);
            break child.wait().await;
        }
        if codex.ready() {
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(()));
            }
        }
        let step = tokio::select! {
            biased;
            _ = cancel.changed() => { kill_group(&mut child); break child.wait().await; }
            _ = &mut deadline, if ready.is_some() => Err("Codex did not start in time".to_string()),
            status = child.wait() => { break status; }
            next = input.recv() => {
                let Some(next) = next else { kill_group(&mut child); break child.wait().await; };
                let (step, ack) = match next {
                    Input::User { content, ack, .. } => (codex.user(&content), ack),
                    Input::Permission { request_id, answer, ack } => (codex.answer(&request_id, answer), ack),
                    Input::EditReady { request_id, allow, ack } => (codex.edit_ready(&request_id, allow), ack),
                };
                // A rejected input leaves the process running; the UI shows the error.
                let step = match step {
                    Ok(step) => step,
                    Err(error) => { let _ = ack.send(Err(error)); continue; }
                };
                let applied = apply(step, &mut stdin, &events, &mut cancel).await;
                let _ = ack.send(applied.as_ref().map(|_| ()).map_err(Clone::clone));
                applied
            }
            line = stdout.next_line() => match line {
                Ok(Some(line)) => match codex.message(&line).await {
                    Ok(step) => apply(step, &mut stdin, &events, &mut cancel).await,
                    Err(error) => Err(error),
                },
                Ok(None) => { kill_group(&mut child); break child.wait().await; }
                Err(error) => Err(error.to_string()),
            }
        };
        match step {
            Ok(true) => {
                kill_group(&mut child);
                break child.wait().await;
            }
            Ok(false) => {}
            Err(error) => failure = Some(error),
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
            line: json!({"method": "writer/failed", "params": {"message": message}}).to_string(),
        });
    }
    if let Some(ready) = ready {
        let _ = ready.send(Err(
            failure.unwrap_or_else(|| "Codex exited before it was ready".into())
        ));
    }
    let _ = err.await;
    codex.release();
    let _ = events.send(AgentEvent::Exit {
        code: status.ok().and_then(|s| s.code()),
    });
    let _ = finished.send(true);
}

#[derive(Debug, PartialEq)]
pub(super) struct SkillPath {
    pub name: String,
    pub description: String,
    pub path: String,
}

/// Enabled skills for the workspace, first one per name, as Codex orders them.
pub(super) fn parse_skills(result: &Value) -> Vec<SkillPath> {
    let mut seen = HashSet::new();
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|entry| entry["skills"].as_array().into_iter().flatten())
        .filter(|skill| skill["enabled"] != false)
        .filter_map(|skill| {
            let name = skill["name"].as_str()?;
            let path = skill["path"].as_str()?;
            if name.is_empty() || name.contains(char::is_whitespace) || !seen.insert(name) {
                return None;
            }
            Some(SkillPath {
                name: name.into(),
                description: text(&skill["description"]),
                path: path.into(),
            })
        })
        .collect()
}

#[derive(Debug, PartialEq)]
pub(super) struct ModelEntry {
    pub id: String,
    pub display_name: String,
    pub default: bool,
}

pub(super) fn parse_models(result: &Value) -> Vec<ModelEntry> {
    result["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["hidden"] != true)
        .filter_map(|model| {
            let id = model["id"].as_str()?;
            Some(ModelEntry {
                id: id.into(),
                display_name: model["displayName"].as_str().unwrap_or(id).into(),
                default: model["isDefault"] == true,
            })
        })
        .collect()
}

// Tauri maps each argument to an IPC field.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn codex_start(
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
    let start = super::Start {
        webview: &webview,
        state: &state,
        root,
        epoch,
        note_path,
        provider: "codex",
        on_event,
    };
    super::launch(start, resolve_codex_env(), move |(binary, path), launch| {
        let child = app_server_command(binary, path, &launch.root).spawn()?;
        let codex = Codex {
            always,
            remember: Some(remember),
            resume: resume_session_id,
            model,
            planning: plan,
            ..Codex::new(
                launch.root,
                launch.scope_root,
                launch.note,
                launch.id,
                launch.claims,
            )
        };
        tauri::async_runtime::spawn(run_process(
            child,
            launch.input,
            launch.cancel,
            launch.finished,
            launch.events,
            codex,
            launch.ready,
        ));
        Ok(())
    })
    .await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn events(step: &Step) -> Vec<Value> {
        step.events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .collect()
    }
    fn lines(step: &Step) -> Vec<Value> {
        events(step)
            .into_iter()
            .filter(|event| event["type"] == "line")
            .map(|event| serde_json::from_str(event["line"].as_str().unwrap()).unwrap())
            .collect()
    }
    async fn receive(codex: &mut Codex, value: Value) -> Step {
        codex.message(&value.to_string()).await.unwrap()
    }
    fn workspace() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::write(root.join("note.md"), "old").unwrap();
        std::fs::write(root.join("other.md"), "old").unwrap();
        (dir, root)
    }
    fn new_codex(root: &Path) -> Codex {
        Codex::new(
            root.into(),
            root.into(),
            Some(root.join("note.md")),
            "chat".into(),
            NoteClaims::default(),
        )
    }
    const THREAD: &str = "thread-1";
    fn thread_result(sandbox: &str) -> Value {
        json!({"thread": {"id": THREAD}, "model": "gpt-test", "reasoningEffort": "high", "sandbox": {"type": sandbox, "networkAccess": false}})
    }
    /// Runs the handshake up to a ready thread, returning the thread request.
    async fn handshake(codex: &mut Codex) -> Value {
        let start = codex.start();
        assert_eq!(start.writes[0]["method"], "initialize");
        assert_eq!(
            start.writes[0]["params"]["capabilities"]["experimentalApi"],
            true
        );
        let step = receive(codex, json!({"id": 1, "result": {}})).await;
        assert_eq!(step.writes[0], json!({"method": "initialized"}));
        assert_eq!(step.writes[1]["method"], "skills/list");
        let skills = json!({"data": [{"cwd": "/", "skills": [
            {"name": "ux-copy", "description": "Copy", "path": "/skills/ux-copy/SKILL.md", "enabled": true},
            {"name": "ux-copy", "description": "Shadowed", "path": "/other/SKILL.md", "enabled": true},
            {"name": "off", "description": "", "path": "/off/SKILL.md", "enabled": false}
        ]}]});
        let mut step = receive(codex, json!({"id": 2, "result": skills})).await;
        if codex.model.is_some() {
            assert_eq!(step.writes[0]["method"], "model/list");
            let models = json!({"data": [{"id": "gpt-test", "displayName": "GPT Test", "hidden": false, "isDefault": true}]});
            step = receive(codex, json!({"id": 3, "result": models})).await;
        }
        let request = step.writes[0].clone();
        assert!(!codex.ready());
        let id = request["id"].clone();
        let step = receive(
            codex,
            json!({"id": id, "result": thread_result("readOnly")}),
        )
        .await;
        assert!(codex.ready());
        assert_eq!(
            lines(&step),
            [json!({"method": "writer/thread", "params": {"threadId": THREAD}})]
        );
        request
    }
    async fn started_turn(codex: &mut Codex) -> Value {
        handshake(codex).await;
        let step = codex.user("hello").unwrap();
        step.writes[0].clone()
    }
    fn patch_started(item: &str, changes: Value) -> Value {
        json!({"method": "item/started", "params": {"threadId": THREAD, "turnId": "turn", "item": {"type": "fileChange", "id": item, "changes": changes, "status": "inProgress"}}})
    }
    fn update(path: &Path) -> Value {
        json!({"path": path, "kind": {"type": "update", "move_path": null}, "diff": ""})
    }
    fn approval(id: u64, item: &str) -> Value {
        json!({"id": id, "method": "item/fileChange/requestApproval", "params": {"threadId": THREAD, "turnId": "turn", "itemId": item, "startedAtMs": 0}})
    }

    #[tokio::test]
    async fn starts_a_read_only_thread_with_co_writer_instructions() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        let request = handshake(&mut codex).await;
        assert_eq!(request["method"], "thread/start");
        let params = &request["params"];
        assert_eq!(params["permissions"], READ_ONLY);
        assert_eq!(params["approvalPolicy"], "on-request");
        assert_eq!(params["cwd"], json!(root));
        assert!(params.get("model").is_none());
        let instructions = params["developerInstructions"].as_str().unwrap();
        assert!(instructions.contains(CODEX_RULES) && instructions.contains("openFile"));
        assert_eq!(codex.skills.len(), 1);
        assert_eq!(codex.skills["ux-copy"], "/skills/ux-copy/SKILL.md");
    }

    #[tokio::test]
    async fn refuses_a_thread_outside_the_read_only_sandbox() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        codex.start();
        receive(&mut codex, json!({"id": 1, "result": {}})).await;
        receive(&mut codex, json!({"id": 2, "result": {"data": []}})).await;
        let refused = codex
            .message(&json!({"id": 3, "result": thread_result("workspaceWrite")}).to_string())
            .await;
        assert_eq!(refused.err().as_deref(), Some(SANDBOX_REFUSED));
        assert!(!codex.ready());
    }

    #[tokio::test]
    async fn resumes_the_saved_thread_with_the_chosen_model() {
        let (_dir, root) = workspace();
        let mut codex = Codex {
            resume: Some("saved".into()),
            model: Some("gpt-test".into()),
            ..new_codex(&root)
        };
        let request = handshake(&mut codex).await;
        assert_eq!(request["method"], "thread/resume");
        assert_eq!(request["params"]["threadId"], "saved");
        assert_eq!(request["params"]["model"], "gpt-test");
        assert_eq!(request["params"]["permissions"], READ_ONLY);

        let mut unknown = Codex {
            model: Some("gone".into()),
            ..new_codex(&root)
        };
        unknown.start();
        receive(&mut unknown, json!({"id": 1, "result": {}})).await;
        receive(&mut unknown, json!({"id": 2, "result": {"data": []}})).await;
        let failed = unknown
            .message(&json!({"id": 3, "result": {"data": [{"id": "gpt-test"}]}}).to_string())
            .await;
        assert!(failed
            .err()
            .unwrap()
            .contains("Unknown Codex model \"gone\""));
    }

    #[tokio::test]
    async fn resume_failures_and_skill_errors_are_explicit() {
        let (_dir, root) = workspace();
        let mut codex = Codex {
            resume: Some("gone".into()),
            ..new_codex(&root)
        };
        codex.start();
        receive(&mut codex, json!({"id": 1, "result": {}})).await;
        let step = receive(
            &mut codex,
            json!({"id": 2, "error": {"code": -1, "message": "bad config"}}),
        )
        .await;
        assert_eq!(
            events(&step)[0],
            json!({"type": "stderr", "message": "Codex couldn't list its skills: bad config"})
        );
        assert_eq!(step.writes[0]["method"], "thread/resume");
        let failed = codex
            .message(&json!({"id": 3, "error": {"code": -1, "message": "no rollout found for thread id gone"}}).to_string())
            .await;
        assert_eq!(
            failed.err().as_deref(),
            Some("no rollout found for thread id gone")
        );
    }

    #[tokio::test]
    async fn turns_carry_the_mode_and_a_known_skill() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        handshake(&mut codex).await;
        let step = codex.user("/ux-copy tighten this").unwrap();
        let params = &step.writes[0]["params"];
        assert_eq!(step.writes[0]["method"], "turn/start");
        assert_eq!(params["threadId"], THREAD);
        assert_eq!(
            params["input"][1],
            json!({"type": "skill", "name": "ux-copy", "path": "/skills/ux-copy/SKILL.md"})
        );
        assert_eq!(params["collaborationMode"]["mode"], "default");
        assert_eq!(params["collaborationMode"]["settings"]["model"], "gpt-test");
        assert_eq!(
            params["collaborationMode"]["settings"]["reasoning_effort"],
            "high"
        );
        assert!(codex.user("again").is_err());

        let mut other = Codex {
            planning: true,
            ..new_codex(&root)
        };
        handshake(&mut other).await;
        let step = other.user("/unknown thing").unwrap();
        assert_eq!(
            step.writes[0]["params"]["input"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            step.writes[0]["params"]["collaborationMode"]["mode"],
            "plan"
        );
    }

    #[tokio::test]
    async fn own_note_patch_waits_for_the_ui_then_applies() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        started_turn(&mut codex).await;
        let started = receive(
            &mut codex,
            patch_started("p1", json!([update(&root.join("note.md"))])),
        )
        .await;
        assert_eq!(lines(&started)[0]["method"], "item/started");
        let step = receive(&mut codex, approval(7, "p1")).await;
        assert!(step.writes.is_empty());
        assert_eq!(
            events(&step),
            [
                json!({"type": "edit_start", "requestId": "7", "toolUseId": "p1", "path": root.join("note.md")})
            ]
        );
        assert!(codex
            .answer(
                "7",
                Answer::Tool {
                    allow: true,
                    always: false
                }
            )
            .is_err());
        let step = codex.edit_ready("7", true).unwrap();
        assert_eq!(
            step.writes,
            [json!({"id": 7, "result": {"decision": "accept"}})]
        );
        assert!(codex.edit_ready("7", true).is_err());
    }

    #[tokio::test]
    async fn other_note_patch_needs_approval_and_a_claim() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        started_turn(&mut codex).await;
        let other = root.join("other.md");
        receive(&mut codex, patch_started("p2", json!([update(&other)]))).await;
        let step = receive(&mut codex, approval(8, "p2")).await;
        assert!(step.writes.is_empty());
        assert_eq!(
            lines(&step),
            [
                json!({"method": "writer/request", "params": {"requestId": "8", "tool": "Edit", "input": {"file_path": other}, "target": {"path": other, "exists": true}}})
            ]
        );
        let step = codex
            .answer(
                "8",
                Answer::Tool {
                    allow: true,
                    always: false,
                },
            )
            .unwrap();
        assert_eq!(events(&step)[0]["type"], "edit_start");
        assert_eq!(
            codex.claims.lock().get(&other).map(String::as_str),
            Some("chat")
        );
        assert_eq!(
            codex.edit_ready("8", false).unwrap().writes,
            [json!({"id": 8, "result": {"decision": "decline"}})]
        );

        // An approved note stays editable for the rest of the turn.
        receive(&mut codex, patch_started("p3", json!([update(&other)]))).await;
        let step = receive(&mut codex, approval(9, "p3")).await;
        assert_eq!(events(&step)[0]["type"], "edit_start");

        // A note another chat holds is declined after approval.
        let created = root.join("new.md");
        codex
            .claims
            .lock()
            .insert(created.clone(), "someone".into());
        let add = json!([{"path": created, "kind": {"type": "add"}, "diff": "new"}]);
        receive(&mut codex, patch_started("p4", add)).await;
        let step = receive(&mut codex, approval(10, "p4")).await;
        assert_eq!(lines(&step)[0]["params"]["tool"], "Write");
        assert_eq!(lines(&step)[0]["params"]["target"]["exists"], false);
        let step = codex
            .answer(
                "10",
                Answer::Tool {
                    allow: true,
                    always: false,
                },
            )
            .unwrap();
        assert_eq!(
            step.writes,
            [json!({"id": 10, "result": {"decision": "decline"}})]
        );
        codex.release();
        assert_eq!(codex.claims.lock().len(), 1);
    }

    #[tokio::test]
    async fn out_of_scope_patches_are_declined_natively() {
        let (_dir, root) = workspace();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.join(".hidden")).unwrap();
        let mut codex = new_codex(&root);
        started_turn(&mut codex).await;
        let note = root.join("note.md");
        let cases = [
            json!([update(&outside.path().join("x.md"))]),
            json!([update(&root.join(".hidden/x.md"))]),
            json!([update(&root.join("missing.md"))]),
            json!([update(&root.join("image.png"))]),
            json!([{"path": note, "kind": {"type": "delete"}, "diff": ""}]),
            json!([{"path": note, "kind": {"type": "update", "move_path": root.join("moved.md")}, "diff": ""}]),
            json!([update(&note), update(&root.join("other.md"))]),
        ];
        for (index, changes) in cases.into_iter().enumerate() {
            let item = format!("bad{index}");
            receive(&mut codex, patch_started(&item, changes)).await;
            let step = receive(&mut codex, approval(20 + index as u64, &item)).await;
            assert_eq!(
                step.writes,
                [json!({"id": 20 + index, "result": {"decision": "decline"}})],
                "case {index}"
            );
            assert!(step.events.is_empty(), "case {index}");
        }
        receive(&mut codex, patch_started("grant", json!([update(&note)]))).await;
        let mut request = approval(30, "grant");
        request["params"]["grantRoot"] = json!(root);
        let step = receive(&mut codex, request).await;
        assert_eq!(step.writes[0]["result"]["decision"], "decline");
        let step = receive(&mut codex, approval(31, "unknown-item")).await;
        assert_eq!(step.writes[0]["result"]["decision"], "decline");
    }

    #[tokio::test]
    async fn shell_escalations_and_unknown_requests_are_refused() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        started_turn(&mut codex).await;
        let step = receive(&mut codex, json!({"id": 40, "method": "item/commandExecution/requestApproval", "params": {"threadId": THREAD, "command": "rm -rf ."}})).await;
        assert_eq!(
            step.writes,
            [json!({"id": 40, "result": {"decision": "decline"}})]
        );
        let step = receive(&mut codex, json!({"id": 41, "method": "item/permissions/requestApproval", "params": {"threadId": THREAD}})).await;
        assert_eq!(
            step.writes,
            [json!({"id": 41, "result": {"permissions": {}, "scope": "turn"}})]
        );
        let step = receive(
            &mut codex,
            json!({"id": 42, "method": "item/tool/call", "params": {}}),
        )
        .await;
        assert_eq!(step.writes[0]["error"]["code"], -32601);
        assert!(step.events.is_empty());
    }

    #[tokio::test]
    async fn mcp_approvals_use_the_shared_tool_names() {
        let (_dir, root) = workspace();
        let saved = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let record = saved.clone();
        let mut codex = Codex {
            remember: Some(Arc::new(move |tool: &str| {
                record.lock().push(tool.to_string());
                Ok(())
            })),
            ..new_codex(&root)
        };
        started_turn(&mut codex).await;
        let call = |id: &str| json!({"method": "item/started", "params": {"threadId": THREAD, "item": {"type": "mcpToolCall", "id": id, "server": "fixture", "tool": "record", "status": "inProgress", "arguments": {}}}});
        let elicit = |id: u64| json!({"id": id, "method": "mcpServer/elicitation/request", "params": {"threadId": THREAD, "serverName": "fixture", "mode": "form", "message": "Allow?", "requestedSchema": {}, "_meta": {"codex_approval_kind": "mcp_tool_call", "tool_description": "Records", "tool_params": {"note": "a"}}}});
        receive(&mut codex, call("m1")).await;
        let step = receive(&mut codex, elicit(50)).await;
        assert_eq!(
            lines(&step),
            [
                json!({"method": "writer/request", "params": {"requestId": "50", "tool": "mcp__fixture__record", "input": {"note": "a"}, "description": "Records"}})
            ]
        );
        let step = codex
            .answer(
                "50",
                Answer::Tool {
                    allow: true,
                    always: true,
                },
            )
            .unwrap();
        assert_eq!(
            step.writes,
            [json!({"id": 50, "result": {"action": "accept", "content": {}, "_meta": null}})]
        );
        assert_eq!(*saved.lock(), ["mcp__fixture__record"]);
        let step = receive(&mut codex, elicit(51)).await;
        assert_eq!(step.writes[0]["result"]["action"], "accept");
        assert!(step.events.is_empty());

        // Without a single running call, the request can't be named, so it's declined.
        receive(&mut codex, json!({"method": "item/completed", "params": {"threadId": THREAD, "item": {"type": "mcpToolCall", "id": "m1"}}})).await;
        let step = receive(&mut codex, elicit(52)).await;
        assert_eq!(step.writes[0]["result"]["action"], "decline");
        receive(&mut codex, call("m2")).await;
        let mut form = elicit(53);
        form["params"]["_meta"] = json!(null);
        let step = receive(&mut codex, form).await;
        assert_eq!(step.writes[0]["result"]["action"], "decline");
    }

    #[tokio::test]
    async fn questions_map_answers_back_to_codex_ids() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        started_turn(&mut codex).await;
        let ask = json!({"id": 60, "method": "item/tool/requestUserInput", "params": {"threadId": THREAD, "itemId": "q", "questions": [
            {"id": "style", "header": "Style", "question": "Which style?", "isOther": true, "isSecret": false, "options": [{"label": "Short", "description": "Brief"}]},
            {"id": "tone", "header": "Tone", "question": "Which tone?", "isOther": true, "isSecret": false, "options": null}
        ]}});
        let step = receive(&mut codex, ask).await;
        let request = &lines(&step)[0]["params"];
        assert_eq!(request["tool"], "AskUserQuestion");
        assert_eq!(
            request["input"]["questions"][0]["options"][0]["label"],
            "Short"
        );
        assert_eq!(request["input"]["questions"][1]["options"], json!([]));
        assert!(codex
            .answer(
                "60",
                Answer::Tool {
                    allow: true,
                    always: false
                }
            )
            .is_err());
        let partial = BTreeMap::from([("Which style?".to_string(), "Short".to_string())]);
        assert!(codex
            .answer(
                "60",
                Answer::Questions {
                    answers: Some(partial)
                }
            )
            .is_err());
        let answers = BTreeMap::from([
            ("Which style?".to_string(), "Short".to_string()),
            ("Which tone?".to_string(), "Warm".to_string()),
        ]);
        let step = codex
            .answer(
                "60",
                Answer::Questions {
                    answers: Some(answers),
                },
            )
            .unwrap();
        assert_eq!(
            step.writes,
            [
                json!({"id": 60, "result": {"answers": {"style": {"answers": ["Short"]}, "tone": {"answers": ["Warm"]}}}})
            ]
        );
        assert_eq!(lines(&step)[0]["method"], "writer/resolved");
        assert_eq!(lines(&step)[0]["params"]["answers"]["Which tone?"], "Warm");

        let duplicate = json!({"id": 61, "method": "item/tool/requestUserInput", "params": {"threadId": THREAD, "questions": [
            {"id": "a", "question": "Same?"}, {"id": "b", "question": "Same?"}
        ]}});
        let step = receive(&mut codex, duplicate).await;
        assert_eq!(step.writes, [json!({"id": 61, "result": {"answers": {}}})]);
    }

    #[tokio::test]
    async fn plan_turns_hold_until_the_plan_is_approved() {
        let (_dir, root) = workspace();
        let mut codex = Codex {
            planning: true,
            ..new_codex(&root)
        };
        started_turn(&mut codex).await;
        let note = root.join("note.md");
        receive(&mut codex, patch_started("p", json!([update(&note)]))).await;
        let step = receive(&mut codex, approval(70, "p")).await;
        assert_eq!(step.writes[0]["result"]["decision"], "decline");
        receive(&mut codex, json!({"method": "item/completed", "params": {"threadId": THREAD, "item": {"type": "plan", "id": "plan", "text": "1. Tidy"}}})).await;
        let completed = json!({"method": "turn/completed", "params": {"threadId": THREAD, "turn": {"id": "turn", "status": "completed", "error": null}}});
        let step = receive(&mut codex, completed.clone()).await;
        assert!(!step.done);
        assert_eq!(
            lines(&step),
            [
                json!({"method": "writer/request", "params": {"requestId": "writer-plan-1", "tool": "ExitPlanMode", "input": {"plan": "1. Tidy"}}})
            ]
        );
        let feedback = Answer::Plan {
            approve: false,
            feedback: Some("Shorter".into()),
        };
        let step = codex.answer("writer-plan-1", feedback).unwrap();
        assert_eq!(lines(&step)[0]["params"]["error"], true);
        assert_eq!(
            step.writes[0]["params"]["collaborationMode"]["mode"],
            "plan"
        );
        assert!(step.writes[0]["params"]["input"][0]["text"]
            .as_str()
            .unwrap()
            .ends_with("Their feedback: Shorter"));

        receive(&mut codex, json!({"method": "item/completed", "params": {"threadId": THREAD, "item": {"type": "plan", "id": "plan2", "text": "1. Tidy briefly"}}})).await;
        receive(&mut codex, completed.clone()).await;
        let step = codex
            .answer(
                "writer-plan-2",
                Answer::Plan {
                    approve: true,
                    feedback: None,
                },
            )
            .unwrap();
        assert_eq!(
            lines(&step)[0],
            json!({"method": "writer/resolved", "params": {"requestId": "writer-plan-2", "error": false}})
        );
        assert_eq!(
            step.writes[0]["params"]["collaborationMode"]["mode"],
            "default"
        );
        assert_eq!(step.writes[0]["params"]["input"][0]["text"], IMPLEMENT);
        assert!(!codex.planning);
        receive(&mut codex, patch_started("p2", json!([update(&note)]))).await;
        let step = receive(&mut codex, approval(71, "p2")).await;
        assert_eq!(events(&step)[0]["type"], "edit_start");
        let step = receive(&mut codex, completed).await;
        assert!(step.done);
        assert_eq!(lines(&step)[0]["method"], "turn/completed");
    }

    #[tokio::test]
    async fn only_this_threads_notifications_reach_the_ui() {
        let (_dir, root) = workspace();
        let mut codex = new_codex(&root);
        started_turn(&mut codex).await;
        let delta = |thread: &str| json!({"method": "item/agentMessage/delta", "params": {"threadId": thread, "itemId": "m", "delta": "hi"}});
        assert_eq!(lines(&receive(&mut codex, delta(THREAD)).await).len(), 1);
        assert!(receive(&mut codex, delta("sub-agent"))
            .await
            .events
            .is_empty());
        let sub_done = json!({"method": "turn/completed", "params": {"threadId": "sub-agent", "turn": {"id": "x", "status": "completed"}}});
        assert!(!receive(&mut codex, sub_done).await.done);
        let output = json!({"method": "item/commandExecution/outputDelta", "params": {"threadId": THREAD, "delta": "lots"}});
        assert!(receive(&mut codex, output).await.events.is_empty());
        let warning = json!({"method": "configWarning", "params": {"summary": "Bad config.", "details": "Fix it."}});
        assert_eq!(
            events(&receive(&mut codex, warning).await),
            [json!({"type": "stderr", "message": "Bad config. Fix it."})]
        );

        receive(
            &mut codex,
            patch_started("p", json!([update(&root.join("other.md"))])),
        )
        .await;
        receive(&mut codex, approval(80, "p")).await;
        let resolved = json!({"method": "serverRequest/resolved", "params": {"threadId": THREAD, "requestId": 80}});
        assert_eq!(
            lines(&receive(&mut codex, resolved.clone()).await),
            [json!({"method": "writer/cancel", "params": {"requestId": "80"}})]
        );
        assert!(receive(&mut codex, resolved).await.events.is_empty());
        assert!(codex.message("{").await.is_err());
        assert!(codex
            .message(&json!({"id": 99, "result": {}}).to_string())
            .await
            .is_err());
    }

    fn shell(script: &str, dir: &Path) -> Child {
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
    fn capture() -> (Channel<AgentEvent>, mpsc::UnboundedReceiver<Value>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(body) = body {
                let _ = tx.send(serde_json::from_str(&body).unwrap());
            }
            Ok(())
        });
        (channel, rx)
    }

    #[tokio::test]
    async fn actor_runs_one_turn_and_reaps_the_server() {
        let (dir, root) = workspace();
        let thread = json!({"id": 3, "result": thread_result("readOnly")});
        let done = json!({"method": "turn/completed", "params": {"threadId": THREAD, "turn": {"id": "u", "status": "completed", "error": null}}});
        let script = format!("read init; echo '{{\"id\":1,\"result\":{{}}}}'; read initialized; read skills; echo '{{\"id\":2,\"result\":{{\"data\":[]}}}}'; read thread; printf '%s\\n' '{thread}'; read turn; printf '%s\\n' \"$turn\" > turn.json; echo '{{\"id\":4,\"result\":{{}}}}'; printf '%s\\n' '{done}'; (sleep 0.4; echo late > note.md) & wait");
        let child = shell(&script, dir.path());
        let (input, rx) = mpsc::channel(1);
        let (_cancel, cancel_rx) = watch::channel(false);
        let (finished, mut finished_rx) = watch::channel(false);
        let (ready, started) = oneshot::channel();
        let (events, mut received) = capture();
        let task = tokio::spawn(run_process(
            child,
            rx,
            cancel_rx,
            finished,
            events,
            new_codex(&root),
            ready,
        ));
        started.await.unwrap().unwrap();
        let (ack, sent) = oneshot::channel();
        input
            .send(Input::User {
                content: "hello".into(),
                files: Vec::new(),
                ack,
            })
            .await
            .unwrap();
        sent.await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_secs(2), finished_rx.changed())
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap();
        let mut seen = Vec::new();
        while let Ok(event) = received.try_recv() {
            seen.push(event);
        }
        assert_eq!(seen.last().unwrap()["type"], "exit");
        assert!(seen.iter().any(|event| event["type"] == "line"
            && event["line"].as_str().unwrap().contains("turn/completed")));
        let turn: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("turn.json")).unwrap())
                .unwrap();
        assert_eq!(turn["params"]["threadId"], THREAD);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            std::fs::read_to_string(root.join("note.md")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    async fn stop_before_ready_reaps_and_reports() {
        let (dir, root) = workspace();
        let child = shell("read init; sleep 10", dir.path());
        let (_input, rx) = mpsc::channel(1);
        let (cancel, cancel_rx) = watch::channel(false);
        let (finished, mut finished_rx) = watch::channel(false);
        let (ready, started) = oneshot::channel();
        let (events, _received) = capture();
        let codex = new_codex(&root);
        let note = root.join("note.md");
        codex.claims.lock().insert(note.clone(), "chat".into());
        let claims = codex.claims.clone();
        let task = tokio::spawn(run_process(
            child, rx, cancel_rx, finished, events, codex, ready,
        ));
        tokio::time::sleep(Duration::from_millis(50)).await;
        cancel.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), finished_rx.changed())
            .await
            .unwrap()
            .unwrap();
        task.await.unwrap();
        assert!(started.await.unwrap().is_err());
        assert!(claims.lock().is_empty());
    }

    #[test]
    fn parses_models_and_skills() {
        let models = json!({"data": [
            {"id": "a", "displayName": "A", "hidden": false, "isDefault": true},
            {"id": "hidden", "displayName": "H", "hidden": true},
            {"displayName": "nameless"}
        ]});
        assert_eq!(
            parse_models(&models),
            [ModelEntry {
                id: "a".into(),
                display_name: "A".into(),
                default: true
            }]
        );
        assert!(parse_skills(&json!({})).is_empty());
    }

    fn real_codex_root() -> (tempfile::TempDir, PathBuf) {
        let (dir, root) = workspace();
        std::fs::write(root.join("note.md"), "# Groceries\n\n- milk\n").unwrap();
        (dir, root)
    }

    /// Drives a real `codex app-server` through the actor's state machine.
    async fn real_turn(
        codex: &mut Codex,
        prompt: &str,
        answer: impl Fn(&Value) -> Option<Answer>,
    ) -> Vec<Value> {
        // CODEX_BIN runs a specific CLI build instead of the login shell's.
        let (binary, path) = match std::env::var("CODEX_BIN") {
            Ok(binary) => (binary.into(), std::env::var("PATH").unwrap()),
            Err(_) => resolve_codex_env().await.unwrap(),
        };
        let mut child = app_server_command(binary, path, &codex.cwd.clone())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut seen = Vec::new();
        let (_cancel, mut cancel) = watch::channel(false);
        let (events, mut received) = capture();
        let mut done = apply(codex.start(), &mut stdin, &events, &mut cancel)
            .await
            .unwrap();
        let mut sent = false;
        while !done {
            if codex.ready() && !sent {
                sent = true;
                done = apply(
                    codex.user(prompt).unwrap(),
                    &mut stdin,
                    &events,
                    &mut cancel,
                )
                .await
                .unwrap();
                continue;
            }
            let line = tokio::time::timeout(Duration::from_secs(240), stdout.next_line())
                .await
                .unwrap()
                .unwrap()
                .unwrap();
            let step = codex.message(&line).await.unwrap();
            done = apply(step, &mut stdin, &events, &mut cancel).await.unwrap();
            while let Ok(event) = received.try_recv() {
                seen.push(event.clone());
                if event["type"] == "edit_start" {
                    let id = event["requestId"].as_str().unwrap().to_string();
                    done |= apply(
                        codex.edit_ready(&id, true).unwrap(),
                        &mut stdin,
                        &events,
                        &mut cancel,
                    )
                    .await
                    .unwrap();
                }
                let request = event["line"]
                    .as_str()
                    .and_then(|line| serde_json::from_str::<Value>(line).ok());
                if let Some(request) = request.filter(|r| r["method"] == "writer/request") {
                    let id = request["params"]["requestId"].as_str().unwrap().to_string();
                    let reply = answer(&request["params"]).unwrap_or(Answer::Tool {
                        allow: false,
                        always: false,
                    });
                    done |= apply(
                        codex.answer(&id, reply).unwrap(),
                        &mut stdin,
                        &events,
                        &mut cancel,
                    )
                    .await
                    .unwrap();
                }
            }
        }
        kill_group(&mut child);
        let _ = child.wait().await;
        seen
    }

    #[tokio::test]
    #[ignore = "requires terminal Codex sign-in and network"]
    async fn real_codex_edits_note() {
        let (_dir, root) = real_codex_root();
        let mut codex = new_codex(&root);
        let prompt = format!("<writer_context>{{\"openFile\":\"{}\"}}</writer_context>\nAdd \"- eggs\" to the list in the open note. Then try to add \"- tea\" to {}; if that's declined, say so without retrying.", root.join("note.md").display(), root.join("other.md").display());
        let seen = real_turn(&mut codex, &prompt, |_| None).await;
        eprintln!("{seen:#?}");
        assert!(std::fs::read_to_string(root.join("note.md"))
            .unwrap()
            .contains("- eggs"));
        assert_eq!(
            std::fs::read_to_string(root.join("other.md")).unwrap(),
            "old"
        );
    }

    #[tokio::test]
    #[ignore = "requires terminal Codex sign-in and network"]
    async fn real_codex_plan_mode() {
        let (_dir, root) = real_codex_root();
        let mut codex = Codex {
            planning: true,
            ..new_codex(&root)
        };
        let prompt = format!("<writer_context>{{\"openFile\":\"{}\"}}</writer_context>\nPlan how to sort this list alphabetically and add bread, then do it once I approve.", root.join("note.md").display());
        let seen = real_turn(&mut codex, &prompt, |request| {
            match request["tool"].as_str() {
                Some("ExitPlanMode") => Some(Answer::Plan {
                    approve: true,
                    feedback: None,
                }),
                Some("AskUserQuestion") => {
                    let questions = request["input"]["questions"].as_array()?;
                    Some(Answer::Questions {
                        answers: Some(
                            questions
                                .iter()
                                .map(|q| {
                                    (
                                        q["question"].as_str().unwrap().to_string(),
                                        "Your call".to_string(),
                                    )
                                })
                                .collect(),
                        ),
                    })
                }
                _ => None,
            }
        })
        .await;
        eprintln!("{seen:#?}");
        assert!(std::fs::read_to_string(root.join("note.md"))
            .unwrap()
            .contains("bread"));
    }
}
