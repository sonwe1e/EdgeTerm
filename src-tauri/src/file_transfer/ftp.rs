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

use super::{
    local, paced_blocking, Checkpoint, Control, Failure, Item, Job, Pacer, TransferResult,
};
use crate::session::{
    ftp::{connect, connect_controlled, ensure_remote_directory, list_directory, FtpConnection},
    transfer::{ensure_local_directory, plan_local_upload_checked, safe_local_child},
};

#[cfg(test)]
#[path = "ftp_tests.rs"]
mod tests;

/// The granularity FTP data moves at under a rate limit. The workers are
/// blocking threads, so a small slice keeps `paced_blocking`'s waits short
/// and its control polling responsive; the download loop reserves a slice
/// before pulling it, letting the kernel's receive window — not a sleep
/// after the fact — hold the server back.
const FTP_PACE_SLICE: usize = 64 * 1024;

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
    // FTP needs independent control/data pairs for simultaneous files. Each
    // worker holds one control connection and opens one data connection at a
    // time, so keep the pool small to respect common per-user connection
    // limits while still overlapping a small-file batch's round trips.
    let results = std::thread::scope(|scope| {
        let mut workers = Vec::new();
        for _ in 0..job.options.files.min(4).min(files.len()) {
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
    let frozen = job.plan.lock().clone();
    if let Some(plan) = frozen {
        let mut sizes = Vec::with_capacity(plan.len());
        for item in &plan {
            job.control.check()?;
            sizes.push(match job.checkpoint(&job.key(item)) {
                Some(checkpoint) => checkpoint.source.size,
                None if item.upload => std::fs::metadata(&item.local)?.len(),
                None => conn.stream.size(&item.remote)? as u64,
            });
        }
        job.prime_resumed_progress(&plan, &sizes);
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
    // Freeze the expanded plan before the first byte moves, so restart
    // recovery replays exactly this list.
    job.save_plan(&files)?;
    *job.plan.lock() = Some(files.clone());
    Ok(files)
}

fn signature(
    pacer: Option<&Arc<super::Pacer>>,
    control: &Control,
    ftp: &mut FtpStream,
    path: &str,
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
        remote_hash(pacer, control, ftp, path)?.1
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
    pacer: Option<&Arc<super::Pacer>>,
    control: &Control,
    ftp: &mut FtpStream,
    path: &str,
) -> TransferResult<(u64, String)> {
    let mut stream = ftp.retr_as_stream(path)?;
    let socket = control.socket(stream.get_ref())?;
    let mut context = Context::new(&SHA256);
    // The read-back of a resume prefix (or of a source a server cannot
    // date) is payload this job moves: it draws on the same budget as the
    // transfer itself, in the same small slices. An EOF probe or short
    // read gives its unused slice back.
    let slice = match pacer {
        Some(p) => p.slice(1024 * 1024),
        None => 1024 * 1024,
    };
    let mut bytes = vec![0; slice];
    let mut size = 0;
    loop {
        control.check()?;
        if let Some(p) = pacer {
            paced_blocking(p, control, slice as u64)?;
        }
        let count = stream.read(&mut bytes)?;
        let unused = slice - count;
        if count == 0 {
            if let Some(p) = pacer {
                p.refund(slice as u64);
            }
            break;
        }
        if let Some(p) = pacer {
            p.refund(unused as u64);
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
    if item.upload && job.options.durable {
        return Err(Failure::new(
            "unsupported",
            "FTP cannot confirm durable uploads; disable Durable writes to transfer without it",
            false,
        ));
    }
    let key = job.key(item);
    let source = if item.upload {
        local::signature(Path::new(&item.local))?
    } else {
        signature(job.pacer.as_ref(), &job.control, ftp, &item.remote)?
            .ok_or_else(|| Failure::conflict("FTP source disappeared"))?
    };
    let mut cp = if let Some(cp) = job.checkpoint(&key) {
        if cp.source != source {
            return Err(Failure::conflict("source changed; start a new transfer"));
        }
        cp
    } else {
        let original = if item.upload {
            signature(job.pacer.as_ref(), &job.control, ftp, &item.remote)?
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
    let mut fresh = false;
    if !cp.owns_temporary {
        if item.upload {
            // Claim the partial in the journal before the STOR that creates
            // it, so a crash can never leave a `.part` this job owns but never
            // recorded. The old placeholder — a SIZE probe of the `.part`
            // followed by an empty STOR on its own data connection — only
            // proved ownership the journal now records first, so it is gone.
            cp.owns_temporary = true;
            job.save(&cp)?;
            fresh = true;
        } else {
            local::create_partial(Path::new(&cp.temporary))?;
            cp.owns_temporary = true;
            job.save(&cp)?;
        }
    }
    job.progress(&key, cp.offset, source.size, cp.complete);
    if cp.complete {
        return Ok(());
    }
    if cp.committing {
        let missing = if item.upload {
            signature(job.pacer.as_ref(), &job.control, ftp, &cp.temporary)?.is_none()
        } else {
            !Path::new(&cp.temporary).exists()
        };
        if missing {
            let (size, hash) = if item.upload {
                remote_hash(job.pacer.as_ref(), &job.control, ftp, &item.remote)?
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
            remove_backup(job.pacer.as_ref(), ftp, &mut cp, &job.control)?;
            cp.complete = true;
            job.save(&cp)?;
            job.progress(&key, source.size, source.size, true);
            return Ok(());
        }
    }
    if item.upload {
        upload(job, ftp, &mut cp, fresh)?;
    } else {
        download(job, ftp, &mut cp)?;
    }
    let current_source = if item.upload {
        Some(local::signature(Path::new(&item.local))?)
    } else {
        signature(job.pacer.as_ref(), &job.control, ftp, &item.remote)?
    };
    if current_source.as_ref() != Some(&source) {
        return Err(Failure::conflict("source changed during FTP transfer"));
    }
    job.control.check()?;
    job.phase("committing");
    if item.upload {
        let current = signature(job.pacer.as_ref(), &job.control, ftp, &item.remote)?;
        // When nothing was ever moved out of the way, no backup can exist and
        // the lookup would only cost a round trip per file.
        let backup = if cp.original.is_none() && !cp.owns_backup {
            None
        } else {
            signature(job.pacer.as_ref(), &job.control, ftp, &cp.backup)?
        };
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
                && matches!(
                    signature(job.pacer.as_ref(), &job.control, ftp, &item.remote),
                    Ok(None)
                )
            {
                let _ = ftp.rename(&cp.backup, &item.remote);
            }
            return Err(e.into());
        }
        remove_backup(job.pacer.as_ref(), ftp, &mut cp, &job.control)?;
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
    // The socket is read in rate-limit slices. Each slice is charged just
    // before it is pulled — so under a limit the kernel's receive window,
    // not a sleep after the fact, holds the server back — and an EOF probe
    // (a read that returns nothing) or a short read refunds the part of
    // the slice that never arrived.
    let mut buffer = vec![0; job.pace_slice(FTP_PACE_SLICE)];
    let mut saved = cp.offset;
    loop {
        job.control.check()?;
        let slice = buffer.len() as u64;
        job.pace_blocking(slice)?;
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        if cp.offset + n as u64 > cp.source.size {
            return Err(Failure::conflict("FTP source grew or REST was ignored"));
        }
        job.pace_refund(slice - n as u64);
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

fn upload(job: &Job, ftp: &mut FtpStream, cp: &mut Checkpoint, fresh: bool) -> TransferResult<()> {
    // A partial this run just claimed in the journal does not exist yet: the
    // STOR below creates it. Probing it with SIZE first would only pay a round
    // trip to confirm a file we know is absent and read back an mtime this run
    // does not need. The resume path still probes, because that SIZE feeds the
    // prefix verification below.
    let partial_size = if fresh {
        0
    } else {
        let partial = signature(job.pacer.as_ref(), &job.control, ftp, &cp.temporary)?
            .ok_or_else(|| Failure::conflict("FTP partial disappeared"))?;
        if partial.size > cp.source.size {
            return Err(Failure::conflict("FTP partial is larger than the source"));
        }
        partial.size
    };
    let mut hash = local::prefix(Path::new(&cp.item.local), partial_size, &job.control)?;
    if partial_size > 0 {
        job.phase("verifying resume prefix");
        let (size, checksum) = remote_hash(job.pacer.as_ref(), &job.control, ftp, &cp.temporary)?;
        if size != partial_size || checksum != local::hex(hash.clone().finish().as_ref()) {
            return Err(Failure::conflict("FTP partial does not match the source"));
        }
    }
    cp.offset = partial_size;
    let mut input = std::fs::File::open(&cp.item.local)?;
    input.seek(SeekFrom::Start(cp.offset))?;
    let mut output = if cp.offset == 0 {
        ftp.put_with_stream(&cp.temporary)?
    } else {
        let append = ftp.append_with_stream(&cp.temporary);
        // SuppaFTP sends APPE before opening the passive data socket. A server
        // rejecting APPE may already have closed that listener, so the library
        // returns ConnectionRefused or ConnectionReset before consuming the
        // 5xx control reply. Only that reply can justify restarting the upload.
        let append = match append {
            Err(error) if matches!(&error, FtpError::ConnectionError(io) if matches!(io.kind(), std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::ConnectionReset)) =>
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
    let mut buffer = vec![0; job.pace_slice(FTP_PACE_SLICE)];
    while cp.offset < cp.source.size {
        job.control.check()?;
        let length = (cp.source.size - cp.offset).min(buffer.len() as u64) as usize;
        input.read_exact(&mut buffer[..length])?;
        // The slice goes on the data connection now; the charge is taken
        // immediately before it moves.
        job.pace_blocking(length as u64)?;
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
                    let current = signature(job.pacer.as_ref(), &cleanup, ftp, &cp.item.remote)?;
                    if current.is_none() {
                        if signature(job.pacer.as_ref(), &cleanup, ftp, &cp.backup)? != cp.original
                            || cp.original.is_none()
                        {
                            return Err(Failure::conflict(
                                "cannot verify the FTP backup; retained for manual recovery",
                            ));
                        }
                        ftp.rename(&cp.backup, &cp.item.remote)?;
                        cp.owns_backup = false;
                    } else if current != cp.original {
                        let (size, hash) =
                            remote_hash(job.pacer.as_ref(), &cleanup, ftp, &cp.item.remote)?;
                        if size != cp.source.size || hash != cp.prefix_hash {
                            return Err(Failure::conflict(
                                "FTP destination changed; backup and partial retained",
                            ));
                        }
                    }
                    remove_backup(job.pacer.as_ref(), ftp, &mut cp, &cleanup)?;
                }
                if signature(job.pacer.as_ref(), &cleanup, ftp, &cp.temporary)?.is_some() {
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
    pacer: Option<&Arc<Pacer>>,
    ftp: &mut FtpStream,
    cp: &mut Checkpoint,
    control: &Control,
) -> TransferResult<()> {
    if cp.owns_backup {
        if let Some(backup) = signature(pacer, control, ftp, &cp.backup)? {
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
