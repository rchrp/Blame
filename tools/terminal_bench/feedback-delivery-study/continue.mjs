import {join} from 'node:path';
import {study, work} from './inputs.mjs';
import {run} from './campaign.mjs';
// One new assignment per process. Repeated invocations only restore known
// checkpoints and run the next unstarted, originally preselected assignment.
await run({studyRoot: join(study, 'continuation'), campaignRoot: join(work, 'continuation'), maxNewTrials: 1});
