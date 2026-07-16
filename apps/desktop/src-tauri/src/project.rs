// Projects: a named workspace folder under the base dir, marked by
// `<folder>/.openscience/project.json`. The folder IS the workspace — sessions
// group under a project by their `directory`, so no registry or database
// exists to drift out of sync. Folders without the marker stay plain dated
// session workspaces.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::runtime::{base_workspace_dir, random_hex};

#[derive(Serialize, Deserialize, Clone)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    pub version: u32,
    /// For an IMPORTED project: the external repo/folder this project points at.
    /// The project's stub folder under the base dir holds only this metadata; the
    /// user's own repo is never written to. Absent for app-created projects,
    /// whose workspace IS their base-dir folder.
    #[serde(rename = "sourcePath", default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    /// Pinned projects always show in the sidebar (the rest show only the most
    /// recent few). Absent = not pinned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<bool>,
}

/// What the frontend consumes: the metadata plus the folder it lives in.
#[derive(Serialize)]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    /// Absolute workspace folder (canonical, matches session `directory`). For an
    /// imported project this is the external repo, not the stub folder.
    pub path: String,
    /// True when this project points at a user-brought external repo/folder. The
    /// app never auto-commits into an imported workspace.
    pub imported: bool,
    /// Whether this project is pinned to the sidebar.
    pub pinned: bool,
}

fn meta_file(dir: &Path) -> PathBuf {
    dir.join(".openscience").join("project.json")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A corrupt or missing project.json makes the folder a plain workspace again
/// — never an error the UI has to handle.
fn read_meta(dir: &Path) -> Option<ProjectMeta> {
    let text = std::fs::read_to_string(meta_file(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_meta(dir: &Path, meta: &ProjectMeta) -> Result<(), String> {
    let file = meta_file(dir);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    std::fs::write(&file, json).map_err(|e| e.to_string())
}

/// Project name → folder name: one path segment, no whitespace (the agent runs
/// unquoted shell commands against workspace paths), no path-unsafe characters.
/// Unicode (e.g. CJK project names) passes through untouched.
fn folder_slug(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            c if c.is_whitespace() => '-',
            c => c,
        })
        .collect();
    let collapsed = cleaned
        .split('-')
        .filter(|s| !s.is_empty() && !s.chars().all(|c| c == '.'))
        .collect::<Vec<_>>()
        .join("-");
    let trimmed = collapsed.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "project".into()
    } else {
        trimmed
    }
}

fn info_of(meta: ProjectMeta, dir: &Path) -> ProjectInfo {
    // An imported project's workspace is its external source; an app-created
    // project's workspace is its own base-dir folder.
    let imported = meta.source_path.is_some();
    let target = meta
        .source_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| dir.to_path_buf());
    let canon = target.canonicalize().unwrap_or(target);
    ProjectInfo {
        id: meta.id,
        name: meta.name,
        description: meta.description,
        created_at: meta.created_at,
        path: canon.to_string_lossy().to_string(),
        imported,
        pinned: meta.pinned.unwrap_or(false),
    }
}

/// Create the folder + metadata under `base`. Split from the command so the
/// filesystem logic is unit-testable without an AppHandle.
fn create_in(base: &Path, name: &str) -> Result<(PathBuf, ProjectMeta), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name is empty".into());
    }
    let slug = folder_slug(name);
    let mut dir = base.join(&slug);
    for n in 2..100 {
        if !dir.exists() {
            break;
        }
        dir = base.join(format!("{slug}-{n}"));
    }
    if dir.exists() {
        return Err(format!("a folder named \"{slug}\" already exists"));
    }
    let meta = ProjectMeta {
        id: random_hex(8),
        name: name.to_string(),
        description: None,
        created_at: now_ms(),
        version: 1,
        source_path: None,
        pinned: None,
    };
    write_meta(&dir, &meta)?;
    Ok((dir, meta))
}

