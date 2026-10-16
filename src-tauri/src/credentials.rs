//! The credential vault behind `Store`.
//!
//! Saved passwords and passphrases never reach the webview and never appear in
//! `sessions.json`: they live in this module's map, which only the connection
//! layer reads, and are sealed in `credentials.json` next to the public files.
//!
//! The sealing key is a random master key kept in the OS credential store
//! (Windows Credential Manager, macOS Keychain, Secret Service), so the file
//! alone is useless; the store hands the key back to this user account
//! without a password. A portable copy — or any machine whose credential
//! store cannot be reached — keeps secrets for the run only: they are usable
//! while EdgeTerm runs and never written to disk.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use ring::rand::SecureRandom;
use ring::{aead, hkdf};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{AuthKind, SessionKind, SessionProfile};

/// Secrets are kept separately from the public session profiles.  This avoids
/// returning them to the webview while still allowing a saved session to be
/// reopened after an application restart without asking for a password.
#[derive(Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) passphrase: Option<String>,
}

/// `credentials.json` on disk: the secret map sealed under `VaultKey` with an
/// authenticated cipher. Every field is required, so a plain map never parses
/// as an envelope and vice versa (see `CredentialsFile`). `version` and
/// `keySource` were added with the move to the OS credential store; files
/// from before that read as version 1 sealed by the machine-bound key.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCredentials {
    /// Marker so a human (or a grep) can tell the two layouts apart.
    encrypted: bool,
    #[serde(default = "version_one")]
    version: u32,
    #[serde(default = "machine_key_source")]
    key_source: String,
    kdf: String,
    cipher: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

fn version_one() -> u32 {
    FORMAT_MACHINE
}

fn machine_key_source() -> String {
    KEY_SOURCE_MACHINE.to_string()
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CredentialsFile {
    Encrypted(EncryptedCredentials),
    Plain(HashMap<String, StoredSecrets>),
}

const VAULT_KDF: &str = "hkdf-sha256";
const VAULT_CIPHER: &str = "chacha20-poly1305";
/// File versions. 1 is the machine-bound key; 2 seals under the random master
/// key from the OS credential store.
const FORMAT_MACHINE: u32 = 1;
const FORMAT_KEY_STORE: u32 = 2;
const KEY_SOURCE_MACHINE: &str = "machine";
const KEY_SOURCE_OS_STORE: &str = "osKeyStore";
/// HKDF domains: one per key source, so a v1 file can never be decrypted with
/// a v2 key even if the key material were to coincide.
const VAULT_INFO_MACHINE: &[u8] = b"EdgeTerm credentials.json v1";
const VAULT_INFO_KEY_STORE: &[u8] = b"EdgeTerm credentials.json v2";
const VAULT_SALT_LEN: usize = 16;
const VAULT_KEY_LEN: usize = 32;
const VAULT_NONCE_LEN: usize = 12;

/// Which source a `VaultKey` was derived from; also what the envelope records
/// so a later run knows how to re-derive the key.
#[derive(Clone, Copy, PartialEq, Eq)]
enum KeySource {
    /// Bound to the machine id and account name: readable here without any
    /// store, useless on another machine. Nothing new is written this way.
    Machine,
    /// Derived from the random master key in the OS credential store.
    KeyStore,
}

impl KeySource {
    fn name(self) -> &'static str {
        match self {
            KeySource::Machine => KEY_SOURCE_MACHINE,
            KeySource::KeyStore => KEY_SOURCE_OS_STORE,
        }
    }

    fn version(self) -> u32 {
        match self {
            KeySource::Machine => FORMAT_MACHINE,
            KeySource::KeyStore => FORMAT_KEY_STORE,
        }
    }

    fn info(self) -> &'static [u8] {
        match self {
            KeySource::Machine => VAULT_INFO_MACHINE,
            KeySource::KeyStore => VAULT_INFO_KEY_STORE,
        }
    }
}

/// The key `credentials.json` is sealed with. It is derived — never stored —
/// from either the machine id and the account name, or the random master key
/// from the OS credential store, plus a random salt kept in the file.
/// Deriving from the file's own salt keeps a copied file useless without the
/// key source it was written with.
struct VaultKey {
    key: [u8; VAULT_KEY_LEN],
    salt: Vec<u8>,
    source: KeySource,
}

