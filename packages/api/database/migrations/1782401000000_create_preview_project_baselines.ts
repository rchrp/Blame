import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.createTable('preview_project_baselines', (table) => {
      table.string('id', 40).primary()
      table
        .string('project_id', 40)
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.string('fingerprint', 64).notNullable().unique()
      table.string('base_revision', 128).notNullable()
      table.string('sanitized_tree_hash', 64).notNullable()
      table.string('plan_hash', 64).notNullable()
      table.string('lockfile_hash', 64).notNullable()
      table.string('runner_version', 64).notNullable()
      table.integer('protocol_version').unsigned().notNullable()
      table.string('runner_image_digest', 160).notNullable()
      table.string('provider', 32).notNullable()
      table.string('provider_snapshot_id', 255).nullable()
      table.string('owner_sandbox_name', 255).nullable()
      table.string('status', 16).notNullable()
      table.text('error', 'longtext').nullable()
      table.bigInteger('snapshot_bytes').unsigned().nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('last_used_at').nullable()
      table.timestamp('expires_at').nullable()
      table.index(['project_id', 'status', 'expires_at'])
      table.index(['status', 'last_used_at'])
    })

    this.schema.alterTable('preview_sessions', (table) => {
      table
        .string('baseline_id', 40)
        .nullable()
        .references('id')
        .inTable('preview_project_baselines')
        .onDelete('SET NULL')
      table.index(['baseline_id'])
    })

    this.schema.alterTable('preview_workspace_artifacts', (table) => {
      table.string('mode', 16).nullable()
      table.string('sanitized_tree_hash', 64).nullable()
      table.string('lockfile_hash', 64).nullable()
      table.string('workspace_hash', 64).nullable()
    })
  }

  async down() {
    this.schema.alterTable('preview_sessions', (table) => {
      table.dropForeign(['baseline_id'])
      table.dropIndex(['baseline_id'])
      table.dropColumn('baseline_id')
    })
    this.schema.alterTable('preview_workspace_artifacts', (table) => {
      table.dropColumn('mode')
      table.dropColumn('sanitized_tree_hash')
      table.dropColumn('lockfile_hash')
      table.dropColumn('workspace_hash')
    })
    this.schema.dropTable('preview_project_baselines')
  }
}
