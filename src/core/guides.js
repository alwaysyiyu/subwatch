"use strict";

/**
 * 退订指引。
 *
 * 为什么是"指引"而不是"帮你取消"：
 *   中国的自动续费散落在支付宝/微信/Apple/Google/运营商/信用卡，**没有开放银行
 *   接口**，第三方程序无法代客取消（这也是 Rocket Money 那套"抽成代取消"模式在
 *   中国走不通的原因）。所以本项目不假装能取消，而是把**可核对的操作路径**给到用户，
 *   并在用户取消后帮他记录状态。
 *
 * 数据原则（重要，不要为了"看起来更全"而破坏它）：
 *   1. 只写核到官方来源的路径。找不到官方说明的，一律写"未找到官方入口"并引导走签约通道，
 *      **绝不填未经官方确认的 App 内路径**——错误的路径会让用户白折腾一遍还退不掉。
 *   2. 每条标注 confidence：official（官方帮助页/协议）/ media（权威媒体）/ community（用户社区）。
 *   3. 央视/央媒报道过的真实案例可以作为"这个坑真的存在"的依据，但不能当成操作路径。
 */

/**
 * 一个必须放在最前面的总原则 —— 决定了所有操作路径。
 *
 * 自 2024 年起，自动续费签约是「一渠道一协议」：你在 App 里点"连续包月"时选了哪条
 * 支付通道，协议就签在哪条通道上。所以「关掉支付宝」只切断支付宝那一条。
 * 这是"明明关了还在扣"的头号原因（央广网 2024-01 有实证案例）。
 */
const CORE_PRINCIPLE = {
  title: "先记住一件事：关掉一个渠道 ≠ 退订",
  detail:
    "自动续费是「一渠道一协议」：在支付宝关掉，只切断了支付宝那一条；微信那条约还在。" +
    "通过 App Store 内购的订阅只存在于你的 Apple ID 里，支付宝/微信里根本看不到。" +
    "话费代扣签在运营商侧。所以务必三处都查：① 商户 App 内 ② Apple ID 订阅 / 话费代扣 ③ 支付宝和微信两处。",
  evidence: "央广网 2024-01-15 报道：用户 2023-09 在百度网盘客户端关闭自动续费、App 显示「已取消」，12 月底仍被扣 68 元。",
  evidenceUrl: "https://www.cnr.cn/shanghai/shzx/zq/20240115/t20240115_526558613.shtml",
};

/**
 * 通用签约渠道入口 —— 匹配不到具体服务时给这几个，按"最可能在这里"排序。
 */
