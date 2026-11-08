//! In-memory compressed terminal history (roadmap A2; decision D14).
//!
//! Lines that scroll out of an xterm hot window are appended here in batches;
//! `src/terminalHistory.ts` encodes them on the JS side and the shared format
//! plus its cross-language golden vectors live in `src/terminalHistory.golden.json`.
//! Records accumulate in a small pending buffer and are sealed into blocks of
//! [`RECORDS_PER_BLOCK`] lines, each compressed with LZ4. A session keeps at
//! most [`HistoryStore::SESSION_COMPRESSED_CAP`] bytes of compressed blocks or
//! [`HistoryStore::SESSION_RECORD_CAP`] records, whichever it hits first, and
//! the whole store keeps [`HistoryStore::GLOBAL_COMPRESSED_CAP`]; eviction
//! drops the oldest block of the least recently sealed session and counts
//! what it dropped so the UI can say how many older lines were discarded.
//! Nothing is ever written to disk (D14-1), and `clear` releases a whole
//! session at once, including when its tab closes.
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// One logical line of history: wrapped fragments already joined by the JS
/// side, with its SGR runs kept as cell-coordinate segments so a view can
/// re-wrap the line for the current width.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub(crate) struct HistoryLine {
    #[serde(rename = "absLine")]
    pub abs_line: u64,
    #[serde(rename = "timeMs")]
    pub time_ms: u64,
    pub text: String,
    pub runs: Vec<HistoryRun>,
}

/// One SGR run over [`HistoryLine::text`] in cell coordinates; `fg`/`bg` are
/// 32-bit packed colors where `u32::MAX` means "default", and `flags` carries
/// the modifier bits (1 bold, 2 dim, 4 italic, 8 underline, 16 blink,
/// 32 inverse, 64 invisible, 128 strike).
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub(crate) struct HistoryRun {
    pub start: u32,
    pub len: u32,
    pub fg: u32,
    pub bg: u32,
    pub flags: u32,
}

#[derive(Debug)]
pub(crate) enum HistoryError {
    /// The batch or the session's line ordering is wrong (absLine must
    /// strictly increase, timeMs must not decrease).
    Order(&'static str),
    /// The bytes are not a well-formed batch.
    Malformed(String),
    /// No such session (already cleared or never created).
    UnknownSession,
}
impl std::fmt::Display for HistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HistoryError::Order(what) => write!(f, "history order: {what}"),
            HistoryError::Malformed(what) => write!(f, "history batch malformed: {what}"),
            HistoryError::UnknownSession => write!(f, "history session not found"),
        }
    }
}

fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl Reader<'_> {
    fn take(&mut self, want: usize, what: &str) -> Result<&[u8], HistoryError> {
        let end = self.pos.checked_add(want).ok_or_else(|| malformed(what))?;
        if end > self.bytes.len() {
            return Err(malformed(what));
        }
        let slice = &self.bytes[self.pos..end];
        self.pos = end;
        Ok(slice)
    }
    fn u16(&mut self, what: &str) -> Result<u16, HistoryError> {
        let raw = self.take(2, what)?;
        Ok(u16::from_le_bytes([raw[0], raw[1]]))
    }
    fn u32(&mut self, what: &str) -> Result<u32, HistoryError> {
        let raw = self.take(4, what)?;
        Ok(u32::from_le_bytes([raw[0], raw[1], raw[2], raw[3]]))
    }
    fn varint(&mut self, what: &str) -> Result<u64, HistoryError> {
        let mut value: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = *self.take(1, what)?.first().ok_or_else(|| malformed(what))?;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(malformed(what))
    }
}

fn malformed(what: &str) -> HistoryError {
    HistoryError::Malformed(what.to_string())
}

/// Encodes one batch; `lines` must be ordered (absLine strictly increasing,
/// timeMs non-decreasing) or [`HistoryError::Order`] is returned.
pub(crate) fn encode_batch(lines: &[HistoryLine]) -> Result<Vec<u8>, HistoryError> {
    if lines.len() > u32::MAX as usize {
        return Err(malformed("batch too large"));
    }
    let mut out = Vec::new();
    out.extend_from_slice(&(lines.len() as u32).to_le_bytes());
    let mut prev_abs = 0u64;
    let mut prev_time = 0u64;
    for line in lines {
        if line.abs_line <= prev_abs {
            return Err(HistoryError::Order(
                "absLine did not increase within a batch",
            ));
        }
        if line.time_ms < prev_time {
            return Err(HistoryError::Order("timeMs decreased within a batch"));
        }
        put_varint(&mut out, line.abs_line - prev_abs);
        put_varint(&mut out, line.time_ms - prev_time);
        let text = line.text.as_bytes();
        // The format's length field is u16, so a longer line is a contract
        // violation, never a silent truncation.
        if text.len() > u16::MAX as usize {
            return Err(malformed("line text longer than the u16 length field"));
        }
        out.extend_from_slice(&(text.len() as u16).to_le_bytes());
        out.extend_from_slice(text);
        if line.runs.len() > u16::MAX as usize {
            return Err(malformed("too many runs"));
        }
        out.extend_from_slice(&(line.runs.len() as u16).to_le_bytes());
        for run in &line.runs {
            put_varint(&mut out, u64::from(run.start));
            put_varint(&mut out, u64::from(run.len));
            put_varint(&mut out, u64::from(run.fg));
            put_varint(&mut out, u64::from(run.bg));
            put_varint(&mut out, u64::from(run.flags));
        }
        prev_abs = line.abs_line;
        prev_time = line.time_ms;
    }
    Ok(out)
}

