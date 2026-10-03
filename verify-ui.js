#!/usr/bin/env node
"use strict";

/**
 * 渲染层离线校验（verify-ui.js）。
 *
 * 为什么需要它：Electron 的 GUI 初始化在某些受限环境里跑不起来（开发中就遇到了
 * `app.whenReady()` 永不返回），headless 浏览器也可能不可用。但界面代码里最容易出
 * 的 bug 是**静态可查的**：
 *   1. app.js 里 getElementById("x") 而 HTML 里没有 id="x"（点一下就白屏/报错）
 *   2. index.html 引用了不存在的脚本文件
 *   3. app.js 在初始化路径上抛异常
 *
 * 所以这里做三件事：结构交叉校验 + 用最小 DOM mock 把 app.js 真跑一遍 + 检查错误提示。
 *
 * 用法：npm run test:ui
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "src", "renderer");
const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");

const failures = [];
const checks = [];
const skipped = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label}${detail ? " —— " + detail : ""}`);
}

/* ---------- 1. 脚本引用是否都存在 ---------- */
const scriptSrcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
check("index.html 至少引用一个脚本", scriptSrcs.length > 0);
for (const src of scriptSrcs) {
  check(`脚本文件存在：${src}`, fs.existsSync(path.join(RENDERER, src)));
}

/* ---------- 0. 文件编码检查（BOM + 乱码） ---------- */
// 为什么查这个：用 PowerShell 的 `Set-Content -Encoding UTF8` 写文件有两个坑 ——
//   1. 会悄悄加上 BOM（EF BB BF），让 GitHub Actions 解析 workflow YAML 失败
//   2. 更严重：会把已有的 UTF-8 中文当成 ANSI 重新编码，整个文件变成乱码
// 这两种都肉眼不容易发现（第一种完全不可见，第二种在编辑器里才看得出来），
// 而且都会浪费一整轮 CI。所以变成自动断言。
const PROJECT_ROOT = path.join(__dirname);
const BOM_SENSITIVE = [
  ".github/workflows/build-windows.yml",
  "package.json",
  "README.md",
  ".gitignore",
  ".gitattributes",
  "docs/发布流程.md",
  "docs/安装说明.md",
];
// 编码与仓库卫生规则都抽到了 src/repo-hygiene.js（纯函数，可被单元测试直接证伪）。
// 这里只负责"取数据 + 报告结果"。
const hygiene = require("./src/repo-hygiene");

for (const rel of BOM_SENSITIVE) {
  const full = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const buf = fs.readFileSync(full);
  check(`${rel} 不含 BOM`, !hygiene.hasBom(buf), "检测到 EF BB BF，会导致 GitHub Actions 解析失败");
}

// 乱码检测。注意：不要用 PowerShell 的 Get-Content 判断编码 ——
// PS 5.1 会用系统 ANSI 代码页读 UTF-8 文件，干净的文件在终端里会显示成乱码
// （这个坑踩过，差点去"修"一个没坏的文件）。判断编码请用 node 或 read 工具。
const CHECK_ENCODING = [
  ".github/workflows/build-windows.yml",
  ".gitignore",
  "README.md",
  "docs/发布流程.md",
  "docs/安装说明.md",
  "src/core/guides.js",
];
for (const rel of CHECK_ENCODING) {
  const full = path.join(PROJECT_ROOT, rel);
  if (!fs.existsSync(full)) continue;
  const r = hygiene.scanEncoding(fs.readFileSync(full, "utf8"));
  check(
    `${rel} 中文未乱码（已知标记）`,
    r.markers.length === 0,
    `发现乱码字符 ${r.markers.join(" ")} —— 文件被以错误编码重写过`
  );
  if (r.hanCount >= 300) {
    check(
      `${rel} 中文可读（含常见字）`,
      !r.statsSuspect,
      `中文 ${r.hanCount} 字却几乎不含高频常用字（命中 ${r.commonHits}/10），疑为编码损坏`
    );
  }
  check(`${rel} 无解码失败字符`, r.replacementCount === 0, `出现 ${r.replacementCount} 个 U+FFFD`);
}

