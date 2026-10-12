pub mod claude;

use serde::Serialize;
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
    },
    Exit {
        code: Option<i32>,
    },
}

pub enum Input {
    User {
        line: String,
        ack: oneshot::Sender<Result<(), String>>,
    },
    Permission {
        request_id: String,
        allow: bool,
        ack: oneshot::Sender<Result<(), String>>,
    },
    EditReady {
        request_id: String,
        allow: bool,
        ack: oneshot::Sender<Result<(), String>>,
    },
}

pub struct AgentProcess {
    pub note: std::path::PathBuf,
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
