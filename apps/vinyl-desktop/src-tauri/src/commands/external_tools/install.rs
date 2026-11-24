//! Stage verified binaries on the target volume and preserve the previous versions on error.

use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tempfile::TempDir;

pub(super) fn stage_in(dir: &Path) -> Result<TempDir, String> {
    tempfile::Builder::new()
        .prefix(".nexus-tool-")
        .tempdir_in(dir)
        .map_err(|error| format!("err_create_dir:{error}"))
}

pub(super) fn staged_path(stage: &TempDir, target: &Path) -> Result<PathBuf, String> {
    Ok(stage
        .path()
        .join(target.file_name().ok_or("err_invalid_executable_path")?))
}

pub(super) fn make_executable(_path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(_path, fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("err_set_permissions:{error}"))?;
    }
    Ok(())
}

/// Install a single verified executable or the verified FFmpeg/FFprobe pair.
/// Stage and backups are unique to this operation and on the same filesystem.
/// Don't delete backups unless the installation or its rollback succeeded.
pub(super) fn install_executables(stage: TempDir, targets: &[&Path]) -> Result<(), String> {
    let backup_dir = stage.path().join("previous");
    fs::create_dir(&backup_dir).map_err(|error| format!("err_create_dir:{error}"))?;
    let files = targets
        .iter()
        .map(|target| {
            let path = staged_path(&stage, target)?;
            let backup = backup_dir.join(path.file_name().ok_or("err_invalid_executable_path")?);
            Ok((*target, path, backup))
        })
        .collect::<Result<Vec<_>, String>>()?;
    let mut backed_up = vec![false; files.len()];
    let mut installed = vec![false; files.len()];
    let replace = (|| -> io::Result<()> {
        for (index, (target, _, backup)) in files.iter().enumerate() {
            match fs::symlink_metadata(target) {
                Ok(meta) if meta.is_file() => {
                    fs::rename(target, backup)?;
                    backed_up[index] = true;
                }
                Ok(_) => return Err(io::Error::other("Tool destination is not a regular file")),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        for (index, (target, staged, _)) in files.iter().enumerate() {
            fs::rename(staged, target)?;
            installed[index] = true;
        }
        Ok(())
    })();
    if let Err(error) = replace {
        let mut restored = true;
        for (index, (target, _, backup)) in files.iter().enumerate().rev() {
            if backed_up[index] {
                restored &= fs::rename(backup, target).is_ok();
            } else if installed[index] {
                restored &= fs::remove_file(target).is_ok();
            }
        }
        if !restored {
            return Err(format!(
                "err_tool_rollback:{} ({error})",
                stage.keep().display()
            ));
        }
        return Err(format!("err_replace_executable:{error}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pair_is_installed_together_or_old_binaries_are_restored() {
        let root = tempfile::tempdir().unwrap();
        let ffmpeg = root.path().join("ffmpeg.exe");
        let ffprobe = root.path().join("ffprobe.exe");
        fs::write(&ffmpeg, b"old encoder").unwrap();
        fs::write(&ffprobe, b"old probe").unwrap();
        let failed_stage = stage_in(root.path()).unwrap();
        let stage = stage_in(root.path()).unwrap();
        assert_ne!(failed_stage.path(), stage.path());
        fs::write(staged_path(&failed_stage, &ffmpeg).unwrap(), b"new encoder").unwrap();
        assert!(install_executables(failed_stage, &[&ffmpeg, &ffprobe]).is_err());
        assert_eq!(fs::read(&ffmpeg).unwrap(), b"old encoder");
        assert_eq!(fs::read(&ffprobe).unwrap(), b"old probe");
        fs::write(staged_path(&stage, &ffmpeg).unwrap(), b"new encoder").unwrap();
        fs::write(staged_path(&stage, &ffprobe).unwrap(), b"new probe").unwrap();
        install_executables(stage, &[&ffmpeg, &ffprobe]).unwrap();
        assert_eq!(fs::read(&ffmpeg).unwrap(), b"new encoder");
        assert_eq!(fs::read(&ffprobe).unwrap(), b"new probe");
        assert_eq!(root.path().read_dir().unwrap().count(), 2);
    }
}
