//! Images in tool results, ported from
//! `packages/agent-runtime/src/image-context.ts`: the same image is sent
//! once, none above the provider's limit, and the most recent ones within a
//! total budget.
//!
//! The TypeScript recomputed the selection for every request, so an image
//! could come back when a newer one left. Here a replaced image stays
//! replaced (an edit is text: it cannot bring an image back, and taking one
//! out again would rewrite the prefix a second time), and when the budget is
//! exceeded the oldest images go until half of it is left, so evictions,
//! which rewrite older blocks, are rare.

use blame_engine_protocol::{BlobRef, Seq};
use std::collections::HashMap;

/// `maximumImageEncodedBytes`: the provider's limit for one image, base64.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// `maximumImageContextBytes`: images kept in the context, base64.
pub const BUDGET_BYTES: u64 = 8 * 1024 * 1024;
/// Once over budget, images are evicted down to this.
pub const EVICT_TO_BYTES: u64 = 4 * 1024 * 1024;

pub const DUPLICATE: &str = "Duplicate image data; see the earlier result.";
pub const TOO_LARGE: &str =
    "Image exceeds the provider image limit. Resize or crop it before reading again.";
pub const OMITTED: &str = "Image omitted to make room for recent images. View it again if needed.";

/// An image block still shown as an image, in log order.
pub struct Image<'a> {
    pub seq: Seq,
    pub block: u32,
    pub blob: &'a BlobRef,
    /// Its result is frozen: only a forced change (size, budget) may touch it.
    pub frozen: bool,
}

/// The length of the base64 text the provider receives, which is what the
/// TypeScript measured.
fn encoded(bytes: u64) -> u64 {
    bytes.div_ceil(3) * 4
}

/// The text each image that has to go is replaced by.
pub fn replacements(images: &[Image<'_>]) -> Vec<(Seq, u32, &'static str)> {
    let mut out = Vec::new();
    // Each distinct image (media type and digest): where it appears, the
    // latest place, which sets its recency, and its size.
    struct Group {
        latest: usize,
        bytes: u64,
        occurrences: Vec<usize>,
    }
    let mut groups: HashMap<(&str, &str), Group> = HashMap::new();
    let mut order: Vec<(&str, &str)> = Vec::new();
    for (index, image) in images.iter().enumerate() {
        let key = (image.blob.media_type.as_str(), image.blob.sha256.as_str());
        match groups.get_mut(&key) {
            Some(group) => {
                group.latest = index;
                group.occurrences.push(index);
                if !image.frozen {
                    out.push((image.seq, image.block, DUPLICATE));
                }
            }
            None => {
                order.push(key);
                groups.insert(
                    key,
                    Group {
                        latest: index,
                        bytes: encoded(image.blob.bytes),
                        occurrences: vec![index],
                    },
                );
            }
        }
    }
    let mut kept: Vec<&Group> = Vec::new();
    for key in &order {
        let group = &groups[key];
        if group.bytes > MAX_IMAGE_BYTES {
            for &index in &group.occurrences {
                out.push((images[index].seq, images[index].block, TOO_LARGE));
            }
        } else {
            kept.push(group);
        }
    }
    let total: u64 = kept.iter().map(|group| group.bytes).sum();
    if total > BUDGET_BYTES {
        kept.sort_by_key(|group| std::cmp::Reverse(group.latest));
        let mut bytes = 0;
        for (rank, group) in kept.iter().enumerate() {
            // The newest image always stays: it is what the model just
            // asked to see, and it is under the provider's limit.
            if rank == 0 || bytes + group.bytes <= EVICT_TO_BYTES {
                bytes += group.bytes;
                continue;
            }
            for &index in &group.occurrences {
                out.push((images[index].seq, images[index].block, OMITTED));
            }
        }
    }
    // One replacement per block: eviction and size win over "duplicate".
    let mut chosen: HashMap<(Seq, u32), &'static str> = HashMap::new();
    for (seq, block, text) in out {
        let entry = chosen.entry((seq, block)).or_insert(text);
        if *entry == DUPLICATE {
            *entry = text;
        }
    }
    let mut chosen: Vec<_> = chosen
        .into_iter()
        .map(|((seq, block), text)| (seq, block, text))
        .collect();
    chosen.sort();
    chosen
}
