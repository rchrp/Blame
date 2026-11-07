import { Exception } from '@adonisjs/core/exceptions'
import UserAiPreference from '#models/user_ai_preference'
import type { saveUserAiPreferenceValidator } from '#validators/user_ai_preference'
import type { Infer } from '@vinejs/vine/types'

type SaveUserAiPreferenceInput = Infer<typeof saveUserAiPreferenceValidator>

export default class UserAiPreferencesService {
  get(userId: string) {
    return UserAiPreference.find(userId)
  }

  async save(userId: string, input: SaveUserAiPreferenceInput) {
    const existing = await UserAiPreference.find(userId)
    const { alternativeModel, agentModel, personalization } = input
    // The models are required once, to create the row; later saves may carry
    // the personalization alone.
    if (!existing && (!alternativeModel || !agentModel)) {
      throw new Exception('Choose the models before saving the personalization.', {
        code: 'E_AI_PREFERENCES_MODELS_REQUIRED',
        status: 422,
      })
    }
    const values = {
      userId,
      ...(alternativeModel
        ? {
            alternativeProviderId: alternativeModel.providerId,
            alternativeModelId: alternativeModel.modelId,
            alternativeCredentialLabel: alternativeModel.credentialLabel,
            alternativeReasoningEffort: alternativeModel.reasoningEffort,
          }
        : {}),
      ...(agentModel
        ? {
            agentProviderId: agentModel.providerId,
            agentModelId: agentModel.modelId,
            agentCredentialLabel: agentModel.credentialLabel,
            agentReasoningEffort: agentModel.reasoningEffort,
          }
        : {}),
      ...(personalization ?? {}),
    }
    if (!existing) return UserAiPreference.create(values)
    existing.merge(values)
    await existing.save()
    return existing
  }
}
