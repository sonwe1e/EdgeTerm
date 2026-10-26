//! Background file jobs. Credentials stay in memory; journals contain only
//! endpoint identity, paths, source fingerprints and confirmed checkpoints.
mod ftp;
mod local;
mod sftp;
mod tar;

#[cfg(test)]
#[path = "real_tests.rs"]
mod real_tests;

use std::collections::HashMap;
use std::future::Future;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};
use tokio::sync::{watch, Semaphore};

use crate::commands::AppState;
use crate::error::{AppError, Result};
use crate::model::{SessionKind, SessionProfile};
use crate::session::{ssh::SharedTransport, TransferProgress};
use local::Signature;

#[cfg(test)]
fn test_job(root: PathBuf) -> Arc<Job> {
    test_job_items(root, vec![])
}

#[cfg(test)]
fn test_job_items(root: PathBuf, items: Vec<Item>) -> Arc<Job> {
    let directory = root.join("journal");
    std::fs::create_dir_all(&directory).unwrap();
    let options = Options::default();
    Arc::new(Job {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: "test".into(),
        items,
        options: options.clone(),
        profile: serde_json::from_value(
            serde_json::json!({"name":"test", "kind":"sftp", "host":"fixture"}),
        )
        .unwrap(),
        jumps: vec![],
        transport: Mutex::new(None),
        control: Arc::new(Control::default()),
        pacer: None,
        checkpoints: Mutex::new(HashMap::new()),
        directory,
        snapshot: Mutex::new(Snapshot {
            revision: 0,
            id: "test".into(),
            session_id: "test".into(),
            name: "test".into(),
            context: None,
            status: "running".into(),
            phase: "transferring".into(),
            transferred: 0,
            total: 0,
            completed_files: 0,
            total_files: 0,
            failed_files: vec![],
            error: None,
            attempt: 0,
            options,
        }),
        progress: Mutex::new(HashMap::new()),
        last_emit: Mutex::new(Instant::now()),
        app: None,
        targets: Default::default(),
        plan: Mutex::new(None),
        lifecycle: Mutex::new(()),
        channel: Channel::new(|_| Ok(())),
        active: AtomicBool::new(false),
        done: watch::channel(None).0,
    })
}

mod types;
pub use types::*;
mod control;
pub use control::*;
mod pacing;
pub(crate) use pacing::*;
mod job;
pub use job::*;
mod manager;
pub use manager::*;
mod journal;
pub(crate) use journal::*;
mod worker;
pub use worker::*;
#[cfg(test)]
mod tests;
