import { BaseSchema } from '@adonisjs/lucid/schema'

// Installations of the Blame GitHub App that GitHub confirmed a person can
// access, and the repository a project gives the agent in cloud sessions.
// No GitHub token is stored: installation tokens are issued on demand.
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('github_app_installations', (table) => {
      table.uuid('id').primary()
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('installation_id', 32).notNullable()
      table.string('account_login', 100).notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()
      table.unique(['user_id', 'installation_id'], 'gai_user_installation_uq')
    })

    // No foreign key: SQLite (the desktop API) would rebuild the projects
    // table to add one. Issuing a token checks the installation's owner.
    this.schema.alterTable('projects', (table) => {
      table.uuid('github_installation_id').nullable()
      table.string('github_repository_owner', 100).nullable()
      table.string('github_repository_name', 100).nullable()
      table.boolean('github_agent_access').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable('projects', (table) => {
      table.dropColumn('github_installation_id')
      table.dropColumn('github_repository_owner')
      table.dropColumn('github_repository_name')
      table.dropColumn('github_agent_access')
    })
    this.schema.dropTable('github_app_installations')
  }
}
