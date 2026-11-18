use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::credentials::{
    system_key_store, CredentialStore, CredentialStoreStatus, KeyStore, StoredSecrets,
};
use crate::error::{AppError, Result};
use crate::model::{
    AppData, AuthKind, CommandHistoryEntry, CommandScope, DataSummary, SavedCommand, SessionGroup,
    SessionKind, SessionProfile, Theme, APP_DATA_APP, APP_DATA_EXTENSION, APP_DATA_FORMAT,
    MAX_JUMP_HOPS,
};

const MAX_SAVED_COMMANDS: usize = 1000;
const MAX_COMMAND_HISTORY: usize = 5000;
const MAX_HISTORY_COMMAND_LEN: usize = 500;

/// Session profiles, remembered SSH/SFTP/FTP credentials, and Sender commands persisted
/// in the application config directory.
///
/// `sessions.json` never contains credentials and is safe to return to the UI.
/// `credentials.json` is readable only by the current OS user and is sealed
/// with ChaCha20-Poly1305 under a random master key kept in the OS credential
/// store (Windows Credential Manager, macOS Keychain, the Linux Secret
/// Service). A portable copy, or a machine without a reachable credential
/// store, keeps secrets for the run only and writes nothing to disk. The
/// credential file is consulted solely while opening a saved session.
/// `session_groups.json` holds the user-defined folders of the Session panel;
/// it is a separate file so older builds keep reading `sessions.json` as a
/// plain profile list.
/// `sender_commands.json` keeps reusable Sender tags across restarts and upgrades.
/// `command_history.json` remembers executed commands for inline suggestions;
/// like credentials it may contain sensitive text, so it is owner-only too.
pub struct Store {
    path: PathBuf,
    groups_path: PathBuf,
    sender_commands_path: PathBuf,
    command_history_path: PathBuf,
    profiles: Mutex<Vec<SessionProfile>>,
    profiles_load_error: Option<AppError>,
    credentials: CredentialStore,
    groups: Mutex<Vec<SessionGroup>>,
    sender_commands: Mutex<Vec<SavedCommand>>,
    command_history: Mutex<Vec<CommandHistoryEntry>>,
}

impl Store {
    pub fn load() -> Self {
        // A portable copy travels between machines: the OS credential store
        // of whatever machine it happens to run on is meaningless for it, so
        // secrets are kept for the run only (see `CredentialStore`).
        if portable_data_dir().is_some() {
            Self::load_with(config_path(), None)
        } else {
            Self::load_from(config_path())
        }
    }

    pub fn load_from(path: PathBuf) -> Self {
        Self::load_with(path, Some(system_key_store()))
    }

    /// The test counterpart of `load_from`: a process-local key store keyed
    /// by the credentials path, so `cargo test` never touches (or needs) the
    /// real OS credential store.
    #[cfg(test)]
    pub(crate) fn load_from_test(path: PathBuf) -> Self {
        let key_store = crate::credentials::test_support::key_store(&credentials_path_for(&path));
        Self::load_with(path, Some(key_store))
    }

