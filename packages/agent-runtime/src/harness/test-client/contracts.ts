import { unit } from "./harness.js";

// The tool input schemas, as blame-harness checks a model's call
// (`validate.rs`, zod's semantics): `safeParse` answers zod's shape.

type Parsed = { success: true; data: any } | { success: false; error: { message: string } }; // eslint-disable-line @typescript-eslint/no-explicit-any

export function schema(name: string, lenient = false) {
  return {
    name,
    safeParse(value: unknown): Parsed {
      const result = unit("parseInput", name, value, lenient) as { success: boolean; data?: unknown; message?: string };
      return result.success ? { success: true, data: result.data } : { success: false, error: { message: result.message ?? "" } };
    },
  };
}

export const lightSearchCodeInputSchema = schema("search_code");
export const lightReadCodeInputSchema = schema("read_code");
export const lightEditCodeInputSchema = schema("edit_code");
// With the analyze kind (symbolic analysis enabled), and without.
export const lightRunTaskInputSchema = schema("run_task_analyze");
export const lightDefaultRunTaskInputSchema = schema("run_task");
export const finishTaskInputSchema = schema("finish_task");
export const finishSummaryLimit = 100_000;
/** A task contract's required checks, as the harness's finish checks them. */
export const lightRequiredChecksSchema = {
  safeParse(value: unknown): Parsed {
    const result = unit("parseRequiredChecks", value) as { success: boolean; data?: unknown; message?: string };
    return result.success ? { success: true, data: result.data } : { success: false, error: { message: result.message ?? "" } };
  },
};
