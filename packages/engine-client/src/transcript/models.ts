import type { ModelRef } from "../protocol.js";
import type { Transcript } from "./model.js";

/**
 * How many turns each model answered, in the order the models first did:
 * from the replies a rewind has not removed, so a model change, a rewind
 * and a reload all count right. A turn counts for the model of its first
 * reply; a turn that got no reply counts for none.
 */
export function turnsByModel(
  transcript: Pick<Transcript, "items">,
): Array<{ model: ModelRef; turns: number }> {
  const turnModel = new Map<string, ModelRef>();
  for (const item of transcript.items) {
    if (!("turn" in item) || !("message" in item)) continue;
    const model = item.message?.model;
    if (model && !turnModel.has(item.turn)) turnModel.set(item.turn, model);
  }
  const counts = new Map<string, { model: ModelRef; turns: number }>();
  for (const model of turnModel.values()) {
    const key = `${model.provider}\u0000${model.model}`;
    const known = counts.get(key);
    if (known) known.turns += 1;
    else counts.set(key, { model, turns: 1 });
  }
  return [...counts.values()];
}
