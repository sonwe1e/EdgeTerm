use super::*;

pub async fn wait(job: &Job) -> Result<()> {
    let mut done = job.done.subscribe();
    loop {
        if let Some(result) = done.borrow_and_update().clone() {
            return result.map_err(AppError::new);
        }
        done.changed()
            .await
            .map_err(|_| AppError::new("transfer worker ended"))?;
    }
}

pub(super) async fn run_job(job: &Arc<Job>, limit: Arc<Semaphore>) -> TransferResult<()> {
    let mut retry = 0;
    loop {
        if job.control.value() == 1 {
            job.status("paused", None);
            job.control.resumed().await;
        }
        if job.control.value() == 2 {
            // A tar-streaming job records no per-file checkpoints, so there is
            // nothing remote to remove beyond what the remote tar had already
            // written when the channel was closed: no partials, no backups,
            // and no ownership to claim. The SFTP cleanup walks the journal
            // and finds nothing for such a job.
            let cleanup = if job.profile.kind == SessionKind::Ftp {
                ftp::cleanup(job.clone()).await
            } else {
                sftp::cleanup(job).await
            };
            job.snapshot.lock().error = cleanup.err();
            return Err(Failure::new("cancelled", "transfer cancelled", false));
        }
        job.status("queued", None);
        let permit = tokio::select! {
            _ = job.control.stopped() => continue,
            p = limit.clone().acquire_owned() => p.map_err(|e| Failure::local(e.to_string()))?,
        };
        {
            let mut snapshot = job.snapshot.lock();
            snapshot.attempt += 1;
            snapshot.failed_files.clear();
        }
        job.status("running", None);
        let result = if job.profile.kind == SessionKind::Ftp {
            ftp::run(job.clone()).await
        } else if tar::wants_tar(job) {
            tar::run(job).await
        } else {
            sftp::run(job).await
        };
        drop(permit);
        if job.control.value() != 0 {
            continue;
        }
        match result {
            Ok(()) => return Ok(()),
            Err(e) if e.retryable && retry < 3 => {
                retry += 1;
                job.status("retrying", Some(e));
                tokio::select! {
                    _ = job.control.stopped() => {},
                    _ = tokio::time::sleep(Duration::from_secs(1 << retry)) => {},
                }
            }
            Err(e) => return Err(e),
        }
    }
}
