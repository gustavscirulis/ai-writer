use super::{AgentEvent, AgentProcess, Input};
use crate::{error::AppError, state::AppState};
use std::{path::PathBuf, process::Stdio, sync::OnceLock, time::Duration};
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

async fn run_process(
    mut child: Child,
    mut input: mpsc::Receiver<Input>,
    mut cancel: watch::Receiver<bool>,
    finished: watch::Sender<bool>,
    events: Channel<AgentEvent>,
) {
    let group_id = child.id();
    let mut stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let out_events = events.clone();
    let out = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if out_events.send(AgentEvent::Claude { line }).is_err() {
                break;
            }
        }
    });
    let err_events = events.clone();
    let err = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(message)) = lines.next_line().await {
            if err_events.send(AgentEvent::Stderr { message }).is_err() {
                break;
            }
        }
    });
    let status = loop {
        tokio::select! {
            biased;
            _ = cancel.changed() => { kill_group(&mut child); break child.wait().await; }
            status = child.wait() => {
                // Root may exit while tool descendants still own the pipe ends.
                // Kill the group using the captured pid in the natural-exit path below.
                break status;
            }
            next = input.recv() => {
                let Some(next) = next else { kill_group(&mut child); break child.wait().await; };
                let bytes = format!("{}\n", next.line);
                let write = tokio::select! {
                    biased;
                    _ = cancel.changed() => Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "Claude stopped")),
                    result = stdin.write_all(bytes.as_bytes()) => result,
                };
                let failed = write.is_err();
                let _ = next.ack.send(write.map_err(|e| e.to_string()));
                if failed { kill_group(&mut child); break child.wait().await; }
            }
        }
    };
    #[cfg(unix)]
    if let Some(pid) = group_id {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    // Draining readers preserves final assistant/session events before Exit.
    let _ = out.await;
    let _ = err.await;
    let _ = events.send(AgentEvent::Exit {
        code: status.ok().and_then(|s| s.code()),
    });
    let _ = finished.send(true);
}

#[tauri::command]
pub async fn claude_start(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    root: String,
    epoch: u64,
    resume_session_id: Option<String>,
    on_event: Channel<AgentEvent>,
) -> Result<String, AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    let agent_epoch = workspace
        .agent_epoch
        .load(std::sync::atomic::Ordering::SeqCst);
    let (binary, path) = resolve_claude_env().await?;
    // Native getters wait for the main loop: never call one under state locks.
    if !webview
        .is_visible()
        .map_err(|e| AppError::Io(e.to_string()))?
    {
        return Err(AppError::Io(
            "Chat startup canceled because the window is closed".into(),
        ));
    }
    let root = PathBuf::from(root);
    workspace.with_workspace_snapshot(&root, epoch, || {
        let mut slot = workspace.agent.lock();
        if workspace.agent_epoch.load(std::sync::atomic::Ordering::SeqCst) != agent_epoch { return Err(AppError::Io("Chat startup was canceled".into())); }
        if let Some(process) = slot.as_ref() {
            if !*process.finished.borrow() { return Err(AppError::Io("A chat process is already active".into())); }
        }
        let mut command = Command::new(binary);
        command.current_dir(&root).env("PATH", path)
            .env_remove("CLAUDECODE")
            .args(["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "acceptEdits", "--permission-prompts", "host", "--permission-prompt-tool", "stdio", "--append-system-prompt", "You are assisting a writer in a Markdown editor. The user message includes the open file and selection. Edit files on disk with your tools when asked. Preserve frontmatter and formatting unless asked to change them. Report which files you changed."])
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        if let Some(session) = resume_session_id { command.args(["--resume", &session]); }
        let child = command.spawn()?;
        let (tx, rx) = mpsc::channel(1);
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (finished_tx, finished_rx) = watch::channel(false);
        let id = uuid::Uuid::new_v4().to_string();
        *slot = Some(AgentProcess { id: id.clone(), input: tx, cancel: cancel_tx, finished: finished_rx });
        tauri::async_runtime::spawn(run_process(child, rx, cancel_rx, finished_tx, on_event));
        Ok(id)
    }).ok_or(AppError::NoWorkspace)?
}

#[tauri::command]
pub async fn claude_send(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
    line: String,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    let tx = {
        let slot = workspace.agent.lock();
        let process = slot
            .as_ref()
            .filter(|p| p.id == process_id)
            .ok_or_else(|| AppError::Io("Chat process is no longer active".into()))?;
        process.input.clone()
    };
    let (ack, result) = oneshot::channel();
    tx.send(Input { line, ack })
        .await
        .map_err(|_| AppError::Io("Claude Code exited".into()))?;
    result
        .await
        .map_err(|_| AppError::Io("Claude Code exited".into()))?
        .map_err(AppError::Io)
}

#[tauri::command]
pub async fn claude_stop(
    webview: WebviewWindow,
    state: State<'_, AppState>,
    process_id: String,
) -> Result<(), AppError> {
    let workspace = state.get(webview.label()).ok_or(AppError::NoWorkspace)?;
    let mut finished = {
        let slot = workspace.agent.lock();
        let Some(process) = slot.as_ref().filter(|p| p.id == process_id) else {
            return Ok(());
        };
        process.stop();
        process.finished.clone()
    };
    if !*finished.borrow() {
        let _ = finished.changed().await;
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
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
        let task = tokio::spawn(run_process(child, rx, cancel_rx, finished, events));
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
        ));
        let (ack, outcome) = oneshot::channel();
        input
            .send(Input {
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
        *state.agent.lock() = Some(AgentProcess {
            id: "old".into(),
            input,
            cancel,
            finished: completion,
        });
        state.stop_agent();
        assert!(*cancellation.borrow());
        assert!(state.agent.lock().is_some());
        assert_eq!(
            state.agent_epoch.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
    }
}