    /// `key_store` is the OS credential store, or `None` in portable mode;
    /// tests pass a process-local store so `cargo test` never touches the
    /// real credential store (see `load_from_test`).
    pub(crate) fn load_with(path: PathBuf, key_store: Option<Arc<dyn KeyStore>>) -> Self {
        let (mut profiles, profiles_load_error) = match std::fs::read_to_string(&path) {
            Ok(raw) => match serde_json::from_str::<Vec<SessionProfile>>(&raw) {
                Ok(profiles) => (profiles, None),
                Err(_) => (Vec::new(), Some(profiles_read_error(&path))),
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (Vec::new(), None),
            Err(_) => (Vec::new(), Some(profiles_read_error(&path))),
        };
        let credentials = CredentialStore::load(credentials_path_for(&path), key_store.as_deref());
        let groups_path = groups_path_for(&path);
        let groups = read_json(&groups_path).unwrap_or_default();
        let sender_commands_path = sender_commands_path_for(&path);
        let sender_commands = read_json(&sender_commands_path).unwrap_or_default();
        let command_history_path = command_history_path_for(&path);
        let command_history = read_json(&command_history_path).unwrap_or_default();
        // Older files may have contained credentials. Move them into the
        // private credential map when loading, then keep the UI copy redacted.
        let mut imported_legacy_credentials = false;
        for profile in &mut profiles {
            if profile.password.is_some() || profile.passphrase.is_some() {
                let secrets = StoredSecrets {
                    password: profile.password.take(),
                    passphrase: profile.passphrase.take(),
                };
                credentials.write(&profile.id, secrets);
                imported_legacy_credentials = true;
            }
            profile.password = None;
            profile.passphrase = None;
        }

        let store = Store {
            path,
            groups_path,
            sender_commands_path,
            command_history_path,
            profiles: Mutex::new(profiles),
            profiles_load_error,
            credentials,
            groups: Mutex::new(groups),
            sender_commands: Mutex::new(sender_commands),
            command_history: Mutex::new(command_history),
        };
        if imported_legacy_credentials && store.credentials.writes_to_disk() {
            // The profiles file is only rewritten without its embedded
            // passwords once the vault holds them: `persist` writes the
            // credentials file first and verifies it, and on any failure
            // stops before `sessions.json` is touched — the embedded copies
            // stay the durable ones and the next launch retries. Without a
            // writable vault the whole disk is left exactly as it is and the
            // passwords serve this run from memory.
            if let Err(error) = store.persist() {
                tracing::warn!(
                    "EdgeTerm: legacy passwords were not moved into the credential vault ({error}); {} still carries them",
                    store.path.display()
                );
            }
        }
        store
    }

    pub fn list(&self) -> Vec<SessionProfile> {
        self.profiles.lock().clone()
    }

    /// A missing file is a first launch; an existing unreadable file must
    /// survive for recovery. Refuse before changing memory or any other file.
    pub fn require_readable_profiles(&self) -> Result<()> {
        match &self.profiles_load_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    /// Whether saved passwords survive a restart right now, and why not when
    /// they do not; see `credential_store_status`.
    pub fn credential_store_status(&self) -> CredentialStoreStatus {
        self.credentials.status()
    }

    pub fn get(&self, id: &str) -> Result<Option<SessionProfile>> {
        let profile = self.profiles.lock().iter().find(|p| p.id == id).cloned();
        Ok(profile.map(|mut profile| {
            if let Some(stored) = self.credentials.read(id) {
                if matches!(profile.kind, SessionKind::Ftp | SessionKind::Telnet) {
                    profile.password = stored.password.clone();
                } else {
                    match profile.auth.unwrap_or_default() {
                        AuthKind::Password => profile.password = stored.password.clone(),
                        AuthKind::PublicKey => profile.passphrase = stored.passphrase.clone(),
                        AuthKind::Agent => {}
                    }
                }
            }
            profile
        }))
    }

    /// The jump hosts `profile` is tunnelled through, first hop first, each
    /// carrying its stored credentials. Follows `jump_profile_id` outward from
    /// the profile until a session with no jump host is reached. A jump
    /// session that no longer exists, is not an SSH transport, or leads round
    /// in a circle is an error: silently connecting directly instead could
    /// reach a different machine of the same name on another network.
    pub fn jump_chain(&self, profile: &SessionProfile) -> Result<Vec<SessionProfile>> {
        let mut hops = Vec::new();
        let mut visited = HashSet::new();
        if !profile.id.is_empty() {
            visited.insert(profile.id.clone());
        }
        let mut next = profile.jump_profile_id.clone();
        while let Some(id) = next {
            if !visited.insert(id.clone()) {
                return Err(AppError::new("the jump host chain loops back on itself"));
            }
            if hops.len() == MAX_JUMP_HOPS {
                return Err(AppError::new(format!(
                    "the jump host chain is longer than {MAX_JUMP_HOPS} hops"
                )));
            }
            let hop = self
                .get(&id)?
                .ok_or_else(|| AppError::new("the jump host session no longer exists"))?;
            if !hop.is_ssh_transport() {
                return Err(AppError::new(format!(
                    "the jump host session \"{}\" is not an SSH session",
                    hop.name
                )));
            }
            next = hop.jump_profile_id.clone();
            hops.push(hop);
        }
        hops.reverse();
        Ok(hops)
    }

    pub fn save(&self, mut profile: SessionProfile) -> Result<SessionProfile> {
        self.require_readable_profiles()?;
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        // Switching between Telnet and the encrypted protocols in the editor
        // keeps the id, and with it the stored password. An SSH password
        // must not start going out in clear to a telnet prompt, nor a telnet
        // device's password to an SSH server, unless it is typed again.
        let switched = self
            .profiles
            .lock()
            .iter()
            .find(|p| p.id == profile.id)
            .is_some_and(|p| {
                (p.kind == SessionKind::Telnet) != (profile.kind == SessionKind::Telnet)
            });
        if switched {
            self.credentials.remove(&profile.id);
        }
        self.credentials.sync(&profile)?;
        profile.password = None;
        profile.passphrase = None;

        // A jump host is another saved SSH transport. A reference that points
        // nowhere (the jump session was deleted, or the kind was switched away
        // from SSH in the editor) is dropped like a stale group id; a chain
        // that would loop back through this profile is refused outright.
        if let Some(jump_id) = profile.jump_profile_id.clone() {
            let exists = self
                .profiles
                .lock()
                .iter()
                .any(|p| p.id == jump_id && p.is_ssh_transport());
            if jump_id.is_empty() || !exists || !profile.is_ssh_transport() {
                profile.jump_profile_id = None;
            } else {
                self.jump_chain(&profile)?;
            }
        }

        // A stale or foreign group id (deleted group, category switched in the
        // editor) must not strand the profile: fall back to the section root.
        if let Some(group_id) = &profile.group_id {
            let valid = self.groups.lock().iter().any(|group| {
                &group.id == group_id && same_group_category(group.kind, profile.kind)
            });
            if !valid {
                profile.group_id = None;
            }
        }

        {
            let mut profiles = self.profiles.lock();
            match profiles.iter_mut().find(|p| p.id == profile.id) {
                Some(existing) => *existing = profile.clone(),
                None => profiles.push(profile.clone()),
            }
        }
        self.persist()?;
        Ok(profile)
    }

    /// Saves a copy of a profile under a new id and a free "(copy)" name,
    /// listed right after the original. Its stored password / passphrase is
    /// copied here because the webview never sees them; the Sender commands
    /// scoped to the original stay with the original.
    pub fn duplicate(&self, id: &str) -> Result<SessionProfile> {
        self.require_readable_profiles()?;
        let copy = {
            let mut profiles = self.profiles.lock();
            let index = profiles
                .iter()
                .position(|p| p.id == id)
                .ok_or_else(|| AppError::new("the session no longer exists"))?;
            let mut copy = profiles[index].clone();
            copy.id = uuid::Uuid::new_v4().to_string();
            copy.name = copy_name(&copy.name, |name| profiles.iter().any(|p| p.name == name));
            profiles.insert(index + 1, copy.clone());
            copy
        };
        if let Some(secrets) = self.credentials.read(id) {
            self.credentials.write(&copy.id, secrets);
        }
        self.persist()?;
        Ok(copy)
    }

    /// Removes a profile together with everything that belongs to it: its
    /// stored credentials and the Sender commands scoped to it alone.
    pub fn delete(&self, id: &str) -> Result<()> {
        self.require_readable_profiles()?;
        self.credentials.remove(id);
        self.profiles.lock().retain(|p| p.id != id);
        self.persist()?;

        let removed_commands = {
            let mut commands = self.sender_commands.lock();
            let before = commands.len();
            commands.retain(
                |command| !matches!(&command.scope, CommandScope::Profile { id: scoped } if scoped == id),
            );
            commands.len() != before
        };
        if removed_commands {
            self.persist_sender_commands()?;
        }
        Ok(())
    }

    pub fn list_groups(&self) -> Vec<SessionGroup> {
        self.groups.lock().clone()
    }

    /// Creates or renames / re-parents a group. The parent must be an
    /// existing group of the same kind and must not be the group itself or
    /// one of its descendants, so the tree can never form a cycle.
    pub fn save_group(&self, mut group: SessionGroup) -> Result<SessionGroup> {
        group.name = group.name.trim().to_string();
        if group.name.is_empty() {
            return Err(AppError::new("group name cannot be empty"));
        }
        if group.id.is_empty() {
            group.id = uuid::Uuid::new_v4().to_string();
        }
        if group.parent_id.as_deref() == Some("") {
            group.parent_id = None;
        }

        {
            let mut groups = self.groups.lock();
            if let Some(existing) = groups.iter().find(|g| g.id == group.id) {
                if !same_group_category(existing.kind, group.kind) {
                    return Err(AppError::new("a group cannot change its session kind"));
                }
            }
            if let Some(parent_id) = &group.parent_id {
                if *parent_id == group.id {
                    return Err(AppError::new("a group cannot contain itself"));
                }
                match groups.iter().find(|g| &g.id == parent_id) {
                    None => return Err(AppError::new("parent group does not exist")),
                    Some(parent) if !same_group_category(parent.kind, group.kind) => {
                        return Err(AppError::new(
                            "a group can only be nested under a group of the same session kind",
                        ))
                    }
                    Some(_) => {}
                }
                if subtree_ids(&groups, &group.id).contains(parent_id) {
                    return Err(AppError::new(
                        "a group cannot be moved into one of its own subgroups",
                    ));
                }
            }
            match groups.iter_mut().find(|g| g.id == group.id) {
                Some(existing) => *existing = group.clone(),
                None => groups.push(group.clone()),
            }
        }
        self.persist_groups()?;
        Ok(group)
    }

    /// Removes a group with everything in it: the groups nested below it,
    /// the profiles in any of them (with their credentials) and the Sender
    /// commands scoped to any of those groups or profiles.
    pub fn delete_group(&self, id: &str) -> Result<()> {
        self.require_readable_profiles()?;
        let removed_groups = {
            let mut groups = self.groups.lock();
            if !groups.iter().any(|g| g.id == id) {
                return Ok(());
            }
            let removed = subtree_ids(&groups, id);
            groups.retain(|g| !removed.contains(&g.id));
            removed
        };
        self.persist_groups()?;

        let removed_profiles: Vec<String> = {
            let mut profiles = self.profiles.lock();
            let removed: Vec<String> = profiles
                .iter()
                .filter(|p| {
                    p.group_id
                        .as_ref()
                        .is_some_and(|group_id| removed_groups.contains(group_id))
                })
                .map(|p| p.id.clone())
                .collect();
            profiles.retain(|p| !removed.contains(&p.id));
            removed
        };
        if !removed_profiles.is_empty() {
            for profile_id in &removed_profiles {
                self.credentials.remove(profile_id);
            }
            self.persist()?;
        }

        let removed_commands = {
            let mut commands = self.sender_commands.lock();
            let before = commands.len();
            commands.retain(|command| match &command.scope {
                CommandScope::Group { id } => !removed_groups.contains(id),
                CommandScope::Profile { id } => !removed_profiles.contains(id),
                CommandScope::Global | CommandScope::Kind { .. } => true,
            });
            commands.len() != before
        };
        if removed_commands {
            self.persist_sender_commands()?;
        }
        Ok(())
    }

    pub fn list_sender_commands(&self) -> Vec<SavedCommand> {
        self.sender_commands.lock().clone()
    }

    /// Creates or updates a Sender command. A scope pointing at a group or
    /// profile that does not exist falls back to `Global`, the one level that
    /// always exists.
    pub fn save_sender_command(&self, mut command: SavedCommand) -> Result<SavedCommand> {
        if command.id.is_empty() {
            command.id = uuid::Uuid::new_v4().to_string();
        }
        command.scope = self.resolve_scope(command.scope);

        {
            let mut commands = self.sender_commands.lock();
            if let Some(index) = commands.iter().position(|saved| saved.id == command.id) {
                commands[index] = command.clone();
            } else if commands.len() < MAX_SAVED_COMMANDS {
                commands.push(command.clone());
            } else {
                return Err(AppError::new(format!(
                    "saved command limit is {MAX_SAVED_COMMANDS}"
                )));
            }
        }
        self.persist_sender_commands()?;
        Ok(command)
    }

    pub fn delete_sender_command(&self, id: &str) -> Result<()> {
        self.sender_commands
            .lock()
            .retain(|command| command.id != id);
        self.persist_sender_commands()
    }

    fn resolve_scope(&self, scope: CommandScope) -> CommandScope {
        let exists = match &scope {
            CommandScope::Global | CommandScope::Kind { .. } => true,
            CommandScope::Group { id } => self.groups.lock().iter().any(|g| &g.id == id),
            CommandScope::Profile { id } => self.profiles.lock().iter().any(|p| &p.id == id),
        };
        if exists {
            scope
        } else {
            CommandScope::Global
        }
    }

    pub fn list_command_history(&self) -> Vec<CommandHistoryEntry> {
        self.command_history.lock().clone()
    }

    pub fn record_command(&self, command: &str, host: &str) -> Result<()> {
        let command = command.trim_end();
        if command.is_empty() || command.len() > MAX_HISTORY_COMMAND_LEN {
            return Ok(());
        }
        {
            let mut entries = self.command_history.lock();
            let existing = entries
                .iter_mut()
                .find(|entry| entry.command == command && entry.host == host);
            match existing {
                Some(entry) => {
                    entry.count = entry.count.saturating_add(1);
                    entry.last_used = unix_millis();
                }
                None => {
                    entries.push(CommandHistoryEntry {
                        command: command.to_string(),
                        host: host.to_string(),
                        count: 1,
                        last_used: unix_millis(),
                    });
                    if entries.len() > MAX_COMMAND_HISTORY {
                        // Evict the least recently used entry, not the oldest
                        // insertion: a daily-driver command must never fall out
                        // just because it was learned early.
                        if let Some(oldest) = entries
                            .iter()
                            .enumerate()
                            .min_by_key(|(_, entry)| entry.last_used)
                            .map(|(index, _)| index)
                        {
                            entries.remove(oldest);
                        }
                    }
                }
            }
        }
        self.persist_command_history()
    }

    /// Forgets `command` on every host: suggestions are deduplicated by text,
    /// so leaving another host's copy would bring the row straight back.
    pub fn delete_command_history(&self, command: &str) -> Result<()> {
        {
            let mut entries = self.command_history.lock();
            let before = entries.len();
            entries.retain(|entry| entry.command != command);
            if entries.len() == before {
                return Ok(());
            }
        }
        self.persist_command_history()
    }

    pub fn clear_command_history(&self) -> Result<()> {
        self.command_history.lock().clear();
        self.persist_command_history()
    }

    /// Everything the backend contributes to a data export: saved sessions,
    /// their groups and Sender tags. Profiles are already credential-free in
    /// memory; `redact_profile` guards against that ever changing. The
    /// caller fills in the frontend's settings and the timestamp.
    pub fn snapshot(&self) -> AppData {
        AppData {
            app: APP_DATA_APP.to_string(),
            format: APP_DATA_FORMAT,
            exported_at: None,
            settings: None,
            profiles: self
                .profiles
                .lock()
                .iter()
                .cloned()
                .map(redact_profile)
                .collect(),
            groups: self.groups.lock().clone(),
            sender_commands: self.sender_commands.lock().clone(),
        }
    }

    /// Writes the configuration the import is about to replace into a data file
    /// beside the configuration, and keeps the newest few. An import overwrites
    /// same-id entries with no undo, and the file that would restore them exists
    /// only if the user thought to export beforehand.
    fn back_up_before_import(&self) -> Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;
        let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S");
        let backup = parent.join(format!("import-backup-{stamp}.{APP_DATA_EXTENSION}"));
        let mut data = self.snapshot();
        data.exported_at = Some(chrono::Local::now().to_rfc3339());
        write_owner_only(&backup, &serde_json::to_string_pretty(&data)?)?;
        self.prune_import_backups(parent, 5);
        Ok(())
    }

    /// Keeps the newest `keep` import backups so a long-lived install does not
    /// fill its configuration directory with them.
    fn prune_import_backups(&self, parent: &Path, keep: usize) {
        let Ok(entries) = std::fs::read_dir(parent) else {
            return;
        };
        let mut backups: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("import-backup-"))
            })
            .collect();
        // The stamp sorts lexicographically, so the newest are the last.
        backups.sort();
        for stale in backups.iter().rev().skip(keep) {
            let _ = std::fs::remove_file(stale);
        }
    }

    /// Merges an exported file into the store. Entries are matched by id: a
    /// known id replaces the local entry, everything else is added, and
    /// nothing local is deleted. Credentials in the file are ignored — an
    /// export never carries any, so a value here was hand-written — and
    /// `credentials.json` keeps what it holds for a replaced profile as long as
    /// that profile still names the same endpoint; a replacement that changes
    /// the host, user, port, protocol or auth method drops it, so the stored
    /// secret cannot be sent somewhere it was never typed for. Group parents and profile group ids that point nowhere, to a
    /// group of another kind or around a cycle are detached so the Session
    /// panel tree stays finite.
    pub fn import_data(&self, data: AppData) -> Result<DataSummary> {
        self.require_readable_profiles()?;
        validate_app_data(&data)?;
        let mut summary = DataSummary::default();

        // The merge below changes the running state and reaches the disk in
        // three files. Today the merge happened first and the writes after it,
        // so a write that failed left the app holding data it had just reported
        // as not imported — and the next save wrote that half-import over the
        // real configuration. Keep the three lists so a failed write can put
        // them back.
        self.back_up_before_import()?;
        let groups_before = self.groups.lock().clone();
        let profiles_before = self.profiles.lock().clone();
        let commands_before = self.sender_commands.lock().clone();
        // Credential drops are part of committing, not of merging: a file that
        // never lands must not take the passwords with it.
        let mut dropped_credentials: Vec<String> = Vec::new();

        {
            let mut groups = self.groups.lock();
            for mut group in data.groups {
                group.name = group.name.trim().to_string();
                if group.name.is_empty() {
                    continue;
                }
                if group.id.is_empty() {
                    group.id = uuid::Uuid::new_v4().to_string();
                }
                if group.parent_id.as_deref() == Some("") {
                    group.parent_id = None;
                }
                match groups.iter_mut().find(|g| g.id == group.id) {
                    // A group cannot change category: its profiles would no
                    // longer belong under it.
                    Some(existing) if !same_group_category(existing.kind, group.kind) => continue,
                    Some(existing) => *existing = group,
                    None => groups.push(group),
                }
                summary.groups += 1;
            }
            detach_invalid_parents(&mut groups);
        }

        {
            let groups = self.groups.lock().clone();
            let mut profiles = self.profiles.lock();
            for profile in data.profiles {
                let mut profile = redact_profile(profile);
                if profile.id.is_empty() {
                    profile.id = uuid::Uuid::new_v4().to_string();
                }
                if let Some(group_id) = &profile.group_id {
                    let valid = groups.iter().any(|group| {
                        &group.id == group_id && same_group_category(group.kind, profile.kind)
                    });
                    if !valid {
                        profile.group_id = None;
                    }
                }
                match profiles.iter_mut().find(|p| p.id == profile.id) {
                    Some(existing) => {
                        // The file never carries a secret, so whatever the vault
                        // holds was typed for the definition being replaced. If
                        // that definition now names another host, user or
                        // protocol, the secret must not follow it: an SSH
                        // password would otherwise be sent to a telnet prompt,
                        // or to a host nobody typed it for.
                        let moved = names_another_endpoint(existing, &profile);
                        if moved {
                            dropped_credentials.push(existing.id.clone());
                        }
                        *existing = profile;
                    }
                    None => profiles.push(profile),
                }
                summary.profiles += 1;
            }
        }

        {
            // Groups and profiles are in place by now, so a scope can be
            // checked against the merged lists.
            let resolved: Vec<SavedCommand> = data
                .sender_commands
                .into_iter()
                .map(|mut command| {
                    command.scope = self.resolve_scope(command.scope);
                    command
                })
                .collect();
            let mut commands = self.sender_commands.lock();
            for mut command in resolved {
                if command.id.is_empty() {
                    command.id = uuid::Uuid::new_v4().to_string();
                }
                if let Some(index) = commands.iter().position(|saved| saved.id == command.id) {
                    commands[index] = command;
                } else if commands.len() < MAX_SAVED_COMMANDS {
                    commands.push(command);
                } else {
                    summary.skipped_sender_commands += 1;
                    continue;
                }
                summary.sender_commands += 1;
            }
        }

        let written = self
            .persist_groups()
            .and_then(|()| self.persist())
            .and_then(|()| self.persist_sender_commands());
        if let Err(error) = written {
            *self.groups.lock() = groups_before;
            *self.profiles.lock() = profiles_before;
            *self.sender_commands.lock() = commands_before;
            return Err(error);
        }
        for id in dropped_credentials {
            self.credentials.remove(&id);
        }
        Ok(summary)
    }

    // --- persistence ----------------------------------------------------------

    fn persist(&self) -> Result<()> {
        self.require_readable_profiles()?;
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        // Credentials first: `load_from` drops the embedded passwords from
        // the profiles file only when the vault write has succeeded, so the
        // vault must not be the write that happens after (and depends on)
        // the profiles write. A failing vault write then leaves every other
        // file untouched too.
        self.credentials.persist()?;
        let profiles = serde_json::to_string_pretty(&*self.profiles.lock())?;
        write_owner_only(&self.path, &profiles)
    }

    fn persist_groups(&self) -> Result<()> {
        let parent = self
            .groups_path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        let groups = serde_json::to_string_pretty(&*self.groups.lock())?;
        write_owner_only(&self.groups_path, &groups)
    }

    fn persist_sender_commands(&self) -> Result<()> {
        let parent = self
            .sender_commands_path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        let commands = serde_json::to_string_pretty(&*self.sender_commands.lock())?;
        write_owner_only(&self.sender_commands_path, &commands)
    }

    fn persist_command_history(&self) -> Result<()> {
        let parent = self
            .command_history_path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        // Compact JSON: unlike the other stores this file is rewritten on
        // every executed command, so keep the write as small as possible.
        let entries = serde_json::to_string(&*self.command_history.lock())?;
        write_owner_only(&self.command_history_path, &entries)
    }
}

