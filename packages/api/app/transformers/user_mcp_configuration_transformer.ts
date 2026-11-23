import type UserMcpConfiguration from '#models/user_mcp_configuration'
import type { PresentedMcpServer } from '#services/user_mcp_configurations_service'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class UserMcpConfigurationTransformer extends BaseTransformer<UserMcpConfiguration> {
  toObject() {
    return {
      // The controller puts the servers with their synced secrets here.
      servers: (this.resource.$extras.servers ?? this.resource.servers) as PresentedMcpServer[],
      createdAt: this.resource.createdAt.toISO(),
      updatedAt: this.resource.updatedAt?.toISO() ?? null,
    }
  }
}