impl VaultKey {
    /// Version 1: what the previous release wrote and still reads.
    fn machine(salt: Vec<u8>) -> Self {
        Self::derive(machine_key_material(), salt, KeySource::Machine)
    }

    /// Version 2: the key the OS credential store keeps.
    fn from_master(master: &[u8], salt: Vec<u8>) -> Self {
        Self::derive(master, salt, KeySource::KeyStore)
    }

    fn derive(ikm: &[u8], salt: Vec<u8>, source: KeySource) -> Self {
        let mut key = [0u8; VAULT_KEY_LEN];
        hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
            .extract(ikm)
            .expand(&[source.info()], hkdf::HKDF_SHA256)
            .and_then(|okm| okm.fill(&mut key))
            .expect("HKDF output length matches the key length");
        VaultKey { key, salt, source }
    }

    /// A fresh random salt for a key used in this process.
    fn fresh_salt() -> Vec<u8> {
        let mut salt = vec![0u8; VAULT_SALT_LEN];
        // A failing system RNG means the OS has no entropy source at all;
        // nothing else in the app (SSH included) would work either.
        ring::rand::SystemRandom::new()
            .fill(&mut salt)
            .expect("system random number generator");
        salt
    }
}

/// What the machine-bound key is derived from, computed once per process: an
/// app constant, the OS machine id and the account name. Without a machine id
/// (unusual: a stripped-down container) the key is bound to the account only.
fn machine_key_material() -> &'static [u8] {
    static MATERIAL: OnceLock<Vec<u8>> = OnceLock::new();
    MATERIAL.get_or_init(|| {
        let machine = machine_id().unwrap_or_else(|| {
            tracing::warn!(
                "EdgeTerm: no machine id available; version-1 credentials are bound to the user name only"
            );
            String::new()
        });
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default();
        format!("EdgeTerm\0{machine}\0{user}").into_bytes()
    })
}

/// `IOPlatformUUID`, set at manufacture and stable across OS reinstalls.
#[cfg(target_os = "macos")]
fn machine_id() -> Option<String> {
    let output = std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find(|line| line.contains("IOPlatformUUID"))
        .and_then(|line| line.rsplit('"').nth(1))
        .map(str::to_string)
        .filter(|id| !id.is_empty())
}

/// `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid`, generated at
/// Windows installation.
#[cfg(windows)]
fn machine_id() -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};

    let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography\0"
        .encode_utf16()
        .collect();
    let value: Vec<u16> = "MachineGuid\0".encode_utf16().collect();
    let mut buffer = [0u16; 128];
    let mut size = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    // SAFETY: every pointer refers to a live local buffer or NUL-terminated
    // string, and `size` carries the buffer's byte length.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != 0 {
        return None;
    }
    let chars = (size as usize / std::mem::size_of::<u16>()).min(buffer.len());
    let text = String::from_utf16_lossy(&buffer[..chars]);
    let id = text.trim_end_matches('\0').trim().to_string();
    (!id.is_empty()).then_some(id)
}

/// systemd's `/etc/machine-id`, with the D-Bus copy as a fallback.
#[cfg(target_os = "linux")]
fn machine_id() -> Option<String> {
    ["/etc/machine-id", "/var/lib/dbus/machine-id"]
        .iter()
        .find_map(|path| std::fs::read_to_string(path).ok())
        .map(|raw| raw.trim().to_string())
        .filter(|id| !id.is_empty())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn machine_id() -> Option<String> {
    None
}

/// How saved passwords are protected right now; `credential_store_status`
/// reports it to the UI, which says where a password is typed when it will
/// not survive a restart.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CredentialStoreStatus {
    /// Whether secrets saved now survive an application restart.
    pub persistent: bool,
    /// Why they do not, when they do not.
    pub reason: Option<CredentialStoreStatusReason>,
}

impl CredentialStoreStatus {
    fn persistent() -> Self {
        CredentialStoreStatus {
            persistent: true,
            reason: None,
        }
    }

