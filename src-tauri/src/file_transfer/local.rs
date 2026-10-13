use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use ring::digest::{Context, SHA256};
use serde::{Deserialize, Serialize};

use super::{Control, Failure, TransferResult};
use crate::session::transfer::validate_local_file_target;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signature {
    pub size: u64,
    pub modified: Option<u128>,
    pub sample: String,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn digest(bytes: &[u8]) -> String {
    hex(ring::digest::digest(&SHA256, bytes).as_ref())
}

pub fn signature(path: &Path) -> TransferResult<Signature> {
    let mut file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(Failure::conflict("source is not a regular file"));
    }
    let mut context = Context::new(&SHA256);
    let mut buf = vec![0; 64 * 1024];
    for offset in [0, meta.len().saturating_sub(buf.len() as u64)] {
        file.seek(SeekFrom::Start(offset))?;
        let count = file.read(&mut buf)?;
        context.update(&buf[..count]);
    }
    Ok(Signature {
        size: meta.len(),
        modified: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_nanos()),
        sample: hex(context.finish().as_ref()),
    })
}

pub fn target_signature(path: &Path) -> TransferResult<Option<Signature>> {
    validate_local_file_target(path).map_err(|e| Failure::conflict(e.to_string()))?;
    match std::fs::symlink_metadata(path) {
        Ok(_) => signature(path).map(Some),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Rebuild the digest only from the confirmed prefix, never from file length.
pub fn prefix(path: &Path, length: u64, control: &Control) -> TransferResult<Context> {
    let mut file = std::fs::File::open(path)?;
    let mut context = Context::new(&SHA256);
    let mut remaining = length;
    let mut buf = vec![0; 1024 * 1024];
    while remaining > 0 {
        control.check()?;
        let take = remaining.min(buf.len() as u64) as usize;
        file.read_exact(&mut buf[..take])?;
        context.update(&buf[..take]);
        remaining -= take as u64;
    }
    Ok(context)
}

pub async fn prefix_async(
    path: &Path,
    length: u64,
    control: &std::sync::Arc<Control>,
) -> TransferResult<Context> {
    let path = path.to_path_buf();
    let control = control.clone();
    tokio::task::spawn_blocking(move || prefix(&path, length, &control))
        .await
        .map_err(Failure::local)?
}

pub fn normalize(path: &str) -> TransferResult<String> {
    let path = Path::new(path);
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(parent
        .canonicalize()?
        .join(
            path.file_name()
                .ok_or_else(|| Failure::conflict("invalid local filename"))?,
        )
        .to_string_lossy()
        .into())
}

pub fn sibling(path: &Path, id: &str, suffix: &str) -> TransferResult<PathBuf> {
    let parent = path
        .parent()
        .ok_or_else(|| Failure::conflict("target has no parent"))?;
    // Short names also work when the real target is near the filesystem's name limit.
    Ok(parent.join(format!(".edgeterm-{id}.{suffix}")))
}

pub fn create_partial(path: &Path) -> TransferResult<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?;
    Ok(())
}

/// Same-volume replacement. Never unlink the old destination first.
pub fn replace(from: &Path, to: &Path) -> TransferResult<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: both paths are nul-terminated and live through the call.
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(from, to)?;
    Ok(())
}

pub fn save_json(path: &Path, value: &impl Serialize) -> TransferResult<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| Failure::local(e.to_string()))?;
    let staging = path.with_extension("json.new");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&staging)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    replace(&staging, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_failure_does_not_replace_existing_target() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("original");
        let part = sibling(&target, "test", "part").unwrap();
        std::fs::write(&target, b"original").unwrap();
        create_partial(&part).unwrap();
        std::fs::write(&part, b"incomplete").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        std::fs::write(&part, b"complete").unwrap();
        replace(&part, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"complete");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn prefix_ignores_speculative_tail_and_rejects_short_partial() {
        let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::write(&path, b"goodunconfirmed").unwrap();
        let control = Control::default();
        assert_eq!(
            hex(prefix(&path, 4, &control).unwrap().finish().as_ref()),
            digest(b"good")
        );
        assert!(prefix(&path, 100, &control).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
