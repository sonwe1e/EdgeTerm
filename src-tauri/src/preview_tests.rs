//! Tests for the remote report preview: the request and response decisions,
//! the loopback HTTP server as a whole, and acceptance against a real server.
//!
//! The first half needs nothing but a temporary directory: it serves a local
//! tree through the same registry, validation, planning and streaming code an
//! SSH preview uses, so the HTTP contract runs on loopback in CI. The last test
//! drives a real sshd and is skipped — not failed — when the fixture
//! environment is absent.

use std::path::{Path, PathBuf};
use std::time::Duration;

use hyper::StatusCode;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::preview::{
    decode_relative_path, host_allowed, is_html_file, join_remote, mime_for,
    percent_encode_component, plan, strip_token, validate_start_path, within_root, Previews,
};

// --- request and response decisions ---------------------------------------

#[test]
fn report_and_asset_types_are_named_exactly() {
    assert_eq!(mime_for("report.html"), "text/html; charset=utf-8");
    assert_eq!(mime_for("REPORT.HTM"), "text/html; charset=utf-8");
    assert_eq!(mime_for("charts.js"), "text/javascript; charset=utf-8");
    assert_eq!(mime_for("module.mjs"), "text/javascript; charset=utf-8");
    assert_eq!(mime_for("style.css"), "text/css; charset=utf-8");
    assert_eq!(mime_for("data.json"), "application/json; charset=utf-8");
    assert_eq!(mime_for("assets/loss.png"), "image/png");
    assert_eq!(mime_for("loss.JPG"), "image/jpeg");
    assert_eq!(mime_for("loss.jpeg"), "image/jpeg");
    assert_eq!(mime_for("anim.gif"), "image/gif");
    assert_eq!(mime_for("plot.webp"), "image/webp");
    assert_eq!(mime_for("icon.svg"), "image/svg+xml");
    assert_eq!(mime_for("favicon.ico"), "image/x-icon");
    assert_eq!(mime_for("inter.woff2"), "font/woff2");
    assert_eq!(mime_for("inter.ttf"), "font/ttf");
    assert_eq!(mime_for("module.wasm"), "application/wasm");
    assert_eq!(mime_for("notes.txt"), "text/plain; charset=utf-8");
    assert_eq!(mime_for("metrics.csv"), "text/csv; charset=utf-8");
    assert_eq!(mime_for("model.bin"), "application/octet-stream");
    assert_eq!(mime_for("README"), "application/octet-stream");
}

#[test]
fn a_full_response_carries_the_whole_file() {
    let full = plan("report.html", 100, None);
    assert_eq!(full.status, StatusCode::OK);
    assert_eq!(full.content_type, "text/html; charset=utf-8");
    assert_eq!(full.body, Some((0, 99)));
    assert_eq!(full.content_length(), 100);
    assert_eq!(full.content_range, None);

    // An empty file is a complete, empty response rather than a range.
    let empty = plan("report.html", 0, None);
    assert_eq!(empty.status, StatusCode::OK);
    assert_eq!(empty.body, None);
    assert_eq!(empty.content_length(), 0);
}

