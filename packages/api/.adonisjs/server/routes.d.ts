import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'web_search.search': { paramsTuple?: []; params?: {} }
    'stripe_webhooks': { paramsTuple?: []; params?: {} }
    'account_privacy.status': { paramsTuple?: []; params?: {} }
    'consumer_contracts.withdraw': { paramsTuple?: []; params?: {} }
    'vercel_connections.callback': { paramsTuple?: []; params?: {} }
    'github_installations.callback': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.create_intent': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.index': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.projects': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'integrations.vercel.vercel_connections.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'integrations.github.github_installations.create_intent': { paramsTuple?: []; params?: {} }
    'integrations.github.github_installations.index': { paramsTuple?: []; params?: {} }
    'project_github.project_github.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_github.project_github.link_repository': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_github.project_github.unlink_repository': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_github.project_github.update_agent_access': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_github.project_github.agent_token': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'preview_sessions.preview_sessions.index': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.store': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.action': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_surfaces.action': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_import': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_export': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.logs': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.access_ticket': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.bridge_grant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.component_preview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'billing.billing.show': { paramsTuple?: []; params?: {} }
    'billing.billing.checkout': { paramsTuple?: []; params?: {} }
    'billing.billing.portal': { paramsTuple?: []; params?: {} }
    'desktop_auth.complete': { paramsTuple?: []; params?: {} }
    'desktop_auth.passkey': { paramsTuple?: []; params?: {} }
    'desktop_auth.reset_password': { paramsTuple?: []; params?: {} }
    'desktop_auth.verified': { paramsTuple?: []; params?: {} }
    'desktop_auth.exchange': { paramsTuple?: []; params?: {} }
    'desktop_auth.exchange_device_token': { paramsTuple?: []; params?: {} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'speech.speech_transcription.store': { paramsTuple?: []; params?: {} }
    'account_privacy.account_privacy.download': { paramsTuple?: []; params?: {} }
    'account_privacy.account_privacy.close': { paramsTuple?: []; params?: {} }
    'account_privacy.workspace_transfer.import': { paramsTuple?: []; params?: {} }
    'project_deployments.deploy_targets.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.deploy_targets.update': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.store': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.show': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'project_deployments.project_deployments.complete_source': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'project_deployments.project_deployments.logs': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'project_deployments.project_deployments.cancel': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.update': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.show': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.update': { paramsTuple?: []; params?: {} }
    'profile.access_tokens.destroy': { paramsTuple?: []; params?: {} }
    'projects.projects.index': { paramsTuple?: []; params?: {} }
    'projects.projects.store': { paramsTuple?: []; params?: {} }
    'projects.project_agent_memories.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_agent_memories.store': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practices.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practices.update': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'practice': ParamValue} }
    'projects.project_code_practice_analyses.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.start': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.complete': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.fail': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.viewed': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.security_audits.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.security_audits.update': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'auditId': ParamValue} }
    'projects.project_initializations.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.start': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.complete': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.fail': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.cancel': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.repair': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.check': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'providers.model_catalog.show': { paramsTuple?: []; params?: {} }
    'providers.model_catalog.model': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.index': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_o_auth': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_local': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.resolve': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.create_upload': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.complete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.upload_content': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.index': { paramsTuple?: []; params?: {} }
    'engine.engine_sessions.pull': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.push': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_blobs.show': { paramsTuple: [ParamValue]; params: {'sha256': ParamValue} }
    'engine.engine_blobs.store': { paramsTuple: [ParamValue]; params: {'sha256': ParamValue} }
    'projects.quick_chats.quick_chats.index': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.store': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.index': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.store': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.store_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_stories.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'preview_edge_internal.resolve': { paramsTuple?: []; params?: {} }
    'preview_edge_internal.consume_ticket': { paramsTuple?: []; params?: {} }
  }
  GET: {
    'vercel_connections.callback': { paramsTuple?: []; params?: {} }
    'github_installations.callback': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.index': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.projects': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'integrations.github.github_installations.index': { paramsTuple?: []; params?: {} }
    'project_github.project_github.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'preview_sessions.preview_sessions.index': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.logs': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'billing.billing.show': { paramsTuple?: []; params?: {} }
    'desktop_auth.complete': { paramsTuple?: []; params?: {} }
    'desktop_auth.passkey': { paramsTuple?: []; params?: {} }
    'desktop_auth.reset_password': { paramsTuple?: []; params?: {} }
    'desktop_auth.verified': { paramsTuple?: []; params?: {} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'project_deployments.deploy_targets.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.show': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'project_deployments.project_deployments.logs': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.show': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.show': { paramsTuple?: []; params?: {} }
    'projects.projects.index': { paramsTuple?: []; params?: {} }
    'projects.project_agent_memories.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practices.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.security_audits.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'providers.model_catalog.show': { paramsTuple?: []; params?: {} }
    'providers.model_catalog.model': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.index': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.index': { paramsTuple?: []; params?: {} }
    'engine.engine_sessions.pull': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_blobs.show': { paramsTuple: [ParamValue]; params: {'sha256': ParamValue} }
    'projects.quick_chats.quick_chats.index': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.index': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
  }
  HEAD: {
    'vercel_connections.callback': { paramsTuple?: []; params?: {} }
    'github_installations.callback': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.index': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.projects': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'integrations.github.github_installations.index': { paramsTuple?: []; params?: {} }
    'project_github.project_github.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'preview_sessions.preview_sessions.index': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.logs': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'billing.billing.show': { paramsTuple?: []; params?: {} }
    'desktop_auth.complete': { paramsTuple?: []; params?: {} }
    'desktop_auth.passkey': { paramsTuple?: []; params?: {} }
    'desktop_auth.reset_password': { paramsTuple?: []; params?: {} }
    'desktop_auth.verified': { paramsTuple?: []; params?: {} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'project_deployments.deploy_targets.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.show': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'project_deployments.project_deployments.logs': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.show': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.show': { paramsTuple?: []; params?: {} }
    'projects.projects.index': { paramsTuple?: []; params?: {} }
    'projects.project_agent_memories.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practices.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.security_audits.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'providers.model_catalog.show': { paramsTuple?: []; params?: {} }
    'providers.model_catalog.model': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.index': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.index': { paramsTuple?: []; params?: {} }
    'engine.engine_sessions.pull': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_blobs.show': { paramsTuple: [ParamValue]; params: {'sha256': ParamValue} }
    'projects.quick_chats.quick_chats.index': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.index': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
  }
  POST: {
    'web_search.search': { paramsTuple?: []; params?: {} }
    'stripe_webhooks': { paramsTuple?: []; params?: {} }
    'account_privacy.status': { paramsTuple?: []; params?: {} }
    'consumer_contracts.withdraw': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.create_intent': { paramsTuple?: []; params?: {} }
    'integrations.github.github_installations.create_intent': { paramsTuple?: []; params?: {} }
    'project_github.project_github.agent_token': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'preview_sessions.preview_sessions.store': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.action': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_surfaces.action': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_import': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_export': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.access_ticket': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.bridge_grant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.component_preview': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'billing.billing.checkout': { paramsTuple?: []; params?: {} }
    'billing.billing.portal': { paramsTuple?: []; params?: {} }
    'desktop_auth.exchange': { paramsTuple?: []; params?: {} }
    'desktop_auth.exchange_device_token': { paramsTuple?: []; params?: {} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'speech.speech_transcription.store': { paramsTuple?: []; params?: {} }
    'account_privacy.account_privacy.download': { paramsTuple?: []; params?: {} }
    'account_privacy.account_privacy.close': { paramsTuple?: []; params?: {} }
    'project_deployments.project_deployments.store': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_deployments.project_deployments.complete_source': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'project_deployments.project_deployments.cancel': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'profile.access_tokens.destroy': { paramsTuple?: []; params?: {} }
    'projects.projects.store': { paramsTuple?: []; params?: {} }
    'projects.project_agent_memories.store': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.start': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.complete': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.fail': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.viewed': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.start': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.complete': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.fail': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.cancel': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.repair': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.check': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'providers.provider_credentials.store': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_o_auth': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_local': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.resolve': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.create_upload': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.complete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.upload_content': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.push': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.store': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.store': { paramsTuple?: []; params?: {} }
    'preview_edge_internal.resolve': { paramsTuple?: []; params?: {} }
    'preview_edge_internal.consume_ticket': { paramsTuple?: []; params?: {} }
  }
  DELETE: {
    'integrations.vercel.vercel_connections.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'project_github.project_github.unlink_repository': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'providers.provider_credentials.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'engine.engine_sessions.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  PUT: {
    'project_github.project_github.link_repository': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'project_github.project_github.update_agent_access': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'account_privacy.workspace_transfer.import': { paramsTuple?: []; params?: {} }
    'project_deployments.deploy_targets.update': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'profile.user_ai_preferences.update': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.update': { paramsTuple?: []; params?: {} }
    'projects.security_audits.update': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'auditId': ParamValue} }
    'engine.engine_blobs.store': { paramsTuple: [ParamValue]; params: {'sha256': ParamValue} }
    'projects.user_stories.user_stories.store_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
  }
  OPTIONS: {
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
  }
  PATCH: {
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'projects.project_code_practices.update': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'practice': ParamValue} }
    'projects.quick_chats.quick_chats.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}