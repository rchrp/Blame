/* eslint-disable prettier/prettier */
/// <reference path="../manifest.d.ts" />

import type { ExtractBody, ExtractErrorResponse, ExtractQuery, ExtractQueryForGet, ExtractRawResponse, ExtractResponse } from '@tuyau/core/types'
import type { InferInput, SimpleError } from '@vinejs/vine/types'

export type ParamValue = string | number | bigint | boolean

export interface Registry {
  'web_search.search': {
    methods: ["POST"]
    pattern: '/api/v1/web/search'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/web_search').webSearchValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/web_search').webSearchValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/web_search_controller').default['search']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/web_search_controller').default['search']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/web_search_controller').default['search']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'stripe_webhooks': {
    methods: ["POST"]
    pattern: '/api/v1/webhooks/stripe'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/stripe_webhooks_controller').default['handle']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/stripe_webhooks_controller').default['handle']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/stripe_webhooks_controller').default['handle']>>>
    }
  }
  'account_privacy.status': {
    methods: ["POST"]
    pattern: '/api/v1/account/closure-status'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/account_privacy').accountClosureStatusValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/account_privacy').accountClosureStatusValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['status']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['status']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['status']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'consumer_contracts.withdraw': {
    methods: ["POST"]
    pattern: '/api/v1/consumer-contract/withdrawal'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/consumer_contract').withdrawalValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/consumer_contract').withdrawalValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/consumer_contracts_controller').default['withdraw']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/consumer_contracts_controller').default['withdraw']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/consumer_contracts_controller').default['withdraw']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'telemetry_ingestion.store': {
    methods: ["POST"]
    pattern: '/api/v1/telemetry/otlp/v1/:signal'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { signal: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/telemetry_ingestion_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/telemetry_ingestion_controller').default['store']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/telemetry_ingestion_controller').default['store']>>>
    }
  }
  'telemetry_ingestion.health': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/telemetry/upstream-health'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/telemetry_ingestion_controller').default['health']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/telemetry_ingestion_controller').default['health']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/telemetry_ingestion_controller').default['health']>>>
    }
  }
  'vercel_connections.callback': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/integrations/vercel/callback'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['callback']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['callback']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['callback']>>>
    }
  }
  'telemetry_sessions.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/telemetry/session'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/telemetry_sessions_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/telemetry_sessions_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/telemetry_sessions_controller').default['show']>>>
    }
  }
  'integrations.vercel.vercel_connections.create_intent': {
    methods: ["POST"]
    pattern: '/api/v1/integrations/vercel/connect-intents'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['createIntent']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['createIntent']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['createIntent']>>>
    }
  }
  'integrations.vercel.vercel_connections.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/integrations/vercel/connections'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['index']>>>
    }
  }
  'integrations.vercel.vercel_connections.projects': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/integrations/vercel/connections/:id/projects'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['projects']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['projects']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['projects']>>>
    }
  }
  'integrations.vercel.vercel_connections.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/integrations/vercel/connections/:id/link'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['destroy']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/vercel_connections_controller').default['destroy']>>>
    }
  }
  'preview_sessions.preview_sessions.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/preview-sessions'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['index']>>>
    }
  }
  'preview_sessions.preview_sessions.store': {
    methods: ["POST"]
    pattern: '/api/v1/preview-sessions'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['store']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['store']>>>
    }
  }
  'preview_sessions.preview_sessions.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/preview-sessions/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['show']>>>
    }
  }
  'preview_sessions.preview_sessions.action': {
    methods: ["POST"]
    pattern: '/api/v1/preview-sessions/:id/actions'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['action']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['action']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['action']>>>
    }
  }
  'preview_sessions.preview_sessions.source_import': {
    methods: ["POST"]
    pattern: '/api/v1/preview-sessions/:id/source/import'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['sourceImport']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['sourceImport']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['sourceImport']>>>
    }
  }
  'preview_sessions.preview_sessions.source_export': {
    methods: ["POST"]
    pattern: '/api/v1/preview-sessions/:id/source/export'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['sourceExport']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['sourceExport']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['sourceExport']>>>
    }
  }
  'preview_sessions.preview_sessions.logs': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/preview-sessions/:id/logs'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['logs']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['logs']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['logs']>>>
    }
  }
  'preview_sessions.preview_sessions.events': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/preview-sessions/:id/events'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['events']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['events']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['events']>>>
    }
  }
  'preview_sessions.preview_sessions.access_ticket': {
    methods: ["POST"]
    pattern: '/api/v1/preview-sessions/:id/access-ticket'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['accessTicket']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['accessTicket']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['accessTicket']>>>
    }
  }
  'preview_sessions.preview_sessions.bridge_grant': {
    methods: ["POST"]
    pattern: '/api/v1/preview-sessions/:id/bridge-grant'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['bridgeGrant']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['bridgeGrant']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_sessions_controller').default['bridgeGrant']>>>
    }
  }
  'billing.billing.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/billing'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['show']>>>
    }
  }
  'billing.billing.checkout': {
    methods: ["POST"]
    pattern: '/api/v1/billing/checkout'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['checkout']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['checkout']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['checkout']>>>
    }
  }
  'billing.billing.portal': {
    methods: ["POST"]
    pattern: '/api/v1/billing/portal'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['portal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['portal']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/billing_controller').default['portal']>>>
    }
  }
  'desktop_auth.complete': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/auth/desktop-complete'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['complete']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['complete']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['complete']>>>
    }
  }
  'desktop_auth.passkey': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/auth/desktop'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['passkey']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['passkey']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['passkey']>>>
    }
  }
  'desktop_auth.reset_password': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/auth/reset-password-page'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['resetPassword']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['resetPassword']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['resetPassword']>>>
    }
  }
  'desktop_auth.verified': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/auth/verified'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['verified']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['verified']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['verified']>>>
    }
  }
  'desktop_auth.exchange': {
    methods: ["POST"]
    pattern: '/api/v1/auth/desktop-exchange'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['exchange']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['exchange']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['exchange']>>>
    }
  }
  'desktop_auth.exchange_device_token': {
    methods: ["POST"]
    pattern: '/api/v1/auth/desktop-device-exchange'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['exchangeDeviceToken']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['exchangeDeviceToken']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/desktop_auth_controller').default['exchangeDeviceToken']>>>
    }
  }
  'auth.better': {
    methods: ["HEAD","OPTIONS","GET","POST","PUT","PATCH","DELETE"]
    pattern: '/api/v1/auth/*'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { '*': ParamValue[] }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/better_auth_controller').default['handle']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/better_auth_controller').default['handle']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/better_auth_controller').default['handle']>>>
    }
  }
  'profile.profile.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/account/profile'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/profile_controller').default['show']>>>
    }
  }
  'profile.user_ai_preferences.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/account/ai-preferences'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_ai_preferences_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_ai_preferences_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_ai_preferences_controller').default['show']>>>
    }
  }
  'profile.user_ai_preferences.update': {
    methods: ["PUT"]
    pattern: '/api/v1/account/ai-preferences'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_ai_preference').saveUserAiPreferenceValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user_ai_preference').saveUserAiPreferenceValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_ai_preferences_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_ai_preferences_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_ai_preferences_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'profile.user_mcp_configurations.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/account/mcp-configurations'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_mcp_configurations_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_mcp_configurations_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_mcp_configurations_controller').default['show']>>>
    }
  }
  'profile.user_mcp_configurations.update': {
    methods: ["PUT"]
    pattern: '/api/v1/account/mcp-configurations'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_mcp_configuration').saveUserMcpConfigurationValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user_mcp_configuration').saveUserMcpConfigurationValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_mcp_configurations_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_mcp_configurations_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_mcp_configurations_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'profile.account_privacy.download': {
    methods: ["POST"]
    pattern: '/api/v1/account/export'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/account_privacy').accountExportValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/account_privacy').accountExportValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['download']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['download']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['download']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'profile.account_privacy.close': {
    methods: ["POST"]
    pattern: '/api/v1/account/closure'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/account_privacy').accountClosureValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/account_privacy').accountClosureValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['close']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['close']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/account_privacy_controller').default['close']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'profile.access_tokens.destroy': {
    methods: ["POST"]
    pattern: '/api/v1/account/logout'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['destroy']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/access_tokens_controller').default['destroy']>>>
    }
  }
  'projects.projects.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/projects_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/projects_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/projects_controller').default['index']>>>
    }
  }
  'projects.projects.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project').ensureProjectValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/project').ensureProjectValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/projects_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/projects_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/projects_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_agent_memories.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/agent-memories'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_agent_memories_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_agent_memories_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_agent_memories_controller').default['index']>>>
    }
  }
  'projects.project_agent_memories.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/agent-memories'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_agent_memory').storeProjectAgentMemoryValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_agent_memory').storeProjectAgentMemoryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_agent_memories_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_agent_memories_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_agent_memories_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_code_practices.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/code-practices'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practices_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practices_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practices_controller').default['index']>>>
    }
  }
  'projects.project_code_practices.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/projects/:projectId/code-practices/:practice'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_code_practice').updateProjectCodePracticeValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { projectId: ParamValue; practice: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_code_practice').updateProjectCodePracticeValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practices_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practices_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practices_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_code_practice_analyses.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/code-practice-analysis'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['show']>>>
    }
  }
  'projects.project_code_practice_analyses.start': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/code-practice-analysis/start'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_code_practice_analysis').startProjectCodePracticeAnalysisValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_code_practice_analysis').startProjectCodePracticeAnalysisValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['start']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['start']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['start']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_code_practice_analyses.complete': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/code-practice-analysis/complete'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_code_practice_analysis').completeProjectCodePracticeAnalysisValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_code_practice_analysis').completeProjectCodePracticeAnalysisValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['complete']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['complete']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['complete']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_code_practice_analyses.fail': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/code-practice-analysis/fail'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_code_practice_analysis').failProjectCodePracticeAnalysisValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_code_practice_analysis').failProjectCodePracticeAnalysisValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['fail']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['fail']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['fail']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_code_practice_analyses.viewed': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/code-practice-analysis/viewed'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['viewed']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['viewed']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_code_practice_analyses_controller').default['viewed']>>>
    }
  }
  'projects.security_audits.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/security-audits'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/security_audits_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/security_audits_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/security_audits_controller').default['index']>>>
    }
  }
  'projects.security_audits.update': {
    methods: ["PUT"]
    pattern: '/api/v1/projects/:projectId/security-audits/:auditId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/security_audit').saveSecurityAuditValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { projectId: ParamValue; auditId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/security_audit').saveSecurityAuditValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/security_audits_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/security_audits_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/security_audits_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_initializations.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/initialization'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['show']>>>
    }
  }
  'projects.project_initializations.start': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/initialization/start'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_initialization').startProjectInitializationValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_initialization').startProjectInitializationValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['start']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['start']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['start']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_initializations.complete': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/initialization/complete'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_initialization').completeProjectInitializationValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_initialization').completeProjectInitializationValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['complete']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['complete']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['complete']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_initializations.fail': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/initialization/fail'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_initialization').failProjectInitializationValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_initialization').failProjectInitializationValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['fail']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['fail']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['fail']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_initializations.repair': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/initialization/repair'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/project_initialization').repairProjectInitializationValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/project_initialization').repairProjectInitializationValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['repair']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['repair']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_initializations_controller').default['repair']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.deploy_targets.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/deploy-target'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/deploy_targets_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/deploy_targets_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/deploy_targets_controller').default['show']>>>
    }
  }
  'projects.deploy_targets.update': {
    methods: ["PUT"]
    pattern: '/api/v1/projects/:projectId/deploy-target'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/deployment').updateDeployTargetValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/deployment').updateDeployTargetValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/deploy_targets_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/deploy_targets_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/deploy_targets_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_deployments.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/deployments'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['index']>>>
    }
  }
  'projects.project_deployments.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/deployments'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/deployment').createDeploymentValidator)>>
      paramsTuple: [ParamValue]
      params: { projectId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/deployment').createDeploymentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_deployments.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/deployments/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { projectId: ParamValue; id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['show']>>>
    }
  }
  'projects.project_deployments.complete_source': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/deployments/:id/source/complete'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/deployment').completeDeploymentSourceValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { projectId: ParamValue; id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/deployment').completeDeploymentSourceValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['completeSource']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['completeSource']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['completeSource']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.project_deployments.logs': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/:projectId/deployments/:id/logs'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { projectId: ParamValue; id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['logs']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['logs']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['logs']>>>
    }
  }
  'projects.project_deployments.cancel': {
    methods: ["POST"]
    pattern: '/api/v1/projects/:projectId/deployments/:id/cancel'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { projectId: ParamValue; id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['cancel']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['cancel']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/project_deployments_controller').default['cancel']>>>
    }
  }
  'providers.model_catalog.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/providers/catalog'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/model_catalog_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/model_catalog_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/model_catalog_controller').default['show']>>>
    }
  }
  'providers.model_catalog.model': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/providers/catalog/model'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/model_catalog_controller').default['model']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/model_catalog_controller').default['model']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/model_catalog_controller').default['model']>>>
    }
  }
  'providers.provider_credentials.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/providers/credentials'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['index']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['index']>>>
    }
  }
  'providers.provider_credentials.store': {
    methods: ["POST"]
    pattern: '/api/v1/providers/credentials'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/provider_credential').saveProviderCredentialValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/provider_credential').saveProviderCredentialValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'providers.provider_credentials.store_o_auth': {
    methods: ["POST"]
    pattern: '/api/v1/providers/credentials/oauth'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['storeOAuth']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['storeOAuth']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['storeOAuth']>>>
    }
  }
  'providers.provider_credentials.store_local': {
    methods: ["POST"]
    pattern: '/api/v1/providers/credentials/local'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/provider_credential').saveLocalProviderCredentialValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/provider_credential').saveLocalProviderCredentialValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['storeLocal']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['storeLocal']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['storeLocal']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'providers.provider_credentials.resolve': {
    methods: ["POST"]
    pattern: '/api/v1/providers/credentials/resolve'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/provider_credential').resolveProviderCredentialValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/provider_credential').resolveProviderCredentialValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['resolve']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'providers.provider_credentials.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/providers/credentials/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['destroy']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/provider_credentials_controller').default['destroy']>>>
    }
  }
  'speech.speech_transcription.store': {
    methods: ["POST"]
    pattern: '/api/v1/speech/transcriptions'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/speech_transcription').transcribeSpeechValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/speech_transcription').transcribeSpeechValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/speech_transcription_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/speech_transcription_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/speech_transcription_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'attachments.file_attachments.create_upload': {
    methods: ["POST"]
    pattern: '/api/v1/attachments/uploads'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/file_attachment').createFileAttachmentUploadValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/file_attachment').createFileAttachmentUploadValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['createUpload']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['createUpload']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['createUpload']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'attachments.file_attachments.complete': {
    methods: ["POST"]
    pattern: '/api/v1/attachments/:id/complete'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['complete']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['complete']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['complete']>>>
    }
  }
  'attachments.file_attachments.upload_content': {
    methods: ["POST"]
    pattern: '/api/v1/attachments/:id/content'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/file_attachment').uploadFileAttachmentContentValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/file_attachment').uploadFileAttachmentContentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['uploadContent']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['uploadContent']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['uploadContent']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'attachments.file_attachments.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/attachments/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/file_attachments_controller').default['show']>>>
    }
  }
  'projects.quick_chats.quick_chats.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/quick-chats'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/quick_chat').listQuickChatsValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chats.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/quick-chats'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat').createQuickChatValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat').createQuickChatValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chats.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/quick-chats/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['show']>>>
    }
  }
  'projects.quick_chats.quick_chats.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/projects/quick-chats/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat').updateQuickChatValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat').updateQuickChatValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chats.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/projects/quick-chats/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['destroy']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['destroy']>>>
    }
  }
  'projects.quick_chats.quick_chat_messages.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/quick-chats/:id/messages'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat').createQuickChatMessageValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat').createQuickChatMessageValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chat_messages.undo': {
    methods: ["POST"]
    pattern: '/api/v1/projects/quick-chats/:id/messages/:messageId/undo'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat').undoQuickChatMessageValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; messageId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat').undoQuickChatMessageValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['undo']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['undo']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['undo']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chat_messages.validate_undo': {
    methods: ["POST"]
    pattern: '/api/v1/projects/quick-chats/:id/messages/:messageId/undo-validation'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat').undoQuickChatMessageValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; messageId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat').undoQuickChatMessageValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['validateUndo']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['validateUndo']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_messages_controller').default['validateUndo']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chat_agent_runs.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/quick-chats/:id/agent-runs'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat_agent_run').createQuickChatAgentRunValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat_agent_run').createQuickChatAgentRunValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chat_agent_runs.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/projects/quick-chats/:id/agent-runs/:runId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat_agent_run').updateQuickChatAgentRunValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; runId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat_agent_run').updateQuickChatAgentRunValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chat_agent_runs.finalize': {
    methods: ["POST"]
    pattern: '/api/v1/projects/quick-chats/:id/agent-runs/:runId/finalize'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/quick_chat_agent_run').finalizeQuickChatAgentRunValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; runId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/quick_chat_agent_run').finalizeQuickChatAgentRunValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['finalize']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['finalize']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['finalize']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chat_agent_runs.activity_detail': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/quick-chats/:id/agent-runs/:runId/activities/:activityId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue, ParamValue]
      params: { id: ParamValue; runId: ParamValue; activityId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['activityDetail']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['activityDetail']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chat_agent_runs_controller').default['activityDetail']>>>
    }
  }
  'projects.quick_chats.quick_chats.store_screenshot': {
    methods: ["PUT"]
    pattern: '/api/v1/projects/quick-chats/:id/agent-screenshots/:screenshotId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story').agentScreenshotUploadValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; screenshotId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story').agentScreenshotUploadValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['storeScreenshot']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['storeScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['storeScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.quick_chats.quick_chats.show_screenshot': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/quick-chats/:id/agent-screenshots/:screenshotId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; screenshotId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/user_story').agentScreenshotQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['showScreenshot']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['showScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/quick_chats_controller').default['showScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_stories.index': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/user-stories'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/user_story').listUserStoriesValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['index']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['index']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_stories.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/user-stories'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story').createUserStoryValidator)>>
      paramsTuple: []
      params: {}
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story').createUserStoryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_stories.show': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/user-stories/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['show']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['show']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['show']>>>
    }
  }
  'projects.user_stories.user_stories.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/projects/user-stories/:id'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story').updateUserStoryValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story').updateUserStoryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_stories.destroy': {
    methods: ["DELETE"]
    pattern: '/api/v1/projects/user-stories/:id'
    types: {
      body: {}
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['destroy']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['destroy']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['destroy']>>>
    }
  }
  'projects.user_stories.user_stories.activity_detail': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/user-stories/:id/agent-activities/:activityId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; activityId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['activityDetail']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['activityDetail']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['activityDetail']>>>
    }
  }
  'projects.user_stories.user_stories.store_screenshot': {
    methods: ["PUT"]
    pattern: '/api/v1/projects/user-stories/:id/agent-screenshots/:screenshotId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story').agentScreenshotUploadValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; screenshotId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story').agentScreenshotUploadValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['storeScreenshot']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['storeScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['storeScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_stories.show_screenshot': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/user-stories/:id/agent-screenshots/:screenshotId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; screenshotId: ParamValue }
      query: ExtractQueryForGet<InferInput<(typeof import('#validators/user_story').agentScreenshotQueryValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['showScreenshot']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['showScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_stories_controller').default['showScreenshot']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_story_agent_runs.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/user-stories/:id/agent-runs'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story_agent_run').createUserStoryAgentRunValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story_agent_run').createUserStoryAgentRunValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_story_agent_runs.update': {
    methods: ["PATCH"]
    pattern: '/api/v1/projects/user-stories/:id/agent-runs/:runId'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story_agent_run').updateUserStoryAgentRunValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; runId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story_agent_run').updateUserStoryAgentRunValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['update']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['update']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_story_agent_runs.finalize': {
    methods: ["POST"]
    pattern: '/api/v1/projects/user-stories/:id/agent-runs/:runId/finalize'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story_agent_run').finalizeUserStoryAgentRunValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; runId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story_agent_run').finalizeUserStoryAgentRunValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['finalize']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['finalize']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['finalize']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_story_agent_runs.activity_detail': {
    methods: ["GET","HEAD"]
    pattern: '/api/v1/projects/user-stories/:id/agent-runs/:runId/activities/:activityId'
    types: {
      body: {}
      paramsTuple: [ParamValue, ParamValue, ParamValue]
      params: { id: ParamValue; runId: ParamValue; activityId: ParamValue }
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['activityDetail']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['activityDetail']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_agent_runs_controller').default['activityDetail']>>>
    }
  }
  'projects.user_stories.user_story_comments.store': {
    methods: ["POST"]
    pattern: '/api/v1/projects/user-stories/:id/comments'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story_comment').createUserStoryCommentValidator)>>
      paramsTuple: [ParamValue]
      params: { id: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story_comment').createUserStoryCommentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['store']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['store']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_story_comments.undo': {
    methods: ["POST"]
    pattern: '/api/v1/projects/user-stories/:id/comments/:commentId/undo'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story_comment').undoUserStoryCommentValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; commentId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story_comment').undoUserStoryCommentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['undo']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['undo']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['undo']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'projects.user_stories.user_story_comments.validate_undo': {
    methods: ["POST"]
    pattern: '/api/v1/projects/user-stories/:id/comments/:commentId/undo-validation'
    types: {
      body: ExtractBody<InferInput<(typeof import('#validators/user_story_comment').undoUserStoryCommentValidator)>>
      paramsTuple: [ParamValue, ParamValue]
      params: { id: ParamValue; commentId: ParamValue }
      query: ExtractQuery<InferInput<(typeof import('#validators/user_story_comment').undoUserStoryCommentValidator)>>
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['validateUndo']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['validateUndo']>>> | { status: 422; response: { errors: SimpleError[] } }
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/user_story_comments_controller').default['validateUndo']>>> | { status: 422; response: { errors: SimpleError[] } }
    }
  }
  'preview_edge_internal.resolve': {
    methods: ["POST"]
    pattern: '/internal/preview-edge/resolve'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_edge_internal_controller').default['resolve']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_edge_internal_controller').default['resolve']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_edge_internal_controller').default['resolve']>>>
    }
  }
  'preview_edge_internal.consume_ticket': {
    methods: ["POST"]
    pattern: '/internal/preview-edge/consume-ticket'
    types: {
      body: {}
      paramsTuple: []
      params: {}
      query: {}
      response: ExtractResponse<Awaited<ReturnType<import('#controllers/preview_edge_internal_controller').default['consumeTicket']>>>
      errorResponse: ExtractErrorResponse<Awaited<ReturnType<import('#controllers/preview_edge_internal_controller').default['consumeTicket']>>>
      rawResponse: ExtractRawResponse<Awaited<ReturnType<import('#controllers/preview_edge_internal_controller').default['consumeTicket']>>>
    }
  }
}
