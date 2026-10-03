#!/usr/bin/env node
"use strict";

/**
 * 开发启动器。
 *
 * 为什么需要它（真实的 Windows 问题，不是环境洁癖）：
 *   Electron 在 Windows 上会用 AppContainer 令牌启动渲染进程，而渲染进程必须能读
 *   自己的安装目录（node_modules/electron/dist）。如果这个目录没有给
 *   ALL APPLICATION PACKAGES 读权限，Electron 会直接 FATAL 退出：
 *
 *     Sandboxed processes cannot read ...\node_modules\electron\dist:
 *     its ACL has an entry for an AppContainer package SID but none for
 *     ALL APPLICATION PACKAGES
 *
 *   把项目放在非系统盘（例如 F:\）的普通目录下时很容易命中。两个解法：
 *     A. 给目录授权：icacls "<dist>" /grant *S-1-15-2-1:(OI)(CI)(RX)
 *     B. 开发期用 --no-sandbox 启动（本脚本采用的方案）
 *
 * 这是**开发期**的取舍：装包后（electron-builder 产物）不需要它，因为打包后的
 * 目录布局与 ACL 不同。所以这个开关只写在开发脚本里，绝不写进应用代码。
 *
 * 用法：npm start
 */

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const electronBinary = require("electron");

if (!fs.existsSync(electronBinary)) {
  console.error("找不到 Electron 二进制，先运行：npm install");
  process.exit(1);
}

const args = [".", "--no-sandbox", ...process.argv.slice(2)];

console.log(`启动 subwatch（${path.basename(electronBinary)} ${args.join(" ")}）`);

const child = spawn(electronBinary, args, {
  cwd: path.join(__dirname),
  stdio: "inherit", // 关键：inherit 而不是 pipe，否则会碰到命名管道受限的环境
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) console.log(`Electron 被信号终止：${signal}`);
  process.exit(code == null ? 0 : code);
});

child.on("error", (err) => {
  console.error("启动 Electron 失败：", err.message);
  console.error('如果报 ACL/AppContainer 相关错误，试试：icacls "' + path.dirname(electronBinary) + '" /grant *S-1-15-2-1:(OI)(CI)(RX)');
  process.exit(1);
});
