//! The local listener that catches the browser's redirect after logging in
//! to Meta or Google. One login at a time; starting a new one cancels the old.

use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::State;

const MAX_WAIT: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(50);

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Conduit</title>\
<body style=\"font-family:system-ui,sans-serif;background:#1A4BB5;color:#F4F7FC;display:grid;place-items:center;height:100vh;margin:0\">\
<div style=\"text-align:center\"><h1 style=\"margin:0 0 8px\">You're connected.</h1><p>You can close this tab and go back to Conduit.</p></div>";

#[derive(Default)]
pub struct OAuthState {
    pending: Mutex<Option<Pending>>,
}

struct Pending {
    /// Taken by `oauth_wait`; the stop switch stays so `oauth_cancel` still works.
    rx: Option<Receiver<String>>,
    stop: Arc<AtomicBool>,
}

impl OAuthState {
    /// End any login in progress. Its listener thread exits, which also
    /// wakes a waiting `oauth_wait` with "cancelled".
    fn stop_current(&self) {
        if let Some(p) = self.pending.lock().ok().and_then(|mut g| g.take()) {
            p.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Start listening. Port 0 picks any free port. Returns the port in use.
#[tauri::command]
pub fn oauth_listen(state: State<'_, OAuthState>, port: u16) -> Result<u16, String> {
    state.stop_current();

    let v4 = TcpListener::bind(("127.0.0.1", port)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("Port {port} is busy. Close any other login window and try again.")
        } else {
            format!("Couldn't start the login listener: {e}")
        }
    })?;
    let actual = v4.local_addr().map_err(|e| e.to_string())?.port();
    // "localhost" can resolve to IPv6 first; listen there too when possible.
    let v6 = TcpListener::bind(("::1", actual)).ok();

    let mut listeners = vec![v4];
    listeners.extend(v6);
    for l in &listeners {
        l.set_nonblocking(true).map_err(|e| e.to_string())?;
    }

    let (tx, rx) = mpsc::channel();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    thread::spawn(move || {
        let started = Instant::now();
        while !stop_thread.load(Ordering::Relaxed) && started.elapsed() < MAX_WAIT {
            for l in &listeners {
                if let Ok((stream, _)) = l.accept() {
                    if let Some(target) = handle(stream) {
                        let _ = tx.send(target);
                        return;
                    }
                }
            }
            thread::sleep(POLL);
        }
    });

    *state.pending.lock().map_err(|e| e.to_string())? = Some(Pending { rx: Some(rx), stop });
    Ok(actual)
}

/// Read one HTTP request. Returns its path and query if it's the login redirect.
fn handle(stream: TcpStream) -> Option<String> {
    stream.set_nonblocking(false).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let target = line.split_whitespace().nth(1)?.to_string();

    let mut stream = reader.into_inner();
    let is_redirect = target.contains("code=") || target.contains("error=");
    let (status, body) = if is_redirect { ("200 OK", DONE_PAGE) } else { ("404 Not Found", "") };
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
    is_redirect.then_some(target)
}

/// Wait for the redirect started by `oauth_listen`.
#[tauri::command]
pub async fn oauth_wait(state: State<'_, OAuthState>, timeout_sec: u64) -> Result<String, String> {
    let (rx, stop) = {
        let mut guard = state.pending.lock().map_err(|e| e.to_string())?;
        let p = guard.as_mut().ok_or("No login is in progress.")?;
        (p.rx.take().ok_or("This login is already being waited on.")?, p.stop.clone())
    };
    let result = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(timeout_sec)))
        .await
        .map_err(|e| e.to_string())?;
    // Stop only this login's listener, never a newer one.
    stop.store(true, Ordering::Relaxed);
    match result {
        Ok(target) => Ok(target),
        Err(RecvTimeoutError::Timeout) => Err("The login timed out. Please try again.".into()),
        Err(RecvTimeoutError::Disconnected) => Err("Login was cancelled.".into()),
    }
}

#[tauri::command]
pub fn oauth_cancel(state: State<'_, OAuthState>) {
    state.stop_current();
}
