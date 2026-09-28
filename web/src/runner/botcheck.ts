// Защита от ботов в браузере респондента: решение задачи проверки браузера и отпечаток устройства.
import type { BotChallenge, BotSolution } from '../../../shared/api.ts';

// SHA-256 (FIPS 180-4) — синхронная, чтобы перебор шёл быстро и без очереди промисов
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const W = new Uint32Array(64);

/** SHA-256 строки (UTF-8) → 8 слов по 32 бита */
export function sha256Words(text: string): Uint32Array {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const blocks = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(blocks);
  buf.set(bytes);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(blocks - 4, len * 8);
  view.setUint32(blocks - 8, Math.floor(len / 0x20000000));
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  for (let off = 0; off < blocks; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  return h;
}

export const sha256Hex = (text: string) => Array.from(sha256Words(text), (w) => w.toString(16).padStart(8, '0')).join('');

/** Начинается ли хеш с bits нулевых бит */
function zeroBits(h: Uint32Array, bits: number): boolean {
  let i = 0;
  for (; bits >= 32; bits -= 32) if (h[i++] !== 0) return false;
  return bits === 0 || h[i] >>> (32 - bits) === 0;
}

/** Подбор числа n порциями, чтобы страница не зависала */
export function solveChallenge(c: BotChallenge): Promise<BotSolution> {
  return new Promise((resolve) => {
    let n = 0;
    const step = () => {
      const until = n + 20_000;
      for (; n < until; n++) {
        if (zeroBits(sha256Words(`${c.salt}${n}`), c.bits)) return resolve({ ...c, n });
      }
      setTimeout(step, 0);
    };
    step();
  });
}

/** Отпечаток устройства: браузер, экран, язык, часовой пояс, отрисовка — хеш без личных данных */
export function deviceFingerprint(): string {
  const parts: unknown[] = [];
  try {
    const n = navigator as Navigator & { deviceMemory?: number };
    parts.push(n.userAgent, n.language, (n.languages ?? []).join(','), n.platform, n.hardwareConcurrency, n.deviceMemory, n.maxTouchPoints);
    parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone, new Date().getTimezoneOffset());
    parts.push(screen.width, screen.height, screen.colorDepth, window.devicePixelRatio);
  } catch { /* */ }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 220; canvas.height = 40;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.textBaseline = 'top';
      ctx.font = '16px Arial';
      ctx.fillStyle = '#f60'; ctx.fillRect(100, 1, 62, 20);
      ctx.fillStyle = '#069'; ctx.fillText('SurveyLAB, Опрос 😊', 2, 15);
      parts.push(canvas.toDataURL());
    }
    const gl = document.createElement('canvas').getContext('webgl') as WebGLRenderingContext | null;
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl && info) parts.push(gl.getParameter(info.UNMASKED_VENDOR_WEBGL), gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
  } catch { /* */ }
  return sha256Hex(parts.map(String).join('|')).slice(0, 32);
}

/** Автоматизированный браузер (Selenium, Playwright, Puppeteer без маскировки) */
export const isAutomated = () => {
  try { return navigator.webdriver === true || /HeadlessChrome/.test(navigator.userAgent); } catch { return false; }
};
