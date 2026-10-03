#!/usr/bin/env node
"use strict";

/**
 * 测试入口。
 *
 * 为什么不用 `node --test`：它需要 spawn 子进程来跑每个测试文件，而当前沙箱
 * 禁止程序打开命名管道，会报 `spawn EPERM`。这里改为在主进程内直接 require
 * 每个测试文件（node:test 的注册与执行都不需要子进程），保持同样的断言与输出。
 *
 * 注意：为了拿到真实结果，必须先等 `node:test` 跑完再决定退出码，
 * 否则「有没有失败」会被误判成成功。
 *
 * 用法：npm test
 */

const fs = require("node:fs");
const path = require("node:path");
const { run } = require("node:test");

const testDir = path.join(__dirname, "test");
const files = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.js"))
  .sort();

if (files.length === 0) {
  console.error("没有找到测试文件");
  process.exit(1);
}

// 先注册所有测试（require 只做注册，不执行）
for (const file of files) {
  require(path.join(testDir, file));
}

const stream = run({ concurrency: 1, files: [] });

let passed = 0;
let failed = 0;
const failedNames = [];

stream.on("test:pass", (data) => {
  if (data && data.skip) return;
  passed += 1;
});
stream.on("test:fail", (data) => {
  failed += 1;
  if (data && data.name) failedNames.push(data.name);
});

stream.on("end", () => {
  console.log("");
  console.log(`测试文件：${files.length} 个（${files.join(", ")}）`);
  console.log(`通过：${passed}　失败：${failed}`);
  if (failed > 0) {
    console.log(`失败的用例：\n  - ${failedNames.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✅");
  }
});
