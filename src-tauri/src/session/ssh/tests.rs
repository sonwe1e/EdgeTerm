use std::path::{Path, PathBuf};

use russh::keys::PublicKey;

use super::{
    auth_failure, authenticate, client_config, connect, connect_on, connect_sftp, ensure_sftp,
    handshake_failure, key_check, key_only_verdict, legacy_choices, open_shell, replace_host_key,
    run_sftp, saved_answer, verify_host_key, AuthFlow, AuthPrompter, Client, ConnectOutcome,
    Endpoint, Handle, HandshakeError, Hops, KeyCheck, KeyCheckOutcome, LegacyRecord, Prompt,
    Request, SftpConnectOutcome, SftpRequest, SftpResponse, SharedTransport, SshTransports,
    SAVED_PASSWORD_REJECTED,
};
use crate::error::{AppError, ErrorCode};
use crate::file_transfer::Control;
use crate::model::{AuthKind, AuthPromptField, SessionKind, SessionProfile};
use crate::session::auth::CannedAnswers;
use parking_lot::Mutex;
use russh::client;
use russh::client::GexParams;
use russh::kex::dh::groups::{DhGroup, DH_GROUP14};
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::ssh_key::LineEnding;
use russh::keys::PrivateKey;
use russh::keys::{Algorithm, HashAlg};
use russh::server::{Auth, Response};
use russh::{cipher, kex, mac, AlgorithmKind, Names, Preferred};
use russh::{ChannelMsg, MethodKind, MethodSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;

const HOST: &str = "192.0.2.10";
const ED25519_A: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcCiNIPQD3zMS3LgYoVYM8VShLj/4dvS3+yBaPqfGSr";
const ED25519_B: &str =
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFqCv2Sfw6yBfnn1kVkrFEMG076iC8w+NlmGZFBs70qQ";
const ECDSA_A: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBN1WvqLHKYqgraIJhxCF5Wyfs5ByZSzklDNaeFRli6QJLB9MWfaa4AXNL6rX9oOgLyz/Ylv+J6q9M/fpDZmuSkU=";

fn key(openssh: &str) -> PublicKey {
    PublicKey::from_openssh(openssh).expect("valid test key")
}

/// A throwaway request for code paths exercising something other than the
/// diagnostics themselves; nothing installed here is asserted on.
fn request() -> Request {
    Request::begin("fixture")
}

/// A known_hosts path inside a private temporary directory that is
/// removed again on drop.
struct KnownHosts(PathBuf);

impl KnownHosts {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("edgeterm-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        KnownHosts(dir.join("known_hosts"))
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn write(&self, content: &str) {
        std::fs::write(&self.0, content).expect("write known_hosts");
    }

    fn read(&self) -> String {
        std::fs::read_to_string(&self.0).unwrap_or_default()
    }

    /// The recorded entries. russh may start a freshly created file with
    /// a blank line, which OpenSSH ignores, so blank lines are dropped.
    fn entries(&self) -> Vec<String> {
        self.read()
            .lines()
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    }
}

impl Drop for KnownHosts {
    fn drop(&mut self) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// `user@host:port` from the environment variable `var`, as a profile
/// authenticating with the private key named by `EDGETERM_TEST_KEY`.
fn profile_from_env(var: &str) -> SessionProfile {
    let spec = std::env::var(var).unwrap_or_else(|_| panic!("{var} must be user@host:port"));
    let (user, address) = spec.split_once('@').expect("user@host:port");
    let (host, port) = address.rsplit_once(':').expect("user@host:port");
    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.name = var.to_string();
    profile.host = Some(host.to_string());
    profile.port = Some(port.parse().expect("numeric port"));
    profile.username = Some(user.to_string());
    profile.auth = Some(AuthKind::PublicKey);
    profile.private_key_path =
        Some(std::env::var("EDGETERM_TEST_KEY").expect("EDGETERM_TEST_KEY names a private key"));
    profile
}

/// End-to-end check of a tunnelled connection against real servers, so
/// it is ignored by default. Run it with
/// `EDGETERM_TEST_JUMP=user@host:port EDGETERM_TEST_TARGET=user@host:port
/// EDGETERM_TEST_KEY=/path/to/key cargo test -- --ignored jump_host`.
/// The target must be reachable from the jump host and both must accept
/// the key. HOME is pointed at a scratch directory so the developer's
/// own known_hosts is never touched.
#[tokio::test]
#[ignore]
async fn shell_and_sftp_open_through_a_jump_host() {
    let jump = profile_from_env("EDGETERM_TEST_JUMP");
    let target = profile_from_env("EDGETERM_TEST_TARGET");
    let scratch = KnownHosts::new();
    let home = scratch.path().parent().expect("scratch dir").to_path_buf();
    std::fs::create_dir_all(home.join(".ssh")).expect("create .ssh");
    std::env::set_var("HOME", &home);
    // Both hops authenticate with a key; a server that asked anything
    // else would cancel rather than hang this test.
    let user = Mutex::new(CannedAnswers::default());
    let prompter = AuthPrompter::canned(&user);

    // A shell through the tunnel: what the shell prints comes back. The
    // marker is computed so the echoed command line cannot match it.
    let mut conn = match connect(&target, std::slice::from_ref(&jump), &prompter, &request())
        .await
        .expect("connect through the jump host")
    {
        ConnectOutcome::Ready(conn) => conn,
        ConnectOutcome::HostKeyChanged(change) => panic!("{}", change.message),
    };
    conn.channel
        .data(&b"echo edgeterm-$((40+2)); exit\n"[..])
        .await
        .expect("send command");
    let mut output = Vec::new();
    let seen = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            match conn.channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    output.extend_from_slice(&data);
                    if output.windows(11).any(|w| w == b"edgeterm-42") {
                        break true;
                    }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break false,
                Some(_) => {}
            }
        }
    })
    .await
    .expect("shell output within the timeout");
    assert!(
        seen,
        "marker missing from {}",
        String::from_utf8_lossy(&output)
    );
    drop(conn);

    // SFTP through the same kind of tunnel.
    let sftp = match connect_sftp(&target, std::slice::from_ref(&jump), &prompter, &request())
        .await
        .expect("sftp through the jump host")
    {
        SftpConnectOutcome::Ready(conn) => conn,
        SftpConnectOutcome::HostKeyChanged(change) => panic!("{}", change.message),
    };
    let mut slot = None;
    let session = ensure_sftp(&sftp.transport.handle, &mut slot)
        .await
        .expect("sftp subsystem");
    match run_sftp(session, SftpRequest::List { path: "/".into() })
        .await
        .expect("list /")
    {
        SftpResponse::Listing(listing) => assert!(!listing.entries.is_empty()),
        other => panic!("unexpected response: {other:?}"),
    }
    drop(sftp);

    // Both hops went through the host key policy: each was learned.
    let known_hosts = std::fs::read_to_string(home.join(".ssh").join("known_hosts"))
        .expect("known_hosts was written");
    for hop in [&jump, &target] {
        let entry = format!("[{}]:{}", hop.host.as_deref().unwrap(), hop.port.unwrap());
        assert!(
            known_hosts.contains(&entry),
            "{entry} missing from {known_hosts}"
        );
    }

    // A target the jump host cannot reach is reported as such.
    let mut unreachable = target.clone();
    unreachable.port = Some(1);
    let error = connect(
        &unreachable,
        std::slice::from_ref(&jump),
        &prompter,
        &request(),
    )
    .await
    .err()
    .expect("port 1 is closed");
    assert!(error.to_string().contains("jump host"), "{error}");
}

#[test]
fn unknown_host_is_learned_and_then_recognised() {
    let file = KnownHosts::new();

    verify_host_key(HOST, 22, &key(ED25519_A), file.path()).expect("first contact is accepted");
    assert_eq!(file.entries(), [format!("{HOST} {ED25519_A}")]);

    verify_host_key(HOST, 22, &key(ED25519_A), file.path()).expect("known key is accepted");
    assert_eq!(file.entries().len(), 1, "a known key is not recorded twice");
}

#[test]
fn changed_key_of_the_same_algorithm_is_refused() {
    let file = KnownHosts::new();
    // The comment and blank line make sure the reported line number is
    // the real one in the file, not russh's index over entry lines.
    let before = format!("# leading comment\n\n{HOST} {ED25519_A}\n");
    file.write(&before);

    let err = verify_host_key(HOST, 22, &key(ED25519_B), file.path())
        .expect_err("a different key of the same algorithm is a change");
    match err {
        HandshakeError::HostKeyChanged {
            known_hosts,
            line,
            key: presented,
        } => {
            assert_eq!(known_hosts, file.path());
            assert_eq!(line, 3);
            assert_eq!(presented, key(ED25519_B));
        }
        other => panic!("unexpected error: {other:?}"),
    }
    assert_eq!(file.read(), before, "a refused key is never recorded");
}

#[test]
fn new_algorithm_for_a_known_host_is_learned() {
    let file = KnownHosts::new();
    file.write(&format!("{HOST} {ECDSA_A}\n"));

    verify_host_key(HOST, 22, &key(ED25519_A), file.path())
        .expect("a key of another algorithm is not a change");
    assert_eq!(
        file.entries(),
        [format!("{HOST} {ECDSA_A}"), format!("{HOST} {ED25519_A}")]
    );
}

