//! Public-key checks in flight. A check dials the target on a connection of
//! its own, so it outlives the click that started it; the setup dialog's
//! Cancel, and closing the session, have to reach it from outside the task.
//! This registry is that reach — `session::ssh::key_check` is what a check
//! does.
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::{
    diagnostics::Request,
    error::{AppError, Result},
    file_transfer::Control,
    model::SessionProfile,
    session::ssh::{self, KeyCheck, SharedTransport},
};

/// Most checks the app runs at once; each one is a real connection.
const MAX_ACTIVE: usize = 4;

struct Active {
    owner: String,
    control: Arc<Control>,
}

#[derive(Default)]
struct State {
    active: HashMap<String, Active>,
    /// Request ids cancelled before their check started; see `cancel`.
    early: HashMap<String, Instant>,
}

#[derive(Clone, Default)]
pub struct KeyChecks(Arc<Mutex<State>>);

/// One check the registry is holding. Dropping it — whichever way the command
/// ends — unregisters the id and stops the check.
pub struct Checking {
    id: String,
    control: Arc<Control>,
    checks: KeyChecks,
}

impl Drop for Checking {
    fn drop(&mut self) {
        self.control.set(2);
        self.checks.0.lock().active.remove(&self.id);
    }
}

impl KeyChecks {
    pub fn begin(&self, owner: &str, id: &str) -> Result<Checking> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(AppError::new("invalid key check request id"));
        }
        let mut state = self.0.lock();
        if state.active.contains_key(id) || state.active.len() >= MAX_ACTIVE {
            return Err(AppError::new("too many key checks or duplicate request id"));
        }
        state
            .early
            .retain(|_, time| time.elapsed() < Duration::from_secs(30));
        let control = Arc::new(Control::default());
        if state.early.remove(id).is_some() {
            control.set(2);
        }
        state.active.insert(
            id.into(),
            Active {
                owner: owner.into(),
                control: control.clone(),
            },
        );
        Ok(Checking {
            id: id.into(),
            control,
            checks: self.clone(),
        })
    }

    /// Marks `id` stopped. A check that has not started yet is stopped the
    /// moment it does, so a Cancel that overtakes its request still counts.
    pub fn cancel(&self, id: &str) {
        let mut state = self.0.lock();
        if let Some(active) = state.active.get(id) {
            active.control.set(2);
        } else if !id.is_empty() && id.len() <= 100 && state.early.len() < 128 {
            state.early.insert(id.into(), Instant::now());
        }
    }

    pub fn close_session(&self, owner: &str) {
        for active in self.0.lock().active.values() {
            if active.owner == owner {
                active.control.set(2);
            }
        }
    }

    /// Runs one check to its outcome. Cancellation is an outcome rather than
    /// an error: the dialog asked for it.
    pub async fn check(
        &self,
        checking: Checking,
        transport: Arc<SharedTransport>,
        profile: SessionProfile,
        request: &Request,
    ) -> Result<KeyCheck> {
        ssh::key_check(
            &transport,
            &profile,
            request,
            &checking.control,
            ssh::KEY_CHECK_TIMEOUT,
            None,
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_registry_limits_checks_and_honours_cancels_that_arrive_first() {
        let checks = KeyChecks::default();

        // A Cancel that overtakes its request still counts.
        checks.cancel("early");
        let early = checks.begin("session", "early").expect("begin");
        assert!(
            early.control.check().is_err(),
            "a check cancelled before it started must not run"
        );
        drop(early);

        let mut held = vec![checks.begin("session", "first").expect("begin")];
        assert!(
            checks.begin("session", "first").is_err(),
            "a duplicate request id is refused"
        );
        for index in 2..=MAX_ACTIVE {
            let id = format!("check-{index}");
            held.push(checks.begin("session", &id).expect("within the limit"));
        }
        assert!(
            checks.begin("session", "over").is_err(),
            "the in-flight limit holds"
        );

        checks.close_session("session");
        assert!(
            held.iter()
                .all(|checking| checking.control.check().is_err()),
            "closing the session stops every check it owns"
        );
        held.clear();

        // A check that ended frees its slot.
        checks.cancel("after");
        let after = checks.begin("other", "after").expect("begin");
        assert!(after.control.check().is_err());
    }
}
