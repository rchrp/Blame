//! What each consumer has read of each file content, and receipts.
//! Mirrors `read-coverage.ts`; the state is journaled in the same shape.

use crate::json::Json;
use crate::obj;

pub type Interval = (usize, usize);

#[derive(Clone, Debug, PartialEq)]
pub struct CoverageEntry {
    pub consumer_id: String,
    pub generation: String,
    pub hash: String,
    pub intervals: Vec<Interval>,
    pub path: String,
}

pub struct Registered {
    pub covered: bool,
    pub receipt: String,
    pub uncovered: Vec<Interval>,
}

#[derive(Default)]
pub struct ReadCoverage {
    /// Insertion order is the pruning order, as a JavaScript Map's.
    entries: Vec<CoverageEntry>,
    receipt_sequence: u64,
}

const MAXIMUM_ENTRIES: usize = 500;

impl ReadCoverage {
    pub fn register(
        &mut self,
        scope: (&str, &str),
        hash: &str,
        path: &str,
        intervals: &[Interval],
    ) -> Registered {
        let index = self.position(scope, path, hash);
        let mut entry = match index {
            Some(index) => self.entries[index].clone(),
            None => CoverageEntry {
                consumer_id: scope.0.into(),
                generation: scope.1.into(),
                hash: hash.into(),
                intervals: Vec::new(),
                path: path.into(),
            },
        };
        let uncovered: Vec<Interval> = intervals
            .iter()
            .flat_map(|interval| subtract_covered(*interval, &entry.intervals))
            .collect();
        let mut merged = entry.intervals.clone();
        merged.extend(&uncovered);
        entry.intervals = merge_intervals(merged);
        // `Map.set` on an existing key keeps its place.
        match index {
            Some(index) => self.entries[index] = entry,
            None => self.entries.push(entry),
        }
        while self.entries.len() > MAXIMUM_ENTRIES {
            self.entries.remove(0);
        }
        self.receipt_sequence += 1;
        Registered {
            covered: uncovered.is_empty(),
            receipt: format!("r{}", self.receipt_sequence),
            uncovered,
        }
    }

    /// The parts of `intervals` this consumer has not read yet, without recording a read.
    pub fn uncovered(
        &self,
        scope: (&str, &str),
        hash: &str,
        path: &str,
        intervals: &[Interval],
    ) -> Vec<Interval> {
        let covered = self
            .position(scope, path, hash)
            .map(|index| self.entries[index].intervals.clone())
            .unwrap_or_default();
        merge_intervals(
            intervals
                .iter()
                .flat_map(|interval| subtract_covered(*interval, &covered))
                .collect(),
        )
    }

    pub fn invalidate_path(&mut self, path: &str) {
        self.entries.retain(|entry| entry.path != path);
    }

    fn position(&self, scope: (&str, &str), path: &str, hash: &str) -> Option<usize> {
        self.entries.iter().position(|entry| {
            entry.consumer_id == scope.0
                && entry.generation == scope.1
                && entry.path == path
                && entry.hash == hash
        })
    }

    pub fn entries(&self) -> &[CoverageEntry] {
        &self.entries
    }

    pub fn hydrate(&mut self, state: &Json) {
        self.entries.clear();
        let entries = state
            .get("entries")
            .and_then(Json::as_array)
            .cloned()
            .unwrap_or_default();
        let skip = entries.len().saturating_sub(MAXIMUM_ENTRIES);
        for value in entries.into_iter().skip(skip) {
            if let Some(entry) = entry_from_json(&value) {
                // Later duplicates replace earlier ones in place, as Map.set does.
                match self.position(
                    (&entry.consumer_id, &entry.generation),
                    &entry.path,
                    &entry.hash,
                ) {
                    Some(index) => self.entries[index] = entry,
                    None => self.entries.push(entry),
                }
            }
        }
        self.receipt_sequence = state
            .get("receiptSequence")
            .and_then(Json::as_f64)
            .unwrap_or(0.0) as u64;
    }

    pub fn snapshot(&self) -> Json {
        obj! {
            "entries" => Json::Arr(self.entries.iter().map(entry_to_json).collect()),
            "receiptSequence" => self.receipt_sequence,
        }
    }
}

pub fn intervals_json(intervals: &[Interval]) -> Json {
    Json::Arr(
        intervals
            .iter()
            .map(|interval| Json::from(*interval))
            .collect(),
    )
}

pub fn intervals_from_json(value: Option<&Json>) -> Vec<Interval> {
    value
        .and_then(Json::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((
                        pair.first()?.as_f64()? as usize,
                        pair.get(1)?.as_f64()? as usize,
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn entry_to_json(entry: &CoverageEntry) -> Json {
    obj! {
        "consumerId" => entry.consumer_id.as_str(),
        "generation" => entry.generation.as_str(),
        "hash" => entry.hash.as_str(),
        "intervals" => intervals_json(&entry.intervals),
        "path" => entry.path.as_str(),
    }
}

fn entry_from_json(value: &Json) -> Option<CoverageEntry> {
    Some(CoverageEntry {
        consumer_id: value.get("consumerId")?.as_str()?.into(),
        generation: value.get("generation")?.as_str()?.into(),
        hash: value.get("hash")?.as_str()?.into(),
        intervals: intervals_from_json(value.get("intervals")),
        path: value.get("path")?.as_str()?.into(),
    })
}

fn subtract_covered(interval: Interval, covered: &[Interval]) -> Vec<Interval> {
    let mut pending = vec![interval];
    for existing in covered {
        pending = pending
            .into_iter()
            .flat_map(|candidate| subtract(candidate, *existing))
            .collect();
    }
    pending
}

fn subtract(input: Interval, covered: Interval) -> Vec<Interval> {
    if covered.1 <= input.0 || covered.0 >= input.1 {
        return vec![input];
    }
    let mut output = Vec::new();
    if covered.0 > input.0 {
        output.push((input.0, covered.0));
    }
    if covered.1 < input.1 {
        output.push((covered.1, input.1));
    }
    output
}

/// Sorted, with touching intervals joined (`read-coverage.ts`: `previous[1] < start` splits).
pub fn merge_intervals(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by_key(|interval| interval.0);
    let mut output: Vec<Interval> = Vec::new();
    for interval in intervals {
        match output.last_mut() {
            Some(previous) if previous.1 >= interval.0 => previous.1 = previous.1.max(interval.1),
            _ => output.push(interval),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_only_new_bytes() {
        let mut coverage = ReadCoverage::default();
        let first = coverage.register(("lead", "initial"), "h", "a.ts", &[(0, 10)]);
        assert!(!first.covered);
        assert_eq!(first.receipt, "r1");
        let second = coverage.register(("lead", "initial"), "h", "a.ts", &[(5, 15)]);
        assert_eq!(second.uncovered, vec![(10, 15)]);
        let third = coverage.register(("lead", "initial"), "h", "a.ts", &[(0, 15)]);
        assert!(third.covered);
        assert_eq!(
            coverage.snapshot().stringify(),
            r#"{"entries":[{"consumerId":"lead","generation":"initial","hash":"h","intervals":[[0,15]],"path":"a.ts"}],"receiptSequence":3}"#
        );
    }
}
