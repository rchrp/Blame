import type { EnginePlatformClient } from "@blame/agent-runtime/engine-protocol"

/**
 * Providers, models and connections, from the engine host: the engine's
 * models.dev catalog with the person's credentials. Every picker reads it.
 */
export function engineProviderClient(engine: EnginePlatformClient) {
  return {
    list: (refresh: boolean) => engine.call("providers", { refresh }),
    saveCredential: (
      input: Parameters<typeof engine.call<"saveCredential">>[1]
    ) => engine.call("saveCredential", input),
    deleteCredential: (id: string) => engine.call("deleteCredential", { id }),
    moveCredential: (
      input: Parameters<typeof engine.call<"moveCredential">>[1]
    ) => engine.call("moveCredential", input),
    credentialStorage: () => engine.call("credentialStorage", undefined),
    signInChatGpt: (label?: string, storage?: "account" | "device") =>
      engine.call("signInChatGpt", { label, storage }),
    claudeCodeStatus: () => engine.call("claudeCodeStatus", undefined),
    connectClaudeCode: (label?: string) =>
      engine.call("connectClaudeCode", { label }),
    planUsage: (input: { providerId: string; credentialLabel?: string }) =>
      engine.call("planUsage", input),
  }
}

export type ProviderClient = ReturnType<typeof engineProviderClient>
