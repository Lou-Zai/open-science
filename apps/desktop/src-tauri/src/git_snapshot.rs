use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::AppHandle;

use crate::runtime::quiet_command;

/// Serializes every snapshot commit process-wide. The frontend (on
/// `session.idle`) and several Rust record paths can all try to commit the same
/// workspace at once; without this they race on `.git/index.lock` and silently
/// drop snapshots. Workspaces are used one at a time, so a single global lock is
/// enough and each commit is quick.
fn git_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

const AUTHOR_NAME: &str = "Open Science Desktop";
const AUTHOR_EMAIL: &str = "open-science-desktop@local";

/// Files at or above this size are kept out of snapshots. Git stores every
/// version whole (binaries never delta or compress) and never reclaims the
/// space, and this app commits on *every* run — so the worst case is one large
/// file that changes each run: its history cost is roughly `runs * threshold`.
/// At 20 MB that caps the worst case near 2 GB per 100 runs, while still
/// versioning the outputs users actually want (plots, notebooks, typical CSVs,
/// small models — nearly all < 20 MB). Datasets, checkpoints, and media, which
/// belong in external storage anyway, are excluded. The guard is size-based,
/// not extension-based, so a small `.mp4` is kept and a huge `.csv` is not.
const MAX_BLOB_BYTES: u64 = 20 * 1024 * 1024;

/// The per-file guard above is blind to the other fatal bloat pattern: a dataset
/// of *thousands of small files* (copied-in images, audio clips, per-sample
/// `.json`/`.npy`), each under `MAX_BLOB_BYTES` yet enormous in aggregate. So we
/// also drop any single directory whose freshly-staged contents sum to at least
/// this much. Grouping is by immediate parent directory, so a bulky `data/`
/// never drags down a sibling source tree; a normal code directory (a few MB of
/// text) never trips it, while a copied dataset does. Format-agnostic, and a
/// companion to the media-extension ignores which handle the thin-spread case.
const MAX_DIR_BYTES: u64 = 50 * 1024 * 1024;

/// Default ignore rules planted when WE create a snapshot repo. A `.gitignore`
/// the user already placed in the workspace is left untouched.
///
/// Principle: this is a provenance tool, so we only exclude paths with *no*
/// reproducibility value (OS junk, editor scratch, dependency/env dirs, caches,
/// tooling debug logs) plus secrets that must never be committed. Research
/// outputs — data, figures, notebooks, models, code — are deliberately NOT
/// ignored; anything genuinely too big is caught by the >= 100 MB size guard,
/// which is format-agnostic (a small `.mp4` is kept, a huge `.csv` is not).
const DEFAULT_GITIGNORE: &str = "\
# Managed by Open Science Desktop.
# Excludes paths with no provenance value plus secrets that must never be
# committed. Research outputs, data, notebooks, and code are intentionally kept;
# files >= 100 MB are dropped by the snapshot size guard, not by this list.

# --- Secrets / credentials (API keys live in the OS keychain, never in git) ---
.env
.env.*
!.env.example
!.env.sample
!.env.template
*.pem
*.key
*.p12
*.pfx
id_rsa
id_dsa
id_ecdsa
id_ed25519
.netrc
credentials.json
secrets.json
service-account*.json
.aws/
.gcloud/

# --- macOS ---
.DS_Store
.DS_Store?
._*
.AppleDouble
.LSOverride
.Spotlight-V100
.Trashes

# --- Windows ---
Thumbs.db
ehthumbs.db
ehthumbs_vista.db
Desktop.ini
$RECYCLE.BIN/

# --- Linux ---
.fuse_hidden*
.Trash-*
.nfs*

# --- Editors / IDEs ---
.vscode/
.idea/
*.swp
*.swo
*.swn
.*.swp
*~
*.sublime-workspace

# --- Python ---
__pycache__/
*.py[cod]
*$py.class
.Python
.venv/
venv/
env/
ENV/
.eggs/
*.egg-info/
.pytest_cache/
.mypy_cache/
.dmypy.json
.pyre/
.pytype/
.ruff_cache/
.tox/
.nox/
.coverage
.coverage.*
htmlcov/
.hypothesis/
cython_debug/
.ipynb_checkpoints/

