use super::*;

/// Keyboard and paste input, which xterm.js hands us as a UTF-8 string; it
/// goes out in the session's own encoding.
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    state.sessions.write_text(&id, &data)
}

/// Raw bytes, base64-encoded, for ZMODEM's protocol frames; waits until
/// the session has written them (see `SessionManager::write_confirmed`).
#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn write_session_binary(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<()> {
    let bytes = B64.decode(data).map_err(err)?;
    state.sessions.write_confirmed(&id, bytes).await
}

#[derive(serde::Deserialize, Debug)]
pub(super) struct BinarySessionTarget {
    pub(super) id: String,
}

#[derive(serde::Deserialize, Debug)]
pub(super) struct BinaryFileTarget {
    pub(super) path: String,
    pub(super) offset: u64,
}

pub(super) fn binary_metadata<T: serde::de::DeserializeOwned>(encoded: &str) -> Result<T> {
    let bytes = B64.decode(encoded).map_err(err)?;
    serde_json::from_slice(&bytes).map_err(err)
}

/// The metadata header and the raw body of a binary invoke, split out so
/// the decoding can be tested on its own: `tauri::ipc::Request` has no
/// public constructor, so a test cannot build one. `binary_request` stays
/// a thin adapter over this.
pub(super) fn binary_request_parts<T: serde::de::DeserializeOwned>(
    metadata: Option<&tauri::http::HeaderValue>,
    body: &tauri::ipc::InvokeBody,
) -> Result<(T, Vec<u8>)> {
    let encoded = metadata
        .ok_or_else(|| AppError::new("missing binary metadata"))?
        .to_str()
        .map_err(err)?;
    let target = binary_metadata(encoded)?;
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok((target, bytes.clone())),
        _ => Err(AppError::new("expected a raw binary body")),
    }
}

pub(super) fn binary_request<T: serde::de::DeserializeOwned>(
    request: &tauri::ipc::Request<'_>,
) -> Result<(T, Vec<u8>)> {
    binary_request_parts(request.headers().get("x-edgeterm-metadata"), request.body())
}

