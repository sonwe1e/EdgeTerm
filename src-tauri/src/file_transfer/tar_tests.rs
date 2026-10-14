//! Fixture evidence only: these tests exercise the ustar writer, the probe
//! parser and the refusal decisions against synthetic input. Nothing here
//! talks to a server, so none of it says anything about a real remote tar.
use super::super::Options;
use super::*;
use crate::model::SessionKind;
use std::path::PathBuf;

/// One entry an independent reader pulled out of an archive.
struct Read {
    name: String,
    kind: u8,
    size: u64,
    mode: u64,
    mtime: u64,
    content: Vec<u8>,
}

/// Reads back what the writer produced. It knows the ustar layout and PAX
/// records and nothing about how the writer builds them, so a header the
/// writer gets wrong shows up here rather than being agreed with.
fn read_archive(bytes: &[u8]) -> Vec<Read> {
    let mut out = Vec::new();
    let mut pending_path: Option<String> = None;
    let mut pending_size: Option<u64> = None;
    let mut offset = 0usize;
    while offset + BLOCK <= bytes.len() {
        let block = &bytes[offset..offset + BLOCK];
        if block.iter().all(|byte| *byte == 0) {
            break;
        }
        assert!(
            checksum_ok(block),
            "the header at {offset} has a bad checksum"
        );
        assert_eq!(&block[257..263], b"ustar\0", "magic at {offset}");
        assert_eq!(&block[263..265], b"00", "version at {offset}");
        let kind = block[156];
        let size = octal_field(&block[124..136]);
        let body = (size as usize).div_ceil(BLOCK) * BLOCK;
        let start = offset + BLOCK;
        let content = bytes[start..start + size as usize].to_vec();
        offset = start + body;
        if kind == b'x' {
            for (key, value) in pax_records(&content) {
                match key.as_str() {
                    "path" => pending_path = Some(value),
                    "size" => pending_size = Some(value.parse().expect("a decimal size")),
                    _ => {}
                }
            }
            continue;
        }
        out.push(Read {
            name: pending_path
                .take()
                .unwrap_or_else(|| cstr(&block[..100]))
                .trim_end_matches('/')
                .to_string(),
            kind,
            size: pending_size.take().unwrap_or(size),
            mode: octal_field(&block[100..108]),
            mtime: octal_field(&block[136..148]),
            content,
        });
    }
    out
}

fn cstr(field: &[u8]) -> String {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).into_owned()
}

fn octal_field(field: &[u8]) -> u64 {
    let end = field
        .iter()
        .position(|byte| *byte == 0 || *byte == b' ')
        .unwrap_or(field.len());
    let text = std::str::from_utf8(&field[..end]).unwrap_or("").trim();
    u64::from_str_radix(text, 8).unwrap_or(0)
}

fn checksum_ok(block: &[u8]) -> bool {
    let stored = octal_field(&block[148..156]);
    let mut sum: u64 = 0;
    for (index, byte) in block.iter().enumerate() {
        sum += u64::from(if (148..156).contains(&index) {
            b' '
        } else {
            *byte
        });
    }
    sum == stored
}

fn pax_records(body: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(space) = rest.iter().position(|byte| *byte == b' ') {
        let length: usize = std::str::from_utf8(&rest[..space])
            .unwrap_or("0")
            .parse()
            .unwrap_or(0);
        if length == 0 || length > rest.len() {
            break;
        }
        let record = &rest[space + 1..length - 1];
        if let Some(equals) = record.iter().position(|byte| *byte == b'=') {
            out.push((
                String::from_utf8_lossy(&record[..equals]).into_owned(),
                String::from_utf8_lossy(&record[equals + 1..]).into_owned(),
            ));
        }
        rest = &rest[length..];
    }
    out
}

