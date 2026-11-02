import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/cors'
import env from '#start/env'
import { deployment } from '#lib/deployment'

const siteOrigin = new URL(env.get('BLAME_SITE_URL', 'https://blame.so')).origin
const allowedOrigins = Array.from(
  new Set([
    siteOrigin,
    ...env
      .get('CORS_ORIGIN', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ])
)

/**
 * Configuration options to tweak the CORS policy. The following
 * options are documented on the official documentation website.
 *
 * https://docs.adonisjs.com/guides/security/cors
 */
const corsConfig = defineConfig({
  /**
   * Enable or disable CORS handling globally.
   */
  enabled: true,

  /**
   * In development, allow every origin to simplify local front/backend setup.
   * In production, keep an explicit allowlist (empty by default, so no
   * cross-origin browser access is allowed until configured).
   */
  // The local API listens on the loopback interface and requires the token
  // the desktop app received at startup, whatever page it serves.
  origin: app.inDev || !deployment.hostedServices ? true : allowedOrigins,

  /**
   * HTTP methods accepted for cross-origin requests.
   */
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],

  /**
   * Reflect request headers by default. Use a string array to restrict
   * allowed headers.
   */
  headers: true,

  /**
   * Response headers exposed to the browser.
   */
  exposeHeaders: [],

  /**
   * Allow cookies/authorization headers on cross-origin requests.
   */
  credentials: true,

  /**
   * Cache CORS preflight response for N seconds.
   */
  maxAge: 90,
})

export default corsConfig
