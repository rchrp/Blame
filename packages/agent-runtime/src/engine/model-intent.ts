import type { ModelRecommendation, ModelRecommendations } from "../types.js";
import type { EngineModelChoice } from "./protocol.js";

/**
 * Turns what the orchestrator wants ("cheaper", "balanced", "smarter") into a
 * concrete model, from the same ranking the smart model slider shows.
 *
 * One limit cannot be fixed here: the API computes the ranking (the Pareto
 * frontier of estimated cost against intelligence) before the user's hidden
 * models are removed. A hidden model can therefore already have eliminated
 * models it dominated, and those do not come back: the candidates are the
 * frontier minus the hidden models, not the frontier of the visible models.
 * The same goes for the lists themselves: `all` is deduplicated by canonical
 * model on the API side, while the union of several providers' lists (below)
 * has no canonical id to do that with, so one model offered by two providers
 * at the same price and score appears twice, as a tie.
 */

export type ModelIntent = "cheaper" | "balanced" | "smarter";

/** A slice of the slider: both ends from 0 (cheapest) to 1 (smartest). */
export type ModelRange = { min: number; max: number };

export type ModelKey = { providerId: string; modelId: string };

/** What both functions pick their candidates from. */
export type ModelPool = {
  recommendations: ModelRecommendations;
  /** Defaults to the whole scale. */
  range?: ModelRange;
  /** The providers the user allows; empty or absent means all. */
  providers?: string[];
  /** The models the user hid in the model selector. */
  hidden?: ModelKey[];
};

export type ModelIntentInput = ModelPool & {
  intent: ModelIntent;
  /** The account's default model, used when nothing can be ranked. */
  fallback: EngineModelChoice;
};

export type ModelEscalationInput = ModelPool & {
  /** The story's current model. */
  current: ModelKey;
};

/** What the orchestrator's decision log shows about a choice. */
export type ModelResolution = {
  model: EngineModelChoice;
  /** From 0 (cheapest) to 1 (smartest) among all the candidates, not only the range. `null` for the fallback. */
  position: number | null;
  estimatedCost: number | null;
  smartScore: number | null;
  /** True when there was nothing to rank and `model` is the account's default. */
  fallback: boolean;
};

export type ModelIntentResolution = ModelResolution & { intent: ModelIntent };

type Candidate = ModelRecommendation & { localPosition: number };

const wholeScale: ModelRange = { min: 0, max: 1 };
// Positions are i / (n - 1): a range typed in from another candidate list
// (another set of providers) must still catch a notch it was set on.
const tolerance = 1e-9;

export function resolveModelIntent(
  input: ModelIntentInput,
): ModelIntentResolution {
  const inRange = candidatesInRange(input);
  if (inRange.length === 0) {
    return {
      intent: input.intent,
      // Whole: the account's default names which of the person's credentials
      // it uses and how hard it reasons.
      model: { ...input.fallback },
      position: null,
      estimatedCost: null,
      smartScore: null,
      fallback: true,
    };
  }
  return {
    intent: input.intent,
    ...resolution(intentCandidate(inRange, input.intent)),
  };
}

/**
 * The next model above `current` inside the range, or `null` when it is
 * already the top of the range (or when there is no candidate at all: the
 * fallback is not an escalation). A current model that is not a candidate
 * (the catalog changed, it was hidden, or it was the fallback) escalates to
 * the smartest model of the range, unless that is the current model.
 */
export function escalateModel(
  input: ModelEscalationInput,
): ModelResolution | null {
  const all = rankedCandidates(input);
  const inRange = rangeSubset(all, input.range);
  const index = all.findIndex((candidate) =>
    sameModel(candidate, input.current),
  );
  const next =
    index < 0
      ? inRange[inRange.length - 1]
      : inRange.find(
          (candidate) => candidate.localPosition > all[index].localPosition,
        );
  if (!next || sameModel(next, input.current)) return null;
  return resolution(next);
}

function candidatesInRange(input: ModelPool) {
  return rangeSubset(rankedCandidates(input), input.range);
}