fn tree() -> PathBuf {
    let root = std::env::temp_dir().join(format!("edgeterm-tar-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn item(local: &str, remote: &str, upload: bool, directory: bool) -> Item {
    Item {
        local: local.into(),
        remote: remote.into(),
        upload,
        directory,
    }
}

// --- the writer -------------------------------------------------------------

#[tokio::test]
async fn a_tree_round_trips_through_the_writer() {
    let long = format!("{}.txt", "n".repeat(120));
    let mut sink: Vec<u8> = Vec::new();
    let mut writer = UstarWriter::new(&mut sink);
    writer.directory("pkg", 0o755, 1_700_000_000).await.unwrap();
    writer
        .directory("pkg/deep", 0o750, 1_700_000_000)
        .await
        .unwrap();
    writer
        .file("README.md", 5, 0o644, 1_700_000_000)
        .await
        .unwrap();
    writer.write(b"hello").await.unwrap();
    writer
        .file("pkg/deep/empty.bin", 0, 0o640, 1_700_000_000)
        .await
        .unwrap();
    writer.file(&long, 9, 0o644, 1_700_000_000).await.unwrap();
    writer.write(b"long name").await.unwrap();
    writer
        .file("中文.txt", 5, 0o644, 1_700_000_000)
        .await
        .unwrap();
    writer.write(b"utf-8").await.unwrap();
    writer.finish().await.unwrap();

    // The archive is a whole number of records and ends on two zero blocks.
    assert_eq!(sink.len() % RECORD, 0);
    assert!(sink[sink.len() - 2 * BLOCK..].iter().all(|byte| *byte == 0));

    let entries = read_archive(&sink);
    let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "pkg",
            "pkg/deep",
            "README.md",
            "pkg/deep/empty.bin",
            long.as_str(),
            "中文.txt"
        ]
    );
    let readme = &entries[2];
    assert_eq!(readme.kind, b'0');
    assert_eq!(readme.size, 5);
    assert_eq!(readme.mode, 0o644);
    assert_eq!(readme.mtime, 1_700_000_000);
    assert_eq!(readme.content, b"hello");
    let empty = &entries[3];
    assert_eq!(empty.size, 0);
    assert!(empty.content.is_empty());
    assert_eq!(empty.mode, 0o640);
    assert_eq!(entries[0].kind, b'5');
    assert_eq!(entries[0].mode, 0o755);
    assert_eq!(entries[1].mode, 0o750);
    assert_eq!(entries[4].content, b"long name");
    assert_eq!(entries[5].content, b"utf-8");
}

/// Splits what `header_bytes` wrote for one entry into its PAX extended
/// header (when there is one), the PAX body, and the ustar header itself.
/// A PAX-carrying entry is three blocks: header, padded body, ustar header.
fn split_header(header: &[u8]) -> (Option<&[u8]>, &[u8], &[u8]) {
    let pax_size = octal_field(&header[124..136]);
    if header[156] != b'x' {
        return (None, &[], header);
    }
    (
        Some(&header[..BLOCK]),
        &header[BLOCK..BLOCK + pax_size as usize],
        &header[2 * BLOCK..3 * BLOCK],
    )
}

#[test]
fn a_size_above_the_ustar_octal_limit_moves_into_a_pax_record() {
    // 0o77777777777, the most a 12-byte octal field can hold.
    assert_eq!(USTAR_MAX_SIZE, 8_589_934_591);
    let huge = USTAR_MAX_SIZE + 1;
    let header = header_bytes("big.bin", EntryKind::File, huge, 0o644, 0).unwrap();
    let (extended, body, ustar) = split_header(&header);
    assert!(
        extended.is_some(),
        "a size above the limit needs a PAX header"
    );
    assert_eq!(header.len(), 3 * BLOCK);
    let records = pax_records(body);
    assert!(
        records.contains(&("size".to_string(), huge.to_string())),
        "{records:?}"
    );
    // The ustar header behind it cannot hold the size, so it holds zero
    // rather than a value no reader could trust.
    assert_eq!(octal_field(&ustar[124..136]), 0);
    assert!(checksum_ok(ustar));
    assert!(checksum_ok(extended.unwrap()));
}

#[test]
fn a_name_that_does_not_fit_a_ustar_field_is_carried_by_a_pax_record() {
    let long = format!("{}.txt", "n".repeat(120));
    let header = header_bytes(&long, EntryKind::File, 3, 0o644, 0).unwrap();
    let (extended, body, _ustar) = split_header(&header);
    assert!(extended.is_some());
    let records = pax_records(body);
    assert!(
        records.contains(&("path".to_string(), long.clone())),
        "{records:?}"
    );
    // A plain ASCII name that fits is written straight into the ustar field,
    // with no PAX header in front of it.
    let short = header_bytes("a.txt", EntryKind::File, 1, 0o644, 0).unwrap();
    assert_eq!(short.len(), BLOCK);
    assert_eq!(cstr(&short[..100]), "a.txt");
    assert_eq!(split_header(&short).0, None);
}

#[tokio::test]
async fn an_entry_longer_than_its_header_declares_is_refused() {
    let mut sink: Vec<u8> = Vec::new();
    let mut writer = UstarWriter::new(&mut sink);
    writer.file("a.txt", 2, 0o644, 0).await.unwrap();
    assert!(writer.write(b"abc").await.is_err());
    writer.write(b"ab").await.unwrap();
    // A second entry before the first was finished is refused too.
    writer.file("b.txt", 0, 0o644, 0).await.unwrap();
    writer.finish().await.unwrap();
    let entries = read_archive(&sink);
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].content, b"ab");
}

