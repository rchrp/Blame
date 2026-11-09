import { initializeMonitoring, shutdownMonitoring } from '#lib/monitoring/sdk'
import apiPackage from '../package.json' with { type: 'json' }

export function initializeApiMonitoring() {
  return initializeMonitoring({
    serviceName: 'blame-api',
    serviceVersion: process.env.BLAME_VERSION?.trim() || apiPackage.version,
  })
}

export function shutdownApiMonitoring() {
  return shutdownMonitoring()
}
