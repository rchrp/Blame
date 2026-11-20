/* eslint-disable @unicorn/no-await-expression-member -- the tests read responses inline */
import EngineSession from '#models/engine_session'
import Project from '#models/project'
import User from '#models/user'
import { blobObjectKey } from '#services/engine_sessions_service'
import { workspaceArtifactObjectStorage } from '#services/workspace_artifacts/workspace_artifact_object_storage'
import env from '#start/env'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { createHash, randomUUID } from 'node:crypto'

const base = () => `http://${env.get('HOST')}:${env.get('PORT')}/api/v1/engine`

test.group('engine session log', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('the first push creates the session for its owner and records its purpose', async ({
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await createProject(owner.user.id)
    const id = sessionId()

    const response = await owner.push(id, [created(1, 'development'), message(2)], { projectId })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { acked: 2 })
    const session = await EngineSession.findOrFail(id)
    assert.equal(session.userId, owner.user.id)
    assert.equal(session.purpose, 'development')
    assert.equal(session.headSeq, 2)
    assert.equal(session.projectId, projectId)
    const rows = await db.from('engine_session_records').where('session_id', id).orderBy('seq')
    assert.deepEqual(
      rows.map((row) => [Number(row.seq), row.type, Number(row.at_ms)]),
      [
        [1, 'session_created', 1_700_000_000_001],
        [2, 'user_message', 1_700_000_000_002],
      ]
    )
  })

  test('pushing records again is a no-op, and overlapping batches extend the log', async ({
    assert,
  }) => {
    const owner = await createUser()
    const id = sessionId()
    const batch = [created(1), message(2), message(3), message(4), message(5)]

    assert.deepEqual(await (await owner.push(id, batch)).json(), { acked: 5 })
    assert.deepEqual(await (await owner.push(id, batch)).json(), { acked: 5 })
    assert.deepEqual(await (await owner.push(id, batch.slice(2))).json(), { acked: 5 })
    assert.deepEqual(
      await (await owner.push(id, [message(4), message(5), message(6), message(7)])).json(),
      { acked: 7 }
    )
    assert.deepEqual(await (await owner.push(id, [])).json(), { acked: 7 })
    const [{ total }] = await db
      .from('engine_session_records')
      .where('session_id', id)
      .count('* as total')
    assert.equal(Number(total), 7)
  })

  test('a record that differs from the held one is a conflict and nothing of the batch is stored', async ({
    assert,
  }) => {
    const owner = await createUser()
    const id = sessionId()
    await owner.push(id, [created(1), message(2), message(3)])

    const conflict = await owner.push(id, [message(2, 'something else'), message(3), message(4)])

    assert.equal(conflict.status, 409)
    const body = (await conflict.json()) as Record<string, unknown>
    assert.equal(body.code, 'E_ENGINE_LOG_CONFLICT')
    assert.equal(body.seq, 2)
    assert.equal(body.acked, 3)
    const stored = await owner.pull(id, 0)
    assert.deepEqual(seqs(stored.records), [1, 2, 3])
    assert.deepEqual((stored.records[1] as unknown as { input: unknown }).input, message(2).input)
  })

  test('a held record that differs only in its time is a conflict too', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()
    await owner.push(id, [created(1), message(2)])

    const conflict = await owner.push(id, [{ ...message(2), at_ms: 5 }])

    assert.equal(conflict.status, 409)
  })

  test('key order and spacing do not make a replayed record different', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()
    await owner.push(id, [created(1), message(2)])
    const reordered = Object.fromEntries(Object.entries(message(2)).reverse())

    const response = await owner.raw(
      `/sessions/${id}/records`,
      'POST',
      `{ "records" : [ ${JSON.stringify(reordered)} ] }`
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { acked: 2 })
  })

  test('a batch that leaves a gap is rejected and says where the log stands', async ({
    assert,
  }) => {
    const owner = await createUser()
    const id = sessionId()
    const first = await owner.push(id, [message(2)])
    assert.equal(first.status, 409)
    assert.deepEqual(await first.json(), {
      code: 'E_ENGINE_LOG_GAP',
      message: 'The log holds records up to 0, so a push cannot start at 2',
      acked: 0,
    })

    await owner.push(id, [created(1), message(2)])
    const gap = await owner.push(id, [message(4), message(5)])

    assert.equal(gap.status, 409)
    assert.equal(((await gap.json()) as { acked: number }).acked, 2)
    assert.equal((await owner.pull(id, 0)).head, 2)
  })

  test('a failed first push leaves no session in the list', async ({ assert }) => {
    const owner = await createUser()
    await owner.push(sessionId(), [message(3)])

    const listed = await owner.get('/sessions')

    assert.deepEqual(await listed.json(), { sessions: [] })
  })

  test('refuses batches that are not contiguous, malformed, or too large', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()

    const skipped = await owner.push(id, [created(1), message(3)])
    const descending = await owner.push(id, [message(2), created(1)])
    const noType = await owner.push(id, [{ seq: 1, at_ms: 1 }])
    const zero = await owner.push(id, [{ ...created(1), seq: 0 }])
    const notArray = await owner.raw(`/sessions/${id}/records`, 'POST', '{"records":{}}')
    const notJson = await owner.raw(`/sessions/${id}/records`, 'POST', 'nope')
    const tooMany = await owner.push(
      id,
      Array.from({ length: 257 }, (_, index) => (index ? message(index + 1) : created(1)))
    )
    const tooBig = await owner.raw(`/sessions/${id}/records`, 'POST', 'x'.repeat(9 * 1024 * 1024))
    const json = await owner.raw(
      `/sessions/${id}/records`,
      'POST',
      '{"records":[]}',
      'application/json'
    )
    const badId = await owner.push('has space', [created(1)])

    assert.deepEqual(
      [skipped, descending, noType, zero, notArray, notJson].map((response) => response.status),
      [422, 422, 422, 422, 422, 422]
    )
    assert.equal(tooMany.status, 413)
    assert.equal(tooBig.status, 413)
    assert.equal(json.status, 415)
    assert.equal(badId.status, 422)
    assert.isNull(await EngineSession.find(id))
  })

  test('accepts the largest batch the engine sends', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()
    const records = Array.from({ length: 256 }, (_, index) =>
      index ? message(index + 1, 'x'.repeat(7000)) : created(1)
    )

    const response = await owner.push(id, records)

    assert.deepEqual(await response.json(), { acked: 256 })
  })

  test('pulls records after a seq, ascending and page by page', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()
    await owner.push(id, [created(1), ...Array.from({ length: 9 }, (_, i) => message(i + 2))])

    const first = await owner.pull(id, 0, 4)
    const second = await owner.pull(id, 4, 4)
    const last = await owner.pull(id, 8, 4)
    const empty = await owner.pull(id, 10, 4)

    assert.deepEqual(seqs(first.records), [1, 2, 3, 4])
    assert.isTrue(first.hasMore)
    assert.deepEqual(seqs(second.records), [5, 6, 7, 8])
    assert.isTrue(second.hasMore)
    assert.deepEqual(seqs(last.records), [9, 10])
    assert.isFalse(last.hasMore)
    assert.equal(last.head, 10)
    assert.deepEqual(empty.records, [])
    assert.equal((await owner.pull(id, 0)).records.length, 10)
  })

  test('an unknown session pulls as an empty list', async ({ assert }) => {
    const owner = await createUser()

    const response = await owner.get(`/sessions/${sessionId()}/records?after=0`)

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { records: [], head: 0, hasMore: false })
  })

  test('stores records unchanged, including empty strings and non-ASCII text', async ({
    assert,
  }) => {
    const owner = await createUser()
    const id = sessionId()
    const record = {
      seq: 2,
      at_ms: 1_700_000_000_002,
      type: 'assistant_message',
      blocks: [
        { type: 'reasoning', text: '' },
        { type: 'text', text: 'héllo 🌍   "quoted"\n' },
      ],
      usage: { input_tokens: null, output_tokens: 0 },
    }
    await owner.push(id, [created(1), record])

    const pulled = await owner.pull(id, 1)

    assert.deepEqual(pulled.records, [record])
  })

  test('only the owner reads, writes, lists or deletes a session', async ({ assert }) => {
    const owner = await createUser()
    const other = await createUser()
    const id = sessionId()
    await owner.push(id, [created(1), message(2)])

    const push = await other.push(id, [message(3)])
    const pull = await other.get(`/sessions/${id}/records?after=0`)
    const destroy = await other.delete(`/sessions/${id}`)
    const listed = await other.get('/sessions')

    assert.equal(push.status, 403)
    assert.equal(((await push.json()) as { code: string }).code, 'E_ENGINE_SESSION_FORBIDDEN')
    assert.equal(pull.status, 403)
    assert.equal(destroy.status, 403)
    assert.deepEqual(await listed.json(), { sessions: [] })
    assert.equal((await owner.pull(id, 0)).records.length, 2)
  })

  test('requires authentication', async ({ assert }) => {
    const id = sessionId()
    const calls = await Promise.all([
      fetch(`${base()}/sessions`),
      fetch(`${base()}/sessions/${id}/records`),
      fetch(`${base()}/sessions/${id}/records`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: '{"records":[]}',
      }),
      fetch(`${base()}/sessions/${id}`, { method: 'DELETE' }),
      fetch(`${base()}/blobs/${sha256(Buffer.from('a'))}`),
    ])
    assert.deepEqual(
      calls.map((response) => response.status),
      [401, 401, 401, 401, 401]
    )
  })

  test('lists the sessions of the user, newest activity first', async ({ assert }) => {
    const owner = await createUser()
    const other = await createUser()
    const older = sessionId()
    const newer = sessionId()
    await owner.push(older, [created(1, 'title')])
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await owner.push(newer, [created(1, 'development'), message(2)])
    await other.push(sessionId(), [created(1)])

    const listed = (await (await owner.get('/sessions')).json()) as {
      sessions: Array<Record<string, unknown>>
    }

    assert.deepEqual(
      listed.sessions.map((session) => [session.id, session.purpose, session.head]),
      [
        [newer, 'development', 2],
        [older, 'title', 1],
      ]
    )
    assert.deepEqual(Object.keys(listed.sessions[0]!).sort(), [
      'createdAt',
      'head',
      'id',
      'projectId',
      'purpose',
      'updatedAt',
    ])
  })

  test('rejects a project of someone else', async ({ assert }) => {
    const owner = await createUser()
    const other = await createUser()
    const projectId = await createProject(other.user.id)

    const response = await owner.push(sessionId(), [created(1)], { projectId })

    assert.equal(response.status, 404)
    assert.equal(((await response.json()) as { code: string }).code, 'E_ENGINE_PROJECT_NOT_FOUND')
  })

  test('concurrent pushes to one session keep the sequence intact', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()
    const all = [created(1), ...Array.from({ length: 119 }, (_, index) => message(index + 2))]
    const slices = (size: number) =>
      Array.from({ length: Math.ceil(all.length / size) }, (_, i) =>
        all.slice(i * size, (i + 1) * size)
      )

    // Two clients push the same log in different batch sizes, all at once,
    // from the very first record (so they race to create the session too).
    const results = await Promise.all([
      ...slices(7).map((batch) => owner.push(id, batch)),
      ...slices(11).map((batch) => owner.push(id, batch)),
    ])

    // A batch that arrives before its predecessor is refused as a gap, never
    // stored out of order; whatever is stored is contiguous.
    for (const response of results) assert.include([200, 409], response.status)
    const midway = await db.from('engine_session_records').where('session_id', id).orderBy('seq')
    assert.deepEqual(
      midway.map((row) => Number(row.seq)),
      midway.map((_, index) => index + 1)
    )
    for (const batch of slices(10)) await owner.push(id, batch)
    const rows = await db.from('engine_session_records').where('session_id', id).orderBy('seq')
    assert.deepEqual(
      rows.map((row) => Number(row.seq)),
      all.map((record) => record.seq)
    )
    assert.equal((await EngineSession.findOrFail(id)).headSeq, 120)
  })

  test('concurrent identical pushes all succeed and store the records once', async ({ assert }) => {
    const owner = await createUser()
    const id = sessionId()
    const batch = [created(1), message(2), message(3)]

    const results = await Promise.all(Array.from({ length: 8 }, () => owner.push(id, batch)))

    assert.deepEqual(
      results.map((response) => response.status),
      Array(8).fill(200)
    )
    const [{ total }] = await db
      .from('engine_session_records')
      .where('session_id', id)
      .count('* as total')
    assert.equal(Number(total), 3)
  })
})

