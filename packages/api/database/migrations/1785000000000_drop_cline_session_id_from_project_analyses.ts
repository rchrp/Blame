import { BaseSchema } from '@adonisjs/lucid/schema'

const tables = ['project_initializations', 'project_code_practice_analyses']

/**
 * A project's initialization and code practice analysis run as engine tasks,
 * whose logs stay on the machine that ran them: no Cline session is left to
 * point to, and nothing reopens the transcript of a past analysis.
 */
export default class extends BaseSchema {
  async up() {
    for (const table of tables)
      this.schema.alterTable(table, (columns) => {
        columns.dropColumn('cline_session_id')
      })
  }

  async down() {
    for (const table of tables)
      this.schema.alterTable(table, (columns) => {
        columns.string('cline_session_id').nullable()
      })
  }
}
