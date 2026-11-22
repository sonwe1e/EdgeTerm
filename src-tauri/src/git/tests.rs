use super::*;
use std::{fs, path::PathBuf};

use futures_util::FutureExt;

struct Fixture {
    path: PathBuf,
    repo: GitWorktree,
}

impl Fixture {
    async fn new() -> Self {
        let path = std::env::temp_dir().join(format!("edgeterm-git-测试'{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        let mut fixture = Self {
            repo: GitWorktree {
                directory: path.to_str().unwrap().into(),
                runner: Runner::Local,
            },
            path,
        };
        assert!(fixture.repo.status().await.unwrap().is_none());
        fixture.git(&["init", "-b", "main", "--template="]).await;
        fixture.repo.directory = fixture.repo.root().await.unwrap().unwrap();
        for (key, value) in [
            ("user.name", "Git Fixture"),
            ("user.email", "git-fixture@example.test"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", ".git/fixture-hooks"),
            ("core.autocrlf", "false"),
        ] {
            fixture.git(&["config", "--local", key, value]).await;
        }
        fixture
    }

    async fn git(&self, args: &[&str]) -> String {
        let output = self
            .repo
            .read(&self.repo.directory, args, STATUS_LIMIT)
            .await
            .unwrap();
        String::from_utf8(successful(output).unwrap()).unwrap()
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        fs::write(self.path.join(path), content).unwrap();
    }

    async fn status(&self) -> GitStatus {
        self.repo.status().await.unwrap().unwrap()
    }

    async fn diff(&self, path: &str, scope: GitScope) -> GitPatch {
        let status = self.status().await;
        let file = find_change(&status, path)
            .unwrap()
            .selection(scope)
            .unwrap();
        self.repo.diff(GitDiffTarget::File { file }).await.unwrap()
    }

    async fn action(&self, action: GitAction) {
        self.repo.mutate(action).await.unwrap();
    }

    async fn commit(&self, message: &str) {
        let token = self.status().await.commit_token;
        self.action(GitAction::Commit {
            token,
            message: message.into(),
        })
        .await;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[tokio::test]
async fn stages_and_reverses_hunks_without_touching_working_content() {
    let fixture = Fixture::new().await;
    let baseline = (0..24)
        .map(|line| format!("line {line}\n"))
        .collect::<String>();
    let path = "code [临时].txt";
    fixture.write(path, &baseline);
    fixture.action(GitAction::Stage { path: None }).await;
    fixture.commit("Initial file").await;
    let edited = baseline
        .replace("line 2\n", "first hunk\n")
        .replace("line 20\n", "second hunk\n");
    fixture.write(path, &edited);
    let original = fixture.diff(path, GitScope::Working).await;
    assert_eq!(hunk_ranges(&original.text).len(), 2);
    let stage = |patch: &GitPatch, scope, index| GitAction::Hunk {
        path: path.into(),
        scope,
        index,
        token: patch.token.clone().unwrap(),
    };
    fixture.action(stage(&original, GitScope::Working, 0)).await;
    let stale = fixture
        .repo
        .mutate(stage(&original, GitScope::Working, 1))
        .await
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    let staged = fixture.diff(path, GitScope::Staged).await;
    assert!(staged.text.contains("+first hunk"));
    assert!(!staged.text.contains("+second hunk"));
    fixture.action(stage(&staged, GitScope::Staged, 0)).await;
    assert_eq!(fixture.git(&["show", &format!(":{path}")]).await, baseline);
    assert_eq!(fs::read_to_string(fixture.path.join(path)).unwrap(), edited);

    let remainder = fixture.diff(path, GitScope::Working).await;
    fixture
        .action(stage(&remainder, GitScope::Working, 1))
        .await;
    let token = fixture.status().await.commit_token;
    fixture.write(
        path,
        edited.replace("first hunk", "first hunk plus new work"),
    );
    assert_eq!(fixture.status().await.commit_token, token);
    fixture
        .commit("Commit only the second hunk\n\nMessage body")
        .await;
    assert!(fixture
        .git(&["show", &format!("HEAD:{path}")])
        .await
        .contains("second hunk"));
    assert!(fixture
        .git(&["show", &format!("HEAD:{path}")])
        .await
        .contains("line 2\n"));
    assert!(fixture
        .diff(path, GitScope::Working)
        .await
        .text
        .contains("+first hunk plus new work"));
}

#[tokio::test]
async fn rejects_a_stale_commit_and_tracks_literal_names_renames_and_history() {
    let fixture = Fixture::new().await;
    let path = "[a].txt";
    fixture.write(path, "one\n");
    fixture.write("a.txt", "untracked\n");
    let review = fixture.diff(path, GitScope::Working).await;
    assert_eq!(review.kind, GitPatchKind::Text);
    assert!(review.text.contains("+one"));
    assert_eq!(review.token, None);

    fixture
        .action(GitAction::Stage {
            path: Some(path.into()),
        })
        .await;
    let snapshot = fixture.status().await;
    assert_eq!(
        snapshot
            .changes
            .iter()
            .filter(|change| change.staged.is_some())
            .count(),
        1
    );
    fixture
        .action(GitAction::Unstage {
            path: Some(path.into()),
        })
        .await;
    assert!(fixture
        .status()
        .await
        .changes
        .iter()
        .all(|change| change.staged.is_none()));
    fixture
        .action(GitAction::Stage {
            path: Some(path.into()),
        })
        .await;
    fixture.write(path, "two\n");
    fixture.git(&["add", "--", path]).await;
    let stale = fixture
        .repo
        .mutate(GitAction::Commit {
            token: snapshot.commit_token,
            message: "old snapshot".into(),
        })
        .await
        .unwrap_err();
    assert_eq!(stale.code, ErrorCode::Conflict);
    assert_eq!(fixture.status().await.head, None);
    fixture.commit("记录局部改动").await;

    let committed = fixture.status().await;
    let history = fixture
        .repo
        .history(committed.head.as_deref().unwrap())
        .await
        .unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].subject, "记录局部改动");
    let diff = fixture
        .repo
        .diff(GitDiffTarget::Commit {
            oid: history[0].oid.clone(),
        })
        .await
        .unwrap();
    assert!(diff.text.contains("+two"));
    fixture
        .action(GitAction::CreateBranch {
            branch: "review/topic".into(),
            token: committed.commit_token,
        })
        .await;
    let branch = fixture.status().await;
    assert_eq!(branch.branch.as_deref(), Some("review/topic"));
    fixture
        .action(GitAction::Switch {
            branch: "main".into(),
            token: branch.commit_token,
        })
        .await;
    assert_eq!(fixture.status().await.branch.as_deref(), Some("main"));

    fixture.git(&["mv", "--", path, "renamed.md"]).await;
    let status = fixture.status().await;
    let renamed = find_change(&status, "renamed.md").unwrap();
    assert_eq!(renamed.staged, Some(GitChangeKind::Renamed));
    assert_eq!(renamed.original_path.as_deref(), Some(path));
    let diff = fixture.diff("renamed.md", GitScope::Staged).await;
    assert!(diff.text.contains("rename from [a].txt"));
    fixture
        .action(GitAction::Unstage {
            path: Some("renamed.md".into()),
        })
        .await;
    let status = fixture.status().await;
    assert_eq!(
        find_change(&status, path).unwrap().working,
        Some(GitChangeKind::Deleted)
    );
    assert_eq!(
        find_change(&status, "renamed.md").unwrap().working,
        Some(GitChangeKind::Untracked)
    );
}

#[tokio::test]
async fn resolves_a_nested_directory_and_keeps_binary_and_conflicted_files_explicit() {
    let fixture = Fixture::new().await;
    fs::create_dir(fixture.path.join("sub")).unwrap();
    let nested = GitWorktree {
        directory: fixture.path.join("sub").to_str().unwrap().into(),
        runner: Runner::Local,
    };
    assert_eq!(
        nested.status().await.unwrap().unwrap().root,
        fixture.repo.directory
    );
    fixture.write("binary.dat", [0, 1, 2, 255]);
    assert_eq!(
        fixture.diff("binary.dat", GitScope::Working).await.kind,
        GitPatchKind::Binary
    );
    fixture.write("notes", "base\n");
    fixture
        .action(GitAction::Stage {
            path: Some("notes".into()),
        })
        .await;
    fixture.commit("Base").await;
    let base = fixture.status().await;
    fixture
        .action(GitAction::CreateBranch {
            branch: "conflicting".into(),
            token: base.commit_token,
        })
        .await;
    fixture.write("notes", "topic\n");
    fixture
        .action(GitAction::Stage {
            path: Some("notes".into()),
        })
        .await;
    fixture.commit("Topic").await;
    let topic = fixture.status().await;
    fixture
        .action(GitAction::Switch {
            branch: "main".into(),
            token: topic.commit_token,
        })
        .await;
    fixture.write("notes", "main\n");
    fixture
        .action(GitAction::Stage {
            path: Some("notes".into()),
        })
        .await;
    fixture.commit("Main").await;
    let merge = fixture
        .repo
        .read(&fixture.repo.directory, &["merge", "conflicting"], 8192)
        .await
        .unwrap();
    assert_eq!(merge.exit, Some(1));
    let status = fixture.status().await;
    assert!(find_change(&status, "notes").unwrap().conflicted);
    assert!(fixture
        .repo
        .mutate(GitAction::Stage { path: None })
        .await
        .is_err());
    assert!(fixture
        .repo
        .mutate(GitAction::Commit {
            token: status.commit_token,
            message: "unresolved".into()
        })
        .await
        .is_err());
    fixture.write("notes", "resolved\n");
    fixture
        .action(GitAction::Stage {
            path: Some("notes".into()),
        })
        .await;
    fixture.commit("Merge resolved").await;
    let commit = fixture.status().await.head.unwrap();
    let diff = fixture
        .repo
        .diff(GitDiffTarget::Commit { oid: commit })
        .await
        .unwrap();
    assert!(diff.text.contains("-main\n+resolved\n"));
}

#[tokio::test]
#[ignore = "dedicated loopback OpenSSH fixture with Git and POSIX sh"]
async fn real_git_worktree_over_ssh() {
    use crate::{
        file_transfer::Control,
        session::{exec, ssh},
    };
    use std::panic::{resume_unwind, AssertUnwindSafe};

    let var = |name: &str| std::env::var(name).unwrap();
    let address = var("EDGETERM_REAL_SSH_ADDR");
    let (host, port) = address.rsplit_once(':').unwrap();
    assert!(host == "127.0.0.1" || host == "localhost");
    let known_hosts =
        std::env::temp_dir().join(format!("edgeterm-git-hosts-{}", uuid::Uuid::new_v4()));
    let transport = ssh::test_transport(
        host,
        port.parse().unwrap(),
        &var("EDGETERM_REAL_SSH_USER"),
        &var("EDGETERM_REAL_SSH_KEY"),
        &known_hosts,
    )
    .await;
    let execute = |script: String| {
        let transport = transport.clone();
        async move {
            exec::run(
                transport,
                &script,
                &Control::default(),
                STATUS_LIMIT,
                READ_TIMEOUT,
            )
            .await
        }
    };
    let scratch = format!("/tmp/edgeterm-git-{}", uuid::Uuid::new_v4());
    execute(format!("mkdir -- {scratch}\n")).await.unwrap();
    let directory = format!("{scratch}/forecast's repo");
    let report = AssertUnwindSafe(async {
        execute(format!("mkdir -- {}\n", runner::quote(&directory)))
            .await
            .unwrap();
        let repo = GitWorktree {
            directory: directory.clone(),
            runner: Runner::Ssh(transport.clone()),
        };
        repo.write(&["init", "-q", "-b", "main", "--template="], None)
            .await
            .unwrap();
        for (key, value) in [
            ("user.name", "SSH Fixture"),
            ("user.email", "fixture@example.test"),
            ("commit.gpgsign", "false"),
        ] {
            repo.write(&["config", "--local", key, value], None)
                .await
                .unwrap();
        }
        let file = "引号's [file].txt";
        let location = runner::quote(&format!("{directory}/{file}"));
        execute(format!("printf '%s\\n' one two three > {location}\n"))
            .await
            .unwrap();
        let status = repo.status().await.unwrap().unwrap();
        assert_eq!(status.root, directory);
        let change = find_change(&status, file).unwrap();
        assert_eq!(change.working, Some(GitChangeKind::Untracked));
        let untracked = repo
            .diff(GitDiffTarget::File {
                file: change.selection(GitScope::Working).unwrap(),
            })
            .await
            .unwrap();
        assert!(untracked.text.contains("+three"));
        repo.mutate(GitAction::Stage {
            path: Some(file.into()),
        })
        .await
        .unwrap();
        let staged = repo.status().await.unwrap().unwrap();
        let message = "提交 'quoted' $(printf literal)\n\nContent stays literal";
        repo.mutate(GitAction::Commit {
            message: message.into(),
            token: staged.commit_token,
        })
        .await
        .unwrap();
        let head = repo.status().await.unwrap().unwrap().head.unwrap();
        let history = repo.history(&head).await.unwrap();
        assert_eq!(history[0].subject, "提交 'quoted' $(printf literal)");
        execute(format!("printf '%s\\n' one changed three > {location}\n"))
            .await
            .unwrap();
        let status = repo.status().await.unwrap().unwrap();
        let selection = find_change(&status, file)
            .unwrap()
            .selection(GitScope::Working)
            .unwrap();
        let patch = repo
            .diff(GitDiffTarget::File { file: selection })
            .await
            .unwrap();
        assert!(patch.text.contains("+changed"));
        repo.mutate(GitAction::Hunk {
            path: file.into(),
            scope: GitScope::Working,
            index: 0,
            token: patch.token.unwrap(),
        })
        .await
        .unwrap();
        let lookup = format!(":{file}");
        let index = repo
            .read(&directory, &["show", &lookup], 8192)
            .await
            .unwrap();
        assert_eq!(successful(index).unwrap(), b"one\nchanged\nthree\n");
        assert_eq!(
            repo.status().await.unwrap().unwrap().changes[0].working,
            None
        );
    })
    .catch_unwind()
    .await;
    // The only recursive removal is the UUID directory created by this test.
    let cleaned = execute(format!("rm -rf -- {scratch}\n")).await;
    let _ = fs::remove_file(known_hosts);
    if let Err(failure) = report {
        resume_unwind(failure);
    }
    cleaned.unwrap();
}
