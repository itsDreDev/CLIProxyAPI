use crate::core::{self, ProcessManager, Profile, Status};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_opener::OpenerExt;

struct DesktopState {
    manager: Mutex<core::Result<ProcessManager>>,
    quitting: AtomicBool,
}

fn controls_only(window: &WebviewWindow, app: &AppHandle) -> core::Result<()> {
    let url = window
        .url()
        .map_err(|_| "Could not verify the controls window.")?;
    let development = if cfg!(debug_assertions) {
        app.config().build.dev_url.as_ref()
    } else {
        None
    };
    if window.label() != "main" || !core::trusted_controls_url(&url, development) {
        return Err("Native controls are available only to the bundled controls window.".into());
    }
    Ok(())
}

fn with_manager<T>(
    state: &DesktopState,
    action: impl FnOnce(&mut ProcessManager) -> core::Result<T>,
) -> core::Result<T> {
    let mut guard = state
        .manager
        .lock()
        .map_err(|_| "The proxy controls are unavailable.")?;
    let manager = guard.as_mut().map_err(|error| error.clone())?;
    action(manager)
}

fn sidecar_path() -> core::Result<PathBuf> {
    let executable =
        std::env::current_exe().map_err(|_| "Could not locate the desktop application.")?;
    let name = if cfg!(windows) {
        "subscription-desk-proxy.exe"
    } else {
        "subscription-desk-proxy"
    };
    if let Some(parent) = executable.parent() {
        let path = parent.join(name);
        if path.is_file() {
            return Ok(path);
        }
    }
    if cfg!(debug_assertions) {
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "subscription-desk-proxy-{}{suffix}",
                env!("SUBSCRIPTION_TARGET")
            ));
        if path.is_file() {
            return Ok(path);
        }
    }
    Err(
        "The bundled proxy is missing. Reinstall the application or prepare the desktop sidecar."
            .into(),
    )
}

fn emit_status(app: &AppHandle, status: &Status) {
    let _ = app.emit_to("main", "proxy-status", status);
}

#[tauri::command]
fn get_status(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> core::Result<Status> {
    controls_only(&window, &app)?;
    with_manager(&state, |manager| Ok(manager.status()))
}

async fn start_owned(app: AppHandle) -> core::Result<Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_manager(&app.state::<DesktopState>(), |manager| {
            manager.start(&sidecar_path()?)
        });
        if let Ok(status) = &result {
            emit_status(&app, status);
        }
        result
    })
    .await
    .map_err(|_| "The proxy start task failed.".to_owned())?
}

#[tauri::command]
async fn start_proxy(window: WebviewWindow, app: AppHandle) -> core::Result<Status> {
    controls_only(&window, &app)?;
    start_owned(app).await
}

async fn stop_owned(app: AppHandle) -> core::Result<Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = with_manager(&app.state::<DesktopState>(), |manager| manager.stop());
        if let Ok(status) = &result {
            emit_status(&app, status);
        }
        result
    })
    .await
    .map_err(|_| "The proxy stop task failed.".to_owned())?
}

#[tauri::command]
async fn stop_proxy(window: WebviewWindow, app: AppHandle) -> core::Result<Status> {
    controls_only(&window, &app)?;
    stop_owned(app).await
}