/// `appearance.json`: the little the window has to know before the webview
/// exists. Every other front-end setting lives in the webview's localStorage,
/// which nothing can read until the webview is up — and until the page paints,
/// the window shows the colour it was created with.
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Appearance {
    #[serde(default)]
    theme: Theme,
    /// The main window's size when it last changed, so the next launch opens
    /// at it (`window_state`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    window: Option<WindowGeometry>,
}

/// The main window's size, in the logical pixels `tauri.conf.json` measures
/// it in, so a display with another scale factor gets the same apparent size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub width: u32,
    pub height: u32,
    /// Whether the window was maximized; `width` and `height` are then the
    /// size it restores to.
    #[serde(default)]
    pub maximized: bool,
}

/// Serializes the read-modify-write of `appearance.json`: the theme arrives
/// from an IPC command, the window size from its own writer thread.
static APPEARANCE_LOCK: Mutex<()> = Mutex::new(());

/// The theme the front end last applied, dark until it has said otherwise.
/// The window is created in this theme's background colour, so a light-theme
/// user no longer watches a dark window while the webview starts (issue #35).
pub fn startup_theme() -> Theme {
    startup_theme_at(&appearance_path_for(&config_path()))
}

/// Remembers the theme for the next launch.
pub fn save_startup_theme(theme: Theme) -> Result<()> {
    save_startup_theme_at(&appearance_path_for(&config_path()), theme)
}

