//! Linux host metrics. Cumulative counters follow kernel proc/stat and block/stat;
//! NVIDIA fields use the read-only nvidia-smi CSV query.
use crate::{
    error::{AppError, Result},
    file_transfer::Control,
    session::ssh::SharedTransport,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};
const SCRIPT: &str = include_str!("resource_monitor.sh");

#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub used_bytes: u64,
    pub total_bytes: u64,
}
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Capacity {
    pub used_bytes: u64,
    pub total_bytes: u64,
    pub mount: String,
}
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Gpu {
    pub index: u32,
    pub name: String,
    pub utilization: Option<f64>,
    pub used_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub temperature: Option<f64>,
}
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub status: &'static str,
    pub cpu_percent: Option<f64>,
    pub cpu_status: &'static str,
    pub memory: Option<Memory>,
    pub memory_status: &'static str,
    pub capacity: Option<Capacity>,
    pub capacity_status: &'static str,
    pub disk_read_bps: Option<f64>,
    pub disk_write_bps: Option<f64>,
    pub disk_status: &'static str,
    pub network_receive_bps: Option<f64>,
    pub network_send_bps: Option<f64>,
    pub network_status: &'static str,
    pub gpus: Vec<Gpu>,
    pub gpu_status: &'static str,
}
#[derive(Clone, Default)]
struct Raw {
    stamp: Option<f64>,
    cpu: Option<(u64, u64)>,
    disks: HashMap<String, (u64, u64)>,
    network: HashMap<String, (u64, u64)>,
}
struct Previous {
    transport: Weak<SharedTransport>,
    at: Instant,
    raw: Raw,
}
struct Active {
    owner: String,
    key: String,
    control: Arc<Control>,
}
#[derive(Default)]
struct State {
    active: HashMap<String, Active>,
    previous: HashMap<String, Previous>,
    early: HashMap<String, Instant>,
}
#[derive(Clone, Default)]
pub struct ResourceMonitor(Arc<Mutex<State>>);
pub struct Sampling {
    id: String,
    key: String,
    control: Arc<Control>,
    manager: ResourceMonitor,
}
impl Drop for Sampling {
    fn drop(&mut self) {
        self.control.set(2);
        self.manager.0.lock().active.remove(&self.id);
    }
}
impl ResourceMonitor {
    pub fn begin(&self, owner: &str, id: &str, key: String) -> Result<Sampling> {
        if id.is_empty()
            || id.len() > 100
            || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        {
            return Err(AppError::new("invalid monitor request id"));
        }
        let mut state = self.0.lock();
        if state.active.len() >= 8
            || state.active.contains_key(id)
            || state.active.values().any(|a| a.key == key)
        {
            return Err(AppError::new(
                "a sample for this SSH host is already in progress",
            ));
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
                key: key.clone(),
                control: control.clone(),
            },
        );
        Ok(Sampling {
            id: id.into(),
            key,
            control,
            manager: self.clone(),
        })
    }
    pub fn cancel(&self, id: &str) {
        let mut state = self.0.lock();
        if let Some(active) = state.active.get(id) {
            active.control.set(2);
        } else if !id.is_empty() && id.len() <= 100 && state.early.len() < 128 {
            state.early.insert(id.into(), Instant::now());
        }
    }
    pub fn close_session(&self, id: &str) {
        for active in self.0.lock().active.values() {
            if active.owner == id {
                active.control.set(2);
            }
        }
    }
    pub async fn sample(
        &self,
        request: Sampling,
        transport: Arc<SharedTransport>,
    ) -> Result<Metrics> {
        let identity = Arc::downgrade(&transport);
        let script = SCRIPT.replace("\r\n", "\n");
        let output = crate::session::exec::run(
            transport,
            &script,
            &request.control,
            128 * 1024,
            Duration::from_secs(5),
        )
        .await?;
        request.control.check().map_err(AppError::from)?;
        let (mut metrics, raw) = parse(&output)?;
        let mut state = self.0.lock();
        state
            .previous
            .retain(|_, previous| previous.at.elapsed() < Duration::from_secs(60));
        if let Some(previous) = state
            .previous
            .get(&request.key)
            .filter(|previous| previous.transport.ptr_eq(&identity))
        {
            apply_delta(&mut metrics, &raw, &previous.raw);
        }
        if state.previous.len() >= 32 {
            if let Some(oldest) = state
                .previous
                .iter()
                .min_by_key(|(_, p)| p.at)
                .map(|(k, _)| k.clone())
            {
                state.previous.remove(&oldest);
            }
        }
        state.previous.insert(
            request.key.clone(),
            Previous {
                transport: identity,
                at: Instant::now(),
                raw,
            },
        );
        Ok(metrics)
    }
}
fn number(value: &str) -> Option<u64> {
    value.parse().ok()
}
fn finite(value: &str) -> Option<f64> {
    value
        .parse::<f64>()
        .ok()
        .filter(|n| n.is_finite() && *n >= 0.)
}
fn availability(lines: &[&str]) -> &'static str {
    if lines.iter().any(|s| s.starts_with("!denied")) {
        "denied"
    } else if lines.iter().any(|s| s.starts_with("!unsupported")) {
        "unsupported"
    } else if lines.is_empty() || lines.iter().any(|s| s.starts_with("!error")) {
        "error"
    } else {
        "ok"
    }
}
fn parse(output: &str) -> Result<(Metrics, Raw)> {
    let mut blocks: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut section = "";
    for line in output.lines() {
        if let Some(name) = line.strip_prefix("__EDGETERM__:") {
            section = name;
            blocks.entry(name).or_default();
        } else if !line.trim().is_empty() {
            blocks.entry(section).or_default().push(line.trim());
        }
    }
    let block = |name: &str| blocks.get(name).map(Vec::as_slice).unwrap_or(&[]);
    let supported = block("platform") == ["Linux"];
    let status = if supported { "ok" } else { "unsupported" };
    let mut raw = Raw::default();
    let mut metrics = Metrics {
        status,
        cpu_percent: None,
        cpu_status: status,
        memory: None,
        memory_status: status,
        capacity: None,
        capacity_status: status,
        disk_read_bps: None,
        disk_write_bps: None,
        disk_status: status,
        network_receive_bps: None,
        network_send_bps: None,
        network_status: status,
        gpus: vec![],
        gpu_status: status,
    };
    if !supported {
        return Ok((metrics, raw));
    }
    raw.stamp = block("uptime")
        .first()
        .and_then(|s| s.split_whitespace().next())
        .and_then(finite);
    metrics.cpu_status = availability(block("cpu"));
    if let Some(line) = block("cpu").first() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.first() == Some(&"cpu") && fields.len() >= 5 {
            let values: Option<Vec<u64>> =
                fields.iter().skip(1).take(8).map(|s| number(s)).collect();
            if let Some(values) = values {
                let total = values.iter().try_fold(0u64, |sum, v| sum.checked_add(*v));
                let idle = values[3].checked_add(*values.get(4).unwrap_or(&0));
                raw.cpu = total.zip(idle);
            }
        }
    }
    if raw.cpu.is_none() && metrics.cpu_status == "ok" {
        metrics.cpu_status = "error";
    }
    metrics.memory_status = availability(block("memory"));
    let memory: HashMap<&str, u64> = block("memory")
        .iter()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key, number(value.split_whitespace().next()?)?))
        })
        .collect();
    if let Some(total) = memory.get("MemTotal").copied().filter(|n| *n > 0) {
        let available = memory.get("MemAvailable").copied().or_else(|| {
            memory.get("MemFree").map(|free| {
                free.saturating_add(*memory.get("Buffers").unwrap_or(&0))
                    .saturating_add(*memory.get("Cached").unwrap_or(&0))
                    .saturating_add(*memory.get("SReclaimable").unwrap_or(&0))
                    .saturating_sub(*memory.get("Shmem").unwrap_or(&0))
            })
        });
        if let Some(available) = available {
            metrics.memory = total
                .checked_mul(1024)
                .zip(total.saturating_sub(available.min(total)).checked_mul(1024))
                .map(|(total_bytes, used_bytes)| Memory {
                    total_bytes,
                    used_bytes,
                });
        }
    }
    if metrics.memory.is_none() && metrics.memory_status == "ok" {
        metrics.memory_status = "error";
    }
    metrics.capacity_status = availability(block("capacity"));
    for line in block("capacity") {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() >= 6 {
            if let Some((total_bytes, used_bytes)) = number(fields[1])
                .and_then(|v| v.checked_mul(1024))
                .zip(number(fields[2]).and_then(|v| v.checked_mul(1024)))
            {
                if used_bytes <= total_bytes && total_bytes > 0 {
                    metrics.capacity = Some(Capacity {
                        total_bytes,
                        used_bytes,
                        mount: fields[5..].join(" "),
                    });
                    break;
                }
            }
        }
    }
    if metrics.capacity.is_none() && metrics.capacity_status == "ok" {
        metrics.capacity_status = if block("capacity")
            .iter()
            .any(|s| s.to_ascii_lowercase().contains("permission denied"))
        {
            "denied"
        } else {
            "error"
        };
    }
    metrics.disk_status = availability(block("diskio"));
    let devices: HashSet<&str> = block("diskdevices").iter().copied().collect();
    for line in block("diskio") {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() >= 10 && devices.contains(fields[2]) {
            if let Some(pair) = number(fields[5]).zip(number(fields[9])) {
                raw.disks.insert(fields[2].into(), pair);
            }
        }
    }
    if raw.disks.is_empty() && metrics.disk_status == "ok" {
        metrics.disk_status = "unsupported";
    }
    metrics.network_status = availability(block("network"));
    let devices: HashSet<&str> = block("netdevices").iter().copied().collect();
    for line in block("network") {
        if let Some((name, values)) = line.split_once(':') {
            let name = name.trim();
            let fields: Vec<_> = values.split_whitespace().collect();
            if name != "lo" && (devices.is_empty() || devices.contains(name)) && fields.len() >= 16
            {
                if let Some(pair) = number(fields[0]).zip(number(fields[8])) {
                    raw.network.insert(name.into(), pair);
                }
            }
        }
    }
    if raw.network.is_empty() && metrics.network_status == "ok" {
        metrics.network_status = "unsupported";
    }
    metrics.gpu_status = availability(block("gpu"));
    if metrics.gpu_status == "ok" {
        for line in block("gpu") {
            let fields = csv(line);
            if fields.len() != 6 {
                metrics.gpu_status = "error";
                break;
            }
            let Some(index) = number(&fields[0]).and_then(|n| u32::try_from(n).ok()) else {
                metrics.gpu_status = "error";
                break;
            };
            let utilization = finite(&fields[2]).filter(|n| *n <= 100.);
            let temperature = finite(&fields[5]);
            let used_bytes = number(&fields[3]).and_then(|n| n.checked_mul(1024 * 1024));
            let total_bytes = number(&fields[4]).and_then(|n| n.checked_mul(1024 * 1024));
            let missing = |value: &str| {
                matches!(value, "N/A" | "[N/A]" | "Not Supported" | "[Not Supported]")
            };
            if [
                utilization.is_none(),
                used_bytes.is_none(),
                total_bytes.is_none(),
                temperature.is_none(),
            ]
            .into_iter()
            .zip([2, 3, 4, 5])
            .any(|(absent, index)| absent && !missing(&fields[index]))
                || used_bytes
                    .zip(total_bytes)
                    .is_some_and(|(used, total)| used > total)
            {
                metrics.gpu_status = "error";
                metrics.gpus.clear();
                break;
            }
            metrics.gpus.push(Gpu {
                index,
                name: fields[1].chars().take(128).collect(),
                utilization,
                used_bytes,
                total_bytes,
                temperature,
            });
        }
        if metrics.gpus.is_empty() && metrics.gpu_status == "ok" {
            metrics.gpu_status = "unsupported";
        }
    }
    Ok((metrics, raw))
}
fn csv(line: &str) -> Vec<String> {
    let mut values = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if quoted && chars.peek() == Some(&'"') {
                current.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if c == ',' && !quoted {
            values.push(current.trim().to_owned());
            current.clear();
        } else {
            current.push(c);
        }
    }
    values.push(current.trim().to_owned());
    values
}
fn rates(
    current: &HashMap<String, (u64, u64)>,
    previous: &HashMap<String, (u64, u64)>,
    seconds: f64,
    unit: f64,
) -> Option<(f64, f64)> {
    if current.is_empty() || current.len() != previous.len() {
        return None;
    }
    let mut first = 0u64;
    let mut second = 0u64;
    for (key, (a, b)) in current {
        let (old_a, old_b) = previous.get(key)?;
        first = first.checked_add(a.checked_sub(*old_a)?)?;
        second = second.checked_add(b.checked_sub(*old_b)?)?;
    }
    Some((
        first as f64 * unit / seconds,
        second as f64 * unit / seconds,
    ))
}
fn apply_delta(metrics: &mut Metrics, current: &Raw, previous: &Raw) {
    let Some(seconds) = current
        .stamp
        .zip(previous.stamp)
        .map(|(a, b)| a - b)
        .filter(|s| *s > 0. && *s <= 60.)
    else {
        return;
    };
    if let Some(((total, idle), (old_total, old_idle))) = current.cpu.zip(previous.cpu) {
        if let Some((total, idle)) = total.checked_sub(old_total).zip(idle.checked_sub(old_idle)) {
            if total > 0 && idle <= total {
                metrics.cpu_percent = Some((total - idle) as f64 / total as f64 * 100.);
            }
        }
    }
    if let Some((a, b)) = rates(&current.disks, &previous.disks, seconds, 512.) {
        metrics.disk_read_bps = Some(a);
        metrics.disk_write_bps = Some(b);
    }
    if let Some((a, b)) = rates(&current.network, &previous.network, seconds, 1.) {
        metrics.network_receive_bps = Some(a);
        metrics.network_send_bps = Some(b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(stamp: u32, cpu: u32, read: u32, net: u32) -> String {
        format!("__EDGETERM__:platform\nLinux\n__EDGETERM__:uptime\n{stamp} 0\n__EDGETERM__:cpu\ncpu {cpu} 0 0 100 0 0 0 0 999 999\n__EDGETERM__:memory\nMemTotal: 1000 kB\nMemAvailable: 400 kB\n__EDGETERM__:capacity\nFilesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda 10000 2000 8000 20% /\n__EDGETERM__:diskdevices\nsda\n__EDGETERM__:diskio\n8 0 sda 1 0 {read} 0 1 0 10 0 0 0 0\n8 1 sda1 1 0 9999 0 1 0 9999 0 0 0 0\n__EDGETERM__:network\neth0: {net} 0 0 0 0 0 0 0 100 0 0 0 0 0 0 0\nlo: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0\n__EDGETERM__:gpu\n0, \"NVIDIA, test\", 40, 1024, 8192, 50\n1, Second GPU, N/A, N/A, 4096, N/A\n")
    }
    #[test]
    fn first_sample_is_unknown_and_delta_uses_units_without_double_counting() {
        let (mut first, raw) = parse(&fixture(10, 100, 20, 100)).unwrap();
        assert_eq!(
            raw.cpu,
            Some((200, 100)),
            "guest counters already belong to user/nice and must not be counted twice"
        );
        assert!(first.cpu_percent.is_none());
        assert_eq!(first.memory.as_ref().unwrap().used_bytes, 614400);
        assert_eq!(first.gpus.len(), 2);
        assert_eq!(first.gpus[0].name, "NVIDIA, test");
        assert!(first.gpus[1].utilization.is_none());
        let (next, new) = parse(&fixture(12, 200, 24, 300)).unwrap();
        first = next;
        apply_delta(&mut first, &new, &raw);
        assert_eq!(first.cpu_percent, Some(100.));
        assert_eq!(first.disk_read_bps, Some(1024.));
        assert_eq!(first.network_receive_bps, Some(100.));
    }
    #[test]
    fn resets_and_device_changes_do_not_make_negative_or_fake_rates() {
        let (_, old) = parse(&fixture(10, 100, 20, 100)).unwrap();
        let (mut metrics, new) = parse(&fixture(9, 50, 1, 1)).unwrap();
        apply_delta(&mut metrics, &new, &old);
        assert!(metrics.cpu_percent.is_none());
        let (mut metrics, mut new) = parse(&fixture(12, 200, 24, 300)).unwrap();
        new.network.insert("eth1".into(), (1000, 1000));
        apply_delta(&mut metrics, &new, &old);
        assert!(metrics.network_receive_bps.is_none());
    }
    #[test]
    fn permission_error_unsupported_and_malformed_are_distinct() {
        for invalid in ["bad", "101", "-1"] {
            let (metrics, _) = parse(
                &fixture(10, 100, 20, 100)
                    .replace(", 40, 1024, 8192,", &format!(", {invalid}, 1024, 8192,")),
            )
            .unwrap();
            assert_eq!(metrics.gpu_status, "error");
            assert!(metrics.gpus.is_empty());
        }
        let (source, _) = parse(&fixture(10, 100, 20, 100).replace(
            "0, \"NVIDIA, test\", 40, 1024, 8192, 50\n1, Second GPU, N/A, N/A, 4096, N/A",
            "!denied",
        ))
        .unwrap();
        assert_eq!(source.gpu_status, "denied");
        let (unsupported, _) = parse("__EDGETERM__:platform\nDarwin\n").unwrap();
        assert_eq!(unsupported.status, "unsupported");
        let (mut broken, _) = parse(
            &fixture(10, 100, 20, 100).replace("cpu 100 0 0 100 0 0 0 0 999 999", "cpu malformed"),
        )
        .unwrap();
        assert_eq!(broken.cpu_status, "error");
        broken.cpu_percent = None;
    }
    #[test]
    fn manager_limits_inflight_and_respects_early_cancel_and_owner_close() {
        let manager = ResourceMonitor::default();
        manager.cancel("early");
        let early = manager.begin("a", "early", "host".into()).unwrap();
        assert!(early.control.check().is_err());
        drop(early);
        let first = manager.begin("a", "first", "host".into()).unwrap();
        assert!(manager.begin("b", "second", "host".into()).is_err());
        manager.close_session("a");
        assert!(first.control.check().is_err());
        drop(first);
        assert!(manager.begin("b", "second", "host".into()).is_ok());
    }

    #[tokio::test]
    #[ignore = "dedicated loopback OpenSSH with Linux and NVIDIA GPU"]
    async fn real_linux_sampler_reads_proc_and_nvidia_without_terminal_pty() {
        let var = |name: &str| std::env::var(name).unwrap();
        let address = var("EDGETERM_REAL_SSH_ADDR");
        let (host, port) = address.rsplit_once(':').unwrap();
        let port = port.parse().unwrap();
        let root = std::env::temp_dir().join(format!("edgeterm-monitor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let transport = crate::session::ssh::test_transport(
            host,
            port,
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts"),
        )
        .await;
        let manager = ResourceMonitor::default();
        let first = manager
            .sample(
                manager.begin("fixture", "first", "host".into()).unwrap(),
                transport.clone(),
            )
            .await
            .unwrap();
        assert_eq!(first.status, "ok");
        assert!(first.cpu_percent.is_none());
        assert!(first.memory.as_ref().unwrap().total_bytes > 0);
        assert_eq!(first.capacity.as_ref().unwrap().mount, "/");
        assert_eq!(first.gpu_status, "ok");
        assert!(!first.gpus.is_empty());
        tokio::time::sleep(Duration::from_millis(250)).await;
        let second = manager
            .sample(
                manager.begin("fixture", "second", "host".into()).unwrap(),
                transport.clone(),
            )
            .await
            .unwrap();
        assert!(second
            .cpu_percent
            .is_some_and(|n| (0.0..=100.0).contains(&n)));
        assert!(second.network_receive_bps.is_some());
        assert!(second.disk_read_bps.is_some());
        println!("real monitor: {}", serde_json::to_string(&second).unwrap());
        let result = crate::session::exec::run(
            transport.clone(),
            "sleep 20",
            &Control::default(),
            1024,
            Duration::from_millis(100),
        )
        .await;
        assert!(result.err().unwrap().to_string().contains("timed out"));
        let oversized = crate::session::exec::run(
            transport.clone(),
            "head -c 2048 /dev/zero",
            &Control::default(),
            1024,
            Duration::from_secs(2),
        )
        .await;
        assert!(oversized.err().unwrap().to_string().contains("limit"));
        let healthy = crate::session::exec::run(
            transport.clone(),
            "printf alive",
            &Control::default(),
            1024,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        assert_eq!(healthy, "alive");
        let replacement = crate::session::ssh::test_transport(
            host,
            port,
            &var("EDGETERM_REAL_SSH_USER"),
            &var("EDGETERM_REAL_SSH_KEY"),
            &root.join("known_hosts"),
        )
        .await;
        let fresh = manager
            .sample(
                manager
                    .begin("fixture", "replacement", "host".into())
                    .unwrap(),
                replacement.clone(),
            )
            .await
            .unwrap();
        assert!(fresh.cpu_percent.is_none());
        assert!(fresh.network_receive_bps.is_none());
        drop(replacement);
        drop(transport);
        std::fs::remove_dir_all(root).unwrap();
    }
}
