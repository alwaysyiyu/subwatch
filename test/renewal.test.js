"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  toUtcDay,
  fromUtcDay,
  daysInMonth,
  shiftByMonths,
  nextChargeDate,
  daysUntilNextCharge,
  monthlyCost,
  yearlyCost,
  summarize,
  formatMoney,
} = require("../src/core/renewal");

const D = (s) => toUtcDay(s);

test("日期工具：解析与格式化往返一致", () => {
  assert.equal(fromUtcDay(D("2026-10-01")), "2026-10-01");
  assert.equal(fromUtcDay(D("2024-02-29")), "2024-02-29");
  assert.throws(() => D("2026-13-01"), /不存在的日期/);
  assert.throws(() => D("2026-02-30"), /不存在的日期/);
  assert.throws(() => D("2026/10/01"), /日期格式/);
});

test("daysInMonth 覆盖闰年", () => {
  assert.equal(daysInMonth(2024, 1), 29); // 2024-02
  assert.equal(daysInMonth(2026, 1), 28); // 2026-02
  assert.equal(daysInMonth(2026, 0), 31);
  assert.equal(daysInMonth(2026, 3), 30);
});

test("shiftByMonths：锚点日不漂移（1/31 的关键案例）", () => {
  const anchor = D("2026-01-31");
  assert.equal(fromUtcDay(shiftByMonths(anchor, 0)), "2026-01-31");
  assert.equal(fromUtcDay(shiftByMonths(anchor, 1)), "2026-02-28");
  assert.equal(fromUtcDay(shiftByMonths(anchor, 2)), "2026-03-31", "不能漂移成 3/28");
  assert.equal(fromUtcDay(shiftByMonths(anchor, 3)), "2026-04-30");
  assert.equal(fromUtcDay(shiftByMonths(anchor, 4)), "2026-05-31");
});

test("shiftByMonths：闰年 1/31 到 2/29", () => {
  assert.equal(fromUtcDay(shiftByMonths(D("2024-01-31"), 1)), "2024-02-29");
});

test("shiftByMonths：跨年", () => {
  assert.equal(fromUtcDay(shiftByMonths(D("2026-11-30"), 3)), "2027-02-28");
  assert.equal(fromUtcDay(shiftByMonths(D("2026-01-15"), 12)), "2027-01-15");
});

test("月度订阅：1/31 起，2 月中查下一次是 2/28", () => {
  const sub = { name: "iCloud", amount: 6, cycle: "monthly", startDate: "2026-01-31" };
  assert.equal(nextChargeDate(sub, "2026-02-10"), "2026-02-28");
});

test("月度订阅：扣费当天返回当天，不跳到下个月", () => {
  const sub = { name: "视频会员", amount: 25, cycle: "monthly", startDate: "2026-09-15" };
  // 关键产品行为：扣费当天必须能提醒「今天要扣」，否则用户在最该看到提醒的
  // 那一天只会看到「下个月 15 号」。
  assert.equal(nextChargeDate(sub, "2026-10-15"), "2026-10-15");
  assert.equal(daysUntilNextCharge(sub, "2026-10-15"), 0);
  assert.equal(nextChargeDate(sub, "2026-10-14"), "2026-10-15");
  assert.equal(daysUntilNextCharge(sub, "2026-10-14"), 1);
  assert.equal(nextChargeDate(sub, "2026-10-16"), "2026-11-15");
});

test("年度订阅：跨年推算正确", () => {
  const sub = { name: "域名", amount: 75, cycle: "yearly", startDate: "2024-03-08" };
  assert.equal(nextChargeDate(sub, "2026-10-01"), "2027-03-08");
  assert.equal(nextChargeDate(sub, "2027-03-07"), "2027-03-08");
  assert.equal(nextChargeDate(sub, "2027-03-08"), "2027-03-08"); // 当天
  assert.equal(nextChargeDate(sub, "2027-03-09"), "2028-03-08");
});

