//! Local SSH keys behind the one-click public-key login: what a private key
//! file holds — type, public key, SHA-256 fingerprint — and generation of a
//! new Ed25519 key. Installing the public key on a server and verifying the
//! login build on this (`commands::keys` exposes the two steps below).
//!
//! A passphrase is an input here. Remembering one for a saved session is the
//! credential vault's job, the same as a login password (`Store::save`).

use std::convert::Infallible;
use std::io::Write;
use std::path::Path;

use ring::rand::SecureRandom;
use russh::keys::ssh_key::{self, Algorithm, LineEnding, PrivateKey};
use russh::keys::HashAlg;
use serde::Serialize;

use crate::error::{AppError, ErrorCode, Result};

/// What a private key file holds, in the form the setup dialog shows before
/// anything is installed on a server.
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeySummary {
    /// The key type as in an `authorized_keys` line, e.g. `ssh-ed25519`.
    pub key_type: String,
    /// The public key as an `authorized_keys` field: type and base64 data.
    pub public_key: String,
    /// The SHA-256 fingerprint in OpenSSH form, e.g. `SHA256:AbC…`.
    pub fingerprint: String,
    /// Whether the private key file is encrypted with a passphrase.
    pub encrypted: bool,
}

/// `ring`'s operating-system entropy source, adapted to the `rand_core`
/// traits `ssh-key` draws key material and encryption salts from. The
/// adapter is infallible by design: `ring` treats an unusable system RNG as
/// fatal, and so does this.
struct KeyRandom(ring::rand::SystemRandom);

impl KeyRandom {
    fn new() -> Self {
        KeyRandom(ring::rand::SystemRandom::new())
    }

    fn fill(&self, dst: &mut [u8]) {
        self.0.fill(dst).expect("system random number generator");
    }
}

impl ssh_key::rand_core::TryRng for KeyRandom {
    type Error = Infallible;

    fn try_next_u32(&mut self) -> std::result::Result<u32, Infallible> {
        let mut bytes = [0u8; 4];
        self.fill(&mut bytes);
        Ok(u32::from_le_bytes(bytes))
    }

    fn try_next_u64(&mut self) -> std::result::Result<u64, Infallible> {
        let mut bytes = [0u8; 8];
        self.fill(&mut bytes);
        Ok(u64::from_le_bytes(bytes))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> std::result::Result<(), Infallible> {
        self.fill(dst);
        Ok(())
    }
}

impl ssh_key::rand_core::TryCryptoRng for KeyRandom {}

/// Reads the private key file at `path`, decrypting it with `passphrase`
/// when it is encrypted. The flag says whether a passphrase was needed.
pub(crate) fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<(PrivateKey, bool)> {
    let pem = std::fs::read(path).map_err(|error| {
        AppError::from_io(format!("cannot read the private key {path}"), &error)
    })?;
    let key = PrivateKey::from_openssh(&pem).map_err(|error| {
        AppError::coded(
            ErrorCode::InvalidInput,
            format!("cannot read the private key {path}: {error}"),
        )
    })?;
    if !key.is_encrypted() {
        return Ok((key, false));
    }
    let passphrase = passphrase
        .filter(|passphrase| !passphrase.is_empty())
        .ok_or_else(|| {
            AppError::coded(
                ErrorCode::InvalidInput,
                format!("the private key {path} is encrypted; enter its passphrase"),
            )
        })?;
    let key = key.decrypt(passphrase).map_err(|error| {
        AppError::coded(
            ErrorCode::InvalidInput,
            format!("cannot decrypt the private key {path}; the passphrase is wrong or the file is damaged: {error}"),
        )
    })?;
    Ok((key, true))
}

/// Reads and summarizes `path`; the dialog shows the result before anything
/// is installed.
pub(crate) fn inspect_private_key(path: &str, passphrase: Option<&str>) -> Result<KeySummary> {
    let (key, encrypted) = load_private_key(path, passphrase)?;
    summarize(&key, encrypted)
}

/// Generates a new Ed25519 key at `path`. The file must not exist and is
/// written with owner-only permissions; an optional passphrase encrypts it.
pub(crate) fn generate_private_key(path: &str, passphrase: Option<&str>) -> Result<KeySummary> {
    let passphrase = passphrase.filter(|passphrase| !passphrase.is_empty());
    let mut rng = KeyRandom::new();
    let key = PrivateKey::random(&mut rng, Algorithm::Ed25519)
        .map_err(|error| AppError::new(format!("cannot generate an Ed25519 key: {error}")))?;
    let key = match passphrase {
        Some(passphrase) => key.encrypt(&mut rng, passphrase).map_err(|error| {
            AppError::new(format!("cannot encrypt the new private key: {error}"))
        })?,
        None => key,
    };
    let pem = key
        .to_openssh(LineEnding::LF)
        .map_err(|error| AppError::new(format!("cannot encode the new private key: {error}")))?;
    write_new_owner_only(Path::new(path), pem.as_bytes())?;
    summarize(&key, passphrase.is_some())
}

/// Writes a brand-new file with owner-only permissions. An existing file is
/// never touched: generating a key must not replace one the user already
/// has.
fn write_new_owner_only(path: &Path, contents: &[u8]) -> Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::coded(
                ErrorCode::InvalidInput,
                format!(
                    "{} already exists; refusing to overwrite it",
                    path.display()
                ),
            )
        } else {
            AppError::from_io(format!("cannot create {}", path.display()), &error)
        }
    })?;
    file.write_all(contents)
        .map_err(|error| AppError::from_io(format!("cannot write {}", path.display()), &error))?;
    file.sync_all()
        .map_err(|error| AppError::from_io(format!("cannot write {}", path.display()), &error))?;
    crate::store::restrict_permissions(path);
    Ok(())
}

