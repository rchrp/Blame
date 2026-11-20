//! SHA-256, used to fingerprint the context of a request.

use sha2::Digest;
use std::fmt::Write;

pub(crate) struct Sha256(sha2::Sha256);

impl Sha256 {
    pub(crate) fn new() -> Self {
        Self(sha2::Sha256::new())
    }

    pub(crate) fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }

    /// The digest as lowercase hex.
    pub(crate) fn finish_hex(self) -> String {
        let digest = self.0.finalize();
        let mut hex = String::with_capacity(64);
        for byte in digest {
            // Writing to a String cannot fail.
            let _ = write!(hex, "{byte:02x}");
        }
        hex
    }
}

#[cfg(test)]
mod tests {
    use super::Sha256;

    #[test]
    fn digests_are_lowercase_hex() {
        let mut hasher = Sha256::new();
        hasher.update(b"a");
        hasher.update(b"bc");
        assert_eq!(
            hasher.finish_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
