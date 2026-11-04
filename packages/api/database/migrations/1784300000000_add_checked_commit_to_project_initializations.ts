import { BaseSchema } from '@adonisjs/lucid/schema'

// The last commit of the project branch the preview environment was checked
// against: a project whose branch moved since gets checked again before its
// next story preview.
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('project_initializations', (table) => {
      table.string('checked_commit', 64).nullable()
    })
  }

  async down() {
    this.schema.alterTable('project_initializations', (table) => {
      table.dropColumn('checked_commit')
    })
  }
}