/// Create a project: a fresh folder under the base dir with project metadata,
/// the agent harness, and an initial git snapshot — the same scaffold a dated
/// session workspace gets. Does NOT switch the active workspace; the frontend
/// decides when to move into it.
#[tauri::command(async)]
pub fn create_project(app: AppHandle, name: String) -> Result<ProjectInfo, String> {
    let base = base_workspace_dir(&app)?;
    let (dir, meta) = create_in(&base, &name)?;
    crate::harness::seed_harness(&app, &dir);
    crate::git_snapshot::commit_best_effort(&dir, "Initialize project");
    Ok(info_of(meta, &dir))
}

/// Import an EXISTING repo/folder as a project, referenced in place. Only a
/// lightweight pointer (a stub folder under the base dir holding project.json
/// with `sourcePath`) is created — the user's repo itself is not moved, not
/// scaffolded with the harness, and never auto-committed into (see
/// `git_snapshot::mark_imported`). The workspace the app operates in is the
/// external `source` path.
#[tauri::command(async)]
pub fn import_project(app: AppHandle, path: String) -> Result<ProjectInfo, String> {
    let base = base_workspace_dir(&app)?;
    let source = PathBuf::from(path.trim());
    if path.trim().is_empty() || !source.is_dir() {
        return Err("the selected folder does not exist".into());
    }
    let source = source.canonicalize().unwrap_or(source);
    // Guard: importing a folder that is (or sits under) the app's own base dir
    // would double-track an app-managed workspace — use "New project" for those.
    if let Ok(base_canon) = base.canonicalize() {
        if source == base_canon || source.starts_with(&base_canon) {
            return Err("this folder is already managed by the app; use New project instead".into());
        }
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "imported".into());
    // The stub project folder lives under base and holds ONLY the pointer — the
    // imported repo is never written a project.json.
    let (dir, mut meta) = create_in(&base, &name)?;
    meta.source_path = Some(source.to_string_lossy().to_string());
    write_meta(&dir, &meta)?;
    // Keep the imported repo pristine and out of auto-commit.
    crate::git_snapshot::mark_imported(&source);
    Ok(info_of(meta, &dir))
}

/// Every project under the base dir (first-level folders carrying a readable
/// project.json), sorted by name for a stable sidebar.
#[tauri::command(async)]
pub fn list_projects(app: AppHandle) -> Result<Vec<ProjectInfo>, String> {
    let base = base_workspace_dir(&app)?;
    let mut out: Vec<ProjectInfo> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            if let Some(meta) = read_meta(&dir) {
                // An imported project whose external source has since been moved
                // or deleted is unusable — drop it rather than list a dead entry.
                if let Some(src) = meta.source_path.as_ref() {
                    if !Path::new(src).is_dir() {
                        continue;
                    }
                }
                out.push(info_of(meta, &dir));
            }
        }
    }
    out.sort_by_key(|p| p.name.to_lowercase());
    Ok(out)
}

/// The base-dir folder holding the metadata for project `id` (its stub, for an
/// imported project — NOT the external source, which never carries a project.json).
fn project_dir_by_id(base: &Path, id: &str) -> Option<PathBuf> {
    std::fs::read_dir(base).ok()?.flatten().find_map(|entry| {
        let dir = entry.path();
        match read_meta(&dir) {
            Some(meta) if meta.id == id => Some(dir),
            _ => None,
        }
    })
}

/// Rename the project's display name only — keyed by project id, since an
/// imported project's metadata lives in its base-dir stub, not at its (external)
/// workspace path. The folder never moves, so session `directory` grouping stays
/// intact.
#[tauri::command(async)]
pub fn rename_project(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("project name is empty".into());
    }
    let base = base_workspace_dir(&app)?;
    let dir = project_dir_by_id(&base, &id).ok_or("project not found")?;
    let mut meta = read_meta(&dir).ok_or("not a project folder")?;
    meta.name = name.to_string();
    write_meta(&dir, &meta)
}

fn set_pinned_in(base: &Path, id: &str, pinned: bool) -> Result<(), String> {
    let dir = project_dir_by_id(base, id).ok_or("project not found")?;
    let mut meta = read_meta(&dir).ok_or("not a project folder")?;
    meta.pinned = if pinned { Some(true) } else { None };
    write_meta(&dir, &meta)
}

