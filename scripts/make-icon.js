'use strict';

/**
 * 零依赖生成应用图标 assets/icon.png（512x512 RGBA）。
 * 渐变圆角底板 + 白色终端窗口 + 运行指示灯。
 * 使用 2x 超采样做抗锯齿。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZE = 512;
const SS = 2;
const DIM = SIZE * SS;

const lerp = (a, b, t) => a + (b - a) * t;

function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2;
  const cy = y + h / 2;
  const dx = Math.abs(px - cx) - (w / 2 - r);
  const dy = Math.abs(py - cy) - (h / 2 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const denom = bax * bax + bay * bay || 1;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function sdPolyline(px, py, points, width) {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    best = Math.min(best, sdSegment(px, py, ax, ay, bx, by));
  }
  return best - width / 2;
}

const PLATE = { x: 16, y: 16, w: 480, h: 480, r: 116 };
const WINDOW = { x: 104, y: 132, w: 304, h: 248, r: 44 };
const GRAD_A = [104, 137, 255];
const GRAD_B = [154, 104, 255];
const INK = [92, 84, 202];
const WHITE = [255, 255, 255];
const GREEN = [53, 211, 154];
const STROKE = 26;

const CHEVRON = [
  [168, 200],
  [208, 232],
  [168, 264],
];

// 累积缓冲（预乘前的线性叠加）
const accum = new Float32Array(SIZE * SIZE * 4);

function render() {
  for (let sy = 0; sy < DIM; sy += 1) {
    const y = (sy + 0.5) / SS;
    for (let sx = 0; sx < DIM; sx += 1) {
      const x = (sx + 0.5) / SS;
      const px = Math.floor(y) * SIZE + Math.floor(x);
      const index = px * 4;

      let color = null;
      if (sdRoundRect(x, y, PLATE.x, PLATE.y, PLATE.w, PLATE.h, PLATE.r) <= 0) {
        const t = ((x - PLATE.x) / PLATE.w + (y - PLATE.y) / PLATE.h) / 2;
        color = mix(GRAD_A, GRAD_B, t);
      }
      if (sdRoundRect(x, y, WINDOW.x, WINDOW.y, WINDOW.w, WINDOW.h, WINDOW.r) <= 0) {
        color = WHITE;
      }

      const chevron = sdPolyline(x, y, CHEVRON, STROKE);
      const line1 = sdSegment(x, y, 236, 264, 332, 264) - STROKE / 2;
      const line2 = sdSegment(x, y, 168, 316, 302, 316) - STROKE / 2;
      if (Math.min(chevron, line1, line2) <= 0) color = INK;

      if (Math.hypot(x - 364, y - 320) <= 21) color = GREEN;

      if (color) {
        accum[index] += color[0];
        accum[index + 1] += color[1];
        accum[index + 2] += color[2];
        accum[index + 3] += 1;
      }
    }
  }

  // 每像素归一化（超采样已在同一 index 上累加，除以采样数）
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const samples = SS * SS;
  for (let i = 0; i < out.length; i += 4) {
    out[i] = Math.round(accum[i] / samples);
    out[i + 1] = Math.round(accum[i + 1] / samples);
    out[i + 2] = Math.round(accum[i + 2] / samples);
    out[i + 3] = Math.round(Math.min(1, accum[i + 3] / samples) * 255);
  }
  return out;
}

/* ---------- PNG 编码 ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const output = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, encodePng(render()));
console.log(`已生成 ${output}`);
