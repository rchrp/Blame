import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class StripeWebhookEvent extends BaseModel {
  static selfAssignPrimaryKey = true

  static table = 'stripe_webhook_events'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare type: string

  @column.dateTime({ autoCreate: true })
  declare processedAt: DateTime
}
