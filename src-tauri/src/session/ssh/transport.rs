use super::*;

/// One authenticated SSH transport, and everything that has to outlive the
/// sessions running on it. A shell is one channel of it, the Filer's SFTP
/// subsystem another, and a duplicated tab is simply one more — which is why
/// this is shared: a server behind MFA asks for the second factor when the
/// transport is built, so every session that rides on this one gets in
/// without asking again.
///
/// The transport goes down when the last session holding it lets go (see
/// `Drop`), not when the session that opened it ends: a duplicate outlives
/// the tab it was duplicated from.
pub struct SharedTransport {
    pub(super) forwards: Arc<crate::port_forward::ForwardRoutes>,
    pub(super) handle: Arc<Handle<Client>>,
    /// Taken by `Drop`, which needs to own the hops to tear them down.
    pub(super) hops: Option<Hops>,
    pub(super) legacy: Vec<LegacyAlgorithms>,
    /// Who this transport logged in as, and where; see `Endpoint`.
    pub(super) endpoint: Endpoint,
}

/// The login a transport is: a session may only be opened on one that went
/// to the same place as the profile asking. The frontend passes a tab's own
/// profile, so this never fires in practice — but a shell on a host other
/// than the one the tab names is the kind of mix-up that is worth an error
/// rather than trust, so the two are compared before a channel is opened.
///
/// The jump host is part of it: the same address behind a different jump
/// host is a different machine on a different network.
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Endpoint {
    pub(super) username: String,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) jump_profile_id: Option<String>,
}

impl Endpoint {
    pub(super) fn of(profile: &SessionProfile) -> Self {
        Self {
            username: profile.username.clone().unwrap_or_default(),
            host: profile.host.clone().unwrap_or_default(),
            port: profile.port.unwrap_or(22),
            jump_profile_id: profile.jump_profile_id.clone().filter(|id| !id.is_empty()),
        }
    }
}

