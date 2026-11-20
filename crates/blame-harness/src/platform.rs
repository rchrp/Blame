//! What differs between Unix and Windows, with Node's Windows behaviour as
//! the reference (the TypeScript harness runs there unchanged): permission
//! bits come from the read-only flag, there is no exec bit, and PATH entries
//! are separated by `;`.

use std::fs::{self, Metadata, OpenOptions};
use std::io;
use std::path::Path;

/// The separator of PATH entries (`path.delimiter`).
pub const PATH_DELIMITER: char = if cfg!(windows) { ';' } else { ':' };

/// `stat.mode & 0o777`. Node reports a Windows file as 0o666, or 0o444
/// when it is read-only.
pub fn file_mode(metadata: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    }
    #[cfg(not(unix))]
    {
        if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        }
    }
}

/// `fs.chmod(path, mode)`. On Windows Node only sets or clears the
/// read-only flag, from the owner's write bit.
pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))
    }
    #[cfg(not(unix))]
    {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(path, permissions)
    }
}

/// A file only its owner reads (journals, validation logs): mode 0600 on
/// Unix; Windows has no mode bits (Node ignores them there).
pub fn private_file(options: &mut OpenOptions) -> &mut OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600)
    }
    #[cfg(not(unix))]
    {
        options
    }
}

/// `fs.access(path, X_OK)`: on Windows Node checks existence only.
pub fn executable(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        true
    }
}
