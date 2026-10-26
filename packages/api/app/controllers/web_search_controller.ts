import env from '#start/env'
import WebSearchService, { WebSearchError } from '#services/web_search_service'
import { webSearchValidator } from '#validators/web_search'
import type { HttpContext } from '@adonisjs/core/http'

const windows = new Map<string, { start: number; count: number; active: number }>()
let active = 0

export default class WebSearchController {
  async search({ auth, request, response }: HttpContext) {
    const input = await request.validateUsing(webSearchValidator)
    const userId = auth.getUserOrFail().id
    const now = Date.now()
    for (const [id, value] of windows)
      if (!value.active && now - value.start > 60_000) windows.delete(id)
    const window = windows.get(userId) ?? { start: now, count: 0, active: 0 }
    if (now - window.start >= 60_000) {
      window.start = now
      window.count = 0
    }
    if (window.count >= 30 || window.active >= 2 || active >= 16) {
      response.header('Retry-After', '60')
      return response.tooManyRequests({ message: 'Web search is busy. Please try again shortly.' })
    }
    window.count++
    window.active++
    active++
    windows.set(userId, window)
    try {
      return await new WebSearchService(env.get('SEARXNG_URL')).search(input)
    } catch (error) {
      if (error instanceof WebSearchError)
        return response.status(error.status).send({ message: error.message })
      throw error
    } finally {
      window.active--
      active--
    }
  }
}
