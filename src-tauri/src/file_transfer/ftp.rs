//! FTP jobs own a separate control connection, keeping browsing responsive.
//! A remote upload prefix is read back before APPE; TCP writes alone are not
//! treated as server-confirmed checkpoints.
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use ring::digest::{Context, SHA256};
use suppaftp::{FtpError, FtpStream};

use super::{local, Checkpoint, Control, Failure, Item, Job, TransferResult};
use crate::session::{
    ftp::{connect, connect_controlled, ensure_remote_directory, list_directory, FtpConnection},
    transfer::{ensure_local_directory, plan_local_upload_checked, safe_local_child},
};

#[cfg(test)]
#[path = "ftp_tests.rs"]
mod tests;

impl From<FtpError> for Failure {
    fn from(e: FtpError) -> Self {
        let retry = matches!(&e, FtpError::ConnectionError(_))
            || matches!(&e, FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 421 | 425 | 426 | 450 | 451 | 452));
        Failure::new(if retry { "network" } else { "remote" }, e, retry)
    }
}

pub async fn run(job: Arc<Job>) -> TransferResult<()> {
    tokio::task::spawn_blocking(move || run_blocking(&job))
        .await
        .map_err(Failure::local)?
}

fn open(job: &Job) -> TransferResult<FtpConnection> {
    job.control.check()?;
    job.phase("connecting");
    let conn = connect_controlled(&job.profile, Some(&job.control)).map_err(Failure::connection)?;
    Ok(conn)
}

fn run_blocking(job: &Job) -> TransferResult<()> {
    let mut conn = open(job)?;
    let control_socket = job.control.socket(conn.stream.get_ref())?;
    job.phase("scanning");
    let files = plan(job, &mut conn)?;
    drop(control_socket);
    drop(conn);
    let next = AtomicUsize::new(0);
    job.phase("transferring");
    // FTP needs independent control/data pairs for simultaneous files. Keep
    // this pool small to respect common per-user connection limits.
    let results = std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..job.options.files.min(2).min(files.len()) {
            workers.push(scope.spawn(|| worker(job, &files, &next)));
        }
        workers
            .into_iter()
            .map(|w| {
                w.join()
                    .unwrap_or_else(|_| Err(Failure::local("FTP worker panicked")))
            })
            .collect::<Vec<_>>()
    });
    job.control.check()?;
    let failures: Vec<_> = results.into_iter().filter_map(|r| r.err()).collect();
    if let Some(e) = failures.iter().find(|e| e.retryable).or(failures.first()) {
        Err(e.clone())
    } else {
        Ok(())
    }
}

fn worker(job: &Job, files: &[Item], next: &AtomicUsize) -> TransferResult<()> {
    let mut conn = open(job)?;
    let mut socket = job.control.socket(conn.stream.get_ref())?;
    let mut first_error = None;
    loop {
        job.control.check()?;
        let Some(item) = files.get(next.fetch_add(1, Ordering::Relaxed)) else {
            break;
        };
        let _target = tauri::async_runtime::block_on(job.lock_target(item))?;
        let result = copy(job, &mut conn.stream, item);
        if let Err(e) = result {
            job.control.check()?;
            job.failure(
                if item.upload {
                    &item.remote
                } else {
                    &item.local
                },
                &e,
            );
            if e.retryable {
                return Err(e);
            }
            if first_error.is_none() {
                first_error = Some(e);
            }
            // A failed data transfer may leave unread 426/226 replies. Rebuild
            // the control connection before using it for another file.
            drop(socket);
            conn = open(job)?;
            socket = job.control.socket(conn.stream.get_ref())?;
        }
    }
    first_error.map_or(Ok(()), Err)
}

