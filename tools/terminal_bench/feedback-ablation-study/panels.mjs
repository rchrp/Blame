import assert from 'node:assert/strict';
const panels={
 F59:{id:'F59',kind:'repair',parent:'light-harness-navigation-feedback-f58-2026-10-18',description:'Failed-check-first advisory and finish ordering only; known Remeda requests, no seeded history or forced tool choice.'},
 F60:{id:'F60',kind:'body',parent:'light-harness-feedback-f59-2026-10-18',description:'Observed input headers in body-edit receipts only; known Remeda requests, no forced symbolic editing.'},
 F61:{id:'F61',kind:'confirmation',parent:'light-harness-feedback-f60-2026-10-18',description:'Full current feedback bundle versus b70c21fa baseline and integrated Cline on fresh TS-Pattern cross-module requests.'},
 F62:{id:'F62',kind:'provenance',parent:'light-harness-feedback-f61-2026-10-18',description:'Post-edit/current-check provenance feedback only versus current Light and integrated Cline; known Remeda diagnostic requests. Common demand-driven HTTP timing and strengthened finite boundary oracle.'},
 F63:{id:'F63',kind:'handoff',date:'2026-10-19',studyName:'light-harness-validation-recovery-f63-2026-10-19',project:'controlled-validation',parent:'light-harness-feedback-f62-2026-10-18',description:'Controlled serialized actual post-validation edit handoff, with versus without validationState only. Common current runtime and scope feedback; handoff is user input, not a live tool-result receipt or restored journal.'},
 F64:{id:'F64',kind:'large',date:'2026-10-19',studyName:'light-harness-rxjs-confirmation-f64-2026-10-19',project:'rxjs',parent:'light-harness-validation-recovery-f63-2026-10-19',description:'Runtime-test scope feedback only versus sealed F62 current Light and integrated Cline on three new complete-project RxJS cross-file feature requests.'},
};
export const panel=panels[process.env.BLAME_FEEDBACK_PANEL];
assert.ok(panel,'Explicit known BLAME_FEEDBACK_PANEL required');