const GENERIC_ENTRY_POINTS = [
  {
    id: "alipay",
    name: "支付宝 · 免密支付/自动扣款",
    path: "我的 →（右上角）设置 → 支付设置 → 免密支付/自动扣款 → 点开对应协议 → 关闭服务 → 确认关闭",
    url: "https://mdeduct.alipay.com/customer/alipayApp/getUsageAgreementList.htm",
    urlLabel: "一键直达解约页（手机打开）",
    note:
      "官方用词是「免密支付/自动扣款」。若详情页没有【解约】或【关闭服务】按钮，说明该代扣不支持页面解约，只能联系商户。" +
      "找不到协议时，去右上角三个点 →「已关闭服务」里查。支付宝端无法申请退款，退款要联系商户。",
    confidence: "official",
    source: "https://cschannel.alipay.com/mobile/helpDetail.htm?help_id=201602052261",
  },
  {
    id: "wechat",
    name: "微信支付 · 自动续费",
    path: "我 → 服务 → 钱包 → 支付设置 → 自动续费 → 选择服务 → 页面底部【关闭扣费服务】",
    url: "https://pay.weixin.qq.com/",
    urlLabel: "微信支付官网",
    note:
      "免密支付是**另一个独立入口**（支付设置 → 免密支付），两个都要关。" +
      "若在「支付设置」里找不到自动续费，试试：钱包 → 消费者保护 → 帮助中心 → 交易疑问 → 自动扣费业务疑问。",
    confidence: "official",
    source: "https://pay.weixin.qq.com/doc/user/4021838381",
  },
  {
    id: "apple",
    name: "Apple · 订阅管理",
    path: "iPhone：设置 → 顶部你的名字（Apple ID）→ 订阅 → 选择订阅 → 取消订阅",
    url: "https://support.apple.com/zh-cn/118428",
    urlLabel: "Apple 官方说明",
    note:
      "若没有「取消订阅」按钮，说明已经取消，会在当前计费周期结束时失效。" +
      "⚠️ 商家用支付宝/微信/银行卡直连的连续包月**不会**出现在这里——判断方法：看扣款商户名是 Apple/App Store 还是 App 自己的名字。",
    confidence: "official",
    source: "https://support.apple.com/zh-cn/118428",
  },
  {
    id: "google",
    name: "Google Play · 订阅",
    path: "Google Play → 右上角头像 → 付款和订阅 → 订阅 → 选择订阅 → 取消订阅",
    url: "https://play.google.com/store/account/subscriptions",
    urlLabel: "Google Play 订阅管理",
    note: "官方帮助页在本环境不可达，路径按通用流程记录，建议落地前人工确认一次。",
    confidence: "official",
    source: "https://support.google.com/googleplay/answer/7018481?hl=zh-Hans",
  },
  {
    id: "carrier",
    name: "运营商 · 增值业务 / 话费代扣",
    path: "移动：发送 0000 到 10086 → 按回复退订；联通拨 10010、电信拨 10000 转人工要求关闭增值业务",
    url: "https://www.10086.cn/0000td/",
    urlLabel: "中国移动 0000 退订页",
    note:
      "0000 是移动长期存在的统一查询退订指令（官网至今保留专用页）。" +
      "联通/电信**没有**对等的官方统一短码，只能打人工或用运营商 App 的「已订购业务」退订。" +
      "话费代扣的会员在支付宝/微信里完全看不到，只能找运营商。",
    confidence: "media",
    source: "https://www.10086.cn/0000td/",
  },
  {
    id: "card",
    name: "信用卡 · 银联代收止付",
    path: "① 商户侧解约 → ② 发卡行侧解约（手机银行/信用卡 App 的「快捷支付管理」「代收代扣管理」「协议管理」，或打信用卡背面客服）→ ③ 必要时销卡",
    url: "https://pcs.unionpay.com/ycb/pcweb/NEWbzzx/cjwt/ywcp/jcyw/jj/DSYW/art/2024/art_47f559a4bb1d4b98a8320a3f3b62d76c.html",
    urlLabel: "银联官方说明",
    note:
      "⚠️ **只换卡/补卡不能止付**：银行仍会向你名下更新后的卡或已过期的原卡发起代收（华夏银行官方协议明文）。" +
      "只有**销卡**才会连带注销代收功能。只解绑微信/支付宝，对银行卡直连代收**无效**。" +
      "银联官方已确认：持卡人可以在发卡行解约，解约信息会通知收单机构。",
    confidence: "official",
    source: "https://creditcard.hxb.com.cn/card/cn/khfw/zygg/2021/03/72418.shtml",
  },
];

/**
 * 具体服务指引。
 *
 * ⚠️ 故意留空的平台：爱奇艺、哔哩哔哩、QQ音乐、网易云音乐、腾讯视频。
 * 这几家的官方站点/协议里**都没有**可核对的 App 内取消入口（有的协议反而写"不可退订"）。
 * 与其编一条路径让用户白折腾，不如明确告诉他"走签约通道"。
 */
