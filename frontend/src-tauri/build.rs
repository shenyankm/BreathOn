fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "load_training_preference",
            "save_training_preference",
            "load_visit_draft",
            "save_visit_draft",
        ]),
    ))
    .expect("failed to build BreathOn");
}
