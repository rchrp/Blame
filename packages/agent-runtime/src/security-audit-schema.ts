// The input schemas of the security audit's result tools. The engine checks
// them (a subset of JSON Schema: no `pattern`, no `$ref`), so a result that
// misses a field the report needs is refused and corrected by the model.

const text = { type: "string", minLength: 1 } as const;
const texts = { type: "array", items: { type: "string" } } as const;

const locationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: text,
    startLine: { type: "number" },
    endLine: { type: "number" },
    symbol: { type: "string" },
  },
} as const;

const evidenceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: text,
    location: locationSchema,
    code: { type: "string" },
  },
} as const;

const taxonomySchema = {
  type: "object",
  additionalProperties: false,
  properties: { cwe: texts, owasp: texts, asvs: texts },
} as const;

const threatModelSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "assets",
    "actors",
    "trustBoundaries",
    "attackerInputs",
    "securityInvariants",
  ],
  properties: {
    assets: texts,
    actors: texts,
    trustBoundaries: texts,
    attackerInputs: texts,
    securityInvariants: texts,
  },
} as const;

export const securityDiscoveryResultSchema = {
  type: "object",
  additionalProperties: false,
  required: ["threatModel", "candidates", "inspectedPaths", "limitations"],
  properties: {
    threatModel: threatModelSchema,
    candidates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "id",
          "title",
          "summary",
          "vulnerabilityFamily",
          "rootControl",
          "component",
          "attacker",
          "locations",
          "evidence",
          "taxonomy",
        ],
        properties: {
          id: { type: "string" },
          title: text,
          summary: text,
          vulnerabilityFamily: text,
          rootControl: text,
          component: text,
          attacker: text,
          asset: { type: "string" },
          locations: { type: "array", items: locationSchema },
          evidence: { type: "array", items: evidenceSchema },
          taxonomy: taxonomySchema,
        },
      },
    },
    inspectedPaths: texts,
    limitations: texts,
  },
} as const;

/**
 * The validator's result: `candidateIds` name only the candidates it was
 * given, so a made-up id is refused by the engine.
 */
export function securityValidationResultSchema(candidateIds: string[]) {
  const ids = candidateIds.length
    ? { type: "array", items: { type: "string", enum: candidateIds } }
    : texts;
  return {
    type: "object",
    additionalProperties: false,
    required: ["findings", "rejected", "inspectedPaths", "limitations"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "candidateIds",
            "title",
            "severity",
            "confidence",
            "priority",
            "taxonomy",
            "attacker",
            "rootCause",
            "attackPath",
            "impact",
            "evidence",
            "affectedLocations",
            "remediation",
            "rationale",
            "counterEvidence",
          ],
          properties: {
            candidateIds: ids,
            title: text,
            severity: { enum: ["critical", "high", "medium", "low"] },
            confidence: { enum: ["high", "medium", "low"] },
            priority: { enum: ["p0", "p1", "p2", "p3"] },
            taxonomy: taxonomySchema,
            attacker: text,
            asset: { type: "string" },
            rootCause: {
              type: "object",
              additionalProperties: false,
              required: ["summary"],
              properties: { summary: text, location: locationSchema },
            },
            attackPath: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label"],
                properties: { label: text, location: locationSchema },
              },
            },
            impact: text,
            evidence: { type: "array", items: evidenceSchema },
            affectedLocations: { type: "array", items: locationSchema },
            remediation: {
              type: "object",
              additionalProperties: false,
              required: ["summary", "guidance"],
              properties: { summary: text, guidance: texts },
            },
            rationale: text,
            counterEvidence: texts,
          },
        },
      },
      rejected: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["candidateIds", "reason"],
          properties: { candidateIds: ids, reason: text },
        },
      },
      inspectedPaths: texts,
      limitations: texts,
    },
  };
}
