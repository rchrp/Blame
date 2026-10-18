import assert from 'node:assert/strict';
import {panel} from './panels.mjs';
const action=process.argv[2];
assert.ok(['snapshot','controls','contract-controls','preflight-controls','environment-smoke','freeze','bind','run','resume','audit','publish','verify','replay','readout'].includes(action));
await import(`./${action==='controls'&&panel.date?'new-controls':action==='freeze'&&panel.date?'new-freeze':['bind','run','resume'].includes(action)?'run':action}.mjs`);
