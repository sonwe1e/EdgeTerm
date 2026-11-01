//! A read-only preview of one remote HTML report in the system browser.
//!
//! A report and the resources it references relatively live on an SSH server,
//! so the Filer cannot hand the file to the browser directly. A preview owns a
//! loopback HTTP server instead: the browser loads
//! `http://127.0.0.1:<port>/<token>/<file>`, and every request is answered by
//! reading the file over the session's own SFTP channel at the moment the
//! browser asks for it — no copy is placed on disk.
//!
//! The boundaries are deliberate:
//!
//! - The report's own directory is the whole readable tree. A request is
//!   resolved through SFTP `realpath` and refused unless the result is still
//!   inside that directory, so a symbolic link cannot lead out of it.
//! - Only `GET` and `HEAD` are served. The 128-bit token is the only
//!   credential, and the `Host` header must name this loopback listener, so
//!   a page the browser already has open cannot reach the server through DNS
//!   rebinding.
//! - Nothing is cached (`Cache-Control: no-store`): a `data.json` a training
//!   run rewrites must be visible on the next refresh.
//! - A file is streamed in 64 KiB reads, never read whole into memory; one
//!   byte range is supported so a large asset can be seeked, and `HEAD`
//!   answers without a body.
//! - The preview ends with its session: closing the session, or the SSH
//!   transport going down, stops the server and releases the port.
//!
//! Absolute references such as `/assets/loss.png` are deliberately outside
//! this first version: they name the server's root, not the report's
//! directory, and are refused rather than guessed at.

use std::collections::HashMap;
use std::convert::Infallible;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::body::{Body as HttpBody, Bytes, Frame, Incoming};
use hyper::header::{self, HeaderName, HeaderValue};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use parking_lot::Mutex;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{FileAttributes, OpenFlags};
use serde::Serialize;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch, Semaphore};
use tokio::task::JoinSet;

#[cfg(test)]
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::error::{AppError, Result};
use crate::session::ssh::SharedTransport;

/// The largest file a preview serves. Above it the report is not a report.
const MAX_FILE: u64 = 512 * 1024 * 1024;
/// One SFTP read, and therefore one chunk in flight, per response.
const CHUNK: usize = 64 * 1024;
/// How many chunks may wait for the browser before reading pauses.
const STREAM_CHUNKS: usize = 2;
/// Concurrent responses; a browser opens six connections per origin.
const MAX_IN_FLIGHT: usize = 8;
/// Open sockets per preview, mostly idle keep-alive connections.
const MAX_CONNECTIONS: usize = 16;
/// Live previews across the application.
const MAX_PREVIEWS: usize = 16;
/// Waiting this long for a stopped server to release its listener is a bug.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// How often the server checks that its session is still there.
const ALIVE_TICK: Duration = Duration::from_millis(500);

/// One live preview, as the front end sees it.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSession {
    pub id: String,
    /// The address to open in the system browser: it names the report file.
    pub url: String,
    /// The remote directory a preview may read from, and the only one.
    pub root: String,
    pub port: u16,
}

/// Every preview this process serves, keyed by preview id.
#[derive(Default)]
pub struct Previews {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
}