impl SharedTransport {
    pub fn forward_routes(&self) -> &crate::port_forward::ForwardRoutes {
        &self.forwards
    }
    pub async fn direct_tcpip(
        &self,
        host: &str,
        port: u16,
        origin: &str,
        origin_port: u16,
    ) -> Result<russh::ChannelStream<Msg>> {
        let handle = self.handle.clone();
        let host = host.to_owned();
        let origin = origin.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let channel = handle
                .channel_open_direct_tcpip(host, u32::from(port), origin, u32::from(origin_port))
                .await
                .map(|channel| channel.into_stream())
                .map_err(AppError::from);
            // A late channel response after cancellation is still closed:
            // ChannelStream owns the close-on-drop guard, unlike Channel.
            let _ = send.send(channel);
        });
        receive
            .await
            .map_err(|_| AppError::new("SSH tunnel channel request ended"))?
    }
    pub async fn request_forward(&self, host: &str, port: u16) -> Result<RemoteListener> {
        let handle = self.handle.clone();
        let host = host.to_owned();
        let (send, receive) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let result = match handle.tcpip_forward(host.clone(), u32::from(port)).await {
                Ok(allocated) => match if port == 0 {
                    u16::try_from(allocated)
                } else {
                    Ok(port)
                } {
                    Ok(port) if port != 0 => Ok(RemoteListener {
                        handle: Some(handle),
                        host,
                        port,
                    }),
                    _ => Err(AppError::new("server allocated an invalid TCP port")),
                },
                Err(error) => Err(error.into()),
            };
            // If the caller has timed out or closed, the delivered lease is
            // dropped and cancels the server's late port allocation.
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| AppError::connection_failed("remote listener request ended"))?
    }
    pub async fn transfer_channel(&self) -> Result<russh::ChannelStream<Msg>> {
        let mut channel = self.owned_command_channel().await?;
        channel.request_subsystem(true, "sftp").await?;
        let answer = tokio::time::timeout(SFTP_SUBSYSTEM_TIMEOUT, async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => return true,
                    Some(ChannelMsg::Failure | ChannelMsg::Close | ChannelMsg::Eof) | None => {
                        return false
                    }
                    _ => {}
                }
            }
        })
        .await;
        if answer != Ok(true) {
            let _ = channel.close().await;
            return Err(match answer {
                Err(_) => AppError::timeout(format!(
                    "the server did not answer the sftp subsystem request within {} s",
                    SFTP_SUBSYSTEM_TIMEOUT.as_secs()
                )),
                _ => AppError::connection_failed("the server did not accept the sftp subsystem"),
            });
        }
        Ok(channel.into_stream())
    }

    /// A plain session channel of this transport, for a remote command.
    /// No subsystem is requested: the caller owns the request it puts on
    /// the channel and the replies it reads from it (see `remote_cwd`).
    pub async fn command_channel(&self) -> Result<russh::Channel<Msg>> {
        Ok(self.handle.channel_open_session().await?)
    }
    pub async fn owned_command_channel(&self) -> Result<OwnedSessionChannel> {
        let handle = self.handle.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        tauri::async_runtime::spawn(async move {
            let result = handle
                .channel_open_session()
                .await
                .map(|channel| OwnedSessionChannel {
                    channel: Some(channel),
                    terminate: false,
                })
                .map_err(AppError::from);
            let _ = send.send(result);
        });
        receive
            .await
            .map_err(|_| AppError::connection_failed("SSH command channel request ended"))?
    }

    /// The transports that could only connect on legacy algorithms — this
    /// one and the jump hosts it runs over.
    pub fn legacy_algorithms(&self) -> &[LegacyAlgorithms] {
        &self.legacy
    }

    /// Whether a session for `profile` may run on this transport: it has to
    /// be the same login, and the transport has to still be up.
    pub(super) fn carries(&self, profile: &SessionProfile) -> Result<()> {
        if self.endpoint != Endpoint::of(profile) {
            return Err(AppError::invalid_input(
                "that session is connected to a different server",
            ));
        }
        if self.is_closed() {
            return Err(AppError::connection_failed(
                "the connection this session would share has gone down",
            ));
        }
        Ok(())
    }

    /// Whether the transport has gone down, so a session that asked to run
    /// on it is told rather than left with a channel that will never open.
    pub(crate) fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
    #[cfg(test)]
    pub(crate) async fn test_disconnect(&self) {
        self.handle
            .disconnect(
                russh::Disconnect::ByApplication,
                "dedicated fixture disconnect",
                "",
            )
            .await
            .unwrap();
    }
}

pub struct RemoteListener {
    pub(super) handle: Option<Arc<Handle<Client>>>,
    pub(super) host: String,
    pub port: u16,
}

pub struct OwnedSessionChannel {
    pub(super) channel: Option<Channel<Msg>>,
    pub(super) terminate: bool,
}

impl OwnedSessionChannel {
    pub fn terminate_on_drop(&mut self) {
        self.terminate = true;
    }
    pub fn into_stream(mut self) -> russh::ChannelStream<Msg> {
        self.channel.take().unwrap().into_stream()
    }
}

impl std::ops::Deref for OwnedSessionChannel {
    type Target = Channel<Msg>;
    fn deref(&self) -> &Self::Target {
        self.channel.as_ref().unwrap()
    }
}

impl std::ops::DerefMut for OwnedSessionChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.channel.as_mut().unwrap()
    }
}

impl Drop for OwnedSessionChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.channel.take() {
            let terminate = self.terminate;
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(1), async {
                    if terminate {
                        let _ = channel.signal(russh::Sig::TERM).await;
                    }
                    let _ = channel.close().await;
                })
                .await;
            });
        }
    }
}

impl RemoteListener {
    pub async fn close(mut self) -> Result<()> {
        let handle = self.handle.take().unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            handle.cancel_tcpip_forward(self.host.clone(), u32::from(self.port)),
        )
        .await
        .map_err(|_| AppError::new("remote listener cancellation was not acknowledged"))??;
        Ok(())
    }
}

