use super::*;

/// A shared token bucket for one job's whole payload rate limit. Every
/// worker (SFTP request pipeline, FTP data socket, tar packer) draws from
/// the same bucket:
///
/// - Tokens are refilled from the monotonic clock on every lock, so a
///   waiter never reserves future budget. Cancelling a wait costs nothing;
///   waking up re-checks whatever the bucket actually holds.
/// - A slice is charged exactly when it starts moving — the request is
///   issued, the socket read begins, the archive write goes out — and a
///   short DATA or EOF read gives the unused part of its slice back.
/// - The burst is bounded by `capacity` (one second of budget, capped at
///   1 MiB), not by the SFTP request window: a paced job's whole pipeline
///   cannot run ahead of the bucket and then sleep it off.
/// - Under a low rate the slice shrinks to about 100 ms of budget
///   (`slice`), so a 1 KiB/s job moves in ~100-byte steps instead of
///   stalling minutes per chunk; the configured chunk stays the ceiling.
pub(crate) struct Pacer {
    /// Bytes per second.
    pub(super) rate: u64,
    /// Maximum tokens the bucket ever holds: the whole burst allowance.
    pub(super) capacity: u64,
    pub(super) state: Mutex<Bucket>,
}

pub(super) struct Bucket {
    pub(super) tokens: u64,
    pub(super) updated: tokio::time::Instant,
}

impl Pacer {
    pub(crate) fn new(rate_bps: u64) -> Self {
        let rate = rate_bps.max(1);
        let capacity = rate.min(1024 * 1024);
        Self {
            rate,
            capacity,
            state: Mutex::new(Bucket {
                tokens: capacity,
                updated: tokio::time::Instant::now(),
            }),
        }
    }

    /// The slice a paced loop should move at once: the smaller of the
    /// caller's ceiling and ~100 ms of budget (never zero).
    pub(crate) fn slice(&self, ceiling: usize) -> usize {
        ceiling.min((self.rate / 10).max(1) as usize)
    }

    pub(super) fn refill(bucket: &mut Bucket, rate: u64, capacity: u64) {
        let now = tokio::time::Instant::now();
        if bucket.updated < now {
            let elapsed = now - bucket.updated;
            let refill = (elapsed.as_nanos() as u128 * rate as u128 / 1_000_000_000) as u64;
            bucket.tokens = bucket.tokens.saturating_add(refill).min(capacity);
            bucket.updated = now;
        }
    }

    /// Takes `bytes` tokens if the bucket holds them, atomically.
    pub(super) fn try_take(&self, bytes: u64) -> bool {
        let mut bucket = self.state.lock();
        Self::refill(&mut bucket, self.rate, self.capacity);
        if bucket.tokens >= bytes {
            bucket.tokens -= bytes;
            true
        } else {
            false
        }
    }

    /// How long until `bytes` tokens exist, given a fresh refill.
    pub(super) fn deficit(&self, bytes: u64) -> Duration {
        let mut bucket = self.state.lock();
        Self::refill(&mut bucket, self.rate, self.capacity);
        let missing = bytes.saturating_sub(bucket.tokens).max(1);
        Duration::from_nanos((missing as u128 * 1_000_000_000 / self.rate as u128) as u64)
    }

    /// Gives unused slice tokens back: a short DATA or EOF read did not
    /// move the bytes it asked for. Capped at capacity, which can only
    /// make the job slower, never faster than its limit.
    pub(crate) fn refund(&self, bytes: u64) {
        let mut bucket = self.state.lock();
        Self::refill(&mut bucket, self.rate, self.capacity);
        bucket.tokens = bucket.tokens.saturating_add(bytes).min(self.capacity);
    }

    /// The largest charge that can ever succeed at once.
    pub(super) fn burst(&self) -> u64 {
        self.capacity
    }

    /// Takes exactly `bytes` tokens, waiting in burst-sized pieces so even
    /// a caller that names more than the burst allowance simply waits the
    /// full true duration instead of wedging.
    pub(super) async fn take(&self, control: &Control, bytes: u64) -> TransferResult<()> {
        let mut remaining = bytes;
        while remaining > 0 {
            let piece = remaining.min(self.burst()).max(1);
            loop {
                if self.try_take(piece) {
                    break;
                }
                let wait = self.deficit(piece);
                tokio::select! {
                    biased;
                    _ = control.stopped() => { control.check()?; }
                    _ = tokio::time::sleep(wait) => {}
                }
            }
            remaining -= piece;
        }
        Ok(())
    }

    /// The blocking twin of [`Pacer::take`].
    pub(super) fn take_blocking(&self, control: &Control, bytes: u64) -> TransferResult<()> {
        let mut remaining = bytes;
        while remaining > 0 {
            let piece = remaining.min(self.burst()).max(1);
            loop {
                if self.try_take(piece) {
                    break;
                }
                control.check()?;
                std::thread::sleep(self.deficit(piece).min(Duration::from_millis(50)));
            }
            remaining -= piece;
        }
        Ok(())
    }
}

/// Charge `bytes` against the job's budget and wait for the bucket to hold
/// them, re-checking after every wake-up — no future budget is reserved,
/// so an interrupted wait leaves nothing behind. Returns only once the
/// tokens are taken (the caller's slice is about to move) or the job has
/// been paused/cancelled.
pub(crate) async fn paced(pacer: &Pacer, control: &Control, bytes: u64) -> TransferResult<()> {
    pacer.take(control, bytes).await
}

/// The blocking twin of [`paced`], for the FTP workers: the same
/// re-check-after-wake loop, polling the control flag while it sleeps so
/// pause and cancel stay prompt.
pub(crate) fn paced_blocking(pacer: &Pacer, control: &Control, bytes: u64) -> TransferResult<()> {
    pacer.take_blocking(control, bytes)
}
