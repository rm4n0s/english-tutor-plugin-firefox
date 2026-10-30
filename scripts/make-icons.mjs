// Draws the extension icons (src/icons/icon-<size>.png) with no dependencies.
// Run it with `node scripts/make-icons.mjs` after changing the design; the PNG
// files are committed, and the build only copies them.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SIZES = [16, 32, 48, 96];
const SUPERSAMPLE = 4;
const outDir = fileURLToPath(new URL("../src/icons/", import.meta.url));

// Shapes are in a 100 x 100 design space.
const BLUE = [0x00, 0x72, 0xb2];
const WHITE = [0xff, 0xff, 0xff];
const ORANGE = [0xff, 0x8a, 0x4c];

function colorAt(x, y) {
  // Rounded square background.
  const r = 20;
  const cx = Math.min(Math.max(x, r), 100 - r);
  const cy = Math.min(Math.max(y, r), 100 - r);
  if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) return null;
  // The letter E: a stem and three arms.
  const stem = x >= 28 && x <= 40 && y >= 20 && y <= 70;
  const arm = (y0) => x >= 28 && x <= 72 && y >= y0 && y <= y0 + 10;
  if (stem || arm(20) || arm(40) || arm(60)) return WHITE;
  // A wavy underline, as the editor draws for grammar errors.
  const waveY = 82 + 3.5 * Math.sin((x - 20) / 5.5);
  if (x >= 20 && x <= 80 && Math.abs(y - waveY) <= 3) return ORANGE;
  return BLUE;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const n = SUPERSAMPLE;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;
      for (let sy = 0; sy < n; sy++) {
        for (let sx = 0; sx < n; sx++) {
          const x = ((px + (sx + 0.5) / n) / size) * 100;
          const y = ((py + (sy + 0.5) / n) / size) * 100;
          const c = colorAt(x, y);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            covered++;
          }
        }
      }
      const o = (py * size + px) * 4;
      if (covered > 0) {
        pixels[o] = Math.round(r / covered);
        pixels[o + 1] = Math.round(g / covered);
        pixels[o + 2] = Math.round(b / covered);
      }
      pixels[o + 3] = Math.round((covered / (n * n)) * 255);
    }
  }
  return pixels;
}

const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  writeFileSync(`${outDir}icon-${size}.png`, png(size, render(size)));
}
console.log(`wrote ${SIZES.length} icons to ${outDir}`);
