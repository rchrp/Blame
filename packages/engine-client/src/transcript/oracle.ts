// A direct port of `effective` from crates/blame-engine-core/src/projection.rs,
// kept deliberately naive (it rebuilds the list from scratch) so the
// incremental reducer can be checked against it.
import type { SessionRecord } from "../protocol.js";

export interface Effective {
  seq: number;
  /** Present for a record, absent for the cut a rewind left. */
  record?: SessionRecord;
}

export function effective(records: readonly SessionRecord[]): Effective[] {
  let items: Effective[] = [];
  let undoable: { finished: number; removed: Effective[] } | undefined;
  for (const record of records) {
    switch (record.type) {
      case "rewind_started":
        break;
      case "rewind_finished": {
        const cut = items.findIndex((item) => item.seq > record.to);
        const removed = cut === -1 ? [] : items.splice(cut);
        items.push({ seq: record.seq, record });
        undoable = { finished: record.seq, removed };
        continue;
      }
      case "rewind_undone": {
        const taken = undoable;
        undoable = undefined;
        if (taken && taken.finished === record.rewind) {
          items.pop();
          items = items.concat(taken.removed);
        }
        continue;
      }
      default:
        items.push({ seq: record.seq, record });
    }
    undoable = undefined;
  }
  return items;
}

/** The records in effect as a straight log: what a client that never saw the rewinds would hold. */
export function linearLog(records: readonly SessionRecord[]): SessionRecord[] {
  return effective(records).map((item) => item.record!);
}
