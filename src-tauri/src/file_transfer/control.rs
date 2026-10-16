use super::*;

/// A watch channel closes the check/sleep race and wakes blocked async I/O.
/// Registered FTP sockets are interrupted as well, so blocking workers stop.
pub struct Control {
    pub(super) state: watch::Sender<u8>,
    pub(super) sockets: Mutex<HashMap<usize, TcpStream>>,
    pub(super) serial: AtomicUsize,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            state: watch::channel(0).0,
            sockets: Mutex::new(HashMap::new()),
            serial: AtomicUsize::new(0),
        }
    }
}

pub struct SocketGuard<'a> {
    pub(super) control: &'a Control,
    pub(super) id: usize,
}

impl Drop for SocketGuard<'_> {
    fn drop(&mut self) {
        self.control.sockets.lock().remove(&self.id);
    }
}

impl Control {
    pub fn value(&self) -> u8 {
        *self.state.borrow()
    }
    pub fn set(&self, value: u8) {
        self.state.send_replace(value);
        if value != 0 {
            for socket in self.sockets.lock().values() {
                let _ = socket.shutdown(Shutdown::Both);
            }
        }
    }
    pub fn check(&self) -> TransferResult<()> {
        match self.value() {
            1 => Err(Failure::new("paused", "transfer paused", false)),
            2 => Err(Failure::new("cancelled", "transfer cancelled", false)),
            _ => Ok(()),
        }
    }
    pub async fn stopped(&self) {
        let mut rx = self.state.subscribe();
        while *rx.borrow_and_update() == 0 {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
    pub(super) async fn resumed(&self) {
        let mut rx = self.state.subscribe();
        while *rx.borrow_and_update() == 1 {
            if rx.changed().await.is_err() {
                break;
            }
        }
    }
    pub async fn run<T>(
        &self,
        future: impl Future<Output = TransferResult<T>>,
    ) -> TransferResult<T> {
        self.check()?;
        tokio::select! {
            biased;
            _ = self.stopped() => { self.check()?; unreachable!() },
            result = tokio::time::timeout(Duration::from_secs(30), future) =>
                result.unwrap_or_else(|_| Err(Failure::new("timeout", "transfer operation timed out", true))),
        }
    }
    pub fn socket(&self, stream: &TcpStream) -> TransferResult<SocketGuard<'_>> {
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        stream.set_write_timeout(Some(Duration::from_secs(30)))?;
        let clone = stream.try_clone()?;
        let mut sockets = self.sockets.lock();
        self.check()?;
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        sockets.insert(id, clone);
        Ok(SocketGuard { control: self, id })
    }
}