#[test]
fn accepting_a_changed_key_replaces_every_entry_for_the_host() {
    let file = KnownHosts::new();
    file.write(&format!(
        "# comment\nother.example {ED25519_B}\n{HOST} {ECDSA_A}\n\n{HOST} {ED25519_A}\n"
    ));

    replace_host_key(HOST, 22, &key(ED25519_B), file.path()).expect("replace");
    assert_eq!(
        file.entries(),
        [
            "# comment".to_string(),
            format!("other.example {ED25519_B}"),
            format!("{HOST} {ED25519_B}"),
        ]
    );
    verify_host_key(HOST, 22, &key(ED25519_B), file.path())
        .expect("the accepted key is now the known one");
}

#[test]
fn non_default_port_is_recorded_in_bracket_form() {
    let file = KnownHosts::new();

    verify_host_key(HOST, 2222, &key(ED25519_A), file.path()).expect("first contact");
    assert_eq!(file.entries(), [format!("[{HOST}]:2222 {ED25519_A}")]);

    // The same host on the default port is a different entry, not a change.
    verify_host_key(HOST, 22, &key(ED25519_B), file.path()).expect("other port is unrelated");
    assert_eq!(file.entries().len(), 2);
}

#[derive(Clone, Default)]
struct ShellServer {
    logins: Arc<Mutex<usize>>,
    sessions: Arc<Mutex<usize>>,
    forward: Option<Arc<DelayedForward>>,
    channel_delay: Option<Arc<DelayedChannel>>,
}
#[derive(Default)]
struct DelayedChannel {
    opened: std::sync::atomic::AtomicUsize,
    closed: std::sync::atomic::AtomicUsize,
}
#[derive(Default)]
struct DelayedForward {
    requested: std::sync::atomic::AtomicUsize,
    cancelled: Mutex<Vec<u32>>,
}

impl russh::server::Handler for ShellServer {
    type Error = russh::Error;

