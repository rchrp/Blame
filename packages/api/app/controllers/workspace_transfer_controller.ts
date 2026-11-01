import WorkspaceTransferService, {
  type WorkspaceBundle,
} from '#services/workspace_transfer_service'
import { importWorkspaceValidator } from '#validators/workspace_transfer'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Copies the workspace of the local API into an account: the app exports it
 * from the local API and imports it into the hosted API. The local copy stays
 * on the computer.
 */
export default class WorkspaceTransferController {
  async export({ auth, response }: HttpContext) {
    response.header('cache-control', 'private, no-store')
    return { data: await new WorkspaceTransferService().export(auth.getUserOrFail().id) }
  }

  async import({ auth, request }: HttpContext) {
    const bundle = (await request.validateUsing(importWorkspaceValidator)) as WorkspaceBundle
    return { data: await new WorkspaceTransferService().import(auth.getUserOrFail().id, bundle) }
  }
}
