import QuickChatsService from '#services/quick_chats_service'
import QuickChatTransformer from '#transformers/quick_chat_transformer'
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
    return serialize(QuickChatTransformer.transform(quickChats))
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
}