    fn session_only(reason: CredentialStoreStatusReason) -> Self {
        CredentialStoreStatus {
            persistent: false,
            reason: Some(reason),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CredentialStoreStatusReason {
    /// Portable mode: a copy must not depend on (or write to) the machine it
    /// happens to run on.
    Portable,
    /// The OS credential store could not be reached (absent, locked, …).
    KeyStoreUnavailable,
}

/// Where a `CredentialStore` finds the random master key `credentials.json`
/// is sealed with. The OS credential store is the real implementation; the
/// trait lets tests substitute a process-local store, so `cargo test` neither
/// touches the developer's credential store nor needs one to be reachable.
pub(crate) trait KeyStore: Send + Sync {
    /// The stored master key; `Ok(None)` means none was created yet. `Err`
    /// names, in words a user can act on, why the store is unusable right now.
    fn master_key(&self) -> std::result::Result<Option<Vec<u8>>, String>;

    /// Stores a freshly generated master key; only called after `Ok(None)`.
    fn set_master_key(&self, key: &[u8]) -> std::result::Result<(), String>;
}

/// The service and account the master key is filed under in the OS store.
const KEYRING_SERVICE: &str = "EdgeTerm";
const KEYRING_ACCOUNT: &str = "credentials.json master key";

/// The production key store, backed by the OS credential store.
pub(crate) fn system_key_store() -> Arc<dyn KeyStore> {
    Arc::new(OsKeyStore)
}

/// Only the master key lives in the OS store; the secret map stays sealed in
/// `credentials.json`, so a store that is slow, prompt-happy or unreachable
/// only ever costs the automatic login of saved sessions.
struct OsKeyStore;

impl KeyStore for OsKeyStore {
    fn master_key(&self) -> std::result::Result<Option<Vec<u8>>, String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(describe_keyring_error)?;
        match entry.get_password() {
            Ok(encoded) => master_key_from_text(&encoded).map(Some),
            // Nothing stored yet: the first load creates the key.
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(describe_keyring_error(error)),
        }
    }

    fn set_master_key(&self, key: &[u8]) -> std::result::Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
            .map_err(describe_keyring_error)?;
        entry
            .set_password(&B64.encode(key))
            .map_err(describe_keyring_error)
    }
}

fn master_key_from_text(encoded: &str) -> std::result::Result<Vec<u8>, String> {
    let key = B64
        .decode(encoded)
        .map_err(|_| "the stored credential vault key is not valid base64".to_string())?;
    if key.len() != VAULT_KEY_LEN {
        return Err("the stored credential vault key has the wrong length".to_string());
    }
    Ok(key)
}

fn describe_keyring_error(error: keyring::Error) -> String {
    format!("the OS credential store is unavailable ({error})")
}

/// The master key for this run: the stored one, or a freshly generated one on
/// the first launch. Failing to store the new one is fatal for persistence —
/// the vault falls back to the run-only mode below.
fn load_or_create_master(key_store: &dyn KeyStore) -> std::result::Result<Vec<u8>, String> {
    if let Some(key) = key_store.master_key()? {
        return Ok(key);
    }
    let mut key = vec![0u8; VAULT_KEY_LEN];
    ring::rand::SystemRandom::new()
        .fill(&mut key)
        .map_err(|_| "the system random number generator is unavailable".to_string())?;
    key_store.set_master_key(&key)?;
    Ok(key)
}

/// The secret map of a `Store`, kept out of the public session profiles and
/// sealed in `credentials.json`. Reads and writes serve one profile at a
/// time; `persist` writes the whole map back.
pub(crate) struct CredentialStore {
    path: PathBuf,
    /// The key `persist` seals with; `None` in the run-only mode, where
    /// nothing is written to disk at all.
    key: Option<VaultKey>,
    status: CredentialStoreStatus,
    secrets: Mutex<HashMap<String, StoredSecrets>>,
}

impl CredentialStore {
    /// Loads the vault at `path`, or starts a fresh one. `key_store` is the
    /// OS credential store, or `None` in portable mode. Whatever is wrong
    /// with the file or the store never blocks startup: unreadable secrets
    /// are dropped with a warning, the file is left alone, and the next save
    /// replaces it.
    pub(crate) fn load(path: PathBuf, key_store: Option<&dyn KeyStore>) -> Self {
        // The key store comes first: whether it works decides whether
        // secrets can be kept across restarts at all.
        let master = match key_store.map(load_or_create_master) {
            None => None,
            Some(Ok(key)) => Some(key),
            Some(Err(error)) => {
                tracing::warn!("EdgeTerm: {error}; saved passwords are kept for this run only");
                None
            }
        };
        let status = match (&master, key_store) {
            (Some(_), _) => CredentialStoreStatus::persistent(),
            (None, None) => {
                CredentialStoreStatus::session_only(CredentialStoreStatusReason::Portable)
            }
            (None, Some(_)) => CredentialStoreStatus::session_only(
                CredentialStoreStatusReason::KeyStoreUnavailable,
            ),
        };

        let opened = match read_credentials_file(&path) {
            Some(CredentialsFile::Encrypted(envelope)) => {
                open_envelope(&path, &envelope, master.as_deref())
            }
            Some(CredentialsFile::Plain(map)) => Ok(import_plain_map(map, master.as_deref())),
            None => Ok(Opened::Fresh),
        };
        let (secrets, key, reseal) = match opened {
            Ok(Opened::File {
                secrets,
                key,
                reseal,
            }) => (secrets, key, reseal),
            Ok(Opened::Fresh) => (HashMap::new(), fresh_key(&master), false),
            Err(error) => {
                tracing::warn!("EdgeTerm: {error}; saved passwords are unavailable");
                (HashMap::new(), fresh_key(&master), false)
            }
        };

        let store = Self {
            path,
            key,
            status,
            secrets: Mutex::new(secrets),
        };
        if reseal {
            // Best effort: a later explicit save surfaces filesystem errors.
            let _ = store.persist();
        }
        store
    }

