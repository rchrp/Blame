export type SymbolicInput =
  | { min: number; max: number; type?: "integer" }
  | { type: "boolean" };

export type SymbolicRequest = {
  source: string;
  functionName: string;
  inputs: Record<string, SymbolicInput>;
  assertion: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  solverPath?: string;
};

export type SymbolicResult = {
  status: "counterexample" | "bounded_no_counterexample" | "unknown";
  reason: string;
  sourceSha256: string;
  functionName: string;
  assertion: string;
  inputs: Record<string, SymbolicInput>;
  scope: string;
  assumptions?: string[];
  validationAdmission: false;
  solver?: { executable: string; version: string; querySha256: string };
  witness?: {
    inputs: Record<string, number | boolean>;
    result: number | boolean;
    assertion: false;
    concretelyReproduced: true;
  };
};

export type Scalar = number | boolean;
export type Bindings = Map<string, Scalar>;
export type IntegerExpression = {
  type: "integer";
  smt: string;
  min: bigint;
  max: bigint;
};
export type BooleanExpression = { type: "boolean"; smt: string };
export type Expression = IntegerExpression | BooleanExpression;
export type Environment = Map<string, Expression>;
export const symbolicLimits = {
  sourceBytes: 256 * 1024,
  targetCharacters: 16 * 1024,
  assertionCharacters: 4096,
  nodes: 512,
  paths: 32,
  inputs: 8,
  maximumSmtBytes: 128 * 1024,
  outputBytes: 64 * 1024,
  defaultTimeoutMs: 2500,
  maximumTimeoutMs: 10_000,
};

export class SymbolicUnsupported extends Error {}
export function unsupported(reason: string): never {
  throw new SymbolicUnsupported(reason);
}
