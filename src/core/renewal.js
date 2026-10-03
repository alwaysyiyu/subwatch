"use strict";

/**
 * 续费日期推算 —— 本项目的核心算法，也是最容易出错的地方。
 *
 * 关键设计：所有续费日都从「锚点日」用**整数倍周期**推导，而不是逐周期累加。
 * 原因：1/31 逐月累加会漂移成 2/28 → 3/28 → 4/28，正确的语义应是
 * 1/31 → 2/28 → 3/31 → 4/30 → 5/31（锚点始终记着"31 号"）。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 把 "YYYY-MM-DD" 或 Date 解析为 UTC 当天 00:00 的毫秒数 */
function toUtcDay(value) {
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  if (!m) throw new Error(`日期格式应为 YYYY-MM-DD，收到：${value}`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const ms = Date.UTC(year, month, day);
  const d = new Date(ms);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month || d.getUTCDate() !== day) {
    throw new Error(`不存在的日期：${value}`);
  }
  return ms;
}

/** 把毫秒数还原为 "YYYY-MM-DD" */
function fromUtcDay(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 某年某月（0-11）的天数 */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** 按锚点日 + n 个月，日超出当月天数时收敛到当月最后一天 */
function shiftByMonths(anchorMs, months) {
  const a = new Date(anchorMs);
  const targetMonthIndex = a.getUTCMonth() + months;
  const targetYear = a.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(a.getUTCDate(), daysInMonth(targetYear, targetMonth));
  return Date.UTC(targetYear, targetMonth, day);
}

/** 周期定义：一个月 = 1，一年 = 12，一周 = 0（按天推进） */
const CYCLE_MONTHS = {
  weekly: 0,
  monthly: 1,
  quarterly: 3,
  semiannual: 6,
  yearly: 12,
};

const CYCLE_LABELS = {
  weekly: "每周",
  monthly: "每月",
  quarterly: "每季度",
  semiannual: "每半年",
  yearly: "每年",
};

function assertSubscription(sub) {
  if (!sub || typeof sub !== "object") throw new Error("订阅记录必须是对象");
  if (!sub.startDate) throw new Error("订阅缺少 startDate");
  const months = CYCLE_MONTHS[sub.cycle];
  if (months === undefined) throw new Error(`未知周期：${sub.cycle}`);
  return months;
}

/**
 * 求「不早于 onOrAfter 的第一次扣费日」
 * @returns {number} UTC 毫秒
 */
function nextChargeOnOrAfter(anchorMs, months, onOrAfterMs) {
  // 不变量：找最小的 k >= 0，使第 k 期扣费日 >= max(锚点, 查询日)。
  //   - 「>= 锚点」防止算出订阅开始之前的日期；也不能把偏移夹到 0，
  //     否则年度订阅会从第 0 期开始逐期试探。
  //   - 「>= 查询日」保证是还没处理的那一期。**扣费当天也算（days=0）**，
  //     否则用户在最该看到提醒的那天反而看到"下个月几号"。
  //   - 周订阅与按月订阅共用这一套，不再各写一份判断（各写容易两边不一致）。
  //
  // 两个踩过的坑：
  //   1. shiftByMonths 接受「月数」偏移，不是「周期数」。把周期长度乘进分母
  //      却把商当月偏移用，偏移量会缩水成 1/months（季度 1/3、年度 1/12）。
  //   2. 30.44 天/月 的估算会偏低（年度 6 年实际 6 期，算出来 5），所以前进循环
  //      是必需的，且步长必须是"1 期"。
  const floorMs = Math.max(anchorMs, onOrAfterMs);
  const stride = months === 0 ? 7 * MS_PER_DAY : months * 30.44 * MS_PER_DAY;

  let offset = Math.floor((floorMs - anchorMs) / stride);
  let candidate = chargeAt(anchorMs, months, offset);
  let guard = 0;

  // 前进：候选日仍早于下界
  while (candidate < floorMs && guard++ < 4000) {
    offset += 1;
    candidate = chargeAt(anchorMs, months, offset);
  }
  // 回退：只要"再早一期"仍然不早于下界，就还能更小
  while (offset > 0 && chargeAt(anchorMs, months, offset - 1) >= floorMs) {
    offset -= 1;
    candidate = chargeAt(anchorMs, months, offset);
  }
  return candidate;
}

/** 第 offset 期扣费日（offset >= 0）：周订阅按 7 天推进，其余按锚点日推月 */
function chargeAt(anchorMs, months, offset) {
  if (months === 0) return anchorMs + offset * 7 * MS_PER_DAY;
  return shiftByMonths(anchorMs, offset * months);
}

/**
 * 下一次（或当天）扣费日。
 * 扣费当天返回"今天"，而不是跳到下个月 —— 那是这个产品最该说话的一天。
 */
function nextChargeDate(sub, when = new Date()) {
  const months = assertSubscription(sub);
  const anchorMs = toUtcDay(sub.startDate);
  const whenMs = toUtcDay(when);
  return fromUtcDay(nextChargeOnOrAfter(anchorMs, months, whenMs));
}

/**
 * 距下次扣费还有几天（今天 = 0；已过期的记录返回负数）
 */
function daysUntilNextCharge(sub, when = new Date()) {
  const next = toUtcDay(nextChargeDate(sub, when));
  return Math.round((next - toUtcDay(when)) / MS_PER_DAY);
}

/**
 * 把一笔订阅摊平成"每月多少元"，用于汇总与排序
 */
function monthlyCost(sub) {
  const amount = Number(sub.amount) || 0;
  switch (sub.cycle) {
    case "weekly":
      return (amount * 52) / 12;
    case "monthly":
      return amount;
    case "quarterly":
      return amount / 3;
    case "semiannual":
      return amount / 6;
    case "yearly":
      return amount / 12;
    default:
      throw new Error(`未知周期：${sub.cycle}`);
  }
}

/**
 * 年化成本。注意：这里刻意不做任何"折扣"或"推测"，只做单位换算。
 */
function yearlyCost(sub) {
  return monthlyCost(sub) * 12;
}

/**
 * 汇总一组订阅
 */
function summarize(subs) {
  let monthly = 0;
  let yearly = 0;
  for (const sub of subs || []) {
    monthly += monthlyCost(sub);
    yearly += yearlyCost(sub);
  }
  return {
    count: (subs || []).length,
    monthly,
    yearly,
    monthlyText: formatMoney(monthly),
    yearlyText: formatMoney(yearly),
  };
}

/** 金额展示：¥ 前缀，保留两位但去掉无意义的 .00 */
function formatMoney(value) {
  const n = Number(value) || 0;
  const rounded = Math.round(n * 100) / 100;
  return `¥${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`;
}

module.exports = {
  MS_PER_DAY,
  CYCLE_MONTHS,
  CYCLE_LABELS,
  toUtcDay,
  fromUtcDay,
  daysInMonth,
  shiftByMonths,
  nextChargeOnOrAfter,
  nextChargeDate,
  daysUntilNextCharge,
  monthlyCost,
  yearlyCost,
  summarize,
  formatMoney,
};
