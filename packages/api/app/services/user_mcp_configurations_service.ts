import UserMcpConfiguration, {
  type CloudMcpSecrets,
  type CloudMcpServer,
} from '#models/user_mcp_configuration'
import type { saveUserMcpConfigurationValidator } from '#validators/user_mcp_configuration'
import encryption from '@adonisjs/core/services/encryption'
import type { Infer } from '@vinejs/vine/types'

type SaveInput = Infer<typeof saveUserMcpConfigurationValidator>
type SecretsByServer = Record<string, CloudMcpSecrets>

/** A server as the apps read it: the synced secrets are back inline. */
export type PresentedMcpServer = CloudMcpServer & {
  secrets?: CloudMcpSecrets
  secretsSynced?: true
}

export default class UserMcpConfigurationsService {
  get(userId: string) {
    return UserMcpConfiguration.find(userId)
  }

  async save(userId: string, input: SaveInput) {
    validateServers(input.servers)
    const existing = await UserMcpConfiguration.find(userId)
    const previous = existing ? await this.secrets(existing) : {}
    const secrets: SecretsByServer = {}
    const servers = input.servers.map(({ secrets: given, secretsSynced, ...server }) => {
      if (secretsSynced === false) return server
      // Sent: replaced. Not sent: kept as it was (an older app, or an edit
      // that did not touch them).
      const kept = given ?? previous[server.name]
      if (kept) secrets[server.name] = kept
      return server
    })
    const encryptedSecrets = Object.keys(secrets).length
      ? await encryption.encrypt(JSON.stringify(secrets))
      : null
    if (!existing) {
      return UserMcpConfiguration.create({ userId, servers, encryptedSecrets })
    }
    existing.servers = servers
    existing.encryptedSecrets = encryptedSecrets
    await existing.save()
    return existing
  }

  /** The synced secrets by server name, decrypted for the owner only. */
  async secrets(configuration: UserMcpConfiguration): Promise<SecretsByServer> {
    if (!configuration.encryptedSecrets) return {}
    const decrypted = await encryption.decrypt(configuration.encryptedSecrets)
    return typeof decrypted === 'string' ? (JSON.parse(decrypted) as SecretsByServer) : {}
  }

  async present(configuration: UserMcpConfiguration): Promise<PresentedMcpServer[]> {
    const secrets = await this.secrets(configuration)
    return configuration.servers.map((server) =>
      secrets[server.name]
        ? { ...server, secrets: secrets[server.name], secretsSynced: true as const }
        : server
    )
  }
}

function validateServers(servers: SaveInput['servers']) {
  const names = new Set<string>()
  for (const server of servers) {
    const normalizedName = server.name.toLocaleLowerCase()
    if (names.has(normalizedName)) throw new Error('MCP server names must be unique')
    names.add(normalizedName)
    if (server.transport === 'stdio') {
      if (!server.command || server.url) throw new Error('Invalid stdio MCP server configuration')
      if (/\s/.test(server.command)) throw new Error('MCP commands must not contain arguments')
      if (server.secrets?.headers) throw new Error('Invalid stdio MCP server configuration')
      continue
    }
    if (!server.url || server.command) throw new Error('Invalid remote MCP server configuration')
    if (server.secrets?.args || server.secrets?.cwd || server.secrets?.env) {
      throw new Error('Invalid remote MCP server configuration')
    }
    const url = new URL(server.url)
    if (url.username || url.password || url.search || url.hash) {
      throw new Error(
        'MCP server URLs stored in the cloud cannot contain credentials or parameters'
      )
    }
  }
}
