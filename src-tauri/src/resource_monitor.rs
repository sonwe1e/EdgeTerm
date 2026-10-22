//! Linux host metrics. Cumulative counters follow kernel proc/stat and block/stat;
//! NVIDIA fields use the read-only nvidia-smi CSV query, and accelerator fields
//! come from the vendor tools (npu-smi, xpu-smi) or the Rockchip/accel sysfs nodes.
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
/// One accelerator. The optional fields are independently absent: a vendor
/// table can report a temperature without a utilization, and a generic accel
/// device exposes an identity but no counters at all. `None` never turns into a
/// reading of zero.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Npu {
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
    pub npus: Vec<Npu>,
    pub npu_status: &'static str,
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
        npus: vec![],
        npu_status: status,
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
    // An absent npu block (the probe never ran it) is "no accelerator", not a
    // failed reading: the script always emits a marker on a host it probed.
    metrics.npu_status = if block("npu").is_empty() {
        "unsupported"
    } else {
        availability(block("npu"))
    };
    if metrics.npu_status == "ok" {
        let (npus, override_status) = parse_npus(block("npu"));
        metrics.npus = npus;
        if let Some(status) = override_status {
            metrics.npu_status = status;
        }
        if metrics.npus.is_empty() && metrics.npu_status == "ok" {
            metrics.npu_status = "unsupported";
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

/// One row of an `npu-smi`/`xpu-smi` ASCII table, split into its cells. Every
/// vendor table is drawn with the same `| a | b | c |` shape, so the row reads
/// the same whichever tool produced it.
fn table_cells(line: &str) -> Option<Vec<&str>> {
    let rest = line.strip_prefix('|')?;
    let mut cells: Vec<&str> = rest.split('|').map(str::trim).collect();
    if cells.last() == Some(&"") {
        cells.pop();
    }
    Some(cells)
}

/// The numeric columns of one table cell. A value the tool prints as unknown
/// keeps its slot, so a missing power reading cannot shift the temperature into
/// its place; `/` separators and unit words carry no value and are skipped.
fn cell_values(cell: &str) -> Vec<Option<f64>> {
    // `Not Supported` is the tools' two-word spelling of an absent value; fold
    // it into one token before splitting so it keeps a single slot.
    let normalized = cell
        .replace("[Not Supported]", "N/A")
        .replace("Not Supported", "N/A");
    let mut values = Vec::new();
    for token in normalized.split_whitespace() {
        if token == "/" {
            continue;
        }
        if matches!(token, "N/A" | "[N/A]" | "NA" | "-") {
            values.push(None);
        } else if let Some(value) = finite(token.trim_end_matches('%')) {
            values.push(Some(value));
        }
    }
    values
}

/// The leading number of a tool value (`26`, `26 %`, `41 C`); a word such as
/// `N/A` stays unknown.
fn leading_finite(value: &str) -> Option<f64> {
    finite(value.split_whitespace().next()?.trim_end_matches('%'))
}

fn mib_bytes(value: Option<f64>) -> Option<u64> {
    value
        .filter(|n| *n >= 0. && n.is_finite())
        .map(|n| (n * 1024. * 1024.).round() as u64)
}

/// A used/total pair is only reported when the total is a real capacity: a
/// zero total carries none, and a used value above its total is a misparse
/// rather than a reading. Either side may still be unknown on its own.
fn memory_pair(used: Option<f64>, total: Option<f64>) -> (Option<u64>, Option<u64>) {
    let Some(total_bytes) = mib_bytes(total).filter(|n| *n > 0) else {
        return (None, None);
    };
    let used_bytes = mib_bytes(used).filter(|used| *used <= total_bytes);
    (used_bytes, Some(total_bytes))
}

/// Health words `npu-smi` prints in the second column of a card's first row.
const HEALTH: [&str; 6] = ["ok", "warning", "critical", "alarm", "unknown", "healthy"];

/// Reads the `npu` section. The probe emits one source marker followed by that
/// source's own output: vendor tools print their human tables, sysfs sources
/// print the raw file, and the generic fallback prints one device per line.
fn parse_npus(lines: &[&str]) -> (Vec<Npu>, Option<&'static str>) {
    let marker = |name: &str| lines.iter().any(|line| line.starts_with(name));
    if marker("#ascend") {
        parse_ascend_npus(lines)
    } else if marker("#intel") {
        parse_intel_npus(lines)
    } else if marker("#rockchip") {
        parse_rockchip_npus(lines)
    } else if marker("#accel") {
        parse_accel_npus(lines)
    } else {
        (Vec::new(), Some("error"))
    }
}

/// Huawei Ascend: `npu-smi info` draws one card per pair of table rows. The
/// first row carries the card index, name, health, power and temperature; the
/// second carries the chip, PCIe bus, AICore utilization and the memory/HBM
/// pairs. Values are MiB, as the column headers state.
fn parse_ascend_npus(lines: &[&str]) -> (Vec<Npu>, Option<&'static str>) {
    let rows: Vec<Vec<&str>> = lines
        .iter()
        .filter_map(|line| table_cells(line))
        .filter(|cells| cells.len() >= 3)
        .collect();
    let mut npus = Vec::new();
    let mut row = 0;
    while row < rows.len() {
        let head = &rows[row];
        if !HEALTH.contains(&head[1].to_ascii_lowercase().as_str()) {
            row += 1;
            continue;
        }
        let chip = rows.get(row + 1).map(Vec::as_slice);
        match ascend_npu(head, chip) {
            Some(npu) => {
                npus.push(npu);
                row += 2;
            }
            None => row += 1,
        }
    }
    if npus.is_empty() {
        let text = lines.join(" ").to_ascii_lowercase();
        let absent = text.trim().is_empty()
            || text.contains("no npu")
            || text.contains("no device")
            || text.contains("not found");
        return (npus, Some(if absent { "unsupported" } else { "error" }));
    }
    (npus, None)
}

fn ascend_npu(head: &[&str], chip: Option<&[&str]>) -> Option<Npu> {
    let mut label = head[0].split_whitespace();
    let index = number(label.next()?).and_then(|n| u32::try_from(n).ok())?;
    let version = label.collect::<Vec<_>>().join(" ");
    let name = if version.is_empty() {
        "Ascend NPU".to_owned()
    } else {
        version.chars().take(128).collect()
    };
    // Power and temperature share the last cell of the card row.
    let temperature = cell_values(head[2]).get(1).copied().flatten();
    let chip_values = chip.map(|cells| cell_values(cells[2])).unwrap_or_default();
    let utilization = chip_values
        .first()
        .copied()
        .flatten()
        .filter(|n| *n <= 100.);
    // The chip row lists `Memory-Usage(MB)` and `HBM-Usage(MB)` as `used /
    // total` pairs. Prefer the HBM pair when the card reports one, because that
    // is the pool an Ascend NPU allocates from; otherwise take the first pair.
    let rest: Vec<Option<f64>> = chip_values.into_iter().skip(1).collect();
    let pairs: Vec<(Option<f64>, Option<f64>)> = rest
        .chunks(2)
        .filter(|pair| pair.len() == 2)
        .map(|pair| (pair[0], pair[1]))
        .collect();
    let (used_mib, total_mib) = pairs
        .iter()
        .rev()
        .find(|(_, total)| total.is_some_and(|n| n > 0.))
        .or_else(|| pairs.first())
        .map(|(used, total)| (*used, *total))
        .unwrap_or((None, None));
    let (used_bytes, total_bytes) = memory_pair(used_mib, total_mib);
    Some(Npu {
        index,
        name,
        utilization,
        used_bytes,
        total_bytes,
        temperature,
    })
}

/// Intel: `xpu-smi discovery` names each device and `xpu-smi stats -d <id>`
/// prints its counters as a two-column table. The two outputs are joined on the
/// device id the probe put in each marker line.
fn parse_intel_npus(lines: &[&str]) -> (Vec<Npu>, Option<&'static str>) {
    #[derive(Clone, Default)]
    struct Reading {
        utilization: Option<f64>,
        used_mib: Option<f64>,
        total_mib: Option<f64>,
        temperature: Option<f64>,
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Section {
        Other,
        Discovery,
        Stats(u32),
    }
    let mut names: HashMap<u32, String> = HashMap::new();
    let mut readings: HashMap<u32, Reading> = HashMap::new();
    let mut ids: Vec<u32> = Vec::new();
    let mut discovery_id: Option<u32> = None;
    let mut section = Section::Other;
    for line in lines {
        if let Some(marker) = line.strip_prefix('#') {
            section = if marker.trim() == "intel-discovery" {
                Section::Discovery
            } else if let Some(rest) = marker.strip_prefix("intel-stats ") {
                number(rest.trim())
                    .and_then(|n| u32::try_from(n).ok())
                    .map(Section::Stats)
                    .unwrap_or(Section::Other)
            } else {
                Section::Other
            };
            continue;
        }
        let Some(cells) = table_cells(line) else {
            continue;
        };
        let Some(first) = cells.first().copied() else {
            continue;
        };
        match section {
            Section::Discovery => {
                if let Some(id) = number(first)
                    .and_then(|n| u32::try_from(n).ok())
                    .filter(|n| !ids.contains(n))
                {
                    ids.push(id);
                    discovery_id = Some(id);
                }
                let named = cells
                    .iter()
                    .find(|cell| cell.to_ascii_lowercase().contains("device name"));
                if let (Some(id), Some(cell)) = (discovery_id, named) {
                    if let Some((_, name)) = cell.split_once(':') {
                        let name = name.trim();
                        if !name.is_empty() {
                            names.insert(id, name.chars().take(128).collect());
                        }
                    }
                }
            }
            Section::Stats(id) => {
                if !ids.contains(&id) {
                    ids.push(id);
                }
                let label = first.to_ascii_lowercase();
                let value = cells.get(1).copied().unwrap_or("");
                let reading = readings.entry(id).or_default();
                if label.contains("utilization") {
                    if !label.contains("memory") {
                        reading.utilization = leading_finite(value).filter(|n| *n <= 100.);
                    }
                } else if label.contains("memory used") {
                    reading.used_mib = leading_finite(value);
                } else if label.contains("memory") && label.contains("physical size") {
                    reading.total_mib = leading_finite(value);
                } else if label.contains("temperature") {
                    reading.temperature = leading_finite(value);
                }
            }
            Section::Other => {}
        }
    }
    if ids.is_empty() {
        let text = lines.join(" ").to_ascii_lowercase();
        let absent =
            text.trim().is_empty() || text.contains("no device") || text.contains("not found");
        return (
            Vec::new(),
            Some(if absent { "unsupported" } else { "error" }),
        );
    }
    ids.sort_unstable();
    let npus = ids
        .into_iter()
        .map(|id| {
            let reading = readings.get(&id).cloned().unwrap_or_default();
            let (used_bytes, total_bytes) = memory_pair(reading.used_mib, reading.total_mib);
            Npu {
                index: id,
                name: names
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| format!("XPU {id}")),
                utilization: reading.utilization,
                used_bytes,
                total_bytes,
                temperature: reading.temperature,
            }
        })
        .collect();
    (npus, None)
}

/// Rockchip: `/sys/kernel/debug/rknpu/load` prints `load: 12% 11% 10%`, one
/// percentage per NPU core. Each core stays its own row so a busy core is not
/// averaged away by two idle ones.
fn parse_rockchip_npus(lines: &[&str]) -> (Vec<Npu>, Option<&'static str>) {
    let mut npus = Vec::new();
    for line in lines {
        if line.starts_with('#') {
            continue;
        }
        let Some((label, values)) = line.split_once(':') else {
            continue;
        };
        if !label.trim().eq_ignore_ascii_case("load") {
            continue;
        }
        for token in values.split_whitespace() {
            let Some(value) = finite(token.trim_end_matches('%')).filter(|n| *n <= 100.) else {
                continue;
            };
            let index = npus.len() as u32;
            npus.push(Npu {
                index,
                name: "Rockchip NPU".to_owned(),
                utilization: Some(value),
                used_bytes: None,
                total_bytes: None,
                temperature: None,
            });
        }
    }
    if npus.is_empty() {
        return (npus, Some("error"));
    }
    (npus, None)
}

/// Generic fallback: `/sys/class/accel/*` names a device and its driver but
/// exposes no counters. The row still says a device is present, and every
/// reading stays unknown instead of being invented.
fn parse_accel_npus(lines: &[&str]) -> (Vec<Npu>, Option<&'static str>) {
    let mut npus = Vec::new();
    for line in lines {
        if line.starts_with('#') {
            continue;
        }
        let mut tokens = line.split_whitespace();
        let Some(device) = tokens.next() else {
            continue;
        };
        let name = tokens.next().unwrap_or(device);
        let index = device
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<String>()
            .chars()
            .rev()
            .collect::<String>()
            .parse::<u32>()
            .unwrap_or(npus.len() as u32);
        npus.push(Npu {
            index,
            name: name.chars().take(128).collect(),
            utilization: None,
            used_bytes: None,
            total_bytes: None,
            temperature: None,
        });
    }
    if npus.is_empty() {
        return (npus, Some("unsupported"));
    }
    (npus, None)
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
    fn npu_fixture(section: &str) -> String {
        format!("__EDGETERM__:platform\nLinux\n__EDGETERM__:npu\n{section}\n")
    }
    fn npu(output: &str) -> (Metrics, Vec<Npu>) {
        let (metrics, _) = parse(output).unwrap();
        let npus = metrics.npus.clone();
        (metrics, npus)
    }
    #[test]
    fn ascend_npu_smi_pairs_card_rows_and_prefers_hbm_capacity() {
        let (metrics, npus) = npu(&npu_fixture(
            "#ascend
+--------------------------------------------------------------------------------------------+
| npu-smi 23.0.rc3.3                Version: 23.0.rc3.3                                     |
+---------------------------+---------------+------------------------------------------------+
| NPU     Name              | Health        | Power(W)    Temp(C)           Hugepages-Usage(page) |
| Chip                      | Bus-Id        | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)   |
+===========================+===============+================================================+
| 0       910B3             | OK            | 95.4        32                0    / 0       |
| 0                         | 0000:81:00.0  | 12          0    / 0          3059 / 65536   |
+---------------------------+---------------+------------------------------------------------+
| 1       910B3             | Warning       | 88.0        45                0    / 0       |
| 1                         | 0000:82:00.0  | 0           0    / 0          1024 / 65536   |
+---------------------------+---------------+------------------------------------------------+",
        ));
        assert_eq!(metrics.npu_status, "ok");
        assert_eq!(npus.len(), 2);
        assert_eq!(npus[0].index, 0);
        assert_eq!(npus[0].name, "910B3");
        assert_eq!(npus[0].utilization, Some(12.));
        assert_eq!(npus[0].temperature, Some(32.));
        assert_eq!(npus[0].used_bytes, Some(3059 * 1024 * 1024));
        assert_eq!(npus[0].total_bytes, Some(65536 * 1024 * 1024));
        assert_eq!(npus[1].index, 1);
        assert_eq!(npus[1].utilization, Some(0.));
        assert_eq!(npus[1].used_bytes, Some(1024 * 1024 * 1024));
    }
    #[test]
    fn ascend_keeps_unknown_columns_in_place_instead_of_shifting_them() {
        let (metrics, npus) = npu(&npu_fixture(
            "#ascend
| NPU     Name              | Health        | Power(W)    Temp(C)           Hugepages-Usage(page) |
| Chip                      | Bus-Id        | AICore(%)   Memory-Usage(MB)  HBM-Usage(MB)   |
| 0       310P3             | OK            | N/A         33                0    / 0       |
| 0                         | 0000:82:00.0  | N/A         N/A              N/A          |",
        ));
        assert_eq!(metrics.npu_status, "ok");
        assert_eq!(npus.len(), 1);
        assert_eq!(npus[0].name, "310P3");
        assert_eq!(npus[0].temperature, Some(33.));
        assert_eq!(npus[0].utilization, None);
        assert_eq!(npus[0].used_bytes, None);
        assert_eq!(npus[0].total_bytes, None);
    }
    #[test]
    fn ascend_distinguishes_no_devices_from_an_unreadable_table() {
        let (absent, npus) = npu(&npu_fixture("#ascend\nnpu-smi: No NPU devices found."));
        assert_eq!(absent.npu_status, "unsupported");
        assert!(npus.is_empty());
        let (malformed, npus) = npu(&npu_fixture("#ascend\nnpu-smi: command line error: -x"));
        assert_eq!(malformed.npu_status, "error");
        assert!(npus.is_empty());
    }
    #[test]
    fn intel_xpu_smi_joins_discovery_names_with_stats() {
        let (metrics, npus) = npu(&npu_fixture(
            "#intel-discovery
+-----------+--------------------------------------------------------------------------------------+
| Device ID | Device Information                                                                   |
+-----------+--------------------------------------------------------------------------------------+
| 0         | Device Name: Intel(R) Data Center GPU Max 1550                                      |
|           | Device Type: GPU                                                                     |
+-----------+--------------------------------------------------------------------------------------+
#intel-stats 0
+----------------------------------+----------------------------------+
| Device ID                        | 0                                |
| GPU Utilization (%)              | 26                               |
| GPU Memory Used (MiB)            | 420                              |
| GPU Memory Physical Size (MiB)   | 32768                            |
| GPU Temperature (C)              | 41                               |
+----------------------------------+----------------------------------+",
        ));
        assert_eq!(metrics.npu_status, "ok");
        assert_eq!(npus.len(), 1);
        assert_eq!(npus[0].index, 0);
        assert_eq!(npus[0].name, "Intel(R) Data Center GPU Max 1550");
        assert_eq!(npus[0].utilization, Some(26.));
        assert_eq!(npus[0].used_bytes, Some(420 * 1024 * 1024));
        assert_eq!(npus[0].total_bytes, Some(32768 * 1024 * 1024));
        assert_eq!(npus[0].temperature, Some(41.));
    }
    #[test]
    fn intel_device_without_stats_stays_detected_with_unknown_readings() {
        let (metrics, npus) = npu(&npu_fixture(
            "#intel-discovery
| 0         | Device Name: Intel(R) Arc(TM) A770 Graphics                                          |
#intel-stats 0
xpu-smi: stats are not available on this device",
        ));
        assert_eq!(metrics.npu_status, "ok");
        assert_eq!(npus.len(), 1);
        assert_eq!(npus[0].name, "Intel(R) Arc(TM) A770 Graphics");
        assert_eq!(npus[0].utilization, None);
        assert_eq!(npus[0].used_bytes, None);
        assert_eq!(npus[0].temperature, None);
    }
    #[test]
    fn rockchip_rknpu_load_reports_one_row_per_core() {
        let (metrics, npus) = npu(&npu_fixture("#rockchip\nload: 12% 11% 0%"));
        assert_eq!(metrics.npu_status, "ok");
        assert_eq!(npus.len(), 3);
        assert_eq!(npus[0].index, 0);
        assert_eq!(npus[0].name, "Rockchip NPU");
        assert_eq!(npus[0].utilization, Some(12.));
        assert_eq!(npus[2].utilization, Some(0.));
        assert_eq!(npus[0].used_bytes, None);
        let (broken, npus) = npu(&npu_fixture("#rockchip\nnot a load line"));
        assert_eq!(broken.npu_status, "error");
        assert!(npus.is_empty());
    }
    #[test]
    fn generic_accel_devices_are_listed_without_invented_readings() {
        let (metrics, npus) = npu(&npu_fixture("#accel\naccel0 hisi_hdc\naccel1 rknpu"));
        assert_eq!(metrics.npu_status, "ok");
        assert_eq!(npus.len(), 2);
        assert_eq!(npus[0].index, 0);
        assert_eq!(npus[0].name, "hisi_hdc");
        assert_eq!(npus[1].index, 1);
        assert_eq!(npus[1].name, "rknpu");
        for device in npus {
            assert_eq!(device.utilization, None);
            assert_eq!(device.used_bytes, None);
            assert_eq!(device.total_bytes, None);
            assert_eq!(device.temperature, None);
        }
        let (absent, _) = npu(&npu_fixture("!unsupported"));
        assert_eq!(absent.npu_status, "unsupported");
    }
    #[test]
    fn npu_permission_denial_and_absent_probe_stay_distinct() {
        let (denied, npus) = npu(&npu_fixture("!denied"));
        assert_eq!(denied.npu_status, "denied");
        assert!(npus.is_empty());
        let (broken, npus) = npu(&npu_fixture("!error"));
        assert_eq!(broken.npu_status, "error");
        assert!(npus.is_empty());
        // A probe that never emitted the section is "no accelerator", not a
        // failed reading.
        let (unsupported, _) = parse(&fixture(10, 100, 20, 100)).unwrap();
        assert_eq!(unsupported.npu_status, "unsupported");
        assert!(unsupported.npus.is_empty());
        // The GPU path is untouched by the accelerator section.
        assert_eq!(unsupported.gpu_status, "ok");
        assert_eq!(unsupported.gpus.len(), 2);
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