/// Decodes one batch produced by [`encode_batch`] or the TS encoder; the
/// ordering rules are enforced on the way in as well.
pub(crate) fn decode_batch(bytes: &[u8]) -> Result<Vec<HistoryLine>, HistoryError> {
    let mut reader = Reader { bytes, pos: 0 };
    let count = reader.u32("record count")? as usize;
    let mut lines = Vec::with_capacity(count.min(4096));
    let mut prev_abs = 0u64;
    let mut prev_time = 0u64;
    for _ in 0..count {
        let abs_delta = reader.varint("absLine delta")?;
        let time_delta = reader.varint("timeMs delta")?;
        let abs_line = prev_abs
            .checked_add(abs_delta)
            .ok_or_else(|| malformed("absLine overflow"))?;
        let time_ms = prev_time
            .checked_add(time_delta)
            .ok_or_else(|| malformed("timeMs overflow"))?;
        if abs_delta == 0 {
            return Err(HistoryError::Order(
                "absLine did not increase within a batch",
            ));
        }
        let text_len = reader.u16("text length")? as usize;
        let text = std::str::from_utf8(reader.take(text_len, "text bytes")?)
            .map_err(|_| malformed("text is not utf-8"))?
            .to_string();
        let run_count = reader.u16("run count")? as usize;
        let mut runs = Vec::with_capacity(run_count.min(1024));
        for _ in 0..run_count {
            let read = |reader: &mut Reader<'_>| -> Result<u32, HistoryError> {
                let value = reader.varint("run field")?;
                u32::try_from(value).map_err(|_| malformed("run field exceeds u32"))
            };
            runs.push(HistoryRun {
                start: read(&mut reader)?,
                len: read(&mut reader)?,
                fg: read(&mut reader)?,
                bg: read(&mut reader)?,
                flags: read(&mut reader)?,
            });
        }
        lines.push(HistoryLine {
            abs_line,
            time_ms,
            text: text.to_string(),
            runs,
        });
        prev_abs = abs_line;
        prev_time = time_ms;
    }
    if reader.pos != bytes.len() {
        return Err(malformed("trailing bytes after the batch"));
    }
    Ok(lines)
}

/// One sealed, compressed block of history. `raw_len` is the uncompressed
/// byte length LZ4 needs to decompress in place.
struct Block {
    first_abs: u64,
    last_abs: u64,
    records: u32,
    raw_len: usize,
    compressed: Vec<u8>,
}
impl Block {
    fn seal(lines: &[HistoryLine]) -> Block {
        let raw = encode_batch(lines).expect("sealed lines passed append validation");
        let compressed = lz4_flex::block::compress(&raw);
        Block {
            first_abs: lines.first().map(|l| l.abs_line).unwrap_or(0),
            last_abs: lines.last().map(|l| l.abs_line).unwrap_or(0),
            records: lines.len() as u32,
            raw_len: raw.len(),
            compressed,
        }
    }
    fn lines(&self) -> Vec<HistoryLine> {
        let raw = lz4_flex::block::decompress(&self.compressed, self.raw_len)
            .expect("history blocks are only produced by seal");
        decode_batch(&raw).expect("history blocks are only produced from valid lines")
    }
}

struct SessionHistory {
    blocks: VecDeque<Block>,
    pending: Vec<HistoryLine>,
    compressed_bytes: usize,
    records: u64,
    dropped_lines: u64,
    first_abs: u64,
    last_abs: u64,
    sealed_seq: u64,
}

/// What an append did, for the UI's "n older lines were discarded" notice.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub(crate) struct AppendOutcome {
    #[serde(rename = "storedLines")]
    pub stored_lines: u64,
    #[serde(rename = "droppedLines")]
    pub dropped_lines: u64,
    #[serde(rename = "totalRecords")]
    pub total_records: u64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub(crate) struct HistoryStats {
    #[serde(rename = "totalRecords")]
    pub total_records: u64,
    #[serde(rename = "compressedBytes")]
    pub compressed_bytes: usize,
    #[serde(rename = "droppedLines")]
    pub dropped_lines: u64,
    #[serde(rename = "firstAbsLine")]
    pub first_abs_line: u64,
    #[serde(rename = "lastAbsLine")]
    pub last_abs_line: u64,
}

struct StoreInner {
    sessions: HashMap<String, SessionHistory>,
    global_compressed: usize,
    next_seq: u64,
}

