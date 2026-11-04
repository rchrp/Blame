import ProjectInitializationsService from '#services/project_initializations_service'
import ProjectInitializationTransformer from '#transformers/project_initialization_transformer'
import {
  checkProjectInitializationValidator,
  completeProjectInitializationValidator,
  failProjectInitializationValidator,
  repairProjectInitializationValidator,
  startProjectInitializationValidator,
} from '#validators/project_initialization'
import type { HttpContext } from '@adonisjs/core/http'

export default class ProjectInitializationsController {
  async show({ auth, params, serialize }: HttpContext) {
    return serialize(
      ProjectInitializationTransformer.transform(
        await new ProjectInitializationsService().show(auth.getUserOrFail().id, params.projectId)
      )
    )
  }

  async start({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      ProjectInitializationTransformer.transform(
        await new ProjectInitializationsService().start(
          auth.getUserOrFail().id,
          params.projectId,
          await request.validateUsing(startProjectInitializationValidator)
        )
      )
    )
  }

  async complete({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      ProjectInitializationTransformer.transform(
        await new ProjectInitializationsService().complete(
          auth.getUserOrFail().id,
          params.projectId,
          await request.validateUsing(completeProjectInitializationValidator)
        )
      )
    )
  }

  async fail({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      ProjectInitializationTransformer.transform(
        await new ProjectInitializationsService().fail(
          auth.getUserOrFail().id,
          params.projectId,
          await request.validateUsing(failProjectInitializationValidator)
        )
      )
    )
  }

  async repair({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      ProjectInitializationTransformer.transform(
        await new ProjectInitializationsService().repair(
          auth.getUserOrFail().id,
          params.projectId,
          await request.validateUsing(repairProjectInitializationValidator)
        )
      )
    )
  }

  async check({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      ProjectInitializationTransformer.transform(
        await new ProjectInitializationsService().check(
          auth.getUserOrFail().id,
          params.projectId,
          await request.validateUsing(checkProjectInitializationValidator)
        )
      )
    )
  }
}