# --- Conda ---
.conda/

# --- R ---
.Rhistory
.RData
.Rproj.user/
.Ruserdata

# --- Node / JS ---
node_modules/
.npm/
.yarn/
.pnpm-store/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# --- Temp / caches ---
*.tmp
*.temp
*.bak
.cache/
tmp/
.tmp/

# --- Bulk binary media (images / audio / video) ---
# These arrive in the thousands (a copied image or audio dataset) and each file
# is usually well under the 20 MB per-file size guard, so that guard can't stop
# them — thousands of small binaries would bloat history fatally, and git can
# neither delta nor compress them. They are also almost always either raw data
# or a regenerable render, not source. Text/vector figures (.svg) and documents
# (.pdf) are kept — they are small, versionable, and usually authored output.
# Notebook plots are embedded in the versioned .ipynb already. Delete a line
# below if that medium is your primary data and you want it in snapshots.
# Video
*.mp4
*.m4v
*.mov
*.avi
*.mkv
*.webm
*.wmv
*.flv
*.mpg
*.mpeg
*.ogv
*.3gp
# Images (raster)
*.jpg
*.jpeg
*.png
*.gif
*.bmp
*.tif
*.tiff
*.webp
*.heic
*.heif
*.ico
*.psd
*.raw
*.cr2
*.nef
*.arw
*.dng
# Audio
*.wav
*.flac
*.aac
*.m4a
*.mp3
*.ogg
*.oga
*.wma
*.aiff
*.aif
";

fn git(root: &Path) -> std::process::Command {
    let mut cmd = quiet_command("git");
    cmd.current_dir(root)
        .env("GIT_AUTHOR_NAME", AUTHOR_NAME)
        .env("GIT_AUTHOR_EMAIL", AUTHOR_EMAIL)
        .env("GIT_COMMITTER_NAME", AUTHOR_NAME)
        .env("GIT_COMMITTER_EMAIL", AUTHOR_EMAIL);
    cmd
}