test.group('engine blobs', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('stores a blob once, verified by its hash, and serves it to its owner only', async ({
    assert,
  }) => {
    const owner = await createUser()
    const other = await createUser()
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253])
    const hash = sha256(bytes)

    const stored = await owner.putBlob(hash, bytes, 'image/png')
    const again = await owner.putBlob(hash, bytes, 'image/jpeg')
    const pulled = await owner.get(`/blobs/${hash}`)
    const foreign = await other.get(`/blobs/${hash}`)

    assert.equal(stored.status, 201)
    assert.deepEqual(await stored.json(), { sha256: hash, size: 7, mediaType: 'image/png' })
    assert.equal(again.status, 200)
    assert.equal(((await again.json()) as { mediaType: string }).mediaType, 'image/png')
    assert.equal(pulled.status, 200)
    assert.equal(pulled.headers.get('x-blob-media-type'), 'image/png')
    assert.deepEqual(Buffer.from(await pulled.arrayBuffer()), bytes)
    assert.equal(foreign.status, 404)
    assert.lengthOf(await db.from('engine_blobs'), 1)
  })

  test('rejects bytes that do not match the hash and stores nothing', async ({ assert }) => {
    const owner = await createUser()
    const hash = sha256(Buffer.from('expected'))

    const response = await owner.putBlob(hash, Buffer.from('something else'), 'text/plain')

    assert.equal(response.status, 422)
    assert.equal(((await response.json()) as { code: string }).code, 'E_ENGINE_BLOB_HASH_MISMATCH')
    assert.lengthOf(await db.from('engine_blobs'), 0)
    assert.equal((await owner.get(`/blobs/${hash}`)).status, 404)
  })

  test('refuses malformed hashes, missing media types, other content types and huge blobs', async ({
    assert,
  }) => {
    const owner = await createUser()
    const bytes = Buffer.from('abc')
    const hash = sha256(bytes)

    const upper = await owner.putBlob(hash.toUpperCase(), bytes, 'text/plain')
    const short = await owner.putBlob('abc', bytes, 'text/plain')
    const noType = await owner.raw(`/blobs/${hash}`, 'PUT', bytes)
    const json = await owner.raw(
      `/blobs/${hash}?mediaType=text/plain`,
      'PUT',
      Buffer.from('{}'),
      'application/json'
    )
    const huge = Buffer.alloc(26 * 1024 * 1024)
    const tooBig = await owner.putBlob(sha256(huge), huge, 'application/octet-stream')

    assert.deepEqual(
      [upper, short, noType].map((response) => response.status),
      [422, 422, 422]
    )
    assert.equal(json.status, 415)
    assert.equal(tooBig.status, 413)
    assert.lengthOf(await db.from('engine_blobs'), 0)
  })

  test('accepts an empty blob and JSON content', async ({ assert }) => {
    const owner = await createUser()
    const empty = Buffer.alloc(0)
    const json = Buffer.from('{"a":""}')

    const first = await owner.putBlob(sha256(empty), empty, 'application/octet-stream')
    const second = await owner.putBlob(sha256(json), json, 'application/json')
    const pulled = await owner.get(`/blobs/${sha256(json)}`)

    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.equal(Buffer.from(await pulled.arrayBuffer()).toString(), '{"a":""}')
  })
})