fn plan(job: &Job, conn: &mut FtpConnection) -> TransferResult<Vec<Item>> {
    if let Some(plan) = job.plan.lock().clone() {
        return Ok(plan);
    }
    let mut files = Vec::new();
    let mut sizes = Vec::new();
    let home = conn.stream.pwd()?;
    for item in &job.items {
        job.control.check()?;
        conn.stream.cwd(&home)?;
        let directory = item.directory || (item.upload && std::fs::metadata(&item.local)?.is_dir());
        if !directory {
            sizes.push(if item.upload {
                std::fs::metadata(&item.local)?.len()
            } else {
                conn.stream.size(&item.remote)? as u64
            });
            files.push(item.clone());
            continue;
        }
        if item.upload {
            let plan = plan_local_upload_checked(Path::new(&item.local), &item.remote, || {
                job.control.check().map_err(Into::into)
            })
            .map_err(Failure::local)?;
            for dir in plan.directories {
                job.control.check()?;
                ensure_remote_directory(&mut conn.stream, &dir).map_err(Failure::local)?;
            }
            for file in plan.files {
                sizes.push(file.size);
                files.push(Item {
                    local: file.local.to_string_lossy().into(),
                    remote: file.remote,
                    directory: false,
                    upload: true,
                });
            }
        } else {
            let mut dirs = vec![(item.remote.clone(), PathBuf::from(&item.local))];
            while let Some((remote, local)) = dirs.pop() {
                job.control.check()?;
                ensure_local_directory(&local).map_err(Failure::local)?;
                for entry in list_directory(conn, &remote)
                    .map_err(Failure::network)?
                    .entries
                {
                    let child = safe_local_child(&local, &entry.name).map_err(Failure::conflict)?;
                    if entry.is_symlink && (entry.is_dir || conn.stream.size(&entry.path).is_err())
                    {
                        continue;
                    }
                    if entry.is_dir {
                        dirs.push((entry.path, child));
                    } else {
                        sizes.push(entry.size);
                        files.push(Item {
                            local: child.to_string_lossy().into(),
                            remote: entry.path,
                            upload: false,
                            directory: false,
                        });
                    }
                }
            }
        }
    }
    let mut parents = std::collections::HashMap::new();
    let mut destinations = std::collections::HashSet::new();
    for item in &mut files {
        job.control.check()?;
        item.local = local::normalize(&item.local)?;
        let (parent, name) = item
            .remote
            .rsplit_once('/')
            .unwrap_or((".", item.remote.as_str()));
        let parent = if parent.is_empty() { "/" } else { parent };
        let resolved = if let Some(path) = parents.get(parent) {
            path
        } else {
            conn.stream.cwd(&home)?;
            conn.stream.cwd(parent)?;
            parents
                .entry(parent.to_string())
                .or_insert(conn.stream.pwd()?)
        };
        item.remote = crate::session::join_remote(resolved, name);
        if !destinations.insert(super::target_key(&job.profile, item)) {
            return Err(Failure::conflict("batch contains duplicate destinations"));
        }
    }
    for (item, size) in files.iter().zip(sizes) {
        job.progress(&job.key(item), 0, size, false);
    }
    *job.plan.lock() = Some(files.clone());
    Ok(files)
}

