import type UserMcpConfiguration from '#models/user_mcp_configuration'
import UserMcpConfigurationsService from '#services/user_mcp_configurations_service'
import UserMcpConfigurationTransformer from '#transformers/user_mcp_configuration_transformer'
import { saveUserMcpConfigurationValidator } from '#validators/user_mcp_configuration'
import type { HttpContext } from '@adonisjs/core/http'

export default class UserMcpConfigurationsController {
  async show({ auth, response, serialize }: HttpContext) {
    // The answer holds the secrets the person chose to sync: never cached.
    response.header('Cache-Control', 'no-store')
    const configuration = await new UserMcpConfigurationsService().get(auth.getUserOrFail().id)
    if (!configuration) return { data: null }
    return serialize(await this.present(configuration))
  }

  async update({ auth, request, response, serialize }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    let configuration
    try {
      configuration = await new UserMcpConfigurationsService().save(
        auth.getUserOrFail().id,
        await request.validateUsing(saveUserMcpConfigurationValidator)
      )
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid ')) {
        return response.unprocessableEntity({ message: error.message })
      }
      if (error instanceof Error && error.message.startsWith('MCP ')) {
        return response.unprocessableEntity({ message: error.message })
      }
      throw error
    }
    return serialize(await this.present(configuration))
  }

  private async present(configuration: UserMcpConfiguration) {
    configuration.$extras.servers = await new UserMcpConfigurationsService().present(configuration)
    return UserMcpConfigurationTransformer.transform(configuration)
  }
}
