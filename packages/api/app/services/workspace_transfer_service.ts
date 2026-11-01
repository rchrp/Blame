import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

export type WorkspaceRow = Record<string, unknown>

/**
 * A workspace as rows, keyed by table. Rows keep their ids, so importing the
 * same workspace twice inserts nothing the second time.
 */
export type WorkspaceBundle = {
  format: 'blame-workspace'
  version: 1
  tables: Partial<Record<WorkspaceTable, WorkspaceRow[]>>
}

type TableSpec = {
  /** Column holding the owner: the user, or a row of an earlier table. */
  owner: string
  parent: WorkspaceTable | 'users'
  /** Columns that identify a row, when it is not `id`. */
  key?: string[]
}

/**
 * Tables in dependency order. File attachments, screenshots, previews and
 * deployments are hosted services: the local API never stores them.
 */
export const workspaceTables = [
  'projects',
  'provider_credentials',
  'user_ai_preferences',
  'user_mcp_configurations',
  'project_initializations',
  'project_code_practices',
  'project_code_practice_analyses',
  'project_agent_memories',
  'security_audits',
  'user_stories',
  'user_story_comments',
  'user_story_agent_runs',
  'user_story_agent_run_activities',
  'quick_chats',
  'quick_chat_messages',
  'quick_chat_agent_runs',
  'quick_chat_agent_run_activities',
] as const

export type WorkspaceTable = (typeof workspaceTables)[number]

const tables: Record<WorkspaceTable, TableSpec> = {
  projects: { owner: 'user_id', parent: 'users' },
  provider_credentials: { owner: 'user_id', parent: 'users', key: ['provider_id', 'label'] },
  user_ai_preferences: { owner: 'user_id', parent: 'users', key: ['user_id'] },
  user_mcp_configurations: { owner: 'user_id', parent: 'users', key: ['user_id'] },
  project_initializations: { owner: 'project_id', parent: 'projects', key: ['project_id'] },
  project_code_practices: {
    owner: 'project_id',
    parent: 'projects',
    key: ['project_id', 'practice'],
  },
  project_code_practice_analyses: {
    owner: 'project_id',
    parent: 'projects',
    key: ['project_id'],
  },
  project_agent_memories: {
    owner: 'project_id',
    parent: 'projects',
    key: ['project_id', 'fingerprint'],
  },
  security_audits: { owner: 'project_id', parent: 'projects' },
  user_stories: { owner: 'project_id', parent: 'projects' },
  user_story_comments: { owner: 'user_story_id', parent: 'user_stories' },
  user_story_agent_runs: { owner: 'user_story_id', parent: 'user_stories' },
  user_story_agent_run_activities: { owner: 'run_id', parent: 'user_story_agent_runs' },
  quick_chats: { owner: 'project_id', parent: 'projects' },
  quick_chat_messages: { owner: 'quick_chat_id', parent: 'quick_chats' },
  quick_chat_agent_runs: { owner: 'quick_chat_id', parent: 'quick_chats' },
  quick_chat_agent_run_activities: { owner: 'run_id', parent: 'quick_chat_agent_runs' },
}

export type WorkspaceImportResult = Partial<Record<WorkspaceTable, number>>

export default class WorkspaceTransferService {
  /** Every row the user owns, with provider secrets decrypted for re-encryption. */
  async export(userId: string): Promise<WorkspaceBundle> {
    const owned: Partial<Record<WorkspaceTable | 'users', string[]>> = { users: [userId] }
    const bundle: WorkspaceBundle = { format: 'blame-workspace', version: 1, tables: {} }
    for (const table of workspaceTables) {
      const spec = tables[table]
      const owners = owned[spec.parent] ?? []
      const rows = owners.length
        ? await db
            .from(table)
            .whereIn(spec.owner, owners)
            .orderBy(spec.key?.[0] ?? 'id')
        : []
      owned[table] = rows.map((row) => String(row.id))
      bundle.tables[table] = table === 'provider_credentials' ? await revealSecrets(rows) : rows
    }
    return bundle
  }

  /**
   * Adds the rows that the user does not have yet. A project already known by
   * its repository fingerprint absorbs the imported one, and stories that
   * would reuse a taken number get the project's next numbers. Settings the
   * user already has win over imported ones.
   */
  async import(userId: string, bundle: WorkspaceBundle): Promise<WorkspaceImportResult> {
    return db.transaction(async (transaction) => {
      const importer = new WorkspaceImporter(transaction, userId)
      await importer.mapProjects(bundle.tables.projects ?? [])
      const result: WorkspaceImportResult = {}
      for (const table of workspaceTables) {
        const rows = bundle.tables[table]
        if (rows?.length) result[table] = await importer.insert(table, rows)
      }
      await importer.finish()
      return result
    })
  }

  /** Empties the local workspace once an account holds a copy of it. */
  async clear(userId: string) {
    await db.transaction(async (transaction) => {
      for (const table of ['projects', 'provider_credentials'] as const) {
        await transaction.from(table).where('user_id', userId).delete()
      }
      await transaction.from('user_ai_preferences').where('user_id', userId).delete()
      await transaction.from('user_mcp_configurations').where('user_id', userId).delete()
    })
  }
}

class WorkspaceImporter {
  /** Imported project id → project id on this API. */
  private projects = new Map<string, string>()
  private present = new Map<WorkspaceTable, Set<string>>()
  private columns = new Map<WorkspaceTable, Set<string>>()
  private activeRuns: { storyId: string; runId: unknown }[] = []

  constructor(
    private transaction: TransactionClientContract,
    private userId: string
  ) {}