impl Drop for RemoteListener {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let host = self.host.clone();
            let port = self.port;
            tauri::async_runtime::spawn(async move {
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    handle.cancel_tcpip_forward(host, u32::from(port)),
                )
                .await;
            });
        }
    }
}

impl Drop for SharedTransport {
    /// Ends the transport once nothing runs on it any more. Disconnecting is
    /// asynchronous and dropping is not, so the goodbye is sent from a task;
    /// the handle and the hops are moved into it and released there.
    fn drop(&mut self) {
        let handle = self.handle.clone();
        let hops = self.hops.take();
        tauri::async_runtime::spawn(async move {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
            if let Some(hops) = hops {
                hops.disconnect().await;
            }
        });
    }
}

pub struct SshConnection {
    pub(super) transport: Arc<SharedTransport>,
    pub(super) channel: Channel<Msg>,
}

impl SshConnection {
    /// The transports that could only connect on legacy algorithms.
    pub fn legacy_algorithms(&self) -> &[LegacyAlgorithms] {
        self.transport.legacy_algorithms()
    }

    /// The transport this session runs on, for [`SshTransports`] to hand to
    /// the next session opened on it.
    pub fn transport(&self) -> Arc<SharedTransport> {
        self.transport.clone()
    }
}

/// The transports open sessions are running on, keyed by session id, so
/// `open_session` can put a new session on one instead of authenticating
/// again (`reuse_session_id`).
///
/// The entries are weak: a transport stays up only while a session holds it,
/// and an id whose transport has gone is simply one that has to be dialled
/// again. Dead entries are swept whenever one is added.
#[derive(Default)]
pub struct SshTransports {
    pub(super) open: Mutex<std::collections::HashMap<String, std::sync::Weak<SharedTransport>>>,
    pub automatic: crate::session::reuse::ConnectionPool,
}

impl SshTransports {
    /// Records the transport `session_id` runs on. The same transport is
    /// registered once per session using it, so duplicating a duplicate
    /// works and closing the first tab changes nothing for the others.
    pub fn register(&self, session_id: &str, transport: &Arc<SharedTransport>) {
        let mut open = self.open.lock();
        open.retain(|_, weak| weak.strong_count() > 0);
        open.insert(session_id.to_string(), Arc::downgrade(transport));
    }

    pub fn forget(&self, session_id: &str) {
        self.open.lock().remove(session_id);
    }

    /// The transport `session_id` is running on, while it is still up.
    pub fn get(&self, session_id: &str) -> Option<Arc<SharedTransport>> {
        let transport = self.open.lock().get(session_id)?.upgrade()?;
        (!transport.is_closed()).then_some(transport)
    }
}

/// The jump-host transports a session runs over, first hop first (empty for
/// a direct connection). Every later transport is an SSH session inside a
/// `direct-tcpip` channel of the previous one, and dropping a hop's handle
/// ends its russh session and with it everything tunnelled through it, so
/// the hops live exactly as long as the session they carry and are torn
/// down last hop first. Each hop keeps its `host:port` for messages.
pub(super) struct Hops(pub(super) Vec<(Handle<Client>, String)>);

