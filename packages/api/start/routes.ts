/*
|--------------------------------------------------------------------------
| Routes file
|--------------------------------------------------------------------------
|
| The routes file is used for defining the HTTP routes.
|
*/

import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
import { controllers } from '#generated/controllers'
import { deployment } from '#lib/deployment'
import { accountRequiredRoutes, hostedRoutes, previewEdgeRoutes } from '#start/routes/hosted'
import { localRoutes } from '#start/routes/local'

const ProviderCredentialsController = () => import('#controllers/provider_credentials_controller')
const ModelCatalogController = () => import('#controllers/model_catalog_controller')
const ProjectCodePracticesController = () =>
  import('#controllers/project_code_practices_controller')
const ProjectAgentMemoriesController = () =>
  import('#controllers/project_agent_memories_controller')
const ProjectCodePracticeAnalysesController = () =>
  import('#controllers/project_code_practice_analyses_controller')
const ProjectInitializationsController = () =>
  import('#controllers/project_initializations_controller')
const SecurityAuditsController = () => import('#controllers/security_audits_controller')
const QuickChatAgentRunsController = () => import('#controllers/quick_chat_agent_runs_controller')
const QuickChatMessagesController = () => import('#controllers/quick_chat_messages_controller')
const QuickChatsController = () => import('#controllers/quick_chats_controller')
const UserAiPreferencesController = () => import('#controllers/user_ai_preferences_controller')
const UserMcpConfigurationsController = () =>
  import('#controllers/user_mcp_configurations_controller')
const UserStoryAgentRunsController = () => import('#controllers/user_story_agent_runs_controller')
const UserStoryCommentsController = () => import('#controllers/user_story_comments_controller')
const FileAttachmentsController = () => import('#controllers/file_attachments_controller')

router.get('/', () => {
  return { hello: 'world' }
})