/* ---------- 0.9 公开仓库里不应出现本机专属信息 ---------- */
// 开发时的笔记很容易带上本机绝对路径（F:\...、C:\Users\...），
// 推到公开仓库后对别人毫无意义，还暴露了开发环境。
const PUBLIC_FILES = [
  "README.md",
  "LICENSE",
  "docs/安装说明.md",
  "docs/发布流程.md",
  ".github/workflows/build-windows.yml",
];
{
  const entries = [];
  for (const rel of PUBLIC_FILES) {
    const full = path.join(PROJECT_ROOT, rel);
    if (!fs.existsSync(full)) continue;
    entries.push([rel, fs.readFileSync(full, "utf8")]);
  }
  const r = hygiene.scanLocalPaths(entries);
  for (const f of r.findings) {
    check(`${f.file} 不含本机绝对路径`, false, `${f.hits.join("；")} —— 公开仓库里不应包含本机专属路径`);
  }
  check(`公开文件不含本机绝对路径（检查了 ${entries.length} 个文件）`, r.ok);
}

// docs/ 下只应有面向用户的文档。内部工作笔记（开发计划、访谈记录、调研笔记、
// 交接笔记）留在本地 —— 对 clone 项目的人没有价值，还可能带开发环境痕迹。
//
// 判断依据必须是 **git 的追踪状态**，不能用目录列表：本机的 docs/ 里确实还留着
// 这些笔记文件（它们被 .gitignore 排除、不会提交），用目录列表会误判成违规。
//
// 踩过的坑（规则本身已抽到 src/repo-hygiene.js 并被单元测试覆盖）：
//   1. Node 直接 spawn git 在受限环境会 EPERM。原先的 catch 把它吞成 null，
//      导致这条检查在本地被静默跳过 —— 看到的是"假通过"。现在改为明确报告跳过。
//   2. git 默认转义非 ASCII 路径（docs/\345\217\221...），必须加 core.quotepath=false，
//      否则合法文档会被误报。这个 bug 是 CI 抓到的。
function listTrackedDocs() {
  const { execFileSync } = require("node:child_process");
  let lastError = "";
  const attempts = [
    { args: ["-c", "core.quotepath=false", "ls-files", "-z", "docs"], shell: true },
    { args: ["-c", "core.quotepath=false", "ls-files", "docs"], shell: false },
  ];
  for (const a of attempts) {
    try {
      const out = execFileSync("git", a.args, {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15000,
        shell: a.shell,
      });
      return out.split("\0").join("\n").split("\n").map((s) => s.trim()).filter(Boolean);
    } catch (err) {
      lastError = String((err && err.message) || err).split("\n")[0];
    }
  }
  return { error: lastError };
}

const docsResult = listTrackedDocs();
if (Array.isArray(docsResult)) {
  // 规则本身在 src/repo-hygiene.js 里，这里只喂数据并报告
  check(
    "docs/ 检查确实读到了被跟踪的文件（避免空列表假通过）",
    hygiene.isDocsCheckMeaningful(docsResult),
    `只读到 ${docsResult.length} 个：${docsResult.join(", ")}`
  );
  const r = hygiene.checkDocsScope(docsResult);
  check("docs/ 下没有被跟踪的内部工作文档", r.ok, r.message);
} else {
  // 取不到数据就明确报告"这项没跑"，但**不让整个验证失败** ——
  // npm run verify 是发布前的硬门槛，如果本地永远红，它就会失去意义（人会开始忽略它）。
  // 规则逻辑由 test/repo-hygiene.test.js 覆盖，CI 上这里会正常执行。
  skipped.push(`docs/ 范围检查（无法调用 git：${docsResult.error}）`);
}