/// The process-wide history store. Caps follow D14-2 and can be narrowed in
/// tests through [`HistoryStore::with_caps`].
pub(crate) struct HistoryStore {
    inner: Mutex<StoreInner>,
    session_compressed_cap: usize,
    session_record_cap: u64,
    global_compressed_cap: usize,
}
impl Default for HistoryStore {
    fn default() -> Self {
        Self::new()
    }
}
impl HistoryStore {
    pub(crate) const SESSION_COMPRESSED_CAP: usize = 64 * 1024 * 1024;
    pub(crate) const SESSION_RECORD_CAP: u64 = 1_000_000;
    pub(crate) const GLOBAL_COMPRESSED_CAP: usize = 256 * 1024 * 1024;
    pub(crate) const RECORDS_PER_BLOCK: usize = 4096;

    pub(crate) fn new() -> Self {
        Self::with_caps(
            Self::SESSION_COMPRESSED_CAP,
            Self::SESSION_RECORD_CAP,
            Self::GLOBAL_COMPRESSED_CAP,
        )
    }

    pub(crate) fn with_caps(
        session_compressed_cap: usize,
        session_record_cap: u64,
        global_compressed_cap: usize,
    ) -> Self {
        HistoryStore {
            inner: Mutex::new(StoreInner {
                sessions: HashMap::new(),
                global_compressed: 0,
                next_seq: 0,
            }),
            session_compressed_cap,
            session_record_cap,
            global_compressed_cap,
        }
    }

    /// Appends one encoded batch. The batch must continue the session's line
    /// numbering (`absLine` strictly greater than everything stored so far),
    /// which is what a hot window exporting its trimmed lines guarantees.
    pub(crate) fn append(
        &self,
        session_id: &str,
        batch: &[u8],
    ) -> Result<AppendOutcome, HistoryError> {
        let lines = decode_batch(batch)?;
        let mut inner = self.inner.lock().expect("history store poisoned");
        let session = inner
            .sessions
            .entry(session_id.to_string())
            .or_insert_with(|| SessionHistory {
                blocks: VecDeque::new(),
                pending: Vec::new(),
                compressed_bytes: 0,
                records: 0,
                dropped_lines: 0,
                first_abs: 0,
                last_abs: 0,
                sealed_seq: 0,
            });
        if session.last_abs > 0 {
            if let Some(first) = lines.first() {
                if first.abs_line <= session.last_abs {
                    return Err(HistoryError::Order(
                        "batch does not continue the session's line numbering",
                    ));
                }
            }
        }
        let stored = lines.len() as u64;
        if session.first_abs == 0 {
            session.first_abs = lines.first().map(|l| l.abs_line).unwrap_or(0);
        }
        session.last_abs = lines.last().map(|l| l.abs_line).unwrap_or(session.last_abs);
        session.records += stored;
        session.pending.extend(lines);
        let mut sealed = Vec::new();
        while session.pending.len() >= Self::RECORDS_PER_BLOCK {
            let rest: Vec<HistoryLine> = session.pending.split_off(Self::RECORDS_PER_BLOCK);
            sealed.push(std::mem::replace(&mut session.pending, rest));
        }
        for chunk in sealed {
            Self::seal_block(&mut inner, session_id, chunk, self.session_compressed_cap);
        }
        // Record cap: drop whole oldest blocks (never the pending tail) until
        // the session's sealed lines are back under its line budget.
        loop {
            let over = {
                let session = &inner.sessions[session_id];
                session.records - pending_count(session) > self.session_record_cap
            };
            if !over || !drop_oldest(&mut inner, session_id) {
                break;
            }
        }
        // Global cap: evict the least recently sealed session's oldest block
        // until the store fits again; the current session competes like any
        // other, and its newest block survives because its sealed_seq is the
        // largest.
        while inner.global_compressed > self.global_compressed_cap {
            let victim = inner
                .sessions
                .iter()
                .filter(|(_, session)| !session.blocks.is_empty())
                .min_by_key(|(_, session)| session.sealed_seq)
                .map(|(id, _)| id.clone());
            match victim {
                Some(victim) => {
                    if !drop_oldest(&mut inner, &victim) {
                        break;
                    }
                }
                None => break,
            }
        }
        let session = &inner.sessions[session_id];
        Ok(AppendOutcome {
            stored_lines: stored,
            dropped_lines: session.dropped_lines,
            total_records: session.records,
        })
    }

    fn seal_block(
        inner: &mut StoreInner,
        session_id: &str,
        chunk: Vec<HistoryLine>,
        session_cap: usize,
    ) {
        let seq = inner.next_seq;
        inner.next_seq += 1;
        {
            let session = inner
                .sessions
                .get_mut(session_id)
                .expect("caller holds the entry");
            let block = Block::seal(&chunk);
            session.compressed_bytes += block.compressed.len();
            session.sealed_seq = seq;
            inner.global_compressed += block.compressed.len();
            session.blocks.push_back(block);
        }
        // Session cap: keep at least the newest block, drop older ones.
        loop {
            let over = {
                let session = inner
                    .sessions
                    .get_mut(session_id)
                    .expect("caller holds the entry");
                session.compressed_bytes > session_cap && session.blocks.len() > 1
            };
            if !over || !drop_oldest(inner, session_id) {
                break;
            }
        }
    }

