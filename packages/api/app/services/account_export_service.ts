import AccountExportQueries from '#services/account_export_queries'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import FileAttachmentsService from '#services/file_attachments_service'

const authenticationFieldExclusions = [
  'Account password hashes',
  'Bearer and access-token values or hashes stored in authentication fields',
  'API keys and encrypted API-key ciphertext stored in provider credential fields',
  'OAuth access and refresh tokens or encrypted OAuth ciphertext stored in provider credential fields',
]

export default class AccountExportService {
  export(userId: string) {
    return db.transaction(async (transaction) => {
      const queries = new AccountExportQueries(transaction)
      const account = await queries.account(userId)
      const workspace = await this.workspace(queries, userId)
      return this.payload(queries, userId, account, workspace)
    })
  }

  private async payload(
    queries: AccountExportQueries,
    userId: string,
    account: ExportRow,
    workspace: ExportRow
  ) {
    return {
      format: 'blame-account-export',
      version: 4,
      generatedAt: DateTime.utc().toISO(),
      account,
      security: await securityExport(queries, userId),
      billing: await queries.subscription(userId),
      settings: await this.settings(queries, userId),
      integrations: await integrationExport(queries, userId),
      workspace,
      additionalRecords,
    }
  }

  private async settings(queries: AccountExportQueries, userId: string) {
    const aiPreferences = await queries.aiPreferences(userId)
    const mcpConfiguration = await queries.mcpConfiguration(userId)
    return {
      aiPreferences,
      mcpConfiguration: normalizeRow(mcpConfiguration, ['servers']),
    }
  }

  private async workspace(queries: AccountExportQueries, userId: string) {
    const projects = await queries.projects(userId)
    const projectIds = identifiers(projects)
    const userStories = await queries.userStories(projectIds)
    return {
      projects,
      ...(await projectExport(queries, projectIds)),
      // The conversations of stories and quick chats are their engine
      // sessions; the rows only name them.
      userStories: normalizeRows(userStories, storyJsonColumns),
      quickChats: await queries.quickChats(projectIds),
      fileAttachments: await fileAttachmentExport(queries, userId),
      fileAttachmentLinks: {
        userStories: await queries.userStoryFileAttachmentLinks(identifiers(userStories)),
      },
    }
  }
}

const storyJsonColumns = ['code_selection_attachments', 'file_attachments', 'agent_models']
const additionalRecords = {
  contact: 'privacy@blame.so',
  notice:
    'Contact Blame for eligible records held in support systems, payment records held through Stripe, or a broader legal access request.',
}

async function securityExport(queries: AccountExportQueries, userId: string) {
  return {
    accessTokens: normalizeRows(await queries.accessTokens(userId), ['abilities']),
    sessions: await queries.authSessions(userId),
    signInMethods: await queries.authAccounts(userId),
    passkeys: await queries.passkeys(userId),
    dedicatedAuthenticationSecretsIncluded: false,
    exclusions: authenticationFieldExclusions,
    contentWarning:
      'Free-form content is exported as provided and may reproduce credentials or other secrets that were placed in projects, prompts, attachments, messages, commands, output, or configuration.',
  }
}

async function integrationExport(queries: AccountExportQueries, userId: string) {
  return {
    providerConnections: normalizeRows(await queries.providerConnections(userId), ['model_ids']),
  }
}

async function projectExport(queries: AccountExportQueries, projectIds: string[]) {
  const initializations = await queries.projectInitializations(projectIds)
  return {
    projectInitializations: normalizeRows(initializations, [
      'preview_manifest',
      'run_configurations',
    ]),
    projectCodePractices: await queries.projectCodePractices(projectIds),
    projectCodePracticeAnalyses: await queries.projectCodePracticeAnalyses(projectIds),
    projectAgentMemories: normalizeRows(await queries.projectAgentMemories(projectIds), [
      'files',
      'symbols',
    ]),
    securityAudits: normalizeRows(await queries.securityAudits(projectIds), ['payload']),
  }
}

async function fileAttachmentExport(queries: AccountExportQueries, userId: string) {
  const service = new FileAttachmentsService()
  const rows = await queries.fileAttachments(userId)
  return Promise.all(
    rows.map(async (row) => {
      const { object_key: objectKey, ...metadata } = row
      return {
        ...metadata,
        content: await service.contentByObjectKey(String(objectKey)),
      }
    })
  )
}

function identifiers(rows: ExportRow[]) {
  return rows.map((row) => String(row.id))
}

function normalizeRows(rows: ExportRow[], fields: string[]) {
  return rows.map((row) => normalizeRow(row, fields))
}

function normalizeRow(row: ExportRow | null, fields: string[]) {
  if (!row) return null
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      fields.includes(key) ? jsonValue(value) : value,
    ])
  )
}

type ExportRow = Record<string, unknown>

function jsonValue(value: unknown) {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}
