import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { accountRequired } from '#lib/deployment'
import type { HttpContext } from '@adonisjs/core/http'
const PreviewSurfacesController = () => import('#controllers/preview_surfaces_controller')
const BillingController = () => import('#controllers/billing_controller')
const StripeWebhooksController = () => import('#controllers/stripe_webhooks_controller')
const AccountPrivacyController = () => import('#controllers/account_privacy_controller')
const TelemetryIngestionController = () => import('#controllers/telemetry_ingestion_controller')
const TelemetrySessionsController = () => import('#controllers/telemetry_sessions_controller')
const ConsumerContractsController = () => import('#controllers/consumer_contracts_controller')
const BetterAuthController = () => import('#controllers/better_auth_controller')
const DesktopAuthController = () => import('#controllers/desktop_auth_controller')
const SpeechTranscriptionController = () => import('#controllers/speech_transcription_controller')
const WebSearchController = () => import('#controllers/web_search_controller')
const PreviewSessionsController = () => import('#controllers/preview_sessions_controller')
const PreviewEdgeInternalController = () => import('#controllers/preview_edge_internal_controller')
const VercelConnectionsController = () => import('#controllers/vercel_connections_controller')
const GithubInstallationsController = () => import('#controllers/github_installations_controller')
const ProjectGithubController = () => import('#controllers/project_github_controller')
const DeployTargetsController = () => import('#controllers/deploy_targets_controller')
const ProjectDeploymentsController = () => import('#controllers/project_deployments_controller')
const WorkspaceTransferController = () => import('#controllers/workspace_transfer_controller')

/**
 * Routes of the services Blame hosts for accounts: sign-in, billing, account
 * privacy, telemetry, web search, Cloud Previews, voice transcription and
 * deployments. Only the hosted API registers them, under /api/v1.
 */
