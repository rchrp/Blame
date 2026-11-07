import { BaseSchema } from '@adonisjs/lucid/schema'

// How the agents talk and work for this person. The four account settings
// default to their middle notch; a story may override the ambition, and
// null means it follows the account's.
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('user_ai_preferences', (table) => {
      table.string('response_style', 16).notNullable().defaultTo('balanced')
      table.string('experience', 16).notNullable().defaultTo('comfortable')
      table.string('autonomy', 16).notNullable().defaultTo('balanced')
      table.string('ambition', 16).notNullable().defaultTo('standard')
    })
    this.schema.alterTable('user_stories', (table) => {
      table.string('ambition', 16).nullable()
    })
  }

  async down() {
    this.schema.alterTable('user_stories', (table) => {
      table.dropColumn('ambition')
    })
    this.schema.alterTable('user_ai_preferences', (table) => {
      table.dropColumn('response_style')
      table.dropColumn('experience')
      table.dropColumn('autonomy')
      table.dropColumn('ambition')
    })
  }
}
