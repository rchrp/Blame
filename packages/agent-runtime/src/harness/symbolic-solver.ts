import { spawn } from "node:child_process";
import { symbolicLimits } from "./symbolic-types.js";

type ProcessResult = {
  output: string;
  error?: string;
  status?: "sat" | "unsat" | "unknown";
};
export function runSymbolicSolver(
  executable: string,
  options: {
    query?: string;
    values?: string[];
    timeoutMs: number;
    signal?: AbortSignal;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted)
    return Promise.resolve({ output: "", error: "cancelled" });
  return new Promise((resolve) => {
    const child = spawn(
      executable,
      options.query ? ["-in", "-smt2"] : ["-version"],
      {
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let output = "",
      stderr = "",
      bytes = 0,
      error: string | undefined;
    let status: ProcessResult["status"],
      finished = false,
      drain: NodeJS.Timeout | undefined;
    const stop = (reason: string) => {
      error ??= reason;
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else child.kill("SIGKILL");
      drain ??= setTimeout(() => finish(), 100);
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("timed_out"), options.timeoutMs);
    const finish = (code?: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drain);
      options.signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      if (!error && code !== 0) error = "solver_process_failed";
      if (!error && stderr.trim()) error = "solver_stderr";
      resolve({
        output,
        ...(status ? { status } : {}),
        ...(error ? { error } : {}),
      });
    };
    const capture = (chunk: Buffer, isError: boolean) => {
      if (finished) return;
      bytes += chunk.length;
      if (bytes > symbolicLimits.outputBytes) {
        stop("output_limit");
        return;
      }
      if (isError) {
        stderr += chunk.toString("utf8");
        return;
      }
      output += chunk.toString("utf8");
      if (!options.query || status) return;
      const first = /^(sat|unsat|unknown)\r?\n/.exec(output);
      if (!first) {
        if (output.includes("\n")) stop("invalid_solver_status");
        return;
      }
      status = first[1] as NonNullable<ProcessResult["status"]>;
      child.stdin.end(
        status === "sat"
          ? `(get-value (${options.values!.join(" ")}))\n(exit)\n`
          : "(exit)\n",
      );
    };
    child.stdout.on("error", () => {
      if (!finished) stop("solver_output_failed");
    });
    child.stderr.on("error", () => {
      if (!finished) stop("solver_output_failed");
    });
    child.stdout.on("data", (chunk: Buffer) => capture(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => capture(chunk, true));
    child.on("error", (cause: NodeJS.ErrnoException) => {
      error =
        cause.code === "ENOENT" ? "solver_unavailable" : "solver_spawn_failed";
      finish();
    });
    child.stdin.on("error", () => {
      if (!finished) stop("solver_input_failed");
    });
    child.once("close", finish);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else if (options.query)
      child.stdin.write(
        `(set-option :timeout ${options.timeoutMs})\n${options.query}\n(check-sat)\n`,
      );
    else child.stdin.end();
  });
}

export function parseSymbolicValues(
  output: string,
  names: string[],
): Map<string, number | boolean> {
  const text = output.replace(/^sat\r?\n/, "").trim();
  if (text.length > symbolicLimits.outputBytes || !/^\([\s\S]*\)$/.test(text))
    throw new Error("invalid_solver_model");
  const values = new Map<string, number | boolean>();
  const remaining = text
    .slice(1, -1)
    .replace(
      /\(\s*(p\d+)\s+(true|false|-?\d+|\(\s*-\s+\d+\s*\))\s*\)/g,
      (_all, name: string, literal: string) => {
        if (!names.includes(name) || values.has(name))
          throw new Error("invalid_solver_model");
        const value =
          literal === "true"
            ? true
            : literal === "false"
              ? false
              : literal.startsWith("(")
                ? -Number(literal.replace(/[()\s-]/g, ""))
                : Number(literal);
        if (typeof value === "number" && !Number.isSafeInteger(value))
          throw new Error("invalid_solver_model");
        values.set(name, value);
        return "";
      },
    );
  if (remaining.trim() || values.size !== names.length)
    throw new Error("invalid_solver_model");
  return values;
}