    async fn tcpip_forward(
        &mut self,
        _address: &str,
        port: &mut u32,
        _session: &mut russh::server::Session,
    ) -> std::result::Result<bool, Self::Error> {
        let Some(forward) = &self.forward else {
            return Ok(false);
        };
        forward
            .requested
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(300)).await;
        *port = 45678;
        Ok(true)
    }
    async fn cancel_tcpip_forward(
        &mut self,
        _address: &str,
        port: u32,
        _session: &mut russh::server::Session,
    ) -> std::result::Result<bool, Self::Error> {
        if let Some(forward) = &self.forward {
            forward.cancelled.lock().push(port);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
        *self.logins.lock() += 1;
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        *self.sessions.lock() += 1;
        if let Some(delay) = &self.channel_delay {
            delay
                .opened
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
        reply.accept().await;
        Ok(())
    }
    async fn channel_close(
        &mut self,
        _channel: russh::ChannelId,
        _session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        if let Some(delay) = &self.channel_delay {
            delay
                .closed
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _term: &str,
        _cols: u32,
        _rows: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        session.channel_success(channel)
    }

    async fn shell_request(
        &mut self,
        channel: russh::ChannelId,
        session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        session.channel_success(channel)
    }
}

/// The profile a test session connects with: the local server, as the
/// user the test server lets in.
fn profile_for(address: SocketAddr) -> SessionProfile {
    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.host = Some(address.ip().to_string());
    profile.port = Some(address.port());
    profile.username = Some("ops".into());
    profile
}

/// Logs in to `address` the way a session does, and hands back the
/// transport its sessions would share.
async fn transport_to(address: SocketAddr, known_hosts: &Path) -> Arc<SharedTransport> {
    let forwards = Arc::new(crate::port_forward::ForwardRoutes::default());
    let mut handle = client::connect(
        Arc::new(client_config()),
        address,
        Client {
            forwards: forwards.clone(),
            host: "127.0.0.1".into(),
            port: address.port(),
            legacy: LegacyRecord::default(),
            known_hosts: Some(known_hosts.to_path_buf()),
        },
    )
    .await
    .expect("handshake");
    let user = Mutex::new(CannedAnswers::default());
    authenticate(
        &mut handle,
        &profile_for(address),
        "ops",
        "127.0.0.1",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the server lets the session in");
    Arc::new(SharedTransport {
        forwards,
        handle: Arc::new(handle),
        hops: Some(Hops(Vec::new())),
        legacy: Vec::new(),
        endpoint: Endpoint::of(&profile_for(address)),
    })
}

/// What Duplicate SSH Channel is for (issues #63, #73): the second
/// terminal is another channel of the connection the first one logged in
/// on, so a server behind MFA asks once however many tabs are opened on it.
#[tokio::test]
async fn a_cancelled_channel_open_closes_its_late_reply_without_disconnect() {
    let file = KnownHosts::new();
    let delayed = Arc::new(DelayedChannel::default());
    let server = ShellServer {
        channel_delay: Some(delayed.clone()),
        ..Default::default()
    };
    let address = serve_once(server, Preferred::default()).await;
    let transport = transport_to(address, file.path()).await;
    let request = tokio::spawn({
        let transport = transport.clone();
        async move { transport.owned_command_channel().await }
    });
    tokio::time::timeout(Duration::from_secs(2), async {
        while delayed.opened.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    request.abort();
    assert!(request.await.is_err());
    tokio::time::timeout(Duration::from_secs(2), async {
        while delayed.closed.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("late accepted session channel must be closed");
    assert!(!transport.is_closed());
    assert_eq!(Arc::strong_count(&transport), 1);
    let sibling = transport.owned_command_channel().await.unwrap();
    sibling.close().await.unwrap();
}
#[tokio::test]
async fn closing_a_pending_remote_forward_cancels_its_late_allocation() {
    let file = KnownHosts::new();
    let delayed = Arc::new(DelayedForward::default());
    let server = ShellServer {
        forward: Some(delayed.clone()),
        ..Default::default()
    };
    let address = serve_once(server, Preferred::default()).await;
    let transport = transport_to(address, file.path()).await;
    let manager = crate::port_forward::Forwards::default();
    let row = manager
        .start(
            "owner",
            "fixture".into(),
            transport.clone(),
            crate::port_forward::Spec {
                direction: crate::port_forward::Direction::Remote,
                listen_host: "127.0.0.1".into(),
                listen_port: 0,
                target_host: "127.0.0.1".into(),
                target_port: 80,
            },
        )
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        while delayed.requested.load(std::sync::atomic::Ordering::SeqCst) == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
    manager.close_session("owner");
    tokio::time::timeout(Duration::from_millis(100), manager.stop(&row.id))
        .await
        .expect("owner stop must not wait for the delayed server reply")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if delayed.cancelled.lock().contains(&45678) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("late allocation must be cancelled");
    assert_eq!(manager.list()[0].status, "stopped");
    let sibling = transport.owned_command_channel().await.unwrap();
    sibling.close().await.unwrap();
    assert!(!transport.is_closed());
}
#[tokio::test]
async fn a_duplicated_session_is_another_channel_of_the_same_connection() {
    let file = KnownHosts::new();
    let server = ShellServer::default();
    let address = serve_once(server.clone(), Preferred::default()).await;
    let profile = profile_for(address);

    let transport = transport_to(address, file.path()).await;
    let first = open_shell(transport.clone(), &profile)
        .await
        .expect("the first shell");
    let second = connect_on(transport.clone(), &profile)
        .await
        .expect("a second shell on the same connection");

    assert_eq!(*server.logins.lock(), 1, "the login happened once");
    assert_eq!(*server.sessions.lock(), 2, "each tab has its own channel");
    // Both sessions hold the same transport, so neither closing tab can
    // take the connection away from the other.
    assert!(Arc::ptr_eq(&first.transport(), &second.transport()));
    assert!(!transport.is_closed());

    // A profile that names another server never rides this connection,
    // however the request reached the backend: a shell somewhere other
    // than where the tab says is worse than logging in again.
    let mut elsewhere = profile.clone();
    elsewhere.host = Some("10.0.0.9".into());
    let refused = match connect_on(transport.clone(), &elsewhere).await {
        Ok(_) => panic!("a profile for another server was let onto this connection"),
        Err(error) => error.to_string(),
    };
    assert!(refused.contains("different server"), "{refused}");
    assert_eq!(*server.sessions.lock(), 2, "nothing was opened for it");
}

/// The registry `open_session` looks a shared connection up in: it hands
/// out the transports sessions are still holding, and nothing else.
#[tokio::test]
async fn the_registry_only_offers_connections_that_are_still_held() {
    let file = KnownHosts::new();
    let address = serve_once(ShellServer::default(), Preferred::default()).await;
    let transports = SshTransports::default();

    let transport = transport_to(address, file.path()).await;
    transports.register("first", &transport);
    assert!(transports.get("first").is_some());

    // A duplicate registers the same connection under its own id, so the
    // tab it was duplicated from can close without taking it down.
    transports.register("second", &transport);
    transports.forget("first");
    assert!(transports.get("first").is_none());
    assert!(transports.get("second").is_some());

    // Once the last session has let go there is nothing left to share:
    // a tab that asks for this connection dials its own instead.
    drop(transport);
    assert!(transports.get("second").is_none());
}

// --- keyboard-interactive authentication ---------------------------------

/// A throwaway ed25519 key. The seed only has to be constant, not secret:
/// these keys never leave the test process.
fn test_key(seed: u8) -> PrivateKey {
    PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
}

/// A private key file inside a private temporary directory that is
/// removed again on drop, since a profile names its key by path.
struct SecretKeyFile(PathBuf);

impl SecretKeyFile {
    fn new(key: &PrivateKey) -> Self {
        let dir = std::env::temp_dir().join(format!("edgeterm-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let path = dir.join("id_ed25519");
        let encoded = key.to_openssh(LineEnding::LF).expect("encode key");
        std::fs::write(&path, encoded.as_bytes()).expect("write key");
        SecretKeyFile(path)
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for SecretKeyFile {
    fn drop(&mut self) {
        if let Some(dir) = self.0.parent() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// One keyboard-interactive round the test server runs: what it asks, and
/// the answers it accepts.
#[derive(Clone, Copy)]
struct Round {
    instructions: &'static str,
    prompts: &'static [(&'static str, bool)],
    expected: &'static [&'static str],
}

/// How the test server answers the client's first authentication method.
#[derive(Clone, Copy)]
enum FirstReply {
    /// The credential is good, but the account needs the listed methods too.
    Partial(&'static [MethodKind]),
    /// The credential is refused; these methods are suggested instead.
    Refused(&'static [MethodKind]),
}

impl FirstReply {
    fn auth(self) -> Auth {
        let (methods, partial_success) = match self {
            FirstReply::Partial(methods) => (methods, true),
            FirstReply::Refused(methods) => (methods, false),
        };
        Auth::Reject {
            proceed_with_methods: Some(MethodSet::from(methods)),
            partial_success,
        }
    }
}

/// An SSH server that scripts one authentication exchange: it answers the
/// client's first method, then runs the keyboard-interactive rounds and
/// records every answer it received.
#[derive(Clone)]
struct AuthServer {
    first: FirstReply,
    rounds: &'static [Round],
    /// Whether the "none" method is granted, the way a device that has no
    /// password set does.
    open: bool,
    /// The methods a refused "none" lists; every method when unset.
    offered: Option<&'static [MethodKind]>,
    /// The password the `password` method accepts outright; any other
    /// password gets `first`.
    password: Option<&'static str>,
    /// The next round to ask.
    next: usize,
    answers: Arc<Mutex<Vec<Vec<String>>>>,
}

impl AuthServer {
    fn new(first: FirstReply, rounds: &'static [Round]) -> Self {
        Self {
            first,
            rounds,
            open: false,
            offered: None,
            password: None,
            next: 0,
            answers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// A server that asks for no authentication at all.
    fn open() -> Self {
        Self {
            open: true,
            ..Self::new(FirstReply::Refused(&[MethodKind::Password]), &[])
        }
    }

    fn offering(self, offered: &'static [MethodKind]) -> Self {
        Self {
            offered: Some(offered),
            ..self
        }
    }

    fn accepting(self, password: &'static str) -> Self {
        Self {
            password: Some(password),
            ..self
        }
    }
}

impl russh::server::Handler for AuthServer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
        if self.open {
            return Ok(Auth::Accept);
        }
        Ok(Auth::Reject {
            proceed_with_methods: self.offered.map(MethodSet::from),
            partial_success: false,
        })
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &PublicKey,
    ) -> std::result::Result<Auth, Self::Error> {
        Ok(self.first.auth())
    }

    async fn auth_password(
        &mut self,
        _user: &str,
        password: &str,
    ) -> std::result::Result<Auth, Self::Error> {
        self.answers.lock().push(vec![password.to_string()]);
        if self.password == Some(password) {
            return Ok(Auth::Accept);
        }
        Ok(self.first.auth())
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> std::result::Result<Auth, Self::Error> {
        if let Some(response) = response {
            let answers: Vec<String> = response
                .map(|value| String::from_utf8_lossy(&value).into_owned())
                .collect();
            let answered = self.rounds[self.next - 1];
            if !answers
                .iter()
                .map(String::as_str)
                .eq(answered.expected.iter().copied())
            {
                return Ok(Auth::reject());
            }
            self.answers.lock().push(answers);
        }
        let Some(round) = self.rounds.get(self.next) else {
            return Ok(Auth::Accept);
        };
        self.next += 1;
        Ok(Auth::Partial {
            name: "".into(),
            instructions: round.instructions.into(),
            prompts: round
                .prompts
                .iter()
                .map(|(prompt, echo)| ((*prompt).into(), *echo))
                .collect::<Vec<_>>()
                .into(),
        })
    }
}

/// The host key policy has its own tests above; these run against a
/// throwaway server whose key nothing has ever recorded.
struct AcceptAnyKey;

impl client::Handler for AcceptAnyKey {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Runs `server` on a loopback port for one connection, offering only the
/// `preferred` algorithms.
async fn serve_once<H>(server: H, preferred: Preferred) -> SocketAddr
where
    H: russh::server::Handler + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("local address");
    let config = Arc::new(russh::server::Config {
        keys: vec![test_key(1)],
        auth_rejection_time: Duration::ZERO,
        preferred,
        ..Default::default()
    });
    tokio::spawn(async move {
        let (stream, _) = listener.accept().await.expect("accept");
        // A negotiation the client walks away from ends here with an
        // error; judging that is the test's business.
        if let Ok(session) = russh::server::run_stream(config, stream, server).await {
            let _ = session.await;
        }
    });
    address
}

/// Runs `server` on a loopback port for one connection and hands back a
/// client transport that has finished the handshake but not authenticated.
async fn handshake(server: AuthServer) -> Handle<AcceptAnyKey> {
    let address = serve_once(server, Preferred::default()).await;
    client::connect(Arc::new(client::Config::default()), address, AcceptAnyKey)
        .await
        .expect("handshake")
}

/// The SSH server of an old switch or router: it lets anyone in, and
/// answers a group exchange with the 2048-bit group, the largest its
/// moduli go. What it offers is up to `serve_once`.
struct OldDevice;

impl russh::server::Handler for OldDevice {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn lookup_dh_gex_group(
        &mut self,
        _params: &GexParams,
    ) -> std::result::Result<Option<DhGroup>, Self::Error> {
        Ok(Some(DH_GROUP14.clone()))
    }
}

/// Accepts any host key and keeps what each key exchange settled on, the
/// way `Client` does.
struct Negotiated(LegacyRecord);

impl client::Handler for Negotiated {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }

    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &Names,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.0.record(names);
        Ok(())
    }
}

/// Connects with `config` to an `OldDevice` offering `offered` and logs
/// in, handing back the legacy algorithms the connection settled on.
async fn connect_to_old_device(
    offered: Preferred,
    config: client::Config,
) -> std::result::Result<Vec<String>, russh::Error> {
    let address = serve_once(OldDevice, offered).await;
    let legacy = LegacyRecord::default();
    let mut handle = client::connect(Arc::new(config), address, Negotiated(legacy.clone())).await?;
    let login = handle.authenticate_none("admin").await?;
    assert!(login.success(), "the device lets the session in");
    Ok(legacy.get())
}

/// A device with nothing newer than SHA-1 key exchange, CBC and SHA-1
/// MACs (issue #60) is out of reach with russh's defaults, connects with
/// EdgeTerm's lists, and the session reports what it connected on.
#[tokio::test]
async fn a_device_that_only_speaks_legacy_algorithms_connects_and_says_so() {
    let offered = || Preferred {
        kex: vec![
            kex::DH_G14_SHA1,
            kex::EXTENSION_SUPPORT_AS_SERVER,
            kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
        ]
        .into(),
        cipher: vec![cipher::AES_128_CBC].into(),
        mac: vec![mac::HMAC_SHA1].into(),
        ..Preferred::default()
    };

    let refused = connect_to_old_device(offered(), client::Config::default())
        .await
        .expect_err("russh's defaults share no key exchange method with the device");
    assert!(matches!(
        refused,
        russh::Error::NoCommonAlgo {
            kind: AlgorithmKind::Kex,
            ..
        }
    ));
    assert_eq!(
        handshake_failure(&refused),
        "no key exchange method in common with the server, which offers only: \
         diffie-hellman-group14-sha1"
    );

    let legacy = connect_to_old_device(offered(), client_config())
        .await
        .expect("EdgeTerm connects to the device");
    assert_eq!(
        legacy,
        ["diffie-hellman-group14-sha1", "aes128-cbc", "hmac-sha1"]
    );
}

/// The H3C switch from issue #60 offers the NIST curves ahead of its SHA-1
/// groups. Those are what it gets, so nothing is reported as legacy.
#[tokio::test]
async fn a_device_offering_nist_curves_gets_them_rather_than_sha1() {
    let offered = || Preferred {
        kex: vec![
            kex::ECDH_SHA2_NISTP256,
            kex::ECDH_SHA2_NISTP384,
            kex::DH_GEX_SHA1,
            kex::DH_G14_SHA1,
            kex::DH_G1_SHA1,
        ]
        .into(),
        ..Preferred::default()
    };

    assert!(
        connect_to_old_device(offered(), client::Config::default())
            .await
            .is_err(),
        "russh's defaults leave the switch out"
    );
    let legacy = connect_to_old_device(offered(), client_config())
        .await
        .expect("EdgeTerm connects to the switch");
    assert!(legacy.is_empty(), "{legacy:?}");
}

/// A group exchange is only sized once the method is settled, and russh
/// asks for 3072 bits by default: a device whose largest group is 2048
/// bits would fail the connection with no way back.
#[tokio::test]
async fn a_group_exchange_that_offers_a_2048_bit_group_connects() {
    let offered = || Preferred {
        kex: vec![kex::DH_GEX_SHA1].into(),
        ..Preferred::default()
    };

    let asking_for_3072_bits = client::Config {
        preferred: client_config().preferred,
        ..Default::default()
    };
    assert!(
        connect_to_old_device(offered(), asking_for_3072_bits)
            .await
            .is_err(),
        "a 2048-bit group is refused under russh's default floor"
    );
    let legacy = connect_to_old_device(offered(), client_config())
        .await
        .expect("EdgeTerm takes the 2048-bit group");
    assert_eq!(legacy, ["diffie-hellman-group-exchange-sha1"]);
}

/// A modern server never lands on a legacy algorithm just because it
/// also supports one.
#[tokio::test]
async fn a_modern_server_is_not_connected_on_legacy_algorithms() {
    let offered = Preferred {
        kex: [
            client_config().preferred.kex.as_ref(),
            &[kex::EXTENSION_SUPPORT_AS_SERVER],
        ]
        .concat()
        .into(),
        ..client_config().preferred
    };
    let legacy = connect_to_old_device(offered, client_config())
        .await
        .expect("connects");
    assert!(legacy.is_empty(), "{legacy:?}");
}

/// EdgeTerm spells out its own lists, so a russh upgrade that adds an
/// algorithm to its defaults must not slip by unoffered.
#[test]
fn every_algorithm_russh_offers_by_default_is_still_offered() {
    let ours = client_config().preferred;
    let defaults = Preferred::default();
    // Server-side markers mean nothing in a client's list.
    let server_markers = [
        kex::EXTENSION_SUPPORT_AS_SERVER,
        kex::EXTENSION_OPENSSH_STRICT_KEX_AS_SERVER,
    ];
    for name in defaults.kex.iter() {
        assert!(
            ours.kex.contains(name) || server_markers.contains(name),
            "{name:?}"
        );
    }
    for name in defaults.cipher.iter() {
        assert!(ours.cipher.contains(name), "{name:?}");
    }
    for name in defaults.mac.iter() {
        assert!(ours.mac.contains(name), "{name:?}");
    }
    assert_eq!(ours.key, defaults.key);
}

#[test]
fn legacy_choices_name_what_is_weak_and_nothing_else() {
    let sha2_mac = [&mac::HMAC_SHA256, &mac::HMAC_SHA256];
    assert!(legacy_choices(
        &kex::CURVE25519,
        &Algorithm::Ed25519,
        &cipher::AES_128_CTR,
        sha2_mac
    )
    .is_empty());

    assert_eq!(
        legacy_choices(
            &kex::ECDH_SHA2_NISTP256,
            &Algorithm::Rsa { hash: None },
            &cipher::AES_128_CTR,
            sha2_mac
        ),
        ["ssh-rsa"],
        "an RSA host key signing with SHA-1"
    );
    assert!(legacy_choices(
        &kex::ECDH_SHA2_NISTP256,
        &Algorithm::Rsa {
            hash: Some(HashAlg::Sha256)
        },
        &cipher::AES_128_CTR,
        sha2_mac
    )
    .is_empty());

    assert!(
        legacy_choices(
            &kex::CURVE25519,
            &Algorithm::Ed25519,
            &cipher::AES_256_GCM,
            [&mac::HMAC_SHA1, &mac::HMAC_SHA1]
        )
        .is_empty(),
        "the MAC settled beside an AEAD cipher is never used"
    );
    assert_eq!(
        legacy_choices(
            &kex::DH_G1_SHA1,
            &Algorithm::Ed25519,
            &cipher::AES_256_CTR,
            [&mac::HMAC_SHA1, &mac::HMAC_SHA1_ETM]
        ),
        [
            "diffie-hellman-group1-sha1",
            "hmac-sha1",
            "hmac-sha1-etm@openssh.com"
        ]
    );
}

fn public_key_profile(key: &SecretKeyFile) -> SessionProfile {
    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.auth = Some(AuthKind::PublicKey);
    profile.private_key_path = Some(key.path());
    profile
}

/// The JumpServer/KoKo shape from issue #34: the key is accepted, the
/// server then asks for a one-time code, and the login has to continue
/// instead of failing as "public key rejected".
#[tokio::test]
async fn a_public_key_that_needs_a_verification_code_finishes_the_login() {
    const ROUNDS: &[Round] = &[
        Round {
            instructions: "",
            prompts: &[("Verification code: ", false)],
            expected: &["424242"],
        },
        // Providers also send rounds that ask nothing and only carry text.
        Round {
            instructions: "Approve the push on your phone.",
            prompts: &[],
            expected: &[],
        },
    ];
    let server = AuthServer::new(
        FirstReply::Partial(&[MethodKind::KeyboardInteractive]),
        ROUNDS,
    );
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    let key = SecretKeyFile::new(&test_key(2));
    let user = Mutex::new(CannedAnswers::new([vec!["424242".to_string()]]));
    authenticate(
        &mut handle,
        &public_key_profile(&key),
        "alice",
        "mfa.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the second factor completes the login");

    assert_eq!(
        *answers.lock(),
        vec![vec!["424242".to_string()], Vec::<String>::new()]
    );
    let user = user.lock();
    assert_eq!(
        user.asked().len(),
        1,
        "only the round that asks something reaches the user"
    );
    let asked = &user.asked()[0];
    assert_eq!(asked.address, "mfa.example:22");
    assert_eq!(asked.username, "alice");
    assert_eq!(
        asked.prompts,
        [AuthPromptField {
            prompt: "Verification code: ".into(),
            echo: false,
        }]
    );
}

/// A device that was never given a root password — an OpenWrt/dropbear
/// router as it comes out of a flash (issue #37) — grants the "none"
/// method. The login goes through on that alone: no credential is sent
/// and the user is not asked for one.
#[tokio::test]
async fn a_server_that_asks_for_nothing_logs_straight_in() {
    let server = AuthServer::open();
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    // The default profile: password authentication with nothing saved.
    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.auth = Some(AuthKind::Password);

    let user = Mutex::new(CannedAnswers::default());
    authenticate(
        &mut handle,
        &profile,
        "root",
        "192.168.1.1:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("a server that asks for nothing lets the session in");

    assert!(
        answers.lock().is_empty(),
        "no password is sent to a server that already let the session in"
    );
    assert!(
        user.lock().asked().is_empty(),
        "nothing is asked of the user"
    );
}

/// A key the server simply refuses is still reported as a refused key,
/// and nothing is asked of the user.
#[tokio::test]
async fn a_refused_public_key_is_reported_as_a_refused_key() {
    let mut handle = handshake(AuthServer::new(
        FirstReply::Refused(&[MethodKind::PublicKey]),
        &[],
    ))
    .await;

    let key = SecretKeyFile::new(&test_key(2));
    let user = Mutex::new(CannedAnswers::default());
    let error = authenticate(
        &mut handle,
        &public_key_profile(&key),
        "alice",
        "mfa.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect_err("the server refuses the key");

    assert_eq!(
        error.to_string(),
        "authentication failed for alice (public key)"
    );
    assert!(user.lock().asked().is_empty());
}

/// An accepted credential whose account still needs a factor EdgeTerm
/// cannot run says so, rather than blaming the credential. russh's own
/// test server cannot set the partial-success flag, so the wording is
/// checked here rather than over a connection.
#[test]
fn an_accepted_credential_awaiting_another_factor_is_not_blamed() {
    let remaining = MethodSet::from(&[MethodKind::Password][..]);

    assert_eq!(
        auth_failure(AuthKind::PublicKey, "alice", true, &remaining).to_string(),
        concat!(
            "the public key was accepted for alice, but the server requires ",
            "another authentication factor and offers only: password"
        )
    );
    assert_eq!(
        auth_failure(AuthKind::PublicKey, "alice", false, &remaining).to_string(),
        "authentication failed for alice (public key)"
    );
    assert_eq!(
        auth_failure(AuthKind::Agent, "alice", false, &remaining).to_string(),
        "no identity in the ssh agent was accepted for alice"
    );
}

/// Servers that turn the password itself into a keyboard-interactive
/// round get the saved password without troubling the user; the code that
/// follows it is nowhere in the profile, so that one is asked for.
#[tokio::test]
async fn a_password_round_is_answered_from_the_profile_but_a_code_is_not() {
    const ROUNDS: &[Round] = &[
        Round {
            instructions: "",
            prompts: &[("Password: ", false)],
            expected: &["hunter2"],
        },
        Round {
            instructions: "",
            prompts: &[("Verification code: ", false)],
            expected: &["424242"],
        },
    ];
    let server = AuthServer::new(
        FirstReply::Refused(&[MethodKind::KeyboardInteractive]),
        ROUNDS,
    )
    .offering(&[MethodKind::KeyboardInteractive]);
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.auth = Some(AuthKind::Password);
    profile.password = Some("hunter2".into());

    let user = Mutex::new(CannedAnswers::new([vec!["424242".to_string()]]));
    authenticate(
        &mut handle,
        &profile,
        "alice",
        "mfa.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("password plus code completes the login");

    assert_eq!(
        *answers.lock(),
        vec![
            // The saved password as the first interactive round — the
            // server offers no `password` method to send it to —
            vec!["hunter2".to_string()],
            // and the code, which only the user could supply.
            vec!["424242".to_string()],
        ]
    );
    let user = user.lock();
    assert_eq!(user.asked().len(), 1);
    assert_eq!(user.asked()[0].prompts[0].prompt, "Verification code: ");
}

fn password_profile(password: Option<&str>) -> SessionProfile {
    let mut profile = crate::tests::profile(SessionKind::Ssh);
    profile.auth = Some(AuthKind::Password);
    profile.password = password.map(str::to_string);
    profile
}

fn password_question() -> Vec<AuthPromptField> {
    vec![AuthPromptField {
        prompt: "Password:".into(),
        echo: false,
    }]
}

/// A server that runs only the `password` method gives a profile with no
/// password nowhere to be asked for one, so EdgeTerm asks (issue #88), and
/// asks again after a typo the way OpenSSH does.
#[tokio::test]
async fn a_password_only_server_gets_the_password_asked_for() {
    let server = AuthServer::new(FirstReply::Refused(&[MethodKind::Password]), &[])
        .offering(&[MethodKind::Password])
        .accepting("hunter2");
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    let user = Mutex::new(CannedAnswers::new([
        vec!["hunter3".to_string()],
        vec!["hunter2".to_string()],
    ]));
    authenticate(
        &mut handle,
        &password_profile(None),
        "alice",
        "switch.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the typed password logs in");

    assert_eq!(
        *answers.lock(),
        vec![vec!["hunter3".to_string()], vec!["hunter2".to_string()]],
        "no empty password is sent before the user is asked"
    );
    let user = user.lock();
    assert_eq!(user.asked().len(), 2);
    assert_eq!(user.asked()[0].prompts, password_question());
    assert_eq!(user.asked()[0].instructions, "");
    assert_eq!(
        user.asked()[1].instructions,
        "Permission denied, please try again."
    );
}

/// Three refusals end the login, and so does a cancelled prompt.
#[tokio::test]
async fn asking_for_a_password_stops_after_three_tries_or_a_cancel() {
    let server = AuthServer::new(FirstReply::Refused(&[MethodKind::Password]), &[])
        .offering(&[MethodKind::Password]);
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;
    let user = Mutex::new(CannedAnswers::new(
        ["a", "b", "c", "d"].map(|answer| vec![answer.to_string()]),
    ));
    let error = authenticate(
        &mut handle,
        &password_profile(None),
        "alice",
        "switch.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect_err("every password is refused");
    assert_eq!(
        error.to_string(),
        "authentication failed for alice (password)"
    );
    assert_eq!(answers.lock().len(), 3);
    assert_eq!(user.lock().asked().len(), 3);

    let server = AuthServer::new(FirstReply::Refused(&[MethodKind::Password]), &[])
        .offering(&[MethodKind::Password]);
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;
    let user = Mutex::new(CannedAnswers::default());
    let error = authenticate(
        &mut handle,
        &password_profile(None),
        "alice",
        "switch.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect_err("the user cancelled");
    assert_eq!(error.to_string(), "authentication for alice was cancelled");
    assert!(
        answers.lock().is_empty(),
        "nothing is sent for a cancelled prompt"
    );
}

/// A saved password that was rotated elsewhere is refused once and then
/// asked for, never sent a second time: each refusal counts toward the
/// account's lockout.
#[tokio::test]
async fn a_refused_saved_password_is_asked_for_rather_than_resent() {
    let server = AuthServer::new(FirstReply::Refused(&[MethodKind::Password]), &[])
        .offering(&[MethodKind::Password])
        .accepting("rotated");
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    let user = Mutex::new(CannedAnswers::new([vec!["rotated".to_string()]]));
    authenticate(
        &mut handle,
        &password_profile(Some("hunter2")),
        "alice",
        "switch.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the new password logs in");

    assert_eq!(
        *answers.lock(),
        vec![vec!["hunter2".to_string()], vec!["rotated".to_string()]]
    );
    let user = user.lock();
    assert_eq!(user.asked().len(), 1);
    assert_eq!(user.asked()[0].instructions, SAVED_PASSWORD_REJECTED);
}

/// The same on a PAM server, which asks for the password again through
/// keyboard-interactive: that question goes to the user, with the reason
/// above it, rather than being answered with the password just refused.
#[tokio::test]
async fn a_refused_saved_password_is_not_resent_to_keyboard_interactive() {
    const ROUNDS: &[Round] = &[Round {
        instructions: "",
        prompts: &[("Password: ", false)],
        expected: &["rotated"],
    }];
    let server = AuthServer::new(
        FirstReply::Refused(&[MethodKind::Password, MethodKind::KeyboardInteractive]),
        ROUNDS,
    )
    .offering(&[MethodKind::Password, MethodKind::KeyboardInteractive]);
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    let user = Mutex::new(CannedAnswers::new([vec!["rotated".to_string()]]));
    authenticate(
        &mut handle,
        &password_profile(Some("hunter2")),
        "alice",
        "pam.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the new password logs in");

    assert_eq!(
        *answers.lock(),
        vec![vec!["hunter2".to_string()], vec!["rotated".to_string()]]
    );
    let user = user.lock();
    assert_eq!(user.asked().len(), 1);
    assert_eq!(user.asked()[0].prompts[0].prompt, "Password: ");
    assert_eq!(user.asked()[0].instructions, SAVED_PASSWORD_REJECTED);
}

/// With nothing saved and keyboard-interactive on offer, the server asks
/// for the password itself, as it does in OpenSSH; EdgeTerm neither sends
/// an empty password nor asks a second time.
#[tokio::test]
async fn with_nothing_saved_a_pam_server_asks_for_the_password_itself() {
    const ROUNDS: &[Round] = &[Round {
        instructions: "",
        prompts: &[("Password: ", false)],
        expected: &["hunter2"],
    }];
    let server = AuthServer::new(FirstReply::Refused(&[MethodKind::Password]), ROUNDS)
        .offering(&[MethodKind::Password, MethodKind::KeyboardInteractive]);
    let answers = server.answers.clone();
    let mut handle = handshake(server).await;

    let user = Mutex::new(CannedAnswers::new([vec!["hunter2".to_string()]]));
    authenticate(
        &mut handle,
        &password_profile(None),
        "alice",
        "pam.example:22",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the password typed into the server's round logs in");

    assert_eq!(*answers.lock(), vec![vec!["hunter2".to_string()]]);
    let user = user.lock();
    assert_eq!(user.asked().len(), 1);
    assert_eq!(user.asked()[0].prompts[0].prompt, "Password: ");
    assert_eq!(user.asked()[0].instructions, "");
}

#[test]
fn the_saved_password_answers_only_a_password_question() {
    let hidden = |prompt: &str| Prompt {
        prompt: prompt.to_string(),
        echo: false,
    };
    let mut saved = Some("hunter2".to_string());

    assert_eq!(
        saved_answer(&[hidden("Verification code: ")], &mut saved),
        None
    );
    assert_eq!(
        saved_answer(&[hidden("Password: "), hidden("Code: ")], &mut saved),
        None,
        "a round that asks for more than a password is the user's to answer"
    );
    assert_eq!(
        saved_answer(
            &[Prompt {
                prompt: "Password: ".into(),
                echo: true
            }],
            &mut saved
        ),
        None,
        "a question whose answer is echoed is not asking for a secret"
    );

    assert_eq!(
        saved_answer(&[hidden("Password: ")], &mut saved),
        Some("hunter2".to_string())
    );
    assert_eq!(
        saved_answer(&[hidden("Password: ")], &mut saved),
        None,
        "the saved password is offered once; a second refusal is the user's to answer"
    );
}

// --- SFTP fixture and the public-key install (phase 3) ----------------------

use crate::authorized_keys::{install, InstallOutcome};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{
    Attrs, Data as SftpData, File as SftpFile, FileAttributes, Handle as SftpHandle, Name,
    OpenFlags, Status, StatusCode, Version,
};
use std::collections::HashMap;
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};

/// An SSH server whose SFTP subsystem is a real directory on this machine, so
/// everything the public-key install writes over SFTP can be read back from
/// disk. The login is accepted without authentication, like the other shell
/// fixtures.
#[derive(Clone)]
struct SftpHomeServer {
    root: PathBuf,
    channels:
        Arc<tokio::sync::Mutex<HashMap<russh::ChannelId, russh::Channel<russh::server::Msg>>>>,
    /// Applied when the next file write reaches the subsystem: how a test
    /// stages an edit of the file under an install (see
    /// `a_concurrent_edit_stops_the_install_before_it_replaces_the_file`).
    concurrent_edit: Arc<Mutex<Option<(String, Vec<u8>)>>>,
}

impl SftpHomeServer {
    fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            channels: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            concurrent_edit: Arc::new(Mutex::new(None)),
        }
    }

    /// Appends `content` to the virtual `path` right before the subsystem
    /// handles its next write, as another process editing the file would.
    fn tamper(&self, path: &str, content: &[u8]) {
        *self.concurrent_edit.lock() = Some((path.to_string(), content.to_vec()));
    }
}

impl russh::server::Handler for SftpHomeServer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.channels.lock().await.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: russh::ChannelId,
        name: &str,
        session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        let stored = self.channels.lock().await.remove(&channel);
        match (name == "sftp", stored) {
            (true, Some(stored)) => {
                session.channel_success(channel)?;
                let files = SftpFiles {
                    root: self.root.clone(),
                    concurrent_edit: self.concurrent_edit.clone(),
                    ..Default::default()
                };
                russh_sftp::server::run(stored.into_stream(), files).await;
            }
            _ => session.channel_failure(channel)?,
        }
        Ok(())
    }
}

/// The filesystem behind the fixture's SFTP subsystem. Paths are the
/// virtual, absolute ones a client sees, rooted at the server's home
/// directory: `/` is the login's home, `/.ssh/authorized_keys` the file the
/// install works on.
#[derive(Default)]
struct SftpFiles {
    root: PathBuf,
    concurrent_edit: Arc<Mutex<Option<(String, Vec<u8>)>>>,
    /// The open files, keyed by the handle string the client keeps.
    open: HashMap<String, std::fs::File>,
    serial: u64,
}

impl SftpFiles {
    fn local(&self, virtual_path: &str) -> PathBuf {
        let relative = virtual_path.trim_start_matches('.').trim_matches('/');
        self.root.join(relative)
    }
}

/// The attributes the SFTP client reads from a local file.
fn attrs_of(meta: &std::fs::Metadata) -> FileAttributes {
    let mut attrs = FileAttributes::default();
    attrs.size = Some(meta.len());
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        attrs.uid = Some(meta.uid());
        attrs.gid = Some(meta.gid());
        attrs.permissions = Some(meta.permissions().mode());
        attrs.mtime = Some(meta.mtime() as u32);
    }
    #[cfg(not(unix))]
    {
        if meta.is_dir() {
            attrs.set_dir(true);
            attrs.permissions = attrs.permissions.map(|mode| mode | 0o755);
        } else {
            attrs.set_regular(true);
            attrs.permissions = attrs.permissions.map(|mode| mode | 0o644);
        }
        attrs.mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|since| since.as_secs() as u32);
    }
    attrs
}

/// The status code a local I/O failure becomes.
fn io_status(error: &std::io::Error) -> StatusCode {
    match error.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NoSuchFile,
        std::io::ErrorKind::PermissionDenied => StatusCode::PermissionDenied,
        _ => StatusCode::Failure,
    }
}

fn ok(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "Ok".to_string(),
        language_tag: "en-US".to_string(),
    }
}

/// Applies the permissions an `attrs` packet carries, where the platform has
/// them; the mode a create asked for is otherwise only a hint.
#[allow(unused_variables)]
fn set_mode(path: &Path, attrs: &FileAttributes) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Some(mode) = attrs.permissions {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode & 0o777))?;
        }
    }
    Ok(())
}

impl russh_sftp::server::Handler for SftpFiles {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let relative = path.trim_start_matches('.').trim_matches('/').to_string();
        if !self.root.join(&relative).exists() {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Name {
            id,
            files: vec![SftpFile::dummy(format!("/{relative}"))],
        })
    }

    async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta =
            std::fs::symlink_metadata(self.local(&path)).map_err(|error| io_status(&error))?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        let meta = std::fs::metadata(self.local(&path)).map_err(|error| io_status(&error))?;
        Ok(Attrs {
            id,
            attrs: attrs_of(&meta),
        })
    }

    async fn setstat(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        set_mode(&self.local(&path), &attrs).map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        attrs: FileAttributes,
    ) -> Result<SftpHandle, Self::Error> {
        let local = self.local(&filename);
        // Only the unix branch below can use a mode; Windows has none.
        #[cfg_attr(not(unix), allow(unused_variables))]
        let requested_mode = attrs.permissions;
        let mut options = std::fs::OpenOptions::new();
        options.read(pflags.contains(OpenFlags::READ));
        options.write(pflags.contains(OpenFlags::WRITE));
        options.append(pflags.contains(OpenFlags::APPEND));
        options.truncate(pflags.contains(OpenFlags::TRUNCATE));
        if pflags.contains(OpenFlags::EXCLUDE) {
            options.create_new(true);
        } else {
            options.create(pflags.contains(OpenFlags::CREATE));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if let Some(mode) = requested_mode {
                options.mode(mode & 0o777);
            }
        }
        let file = options.open(&local).map_err(|error| io_status(&error))?;
        let handle = format!("fh-{}", self.serial);
        self.serial += 1;
        self.open.insert(handle.clone(), file);
        Ok(SftpHandle { id, handle })
    }

    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        self.open.remove(&handle);
        Ok(ok(id))
    }

    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<SftpData, Self::Error> {
        let file = self.open.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| io_status(&error))?;
        let mut data = vec![0u8; len as usize];
        let read = file.read(&mut data).map_err(|error| io_status(&error))?;
        if read == 0 {
            return Err(StatusCode::Eof);
        }
        data.truncate(read);
        Ok(SftpData { id, data })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        // A staged concurrent edit lands right before the subsystem handles
        // a write, between the install's read of the file and its replace.
        if let Some((path, content)) = self.concurrent_edit.lock().take() {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(self.local(&path))
                .map_err(|error| io_status(&error))?;
            file.write_all(&content)
                .map_err(|error| io_status(&error))?;
        }
        let file = self.open.get_mut(&handle).ok_or(StatusCode::Failure)?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| io_status(&error))?;
        file.write_all(&data).map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn remove(&mut self, id: u32, filename: String) -> Result<Status, Self::Error> {
        std::fs::remove_file(self.local(&filename)).map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn mkdir(
        &mut self,
        id: u32,
        path: String,
        attrs: FileAttributes,
    ) -> Result<Status, Self::Error> {
        let local = self.local(&path);
        std::fs::create_dir(&local).map_err(|error| io_status(&error))?;
        set_mode(&local, &attrs).map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn rename(
        &mut self,
        id: u32,
        oldpath: String,
        newpath: String,
    ) -> Result<Status, Self::Error> {
        // A plain `rename(2)`, overwriting like OpenSSH's sftp-server does.
        std::fs::rename(self.local(&oldpath), self.local(&newpath))
            .map_err(|error| io_status(&error))?;
        Ok(ok(id))
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }
}

/// Opens the SFTP subsystem of `transport`, the way the install command does.
async fn sftp_on(transport: &Arc<SharedTransport>) -> SftpSession {
    SftpSession::new(transport.transfer_channel().await.expect("sftp subsystem"))
        .await
        .expect("sftp session")
}

/// The key the install tests put on the server; the fixture accepts any key,
/// so its private half is never needed.
fn install_key() -> (&'static str, &'static str) {
    ED25519_A.split_once(' ').expect("type and data")
}

#[tokio::test]
async fn installing_a_key_creates_the_ssh_directory_and_the_file() {
    let file = KnownHosts::new();
    let home = file.path().parent().expect("scratch").join("home");
    std::fs::create_dir_all(&home).expect("home");

    let address = serve_once(SftpHomeServer::new(&home), Preferred::default()).await;
    let transport = transport_to(address, file.path()).await;
    let sftp = sftp_on(&transport).await;

    let (key_type, data) = install_key();
    let report = install(&sftp, "/", key_type, data, Some("edgeterm"))
        .await
        .expect("install");
    assert_eq!(report.outcome, InstallOutcome::Added);
    assert_eq!(report.path, "/.ssh/authorized_keys");
    assert_eq!(
        std::fs::read_to_string(home.join(".ssh/authorized_keys")).expect("file"),
        format!("{key_type} {data} edgeterm\n")
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(home.join(".ssh"))
                .expect("dir")
                .permissions()
                .mode()
                & 0o777,
            0o700,
            "the created .ssh must be owner-only"
        );
        assert_eq!(
            std::fs::metadata(home.join(".ssh/authorized_keys"))
                .expect("file")
                .permissions()
                .mode()
                & 0o777,
            0o600,
            "the installed file must be owner-only"
        );
    }
}

#[tokio::test]
async fn installing_a_key_preserves_the_existing_file_around_the_appended_line() {
    let file = KnownHosts::new();
    let home = file.path().parent().expect("scratch").join("home");
    std::fs::create_dir_all(home.join(".ssh")).expect(".ssh");
    // No final newline: the append has to repair it without losing the line.
    std::fs::write(
        home.join(".ssh/authorized_keys"),
        "# keep me\nssh-rsa AAAA old@host",
    )
    .expect("stage file");

    let address = serve_once(SftpHomeServer::new(&home), Preferred::default()).await;
    let transport = transport_to(address, file.path()).await;
    let sftp = sftp_on(&transport).await;

    let (key_type, data) = install_key();
    let report = install(&sftp, "/", key_type, data, None)
        .await
        .expect("install");
    assert_eq!(report.outcome, InstallOutcome::Added);
    assert_eq!(
        std::fs::read_to_string(home.join(".ssh/authorized_keys")).expect("file"),
        format!("# keep me\nssh-rsa AAAA old@host\n{key_type} {data}\n")
    );

    // The same key, whatever comment it now carries, is already there.
    let before = std::fs::read(home.join(".ssh/authorized_keys")).expect("file");
    let again = install(&sftp, "/", key_type, data, Some("somewhere else"))
        .await
        .expect("install again");
    assert_eq!(again.outcome, InstallOutcome::Present);
    assert_eq!(
        std::fs::read(home.join(".ssh/authorized_keys")).expect("file"),
        before,
        "a present key is never written twice"
    );

    // A copy behind restrictions is left alone; no unrestricted line appears.
    let restricted_line = format!("from=\"10.0.0.1\" {key_type} {data}\n");
    std::fs::write(home.join(".ssh/authorized_keys"), &restricted_line).expect("stage");
    let restricted = install(&sftp, "/", key_type, data, None)
        .await
        .expect("restricted install");
    assert_eq!(restricted.outcome, InstallOutcome::PresentRestricted);
    assert_eq!(restricted.options.as_deref(), Some("from=\"10.0.0.1\""));
    assert_eq!(
        std::fs::read_to_string(home.join(".ssh/authorized_keys")).expect("file"),
        restricted_line
    );
}

#[tokio::test]
async fn a_concurrent_edit_stops_the_install_before_it_replaces_the_file() {
    let file = KnownHosts::new();
    let home = file.path().parent().expect("scratch").join("home");
    std::fs::create_dir_all(home.join(".ssh")).expect(".ssh");
    std::fs::write(home.join(".ssh/authorized_keys"), "# keep me\n").expect("stage file");

    let server = SftpHomeServer::new(&home);
    // Another process adds a line while the install is between its read and
    // its replace; the install must notice and write nothing.
    server.tamper("/.ssh/authorized_keys", b"someone@else ssh-ed25519 OTHER\n");
    let address = serve_once(server, Preferred::default()).await;
    let transport = transport_to(address, file.path()).await;
    let sftp = sftp_on(&transport).await;

    let (key_type, data) = install_key();
    let error = install(&sftp, "/", key_type, data, None)
        .await
        .expect_err("the edit must stop the install");
    assert!(
        error.to_string().contains("changed on the server"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(home.join(".ssh/authorized_keys")).expect("file"),
        "# keep me\nsomeone@else ssh-ed25519 OTHER\n",
        "the concurrent edit survives and the key is not half-written"
    );
    let leftovers: Vec<_> = std::fs::read_dir(home.join(".ssh"))
        .expect(".ssh")
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with(".authorized_keys.edgeterm-")
        })
        .collect();
    assert!(leftovers.is_empty(), "no temporary file may be left behind");
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_authorized_keys_is_refused() {
    let file = KnownHosts::new();
    let home = file.path().parent().expect("scratch").join("home");
    std::fs::create_dir_all(home.join(".ssh")).expect(".ssh");
    let target = home.join("real_keys");
    std::fs::write(&target, "# elsewhere\n").expect("target");
    std::os::unix::fs::symlink(&target, home.join(".ssh/authorized_keys")).expect("symlink");

    let address = serve_once(SftpHomeServer::new(&home), Preferred::default()).await;
    let transport = transport_to(address, file.path()).await;
    let sftp = sftp_on(&transport).await;

    let (key_type, data) = install_key();
    let error = install(&sftp, "/", key_type, data, None)
        .await
        .expect_err("a symlink is not where a login's keys belong");
    assert!(
        error.to_string().contains("symlink"),
        "unexpected error: {error}"
    );
    assert_eq!(
        std::fs::read_to_string(&target).expect("target"),
        "# elsewhere\n",
        "the symlink's target is untouched"
    );
}

// --- public-key checks ----------------------------------------------------

/// What a check fixture answers one connection's public-key attempt with.
#[derive(Clone, Copy)]
enum KeyReply {
    /// Any public key is accepted.
    Accept,
    /// The key is refused with password and keyboard-interactive suggested —
    /// and both *would* be accepted on this connection, so a client that
    /// fell back would get in and the record would show it.
    FallbackWouldWork,
    /// No answer until the client's own deadline passes.
    Stall(Duration),
}

/// The methods a refused "none" lists for a connection a check runs on.
const CHECK_OFFERED: &[MethodKind] = &[
    MethodKind::PublicKey,
    MethodKind::Password,
    MethodKind::KeyboardInteractive,
];
const KBD_ONLY: &[MethodKind] = &[MethodKind::KeyboardInteractive];

/// An SSH server for public-key checks: connection `0` is the session's own
/// login (accepted without authentication when `open`), later connections
/// answer the check's key attempt with `reply`, and every attempt is
/// recorded as `"<connection>:<method>"` so a test can prove what was never
/// tried.
#[derive(Clone)]
struct CheckServer {
    index: usize,
    open: bool,
    reply: KeyReply,
    password: bool,
    record: Arc<Mutex<Vec<String>>>,
}

impl russh::server::Handler for CheckServer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
        self.record.lock().push(format!("{}:none", self.index));
        if self.open {
            return Ok(Auth::Accept);
        }
        Ok(Auth::Reject {
            proceed_with_methods: Some(MethodSet::from(CHECK_OFFERED)),
            partial_success: false,
        })
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _key: &PublicKey,
    ) -> std::result::Result<Auth, Self::Error> {
        self.record.lock().push(format!("{}:publickey", self.index));
        Ok(match self.reply {
            KeyReply::Accept => Auth::Accept,
            KeyReply::FallbackWouldWork => Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(CHECK_OFFERED)),
                partial_success: false,
            },
            KeyReply::Stall(period) => {
                tokio::time::sleep(period).await;
                Auth::Accept
            }
        })
    }

    async fn auth_password(
        &mut self,
        _user: &str,
        password: &str,
    ) -> std::result::Result<Auth, Self::Error> {
        self.record
            .lock()
            .push(format!("{}:password:{password}", self.index));
        Ok(if self.password {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_keyboard_interactive<'a>(
        &'a mut self,
        _user: &str,
        _submethods: &str,
        _response: Option<Response<'a>>,
    ) -> std::result::Result<Auth, Self::Error> {
        self.record
            .lock()
            .push(format!("{}:keyboard-interactive", self.index));
        Ok(Auth::Accept)
    }
}

/// A jump host for check tests: no authentication, and every `direct-tcpip`
/// request is dialled and proxied, the way a `ProxyJump` host's is.
#[derive(Clone)]
struct JumpServer {
    record: Arc<Mutex<Vec<String>>>,
    proxied: Arc<std::sync::atomic::AtomicUsize>,
}

impl russh::server::Handler for JumpServer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
        self.record.lock().push("none".into());
        Ok(Auth::Accept)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: russh::Channel<russh::server::Msg>,
        host: &str,
        port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut russh::server::Session,
    ) -> std::result::Result<(), Self::Error> {
        let mut target = tokio::net::TcpStream::connect((host, port as u16)).await?;
        reply.accept().await;
        self.proxied
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let mut stream = channel.into_stream();
        tokio::spawn(async move {
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut target).await;
        });
        Ok(())
    }
}