/// The size the main window last had, if a launch has recorded one.
pub fn startup_window() -> Option<WindowGeometry> {
    startup_window_at(&appearance_path_for(&config_path()))
}

/// Remembers the main window's size for the next launch.
pub fn save_window_geometry(window: WindowGeometry) -> Result<()> {
    save_window_geometry_at(&appearance_path_for(&config_path()), window)
}

pub(crate) fn startup_theme_at(path: &Path) -> Theme {
    read_appearance(path).theme
}

pub(crate) fn save_startup_theme_at(path: &Path, theme: Theme) -> Result<()> {
    let _guard = APPEARANCE_LOCK.lock();
    let mut appearance = read_appearance(path);
    // The front end applies its theme on every start, not only when it
    // changes, so the usual call has nothing to write.
    if appearance.theme == theme {
        return Ok(());
    }
    appearance.theme = theme;
    write_appearance(path, &appearance)
}

pub(crate) fn startup_window_at(path: &Path) -> Option<WindowGeometry> {
    read_appearance(path)
        .window
        .filter(|window| window.width > 0 && window.height > 0)
}

pub(crate) fn save_window_geometry_at(path: &Path, window: WindowGeometry) -> Result<()> {
    let _guard = APPEARANCE_LOCK.lock();
    let mut appearance = read_appearance(path);
    // Every launch reports the size it was created at, which is this one.
    if appearance.window == Some(window) {
        return Ok(());
    }
    appearance.window = Some(window);
    write_appearance(path, &appearance)
}