/** The benchmarked, allowed, visible models, cheapest first, positioned by rank. */
function rankedCandidates(pool: ModelPool): Candidate[] {
  const sorted = sourceList(pool).sort(compare);
  return sorted.map((item, index) => ({
    ...item,
    localPosition: sorted.length === 1 ? 0.5 : index / (sorted.length - 1),
  }));
}

/**
 * The benchmarked, visible models of the allowed providers. One provider (or
 * all) is a list the API already reduced to its frontier; several are merged
 * here, so the dominated models are removed again, after the hidden ones.
 */
function sourceList(pool: ModelPool) {
  const { recommendations } = pool;
  const hidden = pool.hidden ?? [];
  const allowed = [...new Set(pool.providers ?? [])];
  const visible = (items: ModelRecommendation[]) =>
    items.filter(
      (item) =>
        item.segment === "benchmarked" &&
        !hidden.some((entry) => sameModel(entry, item)),
    );
  if (allowed.length === 0) return visible(recommendations.all);
  if (allowed.length === 1) {
    return visible(recommendations.byProvider[allowed[0]] ?? []);
  }
  const union = new Map<string, ModelRecommendation>();
  for (const providerId of allowed) {
    for (const item of visible(recommendations.byProvider[providerId] ?? [])) {
      union.set(`${item.providerId}\n${item.modelId}`, item);
    }
  }
  return withoutDominated([...union.values()]);
}

function withoutDominated(items: ModelRecommendation[]) {
  return items.filter((item) => !items.some((other) => dominates(other, item)));
}

// Same rule as the API's `dominates`: no dearer, no less smart, and strictly
// better on one of the two.
function dominates(left: ModelRecommendation, right: ModelRecommendation) {
  const cheaper = cost(left) < cost(right);
  const smarter = score(left) > score(right);
  return (
    cost(left) <= cost(right) &&
    score(left) >= score(right) &&
    (cheaper || smarter)
  );
}

function compare(left: ModelRecommendation, right: ModelRecommendation) {
  return (
    cost(left) - cost(right) ||
    score(left) - score(right) ||
    left.providerId.localeCompare(right.providerId) ||
    left.modelId.localeCompare(right.modelId)
  );
}

// A missing cost or score never happens on benchmarked entries; if it did, it
// ranks last (dearest, least smart). Two infinities subtract to NaN, which `||`
// treats as a tie.
function cost(item: ModelRecommendation) {
  return item.estimatedCost ?? Number.POSITIVE_INFINITY;
}

function score(item: ModelRecommendation) {
  return item.smartScore ?? Number.NEGATIVE_INFINITY;
}

/**
 * The candidates whose position is inside the range; when none is, the one
 * nearest to it (the lower one on a tie), so a ranked list never resolves to
 * nothing.
 */
function rangeSubset(candidates: Candidate[], range: ModelRange = wholeScale) {
  if (candidates.length === 0) return [];
  const min = Math.min(range.min, range.max);
  const max = Math.max(range.min, range.max);
  const inside = candidates.filter(
    (candidate) =>
      candidate.localPosition >= min - tolerance &&
      candidate.localPosition <= max + tolerance,
  );
  if (inside.length > 0) return inside;
  const distance = (candidate: Candidate) =>
    Math.max(min - candidate.localPosition, candidate.localPosition - max);
  return [
    candidates.reduce((best, item) =>
      distance(item) < distance(best) ? item : best,
    ),
  ];
}

function intentCandidate(inRange: Candidate[], intent: ModelIntent) {
  if (intent === "cheaper") return inRange[0];
  if (intent === "smarter") return inRange[inRange.length - 1];
  return inRange[Math.floor((inRange.length - 1) / 2)];
}

function resolution(candidate: Candidate): ModelResolution {
  return {
    model: { providerId: candidate.providerId, modelId: candidate.modelId },
    position: candidate.localPosition,
    estimatedCost: candidate.estimatedCost,
    smartScore: candidate.smartScore ?? null,
    fallback: false,
  };
}

function sameModel(left: ModelKey, right: ModelKey) {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}
