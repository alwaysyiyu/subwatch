"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/core/store");
const { Notifier } = require("../src/main/notifier");
const { createApi, buildDashboard, buildShareCard, exportCsv, getMeta } = require("../src/main/app-api");

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-api-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  const outbox = [];
  const notifier = new Notifier({ store, send: (p) => outbox.push(p) });
  const api = createApi({ store, notifier });
  return { store, api, outbox, dir };
}

const NOW = new Date("2026-10-01T10:00:00+08:00");

test("app:meta 返回周期选项与平台信息", async () => {
  const { api } = setup();
  const meta = await api["app:meta"]();
  assert.equal(meta.cycles.length, 5);
  assert.ok(meta.cycles.some((c) => c.value === "monthly"));
  assert.ok(meta.categories.length >= 5);
  assert.ok(meta.currencies.includes("CNY"));
  assert.ok(meta.dataFile.endsWith("data.json"));
});

test("subs:presets 按分类分组，界面直接可渲染", async () => {
  const { api } = setup();
  const groups = await api["subs:presets"]();
  assert.ok(Array.isArray(groups));
  assert.ok(groups.length >= 5);
  for (const g of groups) {
    assert.ok(g.category);
    assert.ok(Array.isArray(g.items) && g.items.length > 0);
  }
});

test("从预设添加：一点即加，且默认开始日期是今天", async () => {
  const { store, api } = setup();
  const sub = await api["subs:addFromPreset"]({ presetId: "iqiyi" });
  assert.equal(sub.name, "爱奇艺 VIP");
  assert.equal(sub.cycle, "monthly");
  assert.match(sub.startDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.list().length, 1);
  await assert.rejects(() => api["subs:addFromPreset"]({ presetId: "不存在的预设" }), /找不到预设/);
});

test("dashboard 行包含界面需要的所有派生字段", async () => {
  const { store, api } = setup();
  store.add({ name: "腾讯视频", amount: 25, cycle: "monthly", startDate: "2026-09-04", category: "影音" });
  const d = await api["subs:list"]();
  const row = d.rows[0];
  for (const key of [
    "id", "name", "amount", "amountText", "cycle", "category",
    "daysUntilCharge", "nextChargeDate", "monthlyCost", "monthlyText",
    "yearlyCost", "urgency", "dueSoon", "startDate",
  ]) {
    assert.ok(key in row, `行数据缺少字段：${key}`);
  }
  assert.equal(row.amountText, "¥25");
  assert.equal(row.monthlyText, "¥25");
});

test("dashboard 按距扣费天数升序排序（即将扣费的置顶）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-sort-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  store.add({ name: "20天后", amount: 100, cycle: "monthly", startDate: "2026-09-21" });
  store.add({ name: "3天后", amount: 10, cycle: "monthly", startDate: "2026-09-04" });
  store.add({ name: "1天后", amount: 5, cycle: "monthly", startDate: "2026-09-02" });
  const d = buildDashboard(store, NOW);
  assert.deepEqual(d.rows.map((r) => r.name), ["1天后", "3天后", "20天后"]);
});

test("dashboard 同一天到期时按年化成本降序（贵的排前面）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-sort2-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  store.add({ name: "便宜", amount: 10, cycle: "monthly", startDate: "2026-09-04" });
  store.add({ name: "贵", amount: 300, cycle: "monthly", startDate: "2026-09-04" });
  const d = buildDashboard(store, NOW);
  assert.deepEqual(d.rows.map((r) => r.name), ["贵", "便宜"]);
});

test("dueCount 只统计提醒窗口内的条目", async () => {
  const { store, api } = setup();
  store.add({ name: "近期", amount: 25, cycle: "monthly", startDate: "2026-09-04" }); // 3 天后
  store.add({ name: "很久以后", amount: 75, cycle: "yearly", startDate: "2026-09-20" }); // 19 天后
  const d = await api["subs:list"]();
  assert.equal(d.dueCount, 1);
  assert.equal(d.summary.count, 2);
});

test("增删改通过 api 走通并落盘", async () => {
  const { api, store, dir } = setup();
  const added = await api["subs:add"]({ name: "手动", amount: 30, cycle: "monthly", startDate: "2026-10-01" });
  await api["subs:update"]({ id: added.id, patch: { amount: 45 } });
  assert.equal(store.get(added.id).amount, 45);

  await api["subs:remove"]({ id: added.id });
  assert.equal(store.list().length, 0);

  // 重新打开文件确认真的落盘了
  const reopened = new Store({ filePath: path.join(dir, "data.json") });
  assert.equal(reopened.list().length, 0);
});

test("脏数据被拒绝，错误信息可显示给用户", async () => {
  const { api } = setup();
  await assert.rejects(
    () => api["subs:add"]({ name: "", amount: 10, cycle: "monthly", startDate: "2026-10-01" }),
    /名称不能为空/
  );
  await assert.rejects(
    () => api["subs:add"]({ name: "x", amount: "abc", cycle: "monthly", startDate: "2026-10-01" }),
    /金额/
  );
});

test("分享卡片是「晒账单」而不是广告，且列出最贵的几项", async () => {
  const { store, api } = setup();
  store.add({ name: "视频", amount: 25, cycle: "monthly", startDate: "2026-10-01" });
  store.add({ name: "域名", amount: 600, cycle: "yearly", startDate: "2026-10-01" });
  const card = await api["subs:shareCard"]();
  assert.equal(card.title, "我一年的订阅开销");
  assert.equal(card.count, 2);
  assert.ok(card.yearlyText.startsWith("¥"));
  assert.equal(card.topLines[0].includes("域名"), true, "最贵的应排第一");
  assert.match(card.footer, /subwatch/);
});

test("空库时分享卡片不崩，也不出现 NaN", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-empty-card-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  const card = buildShareCard(store, NOW);
  assert.equal(card.count, 0);
  assert.equal(card.yearlyText, "¥0");
  assert.deepEqual(card.topLines, []);
});

test("CSV 导出：表头正确、名称含逗号时被转义", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-csv-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  store.add({ name: "某,带逗号", amount: 25, cycle: "monthly", startDate: "2026-10-01" });
  const csv = exportCsv(store, NOW);
  const lines = csv.split("\n");
  assert.match(lines[0], /^名称,金额,币种,周期/);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /"某,带逗号"/);
});

test("subs:previewReminders 只算不发（界面预览用）", async () => {
  const { store, api, outbox } = setup();
  store.add({ name: "3天后", amount: 25, cycle: "monthly", startDate: "2026-09-04" });
  const preview = await api["subs:previewReminders"]();
  assert.ok(Array.isArray(preview));
  assert.equal(outbox.length, 0, "预览不应该真的发通知");
});

test("getMeta 的周期值必须与 core 的 CYCLE_MONTHS 完全一致", () => {
  const { CYCLE_MONTHS } = require("../src/core/renewal");
  const meta = getMeta();
  const uiCycles = meta.cycles.map((c) => c.value).sort();
  const coreCycles = Object.keys(CYCLE_MONTHS).sort();
  assert.deepEqual(uiCycles, coreCycles, "界面周期选项与核心算法不一致会导致用户存进无效数据");
});

test("预设的周期值必须都是核心支持的周期", () => {
  const { CYCLE_MONTHS } = require("../src/core/renewal");
  const { allPresets } = require("../src/core/presets");
  for (const p of allPresets()) {
    assert.ok(
      CYCLE_MONTHS[p.cycle] !== undefined,
      `预设「${p.name}」的周期 ${p.cycle} 不被核心支持`
    );
  }
});