/// A missing or damaged file means the defaults: dark, and no size to restore.
fn read_appearance(path: &Path) -> Appearance {
    read_json(path).unwrap_or_default()
}

fn write_appearance(path: &Path, appearance: &Appearance) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::new("config directory has no parent"))?;
    std::fs::create_dir_all(parent)?;
    write_owner_only(path, &serde_json::to_string_pretty(appearance)?)
}

/// Whether `path` carries the data-file extension (`.edgeterm`, any case).
pub fn is_data_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(APP_DATA_EXTENSION))
}

/// Refuses files that are not EdgeTerm exports or come from a newer layout.
pub fn validate_app_data(data: &AppData) -> Result<()> {
    if data.app != APP_DATA_APP {
        return Err(AppError::new("not an EdgeTerm data file"));
    }
    if data.format == 0 {
        return Err(AppError::new("not an EdgeTerm data file: missing format"));
    }
    if data.format > APP_DATA_FORMAT {
        return Err(AppError::new(format!(
            "this data file was written by a newer EdgeTerm (format {} > {})",
            data.format, APP_DATA_FORMAT
        )));
    }
    Ok(())
}

/// "web (copy)", then "web (copy 2)", … — the first that `taken` refuses.
/// Copying a copy counts on from the original's name instead of stacking
/// another "(copy)".
fn copy_name(name: &str, taken: impl Fn(&str) -> bool) -> String {
    let base = name
        .strip_suffix(')')
        .and_then(|rest| rest.rsplit_once(" (copy"))
        .filter(|(_, n)| {
            n.is_empty()
                || n.strip_prefix(' ')
                    .is_some_and(|n| n.parse::<u32>().is_ok())
        })
        .map_or(name, |(base, _)| base);
    (1..)
        .map(|n| match n {
            1 => format!("{base} (copy)"),
            n => format!("{base} (copy {n})"),
        })
        .find(|candidate| !taken(candidate))
        .expect("an unbounded range always has a free name")
}

