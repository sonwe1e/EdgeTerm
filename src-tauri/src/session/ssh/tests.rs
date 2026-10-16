use std::path::{Path, PathBuf};

use russh::keys::PublicKey;

use super::{
    auth_failure, authenticate, client_config, connect, connect_on, connect_sftp, ensure_sftp,
    handshake_failure, legacy_choices, open_shell, replace_host_key, run_sftp, saved_answer,
    verify_host_key, AuthPrompter, Client, ConnectOutcome, Endpoint, Handle, HandshakeError, Hops,
    LegacyRecord, Prompt, Request, SftpConnectOutcome, SftpRequest, SftpResponse, SharedTransport,
    SshTransports, SAVED_PASSWORD_REJECTED,
};
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
