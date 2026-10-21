use super::*;

/// Remembers the theme the front end is showing, so the next launch creates
/// its window in the matching background colour (`store::save_startup_theme`).
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn set_startup_theme(theme: Theme) -> Result<()> {
    store::save_startup_theme(theme)
}

/// Shows the main window once the frontend has committed its first render.
/// Windows keeps it DWM-cloaked until two animation frames have run; the
/// native timeouts still reveal it if the frontend never acknowledges.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn show_main_window(window: tauri::WebviewWindow) -> Result<()> {
    // The frontend committed its first render: the launch's page is ready.
    // `gpu_fallback` only counts acknowledgements inside its time window, so
    // a page that arrives after the crashed browser process was relaunched
    // does not pass as healthy.
    #[cfg(target_os = "windows")]
    crate::gpu_fallback::mark_ready();
    window.show().map_err(err)?;
    #[cfg(target_os = "windows")]
    {
        // A cloaked HWND is visible to WebView2, which can now paint and
        // drive requestAnimationFrame without exposing the bare background.
        // Some WebView2/DWM combinations may throttle cloaked windows, so
        // never make the JS acknowledgement the only way to reveal it.
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(500));
            crate::reveal_main_window(&window);
        });
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = window.set_focus();
        Ok(())
    }
}

/// Hides the main window without destroying it: the "minimize to tray" path
/// (the close-choice dialog and the `CloseAction::Tray` setting). Sessions,
/// transfers and the whole process keep running; the tray (see `tray.rs`)
/// brings the window back.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn hide_main_window(window: tauri::WebviewWindow) -> Result<()> {
    window.hide().map_err(err)
}

/// Mirrors the front end's `closeAction` setting onto the tray's check item,
/// so both sides show one state. The flip from the tray's own side arrives as
/// the `app:close-to-tray-changed` event instead (see `tray.rs`).
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn set_close_to_tray(window: tauri::WebviewWindow, enabled: bool) -> Result<()> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        use tauri::Manager;
        crate::tray::set_close_to_tray(window.app_handle(), enabled);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = (window, enabled);
    Ok(())
}

/// Windows: reveal the painted WebView2 window after two visible animation
/// frames. The native timeout above covers a stalled compositor or JS error.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn finish_main_window(window: tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    crate::reveal_main_window(&window);
    #[cfg(not(target_os = "windows"))]
    let _ = window;
}

/// The clipboard's text, read by the process rather than the page. On macOS
/// this is the paste path (#47): WebKit lets a page read the pasteboard only
/// from inside its own paste command (⌘V, Edit → Paste on the system menu)
/// and answers any other gesture with a "Paste" confirmation menu the user
/// has to click, so a paste key the user chose could not read it from the
/// page. Elsewhere the page reads its own clipboard
/// (`navigator.clipboard.readText`), and the window is created with
/// `enable_clipboard_access` so WebView2 grants that; but a WebView2 profile
/// that refused the permission prompt before the app granted it keeps
/// refusing (the refusal is stored per origin and the prompt is not raised
/// again), so on Windows the front end falls back to this (#45). Empty when
/// the clipboard holds no text, as the page's read is.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn read_clipboard_text() -> Result<String> {
    #[cfg(windows)]
    {
        if !clipboard_win::is_format_avail(clipboard_win::formats::CF_UNICODETEXT) {
            return Ok(String::new());
        }
        clipboard_win::get_clipboard_string().map_err(err)
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        let text =
            NSPasteboard::generalPasteboard().stringForType(unsafe { NSPasteboardTypeString });
        Ok(text.map(|text| text.to_string()).unwrap_or_default())
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Err("the page reads the clipboard on this platform".into())
    }
}

/// Puts text on the clipboard from the process, for a program in a terminal
/// that set it with OSC 52 (#65). That write arrives with the program's
/// output, never inside a click or key press, and WebKit lets a page write
/// the pasteboard only from inside a user gesture; WebView2 wants the page
/// focused. On Linux the page writes it itself: `enable_clipboard_access`
/// sets WebKitGTK's javascript-can-access-clipboard, which lifts the
/// gesture requirement there.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn write_clipboard_text(text: String) -> Result<()> {
    #[cfg(windows)]
    {
        clipboard_win::set_clipboard_string(&text).map_err(err)
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        use objc2_foundation::NSString;
        let pasteboard = NSPasteboard::generalPasteboard();
        pasteboard.clearContents();
        if pasteboard.setString_forType(&NSString::from_str(&text), unsafe {
            NSPasteboardTypeString
        }) {
            Ok(())
        } else {
            Err("the pasteboard refused the text".into())
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = text;
        Err("the page writes the clipboard on this platform".into())
    }
}

/// Brings the mouse pointer back, for the moment before a native dialog
/// opens.
///
/// macOS hides the pointer while the user types: WebKit asks AppKit for
/// `setHiddenUntilMouseMoves:` on every keystroke that lands in an editable
/// area, and a terminal is one, so the pointer is gone the instant a command
/// is typed. AppKit lifts that at the next mouse-moved event *this* process
/// handles, which is why it is never noticed — the pointer is back before
/// the hand is. A file panel breaks that: its window delivers no mouse-moved
/// events to us, so the flag stays set and the panel has no pointer at all
/// for as long as it is up. `rz` is where it hurts, since the panel opens
/// straight off the command the user just typed, and the file to send then
/// has to be picked blind.
///
/// Clearing the flag costs nothing when the pointer is already visible, so
/// every native dialog goes through it (see `nativeDialog.ts`). Elsewhere
/// this is a no-op: Windows hides the pointer while typing through the
/// system setting, which restores it on the next mouse move wherever it is.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn show_pointer(window: tauri::WebviewWindow) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        // AppKit, so the main thread; a command is not promised to run on it.
        window
            .run_on_main_thread(|| objc2_app_kit::NSCursor::setHiddenUntilMouseMoves(false))
            .map_err(err)?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    Ok(())
}

/// Whether this copy runs in portable mode (a `data` directory next to the
/// executable holds all configuration). The updater must not run the NSIS
/// installer then; the front end opens the release page instead.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn portable_mode() -> bool {
    crate::store::portable_data_dir().is_some()
}

/// Shows the Windows "Open with" chooser for a local file. Other platforms
/// have no system-wide chooser; the front end picks an application itself.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn open_with_dialog(path: String) -> Result<()> {
    #[cfg(windows)]
    {
        // The shell's classic entry point behind Explorer's "Open with…".
        std::process::Command::new("rundll32.exe")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(&path)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(AppError::new(
            "the system \"Open with\" dialog is only available on Windows",
        ))
    }
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn list_serial_ports() -> Result<Vec<SerialPortDesc>> {
    session::serial::list_ports()
}
