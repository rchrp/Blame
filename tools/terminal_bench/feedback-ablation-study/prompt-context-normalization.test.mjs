import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeSeededPrompt} from './prompt-context-normalization.mjs';
const prompt=(workspace,commit,other='same')=>`cwd: ${workspace}\n<workspace_metadata>\n${JSON.stringify({workspaces:{[workspace]:{latestGitCommitHash:commit,hint:other}}},null,2)}\n</workspace_metadata>\nInstruction: preserve ${other}.`;
test('normalizes only checked workspace and input identity, retaining changed instructions',()=>{
 const a={workspace:'/a',inputCommit:'a'.repeat(40)},b={workspace:'/b',inputCommit:'b'.repeat(40)};
 assert.equal(normalizeSeededPrompt(prompt(a.workspace,a.inputCommit),a),normalizeSeededPrompt(prompt(b.workspace,b.inputCommit),b));
 assert.notEqual(normalizeSeededPrompt(prompt(a.workspace,a.inputCommit),a),normalizeSeededPrompt(prompt(b.workspace,b.inputCommit,'changed'),b));
 assert.notEqual(normalizeSeededPrompt(prompt(a.workspace,a.inputCommit),a),normalizeSeededPrompt(prompt(a.workspace,a.inputCommit).replace('Instruction: preserve same.','Instruction: change behavior.'),a));
 assert.notEqual(normalizeSeededPrompt(prompt(a.workspace,a.inputCommit)+'\nOther identity: '+a.inputCommit,a),normalizeSeededPrompt(prompt(b.workspace,b.inputCommit)+'\nOther identity: '+b.inputCommit,b));
 assert.throws(()=>normalizeSeededPrompt(prompt(a.workspace,'c'.repeat(40)),a));
 assert.throws(()=>normalizeSeededPrompt(prompt('/wrong',a.inputCommit),a));
});
