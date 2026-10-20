//! Tab-owned SSH TCP tunnels and read-only discovery of remote listeners.
use crate::{
    error::{AppError, Result},
    file_transfer::Control,
    session::ssh::SharedTransport,
};
use parking_lot::Mutex;
use russh::{client::Msg, Channel};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Weak,
    },
    task::{Context, Poll},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf},
    net::{TcpListener, TcpStream},
    sync::{mpsc, watch},
    task::JoinSet,
};

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Local,
    Remote,
    /// A SOCKS5 proxy on the local machine: every connection a client makes
    /// through it names its own far end, the way `ssh -D` works.
    Dynamic,
}
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", serde(rename = "PortForwardSpec"))]
pub struct Spec {
    pub direction: Direction,
    pub listen_host: String,
    pub listen_port: u16,
    /// The far end a Local or Remote forward names. A Dynamic forward has
    /// none: each SOCKS5 client brings its own target in the CONNECT
    /// request. `default` alone — no `skip_serializing_if` — keeps this
    /// type out of specta-serde's phase split, whose renamed variants
    /// would land on `Snapshot`'s own exported name; a `None` therefore
    /// crosses the wire as `null` rather than an absent field.
    #[serde(default)]
    pub target_host: Option<String>,
    #[serde(default)]
    pub target_port: Option<u16>,
}
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", serde(rename = "PortForward"))]
pub struct Snapshot {
    pub id: String,
    pub owner: String,
    pub address: String,
    pub spec: Spec,
    pub status: String,
    pub error: Option<String>,
    pub connections: usize,
    pub sent_bytes: u64,
    pub received_bytes: u64,
}
struct Job {
    snapshot: Mutex<Snapshot>,
    control: Control,
    done: watch::Sender<bool>,
    connections: AtomicUsize,
    sent: AtomicU64,
    received: AtomicU64,
    incoming: mpsc::Sender<Channel<Msg>>,
}
impl Job {
    fn snapshot(&self) -> Snapshot {
        let mut row = self.snapshot.lock().clone();
        row.connections = self.connections.load(Ordering::Relaxed);
        row.sent_bytes = self.sent.load(Ordering::Relaxed);
        row.received_bytes = self.received.load(Ordering::Relaxed);
        row
    }
    fn state(&self, status: &str, error: Option<String>) {
        let mut row = self.snapshot.lock();
        row.status = status.into();
        row.error = error;
    }
}
#[derive(Default)]
pub struct ForwardRoutes(Mutex<HashMap<(String, u16), Weak<Job>>>);
impl ForwardRoutes {
    pub fn dispatch(
        &self,
        address: &str,
        port: u32,
        channel: Channel<Msg>,
    ) -> std::result::Result<(), Channel<Msg>> {
        let job = u16::try_from(port).ok().and_then(|port| {
            self.0
                .lock()
                .get(&(address.into(), port))
                .and_then(Weak::upgrade)
        });
        match job {
            Some(job) if job.control.value() == 0 => {
                job.incoming.try_send(channel).map_err(|e| e.into_inner())
            }
            _ => Err(channel),
        }
    }
    fn insert(&self, host: &str, port: u16, job: &Arc<Job>) -> Result<()> {
        let mut routes = self.0.lock();
        let key = (host.into(), port);
        if routes.get(&key).and_then(Weak::upgrade).is_some() {
            return Err(AppError::new(
                "remote listener is already owned by another tunnel",
            ));
        }
        routes.insert(key, Arc::downgrade(job));
        Ok(())
    }
    fn remove(&self, host: &str, port: u16) {
        self.0.lock().remove(&(host.into(), port));
    }
}
#[derive(Default)]
struct Scans {
    active: HashMap<String, (String, Arc<Control>)>,
    early: HashMap<String, Instant>,
}
pub struct ScanRequest {
    id: String,
    scans: Arc<Mutex<Scans>>,
    control: Arc<Control>,
}
impl Drop for ScanRequest {
    fn drop(&mut self) {
        self.control.set(2);
        self.scans.lock().active.remove(&self.id);
    }
}
#[derive(Default)]
pub struct Forwards {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    inspections: Arc<Mutex<Scans>>,
}
fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 253
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b':' | b'%' | b'_'))
}
/// Whether a spec can start: a valid listener host, and — for everything
/// but a Dynamic forward — a valid target host and a port from 1 to 65535.
/// `ssh_config` reuses it so an imported forward is guaranteed startable.
pub(crate) fn validate(spec: &Spec) -> Result<()> {
    // A Dynamic (SOCKS5) forward names no target: each client's CONNECT
    // request brings one, the way `ssh -D` works.
    let target_ok = spec.direction == Direction::Dynamic
        || (spec
            .target_host
            .as_deref()
            .is_some_and(|host| valid_host(host))
            && spec.target_port.is_some_and(|port| port != 0));
    if !valid_host(&spec.listen_host) || !target_ok {
        return Err(AppError::new(
            "enter valid listener and target hosts and a target port from 1 to 65535",
        ));
    }
    Ok(())
}
impl Forwards {
    pub fn start(
        &self,
        owner: &str,
        address: String,
        transport: Arc<SharedTransport>,
        spec: Spec,
    ) -> Result<Snapshot> {
        validate(&spec)?;
        let (sender, incoming) = mpsc::channel(32);
        let job = Arc::new(Job {
            snapshot: Mutex::new(Snapshot {
                id: uuid::Uuid::new_v4().to_string(),
                owner: owner.into(),
                address,
                spec,
                status: "starting".into(),
                error: None,
                connections: 0,
                sent_bytes: 0,
                received_bytes: 0,
            }),
            control: Control::default(),
            done: watch::channel(false).0,
            connections: AtomicUsize::new(0),
            sent: AtomicU64::new(0),
            received: AtomicU64::new(0),
            incoming: sender,
        });
        let row = job.snapshot();
        {
            let mut jobs = self.jobs.lock();
            if jobs.len() >= 256 || jobs.values().filter(|job| !*job.done.borrow()).count() >= 64 {
                return Err(AppError::new(
                    "tunnel limit reached; remove finished tunnels first",
                ));
            }
            jobs.insert(row.id.clone(), job.clone());
        }
        tauri::async_runtime::spawn(async move {
            let result = run(job.clone(), transport, incoming).await;
            job.state(
                if result.is_err() { "error" } else { "stopped" },
                result.err().map(|e| e.to_string()),
            );
            job.done.send_replace(true);
        });
        Ok(row)
    }
    pub fn list(&self) -> Vec<Snapshot> {
        let mut rows: Vec<_> = self
            .jobs
            .lock()
            .values()
            .map(|job| job.snapshot())
            .collect();
        rows.sort_by(|a, b| a.id.cmp(&b.id));
        rows
    }
    pub async fn stop(&self, id: &str) -> Result<()> {
        let job = self
            .jobs
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("tunnel not found"))?;
        if *job.done.borrow() {
            return Ok(());
        }
        job.state("stopping", None);
        job.control.set(2);
        let mut done = job.done.subscribe();
        tokio::time::timeout(Duration::from_secs(10), async {
            while !*done.borrow_and_update() {
                if done.changed().await.is_err() {
                    break;
                }
            }
        })
        .await
        .map_err(|_| {
            AppError::new("server has not acknowledged tunnel cleanup yet; it is still stopping")
        })?;
        Ok(())
    }
    pub fn remove(&self, id: &str) -> Result<()> {
        let mut jobs = self.jobs.lock();
        if jobs.get(id).is_some_and(|job| !*job.done.borrow()) {
            return Err(AppError::new("stop the tunnel before removing it"));
        }
        jobs.remove(id);
        Ok(())
    }
    pub fn close_session(&self, owner: &str) {
        for job in self
            .jobs
            .lock()
            .values()
            .filter(|job| job.snapshot.lock().owner == owner)
        {
            if !*job.done.borrow() {
                job.state("stopping", None);
                job.control.set(2);
            }
        }
        for (session, control) in self.inspections.lock().active.values() {
            if session == owner {
                control.set(2);
            }
        }
    }
    pub fn begin_scan(&self, owner: &str, id: &str) -> Result<ScanRequest> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(AppError::new("invalid port discovery request id"));
        }
        let mut scans = self.inspections.lock();
        if scans.active.len() >= 8 || scans.active.contains_key(id) {
            return Err(AppError::new("too many active port discovery requests"));
        }
        scans
            .early
            .retain(|_, time| time.elapsed() < Duration::from_secs(30));
        let control = Arc::new(Control::default());
        if scans.early.remove(id).is_some() {
            control.set(2);
        }
        scans
            .active
            .insert(id.into(), (owner.into(), control.clone()));
        Ok(ScanRequest {
            id: id.into(),
            scans: self.inspections.clone(),
            control,
        })
    }
    pub fn cancel_scan(&self, id: &str) {
        let mut scans = self.inspections.lock();
        if let Some((_, control)) = scans.active.get(id) {
            control.set(2);
        } else if !id.is_empty() && id.len() <= 100 && scans.early.len() < 128 {
            scans.early.insert(id.into(), Instant::now());
        }
    }
}
async fn run(
    job: Arc<Job>,
    transport: Arc<SharedTransport>,
    mut incoming: mpsc::Receiver<Channel<Msg>>,
) -> Result<()> {
    let mut spec = job.snapshot.lock().spec.clone();
    if job.control.value() != 0 {
        return Ok(());
    }
    let mut remote_listener = None;
    let listener = match spec.direction {
        // A Dynamic forward listens locally like a Local one; only what an
        // accepted connection is bridged to differs.
        Direction::Local | Direction::Dynamic => {
            let listener = tokio::select! {_=job.control.stopped()=>return Ok(()),result=tokio::time::timeout(Duration::from_secs(5),TcpListener::bind((spec.listen_host.as_str(),spec.listen_port)))=>result.map_err(|_|AppError::new("local listener binding timed out"))??};
            spec.listen_port = listener.local_addr()?.port();
            Some(listener)
        }
        Direction::Remote => {
            let lease = tokio::select! {_=job.control.stopped()=>return Ok(()),result=tokio::time::timeout(Duration::from_secs(8),transport.request_forward(&spec.listen_host,spec.listen_port))=>result.map_err(|_|AppError::new("remote listener request timed out"))??};
            spec.listen_port = lease.port;
            if let Err(error) =
                transport
                    .forward_routes()
                    .insert(&spec.listen_host, spec.listen_port, &job)
            {
                let _ = lease.close().await;
                return Err(error);
            }
            remote_listener = Some(lease);
            None
        }
    };
    job.snapshot.lock().spec = spec.clone();
    if job.control.value() == 0 {
        job.state("listening", None);
    }
    let mut flows = JoinSet::new();
    let mut closed = tokio::time::interval(Duration::from_millis(250));
    let mut result = Ok(());
    loop {
        tokio::select! {
            biased;
            _=job.control.stopped()=>break,
            _=closed.tick()=>{if transport.is_closed(){result=Err(AppError::new("SSH connection closed"));break;}},
            Some(_)=flows.join_next(),if !flows.is_empty()=>{},
            accepted=async {listener.as_ref().unwrap().accept().await},if listener.is_some()=>{
                match accepted {Ok((socket,origin))=>{if flows.len()>=32{drop(socket);continue;}let job=job.clone();let transport=transport.clone();let spec=spec.clone();flows.spawn(async move {
                    // A SOCKS5 client names its own far end per connection.
                    if spec.direction == Direction::Dynamic {
                        serve_socks5(job,transport,socket).await;
                        return;
                    }
                    let (target_host,target_port)=match (&spec.target_host,spec.target_port) {(Some(host),Some(port))=>(host.as_str(),port),_=>{job.snapshot.lock().error=Some("forward target is missing".into());return;}};
                    let origin_host=origin.ip().to_string();
                    let channel=tokio::select!{_ =job.control.stopped()=>return, result=tokio::time::timeout(Duration::from_secs(5),transport.direct_tcpip(target_host,target_port,&origin_host,origin.port()))=>result};
                    match channel {Ok(Ok(channel))=>bridge(job,channel,socket).await,Ok(Err(e))=>job.snapshot.lock().error=Some(e.to_string()),Err(_)=>job.snapshot.lock().error=Some("target connection timed out".into())}
                });},Err(error)=>{result=Err(error.into());break;}}
            },
            Some(channel)=incoming.recv(),if listener.is_none()=>{
                let stream=channel.into_stream();
                if flows.len()>=32{drop(stream);continue;}let job=job.clone();let spec=spec.clone();flows.spawn(async move {
                    let (target_host,target_port)=match (&spec.target_host,spec.target_port) {(Some(host),Some(port))=>(host.clone(),port),_=>{job.snapshot.lock().error=Some("forward target is missing".into());return;}};
                    let socket=tokio::select!{_=job.control.stopped()=>return,result=tokio::time::timeout(Duration::from_secs(5),TcpStream::connect((target_host.as_str(),target_port)))=>result};
                    match socket{Ok(Ok(socket))=>bridge(job,stream,socket).await,other=>{job.snapshot.lock().error=Some(format!("cannot connect to local target: {other:?}"));}}
                });
            }
        }
    }
    drop(listener);
    job.control.set(2);
    while let Some(_) = flows.join_next().await {}
    if spec.direction == Direction::Remote {
        transport
            .forward_routes()
            .remove(&spec.listen_host, spec.listen_port);
        if !transport.is_closed() {
            if let Err(error) = remote_listener.take().unwrap().close().await {
                result = Err(error);
            }
        }
    }
    while let Ok(channel) = incoming.try_recv() {
        drop(channel.into_stream());
    }
    result
}
struct CountedStream<S> {
    stream: S,
    job: Arc<Job>,
    outgoing: bool,
}
impl<S: AsyncRead + Unpin> AsyncRead for CountedStream<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_read(cx, buffer)
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for CountedStream<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let result = Pin::new(&mut self.stream).poll_write(cx, bytes);
        if let Poll::Ready(Ok(n)) = &result {
            let counter = if self.outgoing {
                &self.job.sent
            } else {
                &self.job.received
            };
            counter.fetch_add(*n as u64, Ordering::Relaxed);
        }
        result
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stream).poll_shutdown(cx)
    }
}
struct Connection(Arc<Job>);
impl Drop for Connection {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::Relaxed);
    }
}
async fn bridge(job: Arc<Job>, channel: russh::ChannelStream<Msg>, socket: TcpStream) {
    job.connections.fetch_add(1, Ordering::Relaxed);
    let _connection = Connection(job.clone());
    let mut socket = CountedStream {
        stream: socket,
        job: job.clone(),
        outgoing: false,
    };
    let mut channel = CountedStream {
        stream: channel,
        job: job.clone(),
        outgoing: true,
    };
    tokio::select! {_=job.control.stopped()=>{},result=tokio::io::copy_bidirectional(&mut socket,&mut channel)=>{if let Err(error)=result {job.snapshot.lock().error=Some(error.to_string());}}}
    // russh ChannelStream owns ChannelCloseOnDrop; both halves are closed here.
}

