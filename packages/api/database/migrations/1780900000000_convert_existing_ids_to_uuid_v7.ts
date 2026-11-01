import { uuidV7 } from '#lib/uuid_v7'
import { BaseSchema } from '@adonisjs/lucid/schema'
import { isSqlite } from '#database/sql_dialect'
import type { QueryClientContract } from '@adonisjs/lucid/types/database'

type IndexDefinition = {
  columns: string[]
  name: string
  unique?: boolean
}

type ReferenceDefinition = {
  column: string
  constraint: string
  indexes?: IndexDefinition[]
  nullable?: boolean
  onDelete: 'CASCADE' | 'SET NULL'
  primary?: boolean
  table: string
  uuidColumn: string
}

type TargetDefinition = {
  column: string
  indexes?: IndexDefinition[]
  references: ReferenceDefinition[]
  table: string
  uuidColumn: string
}

type StoryRow = {
  id: string | number
  project_id: string | number
  story_number: number | null
}

const uuidV7Pattern =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
const uuidV7Regex = new RegExp(uuidV7Pattern)

const userIdReferences: ReferenceDefinition[] = [
  {
    column: 'tokenable_id',
    constraint: 'auth_access_tokens_tokenable_id_foreign',
    onDelete: 'CASCADE',
    table: 'auth_access_tokens',
    uuidColumn: 'uuid_tokenable_id',
  },
  {
    column: 'user_id',
    constraint: 'projects_user_id_foreign',
    indexes: [
      {
        columns: ['user_id', 'repository_fingerprint'],
        name: 'projects_user_id_repository_fingerprint_unique',
        unique: true,
      },
      { columns: ['user_id'], name: 'projects_user_id_index' },
    ],
    onDelete: 'CASCADE',
    table: 'projects',
    uuidColumn: 'uuid_user_id',
  },
  {
    column: 'user_id',
    constraint: 'provider_credentials_user_id_foreign',
    indexes: [
      {
        columns: ['user_id', 'provider_id', 'label'],
        name: 'provider_credentials_user_id_provider_id_label_unique',
        unique: true,
      },
      {
        columns: ['user_id', 'provider_id'],
        name: 'provider_credentials_user_id_provider_id_index',
      },
    ],
    onDelete: 'CASCADE',
    table: 'provider_credentials',
    uuidColumn: 'uuid_user_id',
  },
  {
    column: 'user_id',
    constraint: 'user_ai_preferences_user_id_foreign',
    onDelete: 'CASCADE',
    primary: true,
    table: 'user_ai_preferences',
    uuidColumn: 'uuid_user_id',
  },
]

const projectIdReferences: ReferenceDefinition[] = [
  {
    column: 'project_id',
    constraint: 'project_initializations_project_id_foreign',
    onDelete: 'CASCADE',
    primary: true,
    table: 'project_initializations',
    uuidColumn: 'uuid_project_id',
  },
  {
    column: 'project_id',
    constraint: 'project_code_practices_project_id_foreign',
    indexes: [
      {
        columns: ['project_id', 'practice'],
        name: 'project_code_practices_project_id_practice_unique',
        unique: true,
      },
      { columns: ['project_id'], name: 'project_code_practices_project_id_index' },
    ],
    onDelete: 'CASCADE',
    table: 'project_code_practices',
    uuidColumn: 'uuid_project_id',
  },
  {
    column: 'project_id',
    constraint: 'user_stories_project_id_foreign',
    indexes: [
      { columns: ['project_id', 'status'], name: 'user_stories_project_id_status_index' },
      { columns: ['project_id', 'created_at'], name: 'user_stories_project_id_created_at_index' },
      {
        columns: ['project_id', 'story_number'],
        name: 'user_stories_project_id_story_number_unique',
        unique: true,
      },
    ],
    onDelete: 'CASCADE',
    table: 'user_stories',
    uuidColumn: 'uuid_project_id',
  },
  {
    column: 'project_id',
    constraint: 'quick_chats_project_id_foreign',
    indexes: [
      { columns: ['project_id', 'updated_at'], name: 'quick_chats_project_id_updated_at_index' },
    ],
    onDelete: 'CASCADE',
    table: 'quick_chats',
    uuidColumn: 'uuid_project_id',
  },
]

