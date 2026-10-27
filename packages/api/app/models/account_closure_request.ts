import { AccountClosureRequestSchema } from '#database/schema'
import { assignUuidV7Id } from '#lib/uuid_v7_model'
import { beforeCreate } from '@adonisjs/lucid/orm'

export type AccountClosureStatus =
  'pending_active_deletion' | 'pending_external_cleanup' | 'completed'

export default class AccountClosureRequest extends AccountClosureRequestSchema {
  static selfAssignPrimaryKey = true

  @beforeCreate()
  static assignId(request: AccountClosureRequest) {
    assignUuidV7Id(request)
  }

  declare status: AccountClosureStatus
}
