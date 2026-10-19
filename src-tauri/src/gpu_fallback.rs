//! Adaptive startup fallback for a WebView2 GPU process that cannot start
//! under its own sandbox.
//!
//! Measured on WebView2 155.0.4283.62: when the GPU sandbox is broken (a
//! display driver or an endpoint-security shim), the GPU process crash-loops
//! and Chromium eventually tears the browser process down — six GPU crashes,
//! the FATAL "GPU process isn't usable. Goodbye.", and roughly 9 s of blank
//! window before WebView2 relaunches it. Launching with
//! `--disable-gpu-sandbox` avoids the loop entirely (zero crashes, ~5 s to
//! ready) at the price of running the GPU process without that one sandbox,
//! which is why it is not applied unconditionally.
//!
//! One line in the data directory remembers whether the previous launch's
//! page became ready. The front end acknowledges its first render through
//! `show_main_window`, and `READY_WINDOW` keeps a late acknowledgement from
//! counting: on a broken machine the crashed browser process is relaunched
//! by WebView2 after the blank window, so the page *does* come up — about
//! 13-16 s in. Only a ready page inside the window proves the sandboxed GPU
//! path worked. The state machine is then:
//!
//! - previous launch kept the sandbox and never became ready in time → this
//!   one runs with `--disable-gpu-sandbox`;
//! - degraded launches stay degraded (flipping back would make every other
//!   start slow again), but after `RETRY_CLEAN_EVERY` of them one launch
//!   hands the sandbox back, so a fixed driver or a removed shim self-heals
//!   at the cost of one slow start;
//! - an unreadable or unknown marker counts as a first launch: the sandbox
//!   stays on. A marker that cannot be *written* leaves nothing to adapt on,
//!   so those launches fall back to the weaker
//!   `--disable-gpu-process-crash-limit`, which at least keeps a
//!   crash-looping GPU process from taking the browser process — and the
//!   window — down.
//!
//! `apply` runs in `setup`, after the single-instance plugin (a second
//! launch exits in that plugin's own setup, before this runs, so it cannot
//! overwrite the running app's marker) and before the webview is created.
//! A `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` the user set themselves always
//! wins, exactly like the profile folder in `run()`.
//!
//! Delete this module once the GPU sandbox starts reliably everywhere; the
//! dev-app script documents the manual override for the machines concerned.

use std::path::Path;

/// What this launch runs with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Plan {
    /// The GPU process keeps its sandbox (the normal, secure path).
    Clean,
    /// The GPU process runs without its sandbox: the previous launch kept it
    /// and its page did not become ready in time.
    Degraded,
}

const FALLBACK_ARGUMENT: &str = "--disable-gpu-sandbox";
/// When the marker cannot be persisted there is nothing to adapt on; this
/// switch at least keeps the browser process alive through a GPU crash loop
/// (the start is slow, but the app works). It must not run on tracked
/// launches: it makes the crashed browser process recover on its own, so the
/// page becomes ready late and a failure could never be observed again.
const CRASH_LIMIT_ARGUMENT: &str = "--disable-gpu-process-crash-limit";
const ARGUMENTS_VARIABLE: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// Consecutive degraded launches before one hands the sandbox back, so a
/// fixed driver self-heals. The price of a retry that still fails is one
/// slow start (~9 s blank) on the affected machine.
const RETRY_CLEAN_EVERY: u32 = 10;

/// A first-render acknowledgement later than this counts as the crashed
/// browser process having been relaunched, not as a healthy start (measured:
/// ~5 s healthy, ~13-16 s after the GPU crash loop; the margin covers cold
/// starts and antivirus scans, and a false positive self-corrects through
/// the retry above).
#[cfg(target_os = "windows")]
const READY_WINDOW: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Clean,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Ready,
}

