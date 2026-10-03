"use strict";

/**
 * 仓库卫生规则 —— 纯函数，零依赖，可被单元测试直接覆盖。
 *
 * 为什么单独抽出来：这些规则原先写在 verify-ui.js 里，与「调用 git 拿到文件列表」
 * 耦合在一起。而调用 git 在某些受限环境会失败（EPERM），于是**规则本身永远得不到验证**——
 * 一次真实的 bug（非 ASCII 路径被 git 转义导致误报）就是这样溜到 CI 才被发现。
 *
 * 拆开之后：
 *   - 规则在这里，可以被 test/ 直接测（包括故意构造违规输入）
 *   - 数据获取在 verify-ui.js，取不到就明确报告「跳过」，不假装通过
 */

/**
 * docs/ 下只允许面向用户的文档。内部工作笔记（开发计划、访谈记录、调研笔记、
 * 交接笔记）留在本地 —— 对 clone 项目的人没有价值，还可能带开发环境痕迹。
 */
const ALLOWED_DOCS = ["docs/安装说明.md", "docs/发布流程.md"];

/** 检查一批被 git 跟踪的 docs 文件里有没有不该提交的 */
function checkDocsScope(trackedDocs) {
  if (!Array.isArray(trackedDocs)) {
    return { ok: false, reason: "not-array", unexpected: [], message: "输入不是数组" };
  }
  const allowed = new Set(ALLOWED_DOCS);
  const unexpected = trackedDocs.filter((f) => !allowed.has(f));
  return {
    ok: unexpected.length === 0,
    reason: unexpected.length === 0 ? "ok" : "unexpected-docs",
    unexpected,
    message:
      unexpected.length === 0
        ? "docs/ 下只有面向用户的文档"
        : `docs/ 下出现不该提交的文件：${unexpected.join(", ")}`,
  };
}

/** docs/ 检查必须真的读到文件，否则"没发现问题"可能只是因为它什么都没读到 */
function isDocsCheckMeaningful(trackedDocs) {
  return Array.isArray(trackedDocs) && trackedDocs.length >= ALLOWED_DOCS.length;
}

/**
 * 公开文件里不允许出现本机绝对路径（会暴露开发环境，对别人也没意义）。
 * 输入：[[相对路径, 文件内容], ...]
 */
const LOCAL_PATH_PATTERNS = [
  { re: /[A-Za-z]:\\{1,2}(Users|Documents|Desktop|Projects|DSH)[^\s`"')]*/g, label: "Windows 用户/项目绝对路径" },
  { re: /\/Users\/[a-zA-Z0-9._-]+\//g, label: "macOS 用户目录" },
  { re: /\/home\/[a-zA-Z0-9._-]+\//g, label: "Linux 用户目录" },
];

function scanLocalPaths(files) {
  const findings = [];
  for (const [rel, text] of files) {
    const hits = [];
    for (const { re, label } of LOCAL_PATH_PATTERNS) {
      const m = String(text).match(re);
      if (m) hits.push(`${label}: ${[...new Set(m)].slice(0, 3).join(", ")}`);
    }
    if (hits.length) findings.push({ file: rel, hits });
  }
  return { ok: findings.length === 0, findings };
}

/**
 * 文件里是否存在"编码被写坏"的迹象。
 * 三层：已知乱码标记 / 中文很多但没有高频常用字 / 出现解码失败字符。
 */
const MOJIBAKE_MARKERS = ["锛", "鈥", "銆", "缁", "鐗", "鍜", "浣", "瀛", "鏄", "涓", "鈿", "馃"];
const COMMON_HAN = ["的", "了", "是", "在", "不", "有", "这", "要", "和", "我"];

function scanEncoding(text, { minHanForStats = 300 } = {}) {
  const s = String(text);
  const markers = MOJIBAKE_MARKERS.filter((m) => s.includes(m));
  const replacementCount = (s.match(/\uFFFD/g) || []).length;
  const hanCount = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const commonHits = COMMON_HAN.filter((c) => s.includes(c)).length;
  const statsSuspect = hanCount >= minHanForStats && commonHits < 3;
  return {
    ok: markers.length === 0 && replacementCount === 0 && !statsSuspect,
    markers,
    replacementCount,
    hanCount,
    commonHits,
    statsSuspect,
  };
}

/** BOM（EF BB BF）：会让 GitHub Actions 解析 workflow YAML 失败 */
function hasBom(buf) {
  return buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

module.exports = {
  ALLOWED_DOCS,
  checkDocsScope,
  isDocsCheckMeaningful,
  scanLocalPaths,
  scanEncoding,
  hasBom,
  MOJIBAKE_MARKERS,
  COMMON_HAN,
  LOCAL_PATH_PATTERNS,
};