fn signature(
    ftp: &mut FtpStream,
    path: &str,
    control: &Control,
) -> TransferResult<Option<local::Signature>> {
    control.check()?;
    let size = match ftp.size(path) {
        Ok(size) => size as u64,
        Err(FtpError::UnexpectedResponse(r)) if r.status.code() == 550 => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let modified = ftp
        .mdtm(path)
        .ok()
        .map(|v| v.and_utc().timestamp().max(0) as u128);
    // SIZE + MDTM identify an FTP source; read-back below verifies a resumed
    // upload prefix in full, including servers without checksum extensions.
    let sample = if modified.is_none() {
        remote_hash(ftp, path, control)?.1
    } else {
        String::new()
    };
    Ok(Some(local::Signature {
        size,
        modified,
        sample,
    }))
}

fn remote_hash(
    ftp: &mut FtpStream,
    path: &str,
    control: &Control,
) -> TransferResult<(u64, String)> {
    let mut stream = ftp.retr_as_stream(path)?;
    let socket = control.socket(stream.get_ref())?;
    let mut context = Context::new(&SHA256);
    let mut bytes = vec![0; 1024 * 1024];
    let mut size = 0;
    loop {
        control.check()?;
        let count = stream.read(&mut bytes)?;
        if count == 0 {
            break;
        }
        size += count as u64;
        context.update(&bytes[..count]);
    }
    drop(socket);
    ftp.finalize_retr_stream(stream)?;
    Ok((size, local::hex(context.finish().as_ref())))
}

fn copy(job: &Job, ftp: &mut FtpStream, item: &Item) -> TransferResult<()> {
    job.control.check()?;
    let key = job.key(item);
    let source = if item.upload {
        local::signature(Path::new(&item.local))?
    } else {
        signature(ftp, &item.remote, &job.control)?
            .ok_or_else(|| Failure::conflict("FTP source disappeared"))?
    };
    let mut cp = if let Some(cp) = job.checkpoint(&key) {
        if cp.source != source {
            return Err(Failure::conflict("source changed; start a new transfer"));
        }
        cp
    } else {
        let original = if item.upload {
            signature(ftp, &item.remote, &job.control)?
        } else {
            local::target_signature(Path::new(&item.local))?
        };
        let (temporary, backup) = if item.upload {
            let parent = item.remote.rsplit_once('/').map(|p| p.0).unwrap_or(".");
            (
                format!("{parent}/.edgeterm-{key}.part"),
                format!("{parent}/.edgeterm-{key}.backup"),
            )
        } else {
            (
                local::sibling(Path::new(&item.local), &key, "part")?
                    .to_string_lossy()
                    .into(),
                String::new(),
            )
        };
        let cp = Checkpoint {
            key: key.clone(),
            item: item.clone(),
            source: source.clone(),
            original,
            temporary,
            backup,
            offset: 0,
            prefix_hash: local::digest(&[]),
            complete: false,
            committing: false,
            owns_temporary: false,
            owns_backup: false,
        };
        job.save(&cp)?;
        cp
    };
    if !cp.owns_temporary {
        if item.upload {
            if signature(ftp, &cp.temporary, &job.control)?.is_some() {
                return Err(Failure::conflict("FTP partial already exists"));
            }
            let stream = ftp.put_with_stream(&cp.temporary)?;
            ftp.finalize_put_stream(stream)?;
        } else {
            local::create_partial(Path::new(&cp.temporary))?;
        }
        cp.owns_temporary = true;
        job.save(&cp)?;
    }
    job.progress(&key, cp.offset, source.size, cp.complete);
    if cp.complete {
        return Ok(());
    }
    if cp.committing {
        let missing = if item.upload {
            signature(ftp, &cp.temporary, &job.control)?.is_none()
        } else {
            !Path::new(&cp.temporary).exists()
        };
        if missing {
            let (size, hash) = if item.upload {
                remote_hash(ftp, &item.remote, &job.control)?
            } else {
                (
                    std::fs::metadata(&item.local)?.len(),
                    local::hex(
                        local::prefix(Path::new(&item.local), source.size, &job.control)?
                            .finish()
                            .as_ref(),
                    ),
                )
            };
            if size != source.size || hash != cp.prefix_hash {
                return Err(Failure::conflict("cannot verify interrupted FTP commit"));
            }
            remove_backup(ftp, &mut cp, &job.control)?;
            cp.complete = true;
            job.save(&cp)?;
            job.progress(&key, source.size, source.size, true);
            return Ok(());
        }
    }
    if item.upload {
        upload(job, ftp, &mut cp)?;
    } else {
        download(job, ftp, &mut cp)?;
    }
    let current_source = if item.upload {
        Some(local::signature(Path::new(&item.local))?)
    } else {
        signature(ftp, &item.remote, &job.control)?
    };
    if current_source.as_ref() != Some(&source) {
        return Err(Failure::conflict("source changed during FTP transfer"));
    }
    job.control.check()?;
    job.phase("committing");
    if item.upload {
        let current = signature(ftp, &item.remote, &job.control)?;
        let backup = signature(ftp, &cp.backup, &job.control)?;
        let recovering = cp.committing
            && cp.owns_backup
            && current.is_none()
            && backup == cp.original
            && backup.is_some();
        if !recovering && current != cp.original {
            return Err(Failure::conflict("FTP destination changed during transfer"));
        }
        cp.committing = true;
        job.save(&cp)?;
        if current.is_some() {
            if backup.is_some() {
                return Err(Failure::conflict("FTP backup already exists"));
            }
            cp.owns_backup = true;
            job.save(&cp)?;
            ftp.rename(&item.remote, &cp.backup)?;
        }
        if let Err(e) = ftp.rename(&cp.temporary, &item.remote) {
            if (current.is_some() || recovering)
                && matches!(signature(ftp, &item.remote, &job.control), Ok(None))
            {
                let _ = ftp.rename(&cp.backup, &item.remote);
            }
            return Err(e.into());
        }
        remove_backup(ftp, &mut cp, &job.control)?;
        cp.complete = true;
        job.save(&cp)?;
    } else {
        if local::target_signature(Path::new(&item.local))? != cp.original {
            return Err(Failure::conflict(
                "local destination changed during transfer",
            ));
        }
        if cp.original.is_some() {
            std::fs::set_permissions(&cp.temporary, std::fs::metadata(&item.local)?.permissions())?;
        }
        cp.committing = true;
        job.save(&cp)?;
        local::replace(Path::new(&cp.temporary), Path::new(&item.local))?;
        cp.complete = true;
        job.save(&cp)?;
    }
    job.progress(&key, source.size, source.size, true);
    Ok(())
}

fn download(job: &Job, ftp: &mut FtpStream, cp: &mut Checkpoint) -> TransferResult<()> {
    crate::session::transfer::validate_local_file_target(Path::new(&cp.temporary))
        .map_err(Failure::conflict)?;
    let mut hash = local::prefix(Path::new(&cp.temporary), cp.offset, &job.control)?;
    if local::hex(hash.clone().finish().as_ref()) != cp.prefix_hash {
        return Err(Failure::conflict("local partial changed"));
    }
    if cp.offset > 0 {
        if let Err(error) = ftp.resume_transfer(usize::try_from(cp.offset).map_err(Failure::local)?)
        {
            if !resume_unsupported(&error) {
                return Err(error.into());
            }
            cp.offset = 0;
            hash = Context::new(&SHA256);
            cp.prefix_hash = local::digest(&[]);
            job.save(cp)?;
            job.phase("restarting (FTP server has no REST support)");
        }
    }
    let mut input = ftp.retr_as_stream(&cp.item.remote)?;
    let socket = job.control.socket(input.get_ref())?;
    let mut output = std::fs::OpenOptions::new()
        .write(true)
        .open(&cp.temporary)?;
    output.set_len(cp.offset)?;
    output.seek(SeekFrom::Start(cp.offset))?;
    let mut buffer = vec![0; 1024 * 1024];
    let mut saved = cp.offset;
    loop {
        job.control.check()?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        if cp.offset + n as u64 > cp.source.size {
            return Err(Failure::conflict("FTP source grew or REST was ignored"));
        }
        output.write_all(&buffer[..n])?;
        hash.update(&buffer[..n]);
        cp.offset += n as u64;
        job.progress(&cp.key, cp.offset, cp.source.size, false);
        if cp.offset - saved >= 4 * 1024 * 1024 {
            output.sync_data()?;
            cp.prefix_hash = local::hex(hash.clone().finish().as_ref());
            job.save(cp)?;
            saved = cp.offset;
        }
    }
    drop(socket);
    ftp.finalize_retr_stream(input)?;
    if cp.offset != cp.source.size {
        return Err(Failure::conflict(
            "FTP source ended before its reported size",
        ));
    }
    output.sync_all()?;
    cp.prefix_hash = local::hex(hash.finish().as_ref());
    job.save(cp)
}

fn upload(job: &Job, ftp: &mut FtpStream, cp: &mut Checkpoint) -> TransferResult<()> {
    let partial = signature(ftp, &cp.temporary, &job.control)?
        .ok_or_else(|| Failure::conflict("FTP partial disappeared"))?;
    if partial.size > cp.source.size {
        return Err(Failure::conflict("FTP partial is larger than the source"));
    }
    let mut hash = local::prefix(Path::new(&cp.item.local), partial.size, &job.control)?;
    if partial.size > 0 {
        job.phase("verifying resume prefix");
        let (size, checksum) = remote_hash(ftp, &cp.temporary, &job.control)?;
        if size != partial.size || checksum != local::hex(hash.clone().finish().as_ref()) {
            return Err(Failure::conflict("FTP partial does not match the source"));
        }
    }
    cp.offset = partial.size;
    let mut input = std::fs::File::open(&cp.item.local)?;
    input.seek(SeekFrom::Start(cp.offset))?;
    let mut output = if cp.offset == 0 {
        ftp.put_with_stream(&cp.temporary)?
    } else {
        let append = ftp.append_with_stream(&cp.temporary);
        // SuppaFTP sends APPE before opening the passive data socket. A server
        // rejecting APPE may already have closed that listener, so the library
        // returns ConnectionRefused before consuming the 5xx control reply.
        let append = match append {
            Err(error) if matches!(&error, FtpError::ConnectionError(io) if io.kind() == std::io::ErrorKind::ConnectionRefused) =>
            {
                ftp.get_ref()
                    .set_read_timeout(Some(Duration::from_secs(3)))?;
                let reply = ftp.finalize_put_stream(std::io::sink());
                ftp.get_ref()
                    .set_read_timeout(Some(Duration::from_secs(30)))?;
                match reply {
                    Err(rejection) if resume_unsupported(&rejection) => Err(rejection),
                    _ => Err(error),
                }
            }
            other => other,
        };
        match append {
            Ok(stream) => stream,
            Err(error) if resume_unsupported(&error) => {
                cp.offset = 0;
                cp.prefix_hash = local::digest(&[]);
                hash = Context::new(&SHA256);
                job.save(cp)?;
                input.seek(SeekFrom::Start(0))?;
                job.phase("restarting (FTP server has no APPE support)");
                ftp.put_with_stream(&cp.temporary)?
            }
            Err(error) => return Err(error.into()),
        }
    };
    let socket = job.control.socket(output.get_ref())?;
    let mut buffer = vec![0; 1024 * 1024];
    while cp.offset < cp.source.size {
        job.control.check()?;
        let length = (cp.source.size - cp.offset).min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..length])?;
        output.write_all(&buffer[..length])?;
        hash.update(&buffer[..length]);
        cp.offset += length as u64;
        job.progress(&cp.key, cp.offset, cp.source.size, false);
    }
    output.flush()?;
    drop(socket);
    ftp.finalize_put_stream(output)?;
    if ftp.size(&cp.temporary)? as u64 != cp.source.size {
        return Err(Failure::conflict("FTP upload size mismatch"));
    }
    cp.prefix_hash = local::hex(hash.finish().as_ref());
    job.save(cp)
}

