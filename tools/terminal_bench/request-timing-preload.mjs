import {appendFileSync} from 'node:fs';
import {createTimedFetch} from './request-timing.mjs';
const destination = process.env.BLAME_STUDY_TIMING_AUDIT;
if (!destination) throw Error('Timing audit destination must be explicit');
globalThis.fetch = createTimedFetch(globalThis.fetch, {record: value => appendFileSync(destination, JSON.stringify(value)+'\n', {mode:0o600})});