router
  .group(() => {
    if (deployment.hostedServices) hostedRoutes()
    else {
      accountRequiredRoutes()
      localRoutes()
    }

    router
      .group(() => {
        router.get('profile', [controllers.Profile, 'show'])
        router.get('ai-preferences', [UserAiPreferencesController, 'show'])
        router.put('ai-preferences', [UserAiPreferencesController, 'update'])
        router.get('mcp-configurations', [UserMcpConfigurationsController, 'show'])
        router.put('mcp-configurations', [UserMcpConfigurationsController, 'update'])
        router.post('logout', [controllers.AccessTokens, 'destroy'])
      })
      .prefix('account')
      .as('profile')
      .use(middleware.auth())

    router
      .group(() => {
        router.get('/', [controllers.Projects, 'index'])
        router.post('/', [controllers.Projects, 'store'])
        router.get('/:projectId/agent-memories', [ProjectAgentMemoriesController, 'index'])
        router.post('/:projectId/agent-memories', [ProjectAgentMemoriesController, 'store'])
        router.get('/:projectId/code-practices', [ProjectCodePracticesController, 'index'])
        router.patch('/:projectId/code-practices/:practice', [
          ProjectCodePracticesController,
          'update',
        ])
        router.get('/:projectId/code-practice-analysis', [
          ProjectCodePracticeAnalysesController,
          'show',
        ])
        router.post('/:projectId/code-practice-analysis/start', [
          ProjectCodePracticeAnalysesController,
          'start',
        ])
        router.post('/:projectId/code-practice-analysis/complete', [
          ProjectCodePracticeAnalysesController,
          'complete',
        ])
        router.post('/:projectId/code-practice-analysis/fail', [
          ProjectCodePracticeAnalysesController,
          'fail',
        ])
        router.post('/:projectId/code-practice-analysis/viewed', [
          ProjectCodePracticeAnalysesController,
          'viewed',
        ])
        router.get('/:projectId/security-audits', [SecurityAuditsController, 'index'])
        router.put('/:projectId/security-audits/:auditId', [SecurityAuditsController, 'update'])
        router.get('/:projectId/initialization', [ProjectInitializationsController, 'show'])
        router.post('/:projectId/initialization/start', [ProjectInitializationsController, 'start'])
        router.post('/:projectId/initialization/complete', [
          ProjectInitializationsController,
          'complete',
        ])
        router.post('/:projectId/initialization/fail', [ProjectInitializationsController, 'fail'])
        router.post('/:projectId/initialization/cancel', [
          ProjectInitializationsController,
          'cancel',
        ])
        router.post('/:projectId/initialization/repair', [
          ProjectInitializationsController,
          'repair',
        ])
        router.post('/:projectId/initialization/check', [ProjectInitializationsController, 'check'])
      })
      .prefix('projects')
      .as('projects')
      .use(middleware.auth())

    router
      .group(() => {
        router.get('catalog', [ModelCatalogController, 'show'])
        router.get('catalog/model', [ModelCatalogController, 'model'])
        router.get('credentials', [ProviderCredentialsController, 'index'])
        router.post('credentials', [ProviderCredentialsController, 'store'])
        router.post('credentials/oauth', [ProviderCredentialsController, 'storeOAuth'])
        router.post('credentials/local', [ProviderCredentialsController, 'storeLocal'])
        router.post('credentials/resolve', [ProviderCredentialsController, 'resolve'])
        router.delete('credentials/:id', [ProviderCredentialsController, 'destroy'])
      })
      .prefix('providers')
      .as('providers')
      .use(middleware.auth())

    router
      .group(() => {
        router
          .post('/uploads', [FileAttachmentsController, 'createUpload'])
          .use(middleware.premium({ feature: 'cloud_storage' }))
        router.post('/:id/complete', [FileAttachmentsController, 'complete'])
        router
          .post('/:id/content', [FileAttachmentsController, 'uploadContent'])
          .use(middleware.premium({ feature: 'cloud_storage' }))
        router.get('/:id', [FileAttachmentsController, 'show'])
      })
      .prefix('attachments')
      .as('attachments')
      .use(middleware.auth())

    router
      .group(() => {
        router.get('/', [QuickChatsController, 'index'])
        router.post('/', [QuickChatsController, 'store'])
        router.get('/:id', [QuickChatsController, 'show'])
        router.patch('/:id', [QuickChatsController, 'update'])
        router.delete('/:id', [QuickChatsController, 'destroy'])
        router.post('/:id/messages', [QuickChatMessagesController, 'store'])
        router.post('/:id/messages/:messageId/undo', [QuickChatMessagesController, 'undo'])
        router.post('/:id/messages/:messageId/undo-validation', [
          QuickChatMessagesController,
          'validateUndo',
        ])
        router.post('/:id/agent-runs', [QuickChatAgentRunsController, 'store'])
        router.patch('/:id/agent-runs/:runId', [QuickChatAgentRunsController, 'update'])
        router.post('/:id/agent-runs/:runId/finalize', [QuickChatAgentRunsController, 'finalize'])
        router.get('/:id/agent-runs/:runId/activities/:activityId', [
          QuickChatAgentRunsController,
          'activityDetail',
        ])
        router.put('/:id/agent-screenshots/:screenshotId', [
          QuickChatsController,
          'storeScreenshot',
        ])
        router.get('/:id/agent-screenshots/:screenshotId', [QuickChatsController, 'showScreenshot'])
      })
      .prefix('projects/quick-chats')
      .as('projects.quick_chats')
      .use(middleware.auth())

    router
      .group(() => {
        router.get('/', [controllers.UserStories, 'index'])
        router.post('/', [controllers.UserStories, 'store'])
        router.get('/:id', [controllers.UserStories, 'show'])
        router.patch('/:id', [controllers.UserStories, 'update'])
        router.delete('/:id', [controllers.UserStories, 'destroy'])
        router.get('/:id/agent-activities/:activityId', [controllers.UserStories, 'activityDetail'])
        router.put('/:id/agent-screenshots/:screenshotId', [
          controllers.UserStories,
          'storeScreenshot',
        ])
        router.get('/:id/agent-screenshots/:screenshotId', [
          controllers.UserStories,
          'showScreenshot',
        ])
        router.post('/:id/agent-runs', [UserStoryAgentRunsController, 'store'])
        router.patch('/:id/agent-runs/:runId', [UserStoryAgentRunsController, 'update'])
        router.post('/:id/agent-runs/:runId/finalize', [UserStoryAgentRunsController, 'finalize'])
        router.get('/:id/agent-runs/:runId/activities/:activityId', [
          UserStoryAgentRunsController,
          'activityDetail',
        ])
        router.post('/:id/comments', [UserStoryCommentsController, 'store'])
        router.post('/:id/comments/:commentId/undo', [UserStoryCommentsController, 'undo'])
        router.post('/:id/comments/:commentId/undo-validation', [
          UserStoryCommentsController,
          'validateUndo',
        ])
      })
      .prefix('projects/user-stories')
      .as('projects.user_stories')
      .use(middleware.auth())
  })
  .prefix('/api/v1')

if (deployment.hostedServices) previewEdgeRoutes()
