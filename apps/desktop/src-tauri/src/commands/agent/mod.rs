pub mod claude;

use serde::Serialize;
use tokio::sync::{mpsc, oneshot, watch};

/// Provider transport boundary. The UI consumes provider lines plus common
/// process lifecycle events; a future Codex adapter can reuse this envelope.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentEvent {
    Claude { line: String },
    Stderr { message: String },
    Exit { code: Option<i32> },
}

pub struct Input {
    pub line: String,
    pub ack: oneshot::Sender<Result<(), String>>,
}

pub struct AgentProcess {
    pub id: String,
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
