/*
|--------------------------------------------------------------------------
| Local API entrypoint
|--------------------------------------------------------------------------
|
| The desktop app runs this file to use Blame without an account. It serves
| the API on the loopback interface, on SQLite, for the local user only:
|
| 1. migrates the database,
| 2. starts the HTTP server on a free port,
| 3. reports `{ type: 'ready', url, token }` to the desktop app.
|
| Under Electron the report goes through the utility process port; under
| plain Node it is printed as one JSON line, for development and tests.
|
*/

import type { AddressInfo } from 'node:net'
import type { ApplicationService } from '@adonisjs/core/types'

process.env.BLAME_DEPLOYMENT = 'local'
process.env.DB_CONNECTION = 'sqlite'
process.env.HOST = '127.0.0.1'
process.env.PORT ??= '0'
process.env.TZ = 'UTC'
process.env.NODE_ENV ??= 'production'
process.env.LOG_LEVEL ??= 'info'
process.env.APP_URL ??= 'http://127.0.0.1'
process.env.SESSION_DRIVER = 'memory'

await import('reflect-metadata')
const { Ignitor, prettyPrintError } = await import('@adonisjs/core')

const APP_ROOT = new URL('../', import.meta.url)

const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

type LocalApiMessage =
  { type: 'ready'; url: string; token: string } | { type: 'error'; message: string }

function report(message: LocalApiMessage) {
  const port = (process as NodeJS.Process & { parentPort?: { postMessage(value: unknown): void } })
    .parentPort
  if (port) port.postMessage(message)
  else process.stdout.write(`${JSON.stringify(message)}\n`)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.ready(() => announce(app).catch(fail))
    app.listen('SIGTERM', () => app.terminate())
    app.listen('SIGINT', () => app.terminate())
  })
  .httpServer()
  .start()
  .catch(fail)

async function announce(app: ApplicationService) {
  const db = await app.container.make('lucid.db')
  const { MigrationRunner } = await import('@adonisjs/lucid/migration')
  const migrator = new MigrationRunner(db, app, { direction: 'up', disableLocks: true })
  await migrator.run()
  if (migrator.error) throw migrator.error
  const { default: LocalSessionService } = await import('#services/local_session_service')
  const token = await new LocalSessionService().start()
  const server = await app.container.make('server')
  const address = server.getNodeServer()?.address() as AddressInfo
  report({ type: 'ready', url: `http://127.0.0.1:${address.port}/api/v1`, token })
}

function fail(error: unknown) {
  process.exitCode = 1
  report({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  prettyPrintError(error)
  process.exit()
}