/// Pin/unpin a project (pinned projects always show in the sidebar).
#[tauri::command(async)]
pub fn set_project_pinned(app: AppHandle, id: String, pinned: bool) -> Result<(), String> {
    set_pinned_in(&base_workspace_dir(&app)?, &id, pinned)
}

/// Remove a project from the app's index WITHOUT deleting the user's files.
/// - Imported project: its base-dir folder is only a stub pointer (no user
///   files) → remove the stub; the external repo is untouched.
/// - App-created project: the folder holds the workspace files → remove only the
///   `.openscience/project.json` marker, demoting it to a plain folder. Nothing
///   else on disk is deleted.
fn delete_in(base: &Path, id: &str) -> Result<(), String> {
    let dir = project_dir_by_id(base, id).ok_or("project not found")?;
    let meta = read_meta(&dir).ok_or("not a project folder")?;
    // Guard: only ever touch paths under the app's base dir.
    let base_canon = base.canonicalize().unwrap_or_else(|_| base.to_path_buf());
    if dir.canonicalize().map(|d| !d.starts_with(&base_canon)).unwrap_or(true) {
        return Err("refusing to delete a project outside the base dir".into());
    }
    if meta.source_path.is_some() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
    } else {
        let marker = meta_file(&dir);
        if marker.exists() {
            std::fs::remove_file(&marker).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

#[tauri::command(async)]
pub fn delete_project(app: AppHandle, id: String) -> Result<(), String> {
    delete_in(&base_workspace_dir(&app)?, &id)
}

/// Open a project's workspace folder in the OS file manager (Finder / Explorer /
/// Linux file manager, via the `opener` crate). The folder is resolved from the
/// project's own metadata — an app-created project's folder, or an imported
/// project's external source — so the frontend passes only the id, never a raw
/// path (no arbitrary-path open).
#[tauri::command(async)]
pub fn open_project_folder(app: AppHandle, id: String) -> Result<(), String> {
    let base = base_workspace_dir(&app)?;
    let dir = project_dir_by_id(&base, &id).ok_or("project not found")?;
    let meta = read_meta(&dir).ok_or("not a project folder")?;
    let target = meta.source_path.map(PathBuf::from).unwrap_or(dir);
    crate::artifact_file::os_open(&target)
}

#[cfg(test)]
mod tests {
    use super::{create_in, folder_slug, read_meta};
    use std::fs;

    #[test]
    fn slug_is_one_safe_path_segment() {
        assert_eq!(folder_slug("BCI Trends 2026"), "BCI-Trends-2026");
        assert_eq!(folder_slug("  a/b\\c:d  "), "a-b-c-d");
        assert_eq!(folder_slug("脑机接口趋势"), "脑机接口趋势");
        assert_eq!(folder_slug("..."), "project");
        assert_eq!(folder_slug(""), "project");
        assert_eq!(folder_slug("../etc"), "etc"); // no traversal segments survive
    }

    #[test]
    fn create_writes_meta_and_dedupes_folder_names() {
        let base = std::env::temp_dir().join(format!("os-project-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        let (dir1, meta1) = create_in(&base, "My Study").unwrap();
        assert_eq!(dir1, base.join("My-Study"));
        assert_eq!(meta1.name, "My Study");
        let read = read_meta(&dir1).unwrap();
        assert_eq!(read.id, meta1.id);
        assert_eq!(read.version, 1);

        // Same name again → a distinct folder, its own identity.
        let (dir2, meta2) = create_in(&base, "My Study").unwrap();
        assert_eq!(dir2, base.join("My-Study-2"));
        assert_ne!(meta2.id, meta1.id);

        assert!(create_in(&base, "   ").is_err());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn imported_project_points_at_its_external_source_without_writing_into_it() {
        use super::{info_of, write_meta};
        let base = std::env::temp_dir().join(format!("os-project-import-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        // An external repo/folder the user brings in (canonicalizable on disk).
        let ext = base.join("external-repo");
        fs::create_dir_all(&ext).unwrap();

        // A stub under base holds only the pointer metadata.
        let (stub, mut meta) = create_in(&base, "external-repo").unwrap();
        meta.source_path = Some(ext.to_string_lossy().to_string());
        write_meta(&stub, &meta).unwrap();

        // The pointer round-trips from disk…
        let reloaded = read_meta(&stub).unwrap();
        assert_eq!(reloaded.source_path.as_deref(), Some(ext.to_string_lossy().as_ref()));

        // …and info_of resolves the workspace to the EXTERNAL source, flagged imported.
        let info = info_of(reloaded, &stub);
        assert!(info.imported);
        assert_eq!(info.path, ext.canonicalize().unwrap().to_string_lossy());

        // Nothing was written into the user's repo (metadata lives in the stub).
        assert!(!ext.join(".openscience").join("project.json").exists());

        // An app-created project (no source) is not imported and lives in its folder.
        let (own, own_meta) = create_in(&base, "My Study").unwrap();
        let own_info = info_of(read_meta(&own).unwrap(), &own);
        assert!(!own_info.imported);
        assert_eq!(own_info.path, own.canonicalize().unwrap().to_string_lossy());
        let _ = own_meta;

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn rename_resolves_the_stub_by_id_even_for_an_import() {
        use super::{project_dir_by_id, write_meta};
        let base = std::env::temp_dir().join(format!("os-project-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let ext = base.join("my-repo-src");
        fs::create_dir_all(&ext).unwrap();

        // An imported project: stub under base, pointer to the external source.
        let (stub, mut meta) = create_in(&base, "my-repo").unwrap();
        meta.source_path = Some(ext.to_string_lossy().to_string());
        write_meta(&stub, &meta).unwrap();

        // Resolved by id → the STUB (where meta lives), never the external source.
        assert_eq!(project_dir_by_id(&base, &meta.id).as_deref(), Some(stub.as_path()));
        assert!(project_dir_by_id(&base, "nope").is_none());

        // Renaming rewrites the stub's meta; the user's repo is never written to.
        let mut m = read_meta(&stub).unwrap();
        m.name = "Renamed".into();
        write_meta(&stub, &m).unwrap();
        assert_eq!(read_meta(&stub).unwrap().name, "Renamed");
        assert!(!ext.join(".openscience").join("project.json").exists());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn delete_removes_the_index_but_keeps_files() {
        use super::{delete_in, set_pinned_in, write_meta};
        let base = std::env::temp_dir().join(format!("os-project-del-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        // App-created project with real workspace files.
        let (own, own_meta) = create_in(&base, "My Study").unwrap();
        fs::write(own.join("train.py"), "print(1)\n").unwrap();
        // Deleting removes only the project marker; the folder + files remain.
        delete_in(&base, &own_meta.id).unwrap();
        assert!(read_meta(&own).is_none()); // no longer a project
        assert!(own.join("train.py").exists()); // user's files untouched
        assert!(own.is_dir());

        // Imported project: stub under base points at an external repo.
        let ext = base.join("ext-repo");
        fs::create_dir_all(&ext).unwrap();
        fs::write(ext.join("keep.txt"), "user data\n").unwrap();
        let (stub, mut meta) = create_in(&base, "ext-repo-proj").unwrap();
        meta.source_path = Some(ext.to_string_lossy().to_string());
        write_meta(&stub, &meta).unwrap();
        // Pin then delete: the stub is removed; the external repo is untouched.
        set_pinned_in(&base, &meta.id, true).unwrap();
        assert!(read_meta(&stub).unwrap().pinned.unwrap_or(false));
        delete_in(&base, &meta.id).unwrap();
        assert!(!stub.exists()); // stub index gone
        assert!(ext.join("keep.txt").exists()); // external repo untouched

        // Deleting an unknown id errors, not panics.
        assert!(delete_in(&base, "nope").is_err());

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn corrupt_meta_reads_as_no_project() {
        let base = std::env::temp_dir().join(format!("os-project-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = base.join("broken");
        fs::create_dir_all(dir.join(".openscience")).unwrap();
        fs::write(dir.join(".openscience").join("project.json"), "{not json").unwrap();
        assert!(read_meta(&dir).is_none());
        let _ = fs::remove_dir_all(&base);
    }
}