  async mapProjects(rows: WorkspaceRow[]) {
    for (const row of rows) {
      const id = String(row.id)
      const existing = await this.transaction
        .from('projects')
        .where('user_id', this.userId)
        .where((query) => {
          query.where('id', id)
          if (row.repository_fingerprint) {
            query.orWhere('repository_fingerprint', String(row.repository_fingerprint))
          }
        })
        .first()
      this.projects.set(id, existing ? String(existing.id) : id)
    }
  }

  async insert(table: WorkspaceTable, rows: WorkspaceRow[]) {
    const spec: TableSpec = tables[table]
    const columns = await this.tableColumns(table)
    let inserted = 0
    for (const source of rows) {
      const row = await this.prepare(table, spec, source, columns)
      if (!row || (await this.exists(table, spec, row))) continue
      await this.transaction.table(table).insert(row)
      this.known(table).add(String(row.id))
      inserted++
    }
    return inserted
  }

  /** Points stories at their active runs and moves each project counter past its stories. */
  async finish() {
    for (const { storyId, runId } of this.activeRuns) {
      await this.transaction
        .from('user_stories')
        .where('id', storyId)
        .update({ active_agent_run_id: runId })
    }
    for (const projectId of new Set(this.projects.values())) {
      const highest = await this.transaction
        .from('user_stories')
        .where('project_id', projectId)
        .max('story_number as number')
        .first()
      await this.transaction
        .from('projects')
        .where('id', projectId)
        .where('last_story_number', '<', Number(highest?.number ?? 0))
        .update({ last_story_number: Number(highest?.number ?? 0) })
    }
  }

  private async prepare(
    table: WorkspaceTable,
    spec: TableSpec,
    source: WorkspaceRow,
    columns: Set<string>
  ) {
    const row = pick(table === 'provider_credentials' ? await sealSecrets(source) : source, columns)
    if (spec.parent === 'users') row[spec.owner] = this.userId
    else if (spec.parent === 'projects') {
      const projectId = this.projects.get(String(row[spec.owner]))
      if (!projectId) return undefined
      row[spec.owner] = projectId
    } else if (!(await this.owns(spec.parent, String(row[spec.owner])))) return undefined
    if (table === 'projects') {
      if (this.projects.get(String(row.id)) !== row.id) return undefined
      row.last_story_number = 0
    }
    if (table === 'user_stories') await this.prepareStory(row)
    return row
  }

  private async prepareStory(row: WorkspaceRow) {
    if (row.active_agent_run_id) {
      this.activeRuns.push({ storyId: String(row.id), runId: row.active_agent_run_id })
      row.active_agent_run_id = null
    }
    const taken = await this.transaction
      .from('user_stories')
      .where('project_id', String(row.project_id))
      .where('story_number', Number(row.story_number))
      .whereNot('id', String(row.id))
      .first()
    if (!taken) return
    const highest = await this.transaction
      .from('user_stories')
      .where('project_id', String(row.project_id))
      .max('story_number as number')
      .first()
    row.story_number = Number(highest?.number ?? 0) + 1
  }

  private async exists(table: WorkspaceTable, spec: TableSpec, row: WorkspaceRow) {
    const query = this.transaction.from(table)
    if (spec.parent === 'users') query.where(spec.owner, this.userId)
    if (spec.key) for (const column of spec.key) query.where(column, row[column] as string)
    else query.where('id', String(row.id))
    return Boolean(await query.first())
  }

  /** Whether a parent row belongs to this user, either imported now or already here. */
  private async owns(table: WorkspaceTable, id: string): Promise<boolean> {
    const known = this.known(table)
    if (known.has(id)) return true
    const spec: TableSpec = tables[table]
    const row = await this.transaction.from(table).where('id', id).first()
    if (!row) return false
    const owner = String(row[spec.owner])
    const owned =
      spec.parent === 'users'
        ? owner === this.userId
        : spec.parent === 'projects'
          ? [...this.projects.values()].includes(owner) || (await this.ownsProject(owner))
          : await this.owns(spec.parent, owner)
    if (owned) known.add(id)
    return owned
  }

  private known(table: WorkspaceTable) {
    const rows = this.present.get(table) ?? new Set<string>()
    this.present.set(table, rows)
    return rows
  }

  private async ownsProject(id: string) {
    const project = await this.transaction
      .from('projects')
      .where('id', id)
      .where('user_id', this.userId)
      .first()
    return Boolean(project)
  }

  /** Columns of this API's schema: an older or newer client may send others. */
  private async tableColumns(table: WorkspaceTable) {
    const cached = this.columns.get(table)
    if (cached) return cached
    // Lucid's transaction columnsInfo() selects no table: ask knex directly.
    const info = await this.transaction.knexQuery().table(table).columnInfo()
    const columns = new Set(Object.keys(info))
    this.columns.set(table, columns)
    return columns
  }
}

function pick(row: WorkspaceRow, columns: Set<string>) {
  return Object.fromEntries(Object.entries(row).filter(([column]) => columns.has(column)))
}

/** Secrets are encrypted with each API's own key, so they travel decrypted. */
async function revealSecrets(rows: WorkspaceRow[]) {
  return Promise.all(
    rows.map(async ({ encrypted_api_key: apiKey, encrypted_oauth_credentials: oauth, ...row }) => ({
      ...row,
      api_key: (await encryption.decrypt(String(apiKey))) ?? '',
      oauth_credentials: oauth ? await encryption.decrypt(String(oauth)) : null,
    }))
  )
}

async function sealSecrets({ api_key: apiKey, oauth_credentials: oauth, ...row }: WorkspaceRow) {
  return {
    ...row,
    encrypted_api_key: await encryption.encrypt(String(apiKey ?? '')),
    encrypted_oauth_credentials: oauth ? await encryption.encrypt(oauth) : null,
  }
}