/// Preserve write confirmation/backpressure while avoiding base64 payloads.
#[tauri::command]
pub async fn write_session_bytes(
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<()> {
    let (target, bytes) = binary_request::<BinarySessionTarget>(&request)?;
    state.sessions.write_confirmed(&target.id, bytes).await
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub fn resize_session(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
    state
        .sessions
        .send(&id, SessionCommand::Resize { cols, rows })
}

/// Keep file IPC bounded. zmodem.js further divides outgoing data into 8 KiB
/// protocol subpackets and XMODEM into 128 / 1024-byte blocks, while this
/// larger application-level chunk keeps the number of disk and IPC round
/// trips reasonable. The frontend shares these commands between the two
/// protocols (terminalTransfer.ts).
pub(super) const ZMODEM_FILE_CHUNK_SIZE: usize = 1024 * 1024;

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn zmodem_file_info(path: String) -> Result<ZmodemFileInfo> {
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() {
        return Err(AppError::new(format!("not a regular file: {path}")));
    }

    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::new(format!("file has no usable name: {path}")))?
        .to_string();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());

    Ok(ZmodemFileInfo {
        name,
        size: metadata.len(),
        modified,
    })
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn zmodem_read_chunk(path: String, offset: u64, length: u32) -> Result<String> {
    Ok(B64.encode(read_transfer_bytes(path, offset, length).await?))
}

#[tauri::command]
pub async fn zmodem_read_bytes(
    path: String,
    offset: u64,
    length: u32,
) -> Result<tauri::ipc::Response> {
    Ok(tauri::ipc::Response::new(
        read_transfer_bytes(path, offset, length).await?,
    ))
}

pub(super) async fn read_transfer_bytes(path: String, offset: u64, length: u32) -> Result<Vec<u8>> {
    let length = length as usize;
    if length == 0 || length > ZMODEM_FILE_CHUNK_SIZE {
        return Err(AppError::new(format!(
            "ZMODEM read length must be between 1 and {ZMODEM_FILE_CHUNK_SIZE} bytes"
        )));
    }

    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut bytes = Vec::with_capacity(length);
    file.take(length as u64).read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn zmodem_create_file(path: String) -> Result<()> {
    let file = tokio::fs::File::create(path).await?;
    file.sync_all().await?;
    Ok(())
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn zmodem_write_chunk(path: String, offset: u64, data: String) -> Result<()> {
    let bytes = B64.decode(data).map_err(err)?;
    write_transfer_bytes(path, offset, &bytes).await
}

#[tauri::command]
pub async fn zmodem_write_bytes(request: tauri::ipc::Request<'_>) -> Result<()> {
    let (target, bytes) = binary_request::<BinaryFileTarget>(&request)?;
    write_transfer_bytes(target.path, target.offset, &bytes).await
}

pub(super) async fn write_transfer_bytes(path: String, offset: u64, bytes: &[u8]) -> Result<()> {
    if bytes.len() > ZMODEM_FILE_CHUNK_SIZE {
        return Err(AppError::new(format!(
            "ZMODEM write chunk exceeds {ZMODEM_FILE_CHUNK_SIZE} bytes"
        )));
    }

    let mut file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    file.write_all(bytes).await?;
    // Tokio may still have the write queued when write_all returns. Wait
    // before acknowledging the chunk or dropping its last file handle.
    file.flush().await?;
    Ok(())
}

#[tauri::command]
#[cfg_attr(feature = "bindings", specta::specta)]
pub async fn zmodem_finish_file(path: String, size: u64) -> Result<()> {
    let file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
    file.set_len(size).await?;
    file.sync_all().await?;
    Ok(())
}

#[cfg(test)]
mod binary_transfer_tests {
    use super::*;

    struct TempFile(String);
    impl TempFile {
        fn new() -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("edgeterm-传输-{}.bin", uuid::Uuid::new_v4()))
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }
    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[test]
    fn binary_metadata_preserves_unicode_paths_and_rejects_invalid_offsets() {
        let encoded = B64.encode(
            serde_json::to_vec(&serde_json::json!({
                "path": "C:\\测试\\é #%.bin", "offset": 1048576
            }))
            .unwrap(),
        );
        let target: BinaryFileTarget = binary_metadata(&encoded).unwrap();
        assert_eq!(target.path, "C:\\测试\\é #%.bin");
        assert_eq!(target.offset, 1048576);
        for bad in [
            "!".to_string(),
            B64.encode(br#"{"path":"a","offset":-1}"#),
            B64.encode(br#"{"path":"a","offset":1.5}"#),
            B64.encode(b"{}"),
        ] {
            assert!(binary_metadata::<BinaryFileTarget>(&bad).is_err());
        }
    }

    fn metadata_header(value: &serde_json::Value) -> tauri::http::HeaderValue {
        tauri::http::HeaderValue::from_str(&B64.encode(serde_json::to_vec(value).unwrap())).unwrap()
    }

    /// The frontend test mocks `invoke`, so it can only prove the shape the
    /// webview sends; these cases are the Rust side of the same boundary.
    #[test]
    fn binary_request_parts_decodes_the_metadata_and_keeps_the_body_bytes() {
        let header = metadata_header(&serde_json::json!({
            "path": "C:\\测试\\é #%.bin", "offset": 1048576
        }));
        let body = tauri::ipc::InvokeBody::Raw(vec![0, 128, 255, 0, 159]);
        let (target, bytes) =
            binary_request_parts::<BinaryFileTarget>(Some(&header), &body).unwrap();
        assert_eq!(target.path, "C:\\测试\\é #%.bin");
        assert_eq!(target.offset, 1048576);
        assert_eq!(bytes, vec![0, 128, 255, 0, 159]);
    }

    #[test]
    fn binary_request_parts_rejects_a_missing_or_unreadable_header() {
        let body = tauri::ipc::InvokeBody::Raw(vec![1]);
        let missing = binary_request_parts::<BinaryFileTarget>(None, &body).unwrap_err();
        assert!(missing.to_string().contains("missing binary metadata"));
        // Bytes 0x80 and 0x81 are legal in a header value but are not
        // visible ASCII, which is what `to_str` refuses.
        let opaque = tauri::http::HeaderValue::from_bytes(&[0x80, 0x81]).unwrap();
        let unreadable =
            binary_request_parts::<BinaryFileTarget>(Some(&opaque), &body).unwrap_err();
        assert!(!unreadable.to_string().is_empty());
    }

    #[test]
    fn binary_request_parts_rejects_metadata_that_is_not_the_target_shape() {
        let body = tauri::ipc::InvokeBody::Raw(vec![1]);
        for bad in [
            B64.encode(b"!"),
            B64.encode(br#"{"path":"a","offset":-1}"#),
            B64.encode(br#"{"path":"a","offset":1.5}"#),
            B64.encode(b"{}"),
            B64.encode(br#"{"path":7,"offset":1}"#),
            B64.encode(br#"{"path":"a"}"#),
        ] {
            let header = tauri::http::HeaderValue::from_str(&bad).unwrap();
            assert!(
                binary_request_parts::<BinaryFileTarget>(Some(&header), &body).is_err(),
                "{bad} must not decode"
            );
        }
    }

    #[test]
    fn binary_request_parts_rejects_a_body_that_is_not_raw() {
        let header = metadata_header(&serde_json::json!({"path": "a", "offset": 0}));
        // A JSON body is what a command without the binary fast path gets.
        let body = tauri::ipc::InvokeBody::Json(serde_json::json!({"path": "a"}));
        let error = binary_request_parts::<BinaryFileTarget>(Some(&header), &body).unwrap_err();
        assert!(error.to_string().contains("expected a raw binary body"));
    }

    #[tokio::test]
    async fn raw_file_chunks_round_trip_all_bytes_offsets_eof_and_truncation() {
        let file = TempFile::new();
        zmodem_create_file(file.0.clone()).await.unwrap();
        let bytes: Vec<u8> = (0..ZMODEM_FILE_CHUNK_SIZE)
            .map(|i| (i % 256) as u8)
            .collect();
        write_transfer_bytes(file.0.clone(), 0, &bytes)
            .await
            .unwrap();
        write_transfer_bytes(file.0.clone(), bytes.len() as u64, &[0, 255, 128])
            .await
            .unwrap();
        assert_eq!(
            read_transfer_bytes(file.0.clone(), 0, bytes.len() as u32)
                .await
                .unwrap(),
            bytes
        );
        assert_eq!(
            read_transfer_bytes(file.0.clone(), bytes.len() as u64 - 1, 8)
                .await
                .unwrap(),
            [255, 0, 255, 128]
        );
        assert!(
            read_transfer_bytes(file.0.clone(), bytes.len() as u64 + 3, 8)
                .await
                .unwrap()
                .is_empty()
        );
        zmodem_finish_file(file.0.clone(), 2).await.unwrap();
        assert_eq!(
            read_transfer_bytes(file.0.clone(), 0, 8).await.unwrap(),
            [0, 1]
        );
        // Legacy commands still share the same validated I/O implementation.
        zmodem_write_chunk(file.0.clone(), 0, B64.encode([42, 24]))
            .await
            .unwrap();
        assert_eq!(
            zmodem_read_chunk(file.0.clone(), 0, 2).await.unwrap(),
            B64.encode([42, 24])
        );
    }

    #[test]
    fn file_chunk_write_returns_after_bytes_are_visible_to_a_new_reader() {
        // Exercise a busy blocking pool with real, independent files. No time
        // threshold: the contract is visibility after the write was acknowledged.
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .max_blocking_threads(1)
            .enable_all()
            .build()
            .unwrap()
            .block_on(async {
                let tasks: Vec<_> = (1..=8)
                    .map(|value| {
                        tokio::spawn(async move {
                            let file = TempFile::new();
                            std::fs::write(&file.0, vec![0; 1024 * 1024]).unwrap();
                            let expected = vec![value; 1024 * 1024];
                            write_transfer_bytes(file.0.clone(), 0, &expected)
                                .await
                                .unwrap();
                            assert!(
                                std::fs::read(&file.0).unwrap() == expected,
                                "a completed chunk write must be visible to another reader"
                            );
                        })
                    })
                    .collect();
                for task in tasks {
                    task.await.unwrap();
                }
            });
    }

    #[tokio::test]
    async fn raw_file_io_keeps_chunk_bounds_and_disk_errors() {
        let file = TempFile::new();
        assert!(read_transfer_bytes(file.0.clone(), 0, 0).await.is_err());
        assert!(
            read_transfer_bytes(file.0.clone(), 0, ZMODEM_FILE_CHUNK_SIZE as u32 + 1)
                .await
                .is_err()
        );
        assert!(
            write_transfer_bytes(file.0.clone(), 0, &vec![0; ZMODEM_FILE_CHUNK_SIZE + 1])
                .await
                .is_err()
        );
        assert!(read_transfer_bytes(file.0.clone(), 0, 1).await.is_err());
        assert!(write_transfer_bytes(file.0.clone(), 0, &[1]).await.is_err());
        zmodem_create_file(file.0.clone()).await.unwrap();
        zmodem_finish_file(file.0.clone(), 0).await.unwrap();
        assert!(read_transfer_bytes(file.0.clone(), 0, 1)
            .await
            .unwrap()
            .is_empty());
    }
}
