import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The secrets (arguments, environment variables, headers) of the MCP servers
 * a person chose to sync with their account, in one encrypted blob like the
 * provider credentials. Null for everyone who did not choose that.
 */
export default class extends BaseSchema {
  protected tableName = 'user_mcp_configurations'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('encrypted_secrets').nullable()
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('encrypted_secrets')
    })
  }
}
