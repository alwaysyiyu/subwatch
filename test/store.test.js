"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Store, normalizeSubscription } = require("../src/core/store");

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-test-"));
  return { store: new Store({ filePath: path.join(dir, "data.json") }), dir };
}

const sample = {
  name: "腾讯视频 VIP",
  amount: 25,
  cycle: "monthly",
  startDate: "2026-09-08",
  category: "影音",
};

test("normalizeSubscription 补齐默认值并生成 id", () => {
  const s = normalizeSubscription(sample);
  assert.ok(s.id.startsWith("sub_"));
  assert.equal(s.currency, "CNY");
  assert.equal(s.autoRenew, true);
  assert.equal(s.note, "");
  assert.ok(s.createdAt);
  assert.ok(s.updatedAt);
});

test("normalizeSubscription 拒绝脏数据（不能静默算错）", () => {
  assert.throws(() => normalizeSubscription({ ...sample, name: "  " }), /名称不能为空/);
  assert.throws(() => normalizeSubscription({ ...sample, amount: "abc" }), /金额/);
  assert.throws(() => normalizeSubscription({ ...sample, amount: -1 }), /金额/);
  assert.throws(() => normalizeSubscription({ ...sample, cycle: "daily" }), /未知周期/);
  assert.throws(() => normalizeSubscription({ ...sample, startDate: "2026/9/8" }), /格式/);
  assert.throws(() => normalizeSubscription(null), /必须是对象/);
});

test("增删改查 + 持久化到磁盘", () => {
  const { store, dir } = tmpStore();
  const added = store.add(sample);
  assert.equal(store.list().length, 1);

  // 重新打开同一个文件，数据还在（证明真的落盘了）
  const reopened = new Store({ filePath: path.join(dir, "data.json") });
  assert.equal(reopened.list().length, 1);
  assert.equal(reopened.get(added.id).name, "腾讯视频 VIP");

  const updated = reopened.update(added.id, { amount: 30 });
  assert.equal(updated.amount, 30);
  assert.equal(updated.createdAt, added.createdAt, "createdAt 不应被 update 覆盖");

  reopened.remove(added.id);
  assert.equal(reopened.list().length, 0);
  assert.throws(() => reopened.remove(added.id), /找不到订阅/);
});

test("list() 返回副本，外部改动不污染内部状态", () => {
  const { store } = tmpStore();
  store.add(sample);
  const list = store.list();
  list[0].amount = 9999;
  assert.equal(store.list()[0].amount, 25);
});

test("重复 id 要报错，而不是悄悄覆盖", () => {
  const { store } = tmpStore();
  const added = store.add(sample);
  assert.throws(() => store.add({ ...sample, id: added.id }), /已存在/);
});

test("原子写盘：不留 .tmp 残留", () => {
  const { store, dir } = tmpStore();
  store.add(sample);
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ["data.json"], `目录应只有数据文件，实际：${files.join(", ")}`);
});

test("文件损坏时备份并重建，App 仍能启动", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-corrupt-"));
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, "{ 这不是合法 JSON", "utf8");

  const store = new Store({ filePath: file });
  assert.equal(store.list().length, 0, "应回退到空库而不是崩溃");
  const backups = fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
  assert.equal(backups.length, 1, "坏文件必须被备份，不能静默丢弃");
});

test("空文件视为新库，不报错", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-empty-"));
  const file = path.join(dir, "data.json");
  fs.writeFileSync(file, "", "utf8");
  const store = new Store({ filePath: file });
  assert.equal(store.list().length, 0);
});

test("summary 汇总月/年支出", () => {
  const { store } = tmpStore();
  store.add({ ...sample, amount: 25, cycle: "monthly" });
  store.add({ ...sample, name: "域名", amount: 120, cycle: "yearly" });
  const s = store.summary();
  assert.equal(s.count, 2);
  assert.equal(s.monthly, 35);
  assert.equal(s.yearly, 420);
});

test("提醒去重：同一天同档位只发一次，换档位可再发", () => {
  const { store } = tmpStore();
  const sub = store.add(sample);
  assert.equal(store.shouldNotify(sub.id, 7, "2026-10-01"), true);
  assert.equal(store.shouldNotify(sub.id, 7, "2026-10-01"), false, "重复检查不该再打扰");
  assert.equal(store.shouldNotify(sub.id, 3, "2026-10-05"), true, "换档位是新提醒");
  assert.equal(store.shouldNotify(sub.id, 7, "2026-11-01"), true, "换日期是新提醒");
  // hasNotified 是只读的，不改状态
  assert.equal(store.hasNotified(sub.id, 7, "2026-11-01"), true);
  assert.equal(store.hasNotified(sub.id, 7, "2026-12-01"), false);
});

test("删除订阅时清理其提醒记录（避免 id 复用误判）", () => {
  const { store } = tmpStore();
  const sub = store.add(sample);
  store.shouldNotify(sub.id, 7, "2026-10-01");
  store.remove(sub.id);
  assert.equal(store.hasNotified(sub.id, 7, "2026-10-01"), false);
});

test("replaceAll 重置订阅与提醒记录", () => {
  const { store } = tmpStore();
  const a = store.add(sample);
  store.shouldNotify(a.id, 7, "2026-10-01");
  store.replaceAll([{ ...sample, name: "新的" }]);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].name, "新的");
  assert.equal(store.hasNotified(a.id, 7, "2026-10-01"), false);
});

test("clear 清空", () => {
  const { store } = tmpStore();
  store.add(sample);
  store.clear();
  assert.equal(store.list().length, 0);
});

test("flags：记录「用户已确认过某事」并持久化", () => {
  const { store, dir } = tmpStore();
  assert.equal(store.getFlag("setupConfirmed"), undefined);

  store.setFlag("setupConfirmed", true);
  assert.equal(store.getFlag("setupConfirmed"), true);

  // 重新打开同一文件，标记还在
  const reopened = new Store({ filePath: path.join(dir, "data.json") });
  assert.equal(reopened.getFlag("setupConfirmed"), true);

  reopened.setFlag("setupConfirmed", false);
  assert.equal(reopened.getFlag("setupConfirmed"), undefined);
});

test("老数据文件（没有 flags 字段）也能正常读写标记", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "subwatch-legacy-"));
  const file = path.join(dir, "data.json");
  // 模拟早期版本写下的、没有 flags 的数据库
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, subscriptions: [], notifyLog: {} }), "utf8");

  const store = new Store({ filePath: file });
  assert.equal(store.getFlag("setupConfirmed"), undefined);
  store.setFlag("setupConfirmed", true);
  assert.equal(store.getFlag("setupConfirmed"), true);
});

test("replaceAll 会一并重置标记", () => {
  const { store } = tmpStore();
  store.setFlag("setupConfirmed", true);
  store.replaceAll([{ ...sample }]);
  assert.equal(store.getFlag("setupConfirmed"), undefined);
});
