//! A Blame process's own standard streams stay its own.
//!
//! On Windows a child process inherits every inheritable handle of its
//! parent, not only the three it is given as its standard streams. The engine
//! and the harness are started with pipes as their standard streams, and
//! those pipe handles are inheritable (that is how they were received). So
//! every command the harness runs, and every process that command leaves
//! behind (a dev server, a watcher), would hold the pipes between the app,
//! the engine and the harness: the reader at the other end never sees the
//! stream end while such a process lives.
//!
//! Node does the same at start-up (`uv_disable_stdio_inheritance`), which is
//! why the TypeScript harness never had the problem. Children that must share
//! a stream still do: the standard library duplicates the handle for them.
//!
//! This is the workspace's only unsafe code; the other crates forbid it.

/// Call once, first thing in `main`. Does nothing outside Windows, where a
/// child only gets the file descriptors it is given.
pub fn keep_from_children() {
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::{HANDLE_FLAG_INHERIT, SetHandleInformation};
        for handle in [
            std::io::stdin().as_raw_handle(),
            std::io::stdout().as_raw_handle(),
            std::io::stderr().as_raw_handle(),
        ] {
            // A process started without a stream has none to protect.
            if handle.is_null() {
                continue;
            }
            // SAFETY: the handle is this process's own standard stream, open
            // for the whole life of the process; the call only clears its
            // inherit flag and touches no memory. A failure (a handle of a
            // kind that has no such flag) changes nothing and is ignored.
            unsafe {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}
