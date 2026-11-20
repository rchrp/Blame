//! The workspace write lock, compatible with the TypeScript harness's
//! `proper-lockfile` lock on `.blame/harness/light-write`: the lock is the
//! directory `light-write.lock`, created atomically, stale after 60 s
//! without an mtime update. Both implementations can then share a folder.

use crate::failure::{Failure, Outcome};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

const RETRIES: u32 = 40;
const FACTOR: f64 = 1.2;
const MIN_TIMEOUT_MS: f64 = 25.0;
const MAX_TIMEOUT_MS: f64 = 1_000.0;
const STALE: Duration = Duration::from_secs(60);

pub struct WorkspaceLock {
    lock_directory: PathBuf,
}

impl WorkspaceLock {
    /// Takes the lock of `root`, retrying as proper-lockfile does.
    pub fn acquire(root: &str) -> Outcome<WorkspaceLock> {
        let directory = Path::new(root)
            .join(".blame")
            .join("harness")
            .join("light-write");
        fs::create_dir_all(&directory).map_err(|error| Failure::io(&error, "mkdir", &directory))?;
        let lock_directory = directory.with_extension("lock");
        for attempt in 0..=RETRIES {
            match fs::create_dir(&lock_directory) {
                Ok(()) => return Ok(WorkspaceLock { lock_directory }),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                    if is_stale(&lock_directory) {
                        let _ = fs::remove_dir(&lock_directory);
                        continue;
                    }
                }
                Err(error) => return Err(Failure::io(&error, "mkdir", &lock_directory)),
            }
            if attempt < RETRIES {
                let timeout = (MIN_TIMEOUT_MS * FACTOR.powi(attempt as i32)).min(MAX_TIMEOUT_MS);
                sleep(Duration::from_millis(timeout as u64));
            }
        }
        Err(Failure::new(
            "The workspace is busy: another Blame session or process is changing it. Retry in a moment.",
        ))
    }
}

impl Drop for WorkspaceLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.lock_directory);
    }
}

fn is_stale(lock_directory: &Path) -> bool {
    fs::metadata(lock_directory)
        .and_then(|metadata| metadata.modified())
        .is_ok_and(|modified| {
            SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default()
                > STALE
        })
}
