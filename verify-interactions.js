"use strict";

/**
 * 渲染层交互演练（verify-interactions.js）。
 *
 * 与 verify-ui.js 的区别：后者断言"选项数据正确"，这里真正**驱动界面**——
 * 造一条订阅、调用 openActions、检查 DOM 被填充成什么样，再走一遍「怎么退」二级弹层。
 *
 * 存在的理由：GUI 在本环境起不来（见 HANDOFF §0.4），这是唯一能验证
 * "点下去到底发生了什么"的手段。
 *
 * 用法：npm run test:interactions
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const RENDERER = path.join(__dirname, "src", "renderer");
const html = fs.readFileSync(path.join(RENDERER, "index.html"), "utf8");
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok });
  if (!ok) failures.push(`${label}${detail ? " —— " + detail : ""}`);
}

/* ---------- 最小 DOM ---------- */
function makeElement(tag, id) {
  const el = {
    tagName: tag,
    id: id || "",
    _text: "",
    _html: "",
    value: "",
    dataset: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, f) { (f === undefined ? !this._s.has(c) : f) ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    style: {},
    set textContent(v) { this._text = String(v); },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
    addEventListener() {}, focus() {}, reset() {}, closest() { return null; },
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
  return el;
}

const elements = new Map();
for (const id of htmlIds) elements.set(id, makeElement("div", id));

const manualForm = elements.get("tabManual");
for (const n of ["name", "amount", "currency", "cycle", "category", "startDate", "note"]) {
  manualForm[n] = makeElement("input");
  manualForm[n].value = "";
}
manualForm.reset = () => {};

const errors = [];
// 预置一条订阅：shim 在模块加载时就读 localStorage，所以必须在加载前塞好
let stored = [
  {
    id: "sub_seed_1",
    name: "优酷VIP",
    amount: 25,
    currency: "CNY",
    cycle: "monthly",
    category: "影音",
    startDate: "2026-10-01",
    autoRenew: true,
    note: "",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];
const sandbox = {
  console: { log() {}, info() {}, warn: (m) => errors.push("warn " + m), error: (...a) => errors.push("error " + a.join(" ")) },
  setTimeout, clearTimeout, Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Error, RegExp,
  navigator: { clipboard: { writeText: async () => {} } },
  confirm: () => true,
  localStorage: {
    getItem: () => JSON.stringify({ subscriptions: stored }),
    setItem: (_k, v) => { stored = JSON.parse(v).subscriptions; },
    removeItem: () => {},
  },
  document: {
    body: makeElement("body"),
    getElementById: (id) => elements.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: (t) => makeElement(t),
  },
  window: null,
  Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.open = () => {};
sandbox.window.addEventListener = () => {};
sandbox.__appInternals = {};

const context = vm.createContext(sandbox);
for (const f of ["core.bundle.js", "browser-shim.js", "app.js"]) {
  try {
    new vm.Script(fs.readFileSync(path.join(RENDERER, f), "utf8"), { filename: f }).runInContext(context);
  } catch (err) {
    failures.push(`加载 ${f} 失败：${err.message}`);
  }
}

(async () => {
  await new Promise((r) => setTimeout(r, 200));

  const internals = sandbox.window.__appInternals;
  check("内部方法已暴露", Boolean(internals.openActions && internals.openGuide));

  // 拿到真实的一行数据（boot 时已从 localStorage 读过）
  const list = await sandbox.window.subwatch.list();
  check("启动时读到预置订阅", list.rows.length === 1, `实际 ${list.rows.length} 行`);
  const row = list.rows[0];
  check("有可操作的订阅行", Boolean(row), "行数为 0");

  if (!row) return finish();

  /* ---- 一级：动作选择 ---- */
  internals.openActions(row.id);
  const choicesHtml = elements.get("actionChoices").innerHTML;
  check("动作弹层被填充", choicesHtml.length > 100, `长度 ${choicesHtml.length}`);
  check("动作弹层渲染了 4 个选项", (choicesHtml.match(/data-choice=/g) || []).length === 4,
    `实际 ${(choicesHtml.match(/data-choice=/g) || []).length}`);
  check("每个选项都渲染了说明", (choicesHtml.match(/choice-desc/g) || []).length === 4);
  check("标题含订阅名", elements.get("actionTitle").textContent.includes(row.name));
  check("副标题显示状态", elements.get("actionSubtitle").textContent.includes("还没处理"));
  check("动作弹层可见", elements.get("actionModal").classList.contains("hidden") === false);

  /* ---- 二级：退订指引 ---- */
  internals.openGuide(row.id, { keepGuide: true });
  const guideHtml = elements.get("guideBody").innerHTML;
  check("指引弹层被填充", guideHtml.length > 300, `长度 ${guideHtml.length}`);
  check("指引含核心认知纠正", guideHtml.includes("一渠道一协议") || guideHtml.includes("关掉一个渠道"));
  check("指引含签约通道入口", guideHtml.includes("签约通道"));
  check("指引含免责说明", guideHtml.includes("不能替你取消订阅"));
  check("指引匹配到了优酷", guideHtml.includes("优酷"));
  check("指引弹层可见", elements.get("guideModal").classList.contains("hidden") === false);
  check("动作弹层被隐藏", elements.get("actionModal").classList.contains("hidden") === true);
  check("有「返回」按钮（非直达入口）", elements.get("btnActionBack").classList.contains("hidden") === false);

  // 直达模式（从待处理横幅进入）不该有返回按钮
  internals.openGuide(row.id, { direct: true, keepGuide: true });
  check("直达模式下隐藏「返回」", elements.get("btnActionBack").classList.contains("hidden") === true);

  /* ---- 状态标记 ---- */
  await sandbox.window.subwatch.update({ id: row.id, patch: { canceledAt: "uncanceled" } });
  await internals.refresh(); // 界面重新取数，否则断言的是过期状态
  const afterPending = internals.currentRows();
  check("标记「还没退」已保存", afterPending[0].canceledAt === "uncanceled", `实际 ${afterPending[0].canceledAt}`);

  internals.openActions(row.id);
  check("已标未退时副标题反映状态", elements.get("actionSubtitle").textContent.includes("还没退订"));
  const pendingHtml = elements.get("actionChoices").innerHTML;
  check("已标未退时「还没退」按钮文案变化", pendingHtml.includes("仍然标记为"));

  /* ---- 首次运行引导 ---- */
  check("引导条元素存在", Boolean(elements.get("setupBar")));
  // 数据里没有 setupConfirmed 标记时，引导条应该显示
  const setupHidden = elements.get("setupBar").classList.contains("hidden");
  check("未确认时显示首次引导", setupHidden === false, "引导条被隐藏了");
  check("引导里有「试一下通知」按钮", htmlIds.has("btnTestNotify"));
  check("引导里有开机自启按钮", htmlIds.has("btnToggleAutostart"));

  // 标记为已确认后应隐藏
  await sandbox.window.subwatch.setFlag("setupConfirmed", true);
  await internals.refresh();
  check("已确认后引导条隐藏", elements.get("setupBar").classList.contains("hidden") === true);

  // 浏览器预览模式下应诚实说明"不支持"，而不是假装成功
  const notifyResult = await sandbox.window.subwatch.testNotify();
  check("浏览器模式不假装能发系统通知", notifyResult.shown === false && Boolean(notifyResult.reason));
  const autoResult = await sandbox.window.subwatch.getAutostart();
  check("浏览器模式不假装支持开机自启", autoResult.unsupported === true);

  finish();
})();

function finish() {
  console.log("");
  for (const c of checks) if (!c.ok) console.log(`✖ ${c.label}`);
  if (errors.length) console.log(`渲染层错误：\n  ${errors.join("\n  ")}`);
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n交互演练：${passed}/${checks.length} 通过`);
  if (failures.length) {
    console.log(`\n失败项：\n  - ${failures.join("\n  - ")}`);
    process.exitCode = 1;
  } else {
    console.log("全部通过 ✅");
  }
}