// --- the probe --------------------------------------------------------------

const ANSWER: &str = "Welcome banner from .bashrc\n\
EDGETERM-TAR /usr/bin/tar\n\
EDGETERM-TAR-KEEP yes\n\
EDGETERM-TAR-SHELL posix\n\
EDGETERM-TAR-TARGET absent\n";

#[test]
fn parse_probe_reads_the_marker_lines_and_ignores_banner_noise() {
    let probe = parse_probe(ANSWER, "", Some(0)).unwrap();
    assert_eq!(probe.tar.as_deref(), Some("/usr/bin/tar"));
    assert!(probe.keep_old_files);
    assert_eq!(probe.shell, Shell::Posix);
    assert_eq!(probe.target, Target::Absent);
}

#[test]
fn parse_probe_reads_every_target_state() {
    for (answer, expected) in [
        (
            "EDGETERM-TAR /bin/tar\nEDGETERM-TAR-TARGET absent\n",
            Target::Absent,
        ),
        (
            "EDGETERM-TAR /bin/tar\nEDGETERM-TAR-TARGET 0\n",
            Target::Empty,
        ),
        (
            "EDGETERM-TAR /bin/tar\nEDGETERM-TAR-TARGET 1\n",
            Target::NonEmpty,
        ),
        (
            "EDGETERM-TAR /bin/tar\nEDGETERM-TAR-TARGET file\n",
            Target::NotADirectory,
        ),
        (
            "EDGETERM-TAR /bin/tar\nEDGETERM-TAR-TARGET unreadable\n",
            Target::Unreadable,
        ),
    ] {
        assert_eq!(parse_probe(answer, "", Some(0)).unwrap().target, expected);
    }
}

#[test]
fn parse_probe_names_a_windows_shell_and_a_missing_tar() {
    let windows = "EDGETERM-TAR none\nEDGETERM-TAR-SHELL windows\nEDGETERM-TAR-TARGET absent\n";
    let probe = parse_probe(windows, "", Some(0)).unwrap();
    assert_eq!(probe.tar, None);
    assert_eq!(probe.shell, Shell::Windows);
    assert!(!probe.keep_old_files);
}

#[test]
fn parse_probe_refuses_a_command_that_answered_nothing() {
    // What a Windows OpenSSH server whose shell is cmd or PowerShell looks
    // like: the command runs, writes a complaint to stderr and exits.
    let error = parse_probe("", "'sh' is not recognized", Some(9009)).unwrap_err();
    assert!(
        error.message.contains("POSIX shell")
            && error.message.contains("status 9009")
            && error.message.contains("'sh' is not recognized"),
        "{}",
        error.message
    );
    assert!(!error.retryable);
    // A marker with nothing after it is not an answer either.
    assert!(parse_probe("EDGETERM-TAR\n", "", Some(0)).is_err());
}

// --- the decisions ----------------------------------------------------------

fn probe(target: Target, tar: Option<&str>, keep: bool, shell: Shell) -> Probe {
    Probe {
        tar: tar.map(str::to_string),
        keep_old_files: keep,
        shell,
        target,
    }
}

#[test]
fn decide_refuses_a_target_that_already_holds_something() {
    let error = decide(
        &probe(Target::NonEmpty, Some("/bin/tar"), true, Shell::Posix),
        1,
    )
    .unwrap_err();
    assert_eq!(error.code, "conflict");
    assert!(error.message.contains("not empty"), "{}", error.message);
    assert!(decide(
        &probe(Target::NotADirectory, Some("/bin/tar"), true, Shell::Posix),
        1
    )
    .is_err());
    assert!(decide(
        &probe(Target::Unreadable, Some("/bin/tar"), true, Shell::Posix),
        1
    )
    .is_err());
}

#[test]
fn decide_falls_back_when_the_server_has_no_tar() {
    let decision = decide(&probe(Target::Absent, None, false, Shell::Posix), 1).unwrap();
    assert_eq!(
        decision,
        Decision::PerFile {
            reason: Reason::NoTar
        }
    );
}

#[test]
fn decide_refuses_a_tar_that_cannot_be_told_to_keep_old_files() {
    let error = decide(
        &probe(Target::Empty, Some("/bin/tar"), false, Shell::Posix),
        1,
    )
    .unwrap_err();
    assert_eq!(error.code, "unsupported");
    assert!(
        error.message.contains("keep existing files"),
        "{}",
        error.message
    );
}

#[test]
fn decide_refuses_a_windows_shell() {
    let error = decide(
        &probe(Target::Absent, Some("/bin/tar"), true, Shell::Windows),
        1,
    )
    .unwrap_err();
    assert_eq!(error.code, "unsupported");
    assert!(error.message.contains("Windows"), "{}", error.message);
}