impl Previews {
    /// Starts a preview of the HTML report at `path`. The report's directory
    /// becomes the only readable tree; the URL names the report itself.
    pub async fn start(
        &self,
        owner: &str,
        transport: Arc<SharedTransport>,
        path: &str,
    ) -> Result<PreviewSession> {
        let path = validate_start_path(path)?;
        let sftp = sftp_for(transport.clone()).await?;
        let source = Arc::new(Source::Sftp(Arc::new(sftp)));
        let report = source
            .realpath(path)
            .await
            .map_err(|_| AppError::invalid_input(format!("{path}: the report cannot be found")))?;
        let meta = source
            .stat(&report)
            .await
            .map_err(|_| AppError::invalid_input(format!("{path}: the report cannot be read")))?;
        if meta.is_dir {
            return Err(AppError::invalid_input(
                "select an HTML report, not a directory",
            ));
        }
        let name = report
            .rsplit_once('/')
            .map_or(report.as_str(), |(_, name)| name);
        if !is_html_file(name) {
            return Err(AppError::invalid_input(
                "only HTML reports can be previewed",
            ));
        }
        let directory = match report.rsplit_once('/') {
            Some((directory, _)) if !directory.is_empty() => directory.to_string(),
            _ => "/".to_string(),
        };
        let resolved = source.realpath(&directory).await;
        let root = resolved.unwrap_or(directory);
        if !within_root(&report, &root) {
            return Err(AppError::invalid_input(
                "the report is outside the directory that would be previewed",
            ));
        }
        let alive: Alive = {
            let transport = Arc::downgrade(&transport);
            Box::new(move || {
                transport
                    .upgrade()
                    .is_some_and(|transport| !transport.is_closed())
            })
        };
        self.bind(owner, source, root, name.to_string(), alive)
            .await
    }

    /// Every preview that is still serving, oldest id first.
    pub fn list(&self) -> Vec<PreviewSession> {
        let mut jobs = self.jobs.lock();
        jobs.retain(|_, job| !job.is_done());
        let mut rows: Vec<_> = jobs.values().map(|job| job.snapshot()).collect();
        rows.sort_by(|left, right| left.id.cmp(&right.id));
        rows
    }

    /// Stops one preview and waits until its listener is gone.
    pub async fn stop(&self, id: &str) -> Result<()> {
        let job = self
            .jobs
            .lock()
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::new("preview not found"))?;
        if !job.is_done() {
            job.stop.send_replace(true);
            let mut done = job.done.subscribe();
            tokio::time::timeout(STOP_TIMEOUT, async {
                while !*done.borrow_and_update() {
                    if done.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .map_err(|_| AppError::new("the preview server has not stopped yet"))?;
        }
        self.jobs.lock().remove(id);
        Ok(())
    }

    /// Stops every preview a closed session owned. The session's transport is
    /// torn down as well, so a preview left behind would only fail requests.
    pub fn close_session(&self, owner: &str) {
        let mut jobs = self.jobs.lock();
        let ids: Vec<String> = jobs
            .iter()
            .filter(|(_, job)| job.owner == owner)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(job) = jobs.remove(&id) {
                job.stop.send_replace(true);
            }
        }
    }

    /// Binds the loopback listener, registers the preview and starts serving.
    async fn bind(
        &self,
        owner: &str,
        source: Arc<Source>,
        root: String,
        entry: String,
        alive: Alive,
    ) -> Result<PreviewSession> {
        {
            let mut jobs = self.jobs.lock();
            jobs.retain(|_, job| !job.is_done());
            // Right-clicking the same report twice reopens the running preview
            // instead of leaking a second listener.
            if let Some(existing) = jobs
                .values()
                .find(|job| job.owner == owner && job.root == root && job.entry == entry)
            {
                return Ok(existing.snapshot());
            }
            if jobs.len() >= MAX_PREVIEWS {
                return Err(AppError::new(
                    "too many previews are open; close one before starting another",
                ));
            }
        }
        let listener =
            tokio::time::timeout(Duration::from_secs(5), TcpListener::bind(("127.0.0.1", 0)))
                .await
                .map_err(|_| AppError::new("binding the preview listener timed out"))??;
        let port = listener.local_addr()?.port();
        let token = random_token()?;
        let url = format!(
            "http://127.0.0.1:{port}/{token}/{}",
            percent_encode_component(&entry)
        );
        let job = Arc::new(Job {
            id: uuid::Uuid::new_v4().to_string(),
            token,
            owner: owner.to_string(),
            root,
            entry,
            port,
            url: url.clone(),
            source,
            alive,
            slots: Arc::new(Semaphore::new(MAX_IN_FLIGHT)),
            stop: watch::channel(false).0,
            done: watch::channel(false).0,
        });
        {
            let mut jobs = self.jobs.lock();
            jobs.insert(job.id.clone(), job.clone());
        }
        let snapshot = job.snapshot();
        tokio::spawn(async move {
            run(job.clone(), listener).await;
            job.done.send_replace(true);
        });
        Ok(snapshot)
    }
}

/// A local path from a POSIX-shaped one, for the test source. Windows accepts
/// `/` in ordinary paths but not after the `\\?\` prefix `canonicalize` returns,
/// so the two spellings are converted rather than mixed.
#[cfg(test)]
fn local_path(path: &str) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        std::path::PathBuf::from(path.replace('/', "\\"))
    }
    #[cfg(unix)]
    {
        std::path::PathBuf::from(path)
    }
}

