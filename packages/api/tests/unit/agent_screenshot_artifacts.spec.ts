import { putScreenshotArtifact, screenshotArtifact } from '#services/agent_screenshot_artifacts'
import { test } from '@japa/runner'
import { createHash } from 'node:crypto'

const image = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const id = createHash('sha256').update(image).digest('hex')

test.group('agent screenshot artifacts', () => {
  test('stores a screenshot for its owner and reads it back', async ({ assert }) => {
    const upload = {
      content: image.toString('base64'),
      mimeType: 'image/png',
      sessionId: 'session-a',
    }
    await putScreenshotArtifact('story-a', id, upload)
    await putScreenshotArtifact('story-a', id, upload)
    const stored = await screenshotArtifact('story-a', id, 'session-a')
    assert.equal(stored.content, image.toString('base64'))
    assert.equal(stored.mimeType, 'image/png')
    await assert.rejects(() => screenshotArtifact('story-b', id, 'session-a'))
  })

  test('rejects content that does not match its id', async ({ assert }) => {
    await assert.rejects(
      () =>
        putScreenshotArtifact('story-a', 'f'.repeat(64), {
          content: image.toString('base64'),
          mimeType: 'image/png',
        }),
      /does not match/
    )
    await assert.rejects(
      () =>
        putScreenshotArtifact('story-a', '../escape', {
          content: image.toString('base64'),
          mimeType: 'image/png',
        }),
      /Invalid screenshot id/
    )
    await assert.rejects(
      () =>
        putScreenshotArtifact('story-a', id, {
          content: image.toString('base64'),
          mimeType: 'text/html',
        }),
      /Unsupported image type/
    )
  })
})