    /// Newest-first page of lines with `abs_line >= from_abs`, at most
    /// `max_lines` of them. Pending lines come first because they are the
    /// newest.
    pub(crate) fn read(
        &self,
        session_id: &str,
        from_abs: u64,
        max_lines: usize,
    ) -> Result<Vec<HistoryLine>, HistoryError> {
        let inner = self.inner.lock().expect("history store poisoned");
        let session = inner
            .sessions
            .get(session_id)
            .ok_or(HistoryError::UnknownSession)?;
        let mut out = Vec::new();
        for line in session.pending.iter().rev() {
            if out.len() >= max_lines {
                return Ok(out);
            }
            if line.abs_line >= from_abs {
                out.push(line.clone());
            }
        }
        for block in session.blocks.iter().rev() {
            if out.len() >= max_lines {
                break;
            }
            if block.last_abs < from_abs {
                break;
            }
            for line in block.lines().into_iter().rev() {
                if out.len() >= max_lines {
                    break;
                }
                if line.abs_line >= from_abs {
                    out.push(line);
                }
            }
        }
        Ok(out)
    }

    /// Newest-first page strictly *before* an absolute line. The caller uses
    /// the oldest returned `abs_line` as the next exclusive cursor, so
    /// adjacent pages cannot repeat a record even if new lines are appended
    /// between reads. Pass `u64::MAX` for the initial page.
    ///
    /// Unlike `read` (whose inclusive lower-bound contract is retained), this
    /// skips sealed blocks wholly newer than the cursor without decompressing
    /// them. Only blocks that can contribute records are decoded.
    pub(crate) fn read_before(
        &self,
        session_id: &str,
        before_abs: u64,
        max_lines: usize,
    ) -> Result<Vec<HistoryLine>, HistoryError> {
        let inner = self.inner.lock().expect("history store poisoned");
        let session = inner
            .sessions
            .get(session_id)
            .ok_or(HistoryError::UnknownSession)?;
        let mut out = Vec::new();
        if before_abs == 0 || max_lines == 0 {
            return Ok(out);
        }
        for line in session.pending.iter().rev() {
            if out.len() >= max_lines {
                return Ok(out);
            }
            if line.abs_line < before_abs {
                out.push(line.clone());
            }
        }
        for block in session.blocks.iter().rev() {
            if out.len() >= max_lines {
                break;
            }
            if block.first_abs >= before_abs {
                continue;
            }
            for line in block.lines().into_iter().rev() {
                if out.len() >= max_lines {
                    break;
                }
                if line.abs_line < before_abs {
                    out.push(line);
                }
            }
        }
        Ok(out)
    }

    /// Newest-first substring search over stored text. `budget` bounds the
    /// whole call; blocks checked after it expires are skipped, which the
    /// caller reports alongside the hits.
    pub(crate) fn search(
        &self,
        session_id: &str,
        needle: &str,
        limit: usize,
        budget: Duration,
    ) -> Result<Vec<HistorySearchHit>, HistoryError> {
        self.search_with_before(session_id, needle, limit, budget, None)
    }

    /// Like `search`, but search only records whose absolute line is strictly
    /// older than `before_abs`. A hot line may already have been exported to
    /// cold storage before xterm trims it; filtering *before* enforcing the
    /// hit limit prevents those overlapping records from consuming the cold
    /// result budget or being counted twice by the UI.
    pub(crate) fn search_before(
        &self,
        session_id: &str,
        needle: &str,
        limit: usize,
        budget: Duration,
        before_abs: u64,
    ) -> Result<Vec<HistorySearchHit>, HistoryError> {
        self.search_with_before(session_id, needle, limit, budget, Some(before_abs))
    }

    fn search_with_before(
        &self,
        session_id: &str,
        needle: &str,
        limit: usize,
        budget: Duration,
        before_abs: Option<u64>,
    ) -> Result<Vec<HistorySearchHit>, HistoryError> {
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let deadline = Instant::now() + budget;
        let inner = self.inner.lock().expect("history store poisoned");
        let session = inner
            .sessions
            .get(session_id)
            .ok_or(HistoryError::UnknownSession)?;
        let mut hits = Vec::new();
        let push_hits = |lines: Vec<HistoryLine>, hits: &mut Vec<HistorySearchHit>| {
            for line in lines.into_iter().rev() {
                // The optional cursor is an exclusive upper bound; check it
                // before counting hits, not after the limit has been filled.
                if before_abs.is_some_and(|before| line.abs_line >= before) {
                    continue;
                }
                if hits.len() >= limit {
                    return;
                }
                for (char_index, _) in line.text.char_indices() {
                    if line.text[char_index..].starts_with(needle) {
                        // char_indices yields byte offsets; the count up to
                        // the offset is the character column, 1-based here.
                        let column = line.text[..char_index].chars().count() as u32 + 1;
                        hits.push(HistorySearchHit {
                            abs_line: line.abs_line,
                            column,
                        });
                        break;
                    }
                }
            }
        };
        push_hits(session.pending.clone(), &mut hits);
        if hits.len() < limit {
            for block in session.blocks.iter().rev() {
                if hits.len() >= limit || Instant::now() > deadline {
                    break;
                }
                if before_abs.is_some_and(|before| block.first_abs >= before) {
                    continue;
                }
                push_hits(block.lines(), &mut hits);
            }
        }
        Ok(hits)
    }

