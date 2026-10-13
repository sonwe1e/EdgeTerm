//! Credit-based output flow control shared by all terminal transports.
//!
//! Credits cover bytes sent over IPC but not yet consumed by the frontend.
//! They are byte limits, not rate limits: fast consumers immediately recycle
//! them. ACKs use a per-connection token and a cumulative byte offset, so a
//! delayed/duplicate ACK cannot release another connection's credits.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::{Condvar, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::Notify;

pub const OUTPUT_CHUNK: usize = 64 * 1024;
const SESSION_WINDOW: usize = 512 * 1024;
const GLOBAL_WINDOW: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct Stream {
    session: String,
    sent: u64,
    consumed: u64,
    finished: bool,
}

#[derive(Default)]
struct Ledger {
    streams: HashMap<String, Stream>,
    outstanding: usize,
}

#[derive(Default)]
struct Shared {
    ledger: Mutex<Ledger>,
    changed: Notify,
    blocking_changed: Condvar,
}

impl Shared {
    fn wake(&self) {
        self.changed.notify_waiters();
        self.blocking_changed.notify_all();
    }
}

#[derive(Clone, Default)]
pub struct OutputStreams(Arc<Shared>);

impl OutputStreams {
    pub fn open(
        &self,
        session: &str,
        token: String,
        channel: Channel<InvokeResponseBody>,
    ) -> crate::error::Result<OutputChannel> {
        let mut ledger = self.0.ledger.lock();
        if token.is_empty() || ledger.streams.contains_key(&token) {
            return Err(crate::error::AppError::new(
                "invalid or reused output token",
            ));
        }
        ledger.streams.insert(
            token.clone(),
            Stream {
                session: session.to_owned(),
                ..Stream::default()
            },
        );
        Ok(OutputChannel {
            streams: self.clone(),
            token,
            channel,
        })
    }

    /// Called directly by IPC, never through the session command queue.
    pub fn acknowledge(&self, token: &str, consumed: u64) {
        let mut ledger = self.0.ledger.lock();
        let Some(stream) = ledger.streams.get_mut(token) else {
            return;
        };
        // Reject impossible offsets rather than granting unsent credit.
        if consumed <= stream.consumed || consumed > stream.sent {
            return;
        }
        let released = (consumed - stream.consumed) as usize;
        stream.consumed = consumed;
        let remove = stream.finished && stream.consumed == stream.sent;
        ledger.outstanding -= released;
        if remove {
            ledger.streams.remove(token);
        }
        drop(ledger);
        self.0.wake();
    }

    /// Cancellation also wakes readers parked on credits. The source's
    /// control thread/task can then close the transport without an ACK.
    pub fn close_session(&self, session: &str) {
        let mut ledger = self.0.ledger.lock();
        let mut released = 0;
        ledger.streams.retain(|_, stream| {
            if stream.session != session {
                return true;
            }
            released += (stream.sent - stream.consumed) as usize;
            false
        });
        ledger.outstanding -= released;
        drop(ledger);
        self.0.wake();
    }
}

pub struct OutputChannel {
    streams: OutputStreams,
    token: String,
    channel: Channel<InvokeResponseBody>,
}

impl OutputChannel {
    fn available(ledger: &Ledger, token: &str) -> Option<usize> {
        let stream = ledger.streams.get(token)?;
        Some(
            (SESSION_WINDOW - (stream.sent - stream.consumed) as usize)
                .min(GLOBAL_WINDOW - ledger.outstanding),
        )
    }

    pub fn is_closed(&self) -> bool {
        !self
            .streams
            .0
            .ledger
            .lock()
            .streams
            .contains_key(&self.token)
    }

    /// Sends at most a bounded chunk; leaves the unsent suffix with the pump.
    /// Reservation precedes IPC so even an immediate ACK is safe.
    pub fn send(&self, bytes: &mut Vec<u8>) -> usize {
        let mut ledger = self.streams.0.ledger.lock();
        let count = Self::available(&ledger, &self.token)
            .unwrap_or(0)
            .min(bytes.len())
            .min(OUTPUT_CHUNK);
        if count == 0 {
            return 0;
        }
        ledger.streams.get_mut(&self.token).unwrap().sent += count as u64;
        ledger.outstanding += count;
        drop(ledger);
        let payload = if count == bytes.len() {
            std::mem::take(bytes)
        } else {
            let tail = bytes.split_off(count);
            std::mem::replace(bytes, tail)
        };
        if self.channel.send(InvokeResponseBody::Raw(payload)).is_err() {
            self.cancel();
            return 0;
        }
        count
    }

    fn cancel(&self) {
        let mut ledger = self.streams.0.ledger.lock();
        if let Some(stream) = ledger.streams.remove(&self.token) {
            ledger.outstanding -= (stream.sent - stream.consumed) as usize;
        }
        drop(ledger);
        self.streams.0.wake();
    }

    pub async fn writable(&self) {
        loop {
            // Construct before checking to avoid a lost notify_waiters race.
            let changed = self.streams.0.changed.notified();
            if Self::available(&self.streams.0.ledger.lock(), &self.token) != Some(0) {
                return;
            }
            changed.await;
        }
    }

