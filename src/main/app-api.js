"use strict";

const { presetsByCategory, presetToSubscription, allPresets } = require("../core/presets");
const { daysUntilNextCharge, nextChargeDate, monthlyCost, yearlyCost, formatMoney } = require("../core/renewal");
const { evaluateReminder } = require("../core/reminder");

/**
 * 应用服务层 —— 不依赖 Electron，可在纯 node 下测试。
 *
 * 主进程（main.js）和浏览器预览（renderer/browser-shim.js）都调这一层，
 * 保证两种运行方式的业务行为完全一致。
 */

/**
 * 列表 + 派生信息（距扣费天数、紧迫度、金额），供界面直接渲染。
 * 排序规则：即将扣费的置顶，其次按年化成本从高到低 —— 用户最该先看贵的。
 */
function buildDashboard(store, now = new Date()) {
  const subs = store.list();
  const rows = subs.map((sub) => {
    const days = daysUntilNextCharge(sub, now);
    const reminder = evaluateReminder(sub, { now });
    return {
      ...sub,
      daysUntilCharge: days,
      nextChargeDate: nextChargeDate(sub, now),
      monthlyCost: monthlyCost(sub),
      yearlyCost: yearlyCost(sub),
      urgency: reminder.urgency,
      dueSoon: reminder.shouldNotify,
      amountText: formatMoney(sub.amount),
      monthlyText: formatMoney(monthlyCost(sub)),
    };
  });

  rows.sort((a, b) => {
    if (a.daysUntilCharge !== b.daysUntilCharge) return a.daysUntilCharge - b.daysUntilCharge;
    return b.yearlyCost - a.yearlyCost;
  });

  const summary = store.summary();
  return {
    rows,
    summary,
    dueCount: rows.filter((r) => r.dueSoon).length,
    generatedAt: now.toISOString(),
  };
}

/** 界面的静态配置（周期选项等） */
function getMeta() {
  return {
    cycles: [
      { value: "weekly", label: "每周" },
      { value: "monthly", label: "每月" },
      { value: "quarterly", label: "每季度" },
      { value: "semiannual", label: "每半年" },
      { value: "yearly", label: "每年" },
    ],
    categories: [...new Set(allPresets().map((p) => p.category))],
    currencies: ["CNY", "USD", "HKD", "JPY", "EUR"],
  };
}

/**
 * 分享卡片文案 —— 唯一的自传播机制。
 * 刻意做成"晒账单"而不是"打广告"，这样用户愿意发出去。
 */
function buildShareCard(store, now = new Date()) {
  const { summary, rows } = buildDashboard(store, now);
  const top = rows.slice().sort((a, b) => b.yearlyCost - a.yearlyCost).slice(0, 3);
  return {
    title: "我一年的订阅开销",
    yearlyText: summary.yearlyText,
    monthlyText: summary.monthlyText,
    count: summary.count,
    topLines: top.map((r) => `${r.name} ${r.monthlyText}/月`),
    footer: "用 subwatch 算的 · 你的呢？",
  };
}

/** 导出 CSV（买断版功能，这里先把能力做出来） */
function exportCsv(store, now = new Date()) {
  const { rows } = buildDashboard(store, now);
  const header = "名称,金额,币种,周期,分类,下次扣费,距今天数,月均成本,年化成本,备注";
  const lines = rows.map((r) =>
    [
      r.name,
      r.amount,
      r.currency,
      r.cycle,
      r.category,
      r.nextChargeDate,
      r.daysUntilCharge,
      r.monthlyCost.toFixed(2),
      r.yearlyCost.toFixed(2),
      (r.note || "").replace(/[",\n]/g, " "),
    ]
      .map((v) => (String(v).includes(",") ? `"${v}"` : v))
      .join(",")
  );
  return [header, ...lines].join("\n");
}

/**
 * 建立 IPC 方法表。主进程把它挂到 ipcMain，浏览器预览直接当对象用。
 * @param {object} deps
 * @param {import("../core/store").Store} deps.store
 * @param {object} [deps.notifier]
 * @param {() => Date} [deps.now]
 */
function createApi({ store, notifier, now }) {
  const clock = now || (() => new Date());

  // 统一契约：所有方法都返回 Promise（异步失败），即使内部是同步实现。
  // 理由：主进程的 ipcMain.handle 对同步抛出和 Promise 拒绝都能处理，但浏览器
  // shim 是 async 函数、只会以 Promise 拒绝的方式失败。两边不一致的话，调用方
  // （渲染层）就得写两套错误处理，迟早出错。
  const wrap = (fn) => async (...args) => fn(...args);

  const api = {
    "app:meta": wrap(() => ({ ...getMeta(), platform: process.platform, dataFile: store.filePath })),

    "subs:list": wrap(() => buildDashboard(store, clock())),

    "subs:presets": wrap(() => presetsByCategory()),

    "subs:addFromPreset": wrap(({ presetId, startDate } = {}) => {
      const preset = allPresets().find((p) => p.id === presetId);
      if (!preset) throw new Error(`找不到预设：${presetId}`);
      return store.add(presetToSubscription(preset, startDate));
    }),

    "subs:add": wrap((payload) => store.add(payload)),
    "subs:update": wrap(({ id, patch }) => store.update(id, patch)),
    "subs:remove": wrap(({ id }) => store.remove(id)),

    "subs:summary": wrap(() => store.summary()),
    "subs:shareCard": wrap(() => buildShareCard(store, clock())),
    "subs:exportCsv": wrap(() => exportCsv(store, clock())),

    /** 预览提醒文案（不发送），让用户先看到"提醒长什么样" */
    "subs:previewReminders": wrap(() => (notifier ? notifier.check({ silent: true }) : [])),

    /** 手动触发一次提醒检查（托盘菜单用） */
    "subs:checkNow": wrap(() => (notifier ? notifier.check() : [])),
  };

  return api;
}

module.exports = {
  createApi,
  buildDashboard,
  buildShareCard,
  exportCsv,
  getMeta,
};
