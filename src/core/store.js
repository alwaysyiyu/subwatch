"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { summarize, CYCLE_MONTHS } = require("./renewal");

/**
 * 本地数据层。
 *
 * 设计取舍：用 JSON 文件而不是 better-sqlite3。
 * better-sqlite3 是原生模块，在 Electron 里需要 electron-rebuild，7 天窗口不值得
 * 冒这个风险；几十条订阅的数据量，JSON 绰绰有余。
 *
 * 两个必须做对的地方：
 *   1. 原子写入 —— 先写 .tmp 再 rename，避免断电/崩溃写坏用户唯一的账本。
 *   2. 损坏兜底 —— 文件读坏时备份成 .corrupt-<时间戳> 再重建，绝不静默丢数据。
 */

const SCHEMA_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `sub_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
}

/** 校验并规整一条订阅记录 */
function normalizeSubscription(input) {
  if (!input || typeof input !== "object") throw new Error("订阅记录必须是对象");
  const name = String(input.name || "").trim();
  if (!name) throw new Error("订阅名称不能为空");

  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new Error("金额必须是非负数字");

  const cycle = String(input.cycle || "");
  if (CYCLE_MONTHS[cycle] === undefined) throw new Error(`未知周期：${cycle}`);

  const startDate = String(input.startDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new Error("开始日期格式应为 YYYY-MM-DD");

  return {
    id: input.id || newId(),
    name,
    amount,
    currency: input.currency || "CNY",
    cycle,
    category: input.category || "其他",
    startDate,
    autoRenew: input.autoRenew !== false,
    note: String(input.note || ""),
    createdAt: input.createdAt || nowIso(),
    updatedAt: nowIso(),
    // 可选：用于"你上次用它还是 N 天前"与吃灰预警
    ...(input.lastUsedAt ? { lastUsedAt: input.lastUsedAt } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    // 退订状态：
    //   "uncanceled"       = 用户明确表示还没退订（要继续提醒）
    //   ISO 时间字符串      = 用户已退订完成
    //   不存在             = 未处理
    ...(input.canceledAt ? { canceledAt: input.canceledAt } : {}),
  };
}

function emptyDb() {
  return { schemaVersion: SCHEMA_VERSION, subscriptions: [], notifyLog: {}, flags: {} };
}

/** 校验整个数据库结构；坏数据不静默丢弃，交由调用方决定 */
function validateDb(raw) {
  if (!raw || typeof raw !== "object") throw new Error("数据文件内容不是对象");
  const list = Array.isArray(raw.subscriptions) ? raw.subscriptions : [];
  return {
    schemaVersion: Number(raw.schemaVersion) || SCHEMA_VERSION,
    subscriptions: list,
    notifyLog: raw.notifyLog && typeof raw.notifyLog === "object" ? raw.notifyLog : {},
    flags: raw.flags && typeof raw.flags === "object" ? raw.flags : {},
  };
}

class Store {
  /**
   * @param {object} options
   * @param {string} options.filePath 数据文件绝对路径
   */
  constructor({ filePath }) {
    if (!filePath) throw new Error("Store 需要 filePath");
    this.filePath = filePath;
    this.db = emptyDb();
    this.load();
  }

  /** 读盘。文件损坏时备份并重建，保证 App 永远能启动 */
  load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.db = emptyDb();
        return { ok: true, fresh: true };
      }
      const text = fs.readFileSync(this.filePath, "utf8");
      if (!text.trim()) {
        this.db = emptyDb();
        return { ok: true, fresh: true };
      }
      this.db = validateDb(JSON.parse(text));
      return { ok: true, fresh: false };
    } catch (err) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.filePath, backup);
      } catch {
        /* 备份失败也不能让 App 起不来 */
      }
      this.db = emptyDb();
      return { ok: false, error: String(err && err.message), backup };
    }
  }

  /** 原子写盘 */
  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
    return true;
  }

  /** @returns {Array} 订阅列表（复制，外部改不坏内部状态） */
  list() {
    return this.db.subscriptions.map((s) => ({ ...s }));
  }

  get(id) {
    const found = this.db.subscriptions.find((s) => s.id === id);
    return found ? { ...found } : null;
  }

  add(input) {
    const sub = normalizeSubscription(input);
    if (this.db.subscriptions.some((s) => s.id === sub.id)) {
      throw new Error(`订阅 id 已存在：${sub.id}`);
    }
    this.db.subscriptions.push(sub);
    this.save();
    return { ...sub };
  }

  update(id, patch) {
    const idx = this.db.subscriptions.findIndex((s) => s.id === id);
    if (idx === -1) throw new Error(`找不到订阅：${id}`);
    const merged = normalizeSubscription({ ...this.db.subscriptions[idx], ...patch, id });
    merged.createdAt = this.db.subscriptions[idx].createdAt;
    this.db.subscriptions[idx] = merged;
    this.save();
    return { ...merged };
  }

  remove(id) {
    const before = this.db.subscriptions.length;
    this.db.subscriptions = this.db.subscriptions.filter((s) => s.id !== id);
    if (this.db.subscriptions.length === before) throw new Error(`找不到订阅：${id}`);
    // 顺手清掉对应的提醒记录，避免 id 复用时误判"已提醒过"
    delete this.db.notifyLog[id];
    this.save();
    return true;
  }

  /** 清空（用于"重置"与测试） */
  clear() {
    this.db = emptyDb();
    this.save();
    return true;
  }

  replaceAll(subs) {
    this.db.subscriptions = (subs || []).map((s) => normalizeSubscription(s));
    this.db.notifyLog = {};
    this.db.flags = {};
    this.save();
    return this.list();
  }

  summary() {
    return summarize(this.db.subscriptions);
  }

  /**
   * 提醒去重：同一条订阅、同一档位、同一天只通知一次。
   * 否则每 6 小时检查一次会变成一天骚扰用户 4 次。
   *
   * @returns {boolean} true 表示"可以发"
   */
  shouldNotify(subId, stage, dateKey) {
    const key = `${dateKey}#${stage}`;
    const seen = this.db.notifyLog[subId];
    if (seen === key) return false;
    this.db.notifyLog[subId] = key;
    this.save();
    return true;
  }

  /** 只读地查询是否已通知过（不写盘），用于界面展示 */
  hasNotified(subId, stage, dateKey) {
    return this.db.notifyLog[subId] === `${dateKey}#${stage}`;
  }

  /**
   * 简单的键值标记，用于记录"用户已经确认过某事"。
   * 目前只用于首次运行引导（确认过就不再提示）。
   */
  getFlag(key) {
    return this.db.flags && this.db.flags[key];
  }

  setFlag(key, value) {
    if (!this.db.flags) this.db.flags = {};
    if (value) this.db.flags[key] = true;
    else delete this.db.flags[key];
    this.save();
    return true;
  }
}

module.exports = {
  Store,
  SCHEMA_VERSION,
  normalizeSubscription,
  newId,
  emptyDb,
  validateDb,
};
