import WorkspaceTransferService, {
  type WorkspaceBundle,
} from '#services/workspace_transfer_service'
import { importWorkspaceValidator } from '#validators/workspace_transfer'
import type { HttpContext } from '@adonisjs/core/http'

/**
 * Moves the workspace of the local API into an account: the app exports it
 * from the local API, imports it into the hosted API, then clears it locally.
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

  async clear({ auth, response }: HttpContext) {
    await new WorkspaceTransferService().clear(auth.getUserOrFail().id)
    return response.noContent()
  }
}
