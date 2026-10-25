import { BaseSchema } from '@adonisjs/lucid/schema'

const legacyTables = ['user_stories', 'user_story_comments', 'quick_chat_messages']

export default class extends BaseSchema {
  async up() {
    this.schema.alterTable('file_attachments', (table) => {
      table.dropColumn('ai_context_markdown')
    })
    this.defer(async (db) => {
      // Retain original inline bytes and references while removing derived metadata.
      for (const table of legacyTables) {
        let afterId: string | undefined
        while (true) {
          const query = db
            .from(table)
            .select('id', 'file_attachments')
            .whereNotNull('file_attachments')
          if (afterId) query.where('id', '>', afterId)
          const rows = await query.orderBy('id', 'asc').limit(100)
          if (!rows.length) break
          for (const row of rows) {
            const cleaned = originalAttachmentPayload(row.file_attachments)
            if (cleaned !== undefined) {
              await db.from(table).where('id', row.id).update({ file_attachments: cleaned })
            }
          }
          afterId = rows.at(-1)!.id
        }
      }
    })
  }

  async down() {
    // The schema can be restored; discarded derived text is not regenerated.
    this.schema.alterTable('file_attachments', (table) => {
      table.text('ai_context_markdown', 'longtext').nullable()
    })
  }
}

export function originalAttachmentPayload(value: unknown): string | undefined {
  let parsed: unknown
  try {
    parsed = typeof value === 'string' ? JSON.parse(value) : value
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed)) return undefined
  let changed = false
  const attachments = parsed.map((attachment) => {
    if (
      !attachment ||
      typeof attachment !== 'object' ||
      !Object.hasOwn(attachment, 'aiContextMarkdown')
    )
      return attachment
    const original = { ...attachment }
    delete original.aiContextMarkdown
    changed = true
    return original
  })
  return changed ? JSON.stringify(attachments) : undefined
}