test.group('engine session deletion', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('deletes the session, its records, and the blobs no other session uses', async ({
    assert,
  }) => {
    const owner = await createUser()
    const first = sessionId()
    const second = sessionId()
    const shared = Buffer.from('shared image')
    const unshared = Buffer.from('private image')
    await owner.putBlob(sha256(shared), shared, 'image/png')
    await owner.putBlob(sha256(unshared), unshared, 'image/png')
    await owner.push(first, [created(1), withImage(2, shared), withImage(3, unshared)])
    await owner.push(second, [created(1), withImage(2, shared)])

    const response = await owner.delete(`/sessions/${first}`)

    assert.equal(response.status, 204)
    assert.isNull(await EngineSession.find(first))
    assert.lengthOf(await db.from('engine_session_records').where('session_id', first), 0)
    assert.lengthOf(await db.from('engine_session_blobs').where('session_id', first), 0)
    assert.equal((await owner.get(`/blobs/${sha256(unshared)}`)).status, 404)
    await assert.rejects(() =>
      workspaceArtifactObjectStorage().content(blobObjectKey(owner.user.id, sha256(unshared)))
    )
    assert.equal((await owner.get(`/blobs/${sha256(shared)}`)).status, 200)
    assert.equal((await owner.pull(second, 0)).records.length, 2)
    assert.deepEqual((await owner.pull(first, 0)).records, [])

    assert.equal((await owner.delete(`/sessions/${second}`)).status, 204)
    assert.equal((await owner.get(`/blobs/${sha256(shared)}`)).status, 404)
    assert.equal((await owner.delete(`/sessions/${second}`)).status, 404)
  })

  test('leaves the blobs of another user with the same bytes alone', async ({ assert }) => {
    const owner = await createUser()
    const other = await createUser()
    const bytes = Buffer.from('same image')
    for (const user of [owner, other]) await user.putBlob(sha256(bytes), bytes, 'image/png')
    const id = sessionId()
    await owner.push(id, [created(1), withImage(2, bytes)])
    await other.push(sessionId(), [created(1), withImage(2, bytes)])

    await owner.delete(`/sessions/${id}`)

    assert.equal((await owner.get(`/blobs/${sha256(bytes)}`)).status, 404)
    assert.equal((await other.get(`/blobs/${sha256(bytes)}`)).status, 200)
  })

  test('removes the sessions and blobs of a deleted user', async ({ assert }) => {
    const owner = await createUser()
    const bytes = Buffer.from('image')
    await owner.putBlob(sha256(bytes), bytes, 'image/png')
    await owner.push(sessionId(), [created(1), withImage(2, bytes)])

    await owner.user.delete()

    for (const table of [
      'engine_sessions',
      'engine_session_records',
      'engine_blobs',
      'engine_session_blobs',
    ]) {
      assert.lengthOf(await db.from(table), 0, table)
    }
  })
})