    /// See `CredentialStoreStatus`.
    pub(crate) fn status(&self) -> CredentialStoreStatus {
        self.status
    }

    /// The secrets stored for the session `id`, if it has any.
    pub(crate) fn read(&self, id: &str) -> Option<StoredSecrets> {
        self.secrets.lock().get(id).cloned()
    }

    /// Replaces the secrets stored for the session `id` (a copied profile).
    pub(crate) fn write(&self, id: &str, secrets: StoredSecrets) {
        self.secrets.lock().insert(id.to_string(), secrets);
    }

    /// Forgets the secrets of the session `id` (the profile was deleted, or
    /// no longer takes a secret at all).
    pub(crate) fn remove(&self, id: &str) {
        self.secrets.lock().remove(id);
    }

    /// Stores whatever `profile` now carries. A session kind or auth method
    /// that takes no secret (or the wrong one) clears the entry, as does an
    /// empty input: an empty editor field means "ask when connecting".
    pub(crate) fn sync(&self, profile: &SessionProfile) {
        let mut secrets = self.secrets.lock();
        if !matches!(
            profile.kind,
            SessionKind::Ssh | SessionKind::Ftp | SessionKind::Sftp | SessionKind::Telnet
        ) || (matches!(profile.kind, SessionKind::Ssh | SessionKind::Sftp)
            && profile.auth == Some(AuthKind::Agent))
        {
            secrets.remove(&profile.id);
            return;
        }

        // FTP and Telnet hold a password and nothing else; Telnet's is typed
        // at the server's login prompt (see `telnet::AutoLogin`).
        if matches!(profile.kind, SessionKind::Ftp | SessionKind::Telnet) {
            let stored = secrets.entry(profile.id.clone()).or_default();
            stored.passphrase = None;
            if let Some(password) = &profile.password {
                stored.password = (!password.is_empty()).then(|| password.clone());
            }
            if stored.password.is_none() {
                secrets.remove(&profile.id);
            }
            return;
        }

        let stored = secrets.entry(profile.id.clone()).or_default();
        match profile.auth.unwrap_or_default() {
            AuthKind::Password => {
                stored.passphrase = None;
                if let Some(password) = &profile.password {
                    stored.password = (!password.is_empty()).then(|| password.clone());
                }
            }
            AuthKind::PublicKey => {
                stored.password = None;
                if let Some(passphrase) = &profile.passphrase {
                    stored.passphrase = (!passphrase.is_empty()).then(|| passphrase.clone());
                }
            }
            AuthKind::Agent => unreachable!(),
        }

        if stored.password.is_none() && stored.passphrase.is_none() {
            secrets.remove(&profile.id);
        }
    }

