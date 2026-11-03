import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'
import {
  parsePreviewEnvironmentSecrets,
  type PreviewEnvironmentSecrets,
} from '@blame/preview-runtime'

// The variables of a cloud preview, encrypted at rest with the app key and
// read only when the runner needs them: never part of the plan, its hash or
// the session view.

const table = 'preview_session_environments'

export async function storePreviewEnvironment(
  sessionId: string,
  environment: PreviewEnvironmentSecrets | undefined
) {
  if (!environment) {
    await db.from(table).where('session_id', sessionId).delete()
    return
  }
  const now = new Date()
  const encrypted = await encryption.encrypt(JSON.stringify(environment))
  const updated = await db
    .from(table)
    .where('session_id', sessionId)
    .update({ environment_encrypted: encrypted, updated_at: now })
  if (Number(Array.isArray(updated) ? updated[0] : updated) > 0) return
  await db.table(table).insert({
    session_id: sessionId,
    environment_encrypted: encrypted,
    created_at: now,
    updated_at: now,
  })
}

export async function loadPreviewEnvironment(
  sessionId: string
): Promise<PreviewEnvironmentSecrets | undefined> {
  const row = await db.from(table).where('session_id', sessionId).first()
  if (!row?.environment_encrypted) return undefined
  const decrypted = await encryption.decrypt(row.environment_encrypted)
  if (typeof decrypted !== 'string') return undefined
  return parsePreviewEnvironmentSecrets(JSON.parse(decrypted))
}

export async function forgetPreviewEnvironment(sessionId: string) {
  await db.from(table).where('session_id', sessionId).delete()
}