async function createUser() {
  const user = await User.create({ email: `${randomUUID()}@example.com`, password: 'password123' })
  const token = (await User.accessTokens.create(user)).value!.release()
  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${base()}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
    })
  const raw = (
    path: string,
    method: string,
    body: string | Buffer,
    contentType = 'application/octet-stream'
  ) => request(path, { method, body, headers: { 'content-type': contentType } })
  return {
    user,
    raw,
    get: (path: string) => request(path),
    delete: (path: string) => request(path, { method: 'DELETE' }),
    push: (id: string, records: unknown[], extra: Record<string, unknown> = {}) =>
      raw(`/sessions/${id}/records`, 'POST', JSON.stringify({ records, ...extra })),
    pull: async (id: string, after: number, limit?: number) =>
      (await (
        await request(`/sessions/${id}/records?after=${after}${limit ? `&limit=${limit}` : ''}`)
      ).json()) as { records: Array<{ seq: number }>; head: number; hasMore: boolean },
    putBlob: (hash: string, bytes: Buffer, mediaType: string) =>
      raw(`/blobs/${hash}?mediaType=${encodeURIComponent(mediaType)}`, 'PUT', bytes),
  }
}

async function createProject(userId: string) {
  const project = await Project.create({
    name: 'Engine project',
    repositoryFingerprint: randomUUID(),
    userId,
  })
  return project.id
}

function sessionId() {
  return `session-${randomUUID()}`
}

function created(seq: number, purpose = 'development') {
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq,
    type: 'session_created',
    config: { purpose, workspace_root: '/work', model: { provider: 'anthropic', model: 'm' } },
  }
}

function message(seq: number, text = 'hello') {
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq,
    type: 'user_message',
    turn: 'turn-1',
    input: [{ type: 'text', text }],
    delivery: 'turn',
  }
}

function withImage(seq: number, bytes: Buffer) {
  return {
    seq,
    at_ms: 1_700_000_000_000 + seq,
    type: 'user_message',
    turn: 'turn-1',
    input: [
      {
        type: 'image',
        blob: { sha256: sha256(bytes), media_type: 'image/png', bytes: bytes.length },
      },
    ],
    delivery: 'turn',
  }
}

function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}

function seqs(records: Array<{ seq: number }>) {
  return records.map((record) => record.seq)
}