const userStoryIdReferences: ReferenceDefinition[] = [
  {
    column: 'user_story_id',
    constraint: 'user_story_comments_user_story_id_foreign',
    indexes: [
      {
        columns: ['user_story_id', 'created_at'],
        name: 'user_story_comments_user_story_id_created_at_index',
      },
      {
        columns: ['user_story_id', 'created_at', 'id'],
        name: 'user_story_comments_user_story_id_created_at_id_index',
      },
    ],
    onDelete: 'CASCADE',
    table: 'user_story_comments',
    uuidColumn: 'uuid_user_story_id',
  },
  {
    column: 'user_story_id',
    constraint: 'user_story_agent_runs_user_story_id_foreign',
    indexes: [
      {
        columns: ['user_story_id', 'created_at'],
        name: 'user_story_agent_runs_user_story_id_created_at_index',
      },
      {
        columns: ['user_story_id', 'created_at', 'id'],
        name: 'user_story_agent_runs_user_story_id_created_at_id_index',
      },
    ],
    onDelete: 'CASCADE',
    table: 'user_story_agent_runs',
    uuidColumn: 'uuid_user_story_id',
  },
]

const userStoryCommentIdReferences: ReferenceDefinition[] = [
  {
    column: 'comment_id',
    constraint: 'user_story_agent_runs_comment_id_foreign',
    indexes: [{ columns: ['comment_id'], name: 'user_story_agent_runs_comment_id_index' }],
    nullable: true,
    onDelete: 'SET NULL',
    table: 'user_story_agent_runs',
    uuidColumn: 'uuid_comment_id',
  },
]

const quickChatIdReferences: ReferenceDefinition[] = [
  {
    column: 'quick_chat_id',
    constraint: 'quick_chat_messages_quick_chat_id_foreign',
    indexes: [
      {
        columns: ['quick_chat_id', 'created_at'],
        name: 'quick_chat_messages_quick_chat_id_created_at_index',
      },
      {
        columns: ['quick_chat_id', 'created_at', 'id'],
        name: 'quick_chat_messages_quick_chat_id_created_at_id_index',
      },
    ],
    onDelete: 'CASCADE',
    table: 'quick_chat_messages',
    uuidColumn: 'uuid_quick_chat_id',
  },
  {
    column: 'quick_chat_id',
    constraint: 'quick_chat_agent_runs_quick_chat_id_foreign',
    indexes: [
      {
        columns: ['quick_chat_id', 'created_at'],
        name: 'quick_chat_agent_runs_quick_chat_id_created_at_index',
      },
      {
        columns: ['quick_chat_id', 'created_at', 'id'],
        name: 'quick_chat_agent_runs_quick_chat_id_created_at_id_index',
      },
    ],
    onDelete: 'CASCADE',
    table: 'quick_chat_agent_runs',
    uuidColumn: 'uuid_quick_chat_id',
  },
]

const quickChatMessageIdReferences: ReferenceDefinition[] = [
  {
    column: 'message_id',
    constraint: 'quick_chat_agent_runs_message_id_foreign',
    indexes: [{ columns: ['message_id'], name: 'quick_chat_agent_runs_message_id_index' }],
    nullable: true,
    onDelete: 'SET NULL',
    table: 'quick_chat_agent_runs',
    uuidColumn: 'uuid_message_id',
  },
]