#[test]
fn one_byte_range_is_honoured() {
    let head = plan("charts.js", 1000, Some("bytes=0-99"));
    assert_eq!(head.status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(head.body, Some((0, 99)));
    assert_eq!(head.content_length(), 100);
    assert_eq!(head.content_range.as_deref(), Some("bytes 0-99/1000"));

    let tail = plan("charts.js", 1000, Some("bytes=900-"));
    assert_eq!(tail.body, Some((900, 999)));
    assert_eq!(tail.content_range.as_deref(), Some("bytes 900-999/1000"));

    let suffix = plan("charts.js", 1000, Some("bytes=-10"));
    assert_eq!(suffix.body, Some((990, 999)));
    assert_eq!(suffix.content_range.as_deref(), Some("bytes 990-999/1000"));

    let clamped = plan("charts.js", 1000, Some("bytes=900-5000"));
    assert_eq!(clamped.body, Some((900, 999)));
    assert_eq!(clamped.content_range.as_deref(), Some("bytes 900-999/1000"));
}

#[test]
fn an_unsupported_or_impossible_range_is_ignored_or_refused() {
    // Several ranges are not implemented; the whole file is the honest answer.
    assert_eq!(
        plan("a.js", 1000, Some("bytes=0-1,5-6")).status,
        StatusCode::OK
    );
    assert_eq!(plan("a.js", 1000, Some("items=0-1")).status, StatusCode::OK);
    assert_eq!(plan("a.js", 1000, Some("bytes=abc")).status, StatusCode::OK);
    assert_eq!(plan("a.js", 1000, Some("bytes=5-1")).status, StatusCode::OK);

    // A range past the end cannot be answered, and says how large the file is.
    let past = plan("a.js", 1000, Some("bytes=1000-"));
    assert_eq!(past.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(past.body, None);
    assert_eq!(past.content_length(), 0);
    assert_eq!(past.content_range.as_deref(), Some("bytes */1000"));

    // An empty file has no byte to serve.
    let empty = plan("a.js", 0, Some("bytes=0-"));
    assert_eq!(empty.status, StatusCode::RANGE_NOT_SATISFIABLE);
    assert_eq!(empty.content_range.as_deref(), Some("bytes */0"));
}

#[test]
fn the_host_header_must_name_this_listener() {
    assert!(host_allowed(Some("127.0.0.1:51234"), 51234));
    assert!(host_allowed(Some("localhost:51234"), 51234));
    assert!(!host_allowed(Some("evil.example:51234"), 51234));
    assert!(!host_allowed(Some("127.0.0.1:51235"), 51234));
    assert!(!host_allowed(Some("127.0.0.1"), 51234));
    assert!(!host_allowed(Some("127.0.0.1.evil.example:51234"), 51234));
    assert!(!host_allowed(Some("[::1]:51234"), 51234));
    assert!(!host_allowed(None, 51234));
}

#[test]
fn the_token_prefix_is_required_and_exact() {
    let token = "0123456789abcdef0123456789abcdef";
    assert_eq!(
        strip_token(&format!("/{token}/charts.js"), token),
        Some("charts.js")
    );
    assert_eq!(
        strip_token(&format!("/{token}/assets/loss.png"), token),
        Some("assets/loss.png")
    );
    assert_eq!(
        strip_token("/0123456789abcdef0123456789abcdff/charts.js", token),
        None
    );
    assert_eq!(strip_token(&format!("/{token}"), token), None);
    assert_eq!(strip_token("/charts.js", token), None);
    assert_eq!(strip_token(&format!("{token}/charts.js"), token), None);
}

#[test]
fn paths_are_decoded_and_confined_before_anything_is_read() {
    assert_eq!(
        decode_relative_path("charts.js"),
        Some(vec!["charts.js".to_string()])
    );
    assert_eq!(
        decode_relative_path("assets/loss.png"),
        Some(vec!["assets".to_string(), "loss.png".to_string()])
    );
    // Escapes are decoded before the segments are judged.
    assert_eq!(
        decode_relative_path("a%20b%2Fc.js"),
        Some(vec!["a b".to_string(), "c.js".to_string()])
    );
    assert_eq!(
        decode_relative_path("%E6%8A%A5%E5%91%8A.html"),
        Some(vec!["报告.html".to_string()])
    );
    assert_eq!(
        decode_relative_path("a/./b"),
        Some(vec!["a".to_string(), "b".to_string()])
    );
    for refused in [
        "",
        ".",
        "..",
        "../secret.json",
        "%2e%2e/secret.json",
        "a/../b",
        "a%2F..%2Fb",
        "a%00b",
        "a%5Cb",
        "a%zzb",
        "a%2",
        "a/b\\c",
    ] {
        assert_eq!(
            decode_relative_path(refused),
            None,
            "{refused} must be refused"
        );
    }
}

#[test]
fn a_resolved_path_stays_inside_its_root() {
    let root = "/home/edgeterm/work/exp";
    assert!(within_root("/home/edgeterm/work/exp/report.html", root));
    assert!(within_root("/home/edgeterm/work/exp/assets/loss.png", root));
    assert!(within_root(root, root));
    assert!(within_root("/home/edgeterm/work/exp/", root));
    assert!(!within_root(
        "/home/edgeterm/work/exp-other/report.html",
        root
    ));
    assert!(!within_root("/home/edgeterm/work/exp/../secret.json", root));
    assert!(!within_root("/home/edgeterm/work/secret.json", root));
    assert!(!within_root("/etc/passwd", root));
    assert!(within_root("/report.html", "/"));
}

#[test]
fn the_browser_url_escapes_the_report_name() {
    assert_eq!(percent_encode_component("report.html"), "report.html");
    assert_eq!(
        percent_encode_component("my report.html"),
        "my%20report.html"
    );
    assert_eq!(
        percent_encode_component("报告.html"),
        "%E6%8A%A5%E5%91%8A.html"
    );
    assert_eq!(percent_encode_component("a#b?c.js"), "a%23b%3Fc.js");
    assert_eq!(percent_encode_component("a-b_c.d~e"), "a-b_c.d~e");
}

#[test]
fn only_html_reports_are_previewed() {
    assert!(is_html_file("report.html"));
    assert!(is_html_file("REPORT.HTML"));
    assert!(is_html_file("index.htm"));
    assert!(!is_html_file("report"));
    assert!(!is_html_file("charts.js"));
    assert!(!is_html_file("report.html.js"));
    assert!(!is_html_file("report.htmlx"));
}

#[test]
fn a_remote_path_is_joined_below_its_root() {
    assert_eq!(
        join_remote(
            "/home/edgeterm/work/exp",
            &["assets".to_string(), "loss.png".to_string()]
        ),
        "/home/edgeterm/work/exp/assets/loss.png"
    );
    assert_eq!(
        join_remote("/", &["report.html".to_string()]),
        "/report.html"
    );
    assert_eq!(
        join_remote("/home/edgeterm/work/exp/", &["report.html".to_string()]),
        "/home/edgeterm/work/exp/report.html"
    );
}

#[test]
fn a_report_path_is_validated_before_it_reaches_the_server() {
    assert!(validate_start_path("").is_err());
    assert!(validate_start_path("  ").is_err());
    assert!(validate_start_path("/home/edgeterm/work/exp/a.html\0").is_err());
    assert!(validate_start_path("/home/edgeterm/work/exp/a.html\nb").is_err());
    assert_eq!(
        validate_start_path(" /home/edgeterm/work/exp/report.html ").unwrap(),
        "/home/edgeterm/work/exp/report.html"
    );
}

// --- the loopback server as a whole ----------------------------------------

struct Fixture {
    directory: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn report_fixture(tag: &str) -> Fixture {
    let directory =
        std::env::temp_dir().join(format!("edgeterm-preview-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(directory.join("assets")).expect("create the fixture tree");
    std::fs::write(
        directory.join("report.html"),
        "<html><script src=\"./charts.js\"></script></html>",
    )
    .expect("write the report");
    std::fs::write(directory.join("charts.js"), "console.log('loss');\n")
        .expect("write the script");
    std::fs::write(directory.join("style.css"), "body { color: #333; }\n")
        .expect("write the style");
    std::fs::write(directory.join("data.json"), "{\"step\": 1}").expect("write the data");
    std::fs::write(
        directory.join("assets/loss.png"),
        [0x89u8, 0x50, 0x4e, 0x47],
    )
    .expect("write the image");
    Fixture { directory }
}

fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link)
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link)
    }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Reply {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

async fn request(port: u16, message: &str) -> Reply {
    let mut socket = TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("connect to the preview");
    socket
        .write_all(message.as_bytes())
        .await
        .expect("send the request");
    let mut raw = Vec::new();
    tokio::time::timeout(Duration::from_secs(30), socket.read_to_end(&mut raw))
        .await
        .expect("the preview answers in time")
        .expect("read the answer");
    parse_reply(&raw)
}

fn parse_reply(raw: &[u8]) -> Reply {
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("the response has headers");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut lines = head.split("\r\n");
    let status = lines
        .next()
        .expect("a status line")
        .split_whitespace()
        .nth(1)
        .expect("a status code")
        .parse()
        .expect("a numeric status");
    let headers = lines
        .filter_map(|line| {
            line.split_once(':')
                .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_string()))
        })
        .collect();
    Reply {
        status,
        headers,
        body: raw[split + 4..].to_vec(),
    }
}

fn request_text(
    _port: u16,
    method: &str,
    target: &str,
    host: &str,
    extra: &[(&str, &str)],
) -> String {
    let mut message =
        format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
    for (name, value) in extra {
        message.push_str(name);
        message.push_str(": ");
        message.push_str(value);
        message.push_str("\r\n");
    }
    message.push_str("\r\n");
    message
}

fn get(port: u16, target: &str) -> String {
    request_text(port, "GET", target, &format!("127.0.0.1:{port}"), &[])
}

/// The `/{token}` prefix of a preview URL, which every request must carry.
fn base_path(url: &str) -> String {
    let path = url
        .strip_prefix("http://")
        .expect("a loopback URL")
        .split_once('/')
        .expect("a token in the URL")
        .1;
    format!(
        "/{}",
        path.rsplit_once('/').map_or(path, |(prefix, _)| prefix)
    )
}

#[tokio::test]
async fn loopback_preview_serves_the_report_and_its_neighbours() {
    let fixture = report_fixture("serve");
    let previews = Previews::default();
    let row = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");
    assert!(row.url.ends_with("/report.html"));
    assert!(row.url.contains(&format!(":{}", row.port)));
    assert_eq!(
        row.root,
        crate::preview::remote_path(&std::fs::canonicalize(&fixture.directory).unwrap())
    );
    let base = base_path(&row.url);

    let report = request(row.port, &get(row.port, &format!("{base}/report.html"))).await;
    assert_eq!(report.status, 200);
    assert_eq!(
        report.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(report.header("cache-control"), Some("no-store"));
    assert_eq!(report.header("accept-ranges"), Some("bytes"));
    assert_eq!(
        report.body,
        std::fs::read(fixture.directory.join("report.html")).unwrap()
    );

    let script = request(row.port, &get(row.port, &format!("{base}/charts.js"))).await;
    assert_eq!(script.status, 200);
    assert_eq!(
        script.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(script.body, b"console.log('loss');\n".to_vec());

    let style = request(row.port, &get(row.port, &format!("{base}/style.css"))).await;
    assert_eq!(style.status, 200);
    assert_eq!(
        style.header("content-type"),
        Some("text/css; charset=utf-8")
    );

    let image = request(row.port, &get(row.port, &format!("{base}/assets/loss.png"))).await;
    assert_eq!(image.status, 200);
    assert_eq!(image.header("content-type"), Some("image/png"));
    assert_eq!(image.body, vec![0x89, 0x50, 0x4e, 0x47]);

    previews.stop(&row.id).await.expect("stop the preview");
}

#[tokio::test]
async fn loopback_preview_refreshes_a_rewritten_json() {
    let fixture = report_fixture("refresh");
    let previews = Previews::default();
    let row = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");
    let target = format!("{}/data.json", base_path(&row.url));

    let first = request(row.port, &get(row.port, &target)).await;
    assert_eq!(first.body, b"{\"step\": 1}".to_vec());
    assert_eq!(first.header("cache-control"), Some("no-store"));

    // A training run rewriting the file must be visible on the next refresh,
    // so the server reads it per request instead of caching it.
    std::fs::write(fixture.directory.join("data.json"), "{\"step\": 2}").unwrap();
    let second = request(row.port, &get(row.port, &target)).await;
    assert_eq!(second.body, b"{\"step\": 2}".to_vec());

    previews.stop(&row.id).await.expect("stop the preview");
}

#[tokio::test]
async fn loopback_preview_answers_head_and_one_byte_range() {
    let fixture = report_fixture("range");
    std::fs::write(fixture.directory.join("data.json"), "0123456789").unwrap();
    let previews = Previews::default();
    let row = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");
    let target = format!("{}/data.json", base_path(&row.url));

    let ranged = request(
        row.port,
        &request_text(
            row.port,
            "GET",
            &target,
            &format!("127.0.0.1:{}", row.port),
            &[("Range", "bytes=2-5")],
        ),
    )
    .await;
    assert_eq!(ranged.status, 206);
    assert_eq!(ranged.header("content-range"), Some("bytes 2-5/10"));
    assert_eq!(ranged.header("content-length"), Some("4"));
    assert_eq!(ranged.body, b"2345".to_vec());

    let head = request(
        row.port,
        &request_text(
            row.port,
            "HEAD",
            &target,
            &format!("127.0.0.1:{}", row.port),
            &[],
        ),
    )
    .await;
    assert_eq!(head.status, 200);
    assert_eq!(head.header("content-length"), Some("10"));
    assert!(head.body.is_empty(), "a HEAD response has no body");

    let past = request(
        row.port,
        &request_text(
            row.port,
            "GET",
            &target,
            &format!("127.0.0.1:{}", row.port),
            &[("Range", "bytes=10-")],
        ),
    )
    .await;
    assert_eq!(past.status, 416);
    assert_eq!(past.header("content-range"), Some("bytes */10"));
    assert!(past.body.is_empty());

    previews.stop(&row.id).await.expect("stop the preview");
}

#[tokio::test]
async fn loopback_preview_refuses_foreign_requests() {
    let fixture = report_fixture("refuse");
    let previews = Previews::default();
    let row = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");
    let base = base_path(&row.url);

    // A host name that resolves to 127.0.0.1 must not reach the preview.
    let foreign = request(
        row.port,
        &request_text(
            row.port,
            "GET",
            &format!("{base}/charts.js"),
            &format!("evil.example:{}", row.port),
            &[],
        ),
    )
    .await;
    assert_eq!(foreign.status, 403);

    // The token is the only credential, and it is compared exactly.
    let wrong = request(
        row.port,
        &get(row.port, "/ffffffffffffffffffffffffffffffff/charts.js"),
    )
    .await;
    assert_eq!(wrong.status, 404);

    // Nothing but reads is served.
    let post = request(
        row.port,
        &request_text(
            row.port,
            "POST",
            &format!("{base}/charts.js"),
            &format!("127.0.0.1:{}", row.port),
            &[],
        ),
    )
    .await;
    assert_eq!(post.status, 405);
    assert_eq!(post.header("allow"), Some("GET, HEAD"));

    // Walking out of the report's directory is refused before SFTP is asked.
    let encoded_escape = request(
        row.port,
        &get(row.port, &format!("{base}/%2e%2e/secret.json")),
    )
    .await;
    assert_eq!(encoded_escape.status, 404);
    let plain_escape = request(row.port, &get(row.port, &format!("{base}/../secret.json"))).await;
    assert_eq!(plain_escape.status, 404);

    // An absolute resource reference names the server's root, not the report's
    // directory: the first version refuses instead of guessing.
    let absolute = request(row.port, &get(row.port, "/charts.js")).await;
    assert_eq!(absolute.status, 404);

    previews.stop(&row.id).await.expect("stop the preview");
}

#[tokio::test]
async fn loopback_preview_refuses_a_symlink_that_leaves_the_report_directory() {
    let fixture = report_fixture("symlink");
    let outside = std::env::temp_dir().join(format!(
        "edgeterm-preview-secret-{}.json",
        uuid::Uuid::new_v4()
    ));
    std::fs::write(&outside, "{\"secret\": true}").expect("write the outside file");
    let link = fixture.directory.join("secret.json");
    if symlink(&outside, &link).is_err() {
        eprintln!("skipped: this account cannot create symbolic links");
        let _ = std::fs::remove_file(outside);
        return;
    }
    let previews = Previews::default();
    let row = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");

    let escaped = request(
        row.port,
        &get(row.port, &format!("{}/secret.json", base_path(&row.url))),
    )
    .await;
    assert_eq!(escaped.status, 403);
    assert!(!String::from_utf8_lossy(&escaped.body).contains("secret"));

    previews.stop(&row.id).await.expect("stop the preview");
    let _ = std::fs::remove_file(outside);
}

#[tokio::test]
async fn loopback_preview_stop_releases_the_port() {
    let fixture = report_fixture("stop");
    let previews = Previews::default();
    let row = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");
    let report = request(
        row.port,
        &get(row.port, &format!("{}/report.html", base_path(&row.url))),
    )
    .await;
    assert_eq!(report.status, 200);

    previews.stop(&row.id).await.expect("stop the preview");
    assert!(previews.list().is_empty(), "a stopped preview is gone");
    assert!(
        TcpStream::connect(("127.0.0.1", row.port)).await.is_err(),
        "the port must be released"
    );
    assert!(
        previews.stop(&row.id).await.is_err(),
        "stopping a preview twice is an error"
    );
}

#[tokio::test]
async fn loopback_preview_close_session_cleans_up_only_its_own() {
    let mine = report_fixture("owner-a");
    let theirs = report_fixture("owner-b");
    let previews = Previews::default();
    let closing = previews
        .start_local("session-a", &mine.directory, "report.html")
        .await
        .expect("start the first preview");
    let staying = previews
        .start_local("session-b", &theirs.directory, "report.html")
        .await
        .expect("start the second preview");
    assert_eq!(previews.list().len(), 2);

    previews.close_session("session-a");
    tokio::time::timeout(Duration::from_secs(5), async {
        while TcpStream::connect(("127.0.0.1", closing.port))
            .await
            .is_ok()
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the closed session's preview must stop");

    assert_eq!(previews.list(), vec![staying.clone()]);
    let report = request(
        staying.port,
        &get(
            staying.port,
            &format!("{}/report.html", base_path(&staying.url)),
        ),
    )
    .await;
    assert_eq!(report.status, 200);

    previews.stop(&staying.id).await.expect("stop the preview");
}

#[tokio::test]
async fn starting_the_same_report_twice_reuses_the_running_preview() {
    let fixture = report_fixture("reuse");
    let previews = Previews::default();
    let first = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the preview");
    let again = previews
        .start_local("session", &fixture.directory, "report.html")
        .await
        .expect("start the same preview again");
    assert_eq!(again.id, first.id);
    assert_eq!(again.url, first.url);
    assert_eq!(previews.list().len(), 1);

    previews.stop(&first.id).await.expect("stop the preview");
}

// --- acceptance against a real sshd ---------------------------------------

struct SshFixture {
    host: String,
    port: u16,
    user: String,
    key: String,
    root: String,
}

/// The dedicated loopback fixture the file-transfer acceptance tests use. The
/// ET_TEST_SSH_* names are accepted as well, so a one-off run does not have to
/// spell the older names out. Without a fixture the test is skipped.
fn ssh_fixture() -> Option<SshFixture> {
    let var = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
    let address = match var("EDGETERM_REAL_SSH_ADDR") {
        Some(address) => address,
        None => format!("{}:{}", var("ET_TEST_SSH_HOST")?, var("ET_TEST_SSH_PORT")?),
    };
    let (host, port) = address.rsplit_once(':')?;
    Some(SshFixture {
        host: host.to_string(),
        port: port.parse().ok()?,
        user: var("EDGETERM_REAL_SSH_USER").or_else(|| var("ET_TEST_SSH_USER"))?,
        key: var("EDGETERM_REAL_SSH_KEY").or_else(|| var("ET_TEST_SSH_KEY"))?,
        root: var("EDGETERM_REAL_SSH_ROOT")
            .or_else(|| var("ET_TEST_SSH_ROOT"))
            .unwrap_or_else(|| "/home/edgeterm/work/exp".to_string()),
    })
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The report tree one acceptance run owns, written remotely so the sample
/// directory other features use is never touched.
const REMOTE_FIXTURE: &str = r#"set -e
mkdir -p {dir}/assets
echo '<html><script src="./charts.js"></script><link rel="stylesheet" href="./style.css"></html>' > {dir}/report.html
echo 'console.log("loss");' > {dir}/charts.js
echo 'body { color: #333; }' > {dir}/style.css
printf '%s' '{"step": 1}' > {dir}/data.json
echo '{"secret": true}' > {secret}
printf '\211PNG' > {dir}/assets/loss.png
head -c 262144 /dev/zero > {dir}/big.bin
ln -s {secret} {dir}/leak.json
echo ready
"#;

async fn remote_exec(
    transport: std::sync::Arc<crate::session::ssh::SharedTransport>,
    script: String,
) -> String {
    crate::session::exec::run(
        transport,
        &script,
        &crate::file_transfer::Control::default(),
        64 * 1024,
        Duration::from_secs(15),
    )
    .await
    .expect("run the remote fixture command")
}

#[tokio::test]
#[ignore = "dedicated loopback OpenSSH fixture (EDGETERM_REAL_SSH_* or ET_TEST_SSH_*)"]
async fn real_remote_report_preview_serves_assets_refuses_escapes_and_stops() {
    let Some(fixture) = ssh_fixture() else {
        eprintln!("skipped: the dedicated SSH fixture is not configured");
        return;
    };
    let scratch =
        std::env::temp_dir().join(format!("edgeterm-preview-real-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&scratch).expect("create the local scratch directory");
    let transport = crate::session::ssh::test_transport(
        &fixture.host,
        fixture.port,
        &fixture.user,
        &fixture.key,
        &scratch.join("known_hosts"),
    )
    .await;

    let base_dir = fixture.root.trim_end_matches('/');
    let directory = format!("{base_dir}/preview-{}", uuid::Uuid::new_v4().simple());
    let secret = format!("{base_dir}/secret-{}.json", uuid::Uuid::new_v4().simple());
    let script = REMOTE_FIXTURE
        .replace("{dir}", &shell_quote(&directory))
        .replace("{secret}", &shell_quote(&secret));
    assert_eq!(remote_exec(transport.clone(), script).await.trim(), "ready");

    let previews = Previews::default();
    let report_path = format!("{directory}/report.html");
    let row = previews
        .start("real-preview", transport.clone(), &report_path)
        .await
        .expect("start the remote preview");
    assert_eq!(row.root, directory);
    assert!(row.url.ends_with("/report.html"));
    assert_eq!(previews.list(), vec![row.clone()]);
    let base = base_path(&row.url);

    let report = request(row.port, &get(row.port, &format!("{base}/report.html"))).await;
    assert_eq!(report.status, 200);
    assert_eq!(
        report.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(report.header("cache-control"), Some("no-store"));
    assert!(String::from_utf8_lossy(&report.body).contains("charts.js"));

    let script_body = request(row.port, &get(row.port, &format!("{base}/charts.js"))).await;
    assert_eq!(script_body.status, 200);
    assert_eq!(
        script_body.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(script_body.body, b"console.log(\"loss\");\n".to_vec());

    let style = request(row.port, &get(row.port, &format!("{base}/style.css"))).await;
    assert_eq!(style.status, 200);
    assert_eq!(
        style.header("content-type"),
        Some("text/css; charset=utf-8")
    );

    let image = request(row.port, &get(row.port, &format!("{base}/assets/loss.png"))).await;
    assert_eq!(image.status, 200);
    assert_eq!(image.header("content-type"), Some("image/png"));
    assert_eq!(image.body, vec![0x89, 0x50, 0x4e, 0x47]);

    // A rewritten data.json is visible on the next request: nothing is cached.
    let before = request(row.port, &get(row.port, &format!("{base}/data.json"))).await;
    assert_eq!(before.body, b"{\"step\": 1}".to_vec());
    let rewrite = format!(
        "printf '%s' '{}' > {}",
        "{\"step\": 2}",
        shell_quote(&format!("{directory}/data.json"))
    );
    remote_exec(transport.clone(), rewrite).await;
    let after = request(row.port, &get(row.port, &format!("{base}/data.json"))).await;
    assert_eq!(after.body, b"{\"step\": 2}".to_vec());

    // A multi-chunk file arrives whole and in order.
    let big = request(row.port, &get(row.port, &format!("{base}/big.bin"))).await;
    assert_eq!(big.status, 200);
    assert_eq!(big.header("content-length"), Some("262144"));
    assert_eq!(big.body.len(), 262144);
    assert!(big.body.iter().all(|byte| *byte == 0));

    let ranged = request(
        row.port,
        &request_text(
            row.port,
            "GET",
            &format!("{base}/big.bin"),
            &format!("127.0.0.1:{}", row.port),
            &[("Range", "bytes=10-13")],
        ),
    )
    .await;
    assert_eq!(ranged.status, 206);
    assert_eq!(ranged.header("content-range"), Some("bytes 10-13/262144"));
    assert_eq!(ranged.header("content-length"), Some("4"));
    assert_eq!(ranged.body, vec![0, 0, 0, 0]);

    let head = request(
        row.port,
        &request_text(
            row.port,
            "HEAD",
            &format!("{base}/data.json"),
            &format!("127.0.0.1:{}", row.port),
            &[],
        ),
    )
    .await;
    assert_eq!(head.status, 200);
    assert_eq!(head.header("content-length"), Some("11"));
    assert!(head.body.is_empty(), "a HEAD response has no body");

    // Two dots never survive decoding, and a symbolic link out of the report's
    // directory is refused after the server resolves it.
    let traversal = request(
        row.port,
        &get(row.port, &format!("{base}/%2e%2e/secret.json")),
    )
    .await;
    assert_eq!(traversal.status, 404);
    let plain_traversal =
        request(row.port, &get(row.port, &format!("{base}/../secret.json"))).await;
    assert_eq!(plain_traversal.status, 404);
    let linked = request(row.port, &get(row.port, &format!("{base}/leak.json"))).await;
    assert_eq!(linked.status, 403);
    assert!(!String::from_utf8_lossy(&linked.body).contains("secret"));
    let absolute = request(row.port, &get(row.port, "/report.html")).await;
    assert_eq!(absolute.status, 404);

    let wrong_token = request(
        row.port,
        &get(row.port, "/ffffffffffffffffffffffffffffffff/charts.js"),
    )
    .await;
    assert_eq!(wrong_token.status, 404);
    let foreign_host = request(
        row.port,
        &request_text(
            row.port,
            "GET",
            &format!("{base}/charts.js"),
            &format!("attacker.example:{}", row.port),
            &[],
        ),
    )
    .await;
    assert_eq!(foreign_host.status, 403);
    let post = request(
        row.port,
        &request_text(
            row.port,
            "POST",
            &format!("{base}/charts.js"),
            &format!("127.0.0.1:{}", row.port),
            &[],
        ),
    )
    .await;
    assert_eq!(post.status, 405);

    previews
        .stop(&row.id)
        .await
        .expect("stop the remote preview");
    assert!(previews.list().is_empty());
    assert!(
        TcpStream::connect(("127.0.0.1", row.port)).await.is_err(),
        "the port must be released"
    );

    let cleanup = format!(
        "rm -rf {} {}",
        shell_quote(&directory),
        shell_quote(&secret)
    );
    remote_exec(transport.clone(), cleanup).await;
    drop(transport);
    let _ = std::fs::remove_dir_all(&scratch);
}