    pub(crate) fn clear(&self, session_id: &str) {
        let mut inner = self.inner.lock().expect("history store poisoned");
        if let Some(session) = inner.sessions.remove(session_id) {
            inner.global_compressed -= session.compressed_bytes.min(inner.global_compressed);
        }
    }

    pub(crate) fn stats(&self, session_id: &str) -> Result<HistoryStats, HistoryError> {
        let inner = self.inner.lock().expect("history store poisoned");
        let session = inner
            .sessions
            .get(session_id)
            .ok_or(HistoryError::UnknownSession)?;
        Ok(HistoryStats {
            total_records: session.records,
            compressed_bytes: session.compressed_bytes,
            dropped_lines: session.dropped_lines,
            first_abs_line: session.first_abs,
            last_abs_line: session.last_abs,
        })
    }

    pub(crate) fn global_compressed_bytes(&self) -> usize {
        self.inner
            .lock()
            .expect("history store poisoned")
            .global_compressed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub(crate) struct HistorySearchHit {
    #[serde(rename = "absLine")]
    pub abs_line: u64,
    pub column: u32,
}

fn pending_count(session: &SessionHistory) -> u64 {
    session.pending.len() as u64
}

/// Drops the oldest block of `session_id` (or, for the global cap, of the
/// least recently sealed session) and updates every counter. Returns false
/// when there was nothing to drop.
fn drop_oldest(inner: &mut StoreInner, session_id: &str) -> bool {
    let session = match inner.sessions.get_mut(session_id) {
        Some(session) => session,
        None => return false,
    };
    let Some(block) = session.blocks.pop_front() else {
        return false;
    };
    session.compressed_bytes -= block.compressed.len().min(session.compressed_bytes);
    inner.global_compressed -= block.compressed.len().min(inner.global_compressed);
    session.records -= u64::from(block.records);
    session.dropped_lines += u64::from(block.records);
    session.first_abs = session
        .pending
        .first()
        .map(|l| l.abs_line)
        .or_else(|| session.blocks.front().map(|b| b.first_abs))
        .unwrap_or(session.last_abs);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/terminalHistory.golden.json")
    }

    fn line(abs: u64, time: u64, text: &str) -> HistoryLine {
        HistoryLine {
            abs_line: abs,
            time_ms: time,
            text: text.into(),
            runs: Vec::new(),
        }
    }

    fn hex_string(hex: &str) -> Vec<u8> {
        let cleaned: String = hex.chars().filter(|c| !c.is_whitespace()).collect();
        (0..cleaned.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&cleaned[i..i + 2], 16).expect("valid hex pair"))
            .collect()
    }

    fn batch(lines: &[HistoryLine]) -> Vec<u8> {
        encode_batch(lines).expect("test lines are ordered")
    }

    /// The vectors in src/terminalHistory.golden.json are the contract both
    /// encoders must match byte for byte; the TS tests read the same file.
    #[test]
    fn golden_vectors_round_trip_and_reject() {
        let raw = std::fs::read_to_string(golden_path()).expect("golden vectors exist");
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let vectors = value["vectors"].as_array().expect("vectors array");
        assert_eq!(vectors.len(), 4);
        for vector in vectors {
            let name = vector["name"].as_str().unwrap();
            let expected: Vec<HistoryLine> =
                serde_json::from_value(vector["lines"].clone()).unwrap();
            match vector["hex"].as_str() {
                Some(hex) => {
                    let bytes = hex_string(hex);
                    assert_eq!(decode_batch(&bytes).unwrap(), expected, "decode {name}");
                    assert_eq!(encode_batch(&expected).unwrap(), bytes, "encode {name}");
                }
                None => {
                    let error = encode_batch(&expected).unwrap_err().to_string();
                    let want = vector["expectError"].as_str().unwrap();
                    assert!(error.contains(want), "{name}: {error}");
                }
            }
        }
    }

