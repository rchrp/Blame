import ProviderCredential from '#models/provider_credential'
import UserMcpConfiguration from '#models/user_mcp_configuration'
import encryption from '@adonisjs/core/services/encryption'
import db from '@adonisjs/lucid/services/db'

export default class CredentialEncryptionRotationService {
  async verify() {
    const credentials = await ProviderCredential.all()
    for (const credential of credentials) {
      await this.decrypt(credential.encryptedApiKey, credential.id)
      if (credential.encryptedOauthCredentials) {
        await this.decrypt(credential.encryptedOauthCredentials, credential.id)
      }
    }
    // The synced MCP secrets share the key and must stay readable with it.
    for (const configuration of await UserMcpConfiguration.query().whereNotNull(
      'encryptedSecrets'
    )) {
      await this.decrypt(configuration.encryptedSecrets!, configuration.userId)
    }
    return credentials.length
  }

  rotate() {
    return db.transaction(async (transaction) => {
      const credentials = await ProviderCredential.query({ client: transaction }).forUpdate()
      for (const credential of credentials) {
        await this.rotateCredential(credential, transaction)
      }
      const configurations = await UserMcpConfiguration.query({ client: transaction })
        .whereNotNull('encryptedSecrets')
        .forUpdate()
      for (const configuration of configurations) {
        const secrets = await this.decrypt(configuration.encryptedSecrets!, configuration.userId)
        configuration.useTransaction(transaction)
        configuration.encryptedSecrets = await encryption.encrypt(secrets)
        await configuration.save()
      }
      return credentials.length
    })
  }

  private async rotateCredential(
    credential: ProviderCredential,
    transaction: Parameters<ProviderCredential['useTransaction']>[0]
  ) {
    const apiKey = await this.decrypt(credential.encryptedApiKey, credential.id)
    const oauthCredentials = credential.encryptedOauthCredentials
      ? await this.decrypt(credential.encryptedOauthCredentials, credential.id)
      : null
    credential.useTransaction(transaction)
    credential.encryptedApiKey = await encryption.encrypt(apiKey)
    credential.encryptedOauthCredentials = oauthCredentials
      ? await encryption.encrypt(oauthCredentials)
      : null
    await credential.save()
  }

  private async decrypt(value: string, credentialId: string) {
    const decrypted = await encryption.decrypt(value)
    if (typeof decrypted === 'string') return decrypted
    throw new Error(`Unable to decrypt provider credential ${credentialId}`)
  }
}
