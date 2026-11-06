import PreviewSessionService from '#services/preview_sessions/preview_session_service'
import PreviewComponentPreviewService from '#services/preview_sessions/preview_component_preview_service'
import PremiumService, { previewCommandRequiresPremium } from '#services/premium_service'
import {
  PreviewRuntimeError,
  parsePreviewEnvironmentSecrets,
  parseComponentPreviewSandboxCursor,
  parseComponentPreviewSandboxStart,
  isRuntimeProfileId,
  type PreviewSessionCommand,
} from '@blame/preview-runtime'
import type { PreviewManifest } from '@blame/preview-contract'
import type { HttpContext } from '@adonisjs/core/http'

const service = new PreviewSessionService()
const componentPreviews = new PreviewComponentPreviewService()

export default class PreviewSessionsController {
  async index(context: HttpContext) {
    try {
      const query = objectBody(context.request.qs())
      const profile = query.profile
      if (!isRuntimeProfileId(profile) || profile === 'local-container') {
        throw invalidRequest('A managed cloud runtime profile is required.')
      }
      return {
        session: await service.findForUserStory(
          context.auth.getUserOrFail().id,
          requiredString(query.userStoryId, 'userStoryId'),
          profile
        ),
      }
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async store(context: HttpContext) {
    try {
      const body = objectBody(context.request.all())
      const profile = body.profile
      if (profile === 'vercel-process') {
        throw invalidRequest('vercel-process is no longer supported; use vercel-compose.')
      }
      if (!isRuntimeProfileId(profile) || profile === 'local-container') {
        throw invalidRequest('A managed cloud runtime profile is required.')
      }
      return await service.create(
        context.auth.getUserOrFail().id,
        {
          userStoryId: requiredString(body.userStoryId, 'userStoryId'),
          profile,
          previewManifest: objectBody(body.previewManifest) as PreviewManifest,
          cloudUploadConsentAt: requiredString(body.cloudUploadConsentAt, 'cloudUploadConsentAt'),
          sourceRevision: optionalString(body.sourceRevision, 'sourceRevision'),
          sourceMetadata:
            body.sourceMetadata === undefined
              ? undefined
              : previewSourceMetadata(body.sourceMetadata),
          resourceSize: resourceSize(body.resourceSize),
          environment: previewEnvironment(body.environment),
        },
        requiredString(body.operationId ?? context.request.header('idempotency-key'), 'operationId')
      )
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async show(context: HttpContext) {
    try {
      return await service.get(context.auth.getUserOrFail().id, context.params.id)
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async action(context: HttpContext) {
    try {
      const body = objectBody(context.request.all())
      const command = previewCommand(body.command)
      if (previewCommandRequiresPremium(command)) {
        const denial = await new PremiumService().denial(
          context.auth.getUserOrFail().id,
          'cloud_preview'
        )
        if (denial) return context.response.paymentRequired(denial)
      }
      return await service.command(
        context.auth.getUserOrFail().id,
        context.params.id,
        command,
        requiredString(body.operationId ?? context.request.header('idempotency-key'), 'operationId')
      )
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async accessTicket(context: HttpContext) {
    try {
      const body = objectBody(context.request.all())
      return await service.issueAccessTicket(
        context.auth.getUserOrFail().id,
        context.params.id,
        optionalString(body.routeId, 'routeId')
      )
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async bridgeGrant(context: HttpContext) {
    try {
      return await service.issueDesktopBridgeGrant(
        context.auth.getUserOrFail().id,
        context.params.id
      )
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  // open_component_preview's server in the preview's sandbox: start, its
  // output while it starts, a fresh route capability, stop.
  async componentPreview(context: HttpContext) {
    try {
      return await componentPreviewAction(
        context.auth.getUserOrFail().id,
        context.params.id,
        objectBody(context.request.all())
      )
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async sourceImport(context: HttpContext) {
    try {
      const body = objectBody(context.request.all())
      const ownerUserId = context.auth.getUserOrFail().id
      if (body.action === 'negotiate') {
        return await service.negotiateSource(ownerUserId, context.params.id, {
          baseRevision: requiredString(body.sourceRevision, 'sourceRevision'),
          sanitizedTreeHash: requiredHash(body.sanitizedTreeHash, 'sanitizedTreeHash'),
          lockfileHash: requiredHash(body.lockfileHash, 'lockfileHash'),
          workspaceHash: requiredHash(body.workspaceHash, 'workspaceHash'),
        })
      }
      if (body.action === 'prepare') {
        return await service.prepareSourceUpload(ownerUserId, context.params.id, {
          sha256: requiredSha256(body.sha256),
          size: positiveInteger(body.size, 'size'),
          sourceRevision: requiredString(body.sourceRevision, 'sourceRevision'),
          sanitizedTreeHash: optionalHash(body.sanitizedTreeHash, 'sanitizedTreeHash'),
          lockfileHash: optionalHash(body.lockfileHash, 'lockfileHash'),
          workspaceHash: optionalHash(body.workspaceHash, 'workspaceHash'),
          baseHash: optionalHash(body.baseHash, 'baseHash'),
          mode: body.mode === undefined ? undefined : body.mode === 'delta' ? 'delta' : 'full',
        })
      }
      if (body.action === 'apply') {
        return await service.importSource(
          ownerUserId,
          context.params.id,
          requiredString(body.artifactId, 'artifactId'),
          optionalString(body.baselineId, 'baselineId')
        )
      }
      throw invalidRequest('Unsupported source import action.')
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async sourceExport(context: HttpContext) {
    try {
      return await service.exportSourceDelta(context.auth.getUserOrFail().id, context.params.id)
    } catch (error) {
      return runtimeErrorResponse(context, error)
    }
  }

  async events(context: HttpContext) {
    return streamEvents(context, service, false)
  }

  async logs(context: HttpContext) {
    return streamEvents(context, service, true)
  }
}

async function streamEvents(
  context: HttpContext,
  sessions: PreviewSessionService,
  logsOnly: boolean
) {
  try {
    const raw = context.response.response
    raw.setHeader('Content-Type', 'text/event-stream')
    raw.setHeader('Cache-Control', 'no-cache, no-transform')
    raw.setHeader('Connection', 'keep-alive')
    raw.flushHeaders()
    let cursor = optionalString(context.request.qs().cursor, 'cursor')
    let closed = false
    context.request.request.once('close', () => (closed = true))
    for (let iteration = 0; iteration < 25 && !closed; iteration += 1) {
      const stream = logsOnly
        ? sessions.logs(context.auth.getUserOrFail().id, context.params.id, cursor)
        : sessions.events(context.auth.getUserOrFail().id, context.params.id, cursor)
      for await (const event of stream) {
        const eventCursor = 'cursor' in event ? event.cursor : String(event.sequence)
        cursor = eventCursor
        const eventType = 'type' in event ? event.type : 'log'
        raw.write(`id: ${eventCursor}\nevent: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      if (!closed) await delay(1000)
    }
    if (!closed) raw.write(': reconnect\n\n')
    raw.end()
  } catch (error) {
    if (!context.response.response.headersSent) return runtimeErrorResponse(context, error)
    context.response.response.end()
  }
}

function previewCommand(value: unknown): PreviewSessionCommand {
  const command = objectBody(value)
  switch (command.type) {
    case 'start-services':
      return {
        type: command.type,
        configurationId: requiredString(command.configurationId, 'configurationId'),
        serviceIds: optionalServiceIds(command.serviceIds),
        primaryRoute: optionalPrimaryRoute(command.primaryRoute),
      }
    case 'stop-services':
    case 'start-agent':
    case 'stop-agent':
    case 'suspend-host':
    case 'resume-host':
    case 'report-sync-conflict':
      return { type: command.type }
    case 'destroy-host': {
      const discard = command.discardPendingDelta
      return {
        type: command.type,
        discardPendingDelta:
          discard === undefined
            ? undefined
            : {
                confirmationId: requiredString(
                  objectBody(discard).confirmationId,
                  'confirmationId'
                ),
              },
      }
    }
    case 'ack-local-sync':
      return {
        type: command.type,
        deltaRevision: requiredString(command.deltaRevision, 'deltaRevision'),
        workspaceHash: optionalHash(command.workspaceHash, 'workspaceHash'),
      }
    default:
      throw invalidRequest('Unsupported preview command.')
  }
}

function optionalServiceIds(value: unknown) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 50) throw invalidRequest('serviceIds is invalid.')
  return [...new Set(value.map((entry) => requiredString(entry, 'serviceId')))]
}

function optionalPrimaryRoute(value: unknown) {
  if (value === undefined) return undefined
  const route = objectBody(value)
  return {
    serviceId: requiredString(route.serviceId, 'primaryRoute.serviceId'),
    endpointId: requiredString(route.endpointId, 'primaryRoute.endpointId'),
  }
}

function resourceSize(value: unknown) {
  if (value === undefined) return undefined
  const input = objectBody(value)
  const vcpus = positiveInteger(input.vcpus, 'resourceSize.vcpus')
  const memoryGb = positiveInteger(input.memoryGb, 'resourceSize.memoryGb')
  return { vcpus, memoryGb }
}

function previewSourceMetadata(value: unknown) {
  const input = objectBody(value)
  return {
    baseRevision: requiredString(input.sourceRevision, 'sourceMetadata.sourceRevision'),
    sanitizedTreeHash: requiredHash(input.sanitizedTreeHash, 'sourceMetadata.sanitizedTreeHash'),
    lockfileHash: requiredHash(input.lockfileHash, 'sourceMetadata.lockfileHash'),
    workspaceHash: requiredHash(input.workspaceHash, 'sourceMetadata.workspaceHash'),
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalidRequest('Invalid request body.')
  return value as Record<string, unknown>
}

function componentPreviewAction(
  ownerUserId: string,
  sessionId: string,
  body: Record<string, unknown>
) {
  switch (body.action) {
    case 'start': {
      const start = parseComponentPreviewSandboxStart(body)
      if (!start.ok) throw invalidRequest(start.message)
      return componentPreviews.start(ownerUserId, sessionId, start.value)
    }
    case 'output': {
      const cursor = parseComponentPreviewSandboxCursor(body.cursor)
      if (!cursor) throw invalidRequest('cursor is invalid.')
      return componentPreviews.output(ownerUserId, sessionId, cursor)
    }
    case 'refresh': {
      const port = positiveInteger(body.port, 'port')
      if (port > 65_535) throw invalidRequest('port is invalid.')
      return componentPreviews.refresh(ownerUserId, sessionId, port)
    }
    case 'stop':
      return componentPreviews.stop(ownerUserId, sessionId)
    default:
      throw invalidRequest('action is invalid.')
  }
}

function requiredString(value: unknown, name: string) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
    throw invalidRequest(`${name} is invalid.`)
  }
  return value.trim()
}

function optionalString(value: unknown, name: string) {
  return value === undefined ? undefined : requiredString(value, name)
}

function optionalHash(value: unknown, name: string) {
  if (value === undefined) return undefined
  const result = requiredString(value, name)
  if (!/^[a-f0-9]{64}$/i.test(result)) throw invalidRequest(`${name} is invalid.`)
  return result
}

function requiredHash(value: unknown, name: string) {
  const result = requiredString(value, name)
  if (!/^[a-f0-9]{64}$/i.test(result)) throw invalidRequest(`${name} is invalid.`)
  return result
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw invalidRequest(`${name} is invalid.`)
  return Number(value)
}

function requiredSha256(value: unknown) {
  const sha256 = requiredString(value, 'sha256')
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw invalidRequest('sha256 is invalid.')
  return sha256
}

function runtimeErrorResponse(context: HttpContext, error: unknown) {
  const { response } = context
  if (error instanceof InvalidPreviewRequestError) {
    return response.badRequest({
      failure: { code: 'INVALID_MANIFEST', message: error.message, retryable: false },
    })
  }
  if (!(error instanceof PreviewRuntimeError)) {
    const status = Number((error as { status?: unknown })?.status)
    if (status === 404) {
      return response.notFound({
        failure: {
          code: 'PREVIEW_ACCESS_DENIED',
          message: 'Preview resource not found.',
          retryable: false,
        },
      })
    }
    context.logger.error({ err: error }, 'Unexpected preview runtime request failure')
    return response.internalServerError({
      failure: { code: 'INTERNAL', message: 'Preview runtime request failed.', retryable: true },
    })
  }
  const status =
    error.failure.code === 'PREVIEW_ACCESS_DENIED'
      ? 403
      : ['PROVIDER_QUOTA', 'BUDGET_EXCEEDED'].includes(error.failure.code)
        ? 429
        : error.failure.retryable
          ? 503
          : 422
  return response.status(status).send({ failure: error.failure })
}

class InvalidPreviewRequestError extends Error {}

function invalidRequest(message: string) {
  return new InvalidPreviewRequestError(message)
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

// The resolved variables of the preview; a malformed value is refused.
function previewEnvironment(value: unknown) {
  if (value === undefined || value === null) return undefined
  try {
    return parsePreviewEnvironmentSecrets(value)
  } catch (error) {
    throw invalidRequest(error instanceof Error ? error.message : 'environment is invalid')
  }
}
