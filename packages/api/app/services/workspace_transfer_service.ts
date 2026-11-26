import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { createHash } from 'node:crypto'

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
  /** Column holding the owner: the user, or one of the user's projects. */
  owner: 'user_id' | 'project_id'
  /**
   * Columns that make an imported row the same as one the account has. A
   * table without them is matched by id.
   */
  key?: string[]
  /** The table's primary key is its key: rows have no id of their own. */
  keyed?: true
  /** Columns naming rows of another table, one id or a JSON list of ids. */
  references?: Record<string, WorkspaceTable>
  /** Columns unique across all users: cleared when another row holds the value. */
  exclusive?: string[]
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
  'epics',
  'user_stories',
  'quick_chats',
] as const

export type WorkspaceTable = (typeof workspaceTables)[number]

const tables: Record<WorkspaceTable, TableSpec> = {
  projects: { owner: 'user_id' },
  provider_credentials: { owner: 'user_id', key: ['provider_id', 'label'] },
  user_ai_preferences: { owner: 'user_id', key: [], keyed: true },
  user_mcp_configurations: { owner: 'user_id', key: [], keyed: true },
  project_initializations: { owner: 'project_id', key: [], keyed: true },
  project_code_practices: { owner: 'project_id', key: ['practice'] },
  project_code_practice_analyses: { owner: 'project_id', key: [], keyed: true },
  project_agent_memories: {
    owner: 'project_id',
    key: ['fingerprint'],
    references: { story_id: 'user_stories' },
  },
  security_audits: { owner: 'project_id' },
  epics: { owner: 'project_id', exclusive: ['engine_session_id'] },
  user_stories: {
    owner: 'project_id',
    references: { epic_id: 'epics', starts_after: 'user_stories' },
    exclusive: ['engine_session_id'],
  },
  quick_chats: { owner: 'project_id' },
}

export type WorkspaceImportResult = Partial<Record<WorkspaceTable, number>>

export default class WorkspaceTransferService {
  /** Every row the user owns, with secrets decrypted for re-encryption. */
  async export(userId: string): Promise<WorkspaceBundle> {
    const owned: Record<'users' | 'projects', string[]> = { users: [userId], projects: [] }
    const bundle: WorkspaceBundle = { format: 'blame-workspace', version: 1, tables: {} }
    for (const table of workspaceTables) {
      const spec = tables[table]
      const owners = spec.owner === 'user_id' ? owned.users : owned.projects
      const rows = owners.length
        ? await db
            .from(table)
            .whereIn(spec.owner, owners)
            .orderBy(spec.keyed ? spec.owner : 'id')
        : []
      if (table === 'projects') owned.projects = rows.map((row) => String(row.id))
      bundle.tables[table] = await revealSecrets(table, rows)
    }
    return bundle
  }

  /**
   * Merges a workspace into the user's account. A row the account already
   * has, by id or by what identifies it, stays as the account has it; every
   * other row is added. A project already known by its repository absorbs the
   * imported one, stories that would reuse a taken number get the project's
   * next numbers, and MCP servers the account lacks join its list.
   *
   * An id another user already holds (the same workspace moved into a second
   * account) is replaced by one derived from the user and the original id, so
   * every part of a workspace sent in several requests, or sent again, lands
   * on the same rows.
   */
  async import(userId: string, bundle: WorkspaceBundle): Promise<WorkspaceImportResult> {
    return db.transaction(async (transaction) => {
      const importer = new WorkspaceImporter(transaction, userId)
      const result: WorkspaceImportResult = {}
      for (const table of workspaceTables) {
        const rows = bundle.tables[table]
        if (rows?.length) result[table] = await importer.import(table, rows)
      }
      await importer.finish()
      return result
    })
  }
}

/** Where an imported row lives in the account, and whether it is there yet. */
type Target = { id: string; exists: boolean }

class WorkspaceImporter {
  /** Imported id → its row in the account, by table. */
  private targets = new Map<WorkspaceTable, Map<string, Target>>()
  /** Projects the account already had for the same repository, by id. */
  private absorbed = new Set<string>()
  private columns = new Map<WorkspaceTable, Map<string, string>>()

  constructor(
    private transaction: TransactionClientContract,
    private userId: string
  ) {}

