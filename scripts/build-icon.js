#!/usr/bin/env node
"use strict";

/**
 * 生成 build/icon.ico（打包用）。
 *
 * 为什么不把 .ico 直接提交进仓库：二进制资源在 git 里不可读、不可 review，
 * 而这个图标足够简单，用代码生成更透明，也方便以后改配色。
 *
 * ICO 格式很简单：一个目录头 + N 个条目的目录表 + 各尺寸的 PNG 数据。
 * Windows 从 Vista 起支持在 ICO 里内嵌 PNG，所以这里直接复用 icon.js 的 PNG 生成器。
 *
 * 用法：npm run build:icon（或由 prepack 自动调用）
 */

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { buildPng } = require("../src/main/icon");

const OUT_DIR = path.join(__dirname, "..", "build");
const OUT_FILE = path.join(OUT_DIR, "icon.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

/** 按目标尺寸重新绘制（icon.js 的生成器目前固定 32×32，这里做缩放） */
function pngAtSize(size) {
  if (size === 32) return buildPng();

  // 先拿到 32×32 的像素，再用最近邻放大/缩小，避免引入图像库依赖
  const { buildPixels, SIZE } = require("../src/main/icon");
  const src = buildPixels();
  const out = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const sx = Math.min(SIZE - 1, Math.floor((x * SIZE) / size));
      const sy = Math.min(SIZE - 1, Math.floor((y * SIZE) / size));
      const si = (sy * SIZE + sx) * 4;
      const di = (y * size + x) * 4;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
      out[di + 3] = src[si + 3];
    }
  }
  return encodePng(out, size);
}

/** 把 RGBA 像素编码成 PNG（与 icon.js 同套逻辑，支持任意尺寸） */
function encodePng(pixels, size) {
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();

  function crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
    return (crc ^ -1) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 组装 ICO */
function buildIco(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];

  entries.forEach((e, i) => {
    const base = i * 16;
    dir[base] = e.size >= 256 ? 0 : e.size; // 256 用 0 表示
    dir[base + 1] = e.size >= 256 ? 0 : e.size;
    dir[base + 2] = 0; // 调色板数
    dir[base + 3] = 0; // reserved
    dir.writeUInt16LE(1, base + 4); // color planes
    dir.writeUInt16LE(32, base + 6); // bits per pixel
    dir.writeUInt32LE(e.data.length, base + 8);
    dir.writeUInt32LE(offset, base + 12);
    offset += e.data.length;
    blobs.push(e.data);
  });

  return Buffer.concat([header, dir, ...blobs]);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entries = SIZES.map((size) => ({ size, data: pngAtSize(size) }));
  const ico = buildIco(entries);
  fs.writeFileSync(OUT_FILE, ico);

  console.log(
    `已生成 ${path.relative(process.cwd(), OUT_FILE)}（${ico.length} 字节，含 ${SIZES.join("/")} 共 ${SIZES.length} 个尺寸）`
  );
}

main();
