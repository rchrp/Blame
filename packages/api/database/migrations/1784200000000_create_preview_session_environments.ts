import { BaseSchema } from '@adonisjs/lucid/schema'

// The environment a cloud preview gets from the developer's computer, kept
// apart from the session's plan and encrypted with the app key. A row can
// exist before its session does: the desktop sends it with the request that
// creates the session.
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('preview_session_environments', (table) => {
      table.string('session_id', 40).primary()
      table.text('environment_encrypted', 'longtext').notNullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').notNullable()
    })
  }

  async down() {
    this.schema.dropTable('preview_session_environments')
  }
}