pub fn git_available() -> bool {
    quiet_command("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn run(root: &Path, args: &[&str]) -> Result<(), String> {
    let out = git(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!(
        "git {} failed{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        },
    ))
}

/// Like `run`, but returns captured stdout bytes on success.
fn capture(root: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let out = git(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {} failed to start: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!(
        "git {} failed{}",
        args.join(" "),
        if stderr.is_empty() {
            String::new()
        } else {
            format!(": {stderr}")
        },
    ))
}

/// After `git add -A`, drop any staged file at/over `MAX_BLOB_BYTES` back out of
/// the index (keeping it on disk) so it never enters git history. `git reset --
/// <path>` reverts the index entry to HEAD, which both removes a brand-new large
/// file and preserves the previously committed version of one that just grew —
/// and it works on an unborn branch (first commit) too.
fn unstage_oversized(root: &Path) -> Result<(), String> {
    let stdout = capture(root, &["diff", "--cached", "--name-only", "-z"])?;
    let mut skipped: Vec<String> = Vec::new();
    for name in stdout.split(|b| *b == 0) {
        if name.is_empty() {
            continue;
        }
        let rel = String::from_utf8_lossy(name).into_owned();
        // A staged deletion has no working-tree file; metadata fails and we skip
        // it, which correctly leaves the deletion staged.
        if let Ok(meta) = std::fs::metadata(root.join(&rel)) {
            if meta.is_file() && meta.len() >= MAX_BLOB_BYTES {
                skipped.push(rel);
            }
        }
    }
    if skipped.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["reset", "--quiet", "--"];
    args.extend(skipped.iter().map(|s| s.as_str()));
    run(root, &args)?;
    eprintln!(
        "workspace snapshot: skipped {} file(s) >= {} MB: {}",
        skipped.len(),
        MAX_BLOB_BYTES / (1024 * 1024),
        skipped.join(", ")
    );
    Ok(())
}

/// Drop any directory whose freshly-staged files sum to >= `MAX_DIR_BYTES` back
/// out of the index (files stay on disk). Catches bulk data dumps — thousands of
/// small files that individually slip past `unstage_oversized`. Grouped by
/// immediate parent directory so one bulky folder can't take a sibling with it;
/// root-level files (no parent dir) are left alone since we would never reset
/// the whole workspace.
fn unstage_bulk_dirs(root: &Path) -> Result<(), String> {
    use std::collections::BTreeMap;
    let stdout = capture(root, &["diff", "--cached", "--name-only", "-z"])?;
    let mut by_dir: BTreeMap<String, u64> = BTreeMap::new();
    for name in stdout.split(|b| *b == 0) {
        if name.is_empty() {
            continue;
        }
        let rel = String::from_utf8_lossy(name).into_owned();
        // git always emits forward slashes here. No slash => file at repo root.
        let Some(idx) = rel.rfind('/') else { continue };
        let dir = rel[..idx].to_string();
        let size = std::fs::metadata(root.join(&rel))
            .map(|m| if m.is_file() { m.len() } else { 0 })
            .unwrap_or(0);
        *by_dir.entry(dir).or_insert(0) += size;
    }
    let bulky: Vec<(String, u64)> = by_dir
        .into_iter()
        .filter(|(_, bytes)| *bytes >= MAX_DIR_BYTES)
        .collect();
    if bulky.is_empty() {
        return Ok(());
    }
    for (dir, _) in &bulky {
        run(root, &["reset", "--quiet", "--", dir])?;
    }
    let summary = bulky
        .iter()
        .map(|(d, b)| format!("{d}/ ({} MB)", b / (1024 * 1024)))
        .collect::<Vec<_>>()
        .join(", ");
    eprintln!(
        "workspace snapshot: skipped {} bulk director{} (>= {} MB staged): {}",
        bulky.len(),
        if bulky.len() == 1 { "y" } else { "ies" },
        MAX_DIR_BYTES / (1024 * 1024),
        summary
    );
    Ok(())
}

/// Written inside `.git` the first time WE create a snapshot repo. Its presence
/// is how we recognize an app-managed repo that is safe to `add -A`/commit into;
/// we never touch a git repository the user brought into the workspace himself.
fn snapshot_marker(root: &Path) -> PathBuf {
    root.join(".git").join(".openscience-snapshots")
}

/// Written under a workspace's `.openscience/` to opt it out of app-managed
/// snapshots entirely — used for IMPORTED workspaces (a repo/folder the user
/// brought in) so the app never `git init`s or commits into it, even when the
/// folder isn't a git repo yet.
const NO_SNAPSHOT_MARKER: &str = ".no-snapshots";

fn no_snapshot_marker(root: &Path) -> PathBuf {
    root.join(".openscience").join(NO_SNAPSHOT_MARKER)
}

/// Prepare an IMPORTED (user-brought) workspace so the app never auto-commits
/// into it. A real git repo is already safe (our commit path skips any repo
/// without the snapshot marker); there we only keep the app's `.openscience/`
/// dir out of the user's `git status` via a local `.git/info/exclude` (never
/// their tracked `.gitignore`). A plain folder gets an explicit opt-out marker
/// so a later commit never `git init`s it. Best-effort; failures are non-fatal.
pub fn mark_imported(root: &Path) {
    if root.join(".git").is_dir() {
        exclude_locally(root, ".openscience/");
    } else {
        let osdir = root.join(".openscience");
        let _ = std::fs::create_dir_all(&osdir);
        let _ = std::fs::write(no_snapshot_marker(root), b"imported\n");
    }
}

/// Append a pattern to `.git/info/exclude` (a local, untracked ignore that does
/// not modify the user's committed `.gitignore`) unless already present.
fn exclude_locally(root: &Path, pattern: &str) {
    let exclude = root.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == pattern) {
        return;
    }
    if let Some(parent) = exclude.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(pattern);
    content.push('\n');
    let _ = std::fs::write(&exclude, content);
}

