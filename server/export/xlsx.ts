import ExcelJS from 'exceljs';
import { withLabels, type Table } from './table.ts';

const KIND_LABELS = { numeric: 'Число', string: 'Текст', date: 'Дата', datetime: 'Дата и время' } as const;

export async function writeXlsx(t: Table, title: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'SurveyLAB';
  wb.title = title;

  const addDataSheet = (name: string, rows: typeof t.rows) => {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }] });
    ws.columns = t.vars.map((v) => ({
      header: v.name,
      key: v.name,
      width: Math.min(Math.max(v.name.length + 2, v.kind === 'string' ? 16 : 10), 40),
      style: v.kind === 'date' ? { numFmt: 'dd.mm.yyyy' } : v.kind === 'datetime' ? { numFmt: 'dd.mm.yyyy hh:mm:ss' } : {},
    }));
    ws.getRow(1).font = { bold: true };
    t.vars.forEach((v, i) => { ws.getRow(1).getCell(i + 1).note = v.label; });
    for (const row of rows) ws.addRow(row.map((c) => (c === null ? undefined : c)));
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: t.vars.length } };
  };

  addDataSheet('Коды', t.rows);
  addDataSheet('Метки', withLabels(t));

  const cb = wb.addWorksheet('Кодбук', { views: [{ state: 'frozen', ySplit: 1 }] });
  cb.columns = [
    { header: 'Переменная', key: 'name', width: 20 },
    { header: 'Вопрос / подпись', key: 'label', width: 70 },
    { header: 'Тип', key: 'kind', width: 14 },
    { header: 'Коды ответов', key: 'values', width: 60 },
  ];
  cb.getRow(1).font = { bold: true };
  for (const v of t.vars) {
    const row = cb.addRow({
      name: v.name,
      label: v.label,
      kind: KIND_LABELS[v.kind],
      values: v.valueLabels?.map((l) => `${l.value} = ${l.label}`).join('\n') ?? '',
    });
    row.alignment = { vertical: 'top', wrapText: true };
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}
