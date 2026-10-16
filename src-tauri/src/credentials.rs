//! The credential vault behind `Store`.
//!
//! Saved passwords and passphrases never reach the webview and never appear in
//! `sessions.json`: they live in this module's map, which only the connection
//! layer reads, and are sealed in `credentials.json` next to the public files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use ring::rand::SecureRandom;
use ring::{aead, hkdf};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{AuthKind, SessionKind, SessionProfile};

/// Secrets are kept separately from the public session profiles.  This avoids
/// returning them to the webview while still allowing a saved session to be
/// reopened after an application restart without asking the OS credential
/// store for permission.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) passphrase: Option<String>,
}

/// `credentials.json` on disk: the secret map sealed with a key bound to this
/// machine and user account (`VaultKey`). Every field is required, so a plain
/// map never parses as an envelope and vice versa (see `CredentialsFile`).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncryptedCredentials {
    /// Marker so a human (or a grep) can tell the two layouts apart.
    encrypted: bool,
    kdf: String,
    cipher: String,
    salt: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum CredentialsFile {
    Encrypted(EncryptedCredentials),
    Plain(HashMap<String, StoredSecrets>),
}

const VAULT_KDF: &str = "hkdf-sha256";
const VAULT_CIPHER: &str = "chacha20-poly1305";
const VAULT_INFO: &[u8] = b"EdgeTerm credentials.json v1";
const VAULT_SALT_LEN: usize = 16;
const VAULT_KEY_LEN: usize = 32;
const VAULT_NONCE_LEN: usize = 12;

/// The key `credentials.json` is sealed with. It is derived — never stored —
/// from the machine id and the account name (`machine_key_material`) plus a
/// random salt kept in the file, so a copy of the file is useless on another
/// machine or account, yet it opens without any prompt on this one. Anything
/// running as this user on this machine can derive the same key: this
/// protects the file at rest, not against a compromised account.
struct VaultKey {
    key: [u8; VAULT_KEY_LEN],
    salt: Vec<u8>,
}

impl VaultKey {
    fn fresh() -> Self {
        let mut salt = vec![0u8; VAULT_SALT_LEN];
        // A failing system RNG means the OS has no entropy source at all;
        // nothing else in the app (SSH included) would work either.
        ring::rand::SystemRandom::new()
            .fill(&mut salt)
            .expect("system random number generator");
        Self::from_salt(salt)
    }

    fn from_salt(salt: Vec<u8>) -> Self {
        let mut key = [0u8; VAULT_KEY_LEN];
        hkdf::Salt::new(hkdf::HKDF_SHA256, &salt)
            .extract(machine_key_material())
            .expand(&[VAULT_INFO], hkdf::HKDF_SHA256)
            .and_then(|okm| okm.fill(&mut key))
            .expect("HKDF output length matches the key length");
        VaultKey { key, salt }
    }
}

/// What the vault key is derived from, computed once per process: an app
/// constant, the OS machine id and the account name. Without a machine id
/// (unusual: a stripped-down container) the key is bound to the account only.
fn machine_key_material() -> &'static [u8] {
    static MATERIAL: OnceLock<Vec<u8>> = OnceLock::new();
    MATERIAL.get_or_init(|| {
        let machine = machine_id().unwrap_or_else(|| {
            eprintln!(
                "EdgeTerm: no machine id available; credentials are bound to the user name only"
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

/// The secret map of a `Store`, kept out of the public session profiles and
/// sealed in `credentials.json`. Reads and writes serve one profile at a time;
/// `persist` writes the whole map back (see the module docs of `Store` for how
/// profiles reference their stored secrets).
pub(crate) struct CredentialStore {
    path: PathBuf,
    /// The key the map is sealed with. Derived once per process from the
    /// machine/account material and the salt stored in the file.
    key: VaultKey,
    secrets: Mutex<HashMap<String, StoredSecrets>>,
}

impl CredentialStore {
    /// Loads the vault at `path`, or starts a fresh one. A file from another
    /// machine, a damaged one, or a plain map (written before sealing existed)
    /// never blocks startup: the secrets are simply unavailable, a warning is
    /// printed, and the next save replaces the file.
    pub(crate) fn load(path: PathBuf) -> Self {
        match read_credentials_file(&path) {
            Some(CredentialsFile::Encrypted(envelope)) => match open_credentials(&envelope) {
                Ok((secrets, key)) => Self {
                    path,
                    key,
                    secrets: Mutex::new(secrets),
                },
                Err(error) => {
                    eprintln!("EdgeTerm: {error}; saved passwords are unavailable");
                    Self::empty(path)
                }
            },
            // Written before sealing existed: seal it now rather than leave
            // the clear text around until the next save.
            Some(CredentialsFile::Plain(map)) => {
                let store = Self {
                    path,
                    key: VaultKey::fresh(),
                    secrets: Mutex::new(map),
                };
                if !store.is_empty() {
                    // Best effort migration. A later explicit save will
                    // surface any filesystem error to the caller.
                    let _ = store.persist();
                }
                store
            }
            None => Self::empty(path),
        }
    }

    fn empty(path: PathBuf) -> Self {
        Self {
            path,
            key: VaultKey::fresh(),
            secrets: Mutex::new(HashMap::new()),
        }
    }

    fn is_empty(&self) -> bool {
        self.secrets.lock().is_empty()
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

    /// Seals the current map into `credentials.json`. Every write uses a fresh
    /// nonce, so two writes of the same map never look alike on disk.
    pub(crate) fn persist(&self) -> Result<()> {
        let plaintext = serde_json::to_vec(&*self.secrets.lock())?;
        let envelope = seal_credentials(&self.key, &plaintext)?;
        crate::store::write_owner_only(&self.path, &serde_json::to_string_pretty(&envelope)?)
    }
}

fn read_credentials_file(path: &Path) -> Option<CredentialsFile> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Encrypts the secret map under `key` with a fresh random nonce.
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
        kdf: VAULT_KDF.to_string(),
        cipher: VAULT_CIPHER.to_string(),
        salt: B64.encode(&key.salt),
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(&in_out),
    })
}

/// Derives this machine's key for `envelope` and decrypts the secret map. A
/// file from another machine or account fails the authentication tag.
fn open_credentials(
    envelope: &EncryptedCredentials,
) -> Result<(HashMap<String, StoredSecrets>, VaultKey)> {
    if envelope.kdf != VAULT_KDF || envelope.cipher != VAULT_CIPHER {
        return Err(AppError::new(
            "credentials.json was written by a newer EdgeTerm (unknown cipher)",
        ));
    }
    let decode = |field: &str, value: &str| {
        B64.decode(value)
            .map_err(|_| AppError::new(format!("credentials.json is corrupt: bad {field}")))
    };
    let salt = decode("salt", &envelope.salt)?;
    let nonce: [u8; VAULT_NONCE_LEN] = decode("nonce", &envelope.nonce)?
        .try_into()
        .map_err(|_| AppError::new("credentials.json is corrupt: bad nonce"))?;
    let mut in_out = decode("ciphertext", &envelope.ciphertext)?;
    let key = VaultKey::from_salt(salt);
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
        .map_err(|_| {
            AppError::new("credentials.json cannot be opened on this machine or account")
        })?;
    let secrets = serde_json::from_slice(plaintext)
        .map_err(|_| AppError::new("credentials.json is corrupt"))?;
    Ok((secrets, key))
}
