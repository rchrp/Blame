import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('projects', (table) => {
      table.integer('last_story_number').unsigned().notNullable().defaultTo(0)
    })
    this.defer(async (db) => {
      await db.rawQuery(`
        UPDATE projects AS project
        SET last_story_number = COALESCE((
          SELECT MAX(story.story_number)
          FROM user_stories AS story
          WHERE story.project_id = project.id
        ), 0)
      `)
    })
  }

  async down() {
    this.schema.alterTable('projects', (table) => {
      table.dropColumn('last_story_number')
    })
  }
}
