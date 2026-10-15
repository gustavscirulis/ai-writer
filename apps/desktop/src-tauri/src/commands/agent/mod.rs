pub mod allowed_tools;
pub mod capabilities;
pub mod claude;
pub mod cli_env;
pub mod codex;
pub mod scope;

use crate::{error::AppError, state::AppState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::{ipc::Channel, AppHandle, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot, watch};

/// Provider transport boundary. The UI parses each provider's lines with that
/// provider's parser and handles the lifecycle events the same way for all.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Started {
        #[serde(rename = "processId")]
        process_id: String,
        provider: &'static str,
    },
    Line {
        line: String,
    },
    Stderr {
        message: String,
    },
    /// An allowed Edit/Write waits for the UI to save and lock the note.
    EditStart {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(rename = "toolUseId")]
        tool_use_id: Option<String>,
        /// Canonical note the edit writes, which may be another note the user approved.
        path: std::path::PathBuf,
    },
    Exit {
        code: Option<i32>,
    },
}

const BASE_SYSTEM_PROMPT: &str =
    "You assist a writer in a Markdown editor. Read workspace files for context.";
const NOTE_SCOPE: &str = "Edit the assigned openFile in writer_context freely. Create or edit other notes only when the user asks; each one needs the user's approval, so use absolute paths to Markdown files inside the workspace.";
const PROMPT_RULES: &str = "Use configured MCP tools when relevant, but do not use them to edit workspace files. Preserve frontmatter and formatting unless asked to change them. Files the user attached are listed in writer_context.files; Read each one before answering. An @Name in the user's message refers to the attached file with that name. Report changes.";

/// Co-writer's instructions for any agent; `write_tool` is how that agent creates a file.
fn system_prompt(has_note: bool, write_tool: &str) -> String {
    let scope = if has_note {
        NOTE_SCOPE.to_string()
    } else {
        format!("No note is open. When the user asks you to write something, create a new Markdown note for it inside the workspace with {write_tool}, using an absolute path. Edit existing notes only when the user asks. Each note you create or edit needs the user's approval.")
    };
    format!(
        "{BASE_SYSTEM_PROMPT} {scope} {PROMPT_RULES} {}",
        crate::embed_protocol::EMBED_AUTHORING_GUIDE
    )
}

pub enum Input {
    User {
        /// The user's message; each actor wraps it in its own protocol frame.
        content: String,
        /// Canonical files the user attached; Read may open them this turn.
        files: Vec<std::path::PathBuf>,
        ack: oneshot::Sender<Result<(), String>>,
    },
    Permission {
        request_id: String,
        answer: Answer,
        ack: oneshot::Sender<Result<(), String>>,
    },
    EditReady {
        request_id: String,
        allow: bool,
        ack: oneshot::Sender<Result<(), String>>,
    },
}

/// The user's reply to a pending host request; native code checks it fits the request.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Answer {
    Tool {
        allow: bool,
        /// Save the tool so later requests skip the prompt, in every chat.
        always: bool,
    },
    /// Answers keyed by question text; `None` declines to answer.
    Questions {
        answers: Option<std::collections::BTreeMap<String, String>>,
    },
    /// Approving a plan ends plan mode; otherwise the agent keeps planning, with any feedback.
    Plan {
        approve: bool,
        feedback: Option<String>,
    },
}

/// Canonical notes that a running agent may edit, keyed to its process id.
pub type NoteClaims =
    std::sync::Arc<parking_lot::Mutex<std::collections::HashMap<std::path::PathBuf, String>>>;

pub struct AgentProcess {
    pub input: mpsc::Sender<Input>,
    pub cancel: watch::Sender<bool>,
    pub finished: watch::Receiver<bool>,
}

impl AgentProcess {
    pub fn stop(&self) {
        let _ = self.cancel.send(true);
    }
}

impl Drop for AgentProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

#[tauri::command]
pub fn set_pending_approvals(webview: WebviewWindow, state: State<'_, AppState>, count: u32) {
    state
        .get_or_create(webview.label())
        .pending_approvals
        .store(count, Ordering::SeqCst);
    refresh_badge(webview.app_handle(), None);
}

/// The macOS Dock badge is app-global, so it always reflects every window's
/// pending approvals rather than whichever window reported last. The update
/// is routed through a window, so a closing one must be skipped.
pub fn refresh_badge(app: &AppHandle, closing: Option<&str>) {
    let total = app.state::<AppState>().pending_approvals_total();
    let Some(window) = app
        .webview_windows()
        .into_values()
        .find(|window| Some(window.label()) != closing)
    else {
        return;
    };
    // tao renders `Some(0)` as a "0" label on macOS instead of clearing it.
    let count = (total > 0).then_some(i64::from(total));
    if let Err(error) = window.set_badge_count(count) {
        eprintln!("failed to update Dock badge: {error}");
    }
}

/// What every agent's start command receives from the UI.
pub struct Start<'a> {
    pub webview: &'a WebviewWindow,
    pub state: &'a AppState,
    pub root: String,
    pub epoch: u64,
    pub note_path: Option<String>,
    pub provider: &'static str,
    pub on_event: Channel<AgentEvent>,
}

