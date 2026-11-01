import Project from '#models/project'
import { createLicensedUser } from '#tests/helpers/create_licensed_user'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'

test.group('security audits', (group) => {
  group.setup(() => testUtils.db().truncate())
  group.each.setup(() => testUtils.db().truncate())

  test('persists project audits and rejects stale snapshot updates', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const project = await createProject(user.id)
    const auditId = crypto.randomUUID()

    const saved = await client
      .put(`/api/v1/projects/${project.id}/security-audits/${auditId}`)
      .loginAs(user)
      .json({ audit: auditSnapshot(project.id, auditId, 2) })
    saved.assertStatus(200)

    const stale = await client
      .put(`/api/v1/projects/${project.id}/security-audits/${auditId}`)
      .loginAs(user)
      .json({ audit: auditSnapshot(project.id, auditId, 1) })
    stale.assertStatus(200)
    assert.equal((stale.body() as { sequence: number }).sequence, 2)

    const listed = await client.get(`/api/v1/projects/${project.id}/security-audits`).loginAs(user)
    listed.assertStatus(200)
    const audits = listed.body() as Array<{ id: string; sequence: number }>
    assert.lengthOf(audits, 1)
    assert.equal(audits[0].id, auditId)
    assert.equal(audits[0].sequence, 2)
  })

  test('removes a finding backlog link after its story is deleted', async ({ client, assert }) => {
    const user = await createLicensedUser()
    const project = await createProject(user.id)
    const storyResponse = await client
      .post('/api/v1/projects/user-stories')
      .loginAs(user)
      .json({ projectId: project.id, title: 'Fix audit finding', summary: 'Remediate it.' })
    storyResponse.assertStatus(200)
    const storyId = (storyResponse.body() as { data: { id: string } }).data.id
    const auditId = crypto.randomUUID()

    await client
      .put(`/api/v1/projects/${project.id}/security-audits/${auditId}`)
      .loginAs(user)
      .json({
        audit: auditSnapshot(project.id, auditId, 1, {
          backlogStoryId: storyId,
          fingerprint: 'finding-fingerprint',
          status: 'fixing',
        }),
      })

    const deleted = await client.delete(`/api/v1/projects/user-stories/${storyId}`).loginAs(user)
    deleted.assertStatus(204)
    const listed = await client.get(`/api/v1/projects/${project.id}/security-audits`).loginAs(user)
    const finding = (
      listed.body() as unknown as Array<{
        findings: Array<{ backlogStoryId?: string; status: string }>
      }>
    )[0].findings[0]
    assert.isUndefined(finding.backlogStoryId)
    assert.equal(finding.status, 'open')
  })

  test('isolates audits by project owner', async ({ client }) => {
    const owner = await createLicensedUser()
    const other = await createLicensedUser()
    const project = await createProject(owner.id)

    const response = await client
      .get(`/api/v1/projects/${project.id}/security-audits`)
      .loginAs(other)
    response.assertStatus(404)
  })
})

function createProject(userId: string) {
  return Project.create({
    name: 'Security project',
    repositoryFingerprint: crypto.randomUUID(),
    userId,
  })
}

function auditSnapshot(
  projectId: string,
  id: string,
  sequence: number,
  finding?: Record<string, unknown>
) {
  const now = new Date().toISOString()
  return {
    candidateCount: finding ? 1 : 0,
    findings: finding ? [finding] : [],
    id,
    mode: 'standard',
    projectId,
    rejectedCandidateCount: 0,
    scannerVersions: {},
    scope: { type: 'repository' },
    sequence,
    sessionIds: [],
    startedAt: now,
    status: 'completed',
    updatedAt: now,
    version: 1,
  }
}