/// Ensure an app-owned snapshot repo exists. Returns `Ok(false)` when the folder
/// already holds a git repo we did not create, or is an imported workspace —
/// the caller must then NOT commit, so the user's own history and staged work
/// are left untouched.
fn ensure_owned_repo(root: &Path) -> Result<bool, String> {
    if !git_available() {
        return Err("git is not available".into());
    }
    // An imported workspace opts out of app-managed snapshots entirely — never
    // `git init` it and never commit, whether or not it is a git repo.
    if no_snapshot_marker(root).exists() {
        return Ok(false);
    }
    if root.join(".git").exists() {
        // A pre-existing repo is only ours if we planted the marker at init.
        return Ok(snapshot_marker(root).exists());
    }
    run(root, &["init"])?;
    std::fs::write(snapshot_marker(root), b"1")
        .map_err(|e| format!("could not mark snapshot repo: {e}"))?;
    // Plant sensible ignores for our fresh repo, but never clobber a
    // .gitignore the workspace already contains.
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        std::fs::write(&gitignore, DEFAULT_GITIGNORE)
            .map_err(|e| format!("could not write .gitignore: {e}"))?;
    }
    Ok(true)
}

pub fn commit(root: &Path, message: &str) -> Result<bool, String> {
    let _lock = git_lock().lock().map_err(|_| "git snapshot lock poisoned".to_string())?;
    if !ensure_owned_repo(root)? {
        // Not an app-managed repo — never commit into the user's own history.
        return Ok(false);
    }
    run(root, &["add", "-A", "--", "."])?;
    unstage_oversized(root)?;
    unstage_bulk_dirs(root)?;
    let status = git(root)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .map_err(|e| format!("git diff failed to start: {e}"))?;
    if status.success() {
        return Ok(false);
    }
    run(root, &["commit", "-m", message])?;
    Ok(true)
}

pub fn commit_best_effort(root: &Path, message: &str) {
    if let Err(e) = commit(root, message) {
        eprintln!("workspace git snapshot skipped: {e}");
    }
}

// ---------------------------------------------------------------------------
// Debounced background snapshotter
//
// Committing inline on every file add ran git (a subprocess) on the UI thread
// and produced one commit per file — a directory added file-by-file became
// dozens of commits in seconds and froze the window (issue #32). Instead,
// callers and the workspace watcher *request* a snapshot; a single background
// thread coalesces requests and commits at most once per quiet window, off the
// main thread.
// ---------------------------------------------------------------------------

/// Trailing quiet window: commit this long after the LAST change so a burst of
/// writes coalesces into one snapshot. Comfortably longer than the ~1 s spacing
/// seen when an agent adds a directory file-by-file, so those collapse to one.
const SNAPSHOT_DEBOUNCE: Duration = Duration::from_secs(3);

/// Starvation cap: while changes keep arriving, commit at least this often so a
/// long-running writer (a detached job appending logs) still leaves periodic
/// snapshots instead of none until it stops.
const SNAPSHOT_MAX_WAIT: Duration = Duration::from_secs(30);

/// A root with a pending snapshot: when its first and most-recent requests came.
#[derive(Clone, Copy)]
struct PendingSnapshot {
    first: Instant,
    last: Instant,
}

/// Whether a pending snapshot is due: the quiet window elapsed since the last
/// request (debounce), or the max wait elapsed since the first (starvation cap).
/// Pure, so the timing policy is unit-testable without threads or real sleeps.
fn snapshot_due(since_last: Duration, since_first: Duration) -> bool {
    since_last >= SNAPSHOT_DEBOUNCE || since_first >= SNAPSHOT_MAX_WAIT
}

fn snapshot_tx() -> &'static Sender<PathBuf> {
    static TX: OnceLock<Sender<PathBuf>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<PathBuf>();
        if let Err(e) = std::thread::Builder::new()
            .name("git-snapshot".into())
            .spawn(move || snapshot_loop(rx))
        {
            eprintln!("workspace snapshot: could not start snapshot thread: {e}");
        }
        tx
    })
}

/// Request a debounced snapshot of `root`. Returns immediately; the commit runs
/// on the background snapshot thread after the quiet window. Safe to call from
/// the UI thread and from the filesystem-watcher callback.
pub fn request_snapshot(root: &Path) {
    let _ = snapshot_tx().send(root.to_path_buf());
}

