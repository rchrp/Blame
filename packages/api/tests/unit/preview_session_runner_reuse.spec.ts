import { test } from '@japa/runner'
import { usesCurrentRunner } from '#services/preview_sessions/preview_session_reuse'

const sandbox = { image: 'vcr.vercel.com/blame/runner@sha256:new', runnerVersion: '0.3.2' }

test.group('Preview session runner reuse', () => {
  test('reuses a preview started with the pinned runner', ({ assert }) => {
    assert.isTrue(usesCurrentRunner({ runnerVersion: '0.3.2', imageDigest: 'sha256:new' }, sandbox))
    assert.isTrue(usesCurrentRunner({}, sandbox))
  })

  test('recreates a preview started with another runner', ({ assert }) => {
    assert.isFalse(usesCurrentRunner({ runnerVersion: '0.3.1' }, sandbox))
    assert.isFalse(
      usesCurrentRunner({ runnerVersion: '0.3.2', imageDigest: 'sha256:old' }, sandbox)
    )
  })
})