  /** Adds the rows of one table that the account lacks; answers how many. */
  async import(table: WorkspaceTable, sources: WorkspaceRow[]) {
    const spec = tables[table]
    const columns = await this.tableColumns(table)
    const rows: { row: WorkspaceRow; target?: Target }[] = []
    // Every row is placed before any is written: a row may name a later one.
    for (const source of sources) {
      const row = await this.prepare(table, spec, source, columns)
      if (row) rows.push({ row, target: await this.place(table, spec, row) })
    }
    let added = 0
    for (const { row, target } of rows) {
      if (table === 'user_mcp_configurations') {
        if (await this.mergeMcpServers(row)) added++
        continue
      }
      if (target?.exists || (spec.keyed && (await this.matching(table, spec, row)))) continue
      if (target) row.id = target.id
      await this.rewriteReferences(spec, row)
      await this.releaseExclusive(table, spec, row)
      if (table === 'user_stories') await this.numberStory(row)
      await this.transaction.table(table).insert(row)
      if (target) target.exists = true
      added++
    }
    return added
  }

  /** Moves each project counter past its stories. */
  async finish() {
    for (const project of this.targetsOf('projects').values()) {
      const highest = Number(await this.highestStoryNumber(project.id))
      await this.transaction
        .from('projects')
        .where('id', project.id)
        .where('last_story_number', '<', highest)
        .update({ last_story_number: highest })
    }
  }

  /** The row as this API stores it, owned by the user; none if it has no place here. */
  private async prepare(
    table: WorkspaceTable,
    spec: TableSpec,
    source: WorkspaceRow,
    columns: ReadonlyMap<string, string>
  ) {
    const row = pick(await sealSecrets(table, source), columns)
    readDates(row, columns)
    writeJson(row)
    if (spec.owner === 'user_id') {
      row.user_id = this.userId
      return row
    }
    // Only a project of this workspace can own a row: never one of another user.
    const project = this.targetsOf('projects').get(String(row.project_id))
    if (!project?.exists) return undefined
    row.project_id = project.id
    return row
  }

  /** Where a row with an id goes: the account's own copy of it, or a free id. */
  private async place(table: WorkspaceTable, spec: TableSpec, row: WorkspaceRow) {
    if (spec.keyed) return undefined
    const sourceId = String(row.id)
    const cached = this.targetsOf(table).get(sourceId)
    if (cached) return cached
    let target = await this.resolve(table, sourceId)
    if (!target.exists && (spec.key || table === 'projects')) {
      const same = await this.matching(table, spec, row)
      if (same) target = { id: String(same.id), exists: true }
      if (same && table === 'projects') this.absorbed.add(target.id)
    }
    this.targetsOf(table).set(sourceId, target)
    return target
  }

  /**
   * The id an imported row has in this account: its own when the row is the
   * user's or the id is free, else one derived from it. Never another user's
   * row.
   */
  private async resolve(table: WorkspaceTable, sourceId: string): Promise<Target> {
    const cached = this.targetsOf(table).get(sourceId)
    if (cached) return cached
    const derived = derivedId(this.userId, table, sourceId)
    const owners = await this.owners(table, [sourceId, derived])
    for (const id of [sourceId, derived]) {
      if (owners.get(id) === this.userId) return { id, exists: true }
    }
    for (const id of [sourceId, derived]) {
      if (!owners.has(id)) return { id, exists: false }
    }
    throw new Error(`No free id for an imported row of ${table}`)
  }

  /** The row of the account that an imported one stands for, by repository or key. */
  private async matching(table: WorkspaceTable, spec: TableSpec, row: WorkspaceRow) {
    const query = this.transaction.from(table).where(spec.owner, String(row[spec.owner]))
    if (table === 'projects') {
      if (!row.repository_fingerprint) return undefined
      query.where('repository_fingerprint', String(row.repository_fingerprint))
    } else if (spec.key) {
      for (const column of spec.key) query.where(column, row[column] as string)
    } else return undefined
    return (await query.first()) as WorkspaceRow | null
  }

  /** The owning user of each id that exists in the table. */
  private async owners(table: WorkspaceTable, ids: string[]) {
    const query = this.transaction.from(`${table} as candidate`).whereIn('candidate.id', ids)
    if (tables[table].owner === 'user_id') {
      query.select('candidate.id', 'candidate.user_id as owner')
    } else {
      query
        .leftJoin('projects', 'projects.id', 'candidate.project_id')
        .select('candidate.id', 'projects.user_id as owner')
    }
    const rows = (await query) as { id: string; owner: string | null }[]
    return new Map(rows.map((row) => [String(row.id), String(row.owner)]))
  }

