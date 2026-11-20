import { BaseSchema } from '@adonisjs/lucid/schema'
import { isSqlite } from '#database/sql_dialect'

// Columns that held the Cline runtime's copy of a quick chat's conversation.
const agentColumns = [
  'agent_status',
  'cline_session_id',
  'agent_provider_id',
  'agent_model_id',
  'agent_last_event',
  'agent_last_error',
  'agent_activities',
  'agent_final_response',
  'agent_usage',
  'agent_session_summary',
]

/**
 * Quick chats run on the agent engine, which owns the conversation and copies
 * its log to `engine_sessions`. The API keeps only the chat's own fields and
 * the id of its engine session; the messages, runs and activities it stored
 * for the Cline runtime are dropped.
 */
export default class extends BaseSchema {
  async up() {
    // Children first: runs point to messages, activities to runs.
    this.schema.dropTable('quick_chat_agent_run_activities')
    this.schema.dropTable('quick_chat_agent_runs')
    this.schema.dropTable('quick_chat_message_file_attachments')
    this.schema.dropTable('quick_chat_messages')

    this.schema.alterTable('quick_chats', (table) => {
      for (const column of agentColumns) table.dropColumn(column)
    })
    // No foreign key: the chat is created before the engine pushes the
    // session's first record, and a session that was never pushed has no row.
    this.schema.alterTable('quick_chats', (table) => {
      const column = table.string('engine_session_id', 64).nullable()
      // Engine session ids are compared exactly, as in `engine_sessions`.
      if (!isSqlite(this.db)) column.collate('utf8mb4_bin')
      table.unique(['engine_session_id'], 'quick_chats_engine_session_id_unique')
    })
  }

  async down() {
    throw new Error('Quick chat conversations moved to engine sessions and cannot be restored')
  }
}