/// One SOCKS5 client on a Dynamic forward: the greeting, a CONNECT request
/// naming the far end, then the same byte bridge a Local forward uses.
/// Only CONNECT is served — an SSH channel carries no UDP and no second
/// listener, so BIND and UDP ASSOCIATE are refused with SOCKS5 reply
/// codes, exactly as `ssh -D` refuses them.
async fn serve_socks5(job: Arc<Job>, transport: Arc<SharedTransport>, socket: TcpStream) {
    if let Err(error) = socks5(&job, &transport, socket).await {
        job.snapshot.lock().error = Some(error.to_string());
    }
}

const SOCKS_VERSION: u8 = 5;
/// "no authentication required", the only method `ssh -D` offers.
const SOCKS_NO_AUTH: u8 = 0x00;
const SOCKS_CONNECT: u8 = 0x01;

/// A SOCKS5 reply carrying `code` and a zero bound address: the bound
/// address is informational and clients ignore it.
fn socks_reply(code: u8) -> [u8; 10] {
    [SOCKS_VERSION, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]
}

async fn read_exact<R: AsyncRead + Unpin>(reader: &mut R, buffer: &mut [u8]) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(5), reader.read_exact(buffer))
        .await
        .map_err(|_| AppError::new("SOCKS5 client stopped responding"))?
        // tokio's read_exact reports the filled length on success; the
        // length is the buffer's own, so only the outcome matters here.
        .map(|_| ())
        .map_err(AppError::from)
}

