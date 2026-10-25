import '@adonisjs/core/types/http'

type ParamValue = string | number | bigint | boolean

export type ScannedRoutes = {
  ALL: {
    'stripe_webhooks': { paramsTuple?: []; params?: {} }
    'account_privacy.status': { paramsTuple?: []; params?: {} }
    'consumer_contracts.withdraw': { paramsTuple?: []; params?: {} }
    'telemetry_ingestion.store': { paramsTuple: [ParamValue]; params: {'signal': ParamValue} }
    'telemetry_ingestion.health': { paramsTuple?: []; params?: {} }
    'vercel_connections.callback': { paramsTuple?: []; params?: {} }
    'telemetry_sessions.show': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.create_intent': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.index': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.projects': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'integrations.vercel.vercel_connections.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.index': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.store': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.action': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_import': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_export': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.logs': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.events': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.access_ticket': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.bridge_grant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
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
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.update': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.show': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.update': { paramsTuple?: []; params?: {} }
    'profile.account_privacy.download': { paramsTuple?: []; params?: {} }
    'profile.account_privacy.close': { paramsTuple?: []; params?: {} }
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
    'projects.project_initializations.repair': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.deploy_targets.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.deploy_targets.update': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.store': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.show': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'projects.project_deployments.complete_source': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'projects.project_deployments.logs': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'projects.project_deployments.cancel': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'providers.model_catalog.show': { paramsTuple?: []; params?: {} }
    'providers.model_catalog.model': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.index': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_o_auth': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_local': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.resolve': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'speech.speech_transcription.store': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.create_upload': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.complete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.upload_content': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.index': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.store': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_messages.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_messages.undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'messageId': ParamValue} }
    'projects.quick_chats.quick_chat_messages.validate_undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'messageId': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.update': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.finalize': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.activity_detail': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue,'activityId': ParamValue} }
    'projects.quick_chats.quick_chats.store_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.quick_chats.quick_chats.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_stories.index': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.store': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.activity_detail': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'activityId': ParamValue} }
    'projects.user_stories.user_stories.store_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_stories.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_story_agent_runs.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_story_agent_runs.update': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.user_stories.user_story_agent_runs.finalize': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.user_stories.user_story_agent_runs.activity_detail': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue,'activityId': ParamValue} }
    'projects.user_stories.user_story_comments.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_story_comments.undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'commentId': ParamValue} }
    'projects.user_stories.user_story_comments.validate_undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'commentId': ParamValue} }
    'preview_edge_internal.resolve': { paramsTuple?: []; params?: {} }
    'preview_edge_internal.consume_ticket': { paramsTuple?: []; params?: {} }
  }
  GET: {
    'telemetry_ingestion.health': { paramsTuple?: []; params?: {} }
    'vercel_connections.callback': { paramsTuple?: []; params?: {} }
    'telemetry_sessions.show': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.index': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.projects': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
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
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.show': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.show': { paramsTuple?: []; params?: {} }
    'projects.projects.index': { paramsTuple?: []; params?: {} }
    'projects.project_agent_memories.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practices.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.security_audits.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.deploy_targets.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.show': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'projects.project_deployments.logs': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'providers.model_catalog.show': { paramsTuple?: []; params?: {} }
    'providers.model_catalog.model': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.index': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.index': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.activity_detail': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue,'activityId': ParamValue} }
    'projects.quick_chats.quick_chats.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_stories.index': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.activity_detail': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'activityId': ParamValue} }
    'projects.user_stories.user_stories.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_story_agent_runs.activity_detail': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue,'activityId': ParamValue} }
  }
  HEAD: {
    'telemetry_ingestion.health': { paramsTuple?: []; params?: {} }
    'vercel_connections.callback': { paramsTuple?: []; params?: {} }
    'telemetry_sessions.show': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.index': { paramsTuple?: []; params?: {} }
    'integrations.vercel.vercel_connections.projects': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
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
    'profile.profile.show': { paramsTuple?: []; params?: {} }
    'profile.user_ai_preferences.show': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.show': { paramsTuple?: []; params?: {} }
    'projects.projects.index': { paramsTuple?: []; params?: {} }
    'projects.project_agent_memories.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practices.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_code_practice_analyses.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.security_audits.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_initializations.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.deploy_targets.show': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.index': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.show': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'projects.project_deployments.logs': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'providers.model_catalog.show': { paramsTuple?: []; params?: {} }
    'providers.model_catalog.model': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.index': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.index': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chats.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.activity_detail': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue,'activityId': ParamValue} }
    'projects.quick_chats.quick_chats.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_stories.index': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_stories.show': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.activity_detail': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'activityId': ParamValue} }
    'projects.user_stories.user_stories.show_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_story_agent_runs.activity_detail': { paramsTuple: [ParamValue,ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue,'activityId': ParamValue} }
  }
  POST: {
    'stripe_webhooks': { paramsTuple?: []; params?: {} }
    'account_privacy.status': { paramsTuple?: []; params?: {} }
    'consumer_contracts.withdraw': { paramsTuple?: []; params?: {} }
    'telemetry_ingestion.store': { paramsTuple: [ParamValue]; params: {'signal': ParamValue} }
    'integrations.vercel.vercel_connections.create_intent': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.store': { paramsTuple?: []; params?: {} }
    'preview_sessions.preview_sessions.action': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_import': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.source_export': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.access_ticket': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'preview_sessions.preview_sessions.bridge_grant': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'billing.billing.checkout': { paramsTuple?: []; params?: {} }
    'billing.billing.portal': { paramsTuple?: []; params?: {} }
    'desktop_auth.exchange': { paramsTuple?: []; params?: {} }
    'desktop_auth.exchange_device_token': { paramsTuple?: []; params?: {} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'profile.account_privacy.download': { paramsTuple?: []; params?: {} }
    'profile.account_privacy.close': { paramsTuple?: []; params?: {} }
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
    'projects.project_initializations.repair': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.store': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.project_deployments.complete_source': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'projects.project_deployments.cancel': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'id': ParamValue} }
    'providers.provider_credentials.store': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_o_auth': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.store_local': { paramsTuple?: []; params?: {} }
    'providers.provider_credentials.resolve': { paramsTuple?: []; params?: {} }
    'speech.speech_transcription.store': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.create_upload': { paramsTuple?: []; params?: {} }
    'attachments.file_attachments.complete': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'attachments.file_attachments.upload_content': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.store': { paramsTuple?: []; params?: {} }
    'projects.quick_chats.quick_chat_messages.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_messages.undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'messageId': ParamValue} }
    'projects.quick_chats.quick_chat_messages.validate_undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'messageId': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.finalize': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.user_stories.user_stories.store': { paramsTuple?: []; params?: {} }
    'projects.user_stories.user_story_agent_runs.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_story_agent_runs.finalize': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.user_stories.user_story_comments.store': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_story_comments.undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'commentId': ParamValue} }
    'projects.user_stories.user_story_comments.validate_undo': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'commentId': ParamValue} }
    'preview_edge_internal.resolve': { paramsTuple?: []; params?: {} }
    'preview_edge_internal.consume_ticket': { paramsTuple?: []; params?: {} }
  }
  DELETE: {
    'integrations.vercel.vercel_connections.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'providers.provider_credentials.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chats.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_stories.destroy': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
  }
  OPTIONS: {
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
  }
  PUT: {
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'profile.user_ai_preferences.update': { paramsTuple?: []; params?: {} }
    'profile.user_mcp_configurations.update': { paramsTuple?: []; params?: {} }
    'projects.security_audits.update': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'auditId': ParamValue} }
    'projects.deploy_targets.update': { paramsTuple: [ParamValue]; params: {'projectId': ParamValue} }
    'projects.quick_chats.quick_chats.store_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
    'projects.user_stories.user_stories.store_screenshot': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'screenshotId': ParamValue} }
  }
  PATCH: {
    'auth.better': { paramsTuple: [...ParamValue[]]; params: {'*': ParamValue[]} }
    'projects.project_code_practices.update': { paramsTuple: [ParamValue,ParamValue]; params: {'projectId': ParamValue,'practice': ParamValue} }
    'projects.quick_chats.quick_chats.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.quick_chats.quick_chat_agent_runs.update': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
    'projects.user_stories.user_stories.update': { paramsTuple: [ParamValue]; params: {'id': ParamValue} }
    'projects.user_stories.user_story_agent_runs.update': { paramsTuple: [ParamValue,ParamValue]; params: {'id': ParamValue,'runId': ParamValue} }
  }
}
declare module '@adonisjs/core/types/http' {
  export interface RoutesList extends ScannedRoutes {}
}