export function hostedRoutes() {
  router.post('web/search', [WebSearchController, 'search']).use(middleware.auth())
  router.post('webhooks/stripe', [StripeWebhooksController, 'handle'])
  router.post('account/closure-status', [AccountPrivacyController, 'status'])
  router.post('consumer-contract/withdrawal', [ConsumerContractsController, 'withdraw'])
  router.post('telemetry/otlp/v1/:signal', [TelemetryIngestionController, 'store'])
  router
    .get('telemetry/upstream-health', [TelemetryIngestionController, 'health'])
    .use(middleware.auth())
  router.get('integrations/vercel/callback', [VercelConnectionsController, 'callback'])
  router.get('integrations/github/callback', [GithubInstallationsController, 'callback'])

  router.get('telemetry/session', [TelemetrySessionsController, 'show']).use(middleware.auth())

  router
    .group(() => {
      router.post('/connect-intents', [VercelConnectionsController, 'createIntent'])
      router.get('/connections', [VercelConnectionsController, 'index'])
      router.get('/connections/:id/projects', [VercelConnectionsController, 'projects'])
      router.delete('/connections/:id/link', [VercelConnectionsController, 'destroy'])
    })
    .prefix('integrations/vercel')
    .as('integrations.vercel')
    .use(middleware.auth())

  router
    .group(() => {
      router.post('/connect-intents', [GithubInstallationsController, 'createIntent'])
      router.get('/installations', [GithubInstallationsController, 'index'])
    })
    .prefix('integrations/github')
    .as('integrations.github')
    .use(middleware.auth())

  // A project's GitHub repository and the agent's short repository-scoped token.
  router
    .group(() => {
      router.get('/:projectId/github', [ProjectGithubController, 'show'])
      router.put('/:projectId/github/repository', [ProjectGithubController, 'linkRepository'])
      router.delete('/:projectId/github/repository', [ProjectGithubController, 'unlinkRepository'])
      router.put('/:projectId/github/agent-access', [ProjectGithubController, 'updateAgentAccess'])
      router.post('/:projectId/github/agent-token', [ProjectGithubController, 'agentToken'])
    })
    .prefix('projects')
    .as('project_github')
    .use(middleware.auth())

  router
    .group(() => {
      router.get('/', [PreviewSessionsController, 'index'])
      router
        .post('/', [PreviewSessionsController, 'store'])
        .use(middleware.premium({ feature: 'cloud_preview' }))
      router.get('/:id', [PreviewSessionsController, 'show'])
      router.post('/:id/actions', [PreviewSessionsController, 'action'])
      router
        .post('/:id/surface-action', [PreviewSurfacesController, 'action'])
        .use(middleware.premium({ feature: 'cloud_preview' }))
      router
        .post('/:id/source/import', [PreviewSessionsController, 'sourceImport'])
        .use(middleware.premium({ feature: 'cloud_preview' }))
      router.post('/:id/source/export', [PreviewSessionsController, 'sourceExport'])
      router.get('/:id/logs', [PreviewSessionsController, 'logs'])
      router.get('/:id/events', [PreviewSessionsController, 'events'])
      router
        .post('/:id/access-ticket', [PreviewSessionsController, 'accessTicket'])
        .use(middleware.premium({ feature: 'cloud_preview' }))
      router
        .post('/:id/bridge-grant', [PreviewSessionsController, 'bridgeGrant'])
        .use(middleware.premium({ feature: 'cloud_preview' }))
      router
        .post('/:id/component-preview', [PreviewSessionsController, 'componentPreview'])
        .use(middleware.premium({ feature: 'cloud_preview' }))
    })
    .prefix('preview-sessions')
    .as('preview_sessions')
    .use(middleware.auth())

  router
    .group(() => {
      router.get('/', [BillingController, 'show'])
      router.post('/checkout', [BillingController, 'checkout'])
      router.post('/portal', [BillingController, 'portal'])
    })
    .prefix('billing')
    .as('billing')
    .use(middleware.auth())

  router.get('auth/desktop-complete', [DesktopAuthController, 'complete'])
  router.get('auth/desktop', [DesktopAuthController, 'passkey'])
  router.get('auth/reset-password-page', [DesktopAuthController, 'resetPassword'])
  router.get('auth/verified', [DesktopAuthController, 'verified'])
  router.post('auth/desktop-exchange', [DesktopAuthController, 'exchange'])
  router.post('auth/desktop-device-exchange', [DesktopAuthController, 'exchangeDeviceToken'])
  router.any('auth/*', [BetterAuthController, 'handle']).as('auth.better')

  router
    .group(() => {
      router.post('/transcriptions', [SpeechTranscriptionController, 'store'])
    })
    .prefix('speech')
    .as('speech')
    .use([middleware.auth(), middleware.premium({ feature: 'speech_transcription' })])

  router
    .group(() => {
      router.post('export', [AccountPrivacyController, 'download'])
      router.post('closure', [AccountPrivacyController, 'close'])
      // Receives the workspace a person built in the desktop app before signing in.
      router.put('workspace', [WorkspaceTransferController, 'import'])
    })
    .prefix('account')
    .as('account_privacy')
    .use(middleware.auth())

  router
    .group(() => {
      router.get('/:projectId/deploy-target', [DeployTargetsController, 'show'])
      router.put('/:projectId/deploy-target', [DeployTargetsController, 'update'])
      router.get('/:projectId/deployments', [ProjectDeploymentsController, 'index'])
      router
        .post('/:projectId/deployments', [ProjectDeploymentsController, 'store'])
        .use(middleware.premium({ feature: 'cloud_storage' }))
      router.get('/:projectId/deployments/:id', [ProjectDeploymentsController, 'show'])
      router
        .post('/:projectId/deployments/:id/source/complete', [
          ProjectDeploymentsController,
          'completeSource',
        ])
        .use(middleware.premium({ feature: 'cloud_storage' }))
      router.get('/:projectId/deployments/:id/logs', [ProjectDeploymentsController, 'logs'])
      router.post('/:projectId/deployments/:id/cancel', [ProjectDeploymentsController, 'cancel'])
    })
    .prefix('projects')
    .as('project_deployments')
    .use(middleware.auth())
}

/** Internal routes for the preview edge, outside /api/v1. */
export function previewEdgeRoutes() {
  router
    .group(() => {
      router.post('/resolve', [PreviewEdgeInternalController, 'resolve'])
      router.post('/consume-ticket', [PreviewEdgeInternalController, 'consumeTicket'])
    })
    .prefix('/internal/preview-edge')
}

const hostedPaths = [
  'web/search',
  'webhooks/stripe',
  'account/closure-status',
  'account/export',
  'account/closure',
  'consumer-contract/*',
  'telemetry/*',
  'integrations/vercel/*',
  'integrations/github/*',
  'preview-sessions',
  'preview-sessions/*',
  'billing',
  'billing/*',
  'auth/*',
  'speech/*',
  'projects/:projectId/deploy-target',
  'projects/:projectId/deployments',
  'projects/:projectId/deployments/*',
  'projects/:projectId/github',
  'projects/:projectId/github/*',
]

/**
 * On the local API, the hosted routes answer that they need an account, so
 * the app can say so instead of failing.
 */
export function accountRequiredRoutes() {
  for (const path of hostedPaths) {
    router.any(path, ({ response }: HttpContext) => response.forbidden(accountRequired))
  }
}
