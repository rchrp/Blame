import type { QueryClientContract } from '@adonisjs/lucid/types/database'

const accountColumns = ['id', 'full_name', 'email', 'created_at', 'updated_at']
const accessTokenColumns = [
  'id',
  'name',
  'type',
  'abilities',
  'last_used_at',
  'expires_at',
  'created_at',
  'updated_at',
]
const projectColumns = [
  'id',
  'user_id',
  'repository_fingerprint',
  'name',
  'created_at',
  'updated_at',
]
const projectInitializationColumns = [
  'project_id',
  'status',
  'step',
  'cline_session_id',
  'agent_provider_id',
  'agent_model_id',
  'preview_manifest',
  'run_configurations',
  'database_mode',
  'error',
  'repair_reason',
  'created_at',
  'updated_at',
]
const projectCodePracticeColumns = [
  'id',
  'project_id',
  'practice',
  'detected',
  'enabled',
  'comment',
  'created_at',
  'updated_at',
]
const projectCodePracticeAnalysisColumns = [
  'project_id',
  'status',
  'cline_session_id',
  'agent_provider_id',
  'agent_model_id',
  'error',
  'viewed_at',
  'created_at',
  'updated_at',
]
const projectAgentMemoryColumns = [
  'id',
  'project_id',
  'fingerprint',
  'objective',
  'summary',
  'files',
  'symbols',
  'source_revision_id',
  'story_id',
  'validation_kind',
  'validation_task_id',
  'created_at',
]
const securityAuditColumns = [
  'id',
  'project_id',
  'status',
  'sequence',
  'payload',
  'started_at',
  'created_at',
  'updated_at',
]
const userStoryColumns = [
  'id',
  'project_id',
  'story_number',
  'title',
  'summary',
  'code_selection_attachments',
  'file_attachments',
  'status',
  'priority',
  'owner',
  'branch',
  'preview_url',
  'worktree',
  'workspace_mode',
  'run_mode',
  'agent_status',
  'cline_session_id',
  'agent_provider_id',
  'agent_model_id',
  'agent_last_event',
  'agent_last_error',
  'agent_activities',
  'agent_final_response',
  'agent_usage',
  'agent_session_summary',
  'merged_at',
  'merge_commit',
  'base_commit',
  'discarded_reason',
  'created_at',
  'updated_at',
]
const messageColumns = [
  'id',
  'body',
  'code_selection_attachments',
  'file_attachments',
  'author',
  'created_at',
  'updated_at',
]
const agentRunColumns = [
  'id',
  'kind',
  'cline_session_id',
  'checkpoint_run_count',
  'diff_end_ref',
  'status',
  'activities',
  'final_response',
  'usage',
  'session_summary',
  'completed_at',
  'created_at',
  'updated_at',
]
const agentRunActivityColumns = [
  'id',
  'run_id',
  'activity_id',
  'activity',
  'created_at',
  'updated_at',
]
const quickChatColumns = [
  'id',
  'project_id',
  'title',
  'workspace',
  'agent_status',
  'cline_session_id',
  'agent_provider_id',
  'agent_model_id',
  'agent_last_event',
  'agent_last_error',
  'agent_activities',
  'agent_final_response',
  'agent_usage',
  'agent_session_summary',
  'created_at',
  'updated_at',
]
const providerConnectionColumns = [
  'id',
  'user_id',
  'provider_id',
  'label',
  'auth_method',
  'account_id',
  'base_url',
  'model_ids',
  'expires_at',
  'created_at',
  'updated_at',
]
const aiPreferenceColumns = [
  'user_id',
  'alternative_provider_id',
  'alternative_model_id',
  'alternative_credential_label',
  'alternative_reasoning_effort',
  'agent_provider_id',
  'agent_model_id',
  'agent_credential_label',
  'agent_reasoning_effort',
  'created_at',
  'updated_at',
]
const subscriptionColumns = [
  'user_id',
  'stripe_customer_id',
  'stripe_subscription_id',
  'stripe_price_id',
  'stripe_checkout_session_id',
  'status',
  'current_period_end',
  'cancel_at_period_end',
  'created_at',
  'updated_at',
]
const fileAttachmentColumns = [
  'id',
  'object_key',
  'name',
  'mime_type',
  'size',
  'checksum_sha256',
  'created_at',
  'updated_at',
]

export default class AccountExportQueries {
  constructor(private client: QueryClientContract) {}

  account(userId: string) {
    return this.client.from('users').select(accountColumns).where('id', userId).firstOrFail()
  }

  accessTokens(userId: string) {
    return this.client
      .from('auth_access_tokens')
      .select(accessTokenColumns)
      .where('tokenable_id', userId)
      .orderBy('created_at', 'asc')
  }

  authSessions(userId: string) {
    return this.client
      .from('auth_sessions')
      .select(['id', 'ip_address', 'user_agent', 'expires_at', 'created_at', 'updated_at'])
      .where('user_id', userId)
      .orderBy('created_at', 'asc')
  }

  authAccounts(userId: string) {
    return this.client
      .from('auth_accounts')
      .select(['id', 'provider_id', 'account_id', 'created_at', 'updated_at'])
      .where('user_id', userId)
      .orderBy('created_at', 'asc')
  }

