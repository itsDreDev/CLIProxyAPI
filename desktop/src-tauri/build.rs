fn main() {
    let target = std::env::var("TARGET").expect("Cargo supplies TARGET");
    println!("cargo:rustc-env=SUBSCRIPTION_TARGET={target}");
    if std::env::var_os("CARGO_FEATURE_DESKTOP").is_some() {
        let manifest = tauri_build::AppManifest::new().commands(&[
            "get_status",
            "start_proxy",
            "stop_proxy",
            "use_local",
            "connect_remote",
            "open_dashboard",
            "copy_management_key",
        ]);
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
            .expect("Failed to build native application configuration");
    }
}
