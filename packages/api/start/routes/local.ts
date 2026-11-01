import { middleware } from '#start/kernel'
import router from '@adonisjs/core/services/router'
const WorkspaceTransferController = () => import('#controllers/workspace_transfer_controller')

/**
 * Routes only the local API registers, under /api/v1: handing its workspace
 * over to an account.
 */
export function localRoutes() {
  router
    .group(() => {
      router.get('workspace', [WorkspaceTransferController, 'export'])
      router.delete('workspace', [WorkspaceTransferController, 'clear'])
    })
    .prefix('account')
    .as('local_workspace')
    .use(middleware.auth())
}
