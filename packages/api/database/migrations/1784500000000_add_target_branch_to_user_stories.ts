import { BaseSchema } from '@adonisjs/lucid/schema'

// The branch a story starts from and merges into, chosen in the composer or
// recorded at its first run. Unlike branch, the story's own branch.
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('user_stories', (table) => {
      table.string('target_branch', 255).nullable().after('branch')
    })
  }

  async down() {
    this.schema.alterTable('user_stories', (table) => {
      table.dropColumn('target_branch')
    })
  }
}