    /// Seals the current map into `credentials.json`. Every write uses a
    /// fresh nonce, so two writes of the same map never look alike on disk.
    /// In the run-only mode there is no key and nothing reaches the disk.
    pub(crate) fn persist(&self) -> Result<()> {
        let Some(key) = &self.key else {
            return Ok(());
        };
        let plaintext = serde_json::to_vec(&*self.secrets.lock())?;
        let envelope = seal_credentials(key, &plaintext)?;
        crate::store::write_owner_only(&self.path, &serde_json::to_string_pretty(&envelope)?)
    }
}

/// What opening the file produced; `Fresh` also stands for "no usable file",
/// including a key-store-sealed file this run cannot open.
enum Opened {
    File {
        secrets: HashMap<String, StoredSecrets>,
        /// The key new writes are sealed with; `None` in the run-only mode.
        key: Option<VaultKey>,
        /// Whether the file must be written back right away (a clear-text
        /// file re-sealed under the new key).
        reseal: bool,
    },
    Fresh,
}

/// A fresh key for a vault without a readable file, or `None` when this run
/// cannot write anyway.
fn fresh_key(master: &Option<Vec<u8>>) -> Option<VaultKey> {
    master
        .as_ref()
        .map(|master| VaultKey::from_master(master, VaultKey::fresh_salt()))
}

fn read_credentials_file(path: &Path) -> Option<CredentialsFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Opens an existing envelope and, for a machine-bound file with the master
/// key available, re-seals it under the master key before returning.
fn open_envelope(
    path: &Path,
    envelope: &EncryptedCredentials,
    master: Option<&[u8]>,
) -> Result<Opened> {
    if envelope.version > FORMAT_KEY_STORE {
        return Err(AppError::new(
            "credentials.json was written by a newer EdgeTerm (unknown version)",
        ));
    }
    if !envelope.encrypted || envelope.kdf != VAULT_KDF || envelope.cipher != VAULT_CIPHER {
        return Err(AppError::new(
            "credentials.json was written by a newer EdgeTerm (unknown cipher)",
        ));
    }
    let source = match envelope.key_source.as_str() {
        KEY_SOURCE_OS_STORE => KeySource::KeyStore,
        KEY_SOURCE_MACHINE => KeySource::Machine,
        other => {
            return Err(AppError::new(format!(
                "credentials.json names an unknown key source \"{other}\""
            )))
        }
    };
    if envelope.version != source.version() {
        return Err(AppError::new(
            "credentials.json mixes a file version with a different key source",
        ));
    }

    let salt = decode_field("salt", &envelope.salt)?;
    match source {
        KeySource::KeyStore => {
            let Some(master) = master else {
                // Portable mode or an unreachable store: leave the file for
                // a run that can read it.
                return Ok(Opened::Fresh);
            };
            let key = VaultKey::from_master(master, salt);
            Ok(Opened::File {
                secrets: decrypt(envelope, &key)?,
                key: Some(key),
                reseal: false,
            })
        }
        KeySource::Machine => {
            let machine_key = VaultKey::machine(salt);
            let secrets = decrypt(envelope, &machine_key)?;
            let Some(master) = master else {
                // The machine key still opens the file; without a key store
                // the secrets are used for this run and nothing is written.
                return Ok(Opened::File {
                    secrets,
                    key: None,
                    reseal: false,
                });
            };
            let key = match migrate_to_key_store(path, &secrets, master) {
                Ok(key) => key,
                Err(error) => {
                    // Keep the old scheme for this run; the file is
                    // untouched, so the next launch retries the move.
                    tracing::warn!("EdgeTerm: credentials.json stays machine-bound ({error})");
                    machine_key
                }
            };
            Ok(Opened::File {
                secrets,
                key: Some(key),
                reseal: false,
            })
        }
    }
}

/// A file written before sealing existed: clear-text secrets on disk. Re-seal
/// it right away when a key store is available; without one the file is left
/// alone (never rewriting plain text is the one thing worse than sealing it)
/// and the secrets are kept for the run only.
fn import_plain_map(map: HashMap<String, StoredSecrets>, master: Option<&[u8]>) -> Opened {
    if map.is_empty() {
        return Opened::Fresh;
    }
    match master {
        Some(master) => Opened::File {
            secrets: map,
            key: Some(VaultKey::from_master(master, VaultKey::fresh_salt())),
            reseal: true,
        },
        None => {
            tracing::warn!(
                "EdgeTerm: credentials.json holds clear-text passwords and no credential store is available to seal them"
            );
            Opened::File {
                secrets: map,
                key: None,
                reseal: false,
            }
        }
    }
}

/// Re-seals `secrets` under the master key and replaces `credentials.json`.
/// The flow is crash-safe: the new file is written next to the old one, read
/// back and verified against the in-memory map, the old file is renamed to
/// `credentials.json.bak`, and only then does the new file take its place.
/// Any failure leaves the old file exactly as it was, so the next launch
/// retries the move; the secrets themselves stay available this run.
fn migrate_to_key_store(
    path: &Path,
    secrets: &HashMap<String, StoredSecrets>,
    master: &[u8],
) -> Result<VaultKey> {
    let temp = sibling(path, ".tmp");
    let outcome = migrate_inner(path, &temp, secrets, master);
    if outcome.is_err() {
        // A leftover temporary file is worthless without its rename; the
        // old file is untouched either way.
        let _ = std::fs::remove_file(&temp);
    }
    outcome
}

fn migrate_inner(
    path: &Path,
    temp: &Path,
    secrets: &HashMap<String, StoredSecrets>,
    master: &[u8],
) -> Result<VaultKey> {
    let key = VaultKey::from_master(master, VaultKey::fresh_salt());
    let envelope = seal_credentials(&key, &serde_json::to_vec(secrets)?)?;
    crate::store::write_owner_only(temp, &serde_json::to_string_pretty(&envelope)?)?;

    // Verify under the new key what actually reached the disk, not what was
    // meant to be written.
    let written = match read_credentials_file(temp) {
        Some(CredentialsFile::Encrypted(envelope)) => envelope,
        _ => {
            return Err(AppError::new(
                "the rewritten credentials file is unreadable",
            ))
        }
    };
    if decrypt(&written, &key)? != *secrets {
        return Err(AppError::new(
            "the rewritten credentials file does not match",
        ));
    }

    // Commit. A stale backup can only stem from an interrupted earlier
    // attempt, so replacing it is safe.
    let backup = sibling(path, ".bak");
    std::fs::remove_file(&backup).ok();
    std::fs::rename(path, &backup)?;
    if let Err(error) = std::fs::rename(temp, path) {
        // Put the old file back rather than leave the vault without one.
        let _ = std::fs::rename(&backup, path);
        return Err(error.into());
    }
    Ok(key)
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

/// Encrypts the secret map under `key` with a fresh random nonce. The
/// envelope names the key source, so a later run knows how to re-derive it.
fn seal_credentials(key: &VaultKey, plaintext: &[u8]) -> Result<EncryptedCredentials> {
    let mut nonce = [0u8; VAULT_NONCE_LEN];
    ring::rand::SystemRandom::new()
        .fill(&mut nonce)
        .map_err(|_| AppError::new("random number generator unavailable"))?;
    let sealing = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &key.key)
            .map_err(|_| AppError::new("invalid vault key"))?,
    );
    let mut in_out = plaintext.to_vec();
    sealing
        .seal_in_place_append_tag(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::empty(),
            &mut in_out,
        )
        .map_err(|_| AppError::new("failed to encrypt credentials"))?;
    Ok(EncryptedCredentials {
        encrypted: true,
        version: key.source.version(),
        key_source: key.source.name().to_string(),
        kdf: VAULT_KDF.to_string(),
        cipher: VAULT_CIPHER.to_string(),
        salt: B64.encode(&key.salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(&in_out),
    })
}

/// Decrypts the secret map with an already derived key. A wrong key (another
/// machine, a rotated master key) fails the authentication tag.
fn decrypt(
    envelope: &EncryptedCredentials,
    key: &VaultKey,
) -> Result<HashMap<String, StoredSecrets>> {
    let nonce: [u8; VAULT_NONCE_LEN] = decode_field("nonce", &envelope.nonce)?
        .try_into()
        .map_err(|_| AppError::new("credentials.json is corrupt: bad nonce"))?;
    let mut in_out = decode_field("ciphertext", &envelope.ciphertext)?;
    let opening = aead::LessSafeKey::new(
        aead::UnboundKey::new(&aead::CHACHA20_POLY1305, &key.key)
            .map_err(|_| AppError::new("invalid vault key"))?,
    );
    let plaintext = opening
        .open_in_place(
            aead::Nonce::assume_unique_for_key(nonce),
            aead::Aad::empty(),
            &mut in_out,
        )
        .map_err(|_| AppError::new("credentials.json cannot be opened with the stored key"))?;
    serde_json::from_slice(plaintext).map_err(|_| AppError::new("credentials.json is corrupt"))
}

fn decode_field(field: &str, value: &str) -> Result<Vec<u8>> {
    B64.decode(value)
        .map_err(|_| AppError::new(format!("credentials.json is corrupt: bad {field}")))
}

/// Seals `secrets_json` the way the previous release wrote the file (the
/// machine-bound version-1 envelope); tests stage an upgrade with it.
#[cfg(test)]
pub(crate) fn legacy_envelope(secrets_json: &str) -> String {
    let key = VaultKey::machine(VaultKey::fresh_salt());
    let envelope = seal_credentials(&key, secrets_json.as_bytes()).expect("seal");
    serde_json::to_string_pretty(&envelope).expect("json")
}

/// A key store for tests: process-local, keyed by the credentials path so a
/// save and the reload after a restart share one master key while different
/// tests stay isolated. `cargo test` never reaches the OS credential store,
/// and `set_available` models a store that cannot be reached right now.
#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::{HashMap, HashSet};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, OnceLock};

