import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ModelRecommendation, ModelRecommendations } from "../types.js";
import {
  escalateModel,
  resolveModelIntent,
  type ModelIntent,
  type ModelRange,
} from "./model-intent.js";
import { emptyRecommendations } from "./provider-list.js";

type Entry = [providerId: string, modelId: string, cost: number, score: number];

function rec([providerId, modelId, cost, score]: Entry): ModelRecommendation {
  return {
    providerId,
    modelId,
    position: 0,
    segment: "benchmarked",
    estimatedCost: cost,
    smartScore: score,
  };
}

function unbenchmarked(
  providerId: string,
  modelId: string,
): ModelRecommendation {
  return {
    providerId,
    modelId,
    position: 0.9,
    segment: "unbenchmarked",
    estimatedCost: 1,
  };
}

function recommendations(
  all: Entry[],
  byProvider: Record<string, Entry[]> = {},
  extra: ModelRecommendation[] = [],
): ModelRecommendations {
  return {
    ...emptyRecommendations(),
    benchmarkBoundary: 0.74,
    all: [...all.map(rec), ...extra],
    byProvider: Object.fromEntries(
      Object.entries(byProvider).map(([id, entries]) => [id, entries.map(rec)]),
    ),
  };
}

const fallback = { providerId: "anthropic", modelId: "account-default" };

// Four models on one frontier: positions 0, 1/3, 2/3, 1.
const frontier: Entry[] = [
  ["anthropic", "small", 1, 40],
  ["anthropic", "mid", 2, 55],
  ["anthropic", "large", 4, 70],
  ["anthropic", "huge", 8, 85],
];

function pick(
  intent: ModelIntent,
  recs: ModelRecommendations,
  extra: {
    range?: ModelRange;
    providers?: string[];
    hidden?: { providerId: string; modelId: string }[];
  } = {},
) {
  return resolveModelIntent({
    intent,
    recommendations: recs,
    fallback,
    ...extra,
  });
}

