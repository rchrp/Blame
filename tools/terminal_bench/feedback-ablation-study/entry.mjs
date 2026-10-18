import assert from 'node:assert/strict';
import './panels.mjs';
const action=process.argv[2];
assert.ok(['snapshot','controls','preflight-controls','environment-smoke','freeze','bind','run','resume','audit','publish','verify','replay','readout'].includes(action));
await import(`./${['bind','run','resume'].includes(action)?'run':action}.mjs`);
