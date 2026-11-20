import vine from '@vinejs/vine'
import { engineProviderId } from '#validators/provider_id'

const price = vine.number().min(0).nullable()

/** The models a client offers, from the engine's catalog. */
export const modelRecommendationsValidator = vine.create({
  connected: vine.array(engineProviderId).maxLength(20),
  models: vine
    .array(
      vine.object({
        providerId: engineProviderId,
        modelId: vine.string().trim().minLength(1).maxLength(200),
        name: vine.string().trim().minLength(1).maxLength(200),
        releaseDate: vine.string().trim().maxLength(20).optional(),
        cost: vine.object({
          input: price,
          output: price,
          cacheRead: price.clone().optional(),
        }),
      })
    )
    .maxLength(5000),
})