impl Hops {
    pub(super) async fn disconnect(self) {
        for (hop, _) in self.0.into_iter().rev() {
            let _ = hop
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
}

pub enum ConnectOutcome {
    Ready(SshConnection),
    /// The handshake was refused because the host's key changed; nothing was
    /// opened. The user may accept the key and connect again.
    HostKeyChanged(HostKeyChange),
}

/// An authenticated transport together with the jump-host transports it
/// runs over, and every one of them that only connected on legacy algorithms.
pub(super) struct Transport {
    pub(super) forwards: Arc<crate::port_forward::ForwardRoutes>,
    pub(super) handle: Handle<Client>,
    pub(super) hops: Hops,
    pub(super) legacy: Vec<LegacyAlgorithms>,
}

/// An authenticated transport, or the host-key decision that has to be made
/// before one can be established. Shared by the shell and SFTP entry points.
pub(super) enum HandleOutcome {
    Ready(Transport),
    HostKeyChanged(HostKeyChange),
}

/// One hop of a connection: its transport, the legacy algorithms it
/// connected on, if any, what its authentication proved, or the host-key
/// decision that stopped the chain there.
pub(super) enum HopOutcome {
    Ready {
        handle: Handle<Client>,
        legacy: Option<LegacyAlgorithms>,
        forwards: Arc<crate::port_forward::ForwardRoutes>,
        /// Distinguishes "the credentials got in" from "the server needed
        /// none at all", which a public-key check reports as itself.
        auth: AuthOutcome,
    },
    HostKeyChanged(HostKeyChange),
}

/// How one dial authenticates and which host keys it checks: what every
/// session uses, or the key-only shape of a public-key check. `known_hosts`
/// overrides the user's own file (`None` in production); fixture tests point
/// it at a scratch file so they never touch `~/.ssh/known_hosts`.
#[derive(Clone, Copy)]
pub(super) struct Dial<'a> {
    pub(super) flow: AuthFlow,
    pub(super) known_hosts: Option<&'a Path>,
}

impl Dial<'_> {
    /// The dial a session uses: interactive authentication, the user's own
    /// `known_hosts`.
    pub(super) fn session() -> Dial<'static> {
        Dial {
            flow: AuthFlow::Interactive,
            known_hosts: None,
        }
    }
}

/// Opens the transport and authenticates, applying the trust-on-first-use host
/// key policy. It stops short of requesting any channel, so both an interactive
/// shell and a bare SFTP subsystem can be layered on top of the same handshake.
///
/// `jumps` are the jump hosts to go through, first hop first (OpenSSH's
/// `ProxyJump`): each is connected in turn, the next one through a
/// `direct-tcpip` channel of the previous, and the profile's own handshake
/// runs through the last. A refused host key anywhere in the chain stops it
/// there and reports that host, so the user can accept it and try again.
pub(super) async fn connect_handle(
    profile: &SessionProfile,
    jumps: &[SessionProfile],
    prompter: &AuthPrompter<'_>,
    dial: Dial<'_>,
    request: &Request,
) -> Result<HandleOutcome> {
    let mut hops: Vec<(Handle<Client>, String)> = Vec::with_capacity(jumps.len());
    let mut legacy = Vec::new();
    for (index, jump) in jumps.iter().enumerate() {
        let via = index.checked_sub(1).map(|previous| Via {
            handle: &hops[previous].0,
            label: jumps[previous].address(),
        });
        match connect_hop(jump, via.as_ref(), prompter, dial, request).await? {
            HopOutcome::Ready {
                handle,
                legacy: weak,
                ..
            } => {
                hops.push((handle, jump.address()));
                legacy.extend(weak);
            }
            HopOutcome::HostKeyChanged(change) => {
                return Ok(HandleOutcome::HostKeyChanged(change));
            }
        }
    }
    let via = jumps.last().map(|jump| Via {
        handle: &hops.last().expect("one hop per jump host").0,
        label: jump.address(),
    });
    match connect_hop(profile, via.as_ref(), prompter, dial, request).await? {
        HopOutcome::Ready {
            handle,
            legacy: weak,
            forwards,
            ..
        } => {
            legacy.extend(weak);
            Ok(HandleOutcome::Ready(Transport {
                forwards,
                handle,
                hops: Hops(hops),
                legacy,
            }))
        }
        HopOutcome::HostKeyChanged(change) => Ok(HandleOutcome::HostKeyChanged(change)),
    }
}

/// The jump host a hop is opened through: the transport to tunnel over and
/// its `host:port` for error messages.
pub(super) struct Via<'a> {
    pub(super) handle: &'a Handle<Client>,
    pub(super) label: String,
}

