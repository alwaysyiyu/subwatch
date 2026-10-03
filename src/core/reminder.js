"use strict";

const { daysUntilNextCharge, nextChargeDate, formatMoney } = require("./renewal");

/**
 * 提醒判定 —— 产品价值的核心。
 *
 * 设计原则（来自调研）：
 * 1. 提前 7 / 3 / 1 天三次递进，不打扰但也不漏。
 * 2. 文案不是"XX 将于 3 天后续费"，而是"3 天后要扣 ¥25，去年你根本没打开过"。
 * 3. 提醒是产品主动找用户 —— 这是低频工具绕开"低频"困境的唯一方式。
 */

/** 默认提醒档位（距扣费天数） */
const DEFAULT_STAGES = [7, 3, 1];

/**
 * 决定一笔订阅在当前时刻是否该提醒。
 *
 * 关键规则：
 * - 只提醒"还没扣的那一次"（daysUntil 严格 >= 0）。
 * - 已扣费的不提醒（不做事后诸葛）。
 * - 如果订阅是刚加的、正好落在提醒窗口内，也只提醒最紧迫的那一档，
 *   避免一次弹出三条。
 *
 * @param {object} sub 订阅记录
 * @param {object} [options]
 * @param {Date}   [options.now]
 * @param {number[]} [options.stages]
 * @returns {{shouldNotify: boolean, stage: number|null, days: number, urgency: string,
 *            nextDate: string, title: string, body: string}}
 */
function evaluateReminder(sub, options = {}) {
  const now = options.now || new Date();
  const stages = (options.stages || DEFAULT_STAGES).slice().sort((a, b) => b - a);

  const days = daysUntilNextCharge(sub, now);
  const nextDate = nextChargeDate(sub, now);
  const amountText = formatMoney(sub.amount);
  const name = sub.name || "未命名订阅";

  const base = { stage: null, days, nextDate, title: "", body: "" };

  if (!Number.isFinite(days) || days < 0) {
    return { shouldNotify: false, urgency: "none", ...base };
  }

  // 命中哪一档：取"大于等于当前剩余天数"里最小的一档（即最紧迫的已触发档）
  const hit = stages.filter((s) => days <= s).sort((a, b) => a - b)[0];
  if (hit === undefined) {
    return { shouldNotify: false, urgency: "none", ...base };
  }

  const urgency = hit <= 1 ? "urgent" : hit <= 3 ? "soon" : "upcoming";
  const whenText = days === 0 ? "今天" : `${days} 天后`;

  return {
    shouldNotify: true,
    urgency,
    stage: hit,
    days,
    nextDate,
    title: `${name} ${whenText}要扣 ${amountText}`,
    body: buildBody(sub, days, amountText, nextDate),
  };
}

/**
 * 提醒正文。刻意加入"值不值"的追问，把工具从"记录"变成"决策"。
 */
function buildBody(sub, days, amountText, nextDate) {
  const parts = [];
  parts.push(`${nextDate} 将扣款 ${amountText}`);
  if (sub.lastUsedAt) {
    const idleDays = Math.round((Date.now() - new Date(sub.lastUsedAt).getTime()) / 86400000);
    if (idleDays >= 30) {
      parts.push(`你上次用它还是 ${idleDays} 天前`);
    }
  } else if (sub.usage === "never") {
    parts.push("你标记过「从未用过」");
  }
  parts.push("要留还是退？");
  return parts.join(" · ");
}

/**
 * 对一组订阅做批量判定，按紧迫度与金额排序。
 */
function evaluateAll(subs, options = {}) {
  return (subs || [])
    .map((sub) => ({ sub, reminder: evaluateReminder(sub, options) }))
    .filter((item) => item.reminder.shouldNotify)
    .sort((a, b) => {
      if (a.reminder.days !== b.reminder.days) return a.reminder.days - b.reminder.days;
      return (Number(b.sub.amount) || 0) - (Number(a.sub.amount) || 0);
    });
}

/**
 * 托盘常驻文案：给用户一个"顺路打开"的理由，缓解低频问题。
 */
function trayTooltip(subs, now = new Date()) {
  const due = evaluateAll(subs, { now });
  if (due.length === 0) {
    const total = (subs || []).length;
    return total === 0 ? "subwatch · 还没有订阅记录" : `subwatch · ${total} 项订阅，近期无扣费`;
  }
  const nearest = due[0];
  return `subwatch · ${nearest.sub.name} ${nearest.reminder.days} 天后扣 ${formatMoney(nearest.sub.amount)}`;
}

module.exports = {
  DEFAULT_STAGES,
  evaluateReminder,
  evaluateAll,
  trayTooltip,
  buildBody,
};
