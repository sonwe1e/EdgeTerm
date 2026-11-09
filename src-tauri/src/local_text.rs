//! Bounded local text editing, with the same optimistic hash contract as SFTP.
use crate::{
    error::{AppError, ErrorCode, Result},
    project::{
        apply_eol, decode_log_window, eol_of, log_window_bounds, sha256_hex, LogWindow, TextFile,
        TextWrite, WriteOutcome,
    },
};
use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Mutex,
    time::UNIX_EPOCH,
};

const LIMIT: usize = 4 * 1024 * 1024;
static WRITES: Mutex<()> = Mutex::new(());

fn bytes(path: &Path) -> Result<Vec<u8>> {
    // A FIFO can block in open itself. Inspect the path first, then use a
    // nonblocking open and inspect the handle too so a replacement between
    // those steps cannot turn the editor into an unbounded pipe reader.
    let path_metadata = fs::metadata(path)?;
    if !path_metadata.is_file() || path_metadata.len() > LIMIT as u64 {
        return Err(AppError::invalid_input(
            "the editor opens regular text files up to 4 MiB",
        ));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        return Err(AppError::invalid_input(
            "the editor opens regular text files up to 4 MiB",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the selected file changed before it could be opened",
            ));
        }
    }
    let mut result = Vec::new();
    file.take((LIMIT + 1) as u64).read_to_end(&mut result)?;
    if result.len() > LIMIT {
        return Err(AppError::invalid_input("file exceeds 4 MiB"));
    }
    Ok(result)
}

pub fn read(path: &str) -> Result<TextFile> {
    let path = fs::canonicalize(path)?;
    let bytes = bytes(&path)?;
    let bom = bytes.starts_with(&[0xef, 0xbb, 0xbf]);
    let text = std::str::from_utf8(&bytes[if bom { 3 } else { 0 }..]).map_err(|_| {
        AppError::invalid_input("this local file is not UTF-8; open it in an external editor")
    })?;
    if text.contains('\0') {
        return Err(AppError::invalid_input(
            "binary files cannot be edited as text",
        ));
    }
    Ok(TextFile {
        path: path.to_string_lossy().into_owned(),
        content: text.into(),
        hash: sha256_hex(&bytes),
        size: bytes.len() as u64,
        encoding: "UTF-8".into(),
        eol: eol_of(text).into(),
        bom,
        modified_at: None,
        permissions: None,
    })
}

/// Local counterpart of the SSH log reader. The 4 MiB editor limit remains
/// untouched: a 100 GiB log still costs at most one 256 KiB allocation.
pub fn read_log_window(
    path: &str,
    anchor: Option<u64>,
    before: bool,
    encoding: Option<&str>,
) -> Result<LogWindow> {
    let path = fs::canonicalize(path)?;
    // Reject special files before opening: a named FIFO opened for reading
    // may block indefinitely even though the viewer promises a bounded read.
    let path_metadata = fs::metadata(&path)?;
    if !path_metadata.is_file() {
        return Err(AppError::invalid_input("select a regular text file"));
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(&path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::invalid_input("select a regular text file"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if path_metadata.dev() != metadata.dev() || path_metadata.ino() != metadata.ino() {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "the selected file changed before it could be opened",
            ));
        }
    }
    let size = metadata.len();
    let (start, end) = log_window_bounds(size, anchor, before);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((end - start) as usize);
    file.take(end - start).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != end - start {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "the log changed during this read; reload the latest window",
        ));
    }
    let (content, start, end, encoding) = decode_log_window(&bytes, start, size, None, encoding)?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64);
    Ok(LogWindow {
        path: path.to_string_lossy().into_owned(),
        start,
        end,
        size,
        content,
        encoding,
        modified_at,
    })
}

