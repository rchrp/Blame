import { BaseModel, column } from '@adonisjs/lucid/orm'
import { DateTime } from 'luxon'

export default class UserSubscription extends BaseModel {
  static selfAssignPrimaryKey = true

  static table = 'user_subscriptions'

  @column({ isPrimary: true })
  declare userId: string

  @column()
  declare stripeCustomerId: string

  @column()
  declare stripeSubscriptionId: string | null

  @column()
  declare stripePriceId: string | null

  @column()
  declare stripeCheckoutSessionId: string | null

  @column()
  declare lastStripeEventCreatedAt: number | null

  @column()
  declare status: string

  @column.dateTime()
  declare currentPeriodEnd: DateTime | null

  @column()
  declare cancelAtPeriodEnd: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime | null
}