  passkeys(userId: string) {
    return this.client
      .from('passkey')
      .select(['id', 'name', 'deviceType', 'backedUp', 'transports', 'createdAt', 'aaguid'])
      .where('userId', userId)
      .orderBy('createdAt', 'asc')
  }

  projects(userId: string) {
    return this.client
      .from('projects')
      .select(projectColumns)
      .where('user_id', userId)
      .orderBy('created_at', 'asc')
  }

  projectInitializations(projectIds: string[]) {
    return this.ownedRows(
      'project_initializations',
      projectInitializationColumns,
      'project_id',
      projectIds
    )
  }

  projectCodePractices(projectIds: string[]) {
    return this.ownedRows(
      'project_code_practices',
      projectCodePracticeColumns,
      'project_id',
      projectIds
    )
  }

  projectCodePracticeAnalyses(projectIds: string[]) {
    return this.ownedRows(
      'project_code_practice_analyses',
      projectCodePracticeAnalysisColumns,
      'project_id',
      projectIds
    )
  }

  projectAgentMemories(projectIds: string[]) {
    return this.ownedRows(
      'project_agent_memories',
      projectAgentMemoryColumns,
      'project_id',
      projectIds
    )
  }

  securityAudits(projectIds: string[]) {
    return this.ownedRows('security_audits', securityAuditColumns, 'project_id', projectIds)
  }

  userStories(projectIds: string[]) {
    return this.ownedRows('user_stories', userStoryColumns, 'project_id', projectIds)
  }

  userStoryComments(storyIds: string[]) {
    return this.ownedRows(
      'user_story_comments',
      ['user_story_id', ...messageColumns],
      'user_story_id',
      storyIds
    )
  }

  userStoryAgentRuns(storyIds: string[]) {
    return this.ownedRows(
      'user_story_agent_runs',
      ['user_story_id', 'comment_id', ...agentRunColumns],
      'user_story_id',
      storyIds
    )
  }

  userStoryAgentRunActivities(runIds: string[]) {
    return this.ownedRows(
      'user_story_agent_run_activities',
      agentRunActivityColumns,
      'run_id',
      runIds
    )
  }

  quickChats(projectIds: string[]) {
    return this.ownedRows('quick_chats', quickChatColumns, 'project_id', projectIds)
  }

  quickChatMessages(chatIds: string[]) {
    return this.ownedRows(
      'quick_chat_messages',
      ['quick_chat_id', ...messageColumns],
      'quick_chat_id',
      chatIds
    )
  }

  quickChatAgentRuns(chatIds: string[]) {
    return this.ownedRows(
      'quick_chat_agent_runs',
      ['quick_chat_id', 'message_id', ...agentRunColumns],
      'quick_chat_id',
      chatIds
    )
  }

  quickChatAgentRunActivities(runIds: string[]) {
    return this.ownedRows(
      'quick_chat_agent_run_activities',
      agentRunActivityColumns,
      'run_id',
      runIds
    )
  }

  providerConnections(userId: string) {
    return this.client
      .from('provider_credentials')
      .select(providerConnectionColumns)
      .where('user_id', userId)
      .orderBy('created_at', 'asc')
  }

  aiPreferences(userId: string) {
    return this.client
      .from('user_ai_preferences')
      .select(aiPreferenceColumns)
      .where('user_id', userId)
      .first()
  }

  mcpConfiguration(userId: string) {
    return this.client
      .from('user_mcp_configurations')
      .select(['user_id', 'servers', 'created_at', 'updated_at'])
      .where('user_id', userId)
      .first()
  }

  subscription(userId: string) {
    return this.client
      .from('user_subscriptions')
      .select(subscriptionColumns)
      .where('user_id', userId)
      .first()
  }

  fileAttachments(userId: string) {
    return this.client
      .from('file_attachments')
      .select(fileAttachmentColumns)
      .where('user_id', userId)
      .where('status', 'ready')
      .orderBy('created_at', 'asc')
  }

  userStoryFileAttachmentLinks(storyIds: string[]) {
    return this.attachmentLinks('user_story_file_attachments', 'user_story_id', storyIds)
  }

  userStoryCommentFileAttachmentLinks(commentIds: string[]) {
    return this.attachmentLinks(
      'user_story_comment_file_attachments',
      'user_story_comment_id',
      commentIds
    )
  }

  quickChatMessageFileAttachmentLinks(messageIds: string[]) {
    return this.attachmentLinks(
      'quick_chat_message_file_attachments',
      'quick_chat_message_id',
      messageIds
    )
  }

  private attachmentLinks(table: string, ownerColumn: string, ownerIds: string[]) {
    if (!ownerIds.length) return Promise.resolve([])
    return this.client
      .from(table)
      .select([ownerColumn, 'file_attachment_id', 'position'])
      .whereIn(ownerColumn, ownerIds)
      .orderBy(ownerColumn, 'asc')
      .orderBy('position', 'asc')
  }

  private ownedRows(table: string, columns: string[], owner: string, ids: string[]) {
    if (ids.length === 0) return Promise.resolve([])
    return this.client.from(table).select(columns).whereIn(owner, ids).orderBy('created_at', 'asc')
  }
}
