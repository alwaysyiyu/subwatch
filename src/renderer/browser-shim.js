"use strict";

/**
 * 浏览器回退实现 —— 让界面可以在普通浏览器里直接打开调试，
 * 也保证 Electron 装不上时不阻塞界面开发。
 *
 * 用的是和主进程同一套 core/ 逻辑（通过 <script> 引入），
 * 所以日期推算、提醒判定、预设的行为与 Electron 里完全一致。
 * 唯一差别是数据存在 localStorage 而不是文件。
 */

(function () {
  if (window.subwatch && window.subwatch.platform === "electron") return;

  const core = window.subwatchCore;
  if (!core) {
    console.error("[shim] 未找到 subwatchCore，界面无法工作");
    return;
  }

  const STORAGE_KEY = "subwatch.browser.data";
  const notifyLog = {};

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { subscriptions: [], flags: {} };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.subscriptions)) return { subscriptions: [], flags: {} };
      // 补齐可能缺失的字段：老版本存下来的数据没有 flags，
      // 不补的话 getFlag/setFlag 会踩到 undefined。
      return { subscriptions: parsed.subscriptions, flags: parsed.flags || {} };
    } catch {
      return { subscriptions: [], flags: {} };
    }
  }

  function save(db) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  }

  let db = load();

  function newId() {
    return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function normalize(input) {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("订阅名称不能为空");
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new Error("金额必须是非负数字");
    if (core.CYCLE_MONTHS[input.cycle] === undefined) throw new Error(`未知周期：${input.cycle}`);
    const startDate = String(input.startDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("开始日期格式应为 YYYY-MM-DD");
    return {
      id: input.id || newId(),
      name,
      amount,
      currency: input.currency || "CNY",
      cycle: input.cycle,
      category: input.category || "其他",
      startDate,
      autoRenew: input.autoRenew !== false,
      note: String(input.note || ""),
      createdAt: input.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
      ...(input.usage ? { usage: input.usage } : {}),
      // 退订状态："uncanceled" 或 ISO 时间字符串。
      // 注意必须与 src/core/store.js 的 normalizeSubscription 保持一致 ——
      // 之前这里漏了，导致浏览器预览模式下"还没退/已退订"的状态存不下来。
      ...(input.canceledAt ? { canceledAt: input.canceledAt } : {}),
    };
  }

  function dashboard() {
    const now = new Date();
    const rows = db.subscriptions.map((sub) => {
      const r = core.evaluateReminder(sub, { now });
      return {
        ...sub,
        daysUntilCharge: core.daysUntilNextCharge(sub, now),
        nextChargeDate: core.nextChargeDate(sub, now),
        monthlyCost: core.monthlyCost(sub),
        yearlyCost: core.yearlyCost(sub),
        urgency: r.urgency,
        dueSoon: r.shouldNotify,
        amountText: core.formatMoney(sub.amount),
        monthlyText: core.formatMoney(core.monthlyCost(sub)),
      };
    });
    rows.sort((a, b) =>
      a.daysUntilCharge !== b.daysUntilCharge
        ? a.daysUntilCharge - b.daysUntilCharge
        : b.yearlyCost - a.yearlyCost
    );
    return {
      rows,
      summary: core.summarize(db.subscriptions),
      dueCount: rows.filter((r) => r.dueSoon).length,
      generatedAt: now.toISOString(),
    };
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  window.subwatch = {
    platform: "browser",

    async meta() {
      return {
        platform: "browser",
        dataFile: "localStorage（浏览器预览模式，数据不会进文件）",
        cycles: [
          { value: "weekly", label: "每周" },
          { value: "monthly", label: "每月" },
          { value: "quarterly", label: "每季度" },
          { value: "semiannual", label: "每半年" },
          { value: "yearly", label: "每年" },
        ],
        categories: core.presetsByCategory().map((g) => g.category),
        currencies: ["CNY", "USD", "HKD", "JPY", "EUR"],
      };
    },

    async list() {
      await sleep(60); // 刻意加一点延迟，模拟 IPC，避免界面写出只在这条路径下才对的代码
      return dashboard();
    },

    async presets() {
      return core.presetsByCategory();
    },

    async addFromPreset({ presetId, startDate }) {
      const preset = core.PRESETS.find((p) => p.id === presetId);
      if (!preset) throw new Error(`找不到预设：${presetId}`);
      const sub = normalize(core.presetToSubscription(preset, startDate));
      db.subscriptions.push(sub);
      save(db);
      return sub;
    },

    async add(payload) {
      const sub = normalize(payload);
      db.subscriptions.push(sub);
      save(db);
      return sub;
    },

    async update({ id, patch }) {
      const idx = db.subscriptions.findIndex((s) => s.id === id);
      if (idx === -1) throw new Error(`找不到订阅：${id}`);
      const merged = normalize({ ...db.subscriptions[idx], ...patch, id });
      merged.createdAt = db.subscriptions[idx].createdAt;
      db.subscriptions[idx] = merged;
      save(db);
      return merged;
    },

    async remove({ id }) {
      const before = db.subscriptions.length;
      db.subscriptions = db.subscriptions.filter((s) => s.id !== id);
      if (db.subscriptions.length === before) throw new Error(`找不到订阅：${id}`);
      save(db);
      return true;
    },

    async summary() {
      return core.summarize(db.subscriptions);
    },

    async shareCard() {
      const d = dashboard();
      const top = d.rows.slice().sort((a, b) => b.yearlyCost - a.yearlyCost).slice(0, 3);
      return {
        title: "我一年的订阅开销",
        yearlyText: d.summary.yearlyText,
        monthlyText: d.summary.monthlyText,
        count: d.summary.count,
        topLines: top.map((r) => `${r.name} ${r.monthlyText}/月`),
        footer: "用 subwatch 算的 · 你的呢？",
      };
    },

    async exportCsv() {
      const d = dashboard();
      const header = "名称,金额,币种,周期,分类,下次扣费,距今天数,月均成本,年化成本,备注";
      const lines = d.rows.map((r) =>
        [r.name, r.amount, r.currency, r.cycle, r.category, r.nextChargeDate,
         r.daysUntilCharge, r.monthlyCost.toFixed(2), r.yearlyCost.toFixed(2), (r.note || "").replace(/[",\n]/g, " ")]
          .map((v) => (String(v).includes(",") ? `"${v}"` : v))
          .join(",")
      );
      return [header, ...lines].join("\n");
    },

    async previewReminders() {
      const now = new Date();
      return db.subscriptions
        .map((sub) => core.evaluateReminder(sub, { now }))
        .filter((r) => r.shouldNotify);
    },

    async checkNow() {
      return this.previewReminders();
    },

    async openExternal(url) {
      window.open(url, "_blank", "noopener");
      return true;
    },

    async copyText(text) {
      await navigator.clipboard.writeText(text);
      return true;
    },

    async saveCsv(csv) {
      const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `subwatch-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
      return true;
    },

    // 浏览器预览模式下没有系统通知与开机自启，给出诚实的说明而不是假装成功
    async testNotify() {
      return { shown: false, reason: "浏览器预览模式没有系统通知。请在桌面版里试。" };
    },
    async getAutostart() {
      return { enabled: false, unsupported: true };
    },
    async setAutostart() {
      return { enabled: false, unsupported: true };
    },
    async getFlag(key) {
      return Boolean(db.flags && db.flags[key]);
    },
    async setFlag(key, value) {
      db.flags = db.flags || {};
      if (value) db.flags[key] = true;
      else delete db.flags[key];
      save(db);
      return Boolean(value);
    },
  };

  console.info("[shim] 浏览器预览模式已启用，数据存在 localStorage");
})();
