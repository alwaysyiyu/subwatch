"use strict";

const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

/**
 * 用代码生成应用图标，避免往仓库里塞二进制资源。
 *
 * 输出：一个 32×32 的 PNG —— "深色圆角底 + 亮色 ¥ 形"。
 * 为什么自己搓 PNG 而不是内置 base64：二进制资源在 git 里不可读、
 * 不可 review，而这个图标足够简单，代码生成更透明。
 */

const SIZE = 32;

/** 生成 RGBA 像素缓冲 */
function buildPixels() {
  const px = Buffer.alloc(SIZE * SIZE * 4);
  const cx = (SIZE - 1) / 2;
  const cy = (SIZE - 1) / 2;
  const radius = 15;
  const bg = [32, 34, 40, 255]; // 近黑
  const fg = [120, 220, 160, 255]; // 青绿，和"省钱"语义相符

  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const i = (y * SIZE + x) * 4;
      const dist = Math.hypot(x - cx, y - cy);
      // 圆形之外留透明，托盘上更好看
      const inside = dist <= radius;
      if (!inside) {
        px[i] = 0;
        px[i + 1] = 0;
        px[i + 2] = 0;
        px[i + 3] = 0;
        continue;
      }
      // 画一个简化的 "¥"：两条斜线 + 两条横线 + 一条竖线
      const isSlash =
        (Math.abs(y - (x - 8) - 2) <= 1 || Math.abs(y + (x - 8) - 42) <= 1) && y >= 8 && y <= 18;
      const isBar = (y === 16 || y === 20) && x >= 10 && x <= 22;
      const isStem = Math.abs(x - cx) <= 1 && y >= 18 && y <= 25;
      const [r, g, b] = isSlash || isBar || isStem ? fg : bg;
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return crc ^ -1;
}

/** 生成 PNG Buffer */
function buildPng() {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const pixels = buildPixels();
  // 每行前面加一个 filter byte(0)
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
  for (let y = 0; y < SIZE; y += 1) {
    const rowStart = y * (SIZE * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
  }

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 把图标写盘并返回路径（Electron 的 Tray 需要文件路径或 NativeImage）。
 * 写到 userData 目录，不污染项目目录。
 */
function ensureIconFile(userDataDir) {
  const target = path.join(userDataDir, "icon.png");
  if (!fs.existsSync(target)) {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(target, buildPng());
  }
  return target;
}

module.exports = { buildPng, buildPixels, ensureIconFile, SIZE };
