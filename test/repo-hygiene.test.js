"use strict";

/**
 * 仓库卫生规则的单元测试。
 *
 * 为什么这些规则值得单独测：它们之前写在 verify-ui.js 里，与「调用 git 拿文件列表」
 * 耦合，而调用 git 在某些环境会失败（EPERM），导致规则本身从未被验证过 ——
 * 一次真实的 bug（git 对非 ASCII 路径做八进制转义，使合法文档被误报成违规）
 * 就是这样溜到 CI 才暴露的。
 *
 * 把这些规则抽成纯函数（src/repo-hygiene.js）后，可以在这里直接构造违规输入来证伪。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ALLOWED_DOCS,
  checkDocsScope,
  isDocsCheckMeaningful,
  scanLocalPaths,
  scanEncoding,
  hasBom,
} = require("../src/repo-hygiene");

/* ---------------- docs/ 范围 ---------------- */

test("docs/ 只含允许的文档时通过", () => {
  const r = checkDocsScope(["docs/安装说明.md", "docs/发布流程.md"]);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "ok");
  assert.deepEqual(r.unexpected, []);
});

test("docs/ 出现内部笔记时失败并指出文件名", () => {
  const r = checkDocsScope(["docs/安装说明.md", "docs/plan.md", "docs/day1-访谈记录.md"]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unexpected-docs");
  assert.deepEqual(r.unexpected, ["docs/plan.md", "docs/day1-访谈记录.md"]);
  assert.match(r.message, /plan\.md/);
});

test("docs/ 下的嵌套目录文件也会被发现（调研笔记）", () => {
  const r = checkDocsScope(["docs/安装说明.md", "docs/research/退订路径核查-中国.md"]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unexpected, ["docs/research/退订路径核查-中国.md"]);
});

test("非 ASCII 路径必须能正确比对（git 转义曾导致误报）", () => {
  // 这是真实 bug 的回归测试：git 默认会把「发布流程」输出成 \345\217\221...
  // 正确的数据源必须给出未转义的路径，否则这两个合法文档会被判违规
  const r = checkDocsScope(["docs/发布流程.md", "docs/安装说明.md"]);
  assert.equal(r.ok, true, "合法的非 ASCII 路径不应被误判");
  // 反过来，转义后的形式应当被识别为"不在允许列表里"
  const escaped = checkDocsScope(['"docs/\\345\\217\\221\\345\\270\\203\\346\\265\\201\\347\\250\\213.md"']);
  assert.equal(escaped.ok, false, "转义路径说明数据源拿错了，应该报出来而不是静默通过");
});

test("输入不是数组时不通过（避免静默跳过）", () => {
  for (const bad of [null, undefined, "docs/x.md", 42]) {
    const r = checkDocsScope(bad);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-array");
  }
});

test("空列表不算通过：必须有内容才说明检查有意义", () => {
  assert.equal(isDocsCheckMeaningful([]), false);
  assert.equal(isDocsCheckMeaningful(["docs/安装说明.md"]), false, "少于允许数量说明没读全");
  assert.equal(isDocsCheckMeaningful(ALLOWED_DOCS), true);
  assert.equal(isDocsCheckMeaningful(null), false);
});

/* ---------------- 本机路径 ---------------- */

test("干净内容不报本机路径", () => {
  const r = scanLocalPaths([
    ["README.md", "在项目目录执行 npm run verify"],
    ["docs/x.md", "数据存在 %APPDATA%\\subwatch\\data.json"],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.findings));
});

test("Windows 用户/项目绝对路径会被抓出", () => {
  const r = scanLocalPaths([["README.md", "cd F:\\DSHDefaultSpace\\subwatch"]]);
  assert.equal(r.ok, false);
  assert.equal(r.findings[0].file, "README.md");
  assert.match(r.findings[0].hits.join(" "), /Windows/);
});

test("macOS / Linux 用户目录会被抓出", () => {
  const mac = scanLocalPaths([["a.md", "cd /Users/alice/project"]]);
  assert.equal(mac.ok, false);
  const linux = scanLocalPaths([["a.md", "cd /home/bob/project"]]);
  assert.equal(linux.ok, false);
});

test("抓出结果里会去重（同一个路径出现多次只报一个）", () => {
  const r = scanLocalPaths([["a.md", "cd F:\\DSHDefaultSpace\ncd F:\\DSHDefaultSpace\n"]]);
  assert.equal(r.ok, false);
  const paths = r.findings[0].hits[0];
  assert.equal((paths.match(/F:\\DSHDefaultSpace/g) || []).length, 1, `未去重：${paths}`);
});

/* ---------------- 编码 ---------------- */

test("正常中文内容不报编码问题", () => {
  const ok = scanEncoding("这是一份正常的中文文档，里面有说明和注意事项。它的内容是清晰的。");
  assert.equal(ok.ok, true);
  assert.equal(ok.markers.length, 0);
  assert.equal(ok.replacementCount, 0);
});

test("已知乱码标记会被抓出", () => {
  const r = scanEncoding("鍙戝竷娴佺▼锛堝惈鏈満璺緞锛?");
  assert.equal(r.ok, false);
  assert.ok(r.markers.length > 0);
});

test("中文很多但没有高频常用字 → 判为可疑（统计式兜底）", () => {
  // 造一段"含大量汉字但不含 的/了/是/在/不/有/这/要/和/我"的文本
  const weird = "龘齉爨纛麤龗靐齾龖鱻驫羴".repeat(40);
  const r = scanEncoding(weird);
  assert.equal(r.statsSuspect, true);
  assert.equal(r.ok, false);
  assert.ok(r.hanCount >= 300);
});

test("短文本不触发统计式判断（避免误伤）", () => {
  const short = "赑屃";
  const r = scanEncoding(short);
  assert.equal(r.statsSuspect, false, "低于阈值不应触发");
});

test("U+FFFD 解码失败字符会被抓出", () => {
  const r = scanEncoding("正常文字\uFFFD\uFFFD更多文字");
  assert.equal(r.ok, false);
  assert.equal(r.replacementCount, 2);
});

test("BOM 检测", () => {
  assert.equal(hasBom(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), true);
  assert.equal(hasBom(Buffer.from("name: x", "utf8")), false);
  assert.equal(hasBom(Buffer.alloc(0)), false);
  assert.equal(hasBom(Buffer.from([0xef, 0xbb])), false, "不足 3 字节不应误判");
});