/// One line, `<mode> <state> <runs>`: what the last launch ran with, whether
/// its page became ready in time, and the consecutive degraded launch count
/// (only meaningful for `degraded`).
fn parse_marker(line: &str) -> Option<(Mode, State, u32)> {
    let mut parts = line.trim().split_whitespace();
    let mode = match parts.next()? {
        "clean" => Mode::Clean,
        "degraded" => Mode::Degraded,
        _ => return None,
    };
    let state = match parts.next()? {
        "pending" => State::Pending,
        "ready" => State::Ready,
        _ => return None,
    };
    let runs = parts.next()?.parse().ok()?;
    parts.next().is_none().then_some((mode, state, runs))
}

fn marker_line(mode: Mode, state: State, runs: u32) -> String {
    let mode = match mode {
        Mode::Clean => "clean",
        Mode::Degraded => "degraded",
    };
    let state = match state {
        State::Pending => "pending",
        State::Ready => "ready",
    };
    format!("{mode} {state} {runs}")
}

/// Pure decision: given the previous launch's marker line (`None` on a first
/// launch or an unreadable marker), return this launch's plan and the
/// pending marker line to persist for it.
pub(crate) fn decide(previous: Option<&str>) -> (Plan, String) {
    match previous.and_then(parse_marker) {
        // First launch, an unreadable marker, or the previous launch kept
        // the sandbox and became ready in time: keep the sandbox on.
        None | Some((Mode::Clean, State::Ready, _)) => {
            (Plan::Clean, marker_line(Mode::Clean, State::Pending, 0))
        }
        // The previous launch kept the sandbox and its page never became
        // ready in time: this is a machine where the GPU process cannot
        // start under its sandbox.
        Some((Mode::Clean, State::Pending, _)) => (
            Plan::Degraded,
            marker_line(Mode::Degraded, State::Pending, 1),
        ),
        // Already running without the sandbox: stay there — flipping back
        // would make every other start slow again — counting this launch,
        // and hand the sandbox back after RETRY_CLEAN_EVERY of them.
        Some((Mode::Degraded, _, runs)) => {
            let runs = runs + 1;
            if runs > RETRY_CLEAN_EVERY {
                (Plan::Clean, marker_line(Mode::Clean, State::Pending, 0))
            } else {
                (
                    Plan::Degraded,
                    marker_line(Mode::Degraded, State::Pending, runs),
                )
            }
        }
    }
}

#[cfg(target_os = "windows")]
static LAUNCH: std::sync::OnceLock<(Mode, u32, std::time::Instant)> = std::sync::OnceLock::new();

#[cfg(target_os = "windows")]
fn marker_path() -> std::path::PathBuf {
    crate::store::data_dir().join("webview-gpu.txt")
}

/// Decide this launch from the persisted marker, persist the new pending
/// marker for it, and set the browser arguments accordingly. Best-effort by
/// design: a marker that cannot be read or written only picks the fallback
/// argument and leaves the next launch on the clean path.
#[cfg(target_os = "windows")]
pub(crate) fn apply() {
    let path = marker_path();
    let previous = std::fs::read_to_string(&path)
        .ok()
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty());
    let (plan, pending) = decide(previous.as_deref());
    let tracked = std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).is_ok()
        && std::fs::write(&path, &pending).is_ok();
    if tracked {
        if let Some((mode, _state, runs)) = parse_marker(&pending) {
            let _ = LAUNCH.set((mode, runs, std::time::Instant::now()));
        }
    }
    if std::env::var_os(ARGUMENTS_VARIABLE).is_none() {
        match plan {
            // The normal path stays silent.
            Plan::Clean if tracked => {}
            Plan::Clean => {
                std::env::set_var(ARGUMENTS_VARIABLE, CRASH_LIMIT_ARGUMENT);
                eprintln!(
                    "edgeterm: cannot track webview startup readiness; \
launching with {CRASH_LIMIT_ARGUMENT} so a failing GPU process cannot \
take the window down"
                );
            }
            Plan::Degraded => {
                std::env::set_var(ARGUMENTS_VARIABLE, FALLBACK_ARGUMENT);
                eprintln!(
                    "edgeterm: launching WebView2 with {FALLBACK_ARGUMENT} \
(the previous launch's page did not become ready in time; the GPU \
process sandbox is likely broken on this machine)"
                );
            }
        }
    }
}

