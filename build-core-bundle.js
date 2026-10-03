#!/usr/bin/env node
"use strict";

/**
 * 把 src/core/*.js（CommonJS）打包成渲染层可用的 core.bundle.js。
 *
 * 为什么不直接把 core 改成 ESM 或在渲染层重复实现一遍：
 *   - core 用 CommonJS 是为了能在纯 node 下被 require 并跑单元测试；
 *   - 真的重复实现一份，迟早在两个版本之间产生行为差异（日期边界尤其危险）。
 * 所以保持单一来源，用一个 20 行的构建脚本生成浏览器版本。
 *
 * 用法：npm run build
 */

const fs = require("node:fs");
const path = require("node:path");

const coreDir = path.join(__dirname, "src", "core");
const outFile = path.join(__dirname, "src", "renderer", "core.bundle.js");

const MODULES = ["renewal.js", "reminder.js", "presets.js", "guides.js"];

const parts = [];
parts.push("/* 自动生成，请勿直接编辑。");
parts.push(" * 来源：src/core/{renewal,reminder,presets}.js");
parts.push(" * 生成命令：npm run build");
parts.push(" */");
parts.push("(function () {");
parts.push('  "use strict";');
parts.push("  var __cache = {};");
parts.push("  function __require(name) {");
parts.push("    if (__cache[name]) return __cache[name].exports;");
parts.push("    var module = { exports: {} };");
parts.push("    __cache[name] = module;");
parts.push("    __impl[name](module, module.exports, __require);");
parts.push("    return module.exports;");
parts.push("  }");
parts.push("  var __impl = {};");

for (const file of MODULES) {
  const full = path.join(coreDir, file);
  if (!fs.existsSync(full)) throw new Error(`缺少源文件：${full}`);
  const code = fs.readFileSync(full, "utf8");

  // 把 require("./renewal") 映射到 bundle 内部的模块名
  const wrapped = code.replace(/require\(["']\.\/([\w.-]+)["']\)/g, (_m, name) => {
    return `__require("${name}")`;
  });

  parts.push(`  __impl[${JSON.stringify(file.replace(/\.js$/, ""))}] = function (module, exports, __require) {`);
  parts.push(wrapped);
  parts.push("  };");
}

// 对外暴露为 window.subwatchCore
parts.push("  var api = {};");
for (const name of ["renewal", "reminder", "presets", "guides"]) {
  parts.push(`  Object.assign(api, __require(${JSON.stringify(name)}));`);
}
parts.push("  window.subwatchCore = api;");
parts.push("})();");
parts.push("");

fs.writeFileSync(outFile, parts.join("\n"), "utf8");

const size = fs.statSync(outFile).size;
console.log(`已生成 ${path.relative(process.cwd(), outFile)}（${size} 字节）`);
