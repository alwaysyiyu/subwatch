#!/usr/bin/env node
"use strict";

/**
 * 手工组装 Windows 绿色版。
 *
 * 为什么不用 electron-builder：
 *   它内部的两个步骤会 `spawn` 子进程并接管 stdio（原生模块重建、npm 模块收集），
 *   而当前开发沙箱禁止程序打开命名管道，会报 `spawn EPERM`。
 *   已用 `npmRebuild: false` 与 `electronDist` 绕过前两个，但"收集 node 模块"
 *   这一步绕不过去（除非改它的源码）。
 *
 * 为什么手工组装是可行且更可控的：
 *   本项目**零原生模块、零运行时依赖**（数据用 JSON、没有 sqlite、没有前端框架），
 *   所以不需要收集任何 node_modules、不需要重建、不需要打 asar——
 *   Electron 的标准"免安装"布局就是：把 app 目录放进 resources/app/ 即可。
 *   这恰好是当初"不引原生模块"这个决策带来的回报。
 *
 * 用法：npm run pack:portable
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = __dirname;
const OUT_ROOT = path.join(ROOT, "release");
const APP_NAME = "subwatch";
const pkg = require(path.join(ROOT, "package.json"));
const VERSION = pkg.version;

/** 需要打进 app 的东西（显式白名单，避免把测试/文档/缓存带进去） */
const APP_FILES = [
  "package.json",
  "src/main",
  "src/core",
  "src/preload",
  "src/renderer",
  "README.md",
];

function log(msg) {
  console.log(`[pack] ${msg}`);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  // 1. 确保 core bundle 是最新的（渲染层依赖它）
  log("生成 core bundle");
  execFileSync(process.execPath, [path.join(ROOT, "build-core-bundle.js")], { stdio: "inherit" });

  // 2. 找到 Electron 发行版
  //
  // 这一步在 CI 上是踩过的坑：`npm ci` 不一定会跑 electron 的 postinstall，
  // 于是 node_modules/electron/dist 根本不存在（只装了 npm 包本身）。
  // 本地也遇到过同样的事，当时是手动跑 install.js 补上的 —— 那次没把它固化进 CI。
  // 所以这里不再假设它存在，而是主动补装一次（幂等：已装好会直接退出）。
  const electronDist = path.join(ROOT, "node_modules", "electron", "dist");
  const electronExe = process.platform === "win32" ? "electron.exe" : "electron";
  if (!fs.existsSync(path.join(electronDist, electronExe))) {
    log("未找到 Electron 运行时，尝试自动补装（node_modules/electron/install.js）…");
    try {
      execFileSync(process.execPath, [path.join(ROOT, "node_modules", "electron", "install.js")], {
        stdio: "inherit",
        cwd: ROOT,
      });
    } catch (err) {
      log(`自动补装失败：${err && err.message}`);
    }
  }

  if (!fs.existsSync(path.join(electronDist, electronExe))) {
    // 报错里带上诊断信息，省得为了看一眼目录结构再跑一轮 CI
    let listing = "(目录不存在)";
    try {
      listing = fs.readdirSync(path.join(ROOT, "node_modules", "electron")).join(", ");
    } catch {
      /* 保持默认 */
    }
    throw new Error(
      [
        `找不到 Electron 运行时：${path.join(electronDist, electronExe)}`,
        "",
        "可能是以下原因之一：",
        "  1. npm install / npm ci 没有执行 electron 的 postinstall（最常见）",
        "     → 手动补一次：node node_modules/electron/install.js",
        "  2. 网络无法访问 Electron 二进制下载源",
        "     → 设置镜像：ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/",
        "",
        `node_modules/electron 目录内容：${listing}`,
      ].join("\n")
    );
  }
  log(`Electron 运行时就绪：${electronDist}`);

  // 3. 组装目录
  const stageDir = path.join(OUT_ROOT, `${APP_NAME}-portable`);
  log(`清理并重建 ${path.relative(ROOT, stageDir)}`);
  rmrf(stageDir);
  fs.mkdirSync(stageDir, { recursive: true });

  log("复制 Electron 运行时（约 370MB，需要一点时间）");
  copyDir(electronDist, stageDir);

  // Electron 的入口叫 electron.exe，改成产品名更像成品
  const renamedExe = path.join(stageDir, `${APP_NAME}.exe`);
  fs.renameSync(path.join(stageDir, "electron.exe"), renamedExe);

  // 4. 把 app 放进去
  const appDir = path.join(stageDir, "resources", "app");
  fs.mkdirSync(appDir, { recursive: true });
  for (const rel of APP_FILES) {
    const src = path.join(ROOT, rel);
    if (!fs.existsSync(src)) {
      log(`跳过不存在的：${rel}`);
      continue;
    }
    const dest = path.join(appDir, rel);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) copyDir(src, dest);
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  // 5. 写一份构建信息，便于排查"用户装的是哪个版本"
  fs.writeFileSync(
    path.join(stageDir, "BUILD-INFO.txt"),
    [
      `${APP_NAME} ${VERSION}`,
      `构建时间：${new Date().toISOString()}`,
      `Electron：${require(path.join(ROOT, "node_modules", "electron", "package.json")).version}`,
      "",
      "这是免安装绿色版：双击 subwatch.exe 直接运行，不需要安装。",
      "",
      "⚠️ 首次运行 Windows 可能提示「Windows 已保护你的电脑」，",
      "   因为本程序没有购买代码签名证书（150–300 美元/年）。",
      "   点「更多信息」→「仍要运行」即可。这与安全性无关。",
      "",
      "数据位置：%APPDATA%\\subwatch\\data.json",
      "卸载：直接删除本文件夹；数据文件不会自动删除，需要手动清理。",
      "",
    ].join("\n"),
    "utf8"
  );

  // 6. 统计与汇报
  const sizeMB = (p) => {
    let total = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(p);
    return total / 1024 / 1024;
  };

  const appSize = sizeMB(appDir);
  const totalSize = sizeMB(stageDir);
  log(`完成`);
  log(`  产物目录：${stageDir}`);
  log(`  app 代码：${appSize.toFixed(1)} MB`);
  log(`  含运行时：${totalSize.toFixed(0)} MB`);
  log(`  入口：${path.join(stageDir, APP_NAME + ".exe")}`);
  log("");
  log("下一步：压缩成 zip 分发，或运行 npm run pack:zip");
}

main();
