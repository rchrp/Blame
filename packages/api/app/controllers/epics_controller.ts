import EpicsService from '#services/epics_service'
import EpicTransformer from '#transformers/epic_transformer'
import { createEpicValidator, listEpicsValidator, updateEpicValidator } from '#validators/epic'
import type { HttpContext } from '@adonisjs/core/http'

export default class EpicsController {
  async index({ auth, request, serialize }: HttpContext) {
    const query = await request.validateUsing(listEpicsValidator, { data: request.qs() })
    const epics = await new EpicsService().list(auth.getUserOrFail().id, query)
    return serialize(EpicTransformer.transform(epics))
  }

  async store({ auth, request, serialize }: HttpContext) {
    return serialize(
      EpicTransformer.transform(
        await new EpicsService().create(
          auth.getUserOrFail().id,
          await request.validateUsing(createEpicValidator)
        )
      )
    )
  }

  async show({ auth, params, serialize }: HttpContext) {
    return serialize(
      EpicTransformer.transform(await new EpicsService().find(auth.getUserOrFail().id, params.id))
    )
  }

  async update({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      EpicTransformer.transform(
        await new EpicsService().update(
          auth.getUserOrFail().id,
          params.id,
          await request.validateUsing(updateEpicValidator, { meta: { epicId: params.id } })
        )
      )
    )
  }

  async destroy({ auth, params, response }: HttpContext) {
    await new EpicsService().delete(auth.getUserOrFail().id, params.id)
    return response.noContent()
  }
}
