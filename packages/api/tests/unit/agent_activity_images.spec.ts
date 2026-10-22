import { updateUserStoryAgentRunValidator } from '#validators/user_story_agent_run'
import { activityWithArtifact } from '#services/agent_activity_artifacts'
import { test } from '@japa/runner'

const id = 'd'.repeat(64)

function finalActivity(images: unknown) {
  return {
    id: 'message-final',
    kind: 'message',
    messageKind: 'final',
    title: 'Agent response',
    detail: 'Checked in light and dark mode.',
    status: 'completed',
    createdAt: '2026-10-22T14:40:00.000Z',
    images,
  }
}

test.group('agent activity images', () => {
  test('a final activity keeps its screenshots through validation and storage', async ({
    assert,
  }) => {
    const images = [
      { id, caption: 'Providers page, dark' },
      { id: 'e'.repeat(64), caption: 'Providers page, light' },
    ]
    const input = await updateUserStoryAgentRunValidator.validate({
      agentActivity: finalActivity(images),
    })
    assert.deepEqual(input.agentActivity?.images, images)
    const stored = await activityWithArtifact('story-1', 'session-1', input.agentActivity!)
    assert.deepEqual(JSON.parse(JSON.stringify(stored)).images, images)
  })

  test('rejects invalid screenshot references', async ({ assert }) => {
    for (const images of [
      [{ id: 'not-an-id', caption: 'Bad id' }],
      [{ id, caption: '' }],
      [{ id, caption: 'x'.repeat(161) }],
      Array.from({ length: 9 }, () => ({ id, caption: 'Too many' })),
    ]) {
      await assert.rejects(() =>
        updateUserStoryAgentRunValidator.validate({ agentActivity: finalActivity(images) })
      )
    }
  })
})
