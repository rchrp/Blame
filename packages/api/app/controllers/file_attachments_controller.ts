import FileAttachmentsService from '#services/file_attachments_service'
import {
  createFileAttachmentUploadValidator,
  uploadFileAttachmentContentValidator,
} from '#validators/file_attachment'
import type { HttpContext } from '@adonisjs/core/http'

export default class FileAttachmentsController {
  async createUpload({ auth, request }: HttpContext) {
    const input = await request.validateUsing(createFileAttachmentUploadValidator)
    return new FileAttachmentsService().createUpload(auth.getUserOrFail().id, input)
  }

  complete({ auth, params }: HttpContext) {
    return new FileAttachmentsService().completeUpload(auth.getUserOrFail().id, params.id)
  }

  async uploadContent({ auth, params, request }: HttpContext) {
    const { content } = await request.validateUsing(uploadFileAttachmentContentValidator)
    return new FileAttachmentsService().uploadContent(
      auth.getUserOrFail().id,
      params.id,
      content ?? ''
    )
  }

  show({ auth, params }: HttpContext) {
    return new FileAttachmentsService().deliverForUser(auth.getUserOrFail().id, params.id)
  }
}
