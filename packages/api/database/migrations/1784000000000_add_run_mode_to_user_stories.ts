import { BaseSchema } from '@adonisjs/lucid/schema'

// Where the story runs, chosen by the person: local container, cloud
// preview or direct (in the project folder). Unlike workspace_mode, which
// describes the worktree while the story runs, it outlives a requeue.
export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('user_stories', (table) => {
      table.string('run_mode', 32).nullable().after('workspace_mode')
    })
    this.schema.alterTable('user_story_agent_runs', (table) => {
      table.string('provider_id', 80).nullable()
      table.string('model_id', 255).nullable()
      table.string('reasoning_effort', 32).nullable()
    })
  }

  async down() {
    this.schema.alterTable('user_story_agent_runs', (table) => {
      table.dropColumn('provider_id')
      table.dropColumn('model_id')
      table.dropColumn('reasoning_effort')
    })
    this.schema.alterTable('user_stories', (table) => {
      table.dropColumn('run_mode')
    })
  }
}
