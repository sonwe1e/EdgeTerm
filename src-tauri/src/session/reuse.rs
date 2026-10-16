//! Automatic reuse of authenticated transports, with per-identity single flight.
use super::{
    auth::AuthPrompter,
    ssh::{self, SftpConnectOutcome, SharedTransport},
};
use crate::{
    diagnostics::Request,
    error::{AppError, Result},
    model::{HostKeyChange, SessionProfile},
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Weak};
use tokio::sync::watch;

#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct ReuseKey([u8; 32]);
impl ReuseKey {
    fn of(profile: &SessionProfile, jumps: &[SessionProfile]) -> Result<Self> {
        fn identity(profile: &SessionProfile) -> Result<serde_json::Value> {
            let key_digest = match profile.private_key_path.as_deref().filter(|p| {
                !p.is_empty()
                    && profile.auth.unwrap_or_default() == crate::model::AuthKind::PublicKey
            }) {
                Some(path) => {
                    let file = std::fs::File::open(path)?;
                    if file.metadata()?.len() > 1024 * 1024 {
                        return Err(AppError::new("private key is too large"));
                    }
                    use std::io::Read;
                    let mut content = Vec::new();
                    file.take(1024 * 1024 + 1).read_to_end(&mut content)?;
                    if content.len() > 1024 * 1024 {
                        return Err(AppError::new("private key is too large"));
                    }
                    Some(
                        ring::digest::digest(&ring::digest::SHA256, &content)
                            .as_ref()
                            .to_vec(),
                    )
                }
                None => None,
            };
            Ok(
                serde_json::json!({"host":profile.host,"port":profile.port.unwrap_or(22),"username":profile.username,
                "auth":profile.auth,"password":profile.password,"privateKeyPath":profile.private_key_path,
                "passphrase":profile.passphrase,"keyDigest":key_digest,"jumpProfileId":profile.jump_profile_id}),
            )
        }
        // Secrets participate in equality but only an ephemeral digest is kept.
        // Visual, recording, locale and encoding settings belong to channels.
        let value = serde_json::json!({"target":identity(profile)?,"hops":jumps.iter().map(identity).collect::<Result<Vec<_>>>()?});
        let digest = ring::digest::digest(&ring::digest::SHA256, &serde_json::to_vec(&value)?);
        let mut bytes = [0; 32];
        bytes.copy_from_slice(digest.as_ref());
        Ok(Self(bytes))
    }
}
#[derive(Clone)]
enum Flight {
    Ready(Weak<SharedTransport>),
    Changed(HostKeyChange),
    Failed(String),
}
struct Slot {
    transport: Weak<SharedTransport>,
    flight: Option<watch::Sender<Option<Flight>>>,
}
#[derive(Clone, Default)]
pub struct ConnectionPool(Arc<Mutex<HashMap<ReuseKey, Slot>>>);
pub enum TransportOutcome {
    Ready(Arc<SharedTransport>, bool),
    HostKeyChanged(HostKeyChange),
}
struct Leader {
    pool: ConnectionPool,
    key: ReuseKey,
    sender: watch::Sender<Option<Flight>>,
    finished: bool,
}
impl Drop for Leader {
    fn drop(&mut self) {
        if !self.finished {
            self.sender.send_replace(Some(Flight::Failed(
                "the connection attempt was cancelled; retry the connection".into(),
            )));
            self.pool.0.lock().remove(&self.key);
        }
    }
}
impl ConnectionPool {
    pub async fn connect(
        &self,
        profile: &SessionProfile,
        jumps: &[SessionProfile],
        prompt: &AuthPrompter<'_>,
        request: &Request,
    ) -> Result<TransportOutcome> {
        self.get_checked(
            profile,
            jumps,
            ssh::connect_sftp(profile, jumps, prompt, request),
            request,
        )
        .await
    }
    async fn get_checked(
        &self,
        profile: &SessionProfile,
        jumps: &[SessionProfile],
        dial: impl Future<Output = Result<SftpConnectOutcome>>,
        request: &Request,
    ) -> Result<TransportOutcome> {
        let key = ReuseKey::of(profile, jumps)?;
        let expected = key.clone();
        self.get(key,async {
            let outcome=dial.await?;
            // Authentication can wait for MFA while key files are rotated.
            // Never publish a transport authenticated with changed material
            // under the identity captured before the handshake.
            if matches!(&outcome,SftpConnectOutcome::Ready(_))&&ReuseKey::of(profile,jumps)?!=expected{return Err(AppError::new("SSH authentication configuration changed while connecting; retry the connection"));}
            Ok(outcome)
        }, request).await
    }
    async fn get(
        &self,
        key: ReuseKey,
        dial: impl Future<Output = Result<SftpConnectOutcome>>,
        request: &Request,
    ) -> Result<TransportOutcome> {
        let (mut waiting, sender) = {
            let mut slots = self.0.lock();
            slots.retain(|_, slot| slot.flight.is_some() || slot.transport.strong_count() > 0);
            if let Some(slot) = slots.get(&key) {
                if let Some(transport) = slot.transport.upgrade().filter(|t| !t.is_closed()) {
                    request.info("reuse", "found an authenticated connection for this login");
                    return Ok(TransportOutcome::Ready(transport, true));
                }
                if let Some(flight) = &slot.flight {
                    (Some(flight.subscribe()), None)
                } else {
                    slots.remove(&key);
                    (None, None)
                }
            } else {
                (None, None)
            }
        };
        // A leader is installed while holding the same short lock. No lock
        // spans authentication or a user MFA prompt, and unrelated keys dial independently.
        let sender = if waiting.is_none() {
            let mut slots = self.0.lock();
            if let Some(slot) = slots.get(&key) {
                if let Some(transport) = slot.transport.upgrade().filter(|t| !t.is_closed()) {
                    request.info("reuse", "another session opened this login first");
                    return Ok(TransportOutcome::Ready(transport, true));
                }
                if let Some(flight) = &slot.flight {
                    waiting = Some(flight.subscribe());
                }
            }
            if waiting.is_none() {
                let (sender, _) = watch::channel(None);
                slots.insert(
                    key.clone(),
                    Slot {
                        transport: Weak::new(),
                        flight: Some(sender.clone()),
                    },
                );
                Some(sender)
            } else {
                None
            }
        } else {
            sender
        };
        if let Some(mut receiver) = waiting {
            loop {
                let answer = receiver.borrow().clone();
                if let Some(answer) = answer {
                    return match answer {
                        Flight::Ready(weak) => weak.upgrade().filter(|t| !t.is_closed())
                            .map(|t| { request.info("reuse", "another session finished authenticating this login"); TransportOutcome::Ready(t,true)}).ok_or_else(|| AppError::new("the authenticated connection closed before another channel could open")),
                        Flight::Changed(change) => Ok(TransportOutcome::HostKeyChanged(change)),
                        Flight::Failed(error) => Err(AppError::new(error)),
                    };
                }
                receiver
                    .changed()
                    .await
                    .map_err(|_| AppError::new("the connection attempt ended"))?;
            }
        }
        let sender = sender.expect("the leader owns the flight sender");
        let mut leader = Leader {
            pool: self.clone(),
            key: key.clone(),
            sender: sender.clone(),
            finished: false,
        };
        let outcome = dial.await;
        let (answer, result) = match outcome {
            Ok(SftpConnectOutcome::Ready(connection)) => {
                let transport = connection.transport();
                (
                    Flight::Ready(Arc::downgrade(&transport)),
                    Ok(TransportOutcome::Ready(transport, false)),
                )
            }
            Ok(SftpConnectOutcome::HostKeyChanged(change)) => (
                Flight::Changed(change.clone()),
                Ok(TransportOutcome::HostKeyChanged(change)),
            ),
            Err(error) => (Flight::Failed(error.to_string()), Err(error)),
        };
        {
            let mut slots = self.0.lock();
            if let Flight::Ready(weak) = &answer {
                slots.insert(
                    key.clone(),
                    Slot {
                        transport: weak.clone(),
                        flight: None,
                    },
                );
            } else {
                slots.remove(&key);
            }
            sender.send_replace(Some(answer));
            leader.finished = true;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> SessionProfile {
        serde_json::from_value(serde_json::json!({"name":"fixture","kind":"ssh","host":"host","username":"user","auth":"password","password":"first"})).unwrap()
    }
    #[test]
    fn keys_isolate_authentication_and_actual_hop_configuration() {
        let original = profile();
        let key = ReuseKey::of(&original, &[]).unwrap();
        let mut visual = original.clone();
        visual.kind = crate::model::SessionKind::Sftp;
        visual.name = "renamed".into();
        visual.encoding = Some("gbk".into());
        assert!(key == ReuseKey::of(&visual, &[]).unwrap());
        let mut changed = original.clone();
        changed.password = Some("second".into());
        assert!(key != ReuseKey::of(&changed, &[]).unwrap());
        let mut hop = profile();
        let one = ReuseKey::of(&original, &[hop.clone()]).unwrap();
        hop.password = Some("new hop password".into());
        assert!(one != ReuseKey::of(&original, &[hop]).unwrap());
        let file = std::env::temp_dir().join(format!("edgeterm-key-{}", uuid::Uuid::new_v4()));
        std::fs::write(&file, b"first key").unwrap();
        changed.private_key_path = Some(file.to_string_lossy().into());
        changed.auth = Some(crate::model::AuthKind::PublicKey);
        let before = ReuseKey::of(&changed, &[]).unwrap();
        std::fs::write(&file, b"other key").unwrap();
        assert!(before != ReuseKey::of(&changed, &[]).unwrap());
        std::fs::remove_file(file).unwrap();
    }
    #[tokio::test]
    async fn cancelling_a_leader_releases_waiters_and_allows_a_new_attempt() {
        let pool = ConnectionPool::default();
        let key = ReuseKey([1; 32]);
        let request = Request::begin("fixture");
        let first = tokio::spawn({
            let pool = pool.clone();
            let key = key.clone();
            let request = request.clone();
            async move { pool.get(key, std::future::pending(), &request).await }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while pool.0.lock().get(&key).is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let waiter = tokio::spawn({
            let pool = pool.clone();
            let key = key.clone();
            let request = request.clone();
            async move {
                pool.get(
                    key,
                    async { panic!("waiter must not authenticate again") },
                    &request,
                )
                .await
            }
        });
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if pool
                    .0
                    .lock()
                    .get(&key)
                    .unwrap()
                    .flight
                    .as_ref()
                    .unwrap()
                    .receiver_count()
                    > 0
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        first.abort();
        let _ = first.await;
        let error = match tokio::time::timeout(std::time::Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
        {
            Err(e) => e,
            Ok(_) => panic!("cancelled leader succeeded"),
        };
        assert!(error.to_string().contains("cancelled"));
        assert!(pool.0.lock().is_empty());
        assert!(pool
            .get(key, async { Err(AppError::new("new dial")) }, &request)
            .await
            .is_err());
    }

    fn ready(outcome: TransportOutcome) -> Arc<SharedTransport> {
        match outcome {
            TransportOutcome::Ready(transport, _) => transport,
            _ => panic!("fixture host key changed"),
        }
    }
    async fn login_count(transport: Arc<SharedTransport>, root: &str) -> usize {
        let stream = transport.transfer_channel().await.unwrap();
        let raw = russh_sftp::client::RawSftpSession::new(stream);
        raw.init().await.unwrap();
        let path = format!("{}/sshd.log", root.trim_end_matches('/'));
        let handle = raw
            .open(
                &path,
                russh_sftp::protocol::OpenFlags::READ,
                russh_sftp::protocol::FileAttributes::empty(),
            )
            .await
            .unwrap()
            .handle;
        let size = raw.fstat(&handle).await.unwrap().attrs.size.unwrap() as usize;
        assert!(size < 2 * 1024 * 1024, "fixture log unexpectedly large");
        let mut bytes = Vec::new();
        while bytes.len() < size {
            let data = raw
                .read(
                    &handle,
                    bytes.len() as u64,
                    (size - bytes.len()).min(32768) as u32,
                )
                .await
                .unwrap();
            assert!(!data.data.is_empty());
            bytes.extend(data.data);
        }
        raw.close(&handle).await.unwrap();
        raw.close_session().unwrap();
        String::from_utf8(bytes)
            .unwrap()
            .lines()
            .filter(|line| line.contains("Accepted publickey"))
            .count()
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_reuse_redials_an_expired_authenticated_transport() {
        let var = |name: &str| std::env::var(name).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let port = port.parse().unwrap();
        let user = var("EDGETERM_REAL_SSH_USER");
        let key_file = var("EDGETERM_REAL_SSH_KEY");
        let scratch =
            std::env::temp_dir().join(format!("edgeterm-reuse-expired-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let known = scratch.join("known_hosts");
        let mut profile = profile();
        profile.host = Some(host.into());
        profile.port = Some(port);
        profile.username = Some(user.clone());
        profile.auth = Some(crate::model::AuthKind::PublicKey);
        profile.private_key_path = Some(key_file.clone());
        profile.password = None;
        let pool = ConnectionPool::default();
        let request = Request::begin("fixture");
        let first = ready(
            pool.get_checked(
                &profile,
                &[],
                async {
                    Ok(SftpConnectOutcome::Ready(ssh::connect_sftp_on(
                        ssh::test_transport(host, port, &user, &key_file, &known).await,
                        &profile,
                    )?))
                },
                &request,
            )
            .await
            .unwrap(),
        );
        first.test_disconnect().await;
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while !first.is_closed() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let second = ready(
            pool.get_checked(
                &profile,
                &[],
                async {
                    Ok(SftpConnectOutcome::Ready(ssh::connect_sftp_on(
                        ssh::test_transport(host, port, &user, &key_file, &known).await,
                        &profile,
                    )?))
                },
                &request,
            )
            .await
            .unwrap(),
        );
        assert!(!Arc::ptr_eq(&first, &second));
        assert!(!second.is_closed());
        assert_eq!(
            crate::session::exec::run(
                second.clone(),
                "printf alive",
                &crate::file_transfer::Control::default(),
                1024,
                std::time::Duration::from_secs(2)
            )
            .await
            .unwrap(),
            "alive"
        );
        drop(first);
        drop(second);
        std::fs::remove_dir_all(scratch).unwrap();
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_reuse_rejects_key_rotation_during_authentication_before_caching() {
        let var = |name: &str| std::env::var(name).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let port = port.parse().unwrap();
        let user = var("EDGETERM_REAL_SSH_USER");
        let scratch =
            std::env::temp_dir().join(format!("edgeterm-reuse-rotation-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let key_path = scratch.join("client-key");
        std::fs::copy(var("EDGETERM_REAL_SSH_KEY"), &key_path).unwrap();
        let mut profile = profile();
        profile.host = Some(host.into());
        profile.port = Some(port);
        profile.username = Some(user.clone());
        profile.auth = Some(crate::model::AuthKind::PublicKey);
        profile.private_key_path = Some(key_path.to_string_lossy().into());
        profile.password = None;
        let before = ReuseKey::of(&profile, &[]).unwrap();
        let pool = ConnectionPool::default();
        let request = Request::begin("fixture");
        let result = pool
            .get_checked(
                &profile,
                &[],
                async {
                    let transport = ssh::test_transport(
                        host,
                        port,
                        &user,
                        key_path.to_str().unwrap(),
                        &scratch.join("known_hosts"),
                    )
                    .await;
                    // Actual public-key authentication is complete; change only this
                    // test's own key file before the production cache admission step.
                    std::fs::write(&key_path, b"rotated fixture key").unwrap();
                    Ok(SftpConnectOutcome::Ready(ssh::connect_sftp_on(
                        transport, &profile,
                    )?))
                },
                &request,
            )
            .await;
        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("changed key material must not be cached"),
        };
        assert!(error.to_string().contains("changed while connecting"));
        assert!(!pool.0.lock().contains_key(&before));
        std::fs::remove_dir_all(scratch).unwrap();
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_auto_reuse_authenticates_once_and_keeps_sibling_channels_alive() {
        let var = |name: &str| std::env::var(name).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let port: u16 = port.parse().unwrap();
        let user = var("EDGETERM_REAL_SSH_USER");
        let key_file = var("EDGETERM_REAL_SSH_KEY");
        let root = var("EDGETERM_REAL_SSH_ROOT");
        let scratch = std::env::temp_dir().join(format!("edgeterm-reuse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let known_hosts = scratch.join("known_hosts");
        let probe = ssh::test_transport(host, port, &user, &key_file, &known_hosts).await;
        let before = login_count(probe.clone(), &root).await;
        let mut profile = profile();
        profile.host = Some(host.into());
        profile.port = Some(port);
        profile.username = Some(user.clone());
        profile.auth = Some(crate::model::AuthKind::PublicKey);
        profile.private_key_path = Some(key_file.clone());
        profile.password = None;
        let key = ReuseKey::of(&profile, &[]).unwrap();
        let pool = ConnectionPool::default();
        let request = Request::begin("fixture");
        let dial = async {
            Ok(SftpConnectOutcome::Ready(ssh::connect_sftp_on(
                ssh::test_transport(host, port, &user, &key_file, &known_hosts).await,
                &profile,
            )?))
        };
        let dial2 = async {
            Ok(SftpConnectOutcome::Ready(ssh::connect_sftp_on(
                ssh::test_transport(host, port, &user, &key_file, &known_hosts).await,
                &profile,
            )?))
        };
        let (first, second) = tokio::join!(
            pool.get(key.clone(), dial, &request),
            pool.get(key.clone(), dial2, &request)
        );
        let first = ready(first.unwrap());
        let second = ready(second.unwrap());
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(
            login_count(probe.clone(), &root).await - before,
            1,
            "two concurrent tabs must authenticate once"
        );
        let registry = ssh::SshTransports::default();
        registry.register("first", &first);
        registry.register("second", &second);
        let channel1 = ssh::connect_on(first.clone(), &profile).await.unwrap();
        let channel2 = ssh::connect_on(second.clone(), &profile).await.unwrap();
        registry.forget("first");
        drop(channel1);
        drop(first);
        assert!(registry.get("second").is_some());
        let sftp = second.transfer_channel().await.unwrap();
        let raw = russh_sftp::client::RawSftpSession::new(sftp);
        raw.init().await.unwrap();
        assert!(!raw.realpath(".").await.unwrap().files.is_empty());
        raw.close_session().unwrap();
        let third = ready(
            pool.get(
                key,
                async { panic!("serial reuse must not authenticate") },
                &request,
            )
            .await
            .unwrap(),
        );
        assert!(Arc::ptr_eq(&third, &second));
        drop(third);
        drop(channel2);
        drop(second);
        assert!(registry.get("second").is_none());
        drop(probe);
        std::fs::remove_dir_all(scratch).unwrap();
    }
}
