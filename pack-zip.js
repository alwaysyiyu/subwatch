#!/usr/bin/env node
"use strict";

/**
 * 把绿色版目录压缩成可分发的 zip。
 *
 * 注意：不用 Node 的库去压缩（会引入依赖），而是调用 PowerShell 的 Compress-Archive。
 * 用 `execFileSync` + `stdio: "inherit"`（**不接管管道**），避免在受限环境里触发
 * `spawn EPERM`。
 *
 * 用法：npm run pack:zip（会先跑 pack:portable）
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = __dirname;
const pkg = require(path.join(ROOT, "package.json"));
const VERSION = pkg.version;
const APP_NAME = "subwatch";
const STAGE = path.join(ROOT, "release", `${APP_NAME}-portable`);
// 注意文件名：不能和 electron-builder 的 artifactName（subwatch-<ver>-x64.zip）撞名，
// 否则本脚本开头的"删除同名文件"会把 electron-builder 打的 zip 静默覆盖掉，
// Release 上就只剩一个（而且是手工那个）。
const ZIP = path.join(ROOT, "release", `${APP_NAME}-${VERSION}-x64-portable.zip`);

function main() {
  if (!fs.existsSync(path.join(STAGE, `${APP_NAME}.exe`))) {
    console.error(`找不到绿色版目录：${STAGE}\n请先运行 npm run pack:portable`);
    process.exit(1);
  }

  // 把修复脚本也放进去，用户遇到启动问题可以自救
  const fixBat = path.join(ROOT, "packaging", "修复启动问题.bat");
  if (fs.existsSync(fixBat)) {
    fs.copyFileSync(fixBat, path.join(STAGE, "修复启动问题.bat"));
    console.log("[pack:zip] 已加入「修复启动问题.bat」");
  }

  if (fs.existsSync(ZIP)) fs.rmSync(ZIP);

  console.log("[pack:zip] 正在压缩（约 370MB，需要一两分钟）…");
  // 压缩目录内容本身，而不是外层目录 —— 用户解压后直接看到 subwatch.exe
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${ZIP}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: "inherit" }
  );

  const sizeMB = fs.statSync(ZIP).size / 1024 / 1024;
  console.log(`[pack:zip] 完成：${ZIP}`);
  console.log(`[pack:zip]   大小：${sizeMB.toFixed(0)} MB`);
  console.log("");
  console.log("分发时请一并说明：");
  console.log("  1. 解压后双击 subwatch.exe");
  console.log("  2. 若没反应，右键「修复启动问题.bat」→ 以管理员身份运行");
  console.log("  3. 首次运行 Windows 提示「已保护你的电脑」→ 更多信息 → 仍要运行（未购买代码签名证书）");
}

main();
