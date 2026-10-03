"use strict";

/**
 * 常见订阅预设 —— 对付"首屏录入摩擦"这个最大流失点。
 *
 * 调研结论：用户必须手动录入，这是几乎确定会丢掉一半人的地方。
 * 对策是绝不让用户从空白表单开始，而是一点即加。
 * 目标：安装到录入第一条 ≤ 60 秒。
 */

/**
 * 每个预设：id / 名称 / 常见价格（元/周期）/ 周期 / 分类
 * 价格为国内常见档位，仅作填写默认值，用户可改。
 * 不预置"开始日期"——默认取今天，用户再调。
 */
const PRESETS = [
  // 长视频
  { id: "iqiyi", name: "爱奇艺 VIP", amount: 25, cycle: "monthly", category: "影音" },
  { id: "tencent-video", name: "腾讯视频 VIP", amount: 25, cycle: "monthly", category: "影音" },
  { id: "youku", name: "优酷 VIP", amount: 25, cycle: "monthly", category: "影音" },
  { id: "mgtv", name: "芒果 TV", amount: 22, cycle: "monthly", category: "影音" },
  { id: "bilibili", name: "哔哩哔哩大会员", amount: 25, cycle: "monthly", category: "影音" },

  // 音乐
  { id: "netease-music", name: "网易云音乐黑胶", amount: 15, cycle: "monthly", category: "音乐" },
  { id: "qq-music", name: "QQ 音乐绿钻", amount: 15, cycle: "monthly", category: "音乐" },
  { id: "spotify", name: "Spotify", amount: 15, cycle: "monthly", category: "音乐", currency: "USD" },
  { id: "apple-music", name: "Apple Music", amount: 11, cycle: "monthly", category: "音乐" },

  // 云与存储
  { id: "icloud", name: "iCloud+", amount: 6, cycle: "monthly", category: "云存储" },
  { id: "baidu-netdisk", name: "百度网盘会员", amount: 25, cycle: "monthly", category: "云存储" },
  { id: "aliyun-drive", name: "阿里云盘会员", amount: 12, cycle: "monthly", category: "云存储" },
  { id: "quark", name: "夸克会员", amount: 15, cycle: "monthly", category: "云存储" },
  { id: "google-one", name: "Google One", amount: 15, cycle: "monthly", category: "云存储" },

  // AI 工具
  { id: "chatgpt-plus", name: "ChatGPT Plus", amount: 145, cycle: "monthly", category: "AI 工具", currency: "USD" },
  { id: "claude-pro", name: "Claude Pro", amount: 145, cycle: "monthly", category: "AI 工具", currency: "USD" },
  { id: "cursor", name: "Cursor Pro", amount: 145, cycle: "monthly", category: "AI 工具", currency: "USD" },
  { id: "copilot", name: "GitHub Copilot", amount: 70, cycle: "monthly", category: "AI 工具", currency: "USD" },

  // 办公与效率
  { id: "wps", name: "WPS 会员", amount: 15, cycle: "monthly", category: "办公" },
  { id: "office365", name: "Microsoft 365", amount: 398, cycle: "yearly", category: "办公" },
  { id: "notion", name: "Notion", amount: 70, cycle: "monthly", category: "办公", currency: "USD" },
  { id: "1password", name: "1Password", amount: 25, cycle: "monthly", category: "办公", currency: "USD" },

  // 通信与网络
  { id: "mobile-plan", name: "手机套餐", amount: 59, cycle: "monthly", category: "通信" },
  { id: "broadband", name: "宽带年费", amount: 900, cycle: "yearly", category: "通信" },
  { id: "vpn", name: "网络加速/代理", amount: 20, cycle: "monthly", category: "通信" },

  // 开发者与年费制服务（这一类支付平台完全看不到，是差异化重点）
  { id: "domain", name: "域名续费", amount: 75, cycle: "yearly", category: "开发者" },
  { id: "vps", name: "VPS / 云服务器", amount: 600, cycle: "yearly", category: "开发者" },
  { id: "apple-dev", name: "Apple Developer", amount: 688, cycle: "yearly", category: "开发者" },
  { id: "steam-cloud", name: "Steam 云/订阅服务", amount: 30, cycle: "monthly", category: "开发者" },
  { id: "github-copilot-biz", name: "GitHub 订阅", amount: 30, cycle: "monthly", category: "开发者" },

  // 其他常见
  { id: "eleme", name: "饿了么会员", amount: 10, cycle: "monthly", category: "生活" },
  { id: "meituan", name: "美团会员", amount: 15, cycle: "monthly", category: "生活" },
  { id: "jd-plus", name: "京东 PLUS", amount: 149, cycle: "yearly", category: "生活" },
  { id: "taobao-88", name: "淘宝 88VIP", amount: 88, cycle: "yearly", category: "生活" },
  { id: "keep", name: "Keep 会员", amount: 25, cycle: "monthly", category: "生活" },
  { id: "gym", name: "健身房年卡", amount: 2400, cycle: "yearly", category: "生活" },
  { id: "insurance", name: "保险月缴", amount: 200, cycle: "monthly", category: "生活" },
];

/** 全部预设 */
function allPresets() {
  return PRESETS.map((p) => ({ ...p }));
}

/** 按分类分组，供界面渲染成"一格一格"的快捷入口 */
function presetsByCategory() {
  const groups = new Map();
  for (const preset of PRESETS) {
    const key = preset.category || "其他";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...preset });
  }
  return [...groups.entries()].map(([category, items]) => ({ category, items }));
}

/** 搜索预设（名称包含即可） */
function searchPresets(keyword) {
  const kw = String(keyword || "").trim().toLowerCase();
  if (!kw) return allPresets();
  return PRESETS.filter(
    (p) => p.name.toLowerCase().includes(kw) || (p.category || "").toLowerCase().includes(kw)
  ).map((p) => ({ ...p }));
}

/**
 * 把预设转成一条可保存的订阅记录。
 * @param {object} preset
 * @param {string} [startDate] YYYY-MM-DD，默认今天
 */
function presetToSubscription(preset, startDate) {
  const today = startDate || new Date().toISOString().slice(0, 10);
  return {
    id: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: preset.name,
    amount: preset.amount,
    currency: preset.currency || "CNY",
    cycle: preset.cycle,
    category: preset.category || "其他",
    startDate: today,
    autoRenew: true,
    note: "",
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  PRESETS,
  allPresets,
  presetsByCategory,
  searchPresets,
  presetToSubscription,
};
