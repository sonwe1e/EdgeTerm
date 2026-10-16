use super::*;

pub(super) fn merge_secrets(mut saved: SessionProfile, incoming: SessionProfile) -> SessionProfile {
    if incoming.password.is_some() {
        saved.password = incoming.password;
    }
    if incoming.passphrase.is_some() {
        saved.passphrase = incoming.passphrase;
    }
    saved
}

pub(super) fn expect_listing(response: SftpResponse) -> Result<DirListing> {
    match response {
        SftpResponse::Listing(listing) => Ok(listing),
        _ => Err(AppError::new("unexpected sftp response")),
    }
}

pub(super) fn expect_path(response: SftpResponse) -> Result<String> {
    match response {
        SftpResponse::Path(path) => Ok(path),
        _ => Err(AppError::new("unexpected sftp response")),
    }
}
