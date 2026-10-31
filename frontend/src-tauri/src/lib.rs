mod preferences;

use tauri::Manager;

fn packaged_page(url: &tauri::Url, debug: bool) -> bool {
    url.path() == "/_android/index.html"
        && url.username().is_empty()
        && url.password().is_none()
        && ((url.scheme() == "https"
            && url.host_str() == Some("openwook.cloud")
            && url.port_or_known_default() == Some(443))
            || (debug
                && url.scheme() == "http"
                && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))))
}

fn check_page(window: &tauri::WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|_| "无法核对本机页面")?;
    if window.label() != "main" || !packaged_page(&url, cfg!(debug_assertions)) {
        return Err("当前页面无权访问本机练习偏好".into());
    }
    Ok(())
}

fn preference_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|_| "无法访问本机存储")?;
    std::fs::create_dir_all(&directory).map_err(|_| "无法访问本机存储")?;
    Ok(directory.join("breathon.sqlite3"))
}

#[tauri::command]
fn load_training_preference(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    account: String,
) -> Result<Option<String>, String> {
    check_page(&window)?;
    preferences::load(&preference_path(&app)?, &account)
}

#[tauri::command]
fn save_training_preference(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    account: String,
    experience: String,
) -> Result<(), String> {
    check_page(&window)?;
    preferences::save(&preference_path(&app)?, &account, &experience)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "android")]
            {
                let capability = tauri::ipc::CapabilityBuilder::new("training-preferences")
                    .window("main")
                    // Tauri classifies the frontendDist origin as local, including external URLs.
                    .local(true)
                    .remote("https://openwook.cloud/_android/index.html".into())
                    .permission("allow-load-training-preference")
                    .permission("allow-save-training-preference");
                #[cfg(debug_assertions)]
                let capability = capability
                    .remote("http://127.0.0.1:*/_android/index.html".into())
                    .remote("http://localhost:*/_android/index.html".into());
                app.add_capability(capability)?;
            }
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_training_preference,
            save_training_preference
        ])
        .run(tauri::generate_context!())
        .expect("error while running BreathOn");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_packaged_pages_can_access_preferences() {
        assert!(packaged_page(
            &tauri::Url::parse("https://openwook.cloud/_android/index.html#home").unwrap(),
            false
        ));
        for url in [
            "https://openwook.cloud/admin",
            "https://openwook.cloud/_android/other.html",
            "https://evil.example/_android/index.html",
            "https://openwook.cloud:444/_android/index.html",
            "https://user@openwook.cloud/_android/index.html",
            "http://openwook.cloud/_android/index.html",
            "http://192.168.1.1/_android/index.html",
        ] {
            assert!(
                !packaged_page(&tauri::Url::parse(url).unwrap(), true),
                "{url}"
            );
        }
        for host in ["127.0.0.1", "localhost"] {
            let url =
                tauri::Url::parse(&format!("http://{host}:5188/_android/index.html")).unwrap();
            assert!(packaged_page(&url, true));
            assert!(!packaged_page(&url, false));
        }
    }
}