    pub fn wait_writable(&self) {
        let mut ledger = self.streams.0.ledger.lock();
        while Self::available(&ledger, &self.token) == Some(0) {
            self.streams.0.blocking_changed.wait(&mut ledger);
        }
    }
}

impl Drop for OutputChannel {
    fn drop(&mut self) {
        // A natural EOF must not free bytes that xterm still has queued.
        // The final ACK removes the finished stream; explicit close can
        // instead retire it immediately, including a disposed terminal.
        let mut ledger = self.streams.0.ledger.lock();
        if let Some(stream) = ledger.streams.get_mut(&self.token) {
            stream.finished = true;
            if stream.sent == stream.consumed {
                ledger.streams.remove(&self.token);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    fn stream(streams: &OutputStreams, id: &str) -> (OutputChannel, Arc<AtomicUsize>) {
        let received = Arc::new(AtomicUsize::new(0));
        let count = received.clone();
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                count.fetch_add(bytes.len(), Ordering::SeqCst);
            }
            Ok(())
        });
        (streams.open(id, id.to_owned(), channel).unwrap(), received)
    }

    #[test]
    fn slow_consumer_is_bounded_and_duplicate_or_invalid_acks_grant_nothing() {
        let streams = OutputStreams::default();
        let (output, received) = stream(&streams, "one");
        let bytes = vec![1; OUTPUT_CHUNK];
        for _ in 0..100 {
            output.send(&mut bytes.clone());
        }
        assert_eq!(received.load(Ordering::SeqCst), SESSION_WINDOW);
        streams.acknowledge("one", SESSION_WINDOW as u64 + 1);
        assert_eq!(output.send(&mut bytes.clone()), 0);
        streams.acknowledge("one", OUTPUT_CHUNK as u64);
        assert_eq!(output.send(&mut bytes.clone()), OUTPUT_CHUNK);
        streams.acknowledge("one", OUTPUT_CHUNK as u64);
        streams.acknowledge("one", 1);
        assert_eq!(output.send(&mut bytes.clone()), 0);
    }

    #[test]
    fn fast_consumer_keeps_streaming_without_a_rate_timer() {
        let streams = OutputStreams::default();
        let (output, received) = stream(&streams, "fast");
        let bytes = vec![1; OUTPUT_CHUNK];
        for i in 1..=200 {
            assert_eq!(output.send(&mut bytes.clone()), OUTPUT_CHUNK);
            streams.acknowledge("fast", (i * OUTPUT_CHUNK) as u64);
        }
        assert_eq!(received.load(Ordering::SeqCst), 200 * OUTPUT_CHUNK);
        assert_eq!(streams.0.ledger.lock().outstanding, 0);
    }

    #[tokio::test]
    async fn global_budget_and_cancellation_wake_a_waiter() {
        let streams = OutputStreams::default();
        let outputs: Vec<_> = (0..9).map(|i| stream(&streams, &i.to_string()).0).collect();
        let bytes = vec![1; OUTPUT_CHUNK];
        for output in &outputs {
            for _ in 0..SESSION_WINDOW / OUTPUT_CHUNK {
                output.send(&mut bytes.clone());
            }
        }
        assert_eq!(streams.0.ledger.lock().outstanding, GLOBAL_WINDOW);
        assert!(
            tokio::time::timeout(Duration::from_millis(10), outputs[8].writable())
                .await
                .is_err()
        );
        streams.close_session("0");
        tokio::time::timeout(Duration::from_secs(1), outputs[8].writable())
            .await
            .unwrap();
        assert_eq!(outputs[8].send(&mut bytes.clone()), OUTPUT_CHUNK);
    }

    #[test]
    fn eof_retains_credit_until_ack_and_reconnect_isolated_from_old_ack() {
        let streams = OutputStreams::default();
        let (old, _) = stream(&streams, "tab");
        old.send(&mut vec![1, 2, 3]);
        drop(old);
        assert_eq!(streams.0.ledger.lock().outstanding, 3);
        streams.acknowledge("tab", 3);
        assert!(streams.0.ledger.lock().streams.is_empty());
        let next = streams
            .open("tab", "next".into(), Channel::new(|_| Ok(())))
            .unwrap();
        next.send(&mut vec![4, 5]);
        streams.acknowledge("tab", 100);
        assert_eq!(streams.0.ledger.lock().outstanding, 2);
        streams.close_session("tab");
        assert!(next.is_closed());
        assert_eq!(streams.0.ledger.lock().outstanding, 0);
    }

    #[test]
    fn close_releases_a_blocking_reader_without_frontend_ack() {
        let streams = OutputStreams::default();
        let (output, _) = stream(&streams, "blocked");
        for _ in 0..SESSION_WINDOW / OUTPUT_CHUNK {
            output.send(&mut vec![0; OUTPUT_CHUNK]);
        }
        let (done, completion) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            output.wait_writable();
            done.send(output.is_closed()).unwrap();
        });
        assert!(completion.recv_timeout(Duration::from_millis(10)).is_err());
        streams.close_session("blocked");
        assert!(completion.recv_timeout(Duration::from_secs(1)).unwrap());
        waiter.join().unwrap();
    }
}