describe("resolveModelIntent", () => {
  const cases: {
    name: string;
    recs: ModelRecommendations;
    intent: ModelIntent;
    range?: ModelRange;
    providers?: string[];
    hidden?: { providerId: string; modelId: string }[];
    expected: string;
    position?: number;
  }[] = [
    {
      name: "cheaper is the first, whole scale",
      recs: recommendations(frontier),
      intent: "cheaper",
      expected: "small",
      position: 0,
    },
    {
      name: "smarter is the last",
      recs: recommendations(frontier),
      intent: "smarter",
      expected: "huge",
      position: 1,
    },
    {
      name: "balanced is the lower middle of four",
      recs: recommendations(frontier),
      intent: "balanced",
      expected: "mid",
      position: 1 / 3,
    },
    {
      name: "balanced is the middle of three",
      recs: recommendations(frontier.slice(0, 3)),
      intent: "balanced",
      expected: "mid",
      position: 0.5,
    },
    {
      name: "one candidate answers every intent",
      recs: recommendations([frontier[1]]),
      intent: "smarter",
      expected: "mid",
      position: 0.5,
    },
    {
      name: "a narrow range keeps two notches",
      recs: recommendations(frontier),
      intent: "cheaper",
      range: { min: 0.3, max: 0.7 },
      expected: "mid",
    },
    {
      name: "a narrow range: balanced picks the lower middle of its notches",
      recs: recommendations(frontier),
      intent: "balanced",
      range: { min: 0.3, max: 1 },
      expected: "large",
    },
    {
      name: "a range on a single notch",
      recs: recommendations(frontier),
      intent: "smarter",
      range: { min: 2 / 3, max: 2 / 3 },
      expected: "large",
    },
    {
      name: "a reversed range is read the right way round",
      recs: recommendations(frontier),
      intent: "smarter",
      range: { min: 0.5, max: 0 },
      expected: "mid",
    },
    {
      name: "a range with no notch takes the nearest one (above)",
      recs: recommendations(frontier),
      intent: "cheaper",
      range: { min: 0.5, max: 0.6 },
      expected: "large",
    },
    {
      name: "a range with no notch takes the nearest one (below)",
      recs: recommendations(frontier),
      intent: "smarter",
      range: { min: 0.35, max: 0.45 },
      expected: "mid",
    },
    {
      name: "a range with no notch, equally far from two, takes the cheaper",
      recs: recommendations([frontier[0], frontier[3]]),
      intent: "smarter",
      range: { min: 0.4, max: 0.6 },
      expected: "small",
    },
    {
      name: "a range beyond the scale is clamped by the notches",
      recs: recommendations(frontier),
      intent: "cheaper",
      range: { min: 2, max: 3 },
      expected: "huge",
    },
    {
      name: "hidden models leave the ranking",
      recs: recommendations(frontier),
      intent: "smarter",
      hidden: [{ providerId: "anthropic", modelId: "huge" }],
      expected: "large",
      position: 1,
    },
    {
      name: "hidden models are matched by provider and model id",
      recs: recommendations(frontier),
      intent: "cheaper",
      hidden: [{ providerId: "openai", modelId: "small" }],
      expected: "small",
    },
    {
      name: "unbenchmarked models are never candidates",
      recs: recommendations(frontier.slice(0, 2), {}, [
        unbenchmarked("anthropic", "fresh"),
      ]),
      intent: "smarter",
      expected: "mid",
    },
    {
      name: "one allowed provider uses that provider's own list",
      recs: recommendations(frontier, {
        anthropic: frontier,
        openai: [
          ["openai", "o-small", 1.5, 45],
          ["openai", "o-big", 6, 80],
        ],
      }),
      intent: "smarter",
      providers: ["openai"],
      expected: "o-big",
    },
    {
      name: "several providers: union, without the cross-provider dominated model",
      recs: recommendations([], {
        anthropic: [
          ["anthropic", "a-small", 1, 40],
          ["anthropic", "a-big", 8, 85],
        ],
        openai: [
          // Dearer than a-small and no smarter: dominated across providers.
          ["openai", "o-weak", 2, 40],
          ["openai", "o-mid", 3, 60],
        ],
      }),
      intent: "balanced",
      providers: ["anthropic", "openai"],
      // a-small, o-mid, a-big: o-weak is gone, so the middle is o-mid.
      expected: "o-mid",
      position: 0.5,
    },
    {
      name: "an unknown allowed provider has no candidate",
      recs: recommendations(frontier, { anthropic: frontier }),
      intent: "smarter",
      providers: ["mistral"],
      expected: "account-default",
    },
    {
      name: "an empty provider list means all",
      recs: recommendations(frontier),
      intent: "smarter",
      providers: [],
      expected: "huge",
    },
  ];

  for (const item of cases) {
    it(item.name, () => {
      const result = pick(item.intent, item.recs, {
        range: item.range,
        providers: item.providers,
        hidden: item.hidden,
      });
      assert.equal(result.model.modelId, item.expected);
      assert.equal(result.intent, item.intent);
      if (item.position !== undefined)
        assert.ok(Math.abs(result.position! - item.position) < 1e-9);
    });
  }

  it("reports the cost, score and position of the chosen model", () => {
    const result = pick("balanced", recommendations(frontier));
    assert.deepEqual(result, {
      intent: "balanced",
      model: { providerId: "anthropic", modelId: "mid" },
      position: 1 / 3,
      estimatedCost: 2,
      smartScore: 55,
      fallback: false,
    });
  });

  it("removes dominated models of the union but keeps one that is only tied", () => {
    const recs = recommendations([], {
      a: [["a", "same-a", 2, 50]],
      b: [
        ["b", "same-b", 2, 50],
        ["b", "worse", 3, 50],
        ["b", "dear", 5, 90],
      ],
    });
    const chosen = ["cheaper", "balanced", "smarter"].map(
      (intent) =>
        pick(intent as ModelIntent, recs, { providers: ["a", "b"] }).model
          .modelId,
    );
    assert.deepEqual(chosen, ["same-a", "same-b", "dear"]);
  });

  it("falls back when there is no recommendation at all", () => {
    const result = pick("smarter", emptyRecommendations());
    assert.deepEqual(result, {
      intent: "smarter",
      model: fallback,
      position: null,
      estimatedCost: null,
      smartScore: null,
      fallback: true,
    });
  });

  it("falls back when every candidate is hidden", () => {
    const result = pick("cheaper", recommendations([frontier[0]]), {
      hidden: [{ providerId: "anthropic", modelId: "small" }],
    });
    assert.equal(result.fallback, true);
    assert.equal(result.model.modelId, "account-default");
  });

  it("keeps the fallback's credential and reasoning", () => {
    const account = {
      ...fallback,
      credentialLabel: "work",
      reasoning: "high" as const,
    };
    const result = resolveModelIntent({
      intent: "cheaper",
      recommendations: emptyRecommendations(),
      fallback: account,
    });
    assert.deepEqual(result.model, account);
    assert.notEqual(result.model, account);
  });

  it("breaks ties by score, then by ids, whatever the input order", () => {
    const entries: Entry[] = [
      ["b", "m2", 2, 50],
      ["a", "m3", 2, 60],
      ["b", "m1", 2, 60],
      ["a", "m4", 3, 70],
    ];
    // Same cost, scores 50 < 60 = 60, then provider "a" < "b".
    const order = [entries, [...entries].reverse()].map((list) =>
      ["cheaper", "smarter"].map(
        (intent) =>
          pick(intent as ModelIntent, recommendations(list)).model.modelId,
      ),
    );
    assert.deepEqual(order[0], ["m2", "m4"]);
    assert.deepEqual(order[1], order[0]);
    // m2 and the two 60s: m3 (provider a) is dominated by none, m1 and m3 tie.
    const middle = pick("balanced", recommendations(entries));
    assert.equal(middle.model.modelId, "m3");
  });
});

