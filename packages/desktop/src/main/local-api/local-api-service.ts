import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
import { localApiKey, type SecretStorage } from "./local-api-key.ts";

export type LocalApiSession = {
  url: string;
  token: string;
};

type LocalApiOptions = {
  /** Entry point of the API build: `@blame/api/local`. */
  modulePath: string;
  /** Where the database, stored objects and key live. */
  dataDirectory: string;
  secrets: SecretStorage;
};

type LocalApiMessage =
  | { type: "ready"; url: string; token: string }
  | { type: "error"; message: string };

const startupTimeoutMs = 60_000;
const shutdownTimeoutMs = 2_000;

/**
 * Runs the Blame API on this computer, for use without an account: a utility
 * process serving SQLite on a loopback port. Started on first use, restarted
 * after a crash; each start issues a new token.
 */
export class LocalApiService {
  private readonly options: LocalApiOptions;
  private process?: UtilityProcess;
  private starting?: Promise<LocalApiSession>;

  constructor(options: LocalApiOptions) {
    this.options = options;
  }

  session() {
    this.starting ??= this.start().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  async shutdown() {
    const child = this.process;
    this.process = undefined;
    this.starting = undefined;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, shutdownTimeoutMs);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }

  private async start() {
    const { dataDirectory, modulePath, secrets } = this.options;
    const key = await localApiKey(dataDirectory, secrets);
    const child = utilityProcess.fork(modulePath, [], {
      env: {
        ...process.env,
        APP_KEY: key,
        DB_SQLITE_FILE: join(dataDirectory, "blame.sqlite"),
        BLAME_LOCAL_STORAGE_DIRECTORY: join(dataDirectory, "objects"),
        LOG_LEVEL: "warn",
      },
      serviceName: "Blame Local API",
      stdio: "inherit",
    });
    this.process = child;
    child.once("exit", () => {
      if (this.process !== child) return;
      this.process = undefined;
      this.starting = undefined;
    });
    return readySession(child);
  }
}

function readySession(child: UtilityProcess) {
  return new Promise<LocalApiSession>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The local Blame API did not start in time."));
    }, startupTimeoutMs);
    const settle = () => {
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("exit", onExit);
    };
    const onMessage = (message: LocalApiMessage) => {
      settle();
      if (message.type === "ready")
        resolve({ url: message.url, token: message.token });
      else
        reject(
          new Error(`The local Blame API failed to start: ${message.message}`),
        );
    };
    const onExit = (code: number) => {
      settle();
      reject(new Error(`The local Blame API exited with code ${code}.`));
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}
