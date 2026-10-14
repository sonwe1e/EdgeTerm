//! Actual Tauri command argument dispatch into real SSH engines, in MockRuntime.
//! This does not simulate the desktop WebView or access the user's store.
use crate::{
    commands::{self, AppState},
    model::SessionKind,
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{
    test::{mock_builder, mock_context, noop_assets, MockRuntime},
    Manager,
};
fn invoke(
    window: &tauri::WebviewWindow<MockRuntime>,
    cmd: &str,
    args: Value,
) -> std::result::Result<Value, Value> {
    tauri::test::get_ipc_response(
        window,
        tauri::webview::InvokeRequest {
            cmd: cmd.into(),
            callback: tauri::ipc::CallbackFn(0),
            error: tauri::ipc::CallbackFn(1),
            url: "http://tauri.localhost".parse().unwrap(),
            body: tauri::ipc::InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: tauri::test::INVOKE_KEY.into(),
        },
    )
    .map(|body| body.deserialize::<Value>().unwrap())
}
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "dedicated loopback OpenSSH fixture; actual Tauri dispatch with isolated store"]
async fn real_ssh_diff_monitor_and_forward_cross_tauri_ipc() {
    let var = |key: &str| std::env::var(key).unwrap();
    let address = var("EDGETERM_REAL_SSH_ADDR");
    let (host, port) = address.rsplit_once(':').unwrap();
    let port: u16 = port.parse().unwrap();
    let scratch =
        std::env::temp_dir().join(format!("edgeterm-feature-ipc-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&scratch).unwrap();
    let transport = crate::session::ssh::test_transport(
        host,
        port,
        &var("EDGETERM_REAL_SSH_USER"),
        &var("EDGETERM_REAL_SSH_KEY"),
        &scratch.join("known_hosts"),
    )
    .await;
    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.host = Some(host.into());
    profile.port = Some(port);
    profile.username = Some(var("EDGETERM_REAL_SSH_USER"));
    let state = AppState {
        sessions: Default::default(),
        outputs: Default::default(),
        store: crate::store::Store::load_from(scratch.join("profiles.json")),
        remote_edits: Default::default(),
        auth_prompts: Default::default(),
        file_transfers: Default::default(),
        file_diffs: Default::default(),
        resource_monitor: Default::default(),
        port_forwards: Default::default(),
        ssh_transports: Default::default(),
    };
    state.file_transfers.remember("fixture", &profile);
    state.ssh_transports.register("fixture", &transport);
    let app = mock_builder()
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            commands::compare_files,
            commands::cancel_file_diff,
            commands::sample_resources,
            commands::cancel_resource_sample,
            commands::start_port_forward,
            commands::list_port_forwards,
            commands::stop_port_forward,
            commands::remove_port_forward,
            commands::discover_listening_ports,
            commands::cancel_port_discovery,
            commands::close_session
        ])
        .build(mock_context(noop_assets()))
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let text = "IPC 你好\r\nlast\n";
    let local = scratch.join("local.txt");
    std::fs::write(&local, text).unwrap();
    let remote = format!(
        "{}/ipc-{}.txt",
        var("EDGETERM_REAL_SSH_ROOT"),
        uuid::Uuid::new_v4()
    );
    let raw = russh_sftp::client::RawSftpSession::new(transport.transfer_channel().await.unwrap());
    raw.init().await.unwrap();
    let handle = raw
        .open(
            &remote,
            russh_sftp::protocol::OpenFlags::WRITE
                | russh_sftp::protocol::OpenFlags::CREATE
                | russh_sftp::protocol::OpenFlags::TRUNCATE,
            russh_sftp::protocol::FileAttributes::empty(),
        )
        .await
        .unwrap()
        .handle;
    raw.write(&handle, 0, text.as_bytes().to_vec())
        .await
        .unwrap();
    raw.close(&handle).await.unwrap();
    let diff=invoke(&window,"compare_files",json!({"id":"fixture","requestId":"ipc-diff","local":local.to_str().unwrap(),"remote":remote})).unwrap();
    assert_eq!(diff["bytesEqual"], true);
    assert_eq!(diff["rows"].as_array().unwrap().len(), 2);
    let sample = invoke(
        &window,
        "sample_resources",
        json!({"id":"fixture","requestId":"ipc-sample"}),
    )
    .unwrap();
    assert_eq!(sample["status"], "ok");
    assert!(sample["cpuPercent"].is_null());
    assert!(sample["memory"]["totalBytes"].as_u64().unwrap() > 0);
    let scan = invoke(
        &window,
        "discover_listening_ports",
        json!({"id":"fixture","requestId":"ipc-ports"}),
    )
    .unwrap();
    assert_eq!(scan["status"], "ok");
    assert!(scan["ports"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["port"] == port));
    let row=invoke(&window,"start_port_forward",json!({"id":"fixture","spec":{"direction":"local","listenHost":"127.0.0.1","listenPort":0,"targetHost":"127.0.0.1","targetPort":port}})).unwrap();
    let id = row["id"].as_str().unwrap();
    let ready = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let rows = invoke(&window, "list_port_forwards", json!({})).unwrap();
            let row = &rows[0];
            if row["status"] != "starting" {
                break row.clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(ready["owner"], "fixture");
    assert_eq!(ready["status"], "listening");
    assert_eq!(ready["spec"]["direction"], "local");
    assert!(invoke(&window, "remove_port_forward", json!({"id":id})).is_err());
    invoke(&window, "stop_port_forward", json!({"id":id})).unwrap();
    invoke(&window, "remove_port_forward", json!({"id":id})).unwrap();
    assert!(invoke(&window, "list_port_forwards", json!({}))
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    invoke(
        &window,
        "cancel_file_diff",
        json!({"requestId":"early-diff"}),
    )
    .unwrap();
    assert!(invoke(&window,"compare_files",json!({"id":"fixture","requestId":"early-diff","local":local.to_str().unwrap(),"remote":remote})).is_err());
    raw.remove(&remote).await.unwrap();
    raw.close_session().unwrap();
    invoke(&window, "close_session", json!({"id":"fixture"})).unwrap();
    assert!(app
        .state::<AppState>()
        .ssh_transports
        .get("fixture")
        .is_none());
    assert!(invoke(
        &window,
        "sample_resources",
        json!({"id":"fixture","requestId":"closed-sample"})
    )
    .is_err());
    assert!(invoke(&window,"start_port_forward",json!({"id":"fixture","spec":{"direction":"local","listenHost":"127.0.0.1","listenPort":0,"targetHost":"127.0.0.1","targetPort":port}})).is_err());
    println!("production Tauri dispatch + real OpenSSH: diff UTF-8/CRLF, monitor, discovery, forwarding lifecycle, cancellation, closed owner passed");
    drop(window);
    drop(app);
    drop(transport);
    std::fs::remove_dir_all(scratch).unwrap();
}
