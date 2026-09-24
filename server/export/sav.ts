// Запись SPSS .sav (несжатый, UTF-8) без внешних зависимостей.
// Формат: https://www.gnu.org/software/pspp/pspp-dev/html_node/System-File-Format.html
import type { Cell, VarDef } from '../../shared/variables.ts';

const SYSMIS = -Number.MAX_VALUE;
/** Секунды между 1582-10-14 (эпоха SPSS) и 1970-01-01 */
const SPSS_EPOCH_OFFSET = 12219379200;

const FMT_F = 5, FMT_A = 1, FMT_DATE = 20, FMT_DATETIME = 22;
const fmt = (type: number, width: number, dec = 0) => (type << 16) | (width << 8) | dec;

class Buf {
  private chunks: Buffer[] = [];
  int(v: number) { const b = Buffer.alloc(4); b.writeInt32LE(v); this.chunks.push(b); }
  dbl(v: number) { const b = Buffer.alloc(8); b.writeDoubleLE(v); this.chunks.push(b); }
  bytes(b: Buffer) { this.chunks.push(b); }
  /** Строка фиксированной длины, дополненная пробелами */
  fixed(s: string | Buffer, len: number, pad = 0x20) {
    const src = typeof s === 'string' ? Buffer.from(s, 'utf8') : s;
    const b = Buffer.alloc(len, pad);
    src.copy(b, 0, 0, Math.min(src.length, len));
    this.chunks.push(b);
  }
  build() { return Buffer.concat(this.chunks); }
}

/** Обрезает UTF-8 по границе символа */
function utf8Truncate(s: string, maxBytes: number): Buffer {
  const b = Buffer.from(s, 'utf8');
  if (b.length <= maxBytes) return b;
  let end = maxBytes;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end);
}

interface Segment {
  short: string;
  width: number; // 0 = numeric
}

interface Planned {
  v: VarDef;
  width: number; // 0 = numeric; иначе ширина строки в байтах
  segments: Segment[];
  /** Позиция первой записи переменной (1-based) — для записи меток значений */
  dictIndex: number;
}

const units = (width: number) => (width === 0 ? 1 : Math.ceil(width / 8));

function segmentWidths(width: number): number[] {
  if (width <= 255) return [width];
  const n = Math.ceil(width / 252);
  return Array.from({ length: n }, (_, i) => (i < n - 1 ? 255 : width - (n - 1) * 252));
}

function makeShortNames(): (count: number, v: VarDef) => string[] {
  const used = new Set<string>();
  const unique = (base: string) => {
    let name = base.slice(0, 8);
    for (let i = 1; used.has(name); i++) {
      const suffix = String(i);
      name = base.slice(0, 8 - suffix.length) + suffix;
    }
    used.add(name);
    return name;
  };
  return (count, v) => {
    const base = v.name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const first = unique(/^[A-Z]/.test(base) ? base : 'V' + base);
    const names = [first];
    for (let i = 1; i < count; i++) names.push(unique(first.slice(0, 5) + i));
    return names;
  };
}

function toNumber(v: VarDef, cell: Cell): number {
  if (cell === null || cell === undefined || cell === '') return SYSMIS;
  if (cell instanceof Date) {
    const t = cell.getTime();
    return isNaN(t) ? SYSMIS : t / 1000 + SPSS_EPOCH_OFFSET;
  }
  const n = typeof cell === 'number' ? cell : Number(cell);
  return isFinite(n) ? n : SYSMIS;
}

function toStringCell(cell: Cell): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) return cell.toISOString();
  return String(cell);
}

