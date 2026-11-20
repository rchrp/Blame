import { BaseSchema } from '@adonisjs/lucid/schema'
import { isSqlite } from '#database/sql_dialect'

// Columns that held the Cline runtime's copy of a story's conversation.
const agentColumns = [
  'cline_session_id',
  'agent_provider_id',
  'agent_model_id',
  'agent_last_event',
  'agent_activities',
  'agent_final_response',
  'agent_usage',
  'agent_session_summary',
  'active_agent_run_id',
]

/**
 * Development stories run on the agent engine, which owns the conversation
 * and copies its log to `engine_sessions`. A story keeps its product fields,
 * the agent state the board shows and the id of its engine session; the
 * comments, runs and activities it stored for the Cline runtime are dropped.
 */
export default class extends BaseSchema {
  async up() {
    // The story points to its active run: that key goes before the runs, and
    // the indexes before their columns.
    this.schema.alterTable('user_stories', (table) => {
      table.dropForeign(['active_agent_run_id'], 'user_stories_active_agent_run_id_foreign')
    })
    this.schema.alterTable('user_stories', (table) => {
      table.dropIndex(['active_agent_run_id'], 'user_stories_active_agent_run_id_index')
      table.dropIndex(['cline_session_id'], 'user_stories_cline_session_id_index')
    })
    // Children first: activities point to runs, runs and attachment links to
    // comments.
    this.schema.dropTable('user_story_agent_run_activities')
    this.schema.dropTable('user_story_agent_runs')
    this.schema.dropTable('user_story_comment_file_attachments')
    this.schema.dropTable('user_story_comments')

    this.schema.alterTable('user_stories', (table) => {
      for (const column of agentColumns) table.dropColumn(column)
    })
    // No foreign key: the story exists before the engine pushes the session's
    // first record, and a session that was never pushed has no row.
    this.schema.alterTable('user_stories', (table) => {
      const column = table.string('engine_session_id', 64).nullable()
      // Engine session ids are compared exactly, as in `engine_sessions`.
      if (!isSqlite(this.db)) column.collate('utf8mb4_bin')
      // The models that worked on the story, for the board.
      table.json('agent_models').nullable()
      table.unique(['engine_session_id'], 'user_stories_engine_session_id_unique')
    })
  }

  async down() {
    throw new Error('Story conversations moved to engine sessions and cannot be restored')
  }
}
