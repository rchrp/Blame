import assert from 'node:assert/strict';

// Post-campaign verification only. Never rewrite a model request. Normalize
// exactly the input Git identity and workspace path after checking both.
export function normalizeSeededPrompt(prompt, {workspace, inputCommit}) {
  assert.equal(typeof prompt, 'string');
  assert.match(inputCommit, /^[a-f0-9]{40}$/);
  assert.ok(prompt.includes(`cwd: ${workspace}\n`));
  const opening = '<workspace_metadata>\n', closing = '\n</workspace_metadata>';
  const start = prompt.indexOf(opening), end = prompt.indexOf(closing, start);
  assert.ok(start >= 0 && end > start);
  const metadata = JSON.parse(prompt.slice(start + opening.length, end));
  assert.deepEqual(Object.keys(metadata.workspaces), [workspace]);
  assert.equal(metadata.workspaces[workspace].latestGitCommitHash, inputCommit);
  metadata.workspaces[workspace].latestGitCommitHash = '<INPUT_COMMIT>';
  return (prompt.slice(0, start + opening.length) + JSON.stringify(metadata, null, 2) + prompt.slice(end))
    .replaceAll(workspace, '<WORKSPACE>');
}
