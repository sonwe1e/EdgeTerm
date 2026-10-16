use super::*;

/// Host key policy: trust on first use, refuse on change.
///
/// An unknown host is recorded in `~/.ssh/known_hosts` and accepted (OpenSSH's
/// `StrictHostKeyChecking=accept-new`). A host whose key no longer matches the
/// recorded one is refused outright.
pub(super) struct Client {
    pub(super) forwards: Arc<crate::port_forward::ForwardRoutes>,
    pub(super) host: String,
    pub(super) port: u16,
    pub(super) legacy: LegacyRecord,
    /// The file the policy checks against. Every session leaves it unset and
    /// gets the user's own `~/.ssh/known_hosts`; tests point it at a scratch
    /// file so a handshake can be run without touching that one.
    pub(super) known_hosts: Option<PathBuf>,
}

/// Why the handshake failed. Carrying the host key verdict out of the russh
/// handler lets `connect` report a refused key to the user instead of
/// surfacing russh's terse "Unknown server key".
#[derive(Debug)]
pub(super) enum HandshakeError {
    Ssh(russh::Error),
    /// `known_hosts` line `line` records a different key of the same
    /// algorithm for this host, so the connection was refused.
    HostKeyChanged {
        known_hosts: PathBuf,
        line: usize,
        key: PublicKey,
    },
}

impl From<russh::Error> for HandshakeError {
    fn from(e: russh::Error) -> Self {
        HandshakeError::Ssh(e)
    }
}

impl client::Handler for Client {
    type Error = HandshakeError;

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        match self
            .forwards
            .dispatch(connected_address, connected_port, channel)
        {
            Ok(()) => reply.accept().await,
            Err(channel) => {
                drop(reply);
                drop(channel);
            }
        }
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        match self.known_hosts.clone().or_else(known_hosts_file) {
            Some(path) => {
                verify_host_key(&self.host, self.port, server_public_key, &path).map(|()| true)
            }
            // Without a home directory there is nothing to check against or
            // to record into.
            None => Ok(true),
        }
    }

    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &Names,
        _session: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        self.legacy.record(names);
        Ok(())
    }
}

pub(super) fn known_hosts_file() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// Apply the accept-new policy against the entries in `known_hosts`.
pub(super) fn verify_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    known_hosts: &Path,
) -> std::result::Result<(), HandshakeError> {
    match check_known_hosts_path(host, port, key, known_hosts) {
        Ok(true) => Ok(()),
        Err(russh::keys::Error::KeyChanged { line }) => Err(HandshakeError::HostKeyChanged {
            known_hosts: known_hosts.to_path_buf(),
            line: known_hosts_line_number(known_hosts, line),
            key: key.clone(),
        }),
        // An unknown host, or a known_hosts file that is missing or cannot be
        // parsed: learn and continue.
        Ok(false) | Err(_) => {
            let _ = learn_known_hosts_path(host, port, key, known_hosts);
            Ok(())
        }
    }
}

/// russh numbers the line in `KeyChanged` without counting `#` comment lines,
/// so map its index back to the real line number in the file.
pub(super) fn known_hosts_line_number(known_hosts: &Path, russh_line: usize) -> usize {
    let Ok(content) = std::fs::read_to_string(known_hosts) else {
        return russh_line;
    };
    content
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.starts_with('#'))
        .nth(russh_line.saturating_sub(1))
        .map(|(index, _)| index + 1)
        .unwrap_or(russh_line)
}

/// Record `key` as the only key for `host:port`, dropping every entry the
/// file held for it. Accepting a changed key means the user decided the
/// address now belongs to a different server, so its other recorded keys are
/// stale too: this is `ssh-keygen -R` followed by a fresh first contact.
pub(super) fn replace_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    known_hosts: &Path,
) -> Result<()> {
    let stale: HashSet<usize> = known_host_keys_path(host, port, known_hosts)
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", known_hosts.display())))?
        .into_iter()
        .map(|(line, _)| line)
        .collect();
    if !stale.is_empty() {
        let content = std::fs::read_to_string(known_hosts)?;
        // Walk the file the way russh numbers it: comment lines do not count.
        let mut index = 0;
        let mut kept = String::with_capacity(content.len());
        for line in content.split_inclusive('\n') {
            if !line.starts_with('#') {
                index += 1;
                if stale.contains(&index) {
                    continue;
                }
            }
            kept.push_str(line);
        }
        std::fs::write(known_hosts, kept)?;
    }
    learn_known_hosts_path(host, port, key, known_hosts)
        .map_err(|e| AppError::new(format!("cannot update {}: {e}", known_hosts.display())))
}

/// Accept the key a host presented after it was refused as changed:
/// `public_key` is the OpenSSH public key line from the reported
/// `HostKeyChange`, and it replaces the host's `known_hosts` entries.
pub fn accept_host_key(host: &str, port: u16, public_key: &str) -> Result<()> {
    let key = PublicKey::from_openssh(public_key)
        .map_err(|e| AppError::new(format!("invalid host key: {e}")))?;
    let known_hosts = known_hosts_file()
        .ok_or_else(|| AppError::new("cannot locate ~/.ssh/known_hosts: no home directory"))?;
    replace_host_key(host, port, &key, &known_hosts)
}

/// Describe a refused host key for the frontend, which shows it to the user
/// and offers to accept the new key.
pub(super) fn describe_host_key_change(
    host: &str,
    port: u16,
    known_hosts: &Path,
    line: usize,
    key: &PublicKey,
) -> Result<HostKeyChange> {
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let public_key = key
        .to_openssh()
        .map_err(|e| AppError::new(format!("cannot encode host key: {e}")))?;
    Ok(HostKeyChange {
        message: format!(
            "host key for {host}:{port} has changed: the server now presents {fingerprint}, \
             which does not match {} line {line}",
            known_hosts.display()
        ),
        host: host.to_string(),
        port,
        key_type: key.algorithm().to_string(),
        fingerprint,
        public_key,
        known_hosts: known_hosts.display().to_string(),
        line,
    })
}
