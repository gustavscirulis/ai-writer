//! Wait for each live frontend's feedback write queue before destroying it.
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[derive(Default)]
struct Pending {
    ready: HashSet<String>,
    waiting: HashMap<String, u64>,
    closing: HashSet<String>,
    quitting: bool,
    exit_allowed: bool,
    request_id: u64,
}

#[derive(Debug, PartialEq)]
enum Completion {
    Ignore,
    Wait,
    Resume,
    Close,
    Exit,
}

impl Pending {
    fn start(&mut self, quitting: bool) -> Vec<String> {
        self.request_id += 1;
        self.quitting = quitting;
        let labels: Vec<_> = if quitting {
            self.ready.iter().cloned().collect()
        } else {
            self.closing.intersection(&self.ready).cloned().collect()
        };
        self.waiting = labels
            .iter()
            .map(|label| (label.clone(), self.request_id))
            .collect();
        labels
    }
    fn cancel(&mut self) {
        self.waiting.clear();
        self.closing.clear();
        self.quitting = false;
    }
    fn acknowledge(&mut self, label: &str, request_id: u64, success: bool) -> Completion {
        if self.waiting.get(label) != Some(&request_id) {
            return Completion::Ignore;
        }
        self.waiting.remove(label);
        if !success {
            self.cancel();
            return Completion::Resume;
        }
        let close = self.closing.remove(label) && !self.quitting;
        if self.quitting && self.waiting.is_empty() {
            self.exit_allowed = true;
            Completion::Exit
        } else if close {
            Completion::Close
        } else {
            Completion::Wait
        }
    }
}

#[derive(Default)]
pub struct FeedbackPersistence(Mutex<Pending>);

#[tauri::command]
pub fn feedback_persistence_ready(window: tauri::WebviewWindow, app: tauri::AppHandle) {
    let state = app.state::<FeedbackPersistence>();
    let mut pending = state.0.lock().unwrap();
    let label = window.label().to_owned();
    pending.ready.insert(label.clone());
    let request_id = pending.request_id;
    let join = pending.quitting;
    if join {
        pending.waiting.insert(label.clone(), request_id);
    }
    drop(pending);
    if join
        && app
            .emit_to(&label, "feedback:flush-before-close", request_id)
            .is_err()
    {
        abandon(&app, request_id);
    }
}

fn send_requests(app: &tauri::AppHandle, labels: Vec<String>, request_id: u64) {
    for label in labels {
        if app
            .emit_to(&label, "feedback:flush-before-close", request_id)
            .is_err()
        {
            abandon(app, request_id);
            break;
        }
    }
}

/// Returns true if normal close must wait for the frontend acknowledgment.
pub fn request_close(app: &tauri::AppHandle, label: &str) -> bool {
    let state = app.state::<FeedbackPersistence>();
    let mut pending = state.0.lock().unwrap();
    if !pending.ready.contains(label) {
        return false;
    }
    pending.closing.insert(label.to_owned());
    if pending.quitting || pending.waiting.contains_key(label) {
        return true;
    }
    let labels = pending.start(false);
    let request_id = pending.request_id;
    drop(pending);
    send_requests(app, labels, request_id);
    true
}

pub fn request_exit(app: &tauri::AppHandle) -> bool {
    let state = app.state::<FeedbackPersistence>();
    let mut pending = state.0.lock().unwrap();
    if pending.exit_allowed || pending.ready.is_empty() {
        return false;
    }
    if pending.quitting {
        return true;
    }
    let labels = pending.start(true);
    let request_id = pending.request_id;
    drop(pending);
    send_requests(app, labels, request_id);
    true
}

fn abandon(app: &tauri::AppHandle, request_id: u64) {
    let state = app.state::<FeedbackPersistence>();
    let mut pending = state.0.lock().unwrap();
    if pending.request_id != request_id {
        return;
    }
    pending.cancel();
    drop(pending);
    let _ = app.emit("feedback:resume-after-close", request_id);
}

#[tauri::command]
pub fn feedback_persistence_ack(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    request_id: u64,
    success: bool,
) {
    let state = app.state::<FeedbackPersistence>();
    let mut pending = state.0.lock().unwrap();
    let completion = pending.acknowledge(window.label(), request_id, success);
    drop(pending);
    match completion {
        Completion::Resume => {
            let _ = app.emit("feedback:resume-after-close", request_id);
        }
        Completion::Exit => app.exit(0),
        Completion::Close => {
            #[cfg(target_os = "macos")]
            if window.label() == crate::MAIN_WINDOW_LABEL {
                let _ = window.hide();
                let _ = window.emit("feedback:resume-after-close", request_id);
                return;
            }
            let _ = window.destroy();
        }
        Completion::Ignore | Completion::Wait => {}
    }
}

pub fn remove(app: &tauri::AppHandle, label: &str) {
    let state = app.state::<FeedbackPersistence>();
    let mut pending = state.0.lock().unwrap();
    pending.ready.remove(label);
    let cancel = pending.waiting.contains_key(label);
    let request_id = pending.request_id;
    pending.closing.remove(label);
    drop(pending);
    if cancel {
        abandon(app, request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready() -> Pending {
        Pending {
            ready: ["main", "other"].map(str::to_owned).into(),
            ..Pending::default()
        }
    }
    #[test]
    fn quit_requires_every_windows_successful_acknowledgment() {
        let mut p = ready();
        p.start(true);
        assert_eq!(p.acknowledge("main", 1, true), Completion::Wait);
        assert!(!p.exit_allowed);
        assert_eq!(p.acknowledge("main", 1, true), Completion::Ignore);
        assert_eq!(p.acknowledge("other", 1, true), Completion::Exit);
        assert!(p.exit_allowed);
    }
    #[test]
    fn failure_cancels_entire_round_and_old_ack_cannot_authorize_retry() {
        let mut p = ready();
        p.start(true);
        assert_eq!(p.acknowledge("main", 1, false), Completion::Resume);
        assert!(p.waiting.is_empty());
        p.start(true);
        assert_eq!(p.acknowledge("other", 1, true), Completion::Ignore);
        assert_eq!(p.acknowledge("main", 2, true), Completion::Wait);
        assert!(!p.exit_allowed);
        assert_eq!(p.acknowledge("other", 2, true), Completion::Exit);
    }
    #[test]
    fn individual_close_destroys_only_the_acknowledged_window() {
        let mut p = ready();
        p.closing.insert("other".into());
        p.start(false);
        assert_eq!(p.acknowledge("main", 1, true), Completion::Ignore);
        assert_eq!(p.acknowledge("other", 1, true), Completion::Close);
        assert!(p.closing.is_empty());
    }
}
