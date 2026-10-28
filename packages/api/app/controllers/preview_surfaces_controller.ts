import type { HttpContext } from '@adonisjs/core/http'
import PreviewSurfaceService from '#services/preview_sessions/preview_surface_service'

export default class PreviewSurfacesController {
  async action({ auth, request, params, response }: HttpContext) {
    const body: unknown = request.all()
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return response.badRequest({ message: 'Invalid screen action.' })
    const { serviceId, arguments: args } = body as Record<string, unknown>
    if (
      typeof serviceId !== 'string' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(serviceId) ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      JSON.stringify(args).length > 70000
    )
      return response.badRequest({ message: 'Invalid screen action.' })
    return new PreviewSurfaceService().action(
      auth.getUserOrFail().id,
      params.id,
      serviceId,
      args as Record<string, unknown>
    )
  }
}
