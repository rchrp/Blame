import { createHash } from "node:crypto";
import { compileSymbolicProgram } from "./symbolic-program.js";
import { parseSymbolicValues, runSymbolicSolver } from "./symbolic-solver.js";
import {
  type Scalar,
  type SymbolicRequest,
  type SymbolicResult,
  SymbolicUnsupported,
  symbolicLimits,
} from "./symbolic-types.js";
export type {
  SymbolicInput,
  SymbolicRequest,
  SymbolicResult,
} from "./symbolic-types.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const scope =
  "Only the selected scalar function body and supplied bounded integer/boolean inputs are modeled. Integers and every arithmetic intermediate stay within JavaScript's safe integer range. Calls, loops, mutation, globals, floats, NaN and Infinity are unsupported. A bounded result does not establish repository correctness, executed tests, source admission or user acceptance.";

export async function analyzeSymbolicSource(
  request: SymbolicRequest,
): Promise<SymbolicResult> {
  request = { ...request, inputs: structuredClone(request.inputs) };
  const base = {
    sourceSha256: digest(request.source),
    functionName: request.functionName,
    assertion: request.assertion,
    inputs: structuredClone(request.inputs),
    scope,
    validationAdmission: false as const,
  };
  const unknown = (
    reason: string,
    solver?: SymbolicResult["solver"],
  ): SymbolicResult => ({
    ...base,
    status: "unknown",
    reason,
    ...(solver ? { solver } : {}),
  });
  if (request.signal?.aborted) return unknown("cancelled");
  const timeoutMs = request.timeoutMs ?? symbolicLimits.defaultTimeoutMs;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > symbolicLimits.maximumTimeoutMs
  )
    return unknown("invalid_timeout");
  let program: ReturnType<typeof compileSymbolicProgram>;
  try {
    program = compileSymbolicProgram(request);
  } catch (error) {
    return unknown(
      error instanceof SymbolicUnsupported
        ? error.message
        : "translation_failed",
    );
  }
  const executable = request.solverPath ?? process.env.BLAME_Z3_PATH ?? "z3";
  const started = Date.now();
  const identity = await runSymbolicSolver(executable, {
    timeoutMs,
    signal: request.signal,
  });
  if (identity.error) return unknown(identity.error);
  const version = identity.output.trim();
  if (!/^Z3 version \d+\.\d+\.\d+(?:[.\w -]*)$/.test(version))
    return unknown("unrecognized_solver_identity");
  const solver = { executable, version, querySha256: digest(program.query) };
  const remaining = timeoutMs - (Date.now() - started);
  if (remaining < 1) return unknown("timed_out", solver);
  const result = await runSymbolicSolver(executable, {
    query: program.query,
    values: program.variables.map((entry) => entry.smt),
    timeoutMs: remaining,
    signal: request.signal,
  });
  if (result.error) return unknown(result.error, solver);
  if (result.status === "unknown") return unknown("solver_unknown", solver);
  if (result.status === "unsat") {
    if (result.output.trim() !== "unsat")
      return unknown("invalid_solver_response", solver);
    return {
      ...base,
      solver,
      status: "bounded_no_counterexample",
      reason:
        "No violating input exists in the supplied finite safe integer/boolean domain under the supported isolated-function semantics.",
    };
  }
  if (result.status !== "sat")
    return unknown("invalid_solver_response", solver);
  try {
    const model = parseSymbolicValues(
      result.output,
      program.variables.map((entry) => entry.smt),
    );
    const inputs: Record<string, Scalar> = Object.fromEntries(
      program.variables.map((entry) => {
        const value = model.get(entry.smt)!;
        const contract = request.inputs[entry.name];
        if (
          entry.type === "boolean"
            ? typeof value !== "boolean"
            : typeof value !== "number" ||
              contract.type === "boolean" ||
              value < contract.min ||
              value > contract.max
        )
          throw new Error("model_outside_contract");
        return [entry.name, value];
      }),
    );
    const concrete = program.reproduce(inputs);
    if (concrete.assertion !== false)
      return unknown("counterexample_not_reproduced", solver);
    if (
      typeof concrete.result === "number" &&
      !Number.isSafeInteger(concrete.result)
    )
      return unknown("counterexample_outside_safe_integer_semantics", solver);
    return {
      ...base,
      solver,
      status: "counterexample",
      reason:
        "A violating input was reproduced by interpreting the original supported TypeScript AST with JavaScript scalar operations.",
      witness: {
        inputs,
        result: concrete.result,
        assertion: false,
        concretelyReproduced: true,
      },
    };
  } catch {
    return unknown("invalid_or_unreproduced_solver_model", solver);
  }
}