/// Strips the secrets a profile may carry; every profile that leaves the
/// store in an export, or enters it from an import, passes through here.
pub fn redact_profile(mut profile: SessionProfile) -> SessionProfile {
    profile.password = None;
    profile.passphrase = None;
    profile
}

/// The grouping namespace a session kind belongs to. FTP and SFTP are both
/// remote-file sessions that share one Session-panel section and therefore one
/// set of folders: a group can hold servers of either protocol. SSH and
/// Telnet likewise share the remote-shell section, so a site's folder holds
/// its devices whichever way they are reached. Group membership and nesting
/// are compared by category rather than exact kind.
/// Mirrors `groupCategory` in the frontend's `sessionGroups.ts`.
fn group_category(kind: SessionKind) -> SessionKind {
    match kind {
        SessionKind::Sftp => SessionKind::Ftp,
        SessionKind::Telnet => SessionKind::Ssh,
        other => other,
    }
}

/// Whether a replacement profile sends its traffic somewhere other than the
/// one the stored credential was typed for.
fn names_another_endpoint(a: &SessionProfile, b: &SessionProfile) -> bool {
    a.kind != b.kind
        || a.host != b.host
        || a.port != b.port
        || a.username != b.username
        || a.auth != b.auth
}

fn same_group_category(a: SessionKind, b: SessionKind) -> bool {
    group_category(a) == group_category(b)
}

