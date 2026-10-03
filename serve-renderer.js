#!/usr/bin/env node
"use strict";

/**
 * 极简静态服务器，用于"浏览器预览模式"调试界面。
 *
 * 为什么需要它：渲染层除了 index.html 之外没有别的依赖，用 file:// 打开也能跑，
 * 但 file:// 下 localStorage / clipboard 的权限行为与桌面版差异较大，
 * 用 http:// 更接近真实环境。
 *
 * 用法：npm run start:browser
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "src", "renderer");
const PORT = Number(process.env.PORT || 5173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(ROOT, rel);

  // 目录穿越防护：请求路径必须落在 ROOT 内
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found: " + rel);
      return;
    }
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`浏览器预览：http://127.0.0.1:${PORT}/`);
  console.log("数据存在 localStorage，与桌面版共用同一套 core 逻辑。");
});