  /** Points references at the account's copies of the rows they name. */
  private async rewriteReferences(spec: TableSpec, row: WorkspaceRow) {
    for (const [column, table] of Object.entries(spec.references ?? {})) {
      const value = row[column]
      if (typeof value !== 'string' || !value) continue
      const list = parseList(value)
      if (list) {
        const ids = await Promise.all(list.map((id) => this.resolvedId(table, id)))
        row[column] = JSON.stringify(ids)
      } else row[column] = await this.resolvedId(table, value)
    }
  }

  private async resolvedId(table: WorkspaceTable, sourceId: string) {
    const target = await this.resolve(table, sourceId)
    return target.id
  }

  /**
   * Engine session ids are unique across users: when another account holds
   * the session (the workspace moved there first), this copy has none.
   */
  private async releaseExclusive(table: WorkspaceTable, spec: TableSpec, row: WorkspaceRow) {
    for (const column of spec.exclusive ?? []) {
      if (row[column] === null || row[column] === undefined) continue
      const holder = await this.transaction
        .from(table)
        .where(column, row[column] as string)
        .first()
      if (holder) row[column] = null
    }
  }

  /**
   * A story keeps its number in a project the workspace brought. In one the
   * account already had, it comes after every number the project gave, even
   * to stories since deleted.
   */
  private async numberStory(row: WorkspaceRow) {
    const projectId = String(row.project_id)
    const taken = await this.transaction
      .from('user_stories')
      .where('project_id', projectId)
      .where('story_number', Number(row.story_number))
      .first()
    if (!taken && !this.absorbed.has(projectId)) return
    const project = await this.transaction.from('projects').where('id', projectId).first()
    const highest = Number(await this.highestStoryNumber(projectId))
    row.story_number = Math.max(highest, Number(project?.last_story_number ?? 0)) + 1
  }

  private async highestStoryNumber(projectId: string) {
    const row = await this.transaction
      .from('user_stories')
      .where('project_id', projectId)
      .max('story_number as number')
      .first()
    return Number(row?.number ?? 0)
  }

  /**
   * Adds the imported MCP servers the account does not have by name, with
   * their synced secrets. Servers the account has stay as they are.
   */
  private async mergeMcpServers(row: WorkspaceRow) {
    const existing = await this.transaction
      .from('user_mcp_configurations')
      .where('user_id', this.userId)
      .first()
    if (!existing) {
      await this.transaction.table('user_mcp_configurations').insert(row)
      return true
    }
    const servers = parseServers(existing.servers)
    // Names are unique whatever their case, as when the account saves them.
    const names = new Set(servers.map((server) => server.name.toLocaleLowerCase()))
    const added = parseServers(row.servers).filter(
      (server) => !names.has(server.name.toLocaleLowerCase())
    )
    if (!added.length) return false
    const secrets = await readMcpSecrets(existing.encrypted_secrets)
    // Secrets the account cannot read would be lost on rewrite: keep its list.
    if (!secrets) return false
    const imported = (await readMcpSecrets(row.encrypted_secrets)) ?? {}
    for (const server of added) {
      if (imported[server.name]) secrets[server.name] = imported[server.name]
    }
    await this.transaction
      .from('user_mcp_configurations')
      .where('user_id', this.userId)
      .update({
        servers: JSON.stringify([...servers, ...added]),
        encrypted_secrets: Object.keys(secrets).length
          ? await encryption.encrypt(JSON.stringify(secrets))
          : null,
        updated_at: new Date(),
      })
    return true
  }

  private targetsOf(table: WorkspaceTable) {
    const targets = this.targets.get(table) ?? new Map<string, Target>()
    this.targets.set(table, targets)
    return targets
  }

  /**
   * Columns of this API's schema and their types: an older or newer client
   * may send others.
   */
  private async tableColumns(table: WorkspaceTable) {
    const cached = this.columns.get(table)
    if (cached) return cached
    // Lucid's transaction columnsInfo() selects no table: ask knex directly.
    const info = await this.transaction.knexQuery().table(table).columnInfo()
    const columns = new Map(Object.entries(info).map(([name, column]) => [name, column.type]))
    this.columns.set(table, columns)
    return columns
  }
}