export function writeSav(vars: VarDef[], rows: Cell[][], fileLabel = ''): Buffer {
  // 1. Ширина строковых переменных — по максимальной длине данных
  const shortNames = makeShortNames();
  let dictIndex = 1;
  const plan: Planned[] = vars.map((v, i) => {
    let width = 0;
    if (v.kind === 'string') {
      width = 8;
      for (const row of rows) width = Math.max(width, Buffer.byteLength(toStringCell(row[i]), 'utf8'));
      width = Math.min(width, 32767);
    }
    const widths = segmentWidths(width);
    const names = shortNames(widths.length, v);
    const segments = widths.map((w, k) => ({ short: names[k], width: w }));
    const p: Planned = { v, width, segments, dictIndex };
    dictIndex += segments.reduce((s, seg) => s + units(seg.width), 0);
    return p;
  });
  const caseSize = dictIndex - 1;

  const out = new Buf();
  const now = new Date();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n: number) => String(n).padStart(2, '0');

  // 2. Заголовок
  out.fixed('$FL2', 4);
  out.fixed('@(#) SPSS DATA FILE - SurveyLAB', 60);
  out.int(2); // layout_code
  out.int(caseSize);
  out.int(0); // без сжатия
  out.int(0); // без веса
  out.int(rows.length);
  out.dbl(100);
  out.fixed(`${p2(now.getDate())} ${months[now.getMonth()]} ${p2(now.getFullYear() % 100)}`, 9);
  out.fixed(`${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`, 8);
  out.fixed(utf8Truncate(fileLabel, 64), 64);
  out.fixed('', 3, 0);

  // 3. Переменные
  for (const p of plan) {
    p.segments.forEach((seg, k) => {
      const label = k === 0 ? utf8Truncate(p.v.label, 255) : Buffer.alloc(0);
      let format: number;
      if (seg.width > 0) format = fmt(FMT_A, Math.min(seg.width, 255));
      else if (p.v.kind === 'date') format = fmt(FMT_DATE, 11);
      else if (p.v.kind === 'datetime') format = fmt(FMT_DATETIME, 20);
      else format = fmt(FMT_F, Math.max(8, 8 + (p.v.decimals ?? 0)), p.v.decimals ?? 0);

      out.int(2);
      out.int(seg.width);
      out.int(label.length > 0 ? 1 : 0);
      out.int(0);
      out.int(format);
      out.int(format);
      out.fixed(seg.short, 8);
      if (label.length > 0) {
        out.int(label.length);
        out.fixed(label, Math.ceil(label.length / 4) * 4);
      }
      for (let c = 1; c < units(seg.width); c++) {
        out.int(2); out.int(-1); out.int(0); out.int(0); out.int(0); out.int(0);
        out.fixed('', 8);
      }
    });
  }

  // 4. Метки значений (только числовые переменные)
  for (const p of plan) {
    if (p.width !== 0 || !p.v.valueLabels?.length) continue;
    out.int(3);
    out.int(p.v.valueLabels.length);
    for (const vl of p.v.valueLabels) {
      out.dbl(vl.value);
      const lab = utf8Truncate(vl.label, 120);
      const total = Math.ceil((lab.length + 1) / 8) * 8;
      const b = Buffer.alloc(total, 0x20);
      b[0] = lab.length;
      lab.copy(b, 1);
      out.bytes(b);
    }
    out.int(4);
    out.int(1);
    out.int(p.dictIndex);
  }

  // 5. Служебные записи
  const ext = (subtype: number, size: number, data: Buffer) => {
    out.int(7); out.int(subtype); out.int(size); out.int(data.length / size); out.bytes(data);
  };
  const ints = (arr: number[]) => { const b = Buffer.alloc(arr.length * 4); arr.forEach((x, i) => b.writeInt32LE(x, i * 4)); return b; };

  ext(3, 4, ints([20, 0, 0, -1, 1, 1, 2, 65001]));
  const fl = Buffer.alloc(24);
  fl.writeDoubleLE(SYSMIS, 0); fl.writeDoubleLE(Number.MAX_VALUE, 8); fl.writeDoubleLE(-Number.MAX_VALUE, 16);
  ext(4, 8, fl);

  const measureCode = { nominal: 1, ordinal: 2, scale: 3 } as const;
  const display: number[] = [];
  for (const p of plan) {
    for (const seg of p.segments) {
      const measure = seg.width > 0 ? 1 : measureCode[p.v.measure];
      display.push(measure, seg.width > 0 ? Math.min(Math.max(seg.width, 8), 40) : 10, seg.width > 0 ? 0 : 1);
    }
  }
  ext(11, 4, ints(display));

  ext(13, 1, Buffer.from(plan.map((p) => `${p.segments[0].short}=${p.v.name}`).join('\t'), 'utf8'));

  const vls = plan.filter((p) => p.segments.length > 1).map((p) => `${p.segments[0].short}=${p.width}\0\t`).join('');
  if (vls) ext(14, 1, Buffer.from(vls, 'utf8'));

  const cnt = Buffer.alloc(16);
  cnt.writeBigInt64LE(1n, 0);
  cnt.writeBigInt64LE(BigInt(rows.length), 8);
  ext(16, 8, cnt);

  ext(20, 1, Buffer.from('UTF-8', 'ascii'));

  out.int(999);
  out.int(0);

  // 6. Данные
  for (const row of rows) {
    plan.forEach((p, i) => {
      if (p.width === 0) {
        out.dbl(toNumber(p.v, row[i]));
        return;
      }
      const data = utf8Truncate(toStringCell(row[i]), p.width);
      let offset = 0;
      for (const seg of p.segments) {
        const alloc = units(seg.width) * 8;
        const used = Math.min(seg.width, 255);
        const piece = data.subarray(offset, offset + used);
        offset += used;
        const b = Buffer.alloc(alloc, 0x20);
        piece.copy(b);
        out.bytes(b);
      }
    });
  }
  return out.build();
}