    #[test]
    fn decode_rejects_a_repeated_abs_line_and_trailing_bytes() {
        // count=1, absLine delta 0, timeMs delta 0, empty text, no runs.
        let bytes = [1u8, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        assert!(matches!(decode_batch(&bytes), Err(HistoryError::Order(_))));
        let mut valid = batch(&[line(1, 1, "a")]);
        valid.push(0);
        assert!(matches!(
            decode_batch(&valid),
            Err(HistoryError::Malformed(_))
        ));
    }

    #[test]
    fn generated_lines_round_trip() {
        let mut lines = Vec::new();
        for i in 1..=1000u64 {
            lines.push(HistoryLine {
                abs_line: i,
                time_ms: 1_700_000_000_000 + i * 3,
                text: format!("line {i} 你好 {}", i % 97),
                runs: vec![
                    HistoryRun {
                        start: 0,
                        len: 4,
                        fg: 0xff9bd5ff,
                        bg: u32::MAX,
                        flags: 1,
                    },
                    HistoryRun {
                        start: 6,
                        len: 2,
                        fg: 0x66ccffff,
                        bg: 0x101010,
                        flags: 8 | 128,
                    },
                ],
            });
        }
        let bytes = encode_batch(&lines).unwrap();
        assert_eq!(decode_batch(&bytes).unwrap(), lines);
    }

    #[test]
    fn append_seals_blocks_and_reads_newest_first_across_boundaries() {
        let store = HistoryStore::new();
        let mut abs = 0u64;
        for _ in 0..2 {
            let lines: Vec<_> = (1..=4096u32)
                .map(|_| {
                    abs += 1;
                    line(abs, abs, &format!("text-{abs}"))
                })
                .collect();
            store.append("s", &batch(&lines)).unwrap();
        }
        let tail: Vec<_> = (1..=100u32)
            .map(|_| {
                abs += 1;
                line(abs, abs, &format!("text-{abs}"))
            })
            .collect();
        store.append("s", &batch(&tail)).unwrap();
        assert_eq!(store.stats("s").unwrap().total_records, 8292);
        assert_eq!(store.stats("s").unwrap().dropped_lines, 0);

        let top = store.read("s", 1, 3).unwrap();
        assert_eq!(
            top.iter().map(|l| l.abs_line).collect::<Vec<_>>(),
            vec![8292, 8291, 8290]
        );

        // A page long enough to cross the pending/newest-block boundary.
        let page = store.read("s", 1, 150).unwrap();
        let abs_list: Vec<u64> = page.iter().map(|l| l.abs_line).collect();
        assert!(
            abs_list.contains(&8193) && abs_list.contains(&8192),
            "{abs_list:?}"
        );
        assert_eq!(abs_list.len(), 150);
        let filtered = store.read("s", 4090, 7).unwrap();
        assert!(filtered.iter().all(|l| l.abs_line >= 4090));
        assert_eq!(filtered.len(), 7);
    }

    #[test]
    fn exclusive_read_pages_501_lines_without_duplicates() {
        let store = HistoryStore::new();
        let lines: Vec<_> = (1..=501u64).map(|i| line(i, i, "page")).collect();
        store.append("s", &batch(&lines)).unwrap();

        let first = store.read_before("s", u64::MAX, 500).unwrap();
        assert_eq!(first.len(), 500);
        assert_eq!(first.first().unwrap().abs_line, 501);
        assert_eq!(first.last().unwrap().abs_line, 2);
        let second = store.read_before("s", 2, 500).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!(second[0].abs_line, 1);
        assert!(store.read_before("s", 1, 500).unwrap().is_empty());
        assert!(store.read_before("s", 0, 500).unwrap().is_empty());

        // This is a separate command contract: the original inclusive
        // lower-bound reader still returns the newest records.
        assert_eq!(store.read("s", 2, 1).unwrap()[0].abs_line, 501);
    }

    #[test]
    fn exclusive_read_pages_1000_lines_and_skips_later_appends() {
        let store = HistoryStore::new();
        let lines: Vec<_> = (1..=1000u64).map(|i| line(i, i, "page")).collect();
        store.append("s", &batch(&lines)).unwrap();

        let first = store.read_before("s", u64::MAX, 500).unwrap();
        assert_eq!(first.len(), 500);
        assert_eq!(first.last().unwrap().abs_line, 501);
        store
            .append("s", &batch(&[line(1001, 1001, "later")]))
            .unwrap();
        let second = store.read_before("s", 501, 500).unwrap();
        assert_eq!(second.len(), 500);
        assert_eq!(second.first().unwrap().abs_line, 500);
        assert_eq!(second.last().unwrap().abs_line, 1);
        assert!(store.read_before("s", 1, 500).unwrap().is_empty());

        let mut all: Vec<_> = first
            .iter()
            .chain(second.iter())
            .map(|l| l.abs_line)
            .collect();
        all.dedup();
        assert_eq!(all.len(), 1000);
        assert_eq!(store.read_before("s", u64::MAX, 1).unwrap()[0].abs_line, 1001);
    }

    #[test]
    fn exclusive_read_crosses_compressed_blocks_and_pending() {
        let store = HistoryStore::new();
        for from in [1u64, 4097] {
            let lines: Vec<_> = (from..from + 4096).map(|i| line(i, i, "sealed")).collect();
            store.append("s", &batch(&lines)).unwrap();
        }
        let tail: Vec<_> = (8193..=8292u64).map(|i| line(i, i, "pending")).collect();
        store.append("s", &batch(&tail)).unwrap();

        assert_eq!(
            store
                .read_before("s", u64::MAX, 150)
                .unwrap()
                .iter()
                .map(|l| l.abs_line)
                .collect::<Vec<_>>(),
            (8143..=8292u64).rev().collect::<Vec<_>>()
        );
        assert_eq!(
            store
                .read_before("s", 4098, 7)
                .unwrap()
                .iter()
                .map(|l| l.abs_line)
                .collect::<Vec<_>>(),
            (4091..=4097u64).rev().collect::<Vec<_>>()
        );
        assert!(store.read_before("s", 1, 7).unwrap().is_empty());
    }

    #[test]
    fn exclusive_read_handles_empty_pages_and_evicted_prefix() {
        let store = HistoryStore::with_caps(usize::MAX, 8192, usize::MAX);
        assert!(matches!(
            store.read_before("missing", u64::MAX, 500),
            Err(HistoryError::UnknownSession)
        ));
        for from in [1u64, 4097, 8193] {
            let lines: Vec<_> = (from..from + 4096).map(|i| line(i, i, "line")).collect();
            store.append("s", &batch(&lines)).unwrap();
        }
        assert_eq!(store.stats("s").unwrap().first_abs_line, 4097);
        assert!(store.read_before("s", u64::MAX, 0).unwrap().is_empty());
        assert!(store.read_before("s", 4097, 500).unwrap().is_empty());
        let page = store.read_before("s", 8193, 4096).unwrap();
        assert_eq!(page.len(), 4096);
        assert_eq!(page.first().unwrap().abs_line, 8192);
        assert_eq!(page.last().unwrap().abs_line, 4097);
        assert!(store.read_before("s", 4097, 500).unwrap().is_empty());
    }

    #[test]
    fn append_rejects_a_batch_that_does_not_continue_the_session() {
        let store = HistoryStore::new();
        store.append("s", &batch(&[line(5, 10, "a")])).unwrap();
        assert!(matches!(
            store.append("s", &batch(&[line(5, 11, "b")])),
            Err(HistoryError::Order(_))
        ));
        store.append("s", &batch(&[line(6, 11, "b")])).unwrap();
    }

    #[test]
    fn session_record_cap_drops_oldest_blocks() {
        let store = HistoryStore::with_caps(usize::MAX, 8192, usize::MAX);
        let mut abs = 0;
        for _ in 0..3 {
            let lines: Vec<_> = (1..=4096u32)
                .map(|_| {
                    abs += 1;
                    line(abs, abs, "x")
                })
                .collect();
            store.append("s", &batch(&lines)).unwrap();
        }
        let stats = store.stats("s").unwrap();
        assert_eq!(stats.total_records, 8192);
        assert_eq!(stats.dropped_lines, 4096);
        assert_eq!(stats.first_abs_line, 4097);
        // The newest line survives: only the oldest block gave way.
        assert_eq!(store.read("s", 4097, 1).unwrap()[0].abs_line, 12288);
    }

    #[test]
    fn session_compressed_cap_keeps_only_the_newest_block() {
        let store = HistoryStore::with_caps(1, u64::MAX, usize::MAX);
        let mut abs = 0;
        for _ in 0..3 {
            let lines: Vec<_> = (1..=4096u32)
                .map(|_| {
                    abs += 1;
                    line(abs, abs, "compress me please, plenty of repetition")
                })
                .collect();
            store.append("s", &batch(&lines)).unwrap();
        }
        let stats = store.stats("s").unwrap();
        assert_eq!(stats.dropped_lines, 8192);
        assert_eq!(stats.first_abs_line, 8193);
        assert_eq!(stats.total_records, 4096);
    }

    #[test]
    fn global_cap_evicts_the_least_recently_sealed_session_first() {
        // Measure one block's compressed size, then allow one block plus a
        // little slack: "identical" blocks still differ by a byte or two
        // because each batch's first absLine delta differs.
        let probe = HistoryStore::new();
        let block = |from: u64| -> Vec<u8> {
            batch(
                &(from..from + 4096)
                    .map(|i| line(i, i, "payload"))
                    .collect::<Vec<_>>(),
            )
        };
        probe.append("probe", &block(1)).unwrap();
        let one_block = probe.global_compressed_bytes();
        assert!(one_block > 0);

        let store = HistoryStore::with_caps(usize::MAX, u64::MAX, one_block + 64);
        store.append("a", &block(1)).unwrap();
        assert_eq!(store.stats("a").unwrap().total_records, 4096);
        store.append("b", &block(1)).unwrap();
        // a sealed least recently, so a's block gave way to b's.
        assert_eq!(store.stats("a").unwrap().total_records, 0);
        assert_eq!(store.stats("a").unwrap().dropped_lines, 4096);
        assert_eq!(store.stats("b").unwrap().total_records, 4096);
        store.append("a", &block(4097)).unwrap();
        // Now b is the least recently sealed and loses its block to a's.
        assert_eq!(store.stats("b").unwrap().total_records, 0);
        assert_eq!(store.stats("b").unwrap().dropped_lines, 4096);
        assert_eq!(store.stats("a").unwrap().total_records, 4096);
        assert_eq!(store.stats("a").unwrap().dropped_lines, 4096);
    }

    #[test]
    fn search_is_newest_first_bounded_and_budget_aware() {
        let store = HistoryStore::new();
        let sealed: Vec<_> = (1..=4096u32)
            .map(|i| {
                line(
                    u64::from(i),
                    u64::from(i),
                    if i % 2 == 0 { "hit here" } else { "miss" },
                )
            })
            .collect();
        store.append("s", &batch(&sealed)).unwrap();
        let pending: Vec<_> = vec![line(4097, 4097, "hit pending"), line(4098, 4098, "nope")];
        store.append("s", &batch(&pending)).unwrap();

        let all = store
            .search("s", "hit", 10_000, Duration::from_secs(10))
            .unwrap();
        assert_eq!(all.first().unwrap().abs_line, 4097);
        assert_eq!(all.len(), 2048 + 1);
        let limited = store
            .search("s", "hit", 3, Duration::from_secs(10))
            .unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].abs_line, 4097);
        assert_eq!(limited[1].abs_line, 4096);