const targets: TargetDefinition[] = [
  { column: 'id', references: userIdReferences, table: 'users', uuidColumn: 'uuid_id' },
  { column: 'id', references: projectIdReferences, table: 'projects', uuidColumn: 'uuid_id' },
  {
    column: 'id',
    references: userStoryIdReferences,
    table: 'user_stories',
    uuidColumn: 'uuid_id',
  },
  {
    column: 'id',
    indexes: [
      {
        columns: ['user_story_id', 'created_at', 'id'],
        name: 'user_story_comments_user_story_id_created_at_id_index',
      },
    ],
    references: userStoryCommentIdReferences,
    table: 'user_story_comments',
    uuidColumn: 'uuid_id',
  },
  {
    column: 'id',
    references: quickChatIdReferences,
    table: 'quick_chats',
    uuidColumn: 'uuid_id',
  },
  {
    column: 'id',
    indexes: [
      {
        columns: ['quick_chat_id', 'created_at', 'id'],
        name: 'quick_chat_messages_quick_chat_id_created_at_id_index',
      },
    ],
    references: quickChatMessageIdReferences,
    table: 'quick_chat_messages',
    uuidColumn: 'uuid_id',
  },
  { column: 'id', references: [], table: 'auth_access_tokens', uuidColumn: 'uuid_id' },
  { column: 'id', references: [], table: 'provider_credentials', uuidColumn: 'uuid_id' },
  { column: 'id', references: [], table: 'project_code_practices', uuidColumn: 'uuid_id' },
  {
    column: 'id',
    indexes: [
      {
        columns: ['user_story_id', 'created_at', 'id'],
        name: 'user_story_agent_runs_user_story_id_created_at_id_index',
      },
    ],
    references: [],
    table: 'user_story_agent_runs',
    uuidColumn: 'uuid_id',
  },
  {
    column: 'id',
    indexes: [
      {
        columns: ['quick_chat_id', 'created_at', 'id'],
        name: 'quick_chat_agent_runs_quick_chat_id_created_at_id_index',
      },
    ],
    references: [],
    table: 'quick_chat_agent_runs',
    uuidColumn: 'uuid_id',
  },
]

export default class extends BaseSchema {
  static disableTransactions = true

  async up() {
    this.defer(async (db) => {
      // SQLite databases are created after the switch to UUIDs: nothing to convert.
      if (isSqlite(db)) return
      await db.rawQuery('SET FOREIGN_KEY_CHECKS=0')
      try {
        await convertIdTargets(db)
      } finally {
        await db.rawQuery('SET FOREIGN_KEY_CHECKS=1')
      }
    })
  }

  async down() {}
}

async function convertIdTargets(db: QueryClientContract) {
  for (const target of targets) {
    await convertIdTarget(db, target)
    if (target.table === 'projects') await ensureStoryNumbers(db)
  }
}

async function convertIdTarget(db: QueryClientContract, target: TargetDefinition) {
  if (!(await hasTable(db, target.table))) return
  const references = await existingReferences(db, target.references)
  const targetNeedsConversion = await columnNeedsConversion(db, target.table, target.column)
  const targetHasUuidColumn = await hasColumn(db, target.table, target.uuidColumn)
  const referencesNeedConversion = await referencesNeedUuidColumns(db, references)
  if (!targetNeedsConversion && !targetHasUuidColumn && !referencesNeedConversion) return
  await addTargetUuidColumn(db, target, targetNeedsConversion)
  await assignTargetUuidValues(db, target)
  await addReferenceUuidColumns(db, references, targetHasUuidColumn || targetNeedsConversion)
  await copyReferenceUuidValues(db, target, references)
  await dropForeignKeys(db, references)
  await dropReferenceIndexes(db, references)
  await dropIndexes(db, target.table, target.indexes ?? [])
  await replaceTargetColumn(db, target)
  await replaceReferenceColumns(db, references)
  await createIndexes(db, target.table, target.indexes ?? [])
  await createReferenceIndexes(db, references)
  await createForeignKeys(db, target, references)
}

async function ensureStoryNumbers(db: QueryClientContract) {
  if (!(await hasTable(db, 'user_stories'))) return
  if (!(await hasColumn(db, 'user_stories', 'story_number'))) {
    await db.rawQuery('ALTER TABLE ?? ADD COLUMN ?? INT UNSIGNED NULL', [
      'user_stories',
      'story_number',
    ])
  }
  if (!(await indexExists(db, 'user_stories', 'user_stories_project_id_story_number_unique'))) {
    await fillStoryNumbers(db)
  }
  await db.rawQuery('ALTER TABLE ?? MODIFY ?? INT UNSIGNED NOT NULL', [
    'user_stories',
    'story_number',
  ])
  await createIndex(db, 'user_stories', {
    columns: ['project_id', 'story_number'],
    name: 'user_stories_project_id_story_number_unique',
    unique: true,
  })
}