/// A registered process slot; the provider spawns its child and actor into it.
pub struct Launch {
    /// The workspace root as the UI named it, for the child's working folder.
    pub root: PathBuf,
    pub scope_root: PathBuf,
    pub note: Option<PathBuf>,
    pub id: String,
    pub claims: NoteClaims,
    pub input: mpsc::Receiver<Input>,
    pub cancel: watch::Receiver<bool>,
    pub finished: watch::Sender<bool>,
    pub events: Channel<AgentEvent>,
    /// The actor reports when the agent can take the user's message.
    pub ready: oneshot::Sender<Result<(), String>>,
}

/// Starts an agent process inside the workspace snapshot, claims its note and
/// waits until its actor is ready. `spawn` runs under the registry lock.
async fn launch(
    start: Start<'_>,
    resolve: impl std::future::Future<Output = Result<(PathBuf, String), AppError>>,
    spawn: impl FnOnce((PathBuf, String), Launch) -> std::io::Result<()>,
) -> Result<String, AppError> {
    let Start {
        webview,
        state,
        root,
        epoch,
        note_path,
        provider,
        on_event,
    } = start;
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    let agent_epoch = workspace.agent_epoch.load(Ordering::SeqCst);
    let env = resolve.await?;
    if !webview
        .is_visible()
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        return Err(AppError::Io(
            "Co-writer startup canceled because the window is closed".into(),
        ));
    }
    let root = PathBuf::from(root);
    let paths = (root.clone(), note_path.map(PathBuf::from));
    let (scope_root, note) = tauri::async_runtime::spawn_blocking(move || {
        Ok::<_, std::io::Error>((
            paths.0.canonicalize()?,
            paths.1.map(|note| note.canonicalize()).transpose()?,
        ))
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))??;
    let (ready_tx, ready_rx) = oneshot::channel();
    let id = workspace
        .with_workspace_snapshot(&root, epoch, || {
            let mut registry = workspace.agents.lock();
            if workspace.agent_epoch.load(Ordering::SeqCst) != agent_epoch {
                return Err(AppError::Io("Co-writer startup was canceled".into()));
            }
            registry.retain(|_, process| !*process.finished.borrow());
            let mut claims = workspace.agent_claims.lock();
            if note.as_ref().is_some_and(|note| claims.contains_key(note)) {
                return Err(AppError::Io("An agent is already editing this note".into()));
            }
            let (tx, rx) = mpsc::channel(1);
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let (finished_tx, finished_rx) = watch::channel(false);
            let id = uuid::Uuid::new_v4().to_string();
            // Claimed before the actor exists, so its exit always releases the claim.
            if let Some(note) = &note {
                claims.insert(note.clone(), id.clone());
            }
            drop(claims);
            let launch = Launch {
                root: root.clone(),
                scope_root,
                note: note.clone(),
                id: id.clone(),
                claims: workspace.agent_claims.clone(),
                input: rx,
                cancel: cancel_rx,
                finished: finished_tx,
                events: on_event.clone(),
                ready: ready_tx,
            };
            if let Err(error) = spawn(env, launch) {
                scope::release(&workspace.agent_claims, &id);
                return Err(error.into());
            }
            registry.insert(
                id.clone(),
                AgentProcess {
                    input: tx,
                    cancel: cancel_tx,
                    finished: finished_rx,
                },
            );
            Ok(id)
        })
        .ok_or(AppError::NoWorkspace)??;
    // Publish cancellation ownership before waiting for MCP/plugin initialization.
    if let Err(error) = on_event.send(AgentEvent::Started {
        process_id: id.clone(),
        provider,
    }) {
        stop_process(&workspace, &id).await;
        return Err(AppError::Io(error.to_string()));
    }
    match ready_rx.await {
        Ok(Ok(())) => Ok(id),
        Ok(Err(message)) => {
            stop_process(&workspace, &id).await;
            Err(AppError::Io(message))
        }
        Err(error) => {
            stop_process(&workspace, &id).await;
            Err(AppError::Io(error.to_string()))
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
        .ok_or_else(|| AppError::Io("Co-writer process is no longer active".into()))?
        .input
        .clone();
    let (ack, result) = oneshot::channel();
    let exited = || AppError::Io("The agent exited".into());
    tx.send(build(ack)).await.map_err(|_| exited())?;
    result.await.map_err(|_| exited())?.map_err(AppError::Io)
}
#[tauri::command]
pub async fn agent_send(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    content: String,
    files: Vec<String>,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    let files = tauri::async_runtime::spawn_blocking(move || {
        crate::commands::chat_files::resolve_attachments(&files)
    })
    .await
    .map_err(|e| AppError::Io(e.to_string()))?
    .map_err(AppError::Io)?;
    deliver(&workspace, &process_id, |ack| Input::User {
        content,
        files,
        ack,
    })
    .await
}
#[tauri::command]
pub async fn agent_decide_permission(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    request_id: String,
    allow: bool,
    always: bool,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    deliver(&workspace, &process_id, |ack| Input::Permission {
        request_id,
        answer: Answer::Tool { allow, always },
        ack,
    })
    .await
}
#[tauri::command]
pub async fn agent_answer(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    request_id: String,
    answer: Answer,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    deliver(&workspace, &process_id, |ack| Input::Permission {
        request_id,
        answer,
        ack,
    })
    .await
}
#[tauri::command]
pub async fn agent_edit_ready(
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
pub async fn agent_stop(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    stop_process(&workspace, &process_id).await;
    Ok(())
}