test("年度订阅：闰日起算，平年收敛到 2/28 且不漂移", () => {
  const sub = { name: "年费", amount: 100, cycle: "yearly", startDate: "2024-02-29" };
  assert.equal(nextChargeDate(sub, "2024-03-01"), "2025-02-28");
  assert.equal(nextChargeDate(sub, "2025-03-01"), "2026-02-28");
  assert.equal(nextChargeDate(sub, "2026-03-01"), "2027-02-28");
});

test("季度与半年周期", () => {
  const q = { name: "季度", amount: 90, cycle: "quarterly", startDate: "2026-01-15" };
  assert.equal(nextChargeDate(q, "2026-02-01"), "2026-04-15");
  assert.equal(nextChargeDate(q, "2026-04-15"), "2026-04-15"); // 当天
  assert.equal(nextChargeDate(q, "2026-04-16"), "2026-07-15");

  const h = { name: "半年", amount: 300, cycle: "semiannual", startDate: "2026-01-31" };
  assert.equal(nextChargeDate(h, "2026-02-01"), "2026-07-31");
});

test("周订阅：按 7 天推进，跨年正确", () => {
  const w = { name: "周卡", amount: 10, cycle: "weekly", startDate: "2026-12-25" };
  assert.equal(nextChargeDate(w, "2026-12-26"), "2027-01-01");
  assert.equal(nextChargeDate(w, "2027-01-01"), "2027-01-01"); // 当天
  assert.equal(nextChargeDate(w, "2027-01-02"), "2027-01-08");
});

test("startDate 在未来时，第一次扣费就是 startDate", () => {
  const sub = { name: "试用", amount: 25, cycle: "monthly", startDate: "2026-11-20" };
  // 10/01 时这笔订阅还没开始，所以第一次扣费就是 11/20 本身，
  // 而不是「往前推一个月」的 10/20。
  assert.equal(nextChargeDate(sub, "2026-10-01"), "2026-11-20");
  assert.equal(daysUntilNextCharge(sub, "2026-10-01"), 50);
  assert.equal(nextChargeDate(sub, "2026-11-20"), "2026-11-20");
  assert.equal(daysUntilNextCharge(sub, "2026-11-20"), 0);
  assert.equal(nextChargeDate(sub, "2026-11-21"), "2026-12-20");
});

test("daysUntilNextCharge 边界", () => {
  const sub = { name: "x", amount: 25, cycle: "monthly", startDate: "2026-09-15" };
  assert.equal(daysUntilNextCharge(sub, "2026-10-14"), 1);
  assert.equal(nextChargeDate(sub, "2026-10-15"), "2026-10-15");
  assert.equal(daysUntilNextCharge(sub, "2026-10-15"), 0);
  assert.equal(nextChargeDate(sub, "2026-10-16"), "2026-11-15");
  assert.equal(daysUntilNextCharge(sub, "2026-10-16"), 30);
});

test("未知周期要报错，而不是静默算错", () => {
  assert.throws(() => monthlyCost({ amount: 10, cycle: "daily" }), /未知周期/);
  assert.throws(() => nextChargeDate({ cycle: "monthly" }, "2026-10-01"), /startDate/);
});

test("成本换算", () => {
  assert.equal(monthlyCost({ amount: 120, cycle: "yearly" }), 10);
  assert.equal(yearlyCost({ amount: 10, cycle: "monthly" }), 120);
  assert.equal(monthlyCost({ amount: 30, cycle: "quarterly" }), 10);
  assert.equal(monthlyCost({ amount: 60, cycle: "semiannual" }), 10);
  assert.equal(Math.round(monthlyCost({ amount: 12, cycle: "weekly" }) * 100) / 100, 52);
});

test("汇总与金额展示", () => {
  const subs = [
    { name: "a", amount: 25, cycle: "monthly" },
    { name: "b", amount: 120, cycle: "yearly" },
  ];
  const s = summarize(subs);
  assert.equal(s.count, 2);
  assert.equal(s.monthly, 35);
  assert.equal(s.yearly, 420);
  assert.equal(s.monthlyText, "¥35");

  assert.equal(formatMoney(35), "¥35");
  assert.equal(formatMoney(35.5), "¥35.50");
  assert.equal(formatMoney(0), "¥0");
});
