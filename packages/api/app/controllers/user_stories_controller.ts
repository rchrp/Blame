import UserStoriesService from '#services/user_stories_service'
import UserStoryTransformer from '#transformers/user_story_transformer'
import { ScreenshotArtifactError } from '#services/agent_screenshot_artifacts'
import {
  agentScreenshotQueryValidator,
  agentScreenshotUploadValidator,
  createUserStoryValidator,
  listUserStoriesValidator,
  updateUserStoryValidator,
} from '#validators/user_story'
import type { HttpContext } from '@adonisjs/core/http'

export default class UserStoriesController {
  async index({ auth, request, serialize }: HttpContext) {
    const query = await request.validateUsing(listUserStoriesValidator, {
      data: request.qs(),
    })
    const stories = await new UserStoriesService().list(auth.getUserOrFail().id, query)
    if (query.view === 'summary') {
      return serialize(UserStoryTransformer.transform(stories).useVariant('toSummary'))
    }

    return serialize(UserStoryTransformer.transform(stories))
  }

  async store({ auth, request, serialize }: HttpContext) {
    return serialize(
      UserStoryTransformer.transform(
        await new UserStoriesService().create(
          auth.getUserOrFail().id,
          await request.validateUsing(createUserStoryValidator)
        )
      )
    )
  }

  async show({ auth, params, serialize }: HttpContext) {
    return serialize(
      UserStoryTransformer.transform(
        await new UserStoriesService().find(auth.getUserOrFail().id, params.id)
      )
    )
  }

  async update({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      UserStoryTransformer.transform(
        await new UserStoriesService().update(
          auth.getUserOrFail().id,
          params.id,
          await request.validateUsing(updateUserStoryValidator)
        )
      )
    )
  }

  async activityDetail({ auth, params, response }: HttpContext) {
    try {
      return await new UserStoriesService().activityDetail(
        auth.getUserOrFail().id,
        params.id,
        params.activityId
      )
    } catch {
      return response.notFound({ message: 'Agent activity not found.' })
    }
  }

  async destroy({ auth, params, response }: HttpContext) {
    await new UserStoriesService().delete(auth.getUserOrFail().id, params.id)
    return response.noContent()
  }

  async storeScreenshot({ auth, params, request, response }: HttpContext) {
    const input = await request.validateUsing(agentScreenshotUploadValidator)
    try {
      return await new UserStoriesService().storeAgentScreenshot(
        auth.getUserOrFail().id,
        params.id,
        params.screenshotId,
        input
      )
    } catch (error) {
      if (error instanceof ScreenshotArtifactError)
        return response.badRequest({ message: error.message })
      throw error
    }
  }

  async showScreenshot({ auth, params, request, response }: HttpContext) {
    const query = await request.validateUsing(agentScreenshotQueryValidator, {
      data: request.qs(),
    })
    try {
      return await new UserStoriesService().agentScreenshot(
        auth.getUserOrFail().id,
        params.id,
        params.screenshotId,
        query.sessionId
      )
    } catch {
      return response.notFound({ message: 'Screenshot not found.' })
    }
  }
}
