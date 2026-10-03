"use strict";

const { evaluateAll } = require("../core/reminder");

/**
 * 提醒调度。
 *
 * 产品价值本体就在这里：提醒是"产品主动找用户"，这是低频工具绕开
 * "一年只打开几次"困境的唯一方式。
 *
 * 两个必须做对的地方：
 *   1. 去重 —— 同一条订阅、同一档位、同一天只发一次。每 6 小时检查一次，
 *      不去重就会变成一天骚扰用户 4 次。
 *   2. 首次启动不轰炸 —— 如果用户一次导入 20 条订阅、其中 5 条都在 7 天内到期，
 *      不要连弹 5 条通知。首轮只提示一条汇总。
 */

const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 小时

/** 本地日期键，用于按天去重 */
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

class Notifier {
  /**
   * @param {object} deps
   * @param {import("../core/store").Store} deps.store
   * @param {(payload: {title: string, body: string}) => void} deps.send 实际发送通知
   * @param {() => Date} [deps.now]
   */
  constructor({ store, send, now }) {
    if (!store) throw new Error("Notifier 需要 store");
    if (typeof send !== "function") throw new Error("Notifier 需要 send 回调");
    this.store = store;
    this.send = send;
    this.now = now || (() => new Date());
    this.timer = null;
    this.startedAt = null;
  }

  /**
   * 检查一次并发送到期提醒。
   * @param {object} [options]
   * @param {boolean} [options.silent] true 时只算不发（用于测试与界面预览）
   * @returns {Array} 实际发出的提醒列表
   */
  check(options = {}) {
    const now = this.now();
    const key = dateKey(now);
    const due = evaluateAll(this.store.list(), { now });
    const sent = [];

    for (const item of due) {
      const { sub, reminder } = item;
      if (!this.store.shouldNotify(sub.id, reminder.stage, key)) continue;
      sent.push(reminder);
      if (!options.silent) {
        this.send({ title: reminder.title, body: reminder.body });
      }
    }
    return sent;
  }

  /**
   * 首次启动的"安全开场"：如果一次有多条到期，只发一条汇总，
   * 避免用户刚导入完就被通知轰炸（这是最容易被卸载的时刻）。
   */
  firstRunCheck() {
    const now = this.now();
    const due = evaluateAll(this.store.list(), { now });
    const fresh = due.filter((d) => this.store.hasNotified(d.sub.id, d.reminder.stage, dateKey(now)) === false);
    if (fresh.length === 0) return [];

    if (fresh.length === 1) return this.check();

    // 多条：只发一条汇总，并把这批全部记入去重日志（避免下轮又逐条弹）
    const total = fresh.reduce((sum, d) => sum + (Number(d.sub.amount) || 0), 0);
    const names = fresh.slice(0, 3).map((d) => d.sub.name).join("、");
    const more = fresh.length > 3 ? ` 等 ${fresh.length} 项` : "";
    for (const d of fresh) {
      this.store.shouldNotify(d.sub.id, d.reminder.stage, dateKey(now));
    }
    const reminder = {
      title: `${fresh.length} 项订阅近期要扣费`,
      body: `${names}${more}，合计约 ¥${Math.round(total)}。打开 subwatch 逐条确认要留还是退。`,
    };
    this.send({ title: reminder.title, body: reminder.body });
    return [reminder];
  }

  start({ intervalMs = DEFAULT_CHECK_INTERVAL_MS } = {}) {
    if (this.timer) return;
    this.startedAt = this.now();
    this.firstRunCheck();
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (err) {
        // 提醒失败不能拖垮应用
        console.error("[notifier] 检查提醒失败：", err);
      }
    }, intervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { Notifier, dateKey, DEFAULT_CHECK_INTERVAL_MS };
