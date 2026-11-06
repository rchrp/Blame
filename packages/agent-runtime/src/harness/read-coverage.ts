export type ByteInterval = [number, number];

export type CoverageEntry = {
  consumerId: string;
  generation: string;
  hash: string;
  intervals: ByteInterval[];
  path: string;
};

export type ReadCoverageState = {
  entries: CoverageEntry[];
  receiptSequence: number;
};

export class ReadCoverage {
  private readonly entries = new Map<string, CoverageEntry>();
  private receiptSequence = 0;

  register(
    input: Omit<CoverageEntry, "intervals"> & { intervals: ByteInterval[] },
  ) {
    const key = coverageKey(input);
    const entry = this.entries.get(key) ?? { ...input, intervals: [] };
    const uncovered = input.intervals.flatMap((interval) =>
      subtractCovered(interval, entry.intervals),
    );
    entry.intervals = mergeIntervals([...entry.intervals, ...uncovered]);
    this.entries.set(key, entry);
    this.prune();
    const receipt = `r${++this.receiptSequence}`;
    return { covered: uncovered.length === 0, receipt, uncovered };
  }

  /** The parts of `intervals` this consumer has not read yet, without recording a read. */
  uncovered(input: Omit<CoverageEntry, "intervals"> & { intervals: ByteInterval[] }) {
    const covered = this.entries.get(coverageKey(input))?.intervals ?? [];
    return mergeIntervals(input.intervals.flatMap((interval) => subtractCovered(interval, covered)));
  }

  invalidatePath(path: string) {
    for (const [key, entry] of this.entries)
      if (entry.path === path) this.entries.delete(key);
  }

  hydrate(state: ReadCoverageState) {
    this.entries.clear();
    for (const entry of state.entries.slice(-500))
      this.entries.set(coverageKey(entry), cloneEntry(entry));
    this.receiptSequence = state.receiptSequence;
  }

  snapshot(): ReadCoverageState {
    return {
      entries: [...this.entries.values()].map(cloneEntry),
      receiptSequence: this.receiptSequence,
    };
  }

  private prune() {
    while (this.entries.size > 500) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}

function cloneEntry(entry: CoverageEntry): CoverageEntry {
  return {
    ...entry,
    intervals: entry.intervals.map((interval) => [...interval]),
  };
}

function coverageKey(input: Omit<CoverageEntry, "intervals">) {
  return [input.consumerId, input.generation, input.path, input.hash].join(
    "\0",
  );
}

function subtractCovered(interval: ByteInterval, covered: ByteInterval[]) {
  let pending = [interval];
  for (const existing of covered)
    pending = pending.flatMap((candidate) => subtract(candidate, existing));
  return pending;
}

function subtract(input: ByteInterval, covered: ByteInterval) {
  if (covered[1] <= input[0] || covered[0] >= input[1]) return [input];
  const output: ByteInterval[] = [];
  if (covered[0] > input[0]) output.push([input[0], covered[0]]);
  if (covered[1] < input[1]) output.push([covered[1], input[1]]);
  return output;
}

function mergeIntervals(intervals: ByteInterval[]) {
  const ordered = [...intervals].sort((left, right) => left[0] - right[0]);
  const output: ByteInterval[] = [];
  for (const interval of ordered) {
    const previous = output.at(-1);
    if (!previous || previous[1] < interval[0]) output.push([...interval]);
    else previous[1] = Math.max(previous[1], interval[1]);
  }
  return output;
}