/// The POSIX spelling of a canonical local path, so the request path and the
/// root compare as one string on every platform.
#[cfg(test)]
pub(crate) fn remote_path(path: &std::path::Path) -> String {
    #[cfg(windows)]
    {
        path.to_string_lossy().replace('\\', "/")
    }
    #[cfg(unix)]
    {
        path.to_string_lossy().into_owned()
    }
}

#[cfg(test)]
impl Previews {
    /// A preview of a directory on this machine: the same registry, request
    /// validation, planning and streaming as an SSH preview, without a session.
    /// Used by `preview_tests` to exercise the HTTP contract on loopback.
    pub(crate) async fn start_local(
        &self,
        owner: &str,
        directory: &std::path::Path,
        entry: &str,
    ) -> Result<PreviewSession> {
        let candidate = directory.to_path_buf();
        let resolved = tokio::task::spawn_blocking(move || std::fs::canonicalize(candidate))
            .await
            .map_err(AppError::new)?
            .map_err(|_| AppError::new("the preview directory is unavailable"))?;
        let root = remote_path(&resolved);
        self.bind(
            owner,
            Arc::new(Source::Local),
            root,
            entry.to_string(),
            Box::new(|| true),
        )
        .await
    }
}

/// What keeps a preview honest about its owner being gone.
type Alive = Box<dyn Fn() -> bool + Send + Sync>;

struct Job {
    id: String,
    token: String,
    owner: String,
    /// The canonical remote directory the preview may read.
    root: String,
    /// The report's file name inside `root`, part of the URL.
    entry: String,
    port: u16,
    url: String,
    source: Arc<Source>,
    alive: Alive,
    slots: Arc<Semaphore>,
    stop: watch::Sender<bool>,
    done: watch::Sender<bool>,
}

impl Job {
    fn snapshot(&self) -> PreviewSession {
        PreviewSession {
            id: self.id.clone(),
            url: self.url.clone(),
            root: self.root.clone(),
            port: self.port,
        }
    }

    fn is_done(&self) -> bool {
        *self.done.borrow()
    }

    /// Resolves once the preview was asked to stop.
    async fn wait_stopped(&self) {
        let mut stop = self.stop.subscribe();
        while !*stop.borrow_and_update() {
            if stop.changed().await.is_err() {
                break;
            }
        }
    }
}

/// Serves one preview until it is stopped or its session is gone. Dropping the
/// listener here is what releases the port.
async fn run(job: Arc<Job>, listener: TcpListener) {
    let mut connections = JoinSet::new();
    let mut tick = tokio::time::interval(ALIVE_TICK);
    loop {
        tokio::select! {
            biased;
            _ = job.wait_stopped() => break,
            _ = tick.tick() => {
                if !(job.alive)() {
                    break;
                }
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        if connections.len() >= MAX_CONNECTIONS {
                            continue;
                        }
                        connections.spawn(serve_connection(job.clone(), stream));
                    }
                    // Accepting from a bound loopback listener does not fail
                    // while it is open; a failure here means it was closed.
                    Err(_) => break,
                }
            }
        }
    }
    drop(listener);
    connections.abort_all();
    while connections.join_next().await.is_some() {}
}

