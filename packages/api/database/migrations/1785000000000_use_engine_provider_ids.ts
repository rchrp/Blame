import { BaseSchema } from '@adonisjs/lucid/schema'

/** The app's ids that become the engine's; the other kept ids are the same. */
const renamed: Record<string, string> = {
  'openai-native': 'openai',
  'openai-codex': 'chatgpt',
}

/**
 * The ids the agent engine serves, under their old names. Everything else
 * (`cline`, Cline's own `openai`, Bedrock, Vertex…) leaves the product.
 */
const kept = [
  'anthropic',
  'claude-code',
  'openai-native',
  'openai-codex',
  'gemini',
  'openrouter',
  'openai-compatible',
]

/** Where a provider id is stored, and what to clear with it. */
const choices = [
  { table: 'user_stories', provider: 'agent_provider_id', model: 'agent_model_id' },
  {
    table: 'project_initializations',
    provider: 'agent_provider_id',
    model: 'agent_model_id',
  },
  {
    table: 'project_code_practice_analyses',
    provider: 'agent_provider_id',
    model: 'agent_model_id',
  },
]

/**
 * Providers are named by the agent engine's ids everywhere (`openai`,
 * `chatgpt`), and the providers it does not serve are gone: their
 * credentials are deleted and choices of their models cleared. The model
 * catalog lives in the engine (models.dev); the API's copy is dropped.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.dropTableIfExists('model_catalog_snapshots')
    this.defer(async (db) => {
      // A later migration (stories on engine sessions) drops the story's
      // provider columns and its runs: what is gone has nothing to rename.
      const exists = (table: string, column: string) =>
        db
          .from(table)
          .select(column)
          .limit(0)
          .then(
            () => true,
            () => false
          )
      const present = []
      for (const choice of choices)
        if (await exists(choice.table, choice.provider)) present.push(choice)
      const runs = await exists('user_story_agent_runs', 'provider_id')
      await db.from('provider_credentials').whereNotIn('provider_id', kept).delete()
      for (const { table, provider, model } of present) {
        await db
          .from(table)
          .whereNotNull(provider)
          .whereNotIn(provider, kept)
          .update({ [provider]: null, [model]: null })
      }
      // A preference that names a model the person can no longer pick is
      // deleted: onboarding asks for both models again.
      await db
        .from('user_ai_preferences')
        .where((query) =>
          query.whereNotIn('agent_provider_id', kept).orWhereNotIn('alternative_provider_id', kept)
        )
        .delete()
      for (const [from, to] of Object.entries(renamed)) {
        await db.from('provider_credentials').where('provider_id', from).update({ provider_id: to })
        for (const { table, provider } of present) {
          await db
            .from(table)
            .where(provider, from)
            .update({ [provider]: to })
        }
        for (const role of ['agent', 'alternative']) {
          await db
            .from('user_ai_preferences')
            .where(`${role}_provider_id`, from)
            .update({ [`${role}_provider_id`]: to })
        }
        // Past runs keep their history, under the provider's new name.
        if (runs)
          await db
            .from('user_story_agent_runs')
            .where('provider_id', from)
            .update({ provider_id: to })
      }
    })
  }

  async down() {
    // The ids can be renamed back; deleted credentials and the dropped
    // catalog are not restored.
    this.defer(async (db) => {
      for (const [from, to] of Object.entries(renamed)) {
        await db.from('provider_credentials').where('provider_id', to).update({ provider_id: from })
      }
    })
  }
}