async function fillStoryNumbers(db: QueryClientContract) {
  const rows = (await db
    .from('user_stories')
    .select('id', 'project_id', 'story_number')
    .orderBy('project_id', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')) as StoryRow[]
  let projectId: string | number | undefined
  let storyNumber = 0
  for (const row of rows) {
    if (projectId !== row.project_id) {
      projectId = row.project_id
      storyNumber = 0
    }
    storyNumber += 1
    if (row.story_number === storyNumber) continue
    await db.from('user_stories').where('id', row.id).update({ story_number: storyNumber })
  }
}

async function existingReferences(db: QueryClientContract, references: ReferenceDefinition[]) {
  const existing: ReferenceDefinition[] = []
  for (const reference of references) {
    if (!(await referenceExists(db, reference))) continue
    existing.push(reference)
  }
  return existing
}

async function referenceExists(db: QueryClientContract, reference: ReferenceDefinition) {
  if (!(await hasTable(db, reference.table))) return false
  if (await hasColumn(db, reference.table, reference.column)) return true
  return hasColumn(db, reference.table, reference.uuidColumn)
}

async function referencesNeedUuidColumns(
  db: QueryClientContract,
  references: ReferenceDefinition[]
) {
  for (const reference of references) {
    if (await hasColumn(db, reference.table, reference.uuidColumn)) return true
    if (await columnNeedsConversion(db, reference.table, reference.column)) return true
  }
  return false
}

async function addTargetUuidColumn(
  db: QueryClientContract,
  target: TargetDefinition,
  needsConversion: boolean
) {
  if (!needsConversion) return
  if (await hasColumn(db, target.table, target.uuidColumn)) return
  await db.rawQuery('ALTER TABLE ?? ADD COLUMN ?? CHAR(36) NULL', [target.table, target.uuidColumn])
}

async function assignTargetUuidValues(db: QueryClientContract, target: TargetDefinition) {
  if (!(await hasColumn(db, target.table, target.uuidColumn))) return
  const rows = (await db
    .from(target.table)
    .select(target.column, target.uuidColumn)
    .whereNull(target.uuidColumn)) as Record<string, string | number | null>[]
  for (const row of rows) {
    const currentId = row[target.column]
    if (currentId === null || currentId === undefined) continue
    await db
      .from(target.table)
      .where(target.column, currentId)
      .update({ [target.uuidColumn]: uuidV7Value(currentId) })
  }
}

async function addReferenceUuidColumns(
  db: QueryClientContract,
  references: ReferenceDefinition[],
  targetConverts: boolean
) {
  for (const reference of references) {
    const referenceConverts = await columnNeedsConversion(db, reference.table, reference.column)
    if (!targetConverts && !referenceConverts) continue
    if (await hasColumn(db, reference.table, reference.uuidColumn)) continue
    await db.rawQuery(
      `ALTER TABLE ${q(reference.table)} ADD COLUMN ${q(reference.uuidColumn)} CHAR(36) NULL`
    )
  }
}

async function copyReferenceUuidValues(
  db: QueryClientContract,
  target: TargetDefinition,
  references: ReferenceDefinition[]
) {
  if (!(await hasColumn(db, target.table, target.uuidColumn))) return
  for (const reference of references) {
    if (!(await hasColumn(db, reference.table, reference.uuidColumn))) continue
    await db.rawQuery(
      `UPDATE ${q(reference.table)} JOIN ${q(target.table)} ON ${q(reference.table)}.${q(reference.column)} = ${q(target.table)}.${q(target.column)} SET ${q(reference.table)}.${q(reference.uuidColumn)} = ${q(target.table)}.${q(target.uuidColumn)} WHERE ${q(reference.table)}.${q(reference.uuidColumn)} IS NULL`
    )
  }
}

async function dropForeignKeys(db: QueryClientContract, references: ReferenceDefinition[]) {
  for (const reference of references) {
    const constraints = await foreignKeyNames(db, reference)
    for (const constraint of constraints) {
      await db.rawQuery('ALTER TABLE ?? DROP FOREIGN KEY ??', [reference.table, constraint])
    }
  }
}

async function dropReferenceIndexes(db: QueryClientContract, references: ReferenceDefinition[]) {
  for (const reference of references) {
    if (reference.primary) await dropPrimaryKey(db, reference.table, reference.column)
    await dropIndexes(db, reference.table, reference.indexes ?? [])
  }
}

async function dropIndexes(db: QueryClientContract, table: string, indexes: IndexDefinition[]) {
  for (const index of indexes) {
    if (!(await indexExists(db, table, index.name))) continue
    await db.rawQuery('ALTER TABLE ?? DROP INDEX ??', [table, index.name])
  }
}

async function replaceTargetColumn(db: QueryClientContract, target: TargetDefinition) {
  if (!(await hasColumn(db, target.table, target.uuidColumn))) return
  await removeAutoIncrement(db, target.table, target.column)
  await dropPrimaryKey(db, target.table, target.column)
  if (await hasColumn(db, target.table, target.column)) {
    await db.rawQuery(
      `ALTER TABLE ${q(target.table)} DROP COLUMN ${q(target.column)}, CHANGE ${q(target.uuidColumn)} ${q(target.column)} CHAR(36) NOT NULL`
    )
  } else {
    await db.rawQuery(
      `ALTER TABLE ${q(target.table)} CHANGE ${q(target.uuidColumn)} ${q(target.column)} CHAR(36) NOT NULL`
    )
  }
  await addPrimaryKey(db, target.table, target.column)
}

async function replaceReferenceColumns(db: QueryClientContract, references: ReferenceDefinition[]) {
  for (const reference of references) {
    await replaceReferenceColumn(db, reference)
  }
}

async function replaceReferenceColumn(db: QueryClientContract, reference: ReferenceDefinition) {
  if (!(await hasColumn(db, reference.table, reference.uuidColumn))) return
  const nullable = reference.nullable ? 'NULL' : 'NOT NULL'
  if (await hasColumn(db, reference.table, reference.column)) {
    await db.rawQuery(
      `ALTER TABLE ${q(reference.table)} DROP COLUMN ${q(reference.column)}, CHANGE ${q(reference.uuidColumn)} ${q(reference.column)} CHAR(36) ${nullable}`
    )
  } else {
    await db.rawQuery(
      `ALTER TABLE ${q(reference.table)} CHANGE ${q(reference.uuidColumn)} ${q(reference.column)} CHAR(36) ${nullable}`
    )
  }
}

async function createReferenceIndexes(db: QueryClientContract, references: ReferenceDefinition[]) {
  for (const reference of references) {
    if (reference.primary) await addPrimaryKey(db, reference.table, reference.column)
    await createIndexes(db, reference.table, reference.indexes ?? [])
  }
}

async function createIndexes(db: QueryClientContract, table: string, indexes: IndexDefinition[]) {
  for (const index of indexes) {
    await createIndex(db, table, index)
  }
}

async function createIndex(db: QueryClientContract, table: string, index: IndexDefinition) {
  if (await indexExists(db, table, index.name)) return
  if (!(await columnsExist(db, table, index.columns))) return
  const kind = index.unique ? 'UNIQUE' : 'INDEX'
  await db.rawQuery(
    `ALTER TABLE ${q(table)} ADD ${kind} ${q(index.name)} (${index.columns.map(q).join(', ')})`
  )
}

async function createForeignKeys(
  db: QueryClientContract,
  target: TargetDefinition,
  references: ReferenceDefinition[]
) {
  for (const reference of references) {
    if (await foreignKeyExists(db, reference)) continue
    if (!(await hasColumn(db, reference.table, reference.column))) continue
    await db.rawQuery(
      `ALTER TABLE ${q(reference.table)} ADD CONSTRAINT ${q(reference.constraint)} FOREIGN KEY (${q(reference.column)}) REFERENCES ${q(target.table)}(${q(target.column)}) ON DELETE ${reference.onDelete}`
    )
  }
}

async function columnNeedsConversion(db: QueryClientContract, table: string, column: string) {
  if (!(await hasColumn(db, table, column))) return false
  if (await isNumericColumn(db, table, column)) return true
  const rows = await db.rawQuery(
    `SELECT 1 FROM ${q(table)} WHERE ${q(column)} IS NOT NULL AND ${q(column)} NOT REGEXP ? LIMIT 1`,
    [uuidV7Pattern]
  )
  return rawRows(rows).length > 0
}

async function removeAutoIncrement(db: QueryClientContract, table: string, column: string) {
  if (!(await isNumericColumn(db, table, column))) return
  await db.rawQuery(`ALTER TABLE ${q(table)} MODIFY ${q(column)} INT UNSIGNED NOT NULL`)
}

async function dropPrimaryKey(db: QueryClientContract, table: string, column: string) {
  if (!(await primaryKeyMatches(db, table, column))) return
  await db.rawQuery('ALTER TABLE ?? DROP PRIMARY KEY', [table])
}

async function addPrimaryKey(db: QueryClientContract, table: string, column: string) {
  if (await primaryKeyMatches(db, table, column)) return
  await db.rawQuery(`ALTER TABLE ${q(table)} ADD PRIMARY KEY (${q(column)})`)
}

async function primaryKeyMatches(db: QueryClientContract, table: string, column: string) {
  const primaryKeys = await db.getPrimaryKeys(table)
  return primaryKeys.length === 1 && primaryKeys[0] === column
}

async function columnsExist(db: QueryClientContract, table: string, columns: string[]) {
  for (const column of columns) {
    if (!(await hasColumn(db, table, column))) return false
  }
  return true
}

async function hasColumn(db: QueryClientContract, table: string, column: string) {
  if (!(await hasTable(db, table))) return false
  const columns = await db.columnsInfo(table)
  return Boolean(columns[column])
}

async function hasTable(db: QueryClientContract, table: string) {
  const tables = await db.getAllTables()
  return tables.includes(table)
}

async function isNumericColumn(db: QueryClientContract, table: string, column: string) {
  const columns = await db.columnsInfo(table)
  return columns[column]?.type.toLowerCase().includes('int') ?? false
}

async function indexExists(db: QueryClientContract, table: string, name: string) {
  const rows = await db.rawQuery('SHOW INDEX FROM ?? WHERE Key_name = ?', [table, name])
  return rawRows(rows).length > 0
}

async function foreignKeyExists(db: QueryClientContract, reference: ReferenceDefinition) {
  const row = await db
    .knexQuery()
    .from('information_schema.key_column_usage')
    .whereRaw('constraint_schema = database()')
    .where('table_name', reference.table)
    .where('constraint_name', reference.constraint)
    .whereNotNull('referenced_table_name')
    .first()
  return Boolean(row)
}

async function foreignKeyNames(db: QueryClientContract, reference: ReferenceDefinition) {
  const result = await db.rawQuery(
    `SELECT constraint_name AS constraintName
     FROM information_schema.key_column_usage
     WHERE constraint_schema = database()
       AND table_name = ?
       AND column_name IN (?, ?)
       AND referenced_table_name IS NOT NULL
       AND constraint_name <> 'PRIMARY'`,
    [reference.table, reference.column, reference.uuidColumn]
  )
  return uniqueStrings(rawRows(result).map(foreignKeyName))
}

function uuidV7Value(value: string | number) {
  if (typeof value === 'string' && uuidV7Regex.test(value)) return value
  return uuidV7()
}

function q(value: string) {
  return `\`${value.replaceAll('`', '``')}\``
}

function rawRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return Array.isArray(result[0]) ? result[0] : result
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows
    return Array.isArray(rows) ? rows : []
  }
  return []
}

function foreignKeyName(row: unknown) {
  if (!row || typeof row !== 'object') return undefined
  const record = row as Record<string, unknown>
  const value = record.constraintName ?? record.constraint_name ?? record.CONSTRAINT_NAME
  return typeof value === 'string' && value.trim() ? value : undefined
}

function uniqueStrings(values: (string | undefined)[]) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}
