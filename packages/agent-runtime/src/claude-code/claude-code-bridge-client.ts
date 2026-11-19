import { createHmac } from "node:crypto";

import type { ClaudeCodeEffort } from "./claude-code-protocol.js";

export const tokenPrefix = "bcc1";

/** What a worker needs from the Claude Code bridge, hosted here or not. */
export type ClaudeCodeBridgeHandle = {
  /** True in the worker that runs the bridge and its Claude Code processes. */
  readonly hosting: boolean;
  /** Claude Code processes running in this worker. */
  readonly lanes: number;
  token(scope: string): string;
  baseUrl(host: string, effort?: ClaudeCodeEffort): string;
  /** Whether the bridge still answers. */
  reachable(): Promise<boolean>;
  closeScopes(scopes: string[]): Promise<void>;
  close(): Promise<void>;
};

/**
 * A stable API key for one conversation scope. Scopes starting with `op:`
 * are one-off operations whose Claude Code process closes soon after.
 */
export function bridgeToken(secret: Buffer, scope: string) {
  const encoded = Buffer.from(scope).toString("base64url");
  return `${tokenPrefix}.${encoded}.${bridgeMac(secret, encoded)}`;
}

export function bridgeMac(secret: Buffer, value: string) {
  return createHmac("sha256", secret)
    .update(value)
    .digest("base64url")
    .slice(0, 32);
}

/** The bridge another agent worker hosts, reached on loopback. */
export class SharedClaudeCodeBridge implements ClaudeCodeBridgeHandle {
  readonly hosting = false;
  readonly lanes = 0;
  readonly port: number;
  private readonly secret: Buffer;

  constructor(port: number, secret: string) {
    this.port = port;
    this.secret = Buffer.from(secret);
  }

  token(scope: string) {
    return bridgeToken(this.secret, scope);
  }

  baseUrl(host: string, effort?: ClaudeCodeEffort) {
    const prefix = effort ? `/effort/${effort}` : "";
    return `http://${host}:${this.port}${prefix}/v1`;
  }

  async reachable() {
    return this.call("GET", "probe");
  }

  async closeScopes(scopes: string[]) {
    await Promise.all(scopes.map((scope) => this.call("DELETE", scope)));
  }

  async close() {}

  private async call(method: "DELETE" | "GET", scope: string) {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/bridge`, {
        headers: { "x-api-key": this.token(scope) },
        method,
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }
}