    use parking_lot::Mutex;

    use super::KeyStore;

    static MASTER_KEYS: OnceLock<Mutex<HashMap<PathBuf, Vec<u8>>>> = OnceLock::new();
    static UNREACHABLE: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

    fn master_keys() -> &'static Mutex<HashMap<PathBuf, Vec<u8>>> {
        MASTER_KEYS.get_or_init(|| Mutex::new(HashMap::new()))
    }

    fn unreachable() -> &'static Mutex<HashSet<PathBuf>> {
        UNREACHABLE.get_or_init(|| Mutex::new(HashSet::new()))
    }

    /// The key store a `Store` over `credentials_path` is loaded with.
    pub(crate) fn key_store(credentials_path: &Path) -> Arc<dyn KeyStore> {
        Arc::new(TestKeyStore {
            path: credentials_path.to_path_buf(),
        })
    }

    /// Models an unreachable credential store (a locked keychain, a Linux box
    /// without a Secret Service). Affects later loads, not running ones.
    pub(crate) fn set_available(credentials_path: &Path, available: bool) {
        let mut unreachable = unreachable().lock();
        if available {
            unreachable.remove(credentials_path);
        } else {
            unreachable.insert(credentials_path.to_path_buf());
        }
    }

    /// Models the master key entry having been deleted from the store.
    pub(crate) fn forget_key(credentials_path: &Path) {
        master_keys().lock().remove(credentials_path);
    }

    struct TestKeyStore {
        path: PathBuf,
    }

    impl KeyStore for TestKeyStore {
        fn master_key(&self) -> Result<Option<Vec<u8>>, String> {
            if unreachable().lock().contains(&self.path) {
                return Err("the test credential store is unreachable".to_string());
            }
            Ok(master_keys().lock().get(&self.path).cloned())
        }

        fn set_master_key(&self, key: &[u8]) -> Result<(), String> {
            if unreachable().lock().contains(&self.path) {
                return Err("the test credential store is unreachable".to_string());
            }
            master_keys().lock().insert(self.path.clone(), key.to_vec());
            Ok(())
        }
    }
}
