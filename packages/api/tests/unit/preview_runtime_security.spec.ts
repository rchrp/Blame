import { validateSourceArtifact } from '#services/workspace_artifacts/source_artifact_validator'
import { vercelNetworkPolicy } from '#services/sandboxes/vercel_network_policy'
import { redactPreviewMessage } from '#services/preview_sessions/preview_event_sink'
import { createHash } from 'node:crypto'
import { pack } from 'tar-stream'
import { test } from '@japa/runner'

test.group('preview runtime security', () => {
  test('uses a default-deny domain allowlist without blocking sandbox DNS', ({ assert }) => {
    const policy = vercelNetworkPolicy(
      [' Registry.NPMJS.org ', 'registry.npmjs.org'],
      [{ domain: 'api.example.com', method: ['GET'], pathPrefix: '/broker/' }]
    )
    assert.deepEqual(Object.keys(policy.allow), ['registry.npmjs.org', 'api.example.com'])
    assert.notProperty(policy, 'subnets')
    assert.throws(
      () => vercelNetworkPolicy(['https://example.com']),
      /Invalid sandbox egress domain/
    )
    assert.throws(() => vercelNetworkPolicy(['169.254.169.254']), /Invalid sandbox egress domain/)
    assert.throws(() => vercelNetworkPolicy(['-invalid.example']), /Invalid sandbox egress domain/)
  })

  test('accepts a bounded source archive with its canonical manifest', async ({ assert }) => {
    const content = await archive([
      { name: '.blame/source-manifest.json', content: '{}' },
      { name: 'workspace/src/index.ts', content: 'export {}\n' },
    ])
    const result = await validateSourceArtifact(content, metadata(content))
    assert.equal(result.entries, 2)
  })

  test('rejects secret paths, traversal, and escaping symlinks', async ({ assert }) => {
    for (const entry of [
      { name: 'workspace/.env', content: 'TOKEN=value' },
      { name: '../escape', content: 'bad' },
      { name: 'workspace/link', type: 'symlink' as const, linkname: '../../escape' },
    ]) {
      const content = await archive([{ name: '.blame/source-manifest.json', content: '{}' }, entry])
      await assert.rejects(() => validateSourceArtifact(content, metadata(content)))
    }
  })

  test('redacts credentials and provider URLs from durable events', ({ assert }) => {
    const redacted = redactPreviewMessage(
      'authorization=Bearer-secret token abc password=hunter2 https://private.vercel.run/path'
    )
    assert.notInclude(redacted, 'Bearer-secret')
    assert.notInclude(redacted, 'hunter2')
    assert.notInclude(redacted, 'private.vercel.run')
    assert.include(redacted, 'authorization=[redacted]')
  })
})

type ArchiveEntry = {
  name: string
  content?: string
  type?: 'symlink'
  linkname?: string
}

async function archive(entries: ArchiveEntry[]) {
  const stream = pack()
  const reading = (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      if (!Buffer.isBuffer(chunk)) throw new Error('Archive stream emitted non-binary data')
      chunks.push(Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  })()
  for (const entry of entries) {
    const header = { name: entry.name, type: entry.type, linkname: entry.linkname }
    if (entry.type === 'symlink') stream.entry(header)
    else stream.entry(header, entry.content ?? '')
  }
  stream.finalize()
  return reading
}

function metadata(content: Uint8Array) {
  return {
    sha256: createHash('sha256').update(content).digest('hex'),
    size: content.byteLength,
  }
}