fn resume_unsupported(error: &FtpError) -> bool {
    matches!(error, FtpError::UnexpectedResponse(r) if matches!(r.status.code(), 500 | 501 | 502 | 504 | 550))
}

pub async fn cleanup(job: Arc<Job>) -> TransferResult<()> {
    tokio::task::spawn_blocking(move || {
        let checkpoints: Vec<_> = job.checkpoints.lock().values().cloned().collect();
        let mut remote = None;
        for mut cp in checkpoints {
            if cp.complete || !cp.owns_temporary {
                continue;
            }
            if cp.item.upload {
                if remote.is_none() {
                    remote = Some(connect(&job.profile).map_err(Failure::network)?);
                }
                let ftp = &mut remote.as_mut().unwrap().stream;
                ftp.get_ref()
                    .set_read_timeout(Some(Duration::from_secs(3)))?;
                ftp.get_ref()
                    .set_write_timeout(Some(Duration::from_secs(3)))?;
                let cleanup = Control::default();
                if cp.committing && cp.owns_backup {
                    let current = signature(ftp, &cp.item.remote, &cleanup)?;
                    if current.is_none() {
                        if signature(ftp, &cp.backup, &cleanup)? != cp.original
                            || cp.original.is_none()
                        {
                            return Err(Failure::conflict(
                                "cannot verify the FTP backup; retained for manual recovery",
                            ));
                        }
                        ftp.rename(&cp.backup, &cp.item.remote)?;
                        cp.owns_backup = false;
                    } else if current != cp.original {
                        let (size, hash) = remote_hash(ftp, &cp.item.remote, &cleanup)?;
                        if size != cp.source.size || hash != cp.prefix_hash {
                            return Err(Failure::conflict(
                                "FTP destination changed; backup and partial retained",
                            ));
                        }
                    }
                    remove_backup(ftp, &mut cp, &cleanup)?;
                }
                if signature(ftp, &cp.temporary, &cleanup)?.is_some() {
                    ftp.rm(&cp.temporary)?;
                }
            } else if Path::new(&cp.temporary).exists() {
                std::fs::remove_file(&cp.temporary)?;
            }
            cp.owns_temporary = false;
            job.save(&cp)?;
        }
        Ok(())
    })
    .await
    .map_err(Failure::local)?
}

fn remove_backup(
    ftp: &mut FtpStream,
    cp: &mut Checkpoint,
    control: &Control,
) -> TransferResult<()> {
    if cp.owns_backup {
        if let Some(backup) = signature(ftp, &cp.backup, control)? {
            if Some(backup) != cp.original {
                return Err(Failure::conflict(
                    "FTP backup changed; retained for manual recovery",
                ));
            }
            ftp.rm(&cp.backup)?;
        }
        cp.owns_backup = false;
    }
    Ok(())
}
