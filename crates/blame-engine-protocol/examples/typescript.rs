//! Writes the TypeScript declarations of the wire types to the file named by
//! the first argument, or to stdout without one.
//!
//! ```text
//! cargo run -p blame-engine-protocol --features ts --example typescript -- <file>
//! ```

fn main() {
    let declarations = blame_engine_protocol::typescript::declarations();
    match std::env::args().nth(1) {
        Some(path) => std::fs::write(&path, declarations)
            .unwrap_or_else(|error| panic!("cannot write {path}: {error}")),
        None => print!("{declarations}"),
    }
}