#[test]
fn decide_streams_into_a_free_target() {
    let decision = decide(
        &probe(Target::Empty, Some("/usr/bin/tar"), true, Shell::Posix),
        1,
    )
    .unwrap();
    assert_eq!(
        decision,
        Decision::Stream {
            tar: "/usr/bin/tar".into()
        }
    );
}

#[test]
fn a_retry_hands_its_own_partial_extraction_to_the_per_file_path() {
    let decision = decide(
        &probe(Target::NonEmpty, Some("/bin/tar"), true, Shell::Posix),
        2,
    )
    .unwrap();
    assert_eq!(
        decision,
        Decision::PerFile {
            reason: Reason::PartialTarget
        }
    );
}

// --- the scope and the default path ----------------------------------------

#[test]
fn the_default_path_is_untouched_when_the_option_is_off() {
    let root = tree();
    let source = root.join("project");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("a.txt"), b"a").unwrap();
    let job = super::super::test_job_items(
        root.clone(),
        vec![item(&source.to_string_lossy(), "/site", true, true)],
    );
    assert!(!Options::default().tar);
    assert!(!wants_tar(&job));
    // On, and an SFTP session, and a folder upload: only then does the tar
    // path get the job.
    let mut job = job;
    Arc::get_mut(&mut job).unwrap().options.tar = true;
    assert!(wants_tar(&job));
    // FTP has no exec channel to run a remote tar on.
    Arc::get_mut(&mut job).unwrap().profile.kind = SessionKind::Ftp;
    assert!(!wants_tar(&job));
    Arc::get_mut(&mut job).unwrap().profile.kind = SessionKind::Sftp;
    // A single file upload is not a folder upload.
    let file = root.join("one.txt");
    std::fs::write(&file, b"one").unwrap();
    let job = super::super::test_job_items(
        root,
        vec![item(&file.to_string_lossy(), "/site/one.txt", true, false)],
    );
    assert!(!wants_tar(&job));
}

#[test]
fn a_batch_that_is_not_one_folder_upload_is_refused() {
    let root = tree();
    let source = root.join("project");
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("a.txt"), b"a").unwrap();
    let file = root.join("one.txt");
    std::fs::write(&file, b"one").unwrap();

    let many = super::super::test_job_items(
        root.clone(),
        vec![
            item(&file.to_string_lossy(), "/site/one.txt", true, false),
            item(&file.to_string_lossy(), "/site/two.txt", true, false),
        ],
    );
    let error = single_directory_upload(&many).unwrap_err();
    assert!(
        error.message.contains("one folder at a time"),
        "{}",
        error.message
    );

    let single = super::super::test_job_items(
        root.clone(),
        vec![item(&file.to_string_lossy(), "/site/one.txt", true, false)],
    );
    let error = single_directory_upload(&single).unwrap_err();
    assert!(error.message.contains("is not one"), "{}", error.message);

    let download = super::super::test_job_items(
        root.clone(),
        vec![item(&source.to_string_lossy(), "/site", false, true)],
    );
    assert!(single_directory_upload(&download).is_err());

    let upload = super::super::test_job_items(
        root,
        vec![item(&source.to_string_lossy(), "/site", true, true)],
    );
    assert_eq!(
        single_directory_upload(&upload).unwrap().remote,
        "/site".to_string()
    );
}

// --- the shell quoting ------------------------------------------------------

#[test]
fn a_remote_path_is_quoted_for_the_shell() {
    assert_eq!(quote("/srv/www"), "'/srv/www'");
    assert_eq!(quote("/srv/it's"), "'/srv/it'\\''s'");
    assert_eq!(quote("/srv/a b;rm -rf /"), "'/srv/a b;rm -rf /'");
    let script = probe_script("/srv/it's");
    assert!(script.contains("'/srv/it'\\''s'"), "{script}");
    assert!(script.contains("command -v tar"));
    assert!(script.contains("--keep-old-files"));
}

#[test]
fn archive_names_are_relative_and_refuse_to_escape() {
    assert_eq!(archive_name("/site", "/site").unwrap(), None);
    assert_eq!(
        archive_name("/site/pkg/a.txt", "/site").unwrap().as_deref(),
        Some("pkg/a.txt")
    );
    // A trailing separator is the destination directory itself, not an entry.
    assert_eq!(
        archive_name("/site/pkg/", "/site").unwrap().as_deref(),
        Some("pkg")
    );
    assert_eq!(archive_name("/site/", "/site").unwrap(), None);
    assert!(archive_name("/other/a.txt", "/site").is_err());
    assert!(archive_name("/site/../escape", "/site").is_err());
}