/// Runs a server on a loopback port that accepts `count` connections one
/// after another, handing connection `index` the handler `handler(index)`
/// returns — the shape a test needs when the first connection is the
/// session's login and the next one is the check's.
async fn serve_each<H, F>(count: usize, mut handler: F, preferred: Preferred) -> SocketAddr
where
    H: russh::server::Handler + Send + 'static,
    F: FnMut(usize) -> H + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let address = listener.local_addr().expect("local address");
    let config = Arc::new(russh::server::Config {
        keys: vec![test_key(1)],
        auth_rejection_time: Duration::ZERO,
        preferred,
        ..Default::default()
    });
    tokio::spawn(async move {
        for index in 0..count {
            let (stream, _) = listener.accept().await.expect("accept");
            let server = handler(index);
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = russh::server::run_stream(config, stream, server).await {
                    let _ = session.await;
                }
            });
        }
    });
    address
}

/// The profile a check runs: the session's endpoint, public-key auth and the
/// key under test.
fn check_profile(address: SocketAddr, key: &SecretKeyFile) -> SessionProfile {
    let mut profile = profile_for(address);
    profile.auth = Some(AuthKind::PublicKey);
    profile.private_key_path = Some(key.path());
    profile
}

/// Logs a session in through `jump` to `target` the way a `ProxyJump`
/// session is opened: the target's handshake runs inside a `direct-tcpip`
/// channel of the jump, and the live transport keeps the jump as its hop.
async fn transport_through(
    jump: SocketAddr,
    target: SocketAddr,
    known_hosts: &Path,
) -> Arc<SharedTransport> {
    let forwards = Arc::new(crate::port_forward::ForwardRoutes::default());
    let client = |at: SocketAddr| Client {
        forwards: forwards.clone(),
        host: at.ip().to_string(),
        port: at.port(),
        legacy: LegacyRecord::default(),
        known_hosts: Some(known_hosts.to_path_buf()),
    };
    let user = Mutex::new(CannedAnswers::default());
    let mut jump_handle = client::connect(Arc::new(client_config()), jump, client(jump))
        .await
        .expect("jump handshake");
    authenticate(
        &mut jump_handle,
        &profile_for(jump),
        "ops",
        "127.0.0.1",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the jump host lets the session in");
    let tunnel = jump_handle
        .channel_open_direct_tcpip(
            target.ip().to_string(),
            u32::from(target.port()),
            "127.0.0.1",
            0,
        )
        .await
        .expect("direct-tcpip to the target");
    let mut handle = client::connect_stream(
        Arc::new(client_config()),
        tunnel.into_stream(),
        client(target),
    )
    .await
    .expect("target handshake");
    authenticate(
        &mut handle,
        &profile_for(target),
        "ops",
        "127.0.0.1",
        &AuthPrompter::canned(&user),
        AuthFlow::Interactive,
        &request(),
    )
    .await
    .expect("the target lets the session in");
    Arc::new(SharedTransport {
        forwards,
        handle: Arc::new(handle),
        hops: Some(Hops(vec![(jump_handle, jump.to_string())])),
        legacy: Vec::new(),
        endpoint: Endpoint::of(&profile_for(target)),
    })
}

#[tokio::test]
async fn a_key_check_opens_its_own_connection_and_accepts_the_key() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(7));
    let record = Arc::new(Mutex::new(Vec::new()));
    // Connection 0 is the session's own login, accepted without
    // authentication. The check's connection has to get in on the key, and a
    // password would work there — so a fallback would succeed and be
    // recorded.
    let address = serve_each(
        2,
        {
            let record = record.clone();
            move |index| CheckServer {
                index,
                open: index == 0,
                reply: KeyReply::Accept,
                password: true,
                record: record.clone(),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    let check = key_check(
        &transport,
        &check_profile(address, &key),
        &request(),
        &Control::default(),
        Duration::from_secs(5),
        Some(file.path().to_path_buf()),
    )
    .await
    .expect("the check itself does not fail");

    assert_eq!(check.outcome, KeyCheckOutcome::Ready, "{}", check.message);
    let entries = record.lock().clone();
    assert_eq!(
        entries,
        ["0:none", "1:none", "1:publickey"],
        "the key is checked on a connection of its own, after none is refused"
    );
    assert!(
        !transport.is_closed(),
        "the session's own connection is untouched"
    );
}

#[tokio::test]
async fn a_key_check_never_answers_a_server_that_offers_a_way_in() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(8));
    let record = Arc::new(Mutex::new(Vec::new()));
    let address = serve_each(
        2,
        {
            let record = record.clone();
            move |index| CheckServer {
                index,
                open: index == 0,
                // The key is refused with a password and a keyboard-
                // interactive prompt suggested, and both would be accepted:
                // a client that fell back would report a login it never
                // proved from the key.
                reply: KeyReply::FallbackWouldWork,
                password: true,
                record: record.clone(),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    let check = key_check(
        &transport,
        &check_profile(address, &key),
        &request(),
        &Control::default(),
        Duration::from_secs(5),
        Some(file.path().to_path_buf()),
    )
    .await
    .expect("the check itself does not fail");

    assert_eq!(check.outcome, KeyCheckOutcome::Denied, "{}", check.message);
    let entries = record.lock().clone();
    assert!(
        !entries.iter().any(|entry| entry.contains("password")),
        "a check never sends a password: {entries:?}"
    );
    assert!(
        !entries
            .iter()
            .any(|entry| entry.contains("keyboard-interactive")),
        "a check has nobody to answer a prompt: {entries:?}"
    );
}

/// A real server's "your key is good, now the code" answer — the MFA shape
/// `AuthenticationMethods publickey,keyboard-interactive` produces — is
/// reported as itself instead of falling into keyboard-interactive, which a
/// check has nobody to answer.
///
/// The verdict is pinned here rather than end to end: russh 0.62.5's server
/// resets `partial_success` on the publickey path (its `encrypted.rs`), so no
/// in-process fixture can put that answer on the wire.
#[test]
fn a_key_only_attempt_reports_an_accepted_key_that_still_needs_a_factor() {
    let challenged = key_only_verdict("ops", &MethodSet::from(KBD_ONLY), true)
        .expect_err("a factor is still missing");
    assert_eq!(challenged.code, ErrorCode::AdditionalFactorRequired);

    let refused = key_only_verdict("ops", &MethodSet::from(CHECK_OFFERED), false)
        .expect_err("the key was refused");
    assert_eq!(refused.code, ErrorCode::AuthenticationDenied);
    assert!(
        refused.to_string().contains("public key"),
        "the refusal names the method: {refused}"
    );
}

/// Every answer a check can end on has an outcome of its own, so the dialog
/// never has to guess from a message.
#[test]
fn a_key_check_turns_each_answer_into_an_outcome() {
    let cases = [
        (
            ErrorCode::AdditionalFactorRequired,
            KeyCheckOutcome::AdditionalFactor,
        ),
        (ErrorCode::AuthenticationDenied, KeyCheckOutcome::Denied),
        (ErrorCode::InvalidInput, KeyCheckOutcome::KeyUnusable),
        (ErrorCode::PermissionDenied, KeyCheckOutcome::KeyUnusable),
        (ErrorCode::Timeout, KeyCheckOutcome::Timeout),
        (ErrorCode::Cancelled, KeyCheckOutcome::Cancelled),
        (ErrorCode::ConnectionFailed, KeyCheckOutcome::Unreachable),
        (ErrorCode::Unknown, KeyCheckOutcome::Unreachable),
    ];
    for (code, expected) in cases {
        let check = KeyCheck::from_error(AppError::coded(code, "detail"));
        assert_eq!(check.outcome, expected, "{code:?}");
        assert_eq!(check.message, "detail");
        assert!(check.change.is_none(), "{code:?}");
    }
}

#[tokio::test]
async fn a_key_check_reports_a_login_that_needs_no_authentication() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(12));
    let record = Arc::new(Mutex::new(Vec::new()));
    // Both connections accept "none": the server lets this login in without
    // any credential, so the key is never sent and never proven.
    let address = serve_each(
        2,
        {
            let record = record.clone();
            move |index| CheckServer {
                index,
                open: true,
                reply: KeyReply::Accept,
                password: false,
                record: record.clone(),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    let check = key_check(
        &transport,
        &check_profile(address, &key),
        &request(),
        &Control::default(),
        Duration::from_secs(5),
        Some(file.path().to_path_buf()),
    )
    .await
    .expect("the check itself does not fail");

    assert_eq!(
        check.outcome,
        KeyCheckOutcome::NotRequired,
        "{}",
        check.message
    );
    let entries = record.lock().clone();
    assert_eq!(
        entries,
        ["0:none", "1:none"],
        "a server that wants nothing never sees the key"
    );
}

#[tokio::test]
async fn a_key_check_refuses_a_profile_the_session_is_not_for() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(13));
    let record = Arc::new(Mutex::new(Vec::new()));
    let address = serve_each(
        1,
        {
            let record = record.clone();
            move |index| CheckServer {
                index,
                open: true,
                reply: KeyReply::Accept,
                password: false,
                record: record.clone(),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    let mut elsewhere = check_profile(address, &key);
    elsewhere.host = Some("10.0.0.9".into());
    let error = key_check(
        &transport,
        &elsewhere,
        &request(),
        &Control::default(),
        Duration::from_secs(5),
        Some(file.path().to_path_buf()),
    )
    .await
    .expect_err("a profile for another server is never checked here");
    assert!(error.to_string().contains("different server"), "{error}");

    let entries = record.lock().clone();
    assert_eq!(entries, ["0:none"], "no second connection was dialled");
}

#[tokio::test]
async fn a_key_check_reports_a_changed_host_key_before_checking_the_key() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(14));
    let record = Arc::new(Mutex::new(Vec::new()));
    let address = serve_each(
        2,
        {
            let record = record.clone();
            move |index| CheckServer {
                index,
                open: index == 0,
                reply: KeyReply::Accept,
                password: false,
                record: record.clone(),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    // A scratch known_hosts holding a different key for the address, the
    // way a reinstalled server looks to the check's dial.
    let staged = KnownHosts::new();
    staged.write(&format!(
        "[{}]:{} {ED25519_B}\n",
        address.ip(),
        address.port()
    ));

    let check = key_check(
        &transport,
        &check_profile(address, &key),
        &request(),
        &Control::default(),
        Duration::from_secs(5),
        Some(staged.path().to_path_buf()),
    )
    .await
    .expect("a changed host key is an outcome, not an error");

    assert_eq!(
        check.outcome,
        KeyCheckOutcome::HostKeyChanged,
        "{}",
        check.message
    );
    assert!(
        check.change.is_some(),
        "the change is handed over for the user's decision"
    );
    let entries = record.lock().clone();
    assert_eq!(
        entries,
        ["0:none"],
        "the key is never sent to a host whose identity is in question"
    );
}

#[tokio::test]
async fn a_key_check_times_out_on_a_server_that_never_answers() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(15));
    let address = serve_each(
        2,
        {
            move |index| CheckServer {
                index,
                open: index == 0,
                reply: KeyReply::Stall(Duration::from_secs(30)),
                password: false,
                record: Arc::new(Mutex::new(Vec::new())),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    let check = key_check(
        &transport,
        &check_profile(address, &key),
        &request(),
        &Control::default(),
        Duration::from_millis(300),
        Some(file.path().to_path_buf()),
    )
    .await
    .expect("the check itself does not fail");

    assert_eq!(check.outcome, KeyCheckOutcome::Timeout, "{}", check.message);
}

#[tokio::test]
async fn a_key_check_stops_when_it_is_cancelled() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(16));
    let address = serve_each(
        2,
        {
            move |index| CheckServer {
                index,
                open: index == 0,
                reply: KeyReply::Stall(Duration::from_secs(30)),
                password: false,
                record: Arc::new(Mutex::new(Vec::new())),
            }
        },
        Preferred::default(),
    )
    .await;
    let transport = transport_to(address, file.path()).await;

    let control = Arc::new(Control::default());
    let running = tokio::spawn({
        let transport = transport.clone();
        let profile = check_profile(address, &key);
        let control = control.clone();
        let known_hosts = file.path().to_path_buf();
        async move {
            key_check(
                &transport,
                &profile,
                &request(),
                &control,
                Duration::from_secs(30),
                Some(known_hosts),
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    control.set(2);

    let check = running
        .await
        .expect("the task finishes")
        .expect("the check itself does not fail");
    assert_eq!(
        check.outcome,
        KeyCheckOutcome::Cancelled,
        "{}",
        check.message
    );
}

#[tokio::test]
async fn a_key_check_tunnels_through_the_sessions_own_jump_host() {
    let file = KnownHosts::new();
    let key = SecretKeyFile::new(&test_key(17));
    let jump_record = Arc::new(Mutex::new(Vec::new()));
    let proxied = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let target_record = Arc::new(Mutex::new(Vec::new()));
    // The jump host takes the session's one connection; the target takes the
    // session's login and then the check's own connection.
    let jump = serve_each(
        1,
        {
            let jump_record = jump_record.clone();
            let proxied = proxied.clone();
            move |_| JumpServer {
                record: jump_record.clone(),
                proxied: proxied.clone(),
            }
        },
        Preferred::default(),
    )
    .await;
    let target = serve_each(
        2,
        {
            let target_record = target_record.clone();
            move |index| CheckServer {
                index,
                open: index == 0,
                reply: KeyReply::Accept,
                password: false,
                record: target_record.clone(),
            }
        },
        Preferred::default(),
    )
    .await;

    let transport = transport_through(jump, target, file.path()).await;
    let check = key_check(
        &transport,
        &check_profile(target, &key),
        &request(),
        &Control::default(),
        Duration::from_secs(5),
        Some(file.path().to_path_buf()),
    )
    .await
    .expect("the check itself does not fail");

    assert_eq!(check.outcome, KeyCheckOutcome::Ready, "{}", check.message);
    let logins = jump_record.lock().clone();
    assert_eq!(
        logins,
        ["none"],
        "the live hop is the path; the jump host is not authenticated again"
    );
    assert_eq!(
        proxied.load(std::sync::atomic::Ordering::SeqCst),
        2,
        "the check's handshake rides the session's own hop"
    );
    let entries = target_record.lock().clone();
    assert_eq!(
        entries,
        ["0:none", "1:none", "1:publickey"],
        "the check is a fresh connection to the target"
    );
}