/**
 * A stable stand-in for an id another user holds: the same user and id give
 * the same one. It keeps the time prefix of a UUIDv7, so rows still sort by
 * creation.
 */
export function derivedId(userId: string, table: string, id: string) {
  const hash = createHash('sha256').update(`${userId}\0${table}\0${id}`).digest('hex')
  const time = /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(id)
    ? `${id.slice(0, 8)}${id.slice(9, 13)}`.toLowerCase()
    : hash.slice(0, 12)
  const variant = ((Number.parseInt(hash[16], 16) & 0x3) | 0x8).toString(16)
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

function parseList(value: string) {
  if (!value.startsWith('[')) return undefined
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : undefined
  } catch {
    return undefined
  }
}

function parseServers(value: unknown): { name: string }[] {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
  return Array.isArray(parsed) ? (parsed as { name: string }[]) : []
}

function pick(row: WorkspaceRow, columns: ReadonlyMap<string, string>) {
  return Object.fromEntries(Object.entries(row).filter(([column]) => columns.has(column)))
}

const isoDateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/

/**
 * The bundle carries dates as JSON ISO strings, which MySQL refuses in a
 * DATETIME or TIMESTAMP column. As dates, each driver writes them the way
 * Lucid does.
 */
function readDates(row: WorkspaceRow, columns: ReadonlyMap<string, string>) {
  for (const [column, value] of Object.entries(row)) {
    const type = columns.get(column)?.toLowerCase() ?? ''
    if (typeof value !== 'string' || !/datetime|timestamp/.test(type)) continue
    if (isoDateTime.test(value)) row[column] = new Date(value)
  }
}

/**
 * MySQL hands a JSON column back as an object, and neither driver takes an
 * object for a column: the bundle's JSON values go in as text.
 */
function writeJson(row: WorkspaceRow) {
  for (const [column, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
      row[column] = JSON.stringify(value)
    }
  }
}

/** Secrets are encrypted with each API's own key, so they travel decrypted. */
async function revealSecrets(table: WorkspaceTable, rows: WorkspaceRow[]) {
  if (table === 'provider_credentials') {
    return Promise.all(
      rows.map(
        async ({ encrypted_api_key: apiKey, encrypted_oauth_credentials: oauth, ...row }) => ({
          ...row,
          api_key: (await encryption.decrypt(String(apiKey))) ?? '',
          oauth_credentials: oauth ? await encryption.decrypt(String(oauth)) : null,
        })
      )
    )
  }
  if (table === 'user_mcp_configurations') {
    return Promise.all(
      rows.map(async ({ encrypted_secrets: secrets, ...row }) => ({
        ...row,
        secrets: (await readMcpSecrets(secrets)) ?? null,
      }))
    )
  }
  return rows
}

async function sealSecrets(table: WorkspaceTable, row: WorkspaceRow): Promise<WorkspaceRow> {
  if (table === 'provider_credentials') {
    const { api_key: apiKey, oauth_credentials: oauth, ...rest } = row
    return {
      ...rest,
      encrypted_api_key: await encryption.encrypt(String(apiKey ?? '')),
      encrypted_oauth_credentials: oauth ? await encryption.encrypt(oauth) : null,
    }
  }
  if (table === 'user_mcp_configurations') {
    // An older app sends secrets sealed with its own key, which no one here
    // can open: the servers come without them.
    const { secrets, ...rest } = row
    delete rest.encrypted_secrets
    const plain = typeof secrets === 'string' ? JSON.parse(secrets) : secrets
    return {
      ...rest,
      encrypted_secrets:
        plain && typeof plain === 'object' && Object.keys(plain).length
          ? await encryption.encrypt(JSON.stringify(plain))
          : null,
    }
  }
  return row
}

/** MCP secrets by server name; undefined when they cannot be read here. */
async function readMcpSecrets(sealed: unknown): Promise<Record<string, unknown> | undefined> {
  if (sealed === null || sealed === undefined || sealed === '') return {}
  const decrypted = await encryption.decrypt(String(sealed))
  if (typeof decrypted !== 'string') return undefined
  const parsed: unknown = JSON.parse(decrypted)
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined
}
