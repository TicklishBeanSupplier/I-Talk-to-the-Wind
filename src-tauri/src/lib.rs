//! Conduit's desktop shell. The app itself is the web UI in `src/`; this
//! side provides what a browser can't: the system keychain, fast file
//! access, the login listener, a tray icon, and staying alive in the
//! background so scheduled posts go out on time.

mod files;
mod oauth;
mod secrets;

use std::thread;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

/// How often the web side checks for due posts and inbox times.
const TICK: Duration = Duration::from_secs(30);

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = app.emit("conduit://resume", ());
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Conduit", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit (scheduled posts pause)", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Conduit")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Must come first: a second launch just focuses the running app,
        // so two copies can never publish the same scheduled post.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(oauth::OAuthState::default())
        .invoke_handler(tauri::generate_handler![
            files::list_dir,
            files::file_info,
            files::read_file,
            files::read_chunk,
            secrets::secret_get,
            secrets::secret_set,
            secrets::secret_delete,
            oauth::oauth_listen,
            oauth::oauth_wait,
            oauth::oauth_cancel,
        ])
        .setup(|app| {
            build_tray(app.handle())?;
            // A steady heartbeat that keeps the scheduler running even while
            // the window is hidden (web views slow their own timers then).
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(TICK);
                if handle.emit("conduit://tick", ()).is_err() {
                    break;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window hides it; the app keeps running in the tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Conduit failed to start");

    app.run(|handle, event| {
        // macOS: clicking the Dock icon brings the window back.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            show_main(handle);
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}
