import TelemetryTokenService from '#services/telemetry_token_service'
import { requiredTelemetrySetting } from '#services/telemetry_ingestion_service'
import type { HttpContext } from '@adonisjs/core/http'

export default class TelemetrySessionsController {
  show({ auth, response }: HttpContext) {
    const user = auth.getUserOrFail()
    response.header('Cache-Control', 'private, no-store')
    return {
      endpoint: requiredTelemetrySetting('BLAME_TELEMETRY_PUBLIC_ENDPOINT'),
      ...new TelemetryTokenService().issue(user.id),
    }
  }
}
