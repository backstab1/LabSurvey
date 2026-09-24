// Проверка .sav через pyreadstat (если установлен Python + pyreadstat; иначе тест пропускается)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildVariables, type ResponseRecord } from '../shared/variables.ts';
import { writeSav } from '../server/export/sav.ts';

const hasPyreadstat = spawnSync('python', ['-c', 'import pyreadstat'], { encoding: 'utf8' }).status === 0;

test('sav file is readable and correct', { skip: !hasPyreadstat && 'pyreadstat не установлен' }, () => {
  const demo = JSON.parse(readFileSync(new URL('../examples/demo.json', import.meta.url), 'utf8'));
  const base = {
    params: { utm_source: 'tg' }, startedAt: '2026-01-01T10:00:00Z', completedAt: '2026-01-01T10:05:00Z',
    durationSec: 300, ip: '1.2.3.4', userAgent: 'UA', isTest: false, version: 1,
  };
  const longText = 'Длинный ответ '.repeat(60).trim();
  const rs: ResponseRecord[] = [
    {
      ...base, id: 'r1', status: 'completed',
      answers: {
        S1: { v: 30 }, S2: { v: 1 }, Q1: { v: [1, 97], o: { '97': 'Даблби' } }, Q2: { v: 1 },
        Q3: { v: { '1': 4, '2': 3, '3': 1, '9': 2 }, o: { '9': 'Музыка' } }, Q4: { v: 5 }, Q4a: { v: longText },
        D1: { v: 97, o: { '97': 'Тверь' } }, D2: { v: '2026-09-01' }, D3: { v: '+79161234567' },
      },
    },
    { ...base, id: 'r2', status: 'screened_out', completedAt: null, durationSec: null, params: {}, answers: { S1: { v: 16 }, S2: { v: 2 } } },
  ];
  const vars = buildVariables(demo, rs);
  const file = join(mkdtempSync(join(tmpdir(), 'sav-')), 'out.sav');
  writeFileSync(file, writeSav(vars, rs.map((r) => vars.map((v) => v.get(r))), 'Демо'));

  const py = `
import pyreadstat, json, math
df, m = pyreadstat.read_sav(r'''${file}''')
r0 = df.iloc[0]; r1 = df.iloc[1]
clean = lambda x: None if isinstance(x, float) and math.isnan(x) else (str(x) if not isinstance(x, (int, float, str)) else x)
print(json.dumps({
  "shape": list(df.shape), "cols": list(df.columns),
  "Q4a": r0["Q4a"], "Q1_97_other": r0["Q1_97_other"], "Q3_9_other": r0["Q3_9_other"],
  "Q3_1": r0["Q3_1"], "S1_r1": r1["S1"], "Q3_1_r1": clean(r1["Q3_1"]), "D2": str(r0["D2"]), "started": str(r0["started_at"]),
  "label_Q3_1": m.column_names_to_labels["Q3_1"], "vl_Q3_1": m.variable_value_labels["Q3_1"],
  "vl_status": m.variable_value_labels["status"], "measure_Q4": m.variable_measure["Q4"], "file_label": m.file_label,
}, ensure_ascii=False, default=str))
`;
  const res = spawnSync('python', ['-c', py], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out.shape, [2, vars.length]);
  assert.deepEqual(out.cols, vars.map((v) => v.name));
  assert.equal(out.Q4a, longText);
  assert.equal(out.Q1_97_other, 'Даблби');
  assert.equal(out.Q3_9_other, 'Музыка');
  assert.equal(out.Q3_1, 4);
  assert.equal(out.S1_r1, 16);
  assert.equal(out.Q3_1_r1, null);
  assert.equal(out.D2, '2026-09-01');
  assert.equal(out.started, '2026-01-01 10:00:00');
  assert.equal(out.label_Q3_1, 'Оцените «[Q2]» по параметрам: Вкус кофе');
  assert.deepEqual(out.vl_Q3_1, { '1.0': 'Плохо', '2.0': 'Средне', '3.0': 'Хорошо', '4.0': 'Отлично' });
  assert.equal(out.vl_status['2.0'], 'Отсеян');
  assert.equal(out.measure_Q4, 'ordinal');
  assert.equal(out.file_label, 'Демо');
});
