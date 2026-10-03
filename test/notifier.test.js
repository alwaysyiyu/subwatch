"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store } = require("../src/core/store");
const { Notifier, dateKey } = require("../src/main/notifier");

const NOW = new Date("2026-10-01T10:00:00+08:00");

function setup(subs, now = NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-notifier-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  for (const s of subs) store.add(s);
  const outbox = [];
  const notifier = new Notifier({
    store,
    send: (payload) => outbox.push(payload),
    now: () => now,
  });
  return { store, notifier, outbox };
}

// startDate 让下次扣费正好落在 3 天后（10/04）
const dueIn3 = { name: "腾讯视频", amount: 25, cycle: "monthly", startDate: "2026-09-04" };
// 下次扣费 19 天后，不在提醒窗口
const notDue = { name: "域名", amount: 75, cycle: "yearly", startDate: "2026-09-20" };

test("dateKey 按本地日期生成", () => {
  assert.equal(dateKey(new Date("2026-10-01T00:00:00")), "2026-10-01");
  assert.equal(dateKey(new Date("2026-01-05T23:59:59")), "2026-01-05");
});

test("到期就发通知，未到期不发", () => {
  const { notifier, outbox } = setup([dueIn3, notDue]);
  const sent = notifier.check();
  assert.equal(sent.length, 1);
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].title, /腾讯视频/);
  assert.match(outbox[0].title, /3 天后/);
});

test("同一天重复检查不会重复通知（这是防骚扰的关键）", () => {
  const { notifier, outbox } = setup([dueIn3]);
  notifier.check();
  notifier.check();
  notifier.check();
  assert.equal(outbox.length, 1, `应该只发 1 条，实际 ${outbox.length} 条`);
});

test("silent 模式只算不发（供界面预览与测试用）", () => {
  const { notifier, outbox } = setup([dueIn3]);
  const sent = notifier.check({ silent: true });
  assert.equal(sent.length, 1);
  assert.equal(outbox.length, 0);
});

test("换一天后可以再次通知（档位未变也算新提醒）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-notifier2-"));
  const store = new Store({ filePath: path.join(dir, "data.json") });
  store.add(dueIn3);
  const outbox = [];
  let clock = new Date("2026-10-01T10:00:00+08:00");
  const notifier = new Notifier({ store, send: (p) => outbox.push(p), now: () => clock });

  notifier.check();
  assert.equal(outbox.length, 1);
  clock = new Date("2026-10-02T10:00:00+08:00"); // 隔天，剩下 2 天 → 命中 3 天档
  notifier.check();
  assert.equal(outbox.length, 2, "隔天应能再提醒一次");
});

test("首次启动：单条到期就正常发", () => {
  const { notifier, outbox } = setup([dueIn3]);
  const sent = notifier.firstRunCheck();
  assert.equal(sent.length, 1);
  assert.equal(outbox.length, 1);
});

test("首次启动：多条到期只发一条汇总，避免通知轰炸", () => {
  const subs = [
    { name: "腾讯视频", amount: 25, cycle: "monthly", startDate: "2026-09-04" },
    { name: "网易云音乐", amount: 15, cycle: "monthly", startDate: "2026-09-04" },
    { name: "iCloud", amount: 6, cycle: "monthly", startDate: "2026-09-04" },
    { name: "百度网盘", amount: 25, cycle: "monthly", startDate: "2026-09-04" },
    { name: "哔哩哔哩", amount: 25, cycle: "monthly", startDate: "2026-09-04" },
  ];
  const { notifier, outbox } = setup(subs);
  const sent = notifier.firstRunCheck();
  assert.equal(sent.length, 1, "5 条到期只应发 1 条汇总");
  assert.equal(outbox.length, 1);
  assert.match(outbox[0].title, /5 项订阅近期要扣费/);
  assert.match(outbox[0].body, /等 5 项/);
});

test("多条汇总后，紧接着的 check() 不应再逐条弹", () => {
  const subs = [
    { name: "A", amount: 25, cycle: "monthly", startDate: "2026-09-04" },
    { name: "B", amount: 25, cycle: "monthly", startDate: "2026-09-04" },
  ];
  const { notifier, outbox } = setup(subs);
  notifier.firstRunCheck();
  assert.equal(outbox.length, 1);
  notifier.check();
  assert.equal(outbox.length, 1, "汇总已覆盖这批，不该再逐条发");
});

test("没有到期项时不发任何通知", () => {
  const { notifier, outbox } = setup([notDue]);
  assert.equal(notifier.firstRunCheck().length, 0);
  assert.equal(notifier.check().length, 0);
  assert.equal(outbox.length, 0);
});

test("start/stop 幂等，不会叠加定时器", () => {
  const { notifier } = setup([dueIn3]);
  notifier.start({ intervalMs: 100000 });
  const first = notifier.timer;
  notifier.start({ intervalMs: 100000 });
  assert.equal(notifier.timer, first, "重复 start 不该创建第二个定时器");
  notifier.stop();
  assert.equal(notifier.timer, null);
  notifier.stop(); // 再 stop 一次也不该抛错
});

test("构造时缺少依赖要立刻报错，而不是运行到一半崩", () => {
  assert.throws(() => new Notifier({}), /需要 store/);
  assert.throws(() => new Notifier({ store: { list: () => [] } }), /需要 send/);
});
