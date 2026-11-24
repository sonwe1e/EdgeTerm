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

use std::sync::Mutex;

use tauri::AppHandle;
use tauri::Manager;

/// The tray's check item was flipped; the payload is the new state.
pub const EVENT_CLOSE_TO_TRAY_CHANGED: &str = "app:close-to-tray-changed";

/// The three entries' text. The front end sends them so the menu speaks the
/// interface's language: this is the only surface left when the window is
/// parked in the tray, and it carries the app's only Quit entry.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayLabels {
    pub open: String,
    pub toggle: String,
    pub quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            open: "Open EdgeTerm".to_string(),
            toggle: "Minimize to tray".to_string(),
            quit: "Quit EdgeTerm".to_string(),
        }
    }
}

const MENU_OPEN: &str = "tray-open";
const MENU_TOGGLE: &str = "tray-toggle";
const MENU_QUIT: &str = "tray-quit";

/// The check item's handle, kept out of the menu so a click on the entry can
/// flip it and `set_close_to_tray` can follow the front end's setting. It is
/// replaced when the menu is rebuilt in another language.
struct TrayToggle(Mutex<tauri::menu::CheckMenuItem<tauri::Wry>>);

/// Builds the menu from `labels`, returning it with the check item the caller
/// keeps: a rebuild in another language needs both.
fn build_menu(
    handle: &AppHandle,
    labels: &TrayLabels,
) -> tauri::Result<(
    tauri::menu::Menu<tauri::Wry>,
    tauri::menu::CheckMenuItem<tauri::Wry>,
)> {
    use tauri::menu::{CheckMenuItem, Menu, MenuItem};
    let open = MenuItem::with_id(handle, MENU_OPEN, &labels.open, true, None::<&str>)?;
    let toggle = CheckMenuItem::with_id(
        handle,
        MENU_TOGGLE,
        &labels.toggle,
        true,
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(handle, MENU_QUIT, &labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&open, &toggle, &quit])?;
    Ok((menu, toggle))
}

/// Rebuilds the menu with another language's text. The click handler lives on
/// the tray icon rather than the menu, so replacing the menu keeps it working.
pub fn set_labels(app: &AppHandle, labels: &TrayLabels) {
    let Ok((menu, toggle)) = build_menu(app, labels) else {
        return;
    };
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_menu(Some(menu));
    }
    if let Some(state) = app.try_state::<TrayToggle>() {
        if let Ok(mut current) = state.0.lock() {
            // Carry the state across the rebuild. A fresh CheckMenuItem starts
            // unchecked, so without this the tray reports the feature as off
            // on every start and every language switch while the app still
            // hides to tray on close.
            let previous = current.is_checked().unwrap_or(false);
            let _ = toggle.set_checked(previous);
            *current = toggle;
        }
    }
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    use tauri::tray::TrayIconBuilder;
    use tauri::{Emitter, Manager};

    let handle = app.handle();
    // English until the front end says otherwise: it sends the interface's own
    // words as soon as the window is up (see `set_tray_labels`).
    let (menu, toggle) = build_menu(handle, &TrayLabels::default())?;
    app.manage(TrayToggle(Mutex::new(toggle)));

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
                let Ok(toggle) = state.0.lock() else {
                    return;
                };
                let next = !toggle.is_checked().unwrap_or(false);
                let _ = toggle.set_checked(next);
                let _ = handle.emit(EVENT_CLOSE_TO_TRAY_CHANGED, next);
            }
            // Same route as the macOS ⌘Q menu: the front end confirms live
            // sessions and exits itself (see `onQuitRequested`).
            MENU_QUIT => {
                // Reveal first. With close-to-tray on, the window is parked and
                // this entry is the app's only exit; the quit guard opens a
                // confirmation when work is live, and that dialog has to be
                // somewhere the reader can see it.
                reveal(handle);
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
        if let Ok(toggle) = state.0.lock() {
            let _ = toggle.set_checked(enabled);
        }
    }
}