fn snapshot_loop(rx: Receiver<PathBuf>) {
    let mut pending: HashMap<PathBuf, PendingSnapshot> = HashMap::new();
    loop {
        // Wait until the nearest deadline, or indefinitely when nothing pends.
        let timeout = pending
            .values()
            .map(|p| {
                let by_debounce = SNAPSHOT_DEBOUNCE.saturating_sub(p.last.elapsed());
                let by_max = SNAPSHOT_MAX_WAIT.saturating_sub(p.first.elapsed());
                by_debounce.min(by_max)
            })
            .min()
            .unwrap_or(Duration::from_secs(3600));
        match rx.recv_timeout(timeout) {
            Ok(root) => {
                let now = Instant::now();
                pending
                    .entry(root)
                    .and_modify(|p| p.last = now)
                    .or_insert(PendingSnapshot { first: now, last: now });
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return,
        }
        let due: Vec<PathBuf> = pending
            .iter()
            .filter(|(_, p)| snapshot_due(p.last.elapsed(), p.first.elapsed()))
            .map(|(root, _)| root.clone())
            .collect();
        for root in due {
            pending.remove(&root);
            commit_best_effort(&root, "Snapshot workspace changes");
        }
    }
}

// ---------------------------------------------------------------------------
// Workspace filesystem watcher
//
// Explicit call sites (file adds, session-idle) cannot see every change — a
// user editing a file in an external editor, or a process the agent detached
// that writes output after the turn ended, bypasses all of them. So we also
// watch the active workspace and enqueue a debounced snapshot on any change,
// ignoring writes under `.git/` (our own commits) to avoid a feedback loop.
// ---------------------------------------------------------------------------

#[allow(clippy::type_complexity)]
fn workspace_watcher() -> &'static Mutex<Option<(RecommendedWatcher, PathBuf)>> {
    static W: OnceLock<Mutex<Option<(RecommendedWatcher, PathBuf)>>> = OnceLock::new();
    W.get_or_init(|| Mutex::new(None))
}

/// Watch `root` recursively and enqueue debounced snapshots on change, replacing
/// any previous watch. Best-effort: a watcher that fails to start just means
/// snapshots fall back to the explicit call sites. Call on startup and whenever
/// the active workspace changes.
pub fn watch_workspace(root: &Path) {
    let Ok(mut slot) = workspace_watcher().lock() else {
        return;
    };
    if slot.as_ref().is_some_and(|(_, cur)| cur == root) {
        return; // already watching this root
    }
    let cb_root = root.to_path_buf();
    let handler = move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Access (read/open) events never change content — ignore them.
        if matches!(event.kind, EventKind::Access(_)) {
            return;
        }
        // Ignore our own git writes; committing must not retrigger a snapshot.
        let under_git = event
            .paths
            .iter()
            .any(|p| p.components().any(|c| c.as_os_str() == ".git"));
        if under_git {
            return;
        }
        request_snapshot(&cb_root);
    };
    let mut watcher = match notify::recommended_watcher(handler) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("workspace watcher: could not create: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
        eprintln!("workspace watcher: could not watch {}: {e}", root.display());
        return;
    }
    // Hold the watcher alive in the slot; dropping the old one stops its watch.
    *slot = Some((watcher, root.to_path_buf()));
}

#[tauri::command(async)]
pub fn commit_workspace_snapshot(app: AppHandle, message: String) -> Result<bool, String> {
    let root = crate::runtime::workspace_dir(&app)?;
    commit(&root, &message)
}

#[cfg(test)]
mod tests {
    use super::{commit, git_available, snapshot_due, SNAPSHOT_DEBOUNCE, SNAPSHOT_MAX_WAIT};
    use std::fs;
    use std::time::Duration;

    #[test]
    fn snapshot_due_debounces_bursts_but_caps_at_max_wait() {
        // Still within the quiet window since the last change → hold (coalesce).
        assert!(!snapshot_due(Duration::from_millis(500), Duration::from_secs(2)));
        // Quiet window elapsed since the last change → fire (debounce).
        assert!(snapshot_due(SNAPSHOT_DEBOUNCE, Duration::from_secs(5)));
        // Changes still arriving, but the max wait elapsed → fire (no starvation).
        assert!(snapshot_due(Duration::from_millis(100), SNAPSHOT_MAX_WAIT));
    }

