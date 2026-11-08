import { BaseSchema } from '@adonisjs/lucid/schema'

// The GitHub pull request opened from the story with Open PR.
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('user_stories', (table) => {
      table.string('pull_request_url', 2048).nullable().after('target_branch')
    })
  }

  async down() {
    this.schema.alterTable('user_stories', (table) => {
      table.dropColumn('pull_request_url')
    })
  }
}