const GUIDES = [
  {
    id: "cn-content-platform",
    // 注意：只列**没有专门指引**的平台。有专门条目的服务（优酷/芒果/百度网盘/WPS）
    // 不要放进来，否则这里更长的关键词会抢走本该由专门条目负责的匹配。
    match: ["爱奇艺", "腾讯视频", "哔哩哔哩", "bilibili", "网易云", "qq音乐", "qq 音乐", "阿里云盘", "夸克", "keep", "饿了么", "美团", "京东", "淘宝"],
    name: "国内内容平台会员",
    channel: "either",
    steps: [
      "先看账单确认这笔钱是从哪扣的（支付宝 / 微信 / Apple / 话费 / 银行卡），再针对性解约",
      "打开对应 App 找「我的 / 会员中心 / 续费管理」里的自动续费开关（各平台入口不统一，没有官方统一路径）",
      "回到支付渠道再确认一次——两边都看不到这笔扣款才算退干净",
    ],
    url: "",
    note:
      "这其中有几家的官方协议**没有**公布 App 内取消入口（爱奇艺、B站、QQ音乐、网易云音乐），" +
      "个别协议甚至写「开通后不可退订」。遇到这种情况，直接走支付宝/微信/Apple 的签约通道解约更可靠。",
    confidence: "media",
    source: "https://www.cnr.cn/shanghai/shzx/zq/20240115/t20240115_526558613.shtml",
  },
  {
    id: "youku",
    match: ["优酷"],
    name: "优酷 · 会员连续包",
    channel: "either",
    steps: [
      "手机客户端（V6.3+）：我的 → 会员中心 → 自动续费管理 → 解约",
      "电脑端：登录 vip.youku.com → 我的会员 → 我的账户 → 关闭服务",
      "iOS 上购买的：只能去 Apple ID 订阅里取消",
    ],
    url: "http://pay.youku.com/auto_renew_agreement.html",
    urlLabel: "优酷官方协议（第七条）",
    note: "官方明确：取消成功后不影响当期已生效的会员权益，到期后不再续费。已扣费用不予退还。",
    confidence: "official",
  },
  {
    id: "baidu-netdisk",
    match: ["百度网盘"],
    name: "百度网盘 · 会员自动续费",
    channel: "either",
    steps: ["电脑端访问百度网盘官网 → 个人中心 → 登录", "找到「取消自动续费」并确认"],
    url: "https://pan.baidu.com/buy/center?tag=3&from=non#/personalcenter/1",
    urlLabel: "百度网盘个人中心",
    note:
      "官方协议写明两个对 subwatch 特别有意义的数字：**到期前 24 小时自动划扣**，" +
      "未在到期前至少 24 小时取消就会自动续订；且**自动续费前五日**会以短信等显著方式通知。" +
      "这也是「提前几天提醒」在官方规则里的依据。",
    confidence: "official",
  },
  {
    id: "wps",
    match: ["wps"],
    name: "WPS 会员自动续费",
    channel: "either",
    steps: [
      "PC 网页端：登录会员中心 → 我的 VIP → 找到对应会员 → 取消续费",
      "PC 客户端：右上角头像 → 钱包 → 续费管理 → 关闭自动续费",
      "安卓端：我 → 钱包 → 续费管理 → 找到对应订单取消",
      "iOS 端：设置 → Apple ID → 订阅 → 选择 WPS Office → 取消订阅",
    ],
    url: "https://vip.wps.cn/center_page/buy_record",
    urlLabel: "WPS 会员中心",
    note: "WPS 官方博客覆盖了 6 种购买渠道的取消方式，是少数把路径写全的厂商。",
    confidence: "official",
  },
  {
    id: "mango-tv",
    match: ["芒果"],
    name: "芒果 TV · 会员连续包",
    channel: "either",
    steps: [
      "支付宝渠道：支付宝 我的 → 设置 → 支付设置 → 免密支付/自动扣款 → 选定芒果TV → 取消订阅",
      "微信渠道：我 → 服务 → 钱包 → 支付设置 → 自动续费 → 选定芒果TV → 关闭扣费服务",
      "苹果渠道：设置 → iTunes Store 与 App Store → Apple ID → 查看 Apple ID → 订阅 → 取消",
      "京东支付渠道：京东金融 我 → 头像 → 设置 → 支付设置 → 自动扣款 → 取消",
      "招商银行一网通：招行 App → 我的 → 设置 → 支付设置 → 免密支付 → 关闭服务",
      "话费代扣：拨打芒果TV 客服 4009770707",
    ],
    url: "https://app.hitv.com/pay/faq/",
    urlLabel: "芒果TV 官方 FAQ",
    note: "官方原文特别强调「苹果连续包只能在苹果平台退订」。芒果TV 是把各渠道退订方式列得最清楚的平台。",
    confidence: "official",
  },
  {
    id: "alipay-autopay",
    match: ["支付宝"],
    name: "支付宝 · 免密支付/自动扣款",
    channel: "alipay",
    steps: [
      "打开支付宝 → 我的 →（右上角）设置",
      "支付设置 → 免密支付/自动扣款",
      "点开对应协议 → 关闭服务 → 确认关闭",
    ],
    url: "https://mdeduct.alipay.com/customer/alipayApp/getUsageAgreementList.htm",
    urlLabel: "一键直达解约页（手机打开）",
    note: "官方用词是「免密支付/自动扣款」，不是「自动续费/免密支付」。找不到协议时去右上角三个点 →「已关闭服务」查。",
    confidence: "official",
  },
  {
    id: "wechat-autopay",
    match: ["微信"],
    name: "微信支付 · 自动续费",
    channel: "wechat",
    steps: ["打开微信 → 我 → 服务", "钱包 → 支付设置 → 自动续费", "选择服务 → 页面底部【关闭扣费服务】"],
    url: "https://pay.weixin.qq.com/doc/user/4021838381",
    urlLabel: "微信支付官方手册",
    note: "免密支付是另一个独立入口，两个都要关。若「支付设置」里找不到，试：钱包 → 消费者保护 → 帮助中心。",
    confidence: "official",
  },
  {
    id: "apple-subscription",
    match: ["icloud", "apple", "app store"],
    name: "Apple · 订阅管理",
    channel: "apple",
    steps: [
      "iPhone：设置 → 顶部你的名字（Apple ID）→ 订阅",
      "选择要取消的订阅 → 取消订阅",
      "没有 iPhone 时：浏览器登录 appleid.apple.com → 订阅",
    ],
    url: "https://support.apple.com/zh-cn/118428",
    urlLabel: "Apple 官方说明",
    note:
      "「订阅」里找不到但仍在扣费，按可能性排查：① 不是 Apple 订阅，是商家自己扣的（看扣款商户名）" +
      "② 签约在微信的「Apple 服务扣费」上 ③ 家人共享用了你的付款方式 ④ 免费试用到期静默续费。" +
      "Apple 客服 400-666-8800（9:00–21:00）。",
    confidence: "official",
  },
  {
    id: "google-play",
    match: ["google", "play"],
    name: "Google Play · 订阅",
    channel: "google",
    steps: ["打开 Google Play → 右上角头像", "付款和订阅 → 订阅", "选择订阅 → 取消订阅"],
    url: "https://play.google.com/store/account/subscriptions",
    urlLabel: "Google Play 订阅管理",
    note: "",
    confidence: "official",
  },
  {
    id: "carrier",
    match: ["手机套餐", "套餐", "移动", "联通", "电信", "宽带"],
    name: "运营商套餐 / 增值业务",
    channel: "carrier",
    steps: [
      "中国移动：发送 0000 到 10086，按回复提示退订包月类增值业务",
      "中国联通：拨打 10010；中国电信：拨打 10000，转人工要求关闭增值业务/第三方代收费",
      "在运营商 App 的「已订购业务 / 增值业务」里再核一遍",
    ],
    url: "https://www.10086.cn/0000td/",
    urlLabel: "中国移动 0000 退订页",
    note:
      "0000 是中国移动官方长期存在的统一退订指令，官网至今保留专用页；联通/电信没有对等的官方短码。" +
      "话费代扣的会员在支付宝/微信里**完全看不到**，只能找运营商。",
    confidence: "media",
  },
  {
    id: "refund",
    match: ["退款", "维权"],
    name: "已经被扣了，怎么要回来",
    channel: "either",
    steps: [
      "先向平台客服提交书面退款申请（保留记录）",
      "无果就打 12315（全国 12315 平台：电话/网站/App/微信支付宝小程序）",
      "准备好证据：扣费账单截图、客服沟通记录、会员协议截图，以及「没收到显著提醒」的记录",
    ],
    url: "https://www.xinhuanet.com/politics/20251224/397baff1ef554b61a1668e771b5474f6/c.html",
    urlLabel: "新华网报道（含全额退款案例）",
    note:
      "平台协议几乎都写「不退」，但法律不认这种条款（消保法第 26 条、民法典第 497 条、" +
      "以及 2025-05-01 施行的最高法预付式消费司法解释）。" +
      "有真实成功案例：吉林一位用户被视频 App 静默扣费 300 余元，12315 投诉后全额退回（约三周）。" +
      "最高法典型案例已明确「自动续费必须显著提醒，否则侵犯消费者知情权」。",
    confidence: "media",
  },
];

