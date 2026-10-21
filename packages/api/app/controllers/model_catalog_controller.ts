import ModelCatalogService from '#services/model_catalog_service'
import ProviderCredentialsService from '#services/provider_credentials_service'
import type { HttpContext } from '@adonisjs/core/http'

export default class ModelCatalogController {
  async show({ auth, request, serialize }: HttpContext) {
    const userId = auth.getUserOrFail().id
    const credentials = await new ProviderCredentialsService().list(userId)
    return serialize(
      await new ModelCatalogService().catalog(userId, credentials, {
        connectedOnly: request.input('view') === 'selector',
      })
    )
  }

  async model({ request, response, serialize }: HttpContext) {
    const { providerId, modelId } = request.qs()
    if (!nonEmptyString(providerId) || !nonEmptyString(modelId)) {
      return response.badRequest({ message: 'providerId and modelId are required' })
    }
    const model = await new ModelCatalogService().modelInfo(providerId, modelId)
    if (!model) return response.notFound({ message: 'Unknown model' })
    return serialize(model)
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
