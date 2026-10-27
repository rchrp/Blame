import test from 'node:test';import assert from 'node:assert/strict';import {successfulNativeInvocations} from './native-invocations.mjs';
test('counts successful literal standalone, structured and &&-grouped invocations',()=>{
 assert.deepEqual(successfulNativeInvocations([{query:'npm run types && npm run test',success:true,result:'passed'},{query:{command:'npm',args:['run','delivered']},success:true,result:'passed'}]),['npm run types','npm run test','npm run delivered']);
});
test('does not turn masked failures, diagnostics or altered test selections into required checks',()=>{
 for(const query of ['npm run types || true','npm run types; echo done','npm run test -- --filter selected','echo "npm run types"','cd elsewhere && npm run types'])assert.deepEqual(successfulNativeInvocations({query,success:true,result:'done'}),[]);
 assert.deepEqual(successfulNativeInvocations({query:'npm run types',success:true,result:'a.ts(1,1): error TS2322: bad type'}),[]);
 assert.deepEqual(successfulNativeInvocations({query:'npm run test',success:false,result:'passed'}),[]);
});
