/* eslint-disable prettier/prettier */
import type { routes } from './index.ts'

export interface ApiDefinition {
  stripeWebhooks: typeof routes['stripe_webhooks']
  accountPrivacy: {
    status: typeof routes['account_privacy.status']
  }
  consumerContracts: {
    withdraw: typeof routes['consumer_contracts.withdraw']
  }
  telemetryIngestion: {
    store: typeof routes['telemetry_ingestion.store']
    health: typeof routes['telemetry_ingestion.health']
  }
  vercelConnections: {
    callback: typeof routes['vercel_connections.callback']
  }
  telemetrySessions: {
    show: typeof routes['telemetry_sessions.show']
  }
  integrations: {
    vercel: {
      vercelConnections: {
        createIntent: typeof routes['integrations.vercel.vercel_connections.create_intent']
        index: typeof routes['integrations.vercel.vercel_connections.index']
        projects: typeof routes['integrations.vercel.vercel_connections.projects']
        destroy: typeof routes['integrations.vercel.vercel_connections.destroy']
      }
    }
  }
  previewSessions: {
    previewSessions: {
      index: typeof routes['preview_sessions.preview_sessions.index']
      store: typeof routes['preview_sessions.preview_sessions.store']
      show: typeof routes['preview_sessions.preview_sessions.show']
      action: typeof routes['preview_sessions.preview_sessions.action']
      sourceImport: typeof routes['preview_sessions.preview_sessions.source_import']
      sourceExport: typeof routes['preview_sessions.preview_sessions.source_export']
      logs: typeof routes['preview_sessions.preview_sessions.logs']
      events: typeof routes['preview_sessions.preview_sessions.events']
      accessTicket: typeof routes['preview_sessions.preview_sessions.access_ticket']
      bridgeGrant: typeof routes['preview_sessions.preview_sessions.bridge_grant']
    }
  }
  billing: {
    billing: {
      show: typeof routes['billing.billing.show']
      checkout: typeof routes['billing.billing.checkout']
      portal: typeof routes['billing.billing.portal']
    }
  }
  desktopAuth: {
    complete: typeof routes['desktop_auth.complete']
    passkey: typeof routes['desktop_auth.passkey']
    resetPassword: typeof routes['desktop_auth.reset_password']
    verified: typeof routes['desktop_auth.verified']
    exchange: typeof routes['desktop_auth.exchange']
    exchangeDeviceToken: typeof routes['desktop_auth.exchange_device_token']
  }
  auth: {
    better: typeof routes['auth.better']
  }
  profile: {
    profile: {
      show: typeof routes['profile.profile.show']
    }
    userAiPreferences: {
      show: typeof routes['profile.user_ai_preferences.show']
      update: typeof routes['profile.user_ai_preferences.update']
    }
    userMcpConfigurations: {
      show: typeof routes['profile.user_mcp_configurations.show']
      update: typeof routes['profile.user_mcp_configurations.update']
    }
    accountPrivacy: {
      download: typeof routes['profile.account_privacy.download']
      close: typeof routes['profile.account_privacy.close']
    }
    accessTokens: {
      destroy: typeof routes['profile.access_tokens.destroy']
    }
  }
  projects: {
    projects: {
      index: typeof routes['projects.projects.index']
      store: typeof routes['projects.projects.store']
    }
    projectAgentMemories: {
      index: typeof routes['projects.project_agent_memories.index']
      store: typeof routes['projects.project_agent_memories.store']
    }
    projectCodePractices: {
      index: typeof routes['projects.project_code_practices.index']
      update: typeof routes['projects.project_code_practices.update']
    }
    projectCodePracticeAnalyses: {
      show: typeof routes['projects.project_code_practice_analyses.show']
      start: typeof routes['projects.project_code_practice_analyses.start']
      complete: typeof routes['projects.project_code_practice_analyses.complete']
      fail: typeof routes['projects.project_code_practice_analyses.fail']
      viewed: typeof routes['projects.project_code_practice_analyses.viewed']
    }
    securityAudits: {
      index: typeof routes['projects.security_audits.index']
      update: typeof routes['projects.security_audits.update']
    }
    projectInitializations: {
      show: typeof routes['projects.project_initializations.show']
      start: typeof routes['projects.project_initializations.start']
      complete: typeof routes['projects.project_initializations.complete']
      fail: typeof routes['projects.project_initializations.fail']
      repair: typeof routes['projects.project_initializations.repair']
    }
    deployTargets: {
      show: typeof routes['projects.deploy_targets.show']
      update: typeof routes['projects.deploy_targets.update']
    }
    projectDeployments: {
      index: typeof routes['projects.project_deployments.index']
      store: typeof routes['projects.project_deployments.store']
      show: typeof routes['projects.project_deployments.show']
      completeSource: typeof routes['projects.project_deployments.complete_source']
      logs: typeof routes['projects.project_deployments.logs']
      cancel: typeof routes['projects.project_deployments.cancel']
    }
    quickChats: {
      quickChats: {
        index: typeof routes['projects.quick_chats.quick_chats.index']
        store: typeof routes['projects.quick_chats.quick_chats.store']
        show: typeof routes['projects.quick_chats.quick_chats.show']
        update: typeof routes['projects.quick_chats.quick_chats.update']
        destroy: typeof routes['projects.quick_chats.quick_chats.destroy']
        storeScreenshot: typeof routes['projects.quick_chats.quick_chats.store_screenshot']
        showScreenshot: typeof routes['projects.quick_chats.quick_chats.show_screenshot']
      }
      quickChatMessages: {
        store: typeof routes['projects.quick_chats.quick_chat_messages.store']
        undo: typeof routes['projects.quick_chats.quick_chat_messages.undo']
        validateUndo: typeof routes['projects.quick_chats.quick_chat_messages.validate_undo']
      }
      quickChatAgentRuns: {
        store: typeof routes['projects.quick_chats.quick_chat_agent_runs.store']
        update: typeof routes['projects.quick_chats.quick_chat_agent_runs.update']
        finalize: typeof routes['projects.quick_chats.quick_chat_agent_runs.finalize']
        activityDetail: typeof routes['projects.quick_chats.quick_chat_agent_runs.activity_detail']
      }
    }
    userStories: {
      userStories: {
        index: typeof routes['projects.user_stories.user_stories.index']
        store: typeof routes['projects.user_stories.user_stories.store']
        show: typeof routes['projects.user_stories.user_stories.show']
        update: typeof routes['projects.user_stories.user_stories.update']
        destroy: typeof routes['projects.user_stories.user_stories.destroy']
        activityDetail: typeof routes['projects.user_stories.user_stories.activity_detail']
        storeScreenshot: typeof routes['projects.user_stories.user_stories.store_screenshot']
        showScreenshot: typeof routes['projects.user_stories.user_stories.show_screenshot']
      }
      userStoryAgentRuns: {
        store: typeof routes['projects.user_stories.user_story_agent_runs.store']
        update: typeof routes['projects.user_stories.user_story_agent_runs.update']
        finalize: typeof routes['projects.user_stories.user_story_agent_runs.finalize']
        activityDetail: typeof routes['projects.user_stories.user_story_agent_runs.activity_detail']
      }
      userStoryComments: {
        store: typeof routes['projects.user_stories.user_story_comments.store']
        undo: typeof routes['projects.user_stories.user_story_comments.undo']
        validateUndo: typeof routes['projects.user_stories.user_story_comments.validate_undo']
      }
    }
  }
  providers: {
    modelCatalog: {
      show: typeof routes['providers.model_catalog.show']
      model: typeof routes['providers.model_catalog.model']
    }
    providerCredentials: {
      index: typeof routes['providers.provider_credentials.index']
      store: typeof routes['providers.provider_credentials.store']
      storeOAuth: typeof routes['providers.provider_credentials.store_o_auth']
      storeLocal: typeof routes['providers.provider_credentials.store_local']
      resolve: typeof routes['providers.provider_credentials.resolve']
      destroy: typeof routes['providers.provider_credentials.destroy']
    }
  }
  speech: {
    speechTranscription: {
      store: typeof routes['speech.speech_transcription.store']
    }
  }
  attachments: {
    fileAttachments: {
      createUpload: typeof routes['attachments.file_attachments.create_upload']
      complete: typeof routes['attachments.file_attachments.complete']
      uploadContent: typeof routes['attachments.file_attachments.upload_content']
      show: typeof routes['attachments.file_attachments.show']
    }
  }
  previewEdgeInternal: {
    resolve: typeof routes['preview_edge_internal.resolve']
    consumeTicket: typeof routes['preview_edge_internal.consume_ticket']
  }
}