    #[test]
    fn commit_initializes_repo_and_skips_clean_tree() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-snapshot-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "rules\n").unwrap();

        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        assert!(root.join(".git").is_dir());
        assert_eq!(commit(&root, "No changes").unwrap(), false);

        fs::write(root.join("AGENTS.md"), "rules\nmore\n").unwrap();
        assert_eq!(commit(&root, "Update workspace").unwrap(), true);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_skips_oversized_files_but_keeps_them_on_disk() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-big-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("small.txt"), "keep me\n").unwrap();
        fs::write(root.join("big.bin"), vec![0u8; super::MAX_BLOB_BYTES as usize]).unwrap();

        // The small file is committed; the oversized one is not.
        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        let tracked = super::capture(&root, &["ls-files"]).unwrap();
        let tracked = String::from_utf8_lossy(&tracked);
        assert!(tracked.contains("small.txt"));
        assert!(!tracked.contains("big.bin"));
        // But the big file is left untouched on disk.
        assert!(root.join("big.bin").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_skips_bulk_directory_of_small_files() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-bulk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dataset")).unwrap();
        // A source file at root that must survive.
        fs::write(root.join("train.py"), "print('hi')\n").unwrap();
        // Four 15 MB files: each is under the 20 MB per-file guard, but together
        // the directory is 60 MB, over the 50 MB directory guard.
        let chunk = vec![0u8; 15 * 1024 * 1024];
        for i in 0..4 {
            fs::write(root.join("dataset").join(format!("sample_{i}.dat")), &chunk).unwrap();
        }

        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        let tracked = super::capture(&root, &["ls-files"]).unwrap();
        let tracked = String::from_utf8_lossy(&tracked);
        assert!(tracked.contains("train.py"));
        assert!(!tracked.contains("dataset/"));
        // Files are only unstaged, never removed from disk.
        assert!(root.join("dataset").join("sample_0.dat").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_writes_default_gitignore_on_fresh_repo() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-ignore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "rules\n").unwrap();

        assert_eq!(commit(&root, "Initialize workspace").unwrap(), true);
        let gitignore = fs::read_to_string(root.join(".gitignore")).unwrap();
        assert!(gitignore.contains("node_modules/"));
        assert!(gitignore.contains(".env"));
        assert!(gitignore.contains("*.mp4"));
        assert!(gitignore.contains("*.png"));
        assert!(gitignore.contains("*.wav"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn commit_never_touches_a_repo_the_user_brought() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-foreign-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A repo the user brought in: it has a .git but none of our marker.
        super::run(&root, &["init"]).unwrap();
        fs::write(root.join("data.txt"), "user work in progress\n").unwrap();

        // We must decline it, leave the tree/index alone, and plant no marker.
        assert_eq!(commit(&root, "should be skipped").unwrap(), false);
        assert!(!super::snapshot_marker(&root).exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn imported_plain_folder_is_never_initialized_or_committed() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-imported-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("notes.md"), "brought-in work\n").unwrap();

        // Importing a plain (non-repo) folder opts it out of snapshots.
        super::mark_imported(&root);
        assert!(super::no_snapshot_marker(&root).exists());

        // A later commit must NOT `git init` it and must NOT commit.
        assert_eq!(commit(&root, "should be skipped").unwrap(), false);
        assert!(!root.join(".git").exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn importing_a_repo_keeps_it_pristine_and_excludes_the_provenance_dir() {
        if !git_available() {
            eprintln!("git unavailable; skipping git snapshot test");
            return;
        }
        let root = std::env::temp_dir().join(format!("os-git-imported-repo-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        super::run(&root, &["init"]).unwrap();

        super::mark_imported(&root);
        // A real repo isn't given the opt-out marker (marker-absence already
        // makes commit() skip it) but gets a LOCAL exclude for .openscience/.
        assert!(!super::no_snapshot_marker(&root).exists());
        let exclude = fs::read_to_string(root.join(".git/info/exclude")).unwrap();
        assert!(exclude.lines().any(|l| l.trim() == ".openscience/"));

        // Still declined by commit(), user's history untouched, and idempotent.
        assert_eq!(commit(&root, "should be skipped").unwrap(), false);
        super::mark_imported(&root); // no duplicate exclude line
        let count = fs::read_to_string(root.join(".git/info/exclude"))
            .unwrap()
            .lines()
            .filter(|l| l.trim() == ".openscience/")
            .count();
        assert_eq!(count, 1);
        let _ = fs::remove_dir_all(&root);
    }
}
