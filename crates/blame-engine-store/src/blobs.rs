//! Content addressing and the files that hold large blobs.
//!
//! A blob file is written to a temporary name, synced, renamed to its hash
//! and the directory synced, all *before* the catalog row that points at it
//! commits. A crash therefore leaves at most an unreferenced file, never a
//! row without its content.

use crate::error::io;
use blame_engine_core::ports::StoreError;
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime};

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut hex = String::with_capacity(64);
    for byte in Sha256::digest(bytes) {
        hex.push(DIGITS[usize::from(byte >> 4)] as char);
        hex.push(DIGITS[usize::from(byte & 15)] as char);
    }
    hex
}

/// Only a hash can name a file, so a hostile address can never leave the
/// blob directory.
pub(crate) fn is_sha256_hex(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub(crate) fn blob_dir(database: &Path) -> PathBuf {
    let mut name = database
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push("-blobs");
    database.with_file_name(name)
}

/// Stale temporary files are what a crash mid-write leaves behind. A fresh
/// one may belong to another engine on the same directory, so only old ones
/// go.
pub(crate) fn prepare_dir(dir: &Path) -> Result<(), StoreError> {
    fs::create_dir_all(dir).map_err(|e| io("cannot create the blob directory", e))?;
    let Ok(entries) = fs::read_dir(dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let stale = entry.file_name().to_string_lossy().starts_with(".tmp-")
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .is_some_and(|age| age > Duration::from_secs(3600));
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Stores `bytes` under `sha256`. Writing the same content again is a no-op,
/// and two engines writing it at once both succeed (each renames its own
/// complete temporary file over the same name).
pub(crate) fn write_file(dir: &Path, sha256: &str, bytes: &[u8]) -> Result<(), StoreError> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let target = dir.join(sha256);
    if fs::metadata(&target).is_ok_and(|m| m.len() == bytes.len() as u64) {
        return Ok(());
    }
    let temporary = dir.join(format!(
        ".tmp-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let written = (|| {
        let mut file = File::create_new(&temporary)?;
        file.write_all(bytes)?;
        // `sync_all` is F_FULLFSYNC on macOS, a real flush everywhere.
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, &target)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&temporary);
        return Err(io("cannot write a blob file", error));
    }
    sync_dir(dir)
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<(), StoreError> {
    File::open(dir)
        .and_then(|d| d.sync_all())
        .map_err(|e| io("cannot sync the blob directory", e))
}

/// Windows cannot open a directory to sync it; NTFS journals the rename.
#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> Result<(), StoreError> {
    Ok(())
}

pub(crate) fn read_file(
    dir: &Path,
    sha256: &str,
    expected_len: u64,
) -> Result<Vec<u8>, StoreError> {
    match fs::read(dir.join(sha256)) {
        Ok(bytes) => verify(sha256, expected_len, bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(StoreError::Corrupt(format!(
            "the file of blob {sha256} is missing"
        ))),
        Err(e) => Err(io("cannot read a blob file", e)),
    }
}

/// Checks content against its address: this is what catches a damaged file
/// or a remote that answered with the wrong bytes.
pub(crate) fn verify(
    sha256: &str,
    expected_len: u64,
    bytes: Vec<u8>,
) -> Result<Vec<u8>, StoreError> {
    if bytes.len() as u64 != expected_len || sha256_hex(&bytes) != sha256 {
        return Err(StoreError::Corrupt(format!(
            "the content of blob {sha256} does not match its address"
        )));
    }
    Ok(bytes)
}