async fn socks5(job: &Arc<Job>, transport: &SharedTransport, mut socket: TcpStream) -> Result<()> {
    let mut greeting = [0u8; 2];
    read_exact(&mut socket, &mut greeting).await?;
    if greeting[0] != SOCKS_VERSION {
        return Err(AppError::new("client is not speaking SOCKS5"));
    }
    let mut methods = vec![0u8; greeting[1] as usize];
    read_exact(&mut socket, &mut methods).await?;
    if greeting[1] == 0 {
        let _ = socket.write_all(&[SOCKS_VERSION, 0xff]).await;
        return Err(AppError::new(
            "SOCKS5 client offered no authentication method",
        ));
    }
    socket.write_all(&[SOCKS_VERSION, SOCKS_NO_AUTH]).await?;
    let mut request = [0u8; 4];
    read_exact(&mut socket, &mut request).await?;
    if request[0] != SOCKS_VERSION {
        return Err(AppError::new("SOCKS5 request version is not 5"));
    }
    let target = match read_target(&mut socket, request[3]).await {
        Ok(target) => target,
        Err(error) => {
            let _ = socket.write_all(&socks_reply(0x08)).await;
            return Err(error);
        }
    };
    if request[1] != SOCKS_CONNECT {
        let _ = socket.write_all(&socks_reply(0x07)).await;
        return Err(AppError::new(
            "SOCKS5 client asked for a command other than CONNECT",
        ));
    }
    let origin = socket.peer_addr()?;
    let channel = match tokio::time::timeout(
        Duration::from_secs(5),
        transport.direct_tcpip(&target.0, target.1, &origin.ip().to_string(), origin.port()),
    )
    .await
    {
        Ok(Ok(channel)) => channel,
        Ok(Err(error)) => {
            let _ = socket.write_all(&socks_reply(0x01)).await;
            return Err(error.into());
        }
        Err(_) => {
            let _ = socket.write_all(&socks_reply(0x01)).await;
            return Err(AppError::new("target connection timed out"));
        }
    };
    socket.write_all(&socks_reply(0x00)).await?;
    bridge(job.clone(), channel, socket).await;
    Ok(())
}

