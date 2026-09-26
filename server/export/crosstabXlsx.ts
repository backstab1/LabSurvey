// Таблицы в Excel: одна вкладка, таблицы друг под другом. Проценты — числами, буквы значимости — в соседнем узком столбце.
import ExcelJS from 'exceljs';
import type { CrosstabResult } from '../../shared/crosstab.ts';

export type Measure = 'colPct' | 'rowPct' | 'count';
const MEASURE_LABELS: Record<Measure, string> = { colPct: '% по столбцу', rowPct: '% по строке', count: 'Количество' };

export async function writeCrosstabXlsx(res: CrosstabResult, title: string, measures: Measure[], note: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SurveyLAB';
  const ws = wb.addWorksheet('Таблицы', { views: [{ state: 'frozen', xSplit: 1 }] });
  ws.getColumn(1).width = 45;
  let r = 1;
  ws.getCell(r, 1).value = title;
  ws.getCell(r, 1).font = { bold: true, size: 13 };
  r++;
  ws.getCell(r, 1).value = note;
  ws.getCell(r, 1).font = { italic: true, color: { argb: 'FF6B7380' } };
  r += 2;

  for (const t of res.tables) {
    const cols = t.columns;
    // Каждый столбец таблицы — два столбца Excel: значение и буквы значимости
    const colIdx = (i: number) => 2 + i * 2;
    ws.getCell(r, 1).value = t.title + (t.multi ? ' (несколько ответов)' : '');
    ws.getCell(r, 1).font = { bold: true };
    r++;
    // Шапка: название баннера над его столбцами
    let i = 0;
    while (i < cols.length) {
      let j = i;
      while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++;
      const cell = ws.getCell(r, colIdx(i));
      cell.value = cols[i].banner || '';
      cell.font = { bold: true };
      cell.alignment = { wrapText: true, vertical: 'bottom' };
      if (j > i) ws.mergeCells(r, colIdx(i), r, colIdx(j) + 1);
      i = j + 1;
    }
    r++;
    cols.forEach((c, k) => {
      const cell = ws.getCell(r, colIdx(k));
      cell.value = c.letter ? `${c.label} (${c.letter})` : c.label;
      cell.font = { bold: true };
      cell.alignment = { wrapText: true, vertical: 'top' };
      ws.getColumn(colIdx(k)).width = 14;
      ws.getColumn(colIdx(k) + 1).width = 4;
    });
    r++;
    ws.getCell(r, 1).value = 'База (ответили)';
    ws.getCell(r, 1).font = { italic: true };
    cols.forEach((c, k) => { ws.getCell(r, colIdx(k)).value = c.base; });
    r++;
    for (const row of t.rows) {
      for (const m of measures) {
        ws.getCell(r, 1).value = measures.length > 1 ? `${row.label} — ${MEASURE_LABELS[m]}` : row.label;
        row.cells.forEach((cell, k) => {
          const v = ws.getCell(r, colIdx(k));
          if (m === 'count') v.value = cell.count;
          else { v.value = (m === 'colPct' ? cell.colPct : cell.rowPct) / 100; v.numFmt = '0.0%'; }
          if (m === 'colPct' && cell.sig) {
            const s = ws.getCell(r, colIdx(k) + 1);
            s.value = cell.sig;
            s.font = { bold: true, color: { argb: 'FF1C7C3A' } };
          }
        });
        r++;
      }
    }
    for (const st of t.stats ?? []) {
      ws.getCell(r, 1).value = st.label;
      st.cells.forEach((cell, k) => {
        ws.getCell(r, colIdx(k)).value = cell.value;
        if (cell.sig) {
          const s = ws.getCell(r, colIdx(k) + 1);
          s.value = cell.sig;
          s.font = { bold: true, color: { argb: 'FF1C7C3A' } };
        }
      });
      r++;
    }
    r += 2;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