// workflow 的 YAML 基本结构（缩进用空格、必须有 on/jobs、步骤未被压成一行）
const wfPath = path.join(PROJECT_ROOT, ".github/workflows/build-windows.yml");
if (fs.existsSync(wfPath)) {
  const wf = fs.readFileSync(wfPath, "utf8");
  check("workflow 用空格缩进（YAML 禁止 tab）", !/\t/.test(wf));
  check("workflow 有 on: 触发器", /^on:/m.test(wf));
  check("workflow 有 jobs:", /^jobs:/m.test(wf));
  check("workflow 在 tag 上触发", /tags:/.test(wf) && /"v\*"/.test(wf));
  check("workflow 步骤已换行（未被压成一行）", /steps:\r?\n\s+- /.test(wf), "可能被错误重写导致换行丢失");
  check(
    "NSIS 打包步骤允许失败（不拖累绿色版）",
    /continue-on-error:\s*true/.test(wf),
    "否则 electron-builder 一失败，绿色版也打不出来"
  );
  check("绿色版打包排在 NSIS 之前", wf.indexOf("pack:zip") < wf.indexOf("pack:win:ci"));
}

/* ---------- 2. CSS 引用 ---------- */
const cssHref = [...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]);
for (const href of cssHref) {
  check(`样式文件存在：${href}`, fs.existsSync(path.join(RENDERER, href)));
}

