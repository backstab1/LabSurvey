import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeFlow } from '../shared/flow.ts';
import type { Survey } from '../shared/types.ts';

const demo = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8')) as Survey;

test('demo flow: edges, incoming, path length', () => {
  const f = analyzeFlow(demo);
  assert.deepEqual(f.issues, []);
  const q4 = f.nodes.find((n) => n.id === 'Q4')!;
  assert.deepEqual(q4.out.map((e) => [e.kind, e.target]), [['goTo', 'D1']]);
  assert.deepEqual(f.nodes.find((n) => n.id === 'D1')!.in.map((x) => x.from), ['Q4']);
  assert.equal(f.stats.screenouts, 2);
  assert.equal(f.stats.questions, 11);
  // Самый короткий путь: INTRO S1 S2 Q1 (Q2–Q4a скрыты) D1 D2 D3 = 7; самый длинный — все 11
  assert.equal(f.stats.minPath, 7);
  assert.equal(f.stats.maxPath, 11);
  assert.ok(f.nodes.every((n) => n.reachable));
});

test('unreachable questions and impossible completion', () => {
  const s: Survey = {
    formatVersion: 2, title: 't', blocks: [{ id: 'B', questions: [
      { id: 'A', type: 'text', text: 'a', actions: { after: [{ do: 'goTo', target: 'C' }] } },
      { id: 'B1', type: 'text', text: 'b' },
      { id: 'C', type: 'text', text: 'c' },
    ] }],
  };
  const f = analyzeFlow(s);
  assert.equal(f.nodes[1].reachable, false);
  assert.match(f.issues[0].message, /нельзя дойти/);
  assert.equal(f.stats.minPath, 2);

  const dead: Survey = {
    formatVersion: 2, title: 't', blocks: [{ id: 'B', questions: [
      { id: 'A', type: 'text', text: 'a', actions: { after: [{ do: 'screenout' }] } },
    ] }],
  };
  const d = analyzeFlow(dead);
  assert.equal(d.issues[0].level, 'error');
  assert.equal(d.stats.minPath, null);
});
