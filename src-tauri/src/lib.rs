mod db;
mod model;
mod reminders;
mod sync;

use db::Database;
use model::{Change, Result, Settings, Snapshot};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, State,
};
use tauri_plugin_autostart::ManagerExt;

pub struct RuntimeState {
    paused: AtomicBool,
    open: MenuItem<tauri::Wry>,
    pause: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window
            .show()
            .and_then(|_| window.unminimize())
            .and_then(|_| window.set_focus())
        {
            eprintln!("Cannot open main window: {error}");
        }
    }
}
fn apply_settings(app: &AppHandle, settings: &Settings) -> Result<()> {
    let manager = app.autolaunch();
    let enabled = manager.is_enabled().map_err(|e| e.to_string())?;
    if enabled != settings.autostart {
        if settings.autostart {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[tauri::command]
fn load_snapshot(database: State<'_, Database>) -> Result<Snapshot> {
    database.snapshot()
}
#[tauri::command]
fn load_changes(database: State<'_, Database>) -> Result<Vec<Change>> {
    database.changes()
}
#[tauri::command]
fn commit_changes(
    app: AppHandle,
    database: State<'_, Database>,
    changes: Vec<Change>,
    settings: Option<Settings>,
) -> Result<()> {
    database.commit(&changes, settings.as_ref(), |s| apply_settings(&app, s))?;
    if let Some(settings) = settings {
        refresh_menu(&app, &settings.language);
    }
    Ok(())
}
#[tauri::command]
fn import_snapshot(
    app: AppHandle,
    database: State<'_, Database>,
    snapshot: Snapshot,
    changes: Vec<Change>,
) -> Result<()> {
    database.import(&snapshot, &changes, |s| apply_settings(&app, s))?;
    refresh_menu(&app, &snapshot.settings.language);
    Ok(())
}
#[tauri::command]
async fn configure_sync(
    app: AppHandle,
    url: Option<String>,
    token: Option<String>,
) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<sync::SyncState>().configure(url, token)
    })
    .await
    .map_err(|_| "Cannot configure reminder synchronization".to_string())?
}
fn labels(language: &str) -> (&'static str, &'static str, &'static str, &'static str) {
    match language {
        "zh-TW" => ("開啟 CProject", "暫停所有提醒", "恢復提醒", "結束"),
        "ja" => (
            "CProject を開く",
            "リマインダーを一時停止",
            "リマインダーを再開",
            "終了",
        ),
        _ => (
            "Open CProject",
            "Pause reminders",
            "Resume reminders",
            "Quit",
        ),
    }
}
fn refresh_menu(app: &AppHandle, language: &str) {
    let state = app.state::<RuntimeState>();
    let (open, pause, resume, quit) = labels(language);
    for (item, label) in [
        (&state.open, open),
        (
            &state.pause,
            if state.paused.load(Ordering::Relaxed) {
                resume
            } else {
                pause
            },
        ),
        (&state.quit, quit),
    ] {
        if let Err(error) = item.set_text(label) {
            eprintln!("Cannot update tray label: {error}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app)
        }))
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations(
                    "sqlite:cproject.db",
                    vec![tauri_plugin_sql::Migration {
                        version: 1,
                        description: "initial entities and audit log",
                        sql: include_str!("../migrations/001_initial.sql"),
                        kind: tauri_plugin_sql::MigrationKind::Up,
                    }],
                )
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .arg("--from-autostart")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            load_snapshot,
            load_changes,
            commit_changes,
            import_snapshot,
            configure_sync
        ])
        .setup(|app| {
            // tauri-plugin-sql maps sqlite URLs to app_config_dir, not app_data_dir.
            let directory = app.path().app_config_dir()?;
            std::fs::create_dir_all(&directory)?;
            let database =
                Database::open(&directory.join("cproject.db")).map_err(std::io::Error::other)?;
            let settings = database.settings().map_err(std::io::Error::other)?;
            apply_settings(app.handle(), &settings).map_err(std::io::Error::other)?;
            app.manage(database);
            app.manage(sync::SyncState::new().map_err(std::io::Error::other)?);
            let (open_text, pause_text, _, quit_text) = labels(&settings.language);
            let open = MenuItem::with_id(app, "open", open_text, true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause", pause_text, true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", quit_text, true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &pause, &quit])?;
            app.manage(RuntimeState {
                paused: AtomicBool::new(false),
                open: open.clone(),
                pause: pause.clone(),
                quit: quit.clone(),
            });
            TrayIconBuilder::with_id("main-tray")
                .icon(
                    app.default_window_icon()
                        .ok_or_else(|| std::io::Error::other("Missing application icon"))?
                        .clone(),
                )
                .tooltip("CProject")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "pause" => {
                        let state = app.state::<RuntimeState>();
                        state.paused.fetch_xor(true, Ordering::Relaxed);
                        let language = app
                            .state::<Database>()
                            .settings()
                            .map(|s| s.language)
                            .unwrap_or_else(|_| "en".into());
                        refresh_menu(app, &language);
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            let handle = app.handle().clone();
            std::thread::Builder::new()
                .name("reminder-ticker".into())
                .spawn(move || loop {
                    if let Err(error) = sync::tick(&handle) {
                        eprintln!("Reminder ticker failed: {error}");
                    }
                    std::thread::sleep(std::time::Duration::from_secs(60));
                })?;
            if std::env::args().any(|arg| arg == "--from-autostart") && settings.close_to_tray {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                match window.state::<Database>().settings() {
                    Ok(settings) if settings.close_to_tray => {
                        api.prevent_close();
                        if let Err(error) = window.hide() {
                            eprintln!("Cannot hide main window: {error}");
                        }
                    }
                    Ok(_) => window.app_handle().exit(0),
                    Err(error) => {
                        api.prevent_close();
                        eprintln!("Cannot read close behavior: {error}");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("CProject desktop runtime failed");
}
