import ModelRecommendationsService from '#services/model_recommendations_service'
import { modelRecommendationsValidator } from '#validators/model_recommendations'
import type { HttpContext } from '@adonisjs/core/http'

export default class ModelRecommendationsController {
  async store({ request, serialize }: HttpContext) {
    const input = await request.validateUsing(modelRecommendationsValidator)
    return serialize(await new ModelRecommendationsService().recommend(input))
  }
}
