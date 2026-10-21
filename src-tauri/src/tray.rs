//! The system tray behind "minimize to tray" (the front end's
//! `CloseAction::Tray`; Windows and macOS only — see `HAS_TRAY` in
//! platform.ts).
//!
//! The tray carries three entries: Open (show + focus the main window), a
//! checkable "Minimize to tray" that mirrors the front end's `closeAction`
//! setting, and Quit, which asks the front end the same way the macOS ⌘Q
//! menu does — the confirm-and-exit decision lives in one place (App.tsx).
//! A left click on the icon itself is Open; the menu is the right click.
//!
//! The check item is flipped from both sides: a click on it flips itself and
//! tells the front end through `EVENT_CLOSE_TO_TRAY_CHANGED`, and a change
//! from the front end (settings, import, the choice dialog's "remember")
//! arrives through `set_close_to_tray`. Neither side holds the other's
//! state, and the mirrored write is idempotent, so the two cannot loop.

use tauri::AppHandle;
use tauri::Manager;

/// The tray's check item was flipped; the payload is the new state.
pub const EVENT_CLOSE_TO_TRAY_CHANGED: &str = "app:close-to-tray-changed";

const MENU_OPEN: &str = "tray-open";
const MENU_TOGGLE: &str = "tray-toggle";
const MENU_QUIT: &str = "tray-quit";

/// The check item's handle, kept out of the menu so a click on the entry can
/// flip it and `set_close_to_tray` can follow the front end's setting.
struct TrayToggle(tauri::menu::CheckMenuItem<tauri::Wry>);

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;
    use tauri::{Emitter, Manager};

    let handle = app.handle();
    let open = MenuItem::with_id(handle, MENU_OPEN, "Open EdgeTerm", true, None::<&str>)?;
    let toggle = CheckMenuItem::with_id(
        handle,
        MENU_TOGGLE,
        "Minimize to tray",
        true,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(handle, MENU_QUIT, "Quit EdgeTerm", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&open, &toggle, &quit])?;
    app.manage(TrayToggle(toggle));

    let icon = app
        .default_window_icon()
        .expect("the bundled window icon doubles as the tray icon")
        .clone();
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("EdgeTerm")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|handle, event| match event.id().as_ref() {
            MENU_OPEN => reveal(handle),
            MENU_TOGGLE => {
                let state = handle.state::<TrayToggle>();
                let next = !state.0.is_checked().unwrap_or(false);
                let _ = state.0.set_checked(next);
                let _ = handle.emit(EVENT_CLOSE_TO_TRAY_CHANGED, next);
            }
            // Same route as the macOS ⌘Q menu: the front end confirms live
            // sessions and exits itself (see `onQuitRequested`).
            MENU_QUIT => {
                let _ = handle.emit("app:quit-requested", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                reveal(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Shows, un-minimizes and focuses the main window: Open on the tray, the
/// left-click restore, and the single-instance handler's restore path.
pub fn reveal(handle: &AppHandle) {
    if let Some(window) = handle.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Follows the front end's setting; the flip itself lives in the menu event.
pub fn set_close_to_tray(app: &AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<TrayToggle>() {
        let _ = state.0.set_checked(enabled);
    }
}