/* ---------- 3. getElementById 的 id 必须存在于 HTML ---------- */
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const jsFiles = ["app.js", "browser-shim.js"];
const referencedIds = new Set();
for (const file of jsFiles) {
  const code = fs.readFileSync(path.join(RENDERER, file), "utf8");
  // 匹配 $("xxx") 与 getElementById("xxx")
  for (const m of code.matchAll(/\$\("([^"]+)"\)/g)) referencedIds.add(m[1]);
  for (const m of code.matchAll(/getElementById\("([^"]+)"\)/g)) referencedIds.add(m[1]);
}
for (const id of [...referencedIds].sort()) {
  check(`app.js 引用的 id 在 HTML 中存在：#${id}`, htmlIds.has(id));
}
check("HTML 里的关键 id 全覆盖（总数合理）", htmlIds.size >= 20, `实际 ${htmlIds.size} 个`);

/* ---------- 4. 用最小 DOM mock 真跑一遍 app.js ---------- */

// 记录解析错误：如果 app.js 或 shim 有语法错误，这里会捕获
const parseErrors = [];

function makeElement(tag, id) {
  const el = {
    tagName: tag,
    id: id || "",
    _text: "",
    _html: "",
    value: "",
    dataset: {},
    classList: {
      _set: new Set(),
      add(...c) { c.forEach((x) => this._set.add(x)); },
      remove(...c) { c.forEach((x) => this._set.delete(x)); },
      toggle(c, force) { (force === undefined ? !this._set.has(c) : force) ? this._set.add(c) : this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    style: {},
    children: [],
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    reset() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  return el;
}

const elements = new Map();
for (const id of htmlIds) elements.set(id, makeElement("div", id));

// 给表格/表单元素补上 name 属性访问（app.js 里用了 form.name 这类写法）
const manualForm = elements.get("tabManual");
if (manualForm) {
  for (const n of ["name", "amount", "currency", "cycle", "category", "startDate", "note"]) {
    manualForm[n] = makeElement("input");
    manualForm[n].value = n === "startDate" ? "2026-10-01" : n === "amount" ? "25" : n === "name" ? "测试" : "";
  }
  manualForm.reset = () => {
    for (const n of ["name", "amount", "note"]) manualForm[n].value = "";
  };
}

const toasts = [];
const errors = [];

let store = { subscriptions: [] };
const sandbox = {
  console: {
    log: () => {},
    info: () => {},
    warn: (m) => errors.push("warn: " + m),
    error: (...a) => errors.push("error: " + a.map(String).join(" ")),
  },
  setTimeout,
  clearTimeout,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Promise,
  Error,
  RegExp,
  Blob: class { constructor() {} },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  navigator: { clipboard: { writeText: async () => {} } },
  confirm: () => true,
  localStorage: {
    getItem: () => null,
    setItem: (k, v) => { store = JSON.parse(v); },
    removeItem: () => {},
  },
  document: {
    body: makeElement("body"),
    documentElement: makeElement("html"),
    getElementById: (id) => {
      if (!elements.has(id)) {
        errors.push(`getElementById 找不到元素：#${id}`);
        return null;
      }
      return elements.get(id);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: (tag) => makeElement(tag),
  },
  window: null,
};

sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.open = () => {};
sandbox.window.addEventListener = () => {};

// 渲染观察点：断言"用户实际看到了什么"，而不是只检查代码里有没有某个字符串
const renders = [];
sandbox.__renderRecorder = (kind, payload) => renders.push({ kind, payload });

const context = vm.createContext(sandbox);

function runFile(file) {
  const full = path.join(RENDERER, file);
  const code = fs.readFileSync(full, "utf8");
  try {
    new vm.Script(code, { filename: file }).runInContext(context);
    return true;
  } catch (err) {
    parseErrors.push(`${file}: ${err.message}`);
    return false;
  }
}

// core.bundle 必须先加载（shim 依赖 window.subwatchCore）
check("core.bundle.js 加载成功", runFile("core.bundle.js"));
check("browser-shim.js 加载成功", runFile("browser-shim.js"));
check("app.js 加载成功", runFile("app.js"));

/* ---------- 5. 等 boot() 的异步流程跑完，检查结果 ---------- */
(async () => {
  await new Promise((r) => setTimeout(r, 250));

  check("app.js / shim 无语法或加载错误", parseErrors.length === 0, parseErrors.join(" | "));
  check("渲染层没有触发 console.error", errors.filter((e) => e.startsWith("error")).length === 0, errors.join(" | "));

  // 空库时应显示空状态、隐藏列表
  check("空库时显示空状态", elements.get("emptyState").classList.contains("hidden") === false);
  check("空库时隐藏列表", elements.get("listSection").classList.contains("hidden") === true);

  // 预设网格必须被填充 —— 这是"60 秒录入第一条"的关键
  const gridEmpty = elements.get("presetGridEmpty").innerHTML;
  const grid = elements.get("presetGrid").innerHTML;
  check("空状态预设网格已渲染", gridEmpty.includes("preset"), `长度 ${gridEmpty.length}`);
  check("弹层预设网格已渲染", grid.includes("preset"), `长度 ${grid.length}`);
  check("预设网格包含分类标题", gridEmpty.includes("preset-group-title"));
  check("预设网格覆盖多个分类", (gridEmpty.match(/preset-group-title/g) || []).length >= 5);
  check(
    "预设按钮数量合理（>=30）",
    (gridEmpty.match(/data-preset=/g) || []).length >= 30,
    `实际 ${(gridEmpty.match(/data-preset=/g) || []).length}`
  );

  // 汇总栏应被填入真实数字而不是占位符
  const count = elements.get("totalCount").textContent;
  const monthly = elements.get("totalMonthly").textContent;
  check("订阅数已填充数字", /^\d+$/.test(count), `实际 "${count}"`);
  check("月支出已填充金额", /^¥/.test(monthly), `实际 "${monthly}"`);

  // 退订相关的元素必须存在
  for (const id of [
    "pendingBanner", "guideModal", "guideBody", "guideTitle",
    "btnMarkCanceled", "btnMarkUncanceled", "btnActionBack",
    "actionModal", "actionTitle", "actionSubtitle", "actionChoices",
  ]) {
    check(`退订相关元素存在：#${id}`, htmlIds.has(id));
  }

  // 一级动作选择必须是"四个带说明的选项"，不能退化回 confirm（用户明确反馈过）
  const internals = sandbox.window.__appInternals;
  check("app 暴露了可断言的内部方法", Boolean(internals && internals.buildChoices));

  if (internals && internals.buildChoices) {
    const choices = internals.buildChoices({});
    check("一级选项数量为 4", choices.length === 4, `实际 ${choices.length}`);
    const ids = choices.map((c) => c.id).sort();
    check("一级选项覆盖 4 个动作", JSON.stringify(ids) === JSON.stringify(["canceled", "delete", "guide", "pending"]), ids.join(","));
    for (const c of choices) {
      check(`选项「${c.id}」有标签`, typeof c.label === "string" && c.label.length > 0);
      check(`选项「${c.id}」有说明文字`, typeof c.desc === "string" && c.desc.length >= 10, `实际 "${c.desc}"`);
    }
    const del = choices.find((c) => c.id === "delete");
    check("删除选项说明了「不会替你取消订阅」", /不会替你取消|只删掉本地/.test(del.desc));
    check("删除选项被标为危险操作", del.danger === true);
    const guide = choices.find((c) => c.id === "guide");
    check("默认主推「告诉我怎么退」", guide.primary === true);

    const pendingChoices = internals.buildChoices({ isPending: true, alreadyDone: false });
    check("已标「还没退」时按钮文案会变化", pendingChoices.find((c) => c.id === "pending").label.includes("仍然"));
    const doneChoices = internals.buildChoices({ isPending: false, alreadyDone: true });
    check("已退订时不再主推指引", doneChoices.find((c) => c.id === "guide").primary === false);
    check("已退订时按钮显示完成态", doneChoices.find((c) => c.id === "canceled").label.includes("✓"));
  }

  // 真实跑一次 openActions，确认它没有抛错并填充了 DOM
  if (internals && internals.openActions) {
    try {
      internals.openActions("__nonexistent__");
      check("openActions 对不存在的 id 安全返回", true);
    } catch (err) {
      check("openActions 对不存在的 id 安全返回", false, err.message);
    }
  }

  // core 必须导出退订指引能力，否则界面点「退订」会拿不到数据
  check("core 导出 getGuide", typeof sandbox.window.subwatchCore.getGuide === "function");
  const guide = sandbox.window.subwatchCore.getGuide({ name: "优酷VIP" });
  check("getGuide 命中具体服务", Boolean(guide.matched));
  check("getGuide 返回签约通道入口", Array.isArray(guide.entryPoints) && guide.entryPoints.length >= 5);
  check("getGuide 带核心原则提示", Boolean(guide.principle && guide.principle.detail));
  check("getGuide 带试用期提醒", Boolean(guide.trialNotice && guide.trialNotice.detail));
  check("无匹配时也给入口", sandbox.window.subwatchCore.getGuide({ name: "没听过的服务" }).entryPoints.length >= 5);

  // 空库时两条横幅都不该出现
  check("空库时隐藏待处理横幅", elements.get("pendingBanner").classList.contains("hidden") === true);
  check("空库时隐藏到期横幅", elements.get("dueBanner").classList.contains("hidden") === true);

  // 周期下拉框必须与 core 支持的周期一致
  const cycleHtml = elements.get("selCycle").innerHTML;
  const coreCycles = sandbox.window.subwatchCore.CYCLE_MONTHS;
  for (const c of Object.keys(coreCycles)) {
    check(`周期下拉包含 ${c}`, cycleHtml.includes(`value="${c}"`));
  }

  /* ---------- 输出 ---------- */
  console.log("");
  for (const c of checks) {
    if (!c.ok) console.log(`✖ ${c.label}${c.detail ? " —— " + c.detail : ""}`);
  }
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n渲染层校验：${passed}/${checks.length} 通过`);
  if (skipped.length > 0) {
    console.log(`\n以下检查在本环境被跳过（CI 上会执行）：`);
    for (const s of skipped) console.log(`  · ${s}`);
  }
  if (failures.length > 0) {
    console.log(`\n失败项：\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log(skipped.length > 0 ? "\n通过 ✅（含跳过的检查）" : "全部通过 ✅");
  }
})();