/// Opens one SSH transport and authenticates on it — directly, or inside a
/// `direct-tcpip` channel of `via` when the host sits behind a jump host.
/// The host-key policy and the credentials are the profile's own either way:
/// the handshake is end to end and the jump host only ever carries
/// ciphertext, so no key or password has to exist on it.
pub(super) async fn connect_hop(
    profile: &SessionProfile,
    via: Option<&Via<'_>>,
    prompter: &AuthPrompter<'_>,
    dial: Dial<'_>,
    request: &Request,
) -> Result<HopOutcome> {
    let host = profile
        .host
        .clone()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::invalid_input("session is missing a host"))?;
    let port = profile.port.unwrap_or(22);
    let username = profile
        .username
        .clone()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| AppError::invalid_input("session is missing a username"))?;
    let address = format!("{host}:{port}");
    match via {
        None => request.info("connect", format!("dialling {address}")),
        Some(via) => request.info(
            "connect",
            format!("dialling {address} through {}", via.label),
        ),
    }

    let config = Arc::new(client_config());
    let legacy = LegacyRecord::default();
    let forwards = Arc::new(crate::port_forward::ForwardRoutes::default());
    let handler = Client {
        forwards: forwards.clone(),
        host: host.clone(),
        port,
        legacy: legacy.clone(),
        known_hosts: dial.known_hosts.map(Path::to_path_buf),
    };

    let connected = match via {
        None => client::connect(config, (host.as_str(), port), handler).await,
        Some(via) => {
            // What OpenSSH's `-W host:port` asks the jump host for: a plain
            // TCP connection from it to the target, which then carries the
            // target's own SSH handshake.
            let tunnel = via
                .handle
                .channel_open_direct_tcpip(host.as_str(), u32::from(port), "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    AppError::connection_failed(format!(
                        "jump host {} cannot reach {host}:{port}: {e}",
                        via.label
                    ))
                })?;
            client::connect_stream(config, tunnel.into_stream(), handler).await
        }
    };

    let mut handle = match connected {
        Ok(handle) => handle,
        Err(HandshakeError::HostKeyChanged {
            known_hosts,
            line,
            key,
        }) => {
            request.warn(
                "host-key",
                format!("{address} presented a changed host key; waiting for the user's decision"),
            );
            return Ok(HopOutcome::HostKeyChanged(describe_host_key_change(
                &host,
                port,
                &known_hosts,
                line,
                &key,
            )?));
        }
        Err(HandshakeError::Ssh(e)) => {
            let reason = handshake_failure(&e);
            request.warn(
                "connect",
                match via {
                    None => format!("cannot reach {host}:{port}: {reason}"),
                    Some(via) => {
                        format!("cannot reach {host}:{port} through {}: {reason}", via.label)
                    }
                },
            );
            return Err(AppError::coded(
                russh_code(&e),
                match via {
                    None => format!("cannot reach {host}:{port}: {reason}"),
                    Some(via) => format!("cannot reach {host}:{port} via {}: {reason}", via.label),
                },
            ));
        }
    };

    let auth = authenticate(
        &mut handle,
        profile,
        &username,
        &address,
        prompter,
        dial.flow,
        request,
    )
    .await?;
    match auth {
        AuthOutcome::Authenticated => {
            request.info("auth", format!("authenticated {username}@{address}"))
        }
        // Already logged by `authenticate`; nothing the profile holds was
        // needed, but the connection is open either way.
        AuthOutcome::NoneRequired => {}
    }
    let algorithms = legacy.get();
    if !algorithms.is_empty() {
        request.warn(
            "algorithms",
            format!(
                "{address} connected on legacy algorithms: {}",
                algorithms.join(", ")
            ),
        );
    }
    let weak = (!algorithms.is_empty()).then(|| LegacyAlgorithms {
        address: address.clone(),
        algorithms,
    });
    Ok(HopOutcome::Ready {
        handle,
        legacy: weak,
        forwards,
        auth,
    })
}

