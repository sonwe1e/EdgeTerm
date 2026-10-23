use super::*;

#[tokio::test(flavor = "current_thread")]
async fn transfer_connection_failures_and_cancellation_have_end_events() {
    for tar_mode in [false, true] {
        for cancel in [false, true] {
            let root =
                std::env::temp_dir().join(format!("edgeterm-dial-log-{}", uuid::Uuid::new_v4()));
            let mut job = test_job(root.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let profile = &mut Arc::get_mut(&mut job).unwrap().profile;
            profile.host = Some("127.0.0.1".into());
            profile.port = Some(listener.local_addr().unwrap().port());
            // Missing username is a deterministic authentication-input failure;
            // cancellation instead interrupts a real pending SSH handshake.
            profile.username = cancel.then(|| "fixture".into());
            let logs = root.join("logs");
            let (subscriber, guard) = crate::diagnostics::build(&logs).unwrap();
            {
                let _default = tracing::subscriber::set_default(subscriber);
                let dial = async {
                    if tar_mode {
                        tar::connect(&job).await.map(|_| ())
                    } else {
                        sftp::Remote::connect(&job).await.map(|_| ())
                    }
                };
                let result = if cancel {
                    let cancel_after_accept = async {
                        let (_stream, _) = listener.accept().await.unwrap();
                        job.control.set(2);
                    };
                    tokio::time::timeout(Duration::from_secs(3), async {
                        tokio::join!(dial, cancel_after_accept).0
                    })
                    .await
                    .unwrap()
                } else {
                    dial.await
                };
                assert!(result.is_err());
            }
            drop(guard);
            let content: String = std::fs::read_dir(&logs)
                .unwrap()
                .map(|e| std::fs::read_to_string(e.unwrap().path()).unwrap())
                .collect();
            let end = content
                .lines()
                .find(|line| line.contains("phase=\"end\""))
                .expect("transfer connection must end even on failure or cancellation");
            assert!(end.contains(&job.id));
            assert!(end.contains("outcome=\"error\""));
            assert!(end.contains("duration_ms="));
            if cancel {
                assert!(end.contains("transfer cancelled"));
            } else {
                assert!(end.contains("missing a username"));
            }
            drop(job);
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
#[test]
fn shell_and_file_sessions_share_limits_and_target_locks() {
    let mut profile: SessionProfile = serde_json::from_value(
        serde_json::json!({"name":"test", "kind":"ssh", "host":"Example.COM", "username":"user"}),
    )
    .unwrap();
    let key = endpoint_key(&profile);
    profile.kind = SessionKind::Sftp;
    profile.host = Some("example.com".into());
    profile.port = Some(22);
    assert_eq!(key, endpoint_key(&profile));
    profile.kind = SessionKind::Ftp;
    assert_ne!(key, endpoint_key(&profile));
}
#[tokio::test]
async fn pause_interrupts_a_pending_operation_and_can_resume() {
    let control = Arc::new(Control::default());
    let running = control.clone();
    let task = tokio::spawn(async move {
        running
            .run(std::future::pending::<TransferResult<()>>())
            .await
    });
    tokio::task::yield_now().await;
    control.set(1);
    let result = tokio::time::timeout(Duration::from_millis(100), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert_eq!(result.code, "paused");
    control.set(0);
    assert_eq!(control.run(async { Ok(7) }).await.unwrap(), 7);
}
#[test]
fn concurrency_has_a_fixed_upper_bound() {
    assert!(Options::default().validate().is_ok());
    assert!(Options {
        requests: 1000,
        ..Options::default()
    }
    .validate()
    .is_err());
    assert!(Options {
        files: 0,
        ..Options::default()
    }
    .validate()
    .is_err());
    assert!(Options {
        files: 33,
        ..Options::default()
    }
    .validate()
    .is_err());
    assert!(Options {
        files: 32,
        ..Options::default()
    }
    .validate()
    .is_ok());
}
#[test]
fn rate_limit_options_reject_out_of_range_and_default_to_unlimited() {
    assert!(Options::default().validate().is_ok());
    assert_eq!(Options::default().rate_limit_bps, 0);
    assert!(Options {
        rate_limit_bps: 1024,
        ..Options::default()
    }
    .validate()
    .is_ok());
    assert!(Options {
        rate_limit_bps: 1 << 30,
        ..Options::default()
    }
    .validate()
    .is_ok());
    for bad in [1u64, 1023, (1 << 30) + 1, u64::MAX] {
        assert!(Options {
            rate_limit_bps: bad,
            ..Options::default()
        }
        .validate()
        .is_err());
    }
    // A saved preference without the field keeps its concurrency and
    // picks up unlimited, rather than being rejected whole.
    let parsed: Options = serde_json::from_str(
        r#"{"requests":8,"chunkKib":64,"files":4,"durable":false,"tar":false}"#,
    )
    .unwrap();
    assert_eq!(parsed.rate_limit_bps, 0);
    assert!(parsed.validate().is_ok());
}

#[test]
fn pacer_bucket_charges_refunds_and_bounds_slices() {
    let pacer = Pacer::new(8192);
    // The bucket starts full: the whole burst (one second of budget)
    // is available, and taking from it is immediate.
    assert!(pacer.try_take(8192));
    // The next 8 KiB need a full second of refill.
    assert!(pacer.deficit(8192) >= Duration::from_millis(990));
    // A refund gives unused tokens back, capped at the burst size.
    pacer.refund(4096);
    assert!(pacer.try_take(4096));
    assert!(pacer.deficit(8192) >= Duration::from_millis(490));
    // Slices shrink to ~100 ms of budget under the caller's ceiling.
    assert_eq!(pacer.slice(128 * 1024), 819);
    assert_eq!(pacer.slice(500), 500);
    let fast = Pacer::new(64 * 1024 * 1024);
    assert_eq!(fast.slice(128 * 1024), 128 * 1024);
    // Zero rate never happens (construction clamps), but zero bytes
    // are free.
    assert!(pacer.try_take(0));
    // The burst allowance is capped at 1 MiB even for fast rates.
    assert_eq!(fast.burst(), 1024 * 1024);
    assert_eq!(pacer.burst(), 8192);
}

#[tokio::test]
async fn pace_wait_is_interrupted_by_pause_and_cancel() {
    // 2 KiB at 1 KiB/s with a 1 KiB burst: the first kilobyte runs at
    // once, the second has to wait a full second — a real wait the stop
    // signal must interrupt. The future is spawned and given time to
    // enter that wait first; a future that was never polled would prove
    // nothing, and an early return would fail the unwrap_err below.
    async fn interrupted(stop: u8, code: &str) {
        let pacer = Arc::new(Pacer::new(1024));
        let control = Arc::new(Control::default());
        let waiting = {
            let pacer = pacer.clone();
            let control = control.clone();
            tokio::spawn(async move { paced(&pacer, &control, 2048).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;
        control.set(stop);
        let error = tokio::time::timeout(Duration::from_millis(250), waiting)
            .await
            .expect("the stop signal interrupts an ongoing pace wait")
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, code);
    }
    interrupted(1, "paused").await;
    interrupted(2, "cancelled").await;
    // No pacer configured: the unlimited path returns immediately.
    let unlimited = test_job_items(scratch(), Vec::new());
    tokio::time::timeout(Duration::from_millis(50), unlimited.pace(1024 * 1024))
        .await
        .expect("unlimited jobs never wait")
        .unwrap();
}

#[test]
fn paced_blocking_is_interrupted_by_cancel() {
    let pacer = Arc::new(Pacer::new(1024));
    let control = Arc::new(Control::default());
    // 2 KiB against a 1 KiB burst: the thread takes its burst at once
    // and then genuinely waits for the second.
    let waiter = {
        let pacer = pacer.clone();
        let control = control.clone();
        std::thread::spawn(move || paced_blocking(&pacer, &control, 2048))
    };
    std::thread::sleep(Duration::from_millis(100));
    control.set(2);
    let error = waiter.join().unwrap().unwrap_err();
    assert_eq!(error.code, "cancelled");
}

#[test]
fn journal_ids_reject_every_path_shape() {
    assert!(valid_journal_id("a"));
    assert!(valid_journal_id("0123456789abcdef0123456789abcdef"));
    assert!(valid_journal_id(&"x".repeat(100)));
    for bad in [
        "",
        ".",
        "..",
        "../x",
        "a/b",
        "a\\b",
        "/abs",
        "C:\\x",
        "a b",
        "a:b",
        &"x".repeat(101),
    ] {
        assert!(!valid_journal_id(bad), "{bad:?} must not be a journal id");
    }
}

#[test]
fn checkpoint_attribution_covers_planned_children_not_foreign_paths() {
    let folder = Item {
        local: "/src/dir".into(),
        remote: "/dst/dir".into(),
        upload: true,
        directory: true,
    };
    let file = Item {
        local: "/src/dir/a".into(),
        remote: "/dst/dir/a".into(),
        upload: true,
        directory: false,
    };
    // A planned child of the folder row, with the same relative path on
    // both sides. Local separators follow the host platform.
    assert!(checkpoint_belongs(&file, &[folder.clone()]));
    let windows = Item {
        local: "G:\\src\\dir\\a".into(),
        remote: "/dst/dir/a".into(),
        upload: true,
        directory: false,
    };
    let windows_folder = Item {
        local: "G:\\src\\dir".into(),
        remote: "/dst/dir".into(),
        upload: true,
        directory: true,
    };
    assert_eq!(
        checkpoint_belongs(&windows, &[windows_folder.clone()]),
        cfg!(windows),
        "backslashes separate local components only on Windows"
    );
    #[cfg(windows)]
    assert!(!checkpoint_belongs(
        &Item {
            local: "H:\\src\\dir\\a".into(),
            ..windows.clone()
        },
        &[windows_folder.clone()]
    ));
    let slash_file = Item {
        remote: "//dst//dir/a".into(),
        ..file.clone()
    };
    assert!(checkpoint_belongs(&file, &[slash_file]));
    assert!(!checkpoint_belongs(
        &Item {
            remote: "dst/dir/a".into(),
            ..file.clone()
        },
        &[file.clone()]
    ));
    // The folder row itself carries no checkpoint.
    let as_file = Item {
        local: "/src/dir".into(),
        remote: "/dst/dir".into(),
        upload: true,
        directory: false,
    };
    assert!(!checkpoint_belongs(&as_file, &[folder.clone()]));
    // A same-prefix sibling directory is not the folder.
    let sibling = Item {
        local: "/src/dir/other/x".into(),
        remote: "/dst/directory/x".into(),
        upload: true,
        directory: false,
    };
    let prefix_folder = Item {
        local: "/src/dir".into(),
        remote: "/dst/dir".into(),
        upload: true,
        directory: true,
    };
    assert!(!checkpoint_belongs(&sibling, &[prefix_folder]));
    // `..` never escapes the folder on either side.
    let escape_remote = Item {
        local: "/src/dir/a".into(),
        remote: "/dst/dir/../outside".into(),
        upload: true,
        directory: false,
    };
    assert!(!checkpoint_belongs(&escape_remote, &[folder.clone()]));
    let escape_local = Item {
        local: "/src/dir/../outside".into(),
        remote: "/dst/dir/a".into(),
        upload: true,
        directory: false,
    };
    assert!(!checkpoint_belongs(&escape_local, &[folder.clone()]));
    // A child whose relative paths differ between the sides is not a
    // planned child.
    let mismatched = Item {
        local: "/src/dir/x".into(),
        remote: "/dst/dir/y".into(),
        upload: true,
        directory: false,
    };
    assert!(!checkpoint_belongs(&mismatched, &[folder.clone()]));
    // Outside the folder, or the other direction: no.
    let outside = Item {
        local: "/etc/passwd".into(),
        remote: "/dst/dir/evil".into(),
        upload: true,
        directory: false,
    };
    assert!(!checkpoint_belongs(&outside, &[folder.clone()]));
    let download = Item {
        local: "/src/dir/a".into(),
        remote: "/dst/dir/a".into(),
        upload: false,
        directory: false,
    };
    assert!(!checkpoint_belongs(&download, &[folder]));
    // A file row matches only the exact remote — never a "child" of it.
    assert!(checkpoint_belongs(&file, &[file.clone()]));
    // The derived upload partial/backup paths — and nothing else.
    let key = "0123456789abcdef01234567";
    let cp = |temporary: String, backup: String| Checkpoint {
        key: key.into(),
        item: file.clone(),
        source: Signature {
            size: 0,
            modified: None,
            sample: local::digest(&[]),
        },
        original: None,
        temporary,
        backup,
        offset: 0,
        prefix_hash: local::digest(&[]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    assert!(checkpoint_paths_are_derived(&cp(
        "/dst/dir/.edgeterm-0123456789abcdef01234567.part".into(),
        "/dst/dir/.edgeterm-0123456789abcdef01234567.backup".into(),
    )));
    assert!(!checkpoint_paths_are_derived(&cp(
        "/etc/passwd".into(),
        "/dst/dir/.edgeterm-0123456789abcdef01234567.backup".into(),
    )));
    assert!(!checkpoint_paths_are_derived(&cp(
        "/dst/.edgeterm-0123456789abcdef01234567.part".into(),
        "/dst/.other.backup".into(),
    )));
}

/// A v2 journal on disk, the shape `start` writes, for recovery tests.
fn write_journal(root: &Path, id: &str, items: &[Item], rate_limit_bps: u64) {
    let directory = root.join(id);
    std::fs::create_dir_all(&directory).unwrap();
    local::save_json(
        &directory.join("job.json"),
        &serde_json::json!({
            "version": JOURNAL_VERSION,
            "id": id,
            "kind": "sftp",
            "endpoint": endpoint_key(&sftp_profile()),
            "host": "example.com",
            "port": 22,
            "username": "user",
            "jumpProfileId": null,
            "items": items,
            "options": {
                "requests": 8, "chunkKib": 64, "files": 4,
                "durable": false, "tar": false, "rateLimitBps": rate_limit_bps
            }
        }),
    )
    .unwrap();
}

fn sftp_profile() -> SessionProfile {
    serde_json::from_value(
        serde_json::json!({"name":"t", "kind":"sftp", "host":"example.com", "username":"user"}),
    )
    .unwrap()
}

fn sink() -> Channel<TransferProgress> {
    Channel::new(|_| Ok(()))
}

fn scratch() -> PathBuf {
    std::env::temp_dir().join(format!("edgeterm-journal-{}", uuid::Uuid::new_v4()))
}

#[test]
fn recovery_lists_reads_and_rebuilds_a_journal() {
    let root = scratch();
    let items = vec![Item {
        local: "/src/a".into(),
        remote: "/dst/a".into(),
        upload: true,
        directory: false,
    }];
    write_journal(&root, "recover-me-1", &items, 4096);
    // A real checkpoint for that item, saved through the production
    // serializer with the paths the engine derives.
    let key = checkpoint_key("recover-me-1", &items[0]);
    let cp = Checkpoint {
        key: key.clone(),
        item: items[0].clone(),
        source: Signature {
            size: 3,
            modified: None,
            sample: local::digest(b"abc"),
        },
        original: None,
        temporary: format!("/dst/.edgeterm-{key}.part"),
        backup: format!("/dst/.edgeterm-{key}.backup"),
        offset: 0,
        prefix_hash: local::digest(&[]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    local::save_json(&root.join("recover-me-1").join(format!("{key}.json")), &cp).unwrap();
    // The engine freezes the expanded plan beside the journal before
    // the first byte moves; a claimable journal carries it.
    local::save_json(
        &root.join("recover-me-1").join("plan.json"),
        &serde_json::json!({ "items": items }),
    )
    .unwrap();

    let manager = Transfers::with_root(root.clone());
    let found = manager.discover();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "recover-me-1");
    assert_eq!(found[0].kind.as_deref(), Some("sftp"));
    assert_eq!(found[0].items, 1);
    assert_eq!(found[0].checkpoints, 1);
    assert!(!found[0].unrecognized);

    let journal = manager.read_persisted("recover-me-1").unwrap();
    assert_eq!(journal.checkpoints.len(), 1);
    assert!(
        journal.plan.is_some(),
        "a journal with a saved plan carries it frozen"
    );
    // The pure rebuild — no launch, no dial: the adopt-to-completion
    // proof runs against a live local fixture in the FTP tests, and
    // against the dedicated OpenSSH fixture in the ignored set.
    let adopted = manager
        .rebuild(
            journal.id.clone(),
            "session-1".into(),
            journal.items,
            None,
            journal.options,
            sftp_profile(),
            Vec::new(),
            None,
            root.join("recover-me-1"),
            "a".into(),
            journal.checkpoints,
            sink(),
            None,
        )
        .unwrap();
    // The rebuilt job carries the saved checkpoint and its own pacer.
    assert!(adopted.checkpoint(&key).is_some());
    let pacer = adopted.pacer.as_ref().expect("rate limit builds a pacer");
    let rebuilt = manager
        .rebuild(
            "recover-me-2".into(),
            "session-2".into(),
            vec![items_default()],
            None,
            Options {
                rate_limit_bps: 4096,
                ..Options::default()
            },
            sftp_profile(),
            Vec::new(),
            None,
            root.join("recover-me-2"),
            "a".into(),
            HashMap::new(),
            sink(),
            None,
        )
        .unwrap();
    // Two jobs never share a budget: each rebuild builds its own pacer,
    // and an unlimited job builds none at all.
    assert!(!Arc::ptr_eq(pacer, rebuilt.pacer.as_ref().unwrap()));
    assert!(
        manager
            .rebuild(
                "recover-me-3".into(),
                "session-3".into(),
                vec![items_default()],
                None,
                Options::default(),
                sftp_profile(),
                Vec::new(),
                None,
                root.join("recover-me-3"),
                "a".into(),
                HashMap::new(),
                sink(),
                None,
            )
            .unwrap()
            .pacer
            .is_none(),
        "no limit, no pacer"
    );
    drop(adopted);
    drop(rebuilt);
    let _ = std::fs::remove_dir_all(&root);
}

fn items_default() -> Item {
    Item {
        local: "/s".into(),
        remote: "/d".into(),
        upload: true,
        directory: false,
    }
}

#[test]
fn recovery_refuses_foreign_checkpoints_and_keeps_files() {
    for case in ["foreign-item", "redirected-temporary"] {
        let root = scratch();
        let items = vec![Item {
            local: "/src/a".into(),
            remote: "/dst/a".into(),
            upload: true,
            directory: false,
        }];
        write_journal(&root, "recover-refuse", &items, 0);
        let key = checkpoint_key("recover-refuse", &items[0]);
        let foreign_item = Item {
            local: "/elsewhere".into(),
            remote: "/dst/a".into(),
            upload: true,
            directory: false,
        };
        let item = if case == "foreign-item" {
            foreign_item.clone()
        } else {
            items[0].clone()
        };
        let temporary = if case == "redirected-temporary" {
            "/etc/passwd".to_string()
        } else {
            format!("/dst/.edgeterm-{key}.part")
        };
        // The key still matches its own (possibly foreign) item, so the
        // refusal has to come from attribution, not the name check.
        let cp = Checkpoint {
            key: checkpoint_key("recover-refuse", &item),
            item,
            source: Signature {
                size: 0,
                modified: None,
                sample: local::digest(&[]),
            },
            original: None,
            temporary,
            backup: format!("/dst/.edgeterm-{key}.backup"),
            offset: 0,
            prefix_hash: local::digest(&[]),
            complete: false,
            committing: false,
            owns_temporary: true,
            owns_backup: false,
        };
        let path = root.join("recover-refuse").join(format!("{}.json", cp.key));
        local::save_json(&path, &cp).unwrap();
        let manager = Transfers::with_root(root.clone());
        assert!(
            manager.read_persisted("recover-refuse").is_err(),
            "{case} must be refused"
        );
        // Refusal claims nothing: journal and checkpoint are still there.
        assert!(root.join("recover-refuse/job.json").exists());
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[test]
fn recovery_refuses_checkpoints_without_a_saved_plan() {
    let root = scratch();
    let items = vec![Item {
        local: "/src/a".into(),
        remote: "/dst/a".into(),
        upload: true,
        directory: false,
    }];
    write_journal(&root, "no-plan", &items, 0);
    let key = checkpoint_key("no-plan", &items[0]);
    let cp = Checkpoint {
        key: key.clone(),
        item: items[0].clone(),
        source: Signature {
            size: 3,
            modified: None,
            sample: local::digest(b"abc"),
        },
        original: None,
        temporary: format!("/dst/.edgeterm-{key}.part"),
        backup: format!("/dst/.edgeterm-{key}.backup"),
        offset: 0,
        prefix_hash: local::digest(&[]),
        complete: false,
        committing: false,
        owns_temporary: true,
        owns_backup: false,
    };
    let path = root.join("no-plan").join(format!("{key}.json"));
    local::save_json(&path, &cp).unwrap();
    let manager = Transfers::with_root(root.clone());
    // A checkpoint with no frozen plan cannot show what the
    // interrupted run actually transferred: refuse, claim nothing.
    assert!(manager.read_persisted("no-plan").is_err());
    assert!(root.join("no-plan/job.json").exists());
    assert!(path.exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn adopt_without_a_saved_plan_replans_instead_of_running_top_level_rows() {
    let root = scratch();
    let items = vec![Item {
        local: "/src".into(),
        remote: "/dst".into(),
        upload: true,
        directory: true,
    }];
    // Interrupted before planning: a journal with no plan.json and no
    // checkpoints. Its top-level folder row must never run as though
    // it were a plan of files — recovery re-plans from the items.
    write_journal(&root, "no-plan-replan", &items, 0);
    let manager = Transfers::with_root(root.clone());
    let journal = manager.read_persisted("no-plan-replan").unwrap();
    assert!(journal.plan.is_none(), "no plan.json means no frozen plan");
    // Exercise adopt's constructor without dialing a public host.
    manager.cancel("no-plan-replan");
    let job = manager
        .adopt(
            None,
            journal,
            "s".into(),
            sftp_profile(),
            Vec::new(),
            None,
            sink(),
        )
        .unwrap();
    assert!(
        job.plan.lock().is_none(),
        "the rebuilt job must re-plan, not run folder rows as a plan"
    );
    manager.stop_test_workers().await;
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn recovery_accepts_empty_frozen_plans_and_refuses_plan_io_errors() {
    let root = scratch();
    let items = vec![Item {
        local: "/empty".into(),
        remote: "/empty".into(),
        upload: true,
        directory: true,
    }];
    write_journal(&root, "empty-plan", &items, 0);
    let plan = root.join("empty-plan/plan.json");
    local::save_json(&plan, &serde_json::json!({"items":[]})).unwrap();
    let manager = Transfers::with_root(root.clone());
    assert_eq!(
        manager.read_persisted("empty-plan").unwrap().plan,
        Some(vec![])
    );
    std::fs::remove_file(&plan).unwrap();
    std::fs::create_dir(&plan).unwrap();
    assert!(manager
        .read_persisted("empty-plan")
        .err()
        .unwrap()
        .to_string()
        .contains("cannot read the transfer plan"));
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn recovery_refuses_a_journal_copied_under_another_id() {
    let root = scratch();
    write_journal(&root, "original", &[items_default()], 0);
    std::fs::rename(root.join("original"), root.join("copied")).unwrap();
    let manager = Transfers::with_root(root.clone());
    assert!(manager.read_persisted("copied").is_err());
    assert!(root.join("copied/job.json").exists());
    std::fs::remove_dir_all(&root).unwrap();
}

#[test]
fn recovery_refuses_unrecognized_journals_and_corrupt_files() {
    let root = scratch();
    // No version marker: listed as unrecognized, never adopted.
    let legacy = root.join("legacy-dir");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::write(legacy.join("job.json"), r#"{"id":"legacy-dir","items":[]}"#).unwrap();
    let manager = Transfers::with_root(root.clone());
    let found = manager.discover();
    assert_eq!(found.len(), 1);
    assert!(found[0].unrecognized);
    assert_eq!(found[0].name, "Unrecognized journal");
    assert!(manager.read_persisted("legacy-dir").is_err());
    // A v2 journal whose checkpoint is corrupt JSON.
    let items = vec![Item {
        local: "/s".into(),
        remote: "/d".into(),
        upload: true,
        directory: false,
    }];
    write_journal(&root, "corrupt-cp", &items, 0);
    let key = checkpoint_key("corrupt-cp", &items[0]);
    std::fs::write(
        root.join("corrupt-cp").join(format!("{key}.json")),
        "{not json",
    )
    .unwrap();
    assert!(manager.read_persisted("corrupt-cp").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn discard_only_removes_valid_journal_directories() {
    let root = scratch();
    std::fs::create_dir_all(root.join("keep-me")).unwrap();
    std::fs::write(root.join("sentinel"), b"do not delete").unwrap();
    let manager = Transfers::with_root(root.clone());
    for bad in ["", ".", "..", "../keep-me", "/etc", "sub/dir", "a\\b"] {
        assert!(manager.discard_persisted(bad).is_err(), "{bad:?}");
    }
    // Nothing outside a valid id was touched.
    assert!(root.join("sentinel").exists());
    assert!(root.join("keep-me").exists());
    assert!(manager.discard_persisted("missing").is_err());
    manager.discard_persisted("keep-me").unwrap();
    assert!(!root.join("keep-me").exists());
    assert!(root.join("sentinel").exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
#[test]
fn discard_refuses_a_symlinked_journal_directory() {
    let root = scratch();
    let real = std::env::temp_dir().join(format!("real-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&real).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink(&real, root.join("linked")).unwrap();
    let manager = Transfers::with_root(root.clone());
    assert!(manager.discard_persisted("linked").is_err());
    assert!(manager.read_persisted("linked").is_err());
    assert!(manager.discover().is_empty());
    assert!(real.exists(), "the link target must survive");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&real);
}

#[cfg(windows)]
#[test]
fn discard_refuses_a_junction_journal_directory() {
    let root = scratch();
    let real = std::env::temp_dir().join(format!("real-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&real).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(root.join("linked"))
        .arg(&real)
        .output()
        .expect("mklink /J needs no privilege");
    assert!(status.status.success(), "junction creation failed");
    let manager = Transfers::with_root(root.clone());
    assert!(manager.discard_persisted("linked").is_err());
    assert!(manager.read_persisted("linked").is_err());
    assert!(manager.discover().is_empty());
    assert!(real.exists(), "the junction target must survive");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::remove_dir_all(&real);
}

#[test]
fn adopt_rejects_endpoint_and_kind_mismatches() {
    let root = scratch();
    let items = vec![Item {
        local: "/s".into(),
        remote: "/d".into(),
        upload: true,
        directory: false,
    }];
    write_journal(&root, "mismatch", &items, 0);
    let manager = Transfers::with_root(root.clone());
    let journal = manager.read_persisted("mismatch").unwrap();
    let mut other_host = sftp_profile();
    other_host.host = Some("elsewhere.example".into());
    assert!(manager
        .adopt(
            None,
            journal.clone(),
            "s".into(),
            other_host,
            Vec::new(),
            None,
            sink()
        )
        .is_err());
    let mut ftp = sftp_profile();
    ftp.kind = SessionKind::Ftp;
    assert!(manager
        .adopt(None, journal, "s".into(), ftp, Vec::new(), None, sink())
        .is_err());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn discover_skips_jobs_live_in_this_run() {
    let root = scratch();
    let items = vec![Item {
        local: "/s".into(),
        remote: "/d".into(),
        upload: true,
        directory: false,
    }];
    write_journal(&root, "live-job", &items, 0);
    let manager = Transfers::with_root(root.clone());
    assert!(manager
        .discover()
        .iter()
        .any(|found| found.id == "live-job"));
    // A job under that id in memory hides it from the list — built via
    // `rebuild` so no second journal directory appears beside it.
    let job = manager
        .rebuild(
            "live-job".into(),
            "s".into(),
            items,
            None,
            Options::default(),
            sftp_profile(),
            Vec::new(),
            None,
            root.join("live-job"),
            "d".into(),
            HashMap::new(),
            sink(),
            None,
        )
        .unwrap();
    manager.jobs.lock().insert("live-job".into(), job);
    assert!(manager
        .discover()
        .iter()
        .all(|found| found.id != "live-job"));
    assert!(manager.read_persisted("live-job").is_err());
    assert!(manager.discard_persisted("live-job").is_err());
    let _ = std::fs::remove_dir_all(&root);
}

/// A job inserted straight into the manager (no worker launched), beside the
/// journal a real run would leave: identity, frozen plan and one checkpoint
/// file. `rebuild` is the production constructor, so the job owns exactly
/// the directory `dismiss` is expected to remove.
fn stopped_job(manager: &Transfers, root: &Path, id: &str) -> Arc<Job> {
    let items = vec![Item {
        local: "/src/a".into(),
        remote: "/dst/a".into(),
        upload: true,
        directory: false,
    }];
    write_journal(root, id, &items, 0);
    let key = checkpoint_key(id, &items[0]);
    std::fs::write(root.join(id).join(format!("{key}.json")), b"{}").unwrap();
    local::save_json(
        &root.join(id).join("plan.json"),
        &serde_json::json!({ "items": items }),
    )
    .unwrap();
    let job = manager
        .rebuild(
            id.into(),
            "s".into(),
            items,
            None,
            Options::default(),
            sftp_profile(),
            Vec::new(),
            None,
            root.join(id),
            "a".into(),
            HashMap::new(),
            sink(),
            None,
        )
        .unwrap();
    manager.jobs.lock().insert(id.into(), job.clone());
    job
}

#[test]
fn dismiss_clears_a_failed_job_and_its_local_journal() {
    let root = scratch();
    let manager = Transfers::with_root(root.clone());
    let job = stopped_job(&manager, &root, "failed-job");
    job.status("error", Some(Failure::network("connection reset")));
    assert!(root.join("failed-job").join("job.json").exists());
    assert!(root.join("failed-job").join("plan.json").exists());

    manager.control("failed-job", "dismiss").unwrap();
    assert!(!manager.jobs.lock().contains_key("failed-job"));
    // The whole journal goes: identity, plan and checkpoints. A leftover
    // directory would surface later as an unrecognized recovery entry.
    assert!(
        !root.join("failed-job").exists(),
        "the journal directory is removed whole"
    );
    assert!(
        manager.discover().is_empty(),
        "no ghost recovery entry survives"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dismiss_refuses_a_job_that_is_still_running() {
    let root = scratch();
    let manager = Transfers::with_root(root.clone());
    let job = stopped_job(&manager, &root, "running-job");
    // A running job that reports a failure keeps its worker; clearing it must
    // not race that worker or orphan partial files it may still be writing.
    job.status("error", Some(Failure::network("connection reset")));
    job.active.store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(manager.control("running-job", "dismiss").is_err());
    assert!(manager.jobs.lock().contains_key("running-job"));
    assert!(root.join("running-job").exists());

    // Once the job has stopped, the same record clears.
    job.active.store(false, std::sync::atomic::Ordering::SeqCst);
    manager.control("running-job", "dismiss").unwrap();
    assert!(!manager.jobs.lock().contains_key("running-job"));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn dismiss_keeps_a_cancelled_cleanup_retry_and_still_clears_finished_jobs() {
    let root = scratch();
    let manager = Transfers::with_root(root.clone());

    // Cancelling cleans remote partials; when that cleanup itself failed the
    // job still owns them, so its record stays until cleanup is retried.
    let cleanup_failed = stopped_job(&manager, &root, "cleanup-failed");
    cleanup_failed.status(
        "cancelled",
        Some(Failure::network("cannot remove the partial")),
    );
    assert!(manager.control("cleanup-failed", "dismiss").is_err());
    assert!(manager.jobs.lock().contains_key("cleanup-failed"));

    // A completed job and a cancelled job whose cleanup succeeded clear
    // exactly as before.
    let done = stopped_job(&manager, &root, "done-job");
    done.status("complete", None);
    manager.control("done-job", "dismiss").unwrap();
    assert!(!manager.jobs.lock().contains_key("done-job"));

    let cancelled = stopped_job(&manager, &root, "cancelled-job");
    cancelled.status("cancelled", None);
    manager.control("cancelled-job", "dismiss").unwrap();
    assert!(!manager.jobs.lock().contains_key("cancelled-job"));
    let _ = std::fs::remove_dir_all(&root);
}
