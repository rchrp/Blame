import type QuickChat from '#models/quick_chat'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class QuickChatTransformer extends BaseTransformer<QuickChat> {
  toObject() {
    return {
      ...this.pick(this.resource, [
        'id',
        'projectId',
        'title',
        'workspace',
        'engineSessionId',
        'createdAt',
        'updatedAt',
      ]),
      lastActivityAt: this.resource.lastActivityAt,
    }
  }
}