/// Drops parent links that point nowhere, to a group of another category, to
/// the group itself or around a cycle. Detaching one link never invalidates
/// another, so a single pass is enough.
fn detach_invalid_parents(groups: &mut [SessionGroup]) {
    for index in 0..groups.len() {
        let Some(parent_id) = groups[index].parent_id.clone() else {
            continue;
        };
        let group_id = groups[index].id.clone();
        let kind = groups[index].kind;
        let valid_parent = parent_id != group_id
            && groups
                .iter()
                .any(|group| group.id == parent_id && same_group_category(group.kind, kind));
        if !valid_parent || subtree_ids(groups, &group_id).contains(&parent_id) {
            groups[index].parent_id = None;
        }
    }
}

/// Ids of `root` and every group nested below it, in no particular order.
fn subtree_ids(groups: &[SessionGroup], root: &str) -> Vec<String> {
    let mut ids = vec![root.to_string()];
    let mut cursor = 0;
    while cursor < ids.len() {
        let parent = ids[cursor].clone();
        for group in groups {
            if group.parent_id.as_deref() == Some(parent.as_str()) && !ids.contains(&group.id) {
                ids.push(group.id.clone());
            }
        }
        cursor += 1;
    }
    ids
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn profiles_read_error(path: &Path) -> AppError {
    AppError::new(format!(
        "Cannot read the session configuration at {}. The existing file has been left untouched; \
         restore a readable configuration and restart EdgeTerm before saving sessions.",
        path.display()
    ))
}

fn credentials_path_for(path: &Path) -> PathBuf {
    path.with_file_name("credentials.json")
}

fn groups_path_for(path: &Path) -> PathBuf {
    path.with_file_name("session_groups.json")
}

fn sender_commands_path_for(path: &Path) -> PathBuf {
    path.with_file_name("sender_commands.json")
}

fn command_history_path_for(path: &Path) -> PathBuf {
    path.with_file_name("command_history.json")
}

fn appearance_path_for(path: &Path) -> PathBuf {
    path.with_file_name("appearance.json")
}

/// A `data` directory next to the executable switches the application into
/// portable mode (the VS Code convention): every configuration file lives in
/// that directory, so the whole application travels as one folder.  The
/// Windows portable zip ships the directory; installers never create one, so
/// installed copies keep using the OS configuration directory.
pub fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    portable_data_dir_in(exe.parent()?)
}

