import { execFile, spawn as spawnProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { runtimeAgentClient } from "./runtime-agent.ts";

// A Blame Runtime for tests that count what the desktop asks of it: the
// runtime agent's requests run on this computer, without a VM. Each exec or
// spawn starts one program; `git` and `docker` go through logging wrappers,
// so the programs a shell script starts are counted too. Docker answers
// from `dockerRows` and never reaches a real engine.

type Request = { id: number; method: string; params: Record<string, unknown> };

export type RuntimeCount = {
  /** Requests sent to the runtime agent. */
  requests: number;
  /** Programs started in the runtime. */
  processes: number;
  byMethod: Record<string, number>;
  programs: Record<string, number>;
};

export class RuntimeAgentTestHost {
  dockerRows = "";
  private readonly requests: Request[] = [];
  private readonly directory: string;

  private constructor(directory: string) {
    this.directory = directory;
  }

  /** Routes the runtime agent of this process to a new test host. */
  static async install(directory: string) {
    const host = new RuntimeAgentTestHost(directory);
    await host.writeWrappers();
    runtimeAgentClient({
      platform: process.platform,
      spawnProcess: (() => host.agentProcess()) as never,
    });
    return host;
  }

  reset() {
    this.requests.length = 0;
    return writeFile(this.launchLog, "");
  }

  async count(): Promise<RuntimeCount> {
    const launched = (await readFile(this.launchLog, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    const programs: Record<string, number> = {};
    for (const program of launched)
      programs[program] = (programs[program] ?? 0) + 1;
    const byMethod: Record<string, number> = {};
    let direct = 0;
    for (const { method, params } of this.requests) {
      byMethod[method] = (byMethod[method] ?? 0) + 1;
      if (method !== "exec" && method !== "spawn") continue;
      const command = String(params.command);
      if (command === "git" || command === "docker") continue;
      programs[command] = (programs[command] ?? 0) + 1;
      direct += 1;
    }
    return {
      requests: this.requests.length,
      processes: direct + launched.length,
      byMethod,
      programs,
    };
  }

  private get bin() {
    return join(this.directory, "bin");
  }

  private get launchLog() {
    return join(this.directory, "launches.log");
  }

  private get home() {
    return join(this.directory, "home");
  }

  private async writeWrappers() {
    await mkdir(this.bin, { recursive: true });
    await mkdir(this.home, { recursive: true });
    const git = (
      await new Promise<string>((resolve, reject) =>
        execFile("sh", ["-c", "command -v git"], (error, stdout) =>
          error ? reject(error) : resolve(stdout.trim()),
        ),
      )
    ).trim();
    const wrappers = {
      git: `#!/bin/sh\necho git >> '${this.launchLog}'\nexec '${git}' "$@"\n`,
      docker: [
        "#!/bin/sh",
        `echo docker >> '${this.launchLog}'`,
        `rows='${join(this.directory, "docker-rows")}'`,
        'case "$1" in',
        '  ps) [ -s "$rows" ] && echo container ;;',
        '  inspect) cat "$rows" ;;',
        "esac",
        "",
      ].join("\n"),
    };
    for (const [name, script] of Object.entries(wrappers)) {
      await writeFile(join(this.bin, name), script);
      await chmod(join(this.bin, name), 0o755);
    }
    await this.reset();
  }

  private environment(params: Record<string, unknown>) {
    const requested = (params.env ?? {}) as Record<string, string>;
    return {
      ...Object.fromEntries(
        Object.entries(requested).filter(([key]) => key.startsWith("GIT_")),
      ),
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: this.home,
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
    };
  }

  private agentProcess() {
    const agent = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: null;
      stderr: PassThrough;
      stdin: Writable;
      stdout: PassThrough;
      kill(): boolean;
    };
    agent.exitCode = null;
    agent.signalCode = null;
    agent.stdout = new PassThrough();
    agent.stderr = new PassThrough();
    agent.kill = () => true;
    const reply = (message: unknown) =>
      agent.stdout.write(`${JSON.stringify(message)}\n`);
    agent.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of chunk.toString().split("\n").filter(Boolean)) {
          const request = JSON.parse(line) as Request;
          this.requests.push(request);
          void this.handle(request, reply);
        }
        callback();
      },
    });
    return agent;
  }

  private async handle(request: Request, reply: (message: unknown) => void) {
    const { id, method, params } = request;
    await writeFile(join(this.directory, "docker-rows"), this.dockerRows);
    if (method === "readExistingFiles") {
      const files: Record<string, string | null> = {};
      for (const path of params.paths as string[])
        files[path] = await readFile(path, "utf8").catch(() => null);
      reply({ id, ok: true, result: { files } });
      return;
    }
    if (method === "spawn") {
      const processId = String(id);
      reply({ id, ok: true, result: { processId } });
      const child = spawnProcess(
        String(params.command),
        (params.args as string[]) ?? [],
        {
          cwd: params.cwd as string | undefined,
          env: this.environment(params),
        },
      );
      const forward = (type: "stdout" | "stderr") => (data: Buffer) =>
        reply({ event: "spawn", processId, type, data: data.toString() });
      child.stdout.on("data", forward("stdout"));
      child.stderr.on("data", forward("stderr"));
      child.once("error", () =>
        reply({ event: "spawn", processId, type: "exit", code: 127 }),
      );
      child.once("close", (code) =>
        reply({ event: "spawn", processId, type: "exit", code }),
      );
      return;
    }
    if (method !== "exec") {
      reply({ id, ok: false, error: { message: `Unsupported ${method}` } });
      return;
    }
    execFile(
      String(params.command),
      (params.args as string[]) ?? [],
      {
        cwd: params.cwd as string | undefined,
        env: this.environment(params),
        maxBuffer: 64 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        reply(
          error
            ? {
                id,
                ok: false,
                error: { message: "Runtime command failed", stdout, stderr },
              }
            : { id, ok: true, result: { stdout, stderr, code: 0 } },
        ),
    );
  }
}
