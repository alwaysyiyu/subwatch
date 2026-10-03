"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { GUIDES, GENERIC_ENTRY_POINTS, getGuide, allGuides, allEntryPoints } = require("../src/core/guides");

test("通用入口覆盖四个最主要的签约渠道", () => {
  const ids = allEntryPoints().map((e) => e.id);
  for (const must of ["alipay", "wechat", "apple", "google"]) {
    assert.ok(ids.includes(must), `缺少入口：${must}`);
  }
});

test("每条通用入口都有可核对的操作路径", () => {
  for (const e of allEntryPoints()) {
    assert.ok(e.name && e.name.length > 2, `入口缺名称：${JSON.stringify(e)}`);
    assert.ok(e.path && e.path.includes("→"), `入口缺路径或格式不对：${e.name}`);
  }
});

test("匹配到具体服务时，给出有序步骤", () => {
  const r = getGuide({ name: "iCloud+" });
  assert.ok(r.matched, "iCloud 应命中 Apple 指引");
  assert.equal(r.matched.channel, "apple");
  assert.ok(Array.isArray(r.matched.steps) && r.matched.steps.length >= 2);
  for (const s of r.matched.steps) assert.ok(typeof s === "string" && s.length > 0);
});

test("匹配到渠道时，该渠道的通用入口排到第一位", () => {
  const r = getGuide({ name: "iCloud+" });
  assert.equal(r.entryPoints[0].id, "apple", "应把 Apple 入口排最前，方便用户直接点");
  const alipay = getGuide({ name: "支付宝签约的某服务" });
  assert.equal(alipay.entryPoints[0].id, "alipay");
});

test("匹配不到时给出通用入口，且不假装知道", () => {
  const r = getGuide({ name: "某个我从没听过的服务" });
  assert.equal(r.matched, null);
  assert.equal(r.entryPoints.length, GENERIC_ENTRY_POINTS.length);
  assert.match(r.genericHint, /依次找一遍|入口/);
});

test("匹配不区分大小写", () => {
  assert.ok(getGuide({ name: "ICLOUD 存储" }).matched);
  assert.ok(getGuide({ name: "Google One" }).matched);
});

test("运营商类关键词能命中（这类在支付宝/微信里查不到）", () => {
  for (const n of ["手机套餐", "宽带年费", "中国移动增值业务"]) {
    const r = getGuide({ name: n });
    assert.ok(r.matched, `${n} 应命中运营商指引`);
    assert.equal(r.matched.channel, "carrier");
  }
});

test("空名称或缺失字段不会崩", () => {
  for (const bad of [null, undefined, {}, { name: "" }]) {
    const r = getGuide(bad);
    assert.equal(r.matched, null);
    assert.ok(r.entryPoints.length > 0);
  }
});

test("每条指引都标注了来源可信度，且只允许三档", () => {
  for (const g of allGuides()) {
    assert.ok(
      ["official", "media", "community"].includes(g.confidence),
      `「${g.name}」的可信度标注不合法：${g.confidence}`
    );
  }
});

test("指引数据本身不能有明显笔误（字段齐全）", () => {
  for (const g of allGuides()) {
    assert.ok(g.id, "缺 id");
    assert.ok(g.name, `缺 name：${g.id}`);
    assert.ok(Array.isArray(g.match) && g.match.length > 0, `缺 match 关键词：${g.id}`);
    assert.ok(Array.isArray(g.steps) && g.steps.length > 0, `缺 steps：${g.id}`);
  }
});

test("不允许出现「帮你取消」这类做不到的承诺", () => {
  const text = JSON.stringify(allGuides()) + JSON.stringify(allEntryPoints());
  for (const overclaim of ["自动取消", "帮你取消", "一键退订", "代你取消"]) {
    assert.ok(!text.includes(overclaim), `指引中出现做不到的承诺：${overclaim}`);
  }
});

test("必须包含「关掉一个渠道 ≠ 退订」这条核心认知纠正", () => {
  const g = getGuide({ name: "任意" });
  assert.ok(g.principle, "缺少核心原则提示");
  assert.match(g.principle.title, /渠道/);
  assert.match(g.principle.detail, /Apple ID|一渠道一协议/);
  assert.ok(g.principle.evidenceUrl.startsWith("https://"), "必须附可核对的报道链接");
});

test("必须包含试用期截止时刻的提醒（这一类没有统一官方规则）", () => {
  const g = getGuide({ name: "任意" });
  assert.ok(g.trialNotice, "缺少试用期提醒");
  assert.match(g.trialNotice.detail, /24 小时/);
  assert.match(g.trialNotice.detail, /不统一|各平台/);
});

test("支付宝用词必须是官方口径「免密支付/自动扣款」", () => {
  const alipay = allEntryPoints().find((e) => e.id === "alipay");
  assert.match(alipay.name, /免密支付\/自动扣款/, "官方用词不能写成「自动续费/免密支付」");
  assert.match(alipay.path, /免密支付\/自动扣款/);
  assert.ok(alipay.url.includes("mdeduct.alipay.com"), "应给出官方一键解约页");
});

test("微信必须提示免密支付是另一个独立入口", () => {
  const wechat = allEntryPoints().find((e) => e.id === "wechat");
  assert.match(wechat.note, /免密支付/);
  assert.match(wechat.note, /独立|两个/);
});

test("信用卡止付必须纠正「换卡就安全了」的错误认知", () => {
  const card = allEntryPoints().find((e) => e.id === "card");
  assert.match(card.note, /换卡|补卡/);
  assert.match(card.note, /销卡/);
});

test("没有官方入口的平台不编造 App 内路径", () => {
  // 这几家的官方站点/协议都没有可核对的 App 内取消入口
  const noOfficialPath = ["爱奇艺", "哔哩哔哩", "QQ音乐", "网易云音乐"];
  const all = allGuides();
  for (const name of noOfficialPath) {
    const g = all.find((x) => x.match.some((k) => name.toLowerCase().includes(k.toLowerCase())));
    // 允许落在通用条目上，但不允许有专门的、带具体菜单路径的官方指引
    if (g && g.confidence === "official") {
      assert.fail(`${name} 不应有 official 级别的具体路径指引（官方未公布）`);
    }
  }
});

test("每条具体指引都要能追溯到来源（official/media 必须有 source）", () => {
  for (const g of allGuides()) {
    if (g.confidence === "official" || g.confidence === "media") {
      assert.ok(g.source || g.url, `「${g.name}」标注了 ${g.confidence} 但没给来源`);
    }
  }
  for (const e of allEntryPoints()) {
    if (e.confidence === "official" || e.confidence === "media") {
      assert.ok(e.source, `入口「${e.name}」标注了 ${e.confidence} 但没给来源`);
    }
  }
});

test("长关键词优先匹配，避免命中错条目", () => {
  // "芒果TV会员" 应命中芒果，而不是被更短的通用词抢走
  const g = getGuide({ name: "芒果TV会员" });
  assert.equal(g.matched.id, "mango-tv");
  const y = getGuide({ name: "优酷VIP" });
  assert.equal(y.matched.id, "youku");
  const b = getGuide({ name: "百度网盘会员" });
  assert.equal(b.matched.id, "baidu-netdisk");
});
