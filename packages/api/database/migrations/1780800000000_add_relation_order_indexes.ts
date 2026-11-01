import { BaseSchema } from '@adonisjs/lucid/schema'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'
import { isSqlite } from '#database/sql_dialect'

type RelationOrderIndex = {
  columns: string[]
  name: string
  table: string
}

const relationOrderIndexes: RelationOrderIndex[] = [
  {
    columns: ['user_story_id', 'created_at', 'id'],
    name: 'user_story_comments_user_story_id_created_at_id_index',
    table: 'user_story_comments',
  },
  {
    columns: ['user_story_id', 'created_at', 'id'],
    name: 'user_story_agent_runs_user_story_id_created_at_id_index',
    table: 'user_story_agent_runs',
  },
  {
    columns: ['quick_chat_id', 'created_at', 'id'],
    name: 'quick_chat_messages_quick_chat_id_created_at_id_index',
    table: 'quick_chat_messages',
  },
  {
    columns: ['quick_chat_id', 'created_at', 'id'],
    name: 'quick_chat_agent_runs_quick_chat_id_created_at_id_index',
    table: 'quick_chat_agent_runs',
  },
]

export default class extends BaseSchema {
  async up() {
    this.defer(async (db) => {
      for (const index of relationOrderIndexes) {
        await addIndexIfMissing(db, index)
      }
    })
  }

  async down() {
    this.defer(async (db) => {
      for (const index of relationOrderIndexes.toReversed()) {
        await dropIndexIfExists(db, index)
      }
    })
  }
}

async function addIndexIfMissing(db: QueryClientContract, index: RelationOrderIndex) {
  if (isSqlite(db)) {
    const columns = columnPlaceholders(index.columns)
    await db.rawQuery(`CREATE INDEX IF NOT EXISTS ?? ON ?? (${columns})`, [
      index.name,
      index.table,
      ...index.columns,
    ])
    return
  }
  if (await indexExists(db, index.table, index.name)) return
  await db.rawQuery(`ALTER TABLE ?? ADD INDEX ?? (${columnPlaceholders(index.columns)})`, [
    index.table,
    index.name,
    ...index.columns,
  ])
}

async function dropIndexIfExists(db: QueryClientContract, index: RelationOrderIndex) {
  if (isSqlite(db)) {
    await db.rawQuery('DROP INDEX IF EXISTS ??', [index.name])
    return
  }
  if (!(await indexExists(db, index.table, index.name))) return
  await db.rawQuery('ALTER TABLE ?? DROP INDEX ??', [index.table, index.name])
}

async function indexExists(db: QueryClientContract, table: string, name: string) {
  const result = await db.rawQuery('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name])
  return rawRows(result).length > 0
}

function columnPlaceholders(columns: string[]) {
  return columns.map(() => '??').join(', ')
}

function rawRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows
    return Array.isArray(rows) ? rows : []
  }
  return []
}