        // A spent budget returns only what the pending scan already found.
        let spent = store.search("s", "hit", 10_000, Duration::ZERO).unwrap();
        assert_eq!(spent.len(), 1);
        assert_eq!(spent[0].abs_line, 4097);

        // Column is 1-based on characters, not bytes.
        let columned = store
            .search("s", "pending", 10, Duration::from_secs(10))
            .unwrap();
        assert_eq!(columned[0].column, 5);
    }

    #[test]
    fn exclusive_search_filters_more_than_200_overlapping_hot_hits_before_limiting() {
        let store = HistoryStore::new();
        // Lines 51..=300 were exported early but are still present in the hot
        // buffer. The cold-only search must count all 50 older hits despite
        // those 250 newer hits exceeding the UI's 200-result cap.
        let lines: Vec<_> = (1..=300u64)
            .map(|i| line(i, i, "cold hit and overlapping hit"))
            .collect();
        store.append("s", &batch(&lines)).unwrap();

        let original = store
            .search("s", "hit", 200, Duration::from_secs(1))
            .unwrap();
        assert_eq!(original.len(), 200);
        assert_eq!(original[0].abs_line, 300);
        let filtered = store
            .search_before("s", "hit", 200, Duration::from_secs(1), 51)
            .unwrap();
        assert_eq!(filtered.len(), 50);
        assert_eq!(filtered.first().unwrap().abs_line, 50);
        assert_eq!(filtered.last().unwrap().abs_line, 1);
        assert!(filtered.iter().all(|hit| hit.abs_line < 51));
        assert!(store
            .search_before("s", "hit", 200, Duration::from_secs(1), 1)
            .unwrap()
            .is_empty());
        assert!(store
            .search_before("s", "", 200, Duration::from_secs(1), 51)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn exclusive_search_crosses_blocks_and_keeps_pending_budget_semantics() {
        let store = HistoryStore::new();
        let sealed: Vec<_> = (1..=4096u64).map(|i| line(i, i, "hit sealed")).collect();
        store.append("s", &batch(&sealed)).unwrap();
        let pending: Vec<_> = (4097..=4102u64)
            .map(|i| line(i, i, "hit pending"))
            .collect();
        store.append("s", &batch(&pending)).unwrap();

        let all = store
            .search_before("s", "hit", 5, Duration::from_secs(1), 4099)
            .unwrap();
        assert_eq!(
            all.iter().map(|hit| hit.abs_line).collect::<Vec<_>>(),
            vec![4098, 4097, 4096, 4095, 4094]
        );
        // As in the unchanged search API, a spent budget still checks the
        // pending records, but does not decompress sealed blocks.
        let spent = store
            .search_before("s", "hit", 200, Duration::ZERO, 4099)
            .unwrap();
        assert_eq!(
            spent.iter().map(|hit| hit.abs_line).collect::<Vec<_>>(),
            vec![4098, 4097]
        );
        assert!(store
            .search_before("s", "hit", 200, Duration::from_secs(1), 0)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn clear_releases_the_session_and_its_bytes() {
        let store = HistoryStore::new();
        let lines: Vec<_> = (1..=4096u32)
            .map(|i| line(u64::from(i), u64::from(i), "z"))
            .collect();
        store.append("s", &batch(&lines)).unwrap();
        assert!(store.global_compressed_bytes() > 0);
        store.clear("s");
        assert_eq!(store.global_compressed_bytes(), 0);
        assert!(matches!(
            store.stats("s"),
            Err(HistoryError::UnknownSession)
        ));
        assert!(matches!(
            store.read("s", 1, 1),
            Err(HistoryError::UnknownSession)
        ));
    }
}
