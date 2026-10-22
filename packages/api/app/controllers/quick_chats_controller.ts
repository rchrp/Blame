import QuickChatsService from '#services/quick_chats_service'
import QuickChatTransformer from '#transformers/quick_chat_transformer'
import { ScreenshotArtifactError } from '#services/agent_screenshot_artifacts'
import {
  agentScreenshotQueryValidator,
  agentScreenshotUploadValidator,
} from '#validators/user_story'
import {
  createQuickChatValidator,
  listQuickChatsValidator,
  updateQuickChatValidator,
} from '#validators/quick_chat'
import type { HttpContext } from '@adonisjs/core/http'

export default class QuickChatsController {
  async index({ auth, request, serialize }: HttpContext) {
    const query = await request.validateUsing(listQuickChatsValidator, {
      data: request.qs(),
    })
    const quickChats = await new QuickChatsService().list(auth.getUserOrFail().id, query)
    if (query.view === 'summary') {
      return serialize(quickChats.map((quickChat) => QuickChatTransformer.summary(quickChat)))
    }

    return serialize(quickChats.map((quickChat) => QuickChatTransformer.transform(quickChat)))
  }

  async store({ auth, request, serialize }: HttpContext) {
    return serialize(
      QuickChatTransformer.transform(
        await new QuickChatsService().create(
          auth.getUserOrFail().id,
          await request.validateUsing(createQuickChatValidator)
        )
      )
    )
  }

  async show({ auth, params, serialize }: HttpContext) {
    return serialize(
      QuickChatTransformer.transform(
        await new QuickChatsService().find(auth.getUserOrFail().id, params.id)
      )
    )
  }

  async update({ auth, params, request, serialize }: HttpContext) {
    return serialize(
      QuickChatTransformer.transform(
        await new QuickChatsService().update(
          auth.getUserOrFail().id,
          params.id,
          await request.validateUsing(updateQuickChatValidator)
        )
      )
    )
  }

  async destroy({ auth, params, response }: HttpContext) {
    await new QuickChatsService().delete(auth.getUserOrFail().id, params.id)
    return response.noContent()
  }

  async storeScreenshot({ auth, params, request, response }: HttpContext) {
    const input = await request.validateUsing(agentScreenshotUploadValidator)
    try {
      return await new QuickChatsService().storeAgentScreenshot(
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
      return await new QuickChatsService().agentScreenshot(
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
