"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateReminder, evaluateAll, trayTooltip, DEFAULT_STAGES } = require("../src/core/reminder");

// 用固定"今天"保证测试可重复
const NOW = new Date("2026-10-01T10:00:00+08:00");

function sub(overrides = {}) {
  return { name: "腾讯视频 VIP", amount: 25, cycle: "monthly", startDate: "2026-09-08", ...overrides };
}

test("默认提醒档位是 7/3/1 天", () => {
  assert.deepEqual(DEFAULT_STAGES, [7, 3, 1]);
});

test("距扣费 7 天内才提醒", () => {
  // 10/08 扣费 → 距今 7 天
  const r = evaluateReminder(sub({ startDate: "2026-09-08" }), { now: NOW });
  assert.equal(r.days, 7);
  assert.equal(r.shouldNotify, true);
  assert.equal(r.stage, 7);
  assert.equal(r.urgency, "upcoming");

  // 10/20 扣费 → 距今 19 天，不提醒
  const far = evaluateReminder(sub({ startDate: "2026-09-20" }), { now: NOW });
  assert.equal(far.shouldNotify, false);
  assert.equal(far.stage, null);
});

test("多档命中时取最紧迫的一档（不会一次弹三条）", () => {
  // 10/02 扣费 → 距今 1 天，同时满足 7/3/1
  const r = evaluateReminder(sub({ startDate: "2026-09-02" }), { now: NOW });
  assert.equal(r.days, 1);
  assert.equal(r.stage, 1);
  assert.equal(r.urgency, "urgent");
});

test("3 天档的紧迫度是 soon", () => {
  const r = evaluateReminder(sub({ startDate: "2026-09-04" }), { now: NOW });
  assert.equal(r.days, 3);
  assert.equal(r.stage, 3);
  assert.equal(r.urgency, "soon");
});

test("今天扣费（days=0）判定为 urgent", () => {
  const r = evaluateReminder(sub({ startDate: "2026-09-01" }), { now: NOW });
  assert.equal(r.days, 0);
  assert.equal(r.shouldNotify, true);
  assert.equal(r.urgency, "urgent");
  assert.match(r.title, /今天要扣/);
});

test("锚点落在今天时提醒 days=0，隔天才不再提醒", () => {
  // 订阅的锚点日正好是今天 → 今天就是要扣的日子，必须提醒（days=0）
  const onDueDay = evaluateReminder(sub({ startDate: "2026-10-01" }), { now: NOW });
  assert.equal(onDueDay.days, 0);
  assert.equal(onDueDay.shouldNotify, true);
  assert.equal(onDueDay.urgency, "urgent");
  // 隔天则下一次在 11/01，距今 31 天，不在提醒窗口内
  const dayAfter = evaluateReminder(sub({ startDate: "2026-10-01" }), {
    now: new Date("2026-10-02T10:00:00+08:00"),
  });
  assert.equal(dayAfter.days, 30);
  assert.equal(dayAfter.shouldNotify, false, "刚扣完不该立刻再提醒");
});

test("标题包含名称、天数与金额（不是干巴巴的占位文案）", () => {
  const r = evaluateReminder(sub({ startDate: "2026-09-04" }), { now: NOW });
  assert.equal(r.title, "腾讯视频 VIP 3 天后要扣 ¥25");
});

test("正文会追问「值不值」，并在长期未使用时点破", () => {
  const stale = sub({ startDate: "2026-09-04", lastUsedAt: "2026-01-01T00:00:00Z" });
  const r = evaluateReminder(stale, { now: NOW });
  assert.match(r.body, /将扣款 ¥25/);
  assert.match(r.body, /你上次用它还是 \d+ 天前/);
  assert.match(r.body, /要留还是退/);
});

test("标记「从未用过」时正文点破", () => {
  const r = evaluateReminder(sub({ startDate: "2026-09-04", usage: "never" }), { now: NOW });
  assert.match(r.body, /从未用过/);
});

test("自定义档位生效", () => {
  const r = evaluateReminder(sub({ startDate: "2026-09-20" }), { now: NOW, stages: [30] });
  assert.equal(r.shouldNotify, true);
  assert.equal(r.stage, 30);
});

test("evaluateAll 按剩余天数升序、同日按金额降序", () => {
  const subs = [
    { name: "19 天后", amount: 999, cycle: "monthly", startDate: "2026-09-20" }, // 不提醒
    { name: "3 天后-便宜", amount: 10, cycle: "monthly", startDate: "2026-09-04" },
    { name: "3 天后-贵", amount: 200, cycle: "monthly", startDate: "2026-09-04" },
    { name: "1 天后", amount: 5, cycle: "monthly", startDate: "2026-09-02" },
  ];
  const due = evaluateAll(subs, { now: NOW });
  assert.deepEqual(
    due.map((d) => d.sub.name),
    ["1 天后", "3 天后-贵", "3 天后-便宜"]
  );
});

test("托盘文案：无订阅 / 无临期 / 有临期", () => {
  assert.match(trayTooltip([], NOW), /还没有订阅记录/);
  // 4/15 起算的年度订阅 → 下次扣费在 2027-04-15，距 10/01 还有 196 天
  assert.match(
    trayTooltip([{ name: "域名", amount: 75, cycle: "yearly", startDate: "2026-04-15" }], NOW),
    /近期无扣费/
  );
  assert.match(trayTooltip([sub({ startDate: "2026-09-02" })], NOW), /1 天后扣 ¥25/);
});
