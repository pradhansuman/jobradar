/* gen-icons.js — generates extension icons (16/48/128 PNG) without any dependencies.
 * Draws a rounded diamond "◈" radar mark: solid disc + white diamond + green pulse ring.
 * Usage: node scripts/gen-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, draw) {
  const rows = [];
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = draw(x / (size - 1), y / (size - 1), size);
      const i = (y * size + x) * 4;
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
  }
  rows.push(Buffer.from([0])); // filter type 0 per row
  for (let y = 0; y < size; y++) rows.push(rgba.subarray(y * size * 4, (y + 1) * size * 4));
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const inDisc = (x, y, cx = 0.5, cy = 0.5, rad = 0.46) => (x - cx) ** 2 + (y - cy) ** 2 <= rad ** 2;
const inDiamond = (x, y, cx = 0.5, cy = 0.5, rad = 0.22) => Math.abs(x - cx) + Math.abs(y - cy) <= rad;
const inRing = (x, y, cx = 0.5, cy = 0.5, r1 = 0.40, r2 = 0.46) => {
  const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
  return d >= r1 && d <= r2;
};

function draw(x, y) {
  if (inRing(x, y)) return [34, 211, 165, 255];        // green pulse ring
  if (!inDisc(x, y)) return [0, 0, 0, 0];               // transparent outside
  if (inDiamond(x, y)) return [255, 255, 255, 255];     // white diamond core
  return [79, 140, 255, 255];                           // blue disc
}

const dir = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(dir, size + '.png'), png(size, draw));
  console.log('wrote extension/icons/' + size + '.png');
}