/// The DST.ADDR and DST.PORT of a SOCKS5 request. IPv4 and IPv6 arrive as
/// raw bytes; a domain name arrives length-prefixed. Any other address
/// type is refused with "address type not supported".
async fn read_target<R: AsyncRead + Unpin>(
    reader: &mut R,
    address_type: u8,
) -> Result<(String, u16)> {
    let host = match address_type {
        0x01 => {
            let mut raw = [0u8; 4];
            read_exact(reader, &mut raw).await?;
            std::net::Ipv4Addr::from(raw).to_string()
        }
        0x03 => {
            let mut length = [0u8; 1];
            read_exact(reader, &mut length).await?;
            let mut raw = vec![0u8; length[0] as usize];
            read_exact(reader, &mut raw).await?;
            String::from_utf8(raw)
                .map_err(|_| AppError::new("SOCKS5 domain name is not valid UTF-8"))?
        }
        0x04 => {
            let mut raw = [0u8; 16];
            read_exact(reader, &mut raw).await?;
            std::net::Ipv6Addr::from(raw).to_string()
        }
        _ => return Err(AppError::new("SOCKS5 address type is not supported")),
    };
    let mut raw = [0u8; 2];
    read_exact(reader, &mut raw).await?;
    let port = u16::from_be_bytes(raw);
    if port == 0 {
        return Err(AppError::new("SOCKS5 target port is 0"));
    }
    Ok((host, port))
}

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub host: String,
    pub port: u16,
    pub process: Option<String>,
}
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "bindings", serde(rename = "PortDiscovery"))]
pub struct Discovery {
    pub status: &'static str,
    pub ports: Vec<ListeningPort>,
    pub truncated: bool,
}
const SCAN:&str="if [ \"$(uname -s 2>/dev/null)\" != Linux ]; then printf '!unsupported\\n'; elif command -v ss >/dev/null 2>&1; then printf '!ss\\n'; LC_ALL=C ss -H -ltnp; elif command -v netstat >/dev/null 2>&1; then printf '!netstat\\n'; LC_ALL=C netstat -ltnp; else printf '!unsupported\\n'; fi";
fn endpoint(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if port == 0 {
        return None;
    }
    Some((host.trim_matches(['[', ']']).into(), port))
}
fn parse_scan(text: &str) -> Discovery {
    if text.starts_with("!unsupported") {
        return Discovery {
            status: "unsupported",
            ports: vec![],
            truncated: false,
        };
    }
    let ss = text.starts_with("!ss");
    let mut ports = Vec::new();
    let mut truncated = false;
    for line in text.lines().skip(1) {
        let fields: Vec<_> = line.split_whitespace().collect();
        let index = if ss { 3 } else { 3 };
        if fields.len() <= index
            || (!ss && fields.first().is_none_or(|value| !value.starts_with("tcp")))
        {
            continue;
        }
        if let Some((host, port)) = endpoint(fields[index]) {
            if ports.len() >= 2048 {
                truncated = true;
                break;
            }
            let process = if ss {
                fields
                    .get(5..)
                    .filter(|v| !v.is_empty())
                    .map(|v| v.join(" "))
            } else {
                fields.get(6).filter(|v| **v != "-").map(|v| v.to_string())
            };
            ports.push(ListeningPort {
                host,
                port,
                process,
            });
        }
    }
    ports.sort_by(|a, b| (a.port, &a.host).cmp(&(b.port, &b.host)));
    ports.dedup_by(|a, b| a.host == b.host && a.port == b.port);
    Discovery {
        status: "ok",
        ports,
        truncated,
    }
}
pub async fn discover(request: ScanRequest, transport: Arc<SharedTransport>) -> Result<Discovery> {
    let text = crate::session::exec::run(
        transport,
        SCAN,
        &request.control,
        256 * 1024,
        Duration::from_secs(6),
    )
    .await?;
    Ok(parse_scan(&text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    async fn settled(manager: &Forwards, id: &str) -> Snapshot {
        tokio::time::timeout(Duration::from_secs(8), async {
            loop {
                let row = manager.list().into_iter().find(|row| row.id == id).unwrap();
                if row.status != "starting" && row.status != "stopping" {
                    return row;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("tunnel must settle")
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_network_disconnect_closes_listeners_and_drops_remote_allocation() {
        let var = |key: &str| std::env::var(key).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let port = port.parse().unwrap();
        let root =
            std::env::temp_dir().join(format!("edgeterm-forward-cut-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        let cut = Arc::new(Control::default());
        let proxy = tokio::spawn({
            let cut = cut.clone();
            let host = host.to_string();
            async move {
                let (mut client, _) = listener.accept().await.unwrap();
                let mut server = TcpStream::connect((host.as_str(), port)).await.unwrap();
                tokio::select! {_=cut.stopped()=>{},_=tokio::io::copy_bidirectional(&mut client,&mut server)=>{}}
            }
        });
        let transport = crate::session::ssh::test_transport(
            "127.0.0.1",
            proxy_port,
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts_proxy"),
        )
        .await;
        let manager = Forwards::default();
        let spec = Spec {
            direction: Direction::Remote,
            listen_host: "127.0.0.1".into(),
            listen_port: 0,
            target_host: Some("127.0.0.1".into()),
            target_port: Some(port),
        };
        let remote = manager
            .start(
                "remote-owner",
                address.clone(),
                transport.clone(),
                spec.clone(),
            )
            .unwrap();
        let remote = settled(&manager, &remote.id).await;
        assert_eq!(remote.status, "listening");
        let local = manager
            .start(
                "local-owner",
                address.clone(),
                transport.clone(),
                Spec {
                    direction: Direction::Local,
                    ..spec
                },
            )
            .unwrap();
        let local = settled(&manager, &local.id).await;
        assert_eq!(local.status, "listening");
        let mut socket = TcpStream::connect(("127.0.0.1", local.spec.listen_port))
            .await
            .unwrap();
        let mut banner = [0; 4];
        tokio::time::timeout(Duration::from_secs(3), socket.read_exact(&mut banner))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&banner, b"SSH-");
        cut.set(2);
        proxy.await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if manager.list().iter().all(|row| row.status == "error") {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("both tunnel workers must observe the real transport disconnect");
        assert_eq!(settled(&manager, &local.id).await.status, "error");
        assert_eq!(settled(&manager, &remote.id).await.status, "error");
        assert!(TcpStream::connect(("127.0.0.1", local.spec.listen_port))
            .await
            .is_err());
        let probe = crate::session::ssh::test_transport(
            host,
            port,
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts_probe"),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if probe
                    .direct_tcpip("127.0.0.1", remote.spec.listen_port, "127.0.0.1", 0)
                    .await
                    .is_err()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("sshd must release the disconnected transport's remote listener");
        assert_eq!(
            crate::session::exec::run(
                probe.clone(),
                "printf alive",
                &Control::default(),
                1024,
                Duration::from_secs(2)
            )
            .await
            .unwrap(),
            "alive"
        );
        drop(probe);
        drop(transport);
        std::fs::remove_dir_all(root).unwrap();
        println!("real SSH network cut: local listener closed, remote allocation released, dedicated sshd still healthy");
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_bidirectional_tunnels_discovery_stop_and_sibling_isolation() {
        let var = |key: &str| std::env::var(key).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let root = std::env::temp_dir().join(format!("edgeterm-forward-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let transport = crate::session::ssh::test_transport(
            host,
            port.parse().unwrap(),
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts"),
        )
        .await;
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {accepted=echo.accept()=>{let(mut socket,_)=accepted.unwrap();children.spawn(async move{let mut bytes=[0u8;8192];loop{let n=socket.read(&mut bytes).await.unwrap_or(0);if n==0{break;}if socket.write_all(&bytes[..n]).await.is_err(){break;}}});},Some(_)=children.join_next(),if !children.is_empty()=>{}}
            }
        });
        let manager = Forwards::default();
        let remote = manager
            .start(
                "remote-owner",
                address.clone(),
                transport.clone(),
                Spec {
                    direction: Direction::Remote,
                    listen_host: "127.0.0.1".into(),
                    listen_port: 0,
                    target_host: Some("127.0.0.1".into()),
                    target_port: Some(echo_port),
                },
            )
            .unwrap();
        let remote = settled(&manager, &remote.id).await;
        assert_eq!(remote.status, "listening", "{:?}", remote.error);
        assert_ne!(remote.spec.listen_port, 0);
        let scan = discover(
            manager.begin_scan("remote-owner", "scan").unwrap(),
            transport.clone(),
        )
        .await
        .unwrap();
        assert_eq!(scan.status, "ok");
        assert!(
            scan.ports.iter().any(|p| p.port == remote.spec.listen_port),
            "real ss must discover the remote tunnel listener"
        );
        let local = manager
            .start(
                "local-owner",
                address.clone(),
                transport.clone(),
                Spec {
                    direction: Direction::Local,
                    listen_host: "127.0.0.1".into(),
                    listen_port: 0,
                    target_host: Some("127.0.0.1".into()),
                    target_port: Some(remote.spec.listen_port),
                },
            )
            .unwrap();
        let local = settled(&manager, &local.id).await;
        assert_eq!(local.status, "listening", "{:?}", local.error);
        let mut socket = TcpStream::connect(("127.0.0.1", local.spec.listen_port))
            .await
            .unwrap();
        let payload: Vec<_> = (0..32768).map(|i| (i % 251) as u8).collect();
        socket.write_all(&payload).await.unwrap();
        let mut returned = vec![0; payload.len()];
        tokio::time::timeout(Duration::from_secs(5), socket.read_exact(&mut returned))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(returned, payload);
        let rows = manager.list();
        for id in [&local.id, &remote.id] {
            let row = rows.iter().find(|r| &r.id == id).unwrap();
            assert_eq!(row.sent_bytes, payload.len() as u64);
            assert_eq!(row.received_bytes, payload.len() as u64);
            assert_eq!(row.connections, 1);
        }
        let conflict = manager
            .start(
                "conflict",
                address.clone(),
                transport.clone(),
                Spec {
                    listen_port: local.spec.listen_port,
                    ..local.spec.clone()
                },
            )
            .unwrap();
        let conflict = settled(&manager, &conflict.id).await;
        assert_eq!(conflict.status, "error");
        assert!(conflict.error.is_some());
        let denied = manager
            .start(
                "denied",
                address.clone(),
                transport.clone(),
                Spec {
                    direction: Direction::Remote,
                    listen_host: "127.0.0.1".into(),
                    listen_port: port.parse().unwrap(),
                    target_host: Some("127.0.0.1".into()),
                    target_port: Some(echo_port),
                },
            )
            .unwrap();
        let denied = settled(&manager, &denied.id).await;
        assert_eq!(denied.status, "error");
        assert!(denied.error.is_some());
        assert!(manager.remove(&local.id).is_err());
        manager.close_session("local-owner");
        let stopped = settled(&manager, &local.id).await;
        assert_eq!(stopped.status, "stopped");
        assert!(TcpStream::connect(("127.0.0.1", local.spec.listen_port))
            .await
            .is_err());
        let mut byte = [0];
        let ended = tokio::time::timeout(Duration::from_secs(2), socket.read(&mut byte))
            .await
            .unwrap();
        assert!(ended.is_err() || ended.unwrap() == 0);
        assert_eq!(settled(&manager, &remote.id).await.status, "listening");
        let channel = transport
            .direct_tcpip("127.0.0.1", remote.spec.listen_port, "127.0.0.1", 0)
            .await
            .unwrap();
        let mut stream = channel;
        stream.write_all(b"sibling alive").await.unwrap();
        let mut bytes = [0; 13];
        tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&bytes, b"sibling alive");
        drop(stream);
        manager.stop(&remote.id).await.unwrap();
        assert_eq!(settled(&manager, &remote.id).await.status, "stopped");
        assert!(transport
            .direct_tcpip("127.0.0.1", remote.spec.listen_port, "127.0.0.1", 0)
            .await
            .is_err());
        let alive = crate::session::exec::run(
            transport.clone(),
            "printf alive",
            &Control::default(),
            1024,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(alive, "alive");
        manager.remove(&local.id).unwrap();
        manager.remove(&remote.id).unwrap();
        manager.remove(&conflict.id).unwrap();
        manager.remove(&denied.id).unwrap();
        assert!(manager.list().is_empty());
        println!("real L/R TCP roundtrip: {} bytes each way; discovered remote port {}; owner stop and sibling exec passed",payload.len(),remote.spec.listen_port);
        echo_task.abort();
        let _ = echo_task.await;
        drop(transport);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_dynamic_forward_serves_a_socks5_client_and_refuses_udp() {
        let var = |key: &str| std::env::var(key).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let root =
            std::env::temp_dir().join(format!("edgeterm-forward-dyn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let transport = crate::session::ssh::test_transport(
            host,
            port.parse().unwrap(),
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts"),
        )
        .await;
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {accepted=echo.accept()=>{let(mut socket,_)=accepted.unwrap();children.spawn(async move{let mut bytes=[0u8;8192];loop{let n=socket.read(&mut bytes).await.unwrap_or(0);if n==0{break;}if socket.write_all(&bytes[..n]).await.is_err(){break;}}});},Some(_)=children.join_next(),if !children.is_empty()=>{}}
            }
        });
        let manager = Forwards::default();
        let socks = manager
            .start(
                "dyn-owner",
                address.clone(),
                transport.clone(),
                Spec {
                    direction: Direction::Dynamic,
                    listen_host: "127.0.0.1".into(),
                    listen_port: 0,
                    target_host: None,
                    target_port: None,
                },
            )
            .unwrap();
        let socks = settled(&manager, &socks.id).await;
        assert_eq!(socks.status, "listening", "{:?}", socks.error);
        let mut client = TcpStream::connect(("127.0.0.1", socks.spec.listen_port))
            .await
            .unwrap();
        // Greeting: one method, no authentication.
        client.write_all(&[5, 1, 0]).await.unwrap();
        let mut method = [0u8; 2];
        tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut method))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(method, [5, 0]);
        // CONNECT to the loopback echo server through the tunnel.
        let mut request = vec![5, 1, 0, 1, 127, 0, 0, 1];
        request.extend_from_slice(&echo_port.to_be_bytes());
        client.write_all(&request).await.unwrap();
        let mut reply = [0u8; 10];
        tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut reply))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(reply[1], 0, "SOCKS5 CONNECT must succeed: {reply:?}");
        let payload: Vec<_> = (0..16384).map(|i| (i % 251) as u8).collect();
        client.write_all(&payload).await.unwrap();
        let mut returned = vec![0; payload.len()];
        tokio::time::timeout(Duration::from_secs(5), client.read_exact(&mut returned))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(returned, payload);
        // UDP ASSOCIATE is refused with "command not supported", as ssh -D does.
        client
            .write_all(&[5, 3, 0, 1, 0, 0, 0, 0, 0, 0])
            .await
            .unwrap();
        let mut refused = [0u8; 10];
        tokio::time::timeout(Duration::from_secs(3), client.read_exact(&mut refused))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(refused[1], 0x07);
        drop(client);
        let row = settled(&manager, &socks.id).await;
        assert_eq!(row.sent_bytes, payload.len() as u64);
        assert_eq!(row.received_bytes, payload.len() as u64);
        manager.stop(&socks.id).await.unwrap();
        assert_eq!(settled(&manager, &socks.id).await.status, "stopped");
        assert!(TcpStream::connect(("127.0.0.1", socks.spec.listen_port))
            .await
            .is_err());
        manager.remove(&socks.id).unwrap();
        echo_task.abort();
        let _ = echo_task.await;
        drop(transport);
        std::fs::remove_dir_all(root).unwrap();
        println!("real SOCKS5 dynamic forward: {} bytes each way through a CONNECT; UDP ASSOCIATE refused", payload.len());
    }
    #[test]
    fn listener_parser_handles_ipv4_ipv6_missing_process_and_headers() {
        let result=parse_scan("!ss\nLISTEN 0 128 127.0.0.1:8080 0.0.0.0:* users:((\"test\",pid=3,fd=4))\nLISTEN 0 128 [::]:22 [::]:*\nLISTEN 0 128 :::80 :::*\nbad\n");
        assert_eq!(result.ports.len(), 3);
        assert_eq!(result.ports[0].host, "::");
        assert_eq!(result.ports[0].port, 22);
        assert!(result.ports[0].process.is_none());
        assert_eq!(result.ports[2].port, 8080);
        assert!(result.ports[2].process.as_ref().unwrap().contains("pid=3"));
        let old=parse_scan("!netstat\nActive Internet connections\nProto Recv-Q Send-Q Local Address Foreign Address State PID/Program name\ntcp 0 0 0.0.0.0:3000 0.0.0.0:* LISTEN -\n");
        assert_eq!(old.ports.len(), 1);
        assert_eq!(old.ports[0].port, 3000);
        assert_eq!(parse_scan("!unsupported\n").status, "unsupported");
    }
    #[test]
    fn hosts_and_zero_target_are_validated() {
        let mut spec = Spec {
            direction: Direction::Local,
            listen_host: "127.0.0.1".into(),
            listen_port: 0,
            target_host: Some("::1".into()),
            target_port: Some(80),
        };
        assert!(validate(&spec).is_ok());
        spec.target_host = Some("a;id".into());
        assert!(validate(&spec).is_err());
        spec.target_host = Some("localhost".into());
        spec.target_port = Some(0);
        assert!(validate(&spec).is_err());
        // A Dynamic forward names no target at all.
        let mut dynamic = Spec {
            direction: Direction::Dynamic,
            listen_host: "127.0.0.1".into(),
            listen_port: 1080,
            target_host: None,
            target_port: None,
        };
        assert!(validate(&dynamic).is_ok());
        dynamic.listen_host = "a;id".into();
        assert!(validate(&dynamic).is_err());
    }
    #[tokio::test]
    async fn socks5_reads_ipv4_ipv6_and_domain_targets() {
        // The address type is read by the caller and passed in, so these
        // streams hold only DST.ADDR and DST.PORT.
        let mut ipv4: &[u8] = &[10, 0, 0, 7, 0x00, 0x50];
        assert_eq!(
            read_target(&mut ipv4, 0x01).await.unwrap(),
            ("10.0.0.7".to_string(), 80)
        );
        let mut domain: &[u8] = &[
            10, b'e', b'x', b'a', b'm', b'p', b'l', b'e', b'.', b'd', b'e', 0x01, 0xbb,
        ];
        assert_eq!(
            read_target(&mut domain, 0x03).await.unwrap(),
            ("example.de".to_string(), 443)
        );
        let mut ipv6: &[u8] = &[
            0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0x1f, 0x90,
        ];
        assert_eq!(
            read_target(&mut ipv6, 0x04).await.unwrap(),
            ("2001:db8::1".to_string(), 8080)
        );
        let mut unsupported: &[u8] = &[1, 2, 3, 4, 0, 80];
        assert!(read_target(&mut unsupported, 0x02).await.is_err());
        let mut zero: &[u8] = &[1, 2, 3, 4, 0, 0];
        assert!(read_target(&mut zero, 0x01).await.is_err());
    }
    #[test]
    fn socks5_reply_carries_the_code_and_a_zero_bound_address() {
        assert_eq!(socks_reply(0x00), [5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        assert_eq!(socks_reply(0x05), [5, 5, 0, 1, 0, 0, 0, 0, 0, 0]);
    }
    // The route key is the exact requested listen host, so a server that
    // reports the listener under any other string would silently drop every
    // forwarded connection. OpenSSH echoes the requested address back in the
    // forwarded-tcpip open even when GatewayPorts rewrites the bind, which
    // this locks in for the address families the UI permits beyond the plain
    // 127.0.0.1 covered above.
    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH fixture"]
    async fn real_remote_forward_routes_wildcard_and_ipv6_loopback_listeners() {
        let var = |key: &str| std::env::var(key).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let root =
            std::env::temp_dir().join(format!("edgeterm-forward-af-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let transport = crate::session::ssh::test_transport(
            host,
            port.parse().unwrap(),
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts"),
        )
        .await;
        let echo = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let echo_port = echo.local_addr().unwrap().port();
        let echo_task = tokio::spawn(async move {
            let mut children = JoinSet::new();
            loop {
                tokio::select! {accepted=echo.accept()=>{let(mut socket,_)=accepted.unwrap();children.spawn(async move{let mut bytes=[0u8;8192];loop{let n=socket.read(&mut bytes).await.unwrap_or(0);if n==0{break;}if socket.write_all(&bytes[..n]).await.is_err(){break;}}});},Some(_)=children.join_next(),if !children.is_empty()=>{}}
            }
        });
        let manager = Forwards::default();
        for requested in ["0.0.0.0", "::1"] {
            let row = manager
                .start(
                    "af-owner",
                    address.clone(),
                    transport.clone(),
                    Spec {
                        direction: Direction::Remote,
                        listen_host: requested.into(),
                        listen_port: 0,
                        target_host: Some("127.0.0.1".into()),
                        target_port: Some(echo_port),
                    },
                )
                .unwrap();
            let row = settled(&manager, &row.id).await;
            assert_eq!(row.status, "listening", "{requested}: {:?}", row.error);
            // GatewayPorts=no rewrites the wildcard to a loopback bind, so the
            // server-side probe connects over IPv4 loopback for 0.0.0.0 and
            // IPv6 loopback for ::1.
            let connect_host = if requested == "::1" {
                "::1"
            } else {
                "127.0.0.1"
            };
            let mut direct = transport
                .direct_tcpip(connect_host, row.spec.listen_port, "127.0.0.1", 0)
                .await
                .unwrap_or_else(|error| panic!("{requested}: direct connect failed: {error}"));
            let payload: Vec<u8> = (0..256u32).map(|i| (i % 251) as u8).collect();
            direct.write_all(&payload).await.unwrap();
            let mut returned = vec![0; payload.len()];
            tokio::time::timeout(Duration::from_secs(5), direct.read_exact(&mut returned))
                .await
                .unwrap_or_else(|_| panic!("{requested}: echo never returned"))
                .unwrap();
            assert_eq!(returned, payload, "{requested}: relayed bytes must match");
            manager.stop(&row.id).await.unwrap();
            assert_eq!(settled(&manager, &row.id).await.status, "stopped");
            manager.remove(&row.id).unwrap();
        }
        echo_task.abort();
        let _ = echo_task.await;
        drop(transport);
        std::fs::remove_dir_all(root).unwrap();
        println!("real R forwards on 0.0.0.0 and ::1 relayed 256/256 bytes through the reported listener address");
    }
}