pub fn write(request: TextWrite) -> Result<WriteOutcome> {
    // Serialize our own writers; check external modifications again just before
    // replacement. Filesystems do not provide a cross-process hash-CAS rename.
    let _lock = WRITES.lock().map_err(AppError::new)?;
    let path = fs::canonicalize(&request.path)?;
    let previous = bytes(&path)?;
    let hash = sha256_hex(&previous);
    if request.expected_hash.as_deref() != Some(&hash) {
        return Err(AppError::coded(
            ErrorCode::Conflict,
            "file changed on disk; reload or save your draft elsewhere",
        ));
    }
    if request
        .encoding
        .as_deref()
        .is_some_and(|encoding| !encoding.eq_ignore_ascii_case("utf-8"))
    {
        return Err(AppError::invalid_input("local text editing requires UTF-8"));
    }
    let text = apply_eol(&request.content, &request.eol);
    let mut data = if request.bom {
        vec![0xef, 0xbb, 0xbf]
    } else {
        Vec::new()
    };
    data.extend_from_slice(text.as_bytes());
    if data.len() > LIMIT || data.contains(&0) {
        return Err(AppError::invalid_input("save requires text up to 4 MiB"));
    }
    let temp = path
        .parent()
        .ok_or_else(|| AppError::invalid_input("missing parent"))?
        .join(format!(".edgeterm-{}.edit", uuid::Uuid::new_v4()));
    let mut created = false;
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&temp)?;
        created = true;
        output.write_all(&data)?;
        output.sync_all()?;
        output.set_permissions(fs::metadata(&path)?.permissions())?;
        drop(output);
        if sha256_hex(&bytes(&path)?) != hash {
            return Err(AppError::coded(
                ErrorCode::Conflict,
                "file changed while saving; original left in place",
            ));
        }
        replace(&temp, &path)?;
        Ok(WriteOutcome {
            path: path.to_string_lossy().into_owned(),
            hash: sha256_hex(&data),
            size: data.len() as u64,
            backup: None,
            temp: None,
            uncertain: false,
            note: String::new(),
        })
    })();
    if result.is_err() && created {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn replace(from: &Path, to: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // ReplaceFile preserves the original file's ACL, attributes and streams.
        // SAFETY: paths are valid nul-terminated UTF-16 for the duration of the call.
        if unsafe {
            ReplaceFileW(
                to.as_ptr(),
                from.as_ptr(),
                std::ptr::null(),
                0,
                std::ptr::null(),
                std::ptr::null(),
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(from, to)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn editor_rejects_fifo_without_waiting_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        const CHILD_FIFO: &str = "EDGETERM_EDITOR_FIFO_TEST_PATH";
        if let Some(path) = std::env::var_os(CHILD_FIFO) {
            let path = Path::new(&path);
            assert!(read(path.to_str().unwrap()).is_err());
            fs::write(path.with_extension("checked"), b"rejected").unwrap();
            return;
        }

        let dir = std::env::temp_dir().join(format!("edgeterm-edit-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("pipe.txt");
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a live, NUL-terminated path in this test's directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        // Run the potentially blocking call in a child, not a detached
        // thread: an old implementation is killed and reaped deterministically.
        let mut child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("local_text::tests::editor_rejects_fifo_without_waiting_for_a_writer")
            .env(CHILD_FIFO, &path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let completed = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status.success();
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                child.wait().unwrap();
                break false;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let checked = path.with_extension("checked").exists();
        fs::remove_dir_all(&dir).unwrap();
        assert!(completed && checked, "a FIFO must be rejected before opening it");
    }

    #[test]
    fn roundtrip_preserves_bom_crlf_and_refuses_external_change() {
        let dir = std::env::temp_dir().join(format!("edgeterm-edit-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("config.txt");
        fs::write(&path, b"\xef\xbb\xbfhello\r\n").unwrap();
        let file = read(path.to_str().unwrap()).unwrap();
        let request = TextWrite {
            path: file.path,
            content: "changed\n".into(),
            expected_hash: Some(file.hash),
            eol: file.eol,
            bom: file.bom,
            force: false,
            encoding: Some(file.encoding),
        };
        write(request.clone()).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"\xef\xbb\xbfchanged\r\n");
        assert_eq!(write(request).unwrap_err().code, ErrorCode::Conflict);
        fs::write(&path, b"binary\0content").unwrap();
        assert!(read(path.to_str().unwrap()).is_err());
        fs::write(&path, vec![b'x'; LIMIT + 1]).unwrap();
        assert!(read(path.to_str().unwrap()).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