describe("escalateModel", () => {
  const escalate = (
    current: string,
    extra: {
      range?: ModelRange;
      providers?: string[];
      hidden?: { providerId: string; modelId: string }[];
    } = {},
    recs = recommendations(frontier),
  ) =>
    escalateModel({
      recommendations: recs,
      current: { providerId: "anthropic", modelId: current },
      ...extra,
    });

  it("climbs the whole chain and ends with null", () => {
    const chain: (string | null)[] = [];
    let current: string | undefined = "small";
    while (current) {
      const next = escalate(current);
      chain.push(next?.model.modelId ?? null);
      current = next?.model.modelId;
    }
    assert.deepEqual(chain, ["mid", "large", "huge", null]);
  });

  it("reports the next model like a resolution", () => {
    assert.deepEqual(escalate("mid"), {
      model: { providerId: "anthropic", modelId: "large" },
      position: 2 / 3,
      estimatedCost: 4,
      smartScore: 70,
      fallback: false,
    });
  });

  it("stops at the top of the range", () => {
    const range = { min: 0, max: 0.7 };
    assert.equal(escalate("small", { range })?.model.modelId, "mid");
    assert.equal(escalate("mid", { range })?.model.modelId, "large");
    assert.equal(escalate("large", { range }), null);
  });

  it("does not climb over a hidden model", () => {
    const hidden = [{ providerId: "anthropic", modelId: "large" }];
    assert.equal(escalate("mid", { hidden })?.model.modelId, "huge");
  });

  it("goes to the bottom of the range from below it", () => {
    assert.equal(
      escalate("small", { range: { min: 0.5, max: 1 } })?.model.modelId,
      "large",
    );
  });

  it("is null from above the range", () => {
    assert.equal(escalate("huge", { range: { min: 0, max: 0.4 } }), null);
  });

  it("is null when the range holds a single model that is the current one", () => {
    const range = { min: 2 / 3, max: 2 / 3 };
    assert.equal(escalate("large", { range }), null);
    assert.equal(escalate("small", { range })?.model.modelId, "large");
  });

  it("goes to the smartest of the range when the current model is not a candidate", () => {
    assert.equal(escalate("retired")?.model.modelId, "huge");
    assert.equal(
      escalate("retired", { range: { min: 0, max: 0.5 } })?.model.modelId,
      "mid",
    );
    assert.equal(
      escalate(
        "retired",
        { providers: ["openai"] },
        recommendations(frontier, { openai: [] }),
      ),
      null,
    );
  });

  it("treats a current model of another provider as not a candidate", () => {
    const next = escalateModel({
      recommendations: recommendations(frontier),
      current: { providerId: "openai", modelId: "small" },
    });
    assert.equal(next?.model.modelId, "huge");
  });

  it("is null with no recommendations", () => {
    assert.equal(escalate("small", {}, emptyRecommendations()), null);
  });

  it("is null for a single candidate that is the current model", () => {
    assert.equal(escalate("mid", {}, recommendations([frontier[1]])), null);
  });
});