#[tauri::command]
fn connect_remote(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, DesktopState>,
    origin: String,
) -> core::Result<Status> {
    controls_only(&window, &app)?;
    let status = with_manager(&state, |manager| manager.connect_remote(&origin))?;
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
fn use_local(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> core::Result<Status> {
    controls_only(&window, &app)?;
    let status = with_manager(&state, |manager| Ok(manager.use_local()))?;
    emit_status(&app, &status);
    Ok(status)
}

#[tauri::command]
fn copy_management_key(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> core::Result<()> {
    controls_only(&window, &app)?;
    let key = with_manager(&state, |manager| manager.key_for_copy())?;
    app.clipboard()
        .write_text(key)
        .map_err(|_| "Could not copy the management key to the system clipboard.".into())
}

fn show_controls(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

async fn show_dashboard(app: AppHandle) -> core::Result<()> {
    let url = with_manager(&app.state::<DesktopState>(), |manager| {
        manager.dashboard_url()
    })?;
    if let Some(window) = app.get_webview_window("dashboard") {
        if window
            .url()
            .map_err(|_| "Could not inspect the dashboard origin.")?
            .origin()
            == url.origin()
        {
            window.show().map_err(|_| "Could not show the dashboard.")?;
            window
                .set_focus()
                .map_err(|_| "Could not focus the dashboard.")?;
            return Ok(());
        }
        window
            .destroy()
            .map_err(|_| "Could not switch the dashboard host.")?;
    }
    let origin = url.origin();
    let browser = app.clone();
    WebviewWindowBuilder::new(&app, "dashboard", WebviewUrl::External(url))
        .title("Subscription Desk · Accounts")
        .inner_size(1440.0, 960.0)
        .min_inner_size(700.0, 600.0)
        .incognito(true)
        .on_navigation(move |url| url.origin() == origin)
        .on_new_window(move |url, _features| {
            if core::provider_sign_in_url(&url) {
                let _ = browser.opener().open_url(url.as_str(), None::<&str>);
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
        .map_err(|_| "Could not create the dashboard window.")?;
    Ok(())
}

#[tauri::command]
async fn open_dashboard(window: WebviewWindow, app: AppHandle) -> core::Result<()> {
    controls_only(&window, &app)?;
    show_dashboard(app).await
}

fn tray_error(app: &AppHandle, error: String) {
    let _ = with_manager(&app.state::<DesktopState>(), |manager| {
        manager.record_error(error.clone());
        Ok(())
    });
    show_controls(app);
    let _ = app.emit_to("main", "desktop-error", error);
}

pub fn run() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_proxy,
            stop_proxy,
            use_local,
            connect_remote,
            open_dashboard,
            copy_management_key
        ])
        .setup(|app| {
            let directory = app.path().app_data_dir()?.join("proxy");
            app.manage(DesktopState {
                manager: Mutex::new(Profile::load(directory).map(ProcessManager::new)),
                quitting: AtomicBool::new(false),
            });
            let dashboard =
                MenuItem::with_id(app, "dashboard", "Show Dashboard", true, None::<&str>)?;
            let controls = MenuItem::with_id(app, "controls", "Show Controls", true, None::<&str>)?;
            let start = MenuItem::with_id(app, "start", "Start Proxy", true, None::<&str>)?;
            let stop = MenuItem::with_id(app, "stop", "Stop Proxy", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&dashboard, &controls, &start, &stop, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Subscription Desk")
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "controls" => show_controls(app),
                    "dashboard" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = show_dashboard(handle.clone()).await {
                                tray_error(&handle, error);
                            }
                        });
                    }
                    "start" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = start_owned(handle.clone()).await {
                                tray_error(&handle, error);
                            }
                        });
                    }
                    "stop" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = stop_owned(handle.clone()).await {
                                tray_error(&handle, error);
                            }
                        });
                    }
                    "quit" => {
                        app.state::<DesktopState>()
                            .quitting
                            .store(true, Ordering::SeqCst);
                        let _ =
                            with_manager(&app.state::<DesktopState>(), |manager| manager.stop());
                        app.exit(0);
                    }
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!());
    let application = match application {
        Ok(application) => application,
        Err(error) => {
            eprintln!("Could not initialize Subscription Desk: {error}");
            return;
        }
    };
    application.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. }
            if !app.state::<DesktopState>().quitting.load(Ordering::SeqCst) =>
        {
            api.prevent_exit()
        }
        tauri::RunEvent::Exit => {
            let _ = with_manager(&app.state::<DesktopState>(), |manager| manager.stop());
        }
        _ => {}
    });
}