pub(crate) fn portable_data_dir_in(exe_dir: &Path) -> Option<PathBuf> {
    let dir = exe_dir.join("data");
    dir.is_dir().then_some(dir)
}

/// The directory the application keeps its configuration and logs in: the
/// portable `data` directory when one ships next to the executable, the OS
/// configuration directory (`%APPDATA%\EdgeTerm`, the Application Support
/// folder, `~/.config/EdgeTerm`) otherwise. Diagnostics live in `logs/` under
/// it (see `diagnostics::logs_dir`).
pub fn data_dir() -> PathBuf {
    match portable_data_dir() {
        Some(dir) => dir,
        None => dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("EdgeTerm"),
    }
}

fn config_path() -> PathBuf {
    data_dir().join("sessions.json")
}

pub(crate) fn write_owner_only(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;
    write_atomically(path, |file| file.write_all(contents.as_bytes()))
}

/// Writes through a temporary file beside the target and renames it into place
/// once the bytes are on disk. Opening the target directly and truncating it
/// destroys the previous contents before the new ones exist: a full disk, a
/// locked file or a crash mid-write then leaves unparsable JSON where the
/// configuration was, which blocks saving and can make the next import fail.
pub(crate) fn write_atomically(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let temp = dir.join(format!(".{name}.tmp-{}", uuid::Uuid::new_v4().simple()));

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let written = (|| -> std::io::Result<()> {
        let mut file = options.open(&temp)?;
        write(&mut file)?;
        file.sync_all()
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_file(&temp);
        return Err(error.into());
    }
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.into());
    }
    restrict_permissions(path);
    Ok(())
}

#[cfg(unix)]
pub(crate) fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub(crate) fn restrict_permissions(_path: &Path) {}
