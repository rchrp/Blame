import { test } from '@japa/runner'
import { originalAttachmentPayload } from '../../database/migrations/1784100000000_remove_attachment_ai_context.js'

test.group('attachment metadata migration', () => {
  test('removes only derived text and preserves original bytes, identity and ordering', ({
    assert,
  }) => {
    const original = {
      id: '1',
      name: 'report.pdf',
      content: 'AP+A',
      size: 3,
      type: 'application/pdf',
    }
    const reference = {
      id: '2',
      name: 'notes.docx',
      downloadUrl: 'https://example.test/file',
      size: 42,
      type: 'application/octet-stream',
    }
    const input = [{ ...original, aiContextMarkdown: '# Converted content' }, reference]
    for (const payload of [input, JSON.stringify(input)]) {
      assert.deepEqual(JSON.parse(originalAttachmentPayload(payload)!), [original, reference])
    }
    assert.property(input[0], 'aiContextMarkdown')
  })

  test('is idempotent and leaves absent or malformed legacy values untouched', ({ assert }) => {
    for (const value of [null, '', '{invalid', {}, [], '[{"id":"original"}]']) {
      assert.isUndefined(originalAttachmentPayload(value))
    }
    const cleaned = originalAttachmentPayload([{ content: 'AQID', aiContextMarkdown: 'derived' }])
    assert.isUndefined(originalAttachmentPayload(cleaned))
  })
})