pub async fn connect(
    profile: &SessionProfile,
    jumps: &[SessionProfile],
    prompter: &AuthPrompter<'_>,
    request: &Request,
) -> Result<ConnectOutcome> {
    let Transport {
        forwards,
        handle,
        hops,
        legacy,
    } = match connect_handle(profile, jumps, prompter, Dial::session(), request).await? {
        HandleOutcome::Ready(transport) => transport,
        HandleOutcome::HostKeyChanged(change) => {
            return Ok(ConnectOutcome::HostKeyChanged(change));
        }
    };
    let transport = Arc::new(SharedTransport {
        forwards,
        handle: Arc::new(handle),
        hops: Some(hops),
        legacy,
        endpoint: Endpoint::of(profile),
    });

    Ok(ConnectOutcome::Ready(open_shell(transport, profile).await?))
}

/// Opens another shell on a transport that is already authenticated: one
/// more channel of the same SSH connection, which is what a duplicated tab
/// runs on. Nothing is negotiated and nothing is asked — the point of it for
/// anyone behind MFA, who would otherwise answer a challenge per tab.
pub async fn connect_on(
    transport: Arc<SharedTransport>,
    profile: &SessionProfile,
) -> Result<SshConnection> {
    transport.carries(profile)?;
    open_shell(transport, profile).await
}

/// Requests one interactive shell — a channel with a PTY on it — of an
/// authenticated transport.
pub(super) async fn open_shell(
    transport: Arc<SharedTransport>,
    profile: &SessionProfile,
) -> Result<SshConnection> {
    let channel = transport.handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await?;
    // Servers may ignore environment requests, but those that accept them let
    // modern CLI applications select their 24-bit color output automatically.
    let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
    let _ = channel.set_env(false, "TERM_PROGRAM", "EdgeTerm").await;
    // The locale the profile asks the server for, so its `ls` prints UTF-8
    // rather than octal escapes (issue #39). Applied by servers configured
    // with `AcceptEnv LANG`; see `locale::ssh_lang` for why only a locale
    // the user named is sent.
    if let Some(lang) = locale::ssh_lang(profile) {
        let _ = channel.set_env(false, "LANG", lang).await;
    }
    channel.request_shell(true).await?;

    Ok(SshConnection { transport, channel })
}

/// Test-only: logs in to a real server with a key file and returns the
/// transport a file session would share. Host keys are recorded in
/// `known_hosts`, a scratch file the caller owns, so a benchmark against a
/// loopback server never writes to the user's own `~/.ssh/known_hosts`.
#[cfg(test)]
pub(crate) async fn test_transport(
    host: &str,
    port: u16,
    user: &str,
    key_path: &str,
    known_hosts: &Path,
) -> Arc<SharedTransport> {
    let forwards = Arc::new(crate::port_forward::ForwardRoutes::default());
    let mut handle = client::connect(
        Arc::new(client_config()),
        (host, port),
        Client {
            forwards: forwards.clone(),
            host: host.to_string(),
            port,
            legacy: LegacyRecord::default(),
            known_hosts: Some(known_hosts.to_path_buf()),
        },
    )
    .await
    .expect("handshake");
    let mut profile = crate::tests::profile(crate::model::SessionKind::Ssh);
    profile.host = Some(host.to_string());
    profile.port = Some(port);
    profile.username = Some(user.to_string());
    profile.auth = Some(AuthKind::PublicKey);
    profile.private_key_path = Some(key_path.to_string());
    let answers = Mutex::new(crate::session::auth::CannedAnswers::default());
    authenticate(
        &mut handle,
        &profile,
        user,
        host,
        &AuthPrompter::canned(&answers),
        AuthFlow::Interactive,
        &Request::begin("fixture"),
    )
    .await
    .expect("key login");
    Arc::new(SharedTransport {
        forwards,
        handle: Arc::new(handle),
        hops: Some(Hops(Vec::new())),
        legacy: Vec::new(),
        endpoint: Endpoint::of(&profile),
    })
}
