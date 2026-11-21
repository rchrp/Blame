import type Epic from '#models/epic'
import { BaseTransformer } from '@adonisjs/core/transformers'

export default class EpicTransformer extends BaseTransformer<Epic> {
  toObject() {
    return this.pick(this.resource, [
      'id',
      'projectId',
      'title',
      'goal',
      'status',
      'branch',
      'targetBranch',
      'engineSessionId',
      'settings',
      'mergedAt',
      'mergeCommit',
      'createdAt',
      'updatedAt',
    ])
  }
}