async fn serve_connection(job: Arc<Job>, stream: TcpStream) {
    let io = TokioIo::new(stream);
    let service = service_fn(move |request: Request<Incoming>| {
        let job = job.clone();
        async move { Ok::<_, Infallible>(serve_request(job, request).await) }
    });
    // A half-open socket must not hold a connection slot forever. Hyper only
    // enforces that deadline with a timer registered on the builder; without
    // one it panics at the first request instead of answering it.
    let connection = http1::Builder::new()
        .keep_alive(true)
        .header_read_timeout(Duration::from_secs(10))
        .timer(TokioTimer::new())
        .serve_connection(io, service);
    let _ = connection.await;
}

/// Answers one request: the method, the `Host` header, the token, the path and
/// then the file decide, in that order. Every refusal is a status code with a
/// short generic message; no remote path is echoed back.
async fn serve_request(job: Arc<Job>, request: Request<Incoming>) -> Response<ResponseBody> {
    let head = request.method() == Method::HEAD;
    if request.method() != Method::GET && !head {
        let mut response = plain(StatusCode::METHOD_NOT_ALLOWED, "method not allowed");
        response
            .headers_mut()
            .insert(header::ALLOW, HeaderValue::from_static("GET, HEAD"));
        return response;
    }
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    if !host_allowed(host, job.port) {
        return plain(StatusCode::FORBIDDEN, "forbidden");
    }
    let Some(rest) = strip_token(request.uri().path(), &job.token) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    let Some(segments) = decode_relative_path(rest) else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    let permit = match job.slots.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => return plain(StatusCode::SERVICE_UNAVAILABLE, "busy"),
    };
    let requested = join_remote(&job.root, &segments);
    let Ok(canonical) = job.source.realpath(&requested).await else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    // `realpath` follows symbolic links, so this is the only check that can
    // tell a resource beside the report from one linked to from outside it.
    if !within_root(&canonical, &job.root) {
        return plain(StatusCode::FORBIDDEN, "forbidden");
    }
    let Ok(meta) = job.source.stat(&canonical).await else {
        return plain(StatusCode::NOT_FOUND, "not found");
    };
    if meta.is_dir {
        return plain(StatusCode::NOT_FOUND, "not found");
    }
    if meta.size > MAX_FILE {
        return plain(
            StatusCode::PAYLOAD_TOO_LARGE,
            "the file is too large to preview",
        );
    }
    let name = canonical
        .rsplit_once('/')
        .map_or(canonical.as_str(), |(_, name)| name);
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let plan = plan(name, meta.size, range);
    let mut response = if head {
        drop(permit);
        Response::new(ResponseBody::empty())
    } else {
        match plan.body {
            Some((start, end)) => match job.source.open(&canonical).await {
                Ok(handle) => {
                    let (sender, receiver) = mpsc::channel(STREAM_CHUNKS);
                    let source = job.source.clone();
                    tokio::spawn(async move {
                        // The slot is held for as long as the response body
                        // is, not just until the headers are written.
                        let _permit = permit;
                        stream_file(source, handle, start, end, sender).await;
                    });
                    Response::new(ResponseBody::stream(receiver))
                }
                Err(_) => return plain(StatusCode::NOT_FOUND, "not found"),
            },
            None => {
                drop(permit);
                Response::new(ResponseBody::empty())
            }
        }
    };
    *response.status_mut() = plan.status;
    apply_headers(response.headers_mut(), &plan);
    response
}

fn apply_headers(headers: &mut HeaderMap, plan: &ResponsePlan) {
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(plan.content_type),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from(plan.content_length()),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    if let Some(value) = plan.content_range.as_deref() {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(header::CONTENT_RANGE, value);
        }
    }
}