/// The dialog's view of a loaded key.
fn summarize(key: &PrivateKey, encrypted: bool) -> Result<KeySummary> {
    let public = key.public_key();
    Ok(KeySummary {
        key_type: public.algorithm().as_str().to_string(),
        public_key: public
            .to_openssh()
            .map_err(|error| AppError::new(format!("cannot encode the public key: {error}")))?,
        fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        encrypted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("edgeterm-ssh-keys-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn a_generated_key_is_ed25519_with_a_sha256_fingerprint_and_owner_only() {
        let dir = temp_dir("generate");
        let path = dir.join("id_ed25519");
        let path = path.to_string_lossy().into_owned();

        let summary = generate_private_key(&path, None).expect("generate");
        assert_eq!(summary.key_type, "ssh-ed25519");
        assert!(summary.public_key.starts_with("ssh-ed25519 "));
        assert!(
            summary.fingerprint.starts_with("SHA256:"),
            "fingerprints are shown in OpenSSH SHA-256 form: {}",
            summary.fingerprint
        );
        assert!(!summary.encrypted);

        let pem = std::fs::read_to_string(&path).expect("key file");
        assert!(pem.contains("BEGIN OPENSSH PRIVATE KEY"));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path)
                .expect("metadata")
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "a private key must be owner-only");
        }

        // The public line must parse as one, and inspection must agree with
        // what generation reported.
        russh::keys::PublicKey::from_openssh(&summary.public_key).expect("the line must parse");
        let inspected = inspect_private_key(&path, None).expect("inspect");
        assert_eq!(inspected, summary);

        // Two generated keys are distinct.
        let other = dir.join("id_other");
        let other = generate_private_key(&other.to_string_lossy(), None).expect("generate");
        assert_ne!(other.fingerprint, summary.fingerprint);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn generation_refuses_to_replace_an_existing_file() {
        let dir = temp_dir("no-overwrite");
        let path = dir.join("id_ed25519");
        std::fs::write(&path, "keep me").expect("stage file");
        let path = path.to_string_lossy().into_owned();

        let error = generate_private_key(&path, None).expect_err("must not overwrite");
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.to_string().contains("already exists"));
        assert_eq!(std::fs::read_to_string(&path).expect("file"), "keep me");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_encrypted_key_needs_the_right_passphrase() {
        let dir = temp_dir("passphrase");
        let path = dir.join("id_ed25519");
        let path = path.to_string_lossy().into_owned();

        let summary = generate_private_key(&path, Some("s3cret")).expect("generate");
        assert!(summary.encrypted);
        assert_eq!(
            inspect_private_key(&path, None)
                .expect_err("no passphrase")
                .code,
            ErrorCode::InvalidInput
        );
        let error = inspect_private_key(&path, Some("wrong")).expect_err("wrong passphrase");
        assert_eq!(error.code, ErrorCode::InvalidInput);

        let opened = inspect_private_key(&path, Some("s3cret")).expect("inspect");
        assert_eq!(opened.public_key, summary.public_key);
        assert!(opened.encrypted);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unreadable_keys_are_reported_as_invalid_input() {
        let dir = temp_dir("unreadable");
        let missing = dir.join("nope");
        let error = inspect_private_key(&missing.to_string_lossy(), None).expect_err("missing");
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.to_string().contains("cannot read the private key"));

        let corrupt = dir.join("id_ed25519");
        std::fs::write(&corrupt, "not a key").expect("stage file");
        let error = inspect_private_key(&corrupt.to_string_lossy(), None).expect_err("corrupt");
        assert_eq!(error.code, ErrorCode::InvalidInput);
        assert!(error.to_string().contains("cannot read the private key"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