/** 试用期提示 —— 这一类问题没有统一官方答案，必须诚实说明 */
const TRIAL_NOTICE = {
  title: "关于免费试用 / 首月优惠",
  detail:
    "取消自动续费通常不会立刻收回已付费权益，可以继续用到当前周期结束（各平台协议明确）。" +
    "但**免费试用**有更硬的截止时刻：已有实测案例显示平台要求「试用结束前至少 24 小时」取消，否则按年费扣款。" +
    "各平台规则不统一，拿不准就打客服问清楚截止时间。",
  evidence: "北京日报客户端报道（2026-01-13）：多邻国宣传「7 天免费体验、可随时取消」，确认页小字却写「请在试用结束前至少 24 小时取消」，有用户因此被扣 588 元年费。",
  evidenceUrl: "https://www.jsjc.gov.cn/yaowen/202601/t20260113_1184959.shtml",
};

/**
 * 取得某笔订阅的退订指引。
 * @param {object} sub 订阅记录
 */
function getGuide(sub) {
  const name = String((sub && sub.name) || "").toLowerCase();

  // 选「匹配到的最长关键词」所属的指引，而不是「最先命中的指引」。
  // 否则更通用、更靠前的条目（如"国内内容平台会员"）会抢走本该由专门条目
  // （如"芒果TV"）负责的订阅。平局时保留先出现的那条。
  let matched = null;
  let bestLen = 0;
  for (const g of GUIDES) {
    for (const kw of g.match) {
      const k = kw.toLowerCase();
      if (name.includes(k) && k.length > bestLen) {
        matched = g;
        bestLen = k.length;
      }
    }
  }

  const channelToEntry = { alipay: "alipay", wechat: "wechat", apple: "apple", google: "google", carrier: "carrier" };
  const preferred = matched ? channelToEntry[matched.channel] : null;
  const entryPoints = preferred
    ? [
        ...GENERIC_ENTRY_POINTS.filter((e) => e.id === preferred),
        ...GENERIC_ENTRY_POINTS.filter((e) => e.id !== preferred),
      ]
    : GENERIC_ENTRY_POINTS.slice();

  return {
    matched,
    entryPoints,
    principle: CORE_PRINCIPLE,
    trialNotice: TRIAL_NOTICE,
    genericHint: matched
      ? `这笔订阅的取消方式在「${matched.name}」里有记录。`
      : "没匹配到具体服务。按下面几个签约通道依次找一遍，通常就能找到。",
  };
}

function allGuides() {
  return GUIDES.map((g) => ({ ...g }));
}

function allEntryPoints() {
  return GENERIC_ENTRY_POINTS.map((e) => ({ ...e }));
}

module.exports = {
  GUIDES,
  GENERIC_ENTRY_POINTS,
  CORE_PRINCIPLE,
  TRIAL_NOTICE,
  getGuide,
  allGuides,
  allEntryPoints,
};