/// Record that this launch's page became ready (the front end calls
/// `show_main_window` after its first render). Acknowledgements outside
/// `READY_WINDOW` are ignored — see the module docs. A no-op when this
/// process never tracked a marker.
#[cfg(target_os = "windows")]
pub(crate) fn mark_ready() {
    if let Some((mode, runs, started)) = LAUNCH.get() {
        if started.elapsed() <= READY_WINDOW {
            let _ = std::fs::write(marker_path(), marker_line(*mode, State::Ready, *runs));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fallback_argument_is_literal() {
        // The WebView2 loader only reads the exact switch name, so a typo in
        // the constant must fail right here.
        assert_eq!(FALLBACK_ARGUMENT, "--disable-gpu-sandbox");
        assert_eq!(CRASH_LIMIT_ARGUMENT, "--disable-gpu-process-crash-limit");
    }

    #[test]
    fn first_launch_keeps_the_sandbox() {
        assert_eq!(decide(None), (Plan::Clean, "clean pending 0".to_owned()));
    }

    #[test]
    fn garbage_marker_counts_as_first_launch() {
        for line in [
            "",
            "  ",
            "hello",
            "clean bogus 0",
            "clean pending 0 x",
            "1 2 3",
        ] {
            assert_eq!(
                decide(Some(line)),
                (Plan::Clean, "clean pending 0".to_owned()),
                "{line:?}"
            );
        }
    }

    #[test]
    fn a_runs_overflow_counts_as_first_launch() {
        assert_eq!(
            decide(Some("degraded pending 99999999999")),
            (Plan::Clean, "clean pending 0".to_owned())
        );
    }

    #[test]
    fn clean_and_ready_stays_clean() {
        assert_eq!(
            decide(Some("clean ready 0")),
            (Plan::Clean, "clean pending 0".to_owned())
        );
    }

    #[test]
    fn clean_without_ready_degrades() {
        assert_eq!(
            decide(Some("clean pending 0")),
            (Plan::Degraded, "degraded pending 1".to_owned())
        );
    }

    #[test]
    fn degraded_launches_stay_degraded_and_count() {
        // Ready or not, a degraded launch keeps the next one degraded.
        assert_eq!(
            decide(Some("degraded ready 3")),
            (Plan::Degraded, "degraded pending 4".to_owned())
        );
        assert_eq!(
            decide(Some("degraded pending 3")),
            (Plan::Degraded, "degraded pending 4".to_owned())
        );
    }

    #[test]
    fn degraded_launches_hand_the_sandbox_back_for_a_retry() {
        // At most RETRY_CLEAN_EVERY consecutive degraded launches; the next
        // one retries the sandbox.
        let last = format!("degraded ready {RETRY_CLEAN_EVERY}");
        assert_eq!(
            decide(Some(&last)),
            (Plan::Clean, "clean pending 0".to_owned())
        );
    }

    #[test]
    fn the_retry_boundary_is_inclusive() {
        let within = format!("degraded pending {}", RETRY_CLEAN_EVERY - 1);
        assert_eq!(
            decide(Some(&within)),
            (
                Plan::Degraded,
                format!("degraded pending {RETRY_CLEAN_EVERY}")
            )
        );
    }

    #[test]
    fn a_failed_retry_starts_the_degraded_count_over() {
        assert_eq!(
            decide(Some("clean pending 0")),
            (Plan::Degraded, "degraded pending 1".to_owned())
        );
    }

    #[test]
    fn marker_lines_round_trip() {
        for (mode, state, runs) in [
            (Mode::Clean, State::Pending, 0),
            (Mode::Clean, State::Ready, 0),
            (Mode::Degraded, State::Pending, 1),
            (Mode::Degraded, State::Ready, u32::MAX),
        ] {
            assert_eq!(
                parse_marker(&marker_line(mode, state, runs)),
                Some((mode, state, runs))
            );
        }
    }

    #[test]
    fn parse_tolerates_surrounding_whitespace() {
        assert_eq!(
            parse_marker("  degraded ready 7 \n"),
            Some((Mode::Degraded, State::Ready, 7))
        );
    }
}
