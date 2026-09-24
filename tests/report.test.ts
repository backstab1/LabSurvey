import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../shared/report.ts';
import type { Survey } from '../shared/types.ts';
import type { ResponseRecord } from '../shared/variables.ts';

const survey: Survey = {
  formatVersion: 2, title: 'r',
  blocks: [{ id: 'B1', questions: [
    { id: 'M', type: 'multi', text: 'm', options: [{ code: 1, text: 'a' }, { code: 2, text: 'b' }, { code: 97, text: 'Другое', other: true }] },
    { id: 'N', type: 'scale', text: 'nps', from: 0, to: 10 },
    { id: 'X', type: 'number', text: 'x' },
    { id: 'T', type: 'matrix', mode: 'single', text: 't', rows: [{ code: 1, text: 'r1' }], columns: [{ code: 1, text: 'c1' }, { code: 2, text: 'c2' }] },
  ] }],
};

let seq = 0;
const resp = (answers: ResponseRecord['answers'], status: ResponseRecord['status'] = 'completed'): ResponseRecord => ({
  id: `r${++seq}`, status, answers, params: {}, startedAt: `2026-09-2${seq}T10:00:00Z`, completedAt: null,
  durationSec: 60, ip: null, userAgent: null, isTest: false, version: 1,
});

test('report: shares, NPS, stats, matrix, other texts, drop-off', () => {
  const r = buildReport(survey, [
    resp({ M: { v: [1, 97], o: { '97': 'своё' } }, N: { v: 10 }, X: { v: 5 }, T: { v: { '1': 1 } } }),
    resp({ M: { v: [1, 2] }, N: { v: 8 }, X: { v: 15 }, T: { v: { '1': 2 } } }),
    resp({ M: { v: [2] }, N: { v: 3 }, X: { v: 10 } }),
    resp({ N: { v: 9 } }),
  ], [{ ...resp({}, 'in_progress'), lastPage: 'X' }, { ...resp({}, 'terminated'), lastPage: 'X' }]);
  assert.equal(r.total, 4);
  const m = r.questions.find((q) => q.id === 'M')!;
  assert.equal(m.n, 3);
  assert.deepEqual(m.rows!.map((x) => x.pct), [66.7, 66.7, 33.3]);
  assert.deepEqual(m.texts, ['своё']);
  const n = r.questions.find((q) => q.id === 'N')!;
  assert.deepEqual(n.nps, { score: 25, promoters: 50, detractors: 25, passives: 25 });
  assert.deepEqual(r.questions.find((q) => q.id === 'X')!.stats, { mean: 10, median: 10, min: 5, max: 15 });
  const t = r.questions.find((q) => q.id === 'T')!;
  assert.deepEqual(t.matrix![0].cells.map((c) => c.pct), [50, 50]);
  assert.deepEqual(r.dropOff, [{ id: 'X', text: 'x', count: 2 }]);
});