fn plain(status: StatusCode, message: &'static str) -> Response<ResponseBody> {
    let mut response = Response::new(ResponseBody::text(message));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from(message.len() as u64),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

// --- response bodies -------------------------------------------------------

enum Payload {
    Empty,
    Once(Option<Bytes>),
    Stream(mpsc::Receiver<Vec<u8>>),
}

/// The body of every response: a fixed message, nothing, or the chunks a
/// reader task produces from one remote file.
struct ResponseBody(Payload);

impl ResponseBody {
    fn empty() -> Self {
        Self(Payload::Empty)
    }

    fn text(message: &'static str) -> Self {
        Self(Payload::Once(Some(Bytes::from_static(message.as_bytes()))))
    }

    fn stream(receiver: mpsc::Receiver<Vec<u8>>) -> Self {
        Self(Payload::Stream(receiver))
    }
}

impl HttpBody for ResponseBody {
    type Data = Bytes;
    type Error = std::io::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<Option<std::result::Result<Frame<Bytes>, std::io::Error>>> {
        match &mut self.get_mut().0 {
            Payload::Empty => Poll::Ready(None),
            Payload::Once(bytes) => Poll::Ready(bytes.take().map(|bytes| Ok(Frame::data(bytes)))),
            Payload::Stream(receiver) => match Pin::new(receiver).poll_recv(context) {
                Poll::Ready(Some(chunk)) if !chunk.is_empty() => {
                    Poll::Ready(Some(Ok(Frame::data(Bytes::from(chunk)))))
                }
                Poll::Ready(Some(_)) | Poll::Ready(None) => Poll::Ready(None),
                Poll::Pending => Poll::Pending,
            },
        }
    }
}

/// Reads `[start, end]` of one file in 64 KiB chunks. The receiver closing —
/// the browser going away, or the preview stopping — ends the read, which is
/// what closes the remote file handle early.
async fn stream_file(
    source: Arc<Source>,
    handle: FileHandle,
    start: u64,
    end: u64,
    sender: mpsc::Sender<Vec<u8>>,
) {
    let mut handle = handle;
    let mut offset = start;
    while offset <= end {
        let length = (end - offset + 1).min(CHUNK as u64) as usize;
        match source.read_chunk(&mut handle, offset, length).await {
            Ok(mut bytes) if !bytes.is_empty() => {
                // A server that answers with more than asked for must not
                // overrun the promised `Content-Length`.
                let wanted = (end - offset + 1) as usize;
                if bytes.len() > wanted {
                    bytes.truncate(wanted);
                }
                offset += bytes.len() as u64;
                if sender.send(bytes).await.is_err() {
                    break;
                }
            }
            _ => break,
        }
    }
    source.close(handle).await;
}

// --- remote and local files ------------------------------------------------

/// One SFTP subsystem channel of the session this preview belongs to.
struct Sftp {
    raw: RawSftpSession,
}

impl Sftp {
    async fn open(transport: Arc<SharedTransport>) -> Result<Self> {
        let stream = transport.transfer_channel().await?;
        let raw = RawSftpSession::new(stream);
        raw.set_timeout(20);
        raw.init()
            .await
            .map_err(|error| AppError::connection_failed(error.to_string()))?;
        Ok(Self { raw })
    }
}

impl Drop for Sftp {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}

async fn sftp_for(transport: Arc<SharedTransport>) -> Result<Sftp> {
    tokio::time::timeout(Duration::from_secs(20), Sftp::open(transport))
        .await
        .map_err(|_| AppError::timeout("opening the SFTP channel timed out"))?
}

/// Where a preview reads its files: the session's SFTP channel, or — in tests
/// only — the filesystem this process can see, so the HTTP contract is
/// exercised on loopback without a server.
enum Source {
    Sftp(Arc<Sftp>),
    #[cfg(test)]
    Local,
}

struct FileMeta {
    size: u64,
    is_dir: bool,
}

enum FileHandle {
    Sftp(String),
    #[cfg(test)]
    Local(tokio::fs::File),
}

impl Source {
    /// The canonical path, with every symbolic link on it resolved.
    async fn realpath(&self, path: &str) -> Result<String> {
        match self {
            Self::Sftp(sftp) => {
                let response = sftp
                    .raw
                    .realpath(path)
                    .await
                    .map_err(|error| AppError::new(format!("{path}: {error}")))?;
                response
                    .files
                    .into_iter()
                    .next()
                    .map(|file| file.filename)
                    .ok_or_else(|| AppError::new(format!("{path}: the server resolved no path")))
            }
            #[cfg(test)]
            Self::Local => {
                let candidate = local_path(path);
                let joined =
                    tokio::task::spawn_blocking(move || std::fs::canonicalize(candidate)).await;
                match joined {
                    Ok(Ok(resolved)) => Ok(remote_path(&resolved)),
                    Ok(Err(error)) => Err(AppError::new(format!("{path}: {error}"))),
                    Err(error) => Err(AppError::new(format!("{path}: {error}"))),
                }
            }
        }
    }

    async fn stat(&self, path: &str) -> Result<FileMeta> {
        match self {
            Self::Sftp(sftp) => {
                let attrs = sftp
                    .raw
                    .stat(path)
                    .await
                    .map_err(|error| AppError::new(format!("{path}: {error}")))?
                    .attrs;
                Ok(FileMeta {
                    size: attrs.size.unwrap_or(0),
                    is_dir: attrs.is_dir(),
                })
            }
            #[cfg(test)]
            Self::Local => {
                let candidate = local_path(path);
                let joined =
                    tokio::task::spawn_blocking(move || std::fs::metadata(candidate)).await;
                match joined {
                    Ok(Ok(metadata)) => Ok(FileMeta {
                        size: metadata.len(),
                        is_dir: metadata.is_dir(),
                    }),
                    Ok(Err(error)) => Err(AppError::new(format!("{path}: {error}"))),
                    Err(error) => Err(AppError::new(format!("{path}: {error}"))),
                }
            }
        }
    }

    async fn open(&self, path: &str) -> Result<FileHandle> {
        match self {
            Self::Sftp(sftp) => {
                let handle = sftp
                    .raw
                    .open(path, OpenFlags::READ, FileAttributes::empty())
                    .await
                    .map_err(|error| AppError::new(format!("{path}: {error}")))?
                    .handle;
                Ok(FileHandle::Sftp(handle))
            }
            #[cfg(test)]
            Self::Local => Ok(FileHandle::Local(
                tokio::fs::File::open(local_path(path))
                    .await
                    .map_err(|error| AppError::new(format!("{path}: {error}")))?,
            )),
        }
    }

    async fn read_chunk(
        &self,
        handle: &mut FileHandle,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>> {
        match (self, handle) {
            (Self::Sftp(sftp), FileHandle::Sftp(name)) => {
                let data = sftp
                    .raw
                    .read(name.clone(), offset, length as u32)
                    .await
                    .map_err(|error| AppError::new(error.to_string()))?;
                Ok(data.data)
            }
            #[cfg(test)]
            (Self::Local, FileHandle::Local(file)) => {
                file.seek(std::io::SeekFrom::Start(offset))
                    .await
                    .map_err(|error| AppError::new(format!("seek: {error}")))?;
                let mut buffer = vec![0u8; length];
                let read = file
                    .read(&mut buffer)
                    .await
                    .map_err(|error| AppError::new(format!("read: {error}")))?;
                buffer.truncate(read);
                Ok(buffer)
            }
            // The source and the handle always belong to the same preview.
            #[allow(unreachable_patterns)]
            _ => Err(AppError::new(
                "the preview source changed under an open file",
            )),
        }
    }

    async fn close(&self, handle: FileHandle) {
        match (self, handle) {
            (Self::Sftp(sftp), FileHandle::Sftp(name)) => {
                let _ = sftp.raw.close(name).await;
            }
            #[cfg(test)]
            (_, FileHandle::Local(file)) => drop(file),
            // The source and the handle always belong to the same preview.
            #[allow(unreachable_patterns)]
            _ => {}
        }
    }
}

// --- request validation and response planning (pure) -----------------------

/// What one response is: a status, the headers' values and the byte range a
/// body would cover. `None` in `body` means no body at all.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct ResponsePlan {
    pub(crate) status: StatusCode,
    pub(crate) content_type: &'static str,
    /// The inclusive byte range the body covers.
    pub(crate) body: Option<(u64, u64)>,
    pub(crate) content_range: Option<String>,
}

impl ResponsePlan {
    pub(crate) fn content_length(&self) -> u64 {
        self.body.map_or(0, |(start, end)| end - start + 1)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RangeOutcome {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

pub(crate) fn plan(name: &str, size: u64, range: Option<&str>) -> ResponsePlan {
    let content_type = mime_for(name);
    match parse_range(range, size) {
        RangeOutcome::Partial { start, end } => ResponsePlan {
            status: StatusCode::PARTIAL_CONTENT,
            content_type,
            body: Some((start, end)),
            content_range: Some(format!("bytes {start}-{end}/{size}")),
        },
        RangeOutcome::Unsatisfiable => ResponsePlan {
            status: StatusCode::RANGE_NOT_SATISFIABLE,
            content_type: "text/plain; charset=utf-8",
            body: None,
            content_range: Some(format!("bytes */{size}")),
        },
        RangeOutcome::Full => ResponsePlan {
            status: StatusCode::OK,
            content_type,
            body: size.checked_sub(1).map(|last| (0, last)),
            content_range: None,
        },
    }
}

/// One `bytes=` range. A header this server does not implement — several
/// ranges, another unit, a malformed range — is ignored, which RFC 9110 allows.
fn parse_range(header: Option<&str>, size: u64) -> RangeOutcome {
    let Some(value) = header else {
        return RangeOutcome::Full;
    };
    let Some((unit, spec)) = value.trim().split_once('=') else {
        return RangeOutcome::Full;
    };
    if !unit.trim().eq_ignore_ascii_case("bytes") {
        return RangeOutcome::Full;
    }
    let spec = spec.trim();
    if spec.contains(',') {
        return RangeOutcome::Full;
    }
    let Some((first, last)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    let (first, last) = (first.trim(), last.trim());
    if size == 0 {
        return RangeOutcome::Unsatisfiable;
    }
    if first.is_empty() {
        // A suffix range: the final `last` bytes.
        let Ok(suffix) = last.parse::<u64>() else {
            return RangeOutcome::Full;
        };
        if suffix == 0 {
            return RangeOutcome::Unsatisfiable;
        }
        if suffix >= size {
            return RangeOutcome::Partial {
                start: 0,
                end: size - 1,
            };
        }
        return RangeOutcome::Partial {
            start: size - suffix,
            end: size - 1,
        };
    }
    let Ok(start) = first.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if start >= size {
        return RangeOutcome::Unsatisfiable;
    }
    if last.is_empty() {
        return RangeOutcome::Partial {
            start,
            end: size - 1,
        };
    }
    let Ok(end) = last.parse::<u64>() else {
        return RangeOutcome::Full;
    };
    if end < start {
        return RangeOutcome::Full;
    }
    RangeOutcome::Partial {
        start,
        end: end.min(size - 1),
    }
}

pub(crate) fn mime_for(name: &str) -> &'static str {
    let extension = name
        .rsplit_once('.')
        .map_or_else(String::new, |(_, extension)| extension.to_ascii_lowercase());
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// The `Host` header a browser sends for this preview's own URL, and only
/// that: DNS rebinding turns a foreign host name into 127.0.0.1, but the
/// header keeps the attacker's name.
pub(crate) fn host_allowed(header: Option<&str>, port: u16) -> bool {
    let Some(value) = header else {
        return false;
    };
    value == format!("127.0.0.1:{port}") || value == format!("localhost:{port}")
}

/// The part of the path after `/<token>/`, or `None` when the request does
/// not carry this preview's token.
pub(crate) fn strip_token<'a>(path: &'a str, token: &str) -> Option<&'a str> {
    let rest = path.strip_prefix('/')?;
    let (candidate, rest) = rest.split_once('/')?;
    token_matches(token, candidate).then_some(rest)
}

fn token_matches(expected: &str, candidate: &str) -> bool {
    // Compared without stopping at the first difference: the token is the only
    // credential a request needs, so a reply must not tell a guesser how many
    // leading characters were right.
    let (expected, candidate) = (expected.as_bytes(), candidate.as_bytes());
    expected.len() == candidate.len()
        && expected
            .iter()
            .zip(candidate)
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

/// Percent-decodes one request path and splits it into segments, rejecting
/// anything that could name a path the token does not protect: a NUL, a
/// control byte, a backslash (a separator on some server platforms), a `..`
/// segment, or an empty path. Decoding happens first, so `%2e%2e` is caught
/// by the same rule as `..`.
pub(crate) fn decode_relative_path(raw: &str) -> Option<Vec<String>> {
    let decoded = percent_decode(raw)?;
    if decoded.is_empty() || decoded.len() > 4096 {
        return None;
    }
    if decoded
        .bytes()
        .any(|byte| byte == 0 || byte == b'\\' || byte < 0x20 || byte == 0x7f)
    {
        return None;
    }
    let mut segments = Vec::new();
    for part in decoded.split('/') {
        match part {
            "" | "." => continue,
            ".." => return None,
            part => segments.push(part.to_string()),
        }
    }
    (!segments.is_empty() && segments.len() <= 64).then_some(segments)
}

fn percent_decode(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = hex_digit(*bytes.get(index + 1)?)?;
            let low = hex_digit(*bytes.get(index + 2)?)?;
            decoded.push(high * 16 + low);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Percent-encodes one path segment for the URL handed to the browser; every
/// byte outside the unreserved set is escaped, so a file name with spaces or
/// non-ASCII characters opens as itself.
pub(crate) fn percent_encode_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// Whether a resolved path is inside `root`. Both are canonical, so a path
/// that starts with the root's name but names a sibling (`/r2` against
/// `/r`) is not inside it.
pub(crate) fn within_root(path: &str, root: &str) -> bool {
    if path.split('/').any(|part| part == "..") {
        return false;
    }
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        return path.starts_with('/');
    }
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

pub(crate) fn join_remote(root: &str, segments: &[String]) -> String {
    let root = root.trim_end_matches('/');
    if root.is_empty() {
        format!("/{}", segments.join("/"))
    } else {
        format!("{root}/{}", segments.join("/"))
    }
}

pub(crate) fn is_html_file(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, extension)| extension)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("html") || extension.eq_ignore_ascii_case("htm")
        })
}

pub(crate) fn validate_start_path(path: &str) -> Result<&str> {
    let path = path.trim();
    if path.is_empty() {
        return Err(AppError::invalid_input("the report path is empty"));
    }
    if path.len() > 4096 {
        return Err(AppError::invalid_input("the report path is too long"));
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(AppError::invalid_input(
            "the report path contains an unsupported character",
        ));
    }
    Ok(path)
}

/// A 128-bit random token in hex: the only thing a request needs to know to
/// reach this preview, so it is guessed rather than enumerated.
fn random_token() -> Result<String> {
    use ring::rand::{SecureRandom, SystemRandom};
    use std::fmt::Write as _;
    let mut bytes = [0u8; 16];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| AppError::new("the system random source is unavailable"))?;
    let mut token = String::with_capacity(32);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}
