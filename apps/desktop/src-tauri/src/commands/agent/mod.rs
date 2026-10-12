pub mod allowed_tools;
pub mod claude;
pub mod mcp;

use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::sync::{mpsc, oneshot, watch};

/// Provider transport boundary. The UI consumes provider lines plus common
/// process lifecycle events; a future Codex adapter can reuse this envelope.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Started {
        #[serde(rename = "processId")]
        process_id: String,
    },
    Claude {
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

pub enum Input {
    User {
        line: String,
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
    /// Approving a plan ends plan mode; otherwise Claude keeps planning, with any feedback.
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
