//! Only yt-dlp's after_move records can establish that media was saved.

use std::{
    fs::File,
    io::{BufRead, BufReader},
    path::Path,
};

const NO_OUTPUT: &str = "err_download_no_output";

/// Verify every reported output, including no-merge streams and playlists.
/// Return the last verified file as the representative history entry.
pub(super) fn verify_outputs(
    manifest: &Path,
    destination: &Path,
    token: &str,
) -> Result<(String, i64), String> {
    let invalid = || NO_OUTPUT.to_string();
    let marker = format!(" {token}]");
    let manifest = File::open(manifest).map_err(|_| invalid())?;
    let mut result = None;
    for line in BufReader::new(manifest).lines() {
        let line = line.map_err(|_| invalid())?;
        let path: String = serde_json::from_str(&line).map_err(|_| invalid())?;
        let path_on_disk = Path::new(&path);
        // after_move paths are absolute because --paths home is absolute.
        if !path_on_disk.is_absolute()
            || !path_on_disk
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(&marker))
        {
            return Err(invalid());
        }
        let canonical = path_on_disk.canonicalize().map_err(|_| invalid())?;
        if !canonical.starts_with(destination) {
            return Err(invalid());
        }
        let metadata = canonical.metadata().map_err(|_| invalid())?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(invalid());
        }
        let _ = File::open(&canonical).map_err(|_| invalid())?;
        result = Some((path, i64::try_from(metadata.len()).map_err(|_| invalid())?));
    }
    result.ok_or_else(invalid)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn requires_nonempty_regular_files_from_this_attempt_in_the_destination() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("destination");
        fs::create_dir(&destination).unwrap();
        let destination = destination.canonicalize().unwrap();
        let manifest = root.path().join("manifest");
        let first = destination.join("اردو 🎶 [720 sample].mp4");
        let missing = destination.join("other [1080 sample].mp4");
        let outside = root.path().join("unrelated [1080 sample].mp4");
        let old = destination.join("existing [720 earlier].mp4");
        let encode = |path: &Path| serde_json::to_string(path).unwrap();
        let verify = |records: &str| {
            fs::write(&manifest, records).unwrap();
            verify_outputs(&manifest, &destination, "sample")
        };
        fs::write(&first, "").unwrap();
        fs::write(&old, "old media").unwrap();
        fs::write(&outside, "unrelated media").unwrap();
        for path in [&first, &missing, &old, &outside] {
            assert!(verify(&encode(path)).is_err(), "{path:?}");
        }
        assert!(verify("").is_err());
        assert!(verify("[download] Destination: video.mp4").is_err());
        fs::write(&first, "media").unwrap();
        assert_eq!(verify(&encode(&first)).unwrap().1, 5);
        assert!(verify(&format!("{}\n{}", encode(&first), encode(&missing))).is_err());
        fs::create_dir(&missing).unwrap();
        assert!(verify(&encode(&missing)).is_err());
    }
}
