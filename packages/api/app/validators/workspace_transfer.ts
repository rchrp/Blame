import vine from '@vinejs/vine'
import { workspaceTables } from '#services/workspace_transfer_service'

const rows = vine.array(vine.object({}).allowUnknownProperties()).optional()

export const importWorkspaceValidator = vine.create({
  format: vine.literal('blame-workspace'),
  version: vine.literal(1),
  tables: vine.object(Object.fromEntries(workspaceTables.map((table) => [table, rows]))),
})
