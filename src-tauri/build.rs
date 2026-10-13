fn main() {
    tauri_build::build();
    // Library tests that exercise background jobs link Tauri's Windows UI
    // imports too. Unlike the application, those executables have no .rc
    // manifest; select Common Controls v6 so TaskDialogIndirect can load.
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'");
        // The application already embeds Tauri's full manifest in resource.lib.
        println!("cargo:rustc-link-arg-bin=edgeterm=/MANIFEST:NO");
    }
}
