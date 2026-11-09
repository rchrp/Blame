import { BaseSchema } from '@adonisjs/lucid/schema'

// Files uploaded by a conversation the app keeps itself (plan mode, the
// new-project assistant) have no owner row: the thread lives in the app. They
// are flagged so the orphan cleanup gives them a longer grace.
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('file_attachments', (table) => {
      table.boolean('conversation_attachment').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable('file_attachments', (table) => {
      table.dropColumn('conversation_attachment')
    })
  }
}
