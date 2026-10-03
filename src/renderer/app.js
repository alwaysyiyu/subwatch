"use strict";

/**
 * 渲染层主逻辑。
 *
 * 只通过 window.subwatch 这个接口拿数据 —— 它在 Electron 下由 preload 提供，
 * 在浏览器里由 browser-shim.js 提供，业务行为一致。
 */

const api = window.subwatch;
if (!api) {
  document.body.innerHTML = "<p style='padding:24px'>未找到 subwatch 接口，界面无法启动。</p>";
  throw new Error("缺少 window.subwatch");
}

// 离线校验（verify-ui.js）会预先注入这个对象，用来断言界面渲染结果。
// 注意在模块加载时就挂上可用方法，而不是等用户点开弹层——否则启动即校验会取不到。
window.__appInternals = Object.assign(window.__appInternals || {}, {
  openActions: (...args) => openActions(...args),
  openGuide: (...args) => openGuide(...args),
  deleteRecord: (...args) => deleteRecord(...args),
  buildChoices: (...args) => buildChoices(...args),
  // 离线演练改完数据后需要让界面重新取数，否则断言的是过期状态
  refresh: (...args) => refresh(...args),
  currentRows: () => (dash ? dash.rows : []),
});

/** @type {{rows:any[], summary:any, dueCount:number}|null} */
let dash = null;
let presets = [];
let meta = null;

const $ = (id) => document.getElementById(id);

function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("err", isError);
  el.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 把"距扣费天数"变成人话 */
function countdownText(days, nextDate) {
  if (days < 0) return `已过期 · ${nextDate}`;
  if (days === 0) return "今天要扣";
  if (days === 1) return "明天要扣";
  if (days <= 7) return `${days} 天后要扣`;
  return `${nextDate} 扣费`;
}

const CYCLE_LABEL = {
  weekly: "每周",
  monthly: "每月",
  quarterly: "每季度",
  semiannual: "每半年",
  yearly: "每年",
};

/* ---------------- 渲染 ---------------- */

function renderTotals() {
  const s = dash.summary;
  $("totalMonthly").textContent = s.monthlyText;
  $("totalYearly").textContent = s.yearlyText;
  $("totalCount").textContent = String(s.count);
  $("totalDue").textContent = String(dash.dueCount);
  const box = $("dueBox");
  box.classList.toggle("hidden", dash.dueCount === 0);
  box.classList.toggle("hot", dash.rows.some((r) => r.urgency === "urgent"));
}

function renderBanner() {
  // 待处理横幅：优先于"即将扣费"，因为这是用户自己承认"还没处理"的事
  const pending = dash.rows.filter((r) => r.canceledAt === "uncanceled");
  const pendingBox = $("pendingBanner");
  if (pending.length > 0) {
    const total = pending.reduce((sum, r) => sum + r.amount, 0);
    pendingBox.innerHTML =
      `你标记了 <strong>${pending.length} 项还没退订</strong>，还在持续扣费（合计 ${"¥" + total.toFixed(0)}）。` +
      `点下面直接看退订路径：` +
      pending
        .map(
          (r) =>
            `<button class="btn btn-ghost btn-sm pending-item" data-open-pending="${esc(r.id)}">${esc(r.name)}</button>`
        )
        .join(" ");
    pendingBox.classList.remove("hidden");
  } else {
    pendingBox.classList.add("hidden");
  }

  const banner = $("dueBanner");
  const urgent = dash.rows.filter((r) => r.dueSoon);
  if (urgent.length === 0) {
    banner.classList.add("hidden");
    return;
  }
  const soonest = urgent[0];
  const total = urgent.reduce((sum, r) => sum + r.amount, 0);
  const when = soonest.daysUntilCharge === 0 ? "今天" : soonest.daysUntilCharge === 1 ? "明天" : `${soonest.daysUntilCharge} 天后`;
  banner.innerHTML =
    `<strong>${urgent.length} 项订阅近期要扣费</strong>，合计约 ¥${total.toFixed(0)}。` +
    `最近的是 <strong>${esc(soonest.name)}</strong>（${when}扣 ${soonest.amountText}）——要留还是退？`;
  banner.classList.remove("hidden");
}

/** 预设网格：按分类分组，一点即加 */
function presetGridHtml() {
  const groups = presets;
  const parts = [];
  for (const group of groups) {
    parts.push(`<div class="preset-group-title">${esc(group.category)}</div>`);
    for (const p of group.items) {
      const cur = p.currency && p.currency !== "CNY" ? ` ${p.currency}` : "";
      parts.push(
        `<button class="preset" data-preset="${esc(p.id)}">
           <div class="preset-name">${esc(p.name)}</div>
           <div class="preset-meta">${p.amount}${cur} / ${CYCLE_LABEL[p.cycle] || p.cycle}</div>
         </button>`
      );
    }
  }
  return parts.join("");
}

function renderPresetGrids() {
  const html = presetGridHtml();
  $("presetGrid").innerHTML = html;
  $("presetGridEmpty").innerHTML = html;
}

function renderList() {
  const hasAny = dash.rows.length > 0;
  $("emptyState").classList.toggle("hidden", hasAny);
  $("listSection").classList.toggle("hidden", !hasAny);

  const list = $("list");
  list.innerHTML = dash.rows
    .map((r) => {
      const urgentClass = r.urgency === "urgent" ? "urgency-urgent" : r.urgency === "soon" ? "urgency-soon" : r.urgency === "upcoming" ? "urgency-upcoming" : "";
      const dueClass = r.dueSoon ? "due" : "";
      const pendingClass = r.canceledAt === "uncanceled" ? "pending" : "";
      const autoTag = r.autoRenew ? `<span class="tag tag-auto">自动续费</span>` : `<span class="tag">手动</span>`;
      // 标记过"还没退"的显示醒目标记；退订完成的显示绿标
      const stateTag =
        r.canceledAt === "uncanceled"
          ? `<span class="tag tag-pending">还没退订</span>`
          : r.canceledAt
          ? `<span class="tag tag-done">已退订</span>`
          : "";
      return `
      <div class="item ${urgentClass} ${dueClass} ${pendingClass}">
        <div class="item-bar"></div>
        <div class="item-body">
          <div class="item-top">
            <span class="item-name">${esc(r.name)}</span>
            ${autoTag}
            ${stateTag}
            <span class="tag">${esc(r.category || "其他")}</span>
          </div>
          <div class="item-sub">
            <span class="countdown">${esc(countdownText(r.daysUntilCharge, r.nextChargeDate))}</span>
            · ${r.amountText} / ${CYCLE_LABEL[r.cycle] || r.cycle}
            · 月均 ${r.monthlyText}
          </div>
        </div>
        <div class="item-right">
          <div class="item-amount">${r.amountText}</div>
          <div class="item-actions">
            <button class="btn btn-ghost btn-sm btn-danger" data-del="${esc(r.id)}" title="怎么退订 / 删除记录">退订</button>
            <button class="btn btn-ghost btn-sm" data-edit="${esc(r.id)}">改</button>
          </div>
        </div>
      </div>`;
    })
    .join("");
}

function renderAll() {
  renderTotals();
  renderBanner();
  renderList();
}

/* ---------------- 数据 ---------------- */

async function refresh() {
  dash = await api.list();
  renderAll();
  // 引导条的可见性依赖"用户是否确认过"这个标记，数据刷新时要一并同步，
  // 否则标记变了但引导条还挂在那里。
  await refreshSetupBar();
}

async function addPreset(presetId) {
  try {
    const sub = await api.addFromPreset({ presetId, startDate: todayStr() });
    if (presetId === firstAddedPresetId) {
      firstAddedPresetId = null;
      $("addModal").classList.add("hidden");
    }
    await refresh();
    toast(`已添加「${sub.name}」`);
  } catch (err) {
    toast(`添加失败：${err.message}`, true);
  }
}

// 空状态里点第一个预设时顺手关掉弹层；记录一下是哪个入口触发的
let firstAddedPresetId = null;

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 预设点击（弹层 + 空状态两处共用）
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-preset]");
    if (btn) {
      addPreset(btn.dataset.preset);
      return;
    }

    const del = e.target.closest("[data-del]");
    if (del) {
      // 一级就是三个带说明的选项，而不是"确定/取消"——
      // 后者说不清"确定"之后到底会发生什么，而"标记已退订"和"删除记录"的后果完全不同。
      openActions(del.dataset.del);
      return;
    }

    const choice = e.target.closest("[data-choice]");
    if (choice) {
      const id = actionSubId;
      if (!id) return;
      switch (choice.dataset.choice) {
        case "guide":
          openGuide(id, { keepGuide: true });
          break;
        case "canceled":
          markCanceled(new Date().toISOString());
          break;
        case "pending":
          markCanceled("uncanceled");
          break;
        case "delete":
          deleteRecord(id);
          break;
      }
      return;
    }

    const openPending = e.target.closest("[data-open-pending]");
    if (openPending) {
      // 待处理横幅里的项直达退订路径
      openGuide(openPending.dataset.openPending, { direct: true, keepGuide: true });
      return;
    }

    const edit = e.target.closest("[data-edit]");
    if (edit) {
      const row = dash.rows.find((r) => r.id === edit.dataset.edit);
      if (!row) return;
      openManualForm(row);
      return;
    }

    const open = e.target.closest("[data-open]");
    if (open) {
      api.openExternal(open.dataset.open).catch((err) => toast(err.message, true));
      return;
    }

    const close = e.target.closest("[data-close]");
    if (close) {
      $(close.dataset.close).classList.add("hidden");
      return;
    }

    const tab = e.target.closest(".tab");
    if (tab) {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const which = tab.dataset.tab;
      $("tabPreset").classList.toggle("hidden", which !== "preset");
      $("tabManual").classList.toggle("hidden", which !== "manual");
      return;
    }
  });

  $("btnAdd").addEventListener("click", () => openAddModal("preset"));
  $("btnManualFromEmpty").addEventListener("click", () => openAddModal("manual"));
  $("btnMarkCanceled").addEventListener("click", () => markCanceled(new Date().toISOString()));
  $("btnMarkUncanceled").addEventListener("click", () => markCanceled("uncanceled"));
  $("btnActionBack").addEventListener("click", () => openActions(guideSubId || actionSubId, { keepGuide: true }));

  // ---- 首次运行引导 ----
  $("btnTestNotify").addEventListener("click", async () => {
    try {
      const r = await api.testNotify();
      if (r && r.shown) {
        toast("已发送。看到右下角/通知中心的提醒了吗？");
      } else {
        toast((r && r.reason) || "无法发送测试通知", true);
      }
    } catch (err) {
      toast(`发送失败：${err.message}`, true);
    }
  });

  $("btnToggleAutostart").addEventListener("click", async () => {
    try {
      const cur = await api.getAutostart();
      if (cur && cur.unsupported) {
        toast("当前环境不支持开机自启设置（浏览器预览模式）", true);
        return;
      }
      const next = !cur.enabled;
      const r = await api.setAutostart(next);
      toast(r.enabled ? "已开启开机自启，下次开机它会自己在托盘里待命" : "已关闭开机自启");
      await refreshSetupBar();
    } catch (err) {
      toast(`设置失败：${err.message}`, true);
    }
  });

  $("btnSetupDone").addEventListener("click", async () => {
    try {
      await api.setFlag("setupConfirmed", true);
      $("setupBar").classList.add("hidden");
      toast("好，之后不再提示");
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  });

  $("presetSearch").addEventListener("input", (e) => {
    const kw = e.target.value.trim();
    const core = window.subwatchCore;
    if (!core) return;
    const found = core.searchPresets(kw);
    const grid = $("presetGrid");
    if (kw === "") {
      grid.innerHTML = presetGridHtml();
      return;
    }
    if (found.length === 0) {
      grid.innerHTML = `<div class="preset-group-title">没有匹配的预设，请用「手动填写」</div>`;
      return;
    }
    grid.innerHTML = found
      .map(
        (p) => `<button class="preset" data-preset="${esc(p.id)}">
          <div class="preset-name">${esc(p.name)}</div>
          <div class="preset-meta">${p.amount} / ${CYCLE_LABEL[p.cycle] || p.cycle}</div>
        </button>`
      )
      .join("");
  });

  $("tabManual").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const payload = {
      name: form.name.value,
      amount: form.amount.value,
      currency: form.currency.value,
      cycle: form.cycle.value,
      category: form.category.value || "其他",
      startDate: form.startDate.value,
      note: form.note.value,
    };
    try {
      if (editingId) {
        await api.update({ id: editingId, patch: payload });
        toast("已保存修改");
      } else {
        await api.add(payload);
        toast(`已添加「${payload.name}」`);
      }
      editingId = null;
      $("addModal").classList.add("hidden");
      form.reset();
      $("addTitle").textContent = "添加订阅";
      await refresh();
    } catch (err) {
      toast(`保存失败：${err.message}`, true);
    }
  });

  $("btnShare").addEventListener("click", async () => {
    const card = await api.shareCard();
    $("sharePreview").innerHTML = `
      <div class="share-title">${esc(card.title)}</div>
      <div class="share-big">${esc(card.yearlyText)}</div>
      <div class="share-sub">一年 · 共 ${card.count} 项订阅 · 月均 ${esc(card.monthlyText)}</div>
      <ul class="share-lines">
        ${card.topLines.map((l) => `<li>${esc(l)}</li>`).join("")}
      </ul>
      <div class="share-footer">${esc(card.footer)}</div>`;
    $("shareModal").classList.remove("hidden");
    $("btnCopyShare").onclick = async () => {
      const text = `${card.title}：${card.yearlyText}／年（共 ${card.count} 项，月均 ${card.monthlyText}）\n${card.topLines.join("\n")}\n${card.footer}`;
      await api.copyText(text);
      toast("已复制到剪贴板");
    };
  });

  $("btnExport").addEventListener("click", async () => {
    try {
      const csv = await api.exportCsv();
      await api.saveCsv(csv);
      toast("已导出 CSV");
    } catch (err) {
      toast(`导出失败：${err.message}`, true);
    }
  });

  // Esc 关闭弹层
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModals();
  });
}

/* ---------------- 弹层控制 ---------------- */

let editingId = null;
let guideSubId = null;
let actionSubId = null;

/**
 * 一级：动作选择。
 *
 * 设计取舍：把三个动作**直接摆出来并各配一句说明**，而不是弹一个"确定/取消"。
 * 因为"确定"什么都没说清楚——用户不知道确定之后是"标记已退订"还是"删掉记录"，
 * 而这两件事的后果完全不同（后者会让人忘记自己还没退、继续被扣钱）。
 */
function openActions(subId, opts = {}) {
  const row = dash.rows.find((r) => r.id === subId);
  if (!row) return;
  actionSubId = subId;

  const isPending = row.canceledAt === "uncanceled";
  const alreadyDone = Boolean(row.canceledAt) && !isPending;

  $("actionTitle").textContent = `退订「${row.name}」`;
  $("actionSubtitle").textContent = `${row.amountText} / ${CYCLE_LABEL[row.cycle] || row.cycle} · ${
    isPending ? "你之前标记过「还没退订」" : alreadyDone ? "你之前标记过「已退订」" : "还没处理"
  }`;

  const choices = buildChoices({ isPending, alreadyDone });

  $("actionChoices").innerHTML = choices
    .map(
      (c) => `<button class="choice ${c.primary ? "choice-primary" : ""} ${c.danger ? "choice-danger" : ""}" data-choice="${c.id}">
        <div class="choice-label">${esc(c.label)}</div>
        <div class="choice-desc">${esc(c.desc)}</div>
      </button>`
    )
    .join("");

  if (!opts.keepGuide) $("guideModal").classList.add("hidden");
  $("actionModal").classList.remove("hidden");
}

/**
 * 一级动作选项（纯函数，便于测试直接断言"用户看到的四个选项"）。
 *
 * 关键：每个选项都必须带一句说明。用户反馈过"确定/取消"看不懂 ——
 * 因为"确定"没说是标记已退订还是删掉记录，而这两件事后果完全不同。
 */
function buildChoices({ isPending = false, alreadyDone = false } = {}) {
  return [
    {
      id: "guide",
      label: "告诉我怎么退",
      desc: "给出这个服务的具体退订路径（哪个 App、哪一层菜单），以及容易踩的坑。",
      primary: !alreadyDone,
    },
    {
      id: "canceled",
      label: alreadyDone ? "已退订 ✓" : "我已经退订了",
      desc: "标记为已处理，之后不再提醒这笔。以后如果发现还在扣，把状态改回来就行。",
    },
    {
      id: "pending",
      label: isPending ? "仍然标记为「还没退」" : "还没退，先记着",
      desc: "我会在顶部一直提醒你这笔还在扣钱，直到你退掉为止。",
    },
    {
      id: "delete",
      label: "不想记了，删除记录",
      desc: "只删掉本地这条记录，不会替你取消订阅。删掉之后我不会再提醒你——如果其实还没退，不建议用这个。",
      danger: true,
    },
  ];
}

/**
 * 二级 + 直达：退订路径。
 * 技术上无法代客取消（中国没有开放银行接口），所以给可核对的路径。
 */
function openGuide(subId, opts = {}) {
  const row = dash.rows.find((r) => r.id === subId);
  if (!row) return;
  const core = window.subwatchCore;
  const guide =
    core && core.getGuide
      ? core.getGuide(row)
      : { matched: null, entryPoints: [], genericHint: "", principle: null, trialNotice: null };

  guideSubId = subId;
  $("guideTitle").textContent = `怎么退「${row.name}」`;
  $("guideBody").innerHTML = renderGuideBody(guide);

  const isPending = row.canceledAt === "uncanceled";
  $("btnMarkUncanceled").textContent = isPending ? "仍然标记为「还没退」" : "还没退，先记着";
  $("btnMarkCanceled").textContent =
    row.canceledAt && row.canceledAt !== "uncanceled" ? "已退订 ✓" : "我已经退订了";
  // 从一级弹层进来的才有"返回"，从待处理横幅直达的就没有
  $("btnActionBack").classList.toggle("hidden", Boolean(opts.direct));

  $("actionModal").classList.add("hidden");
  $("guideModal").classList.remove("hidden");
}

function renderGuideBody(guide) {
  const principleHtml = guide.principle
    ? `<div class="guide-principle">
         <div class="guide-principle-title">⚠️ ${esc(guide.principle.title)}</div>
         <div>${esc(guide.principle.detail)}</div>
         <div class="muted small">依据：${esc(guide.principle.evidence)}
           ${guide.principle.evidenceUrl ? `<button class="btn btn-ghost btn-sm" data-open="${esc(guide.principle.evidenceUrl)}">查看报道</button>` : ""}
         </div>
       </div>`
    : "";

  const stepsHtml = guide.matched
    ? `<ol class="guide-steps">${guide.matched.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`
    : `<p class="muted small">没有针对这个服务的专门指引——因为官方没公布过可核对的入口。按下面的签约通道找。</p>`;

  const matchedLink =
    guide.matched && guide.matched.url
      ? `<button class="btn btn-ghost btn-sm" data-open="${esc(guide.matched.url)}">${esc(guide.matched.urlLabel || "打开官方页面")}</button>`
      : "";
  const matchedConfidence =
    guide.matched && guide.matched.confidence === "media"
      ? `<span class="muted small">（来源：权威媒体，非官方公布）</span>`
      : "";

  const noteHtml =
    guide.matched && guide.matched.note ? `<div class="guide-note">注意：${esc(guide.matched.note)}</div>` : "";

  const trialHtml = guide.trialNotice
    ? `<div class="guide-note guide-note-trial">
         <strong>${esc(guide.trialNotice.title)}</strong><br>${esc(guide.trialNotice.detail)}
         <div class="muted small">依据：${esc(guide.trialNotice.evidence)}
           <button class="btn btn-ghost btn-sm" data-open="${esc(guide.trialNotice.evidenceUrl)}">查看报道</button>
         </div>
       </div>`
    : "";

  const entriesHtml = `
    <div class="guide-section-title">${guide.matched ? "其他可能的签约通道" : "依次检查这几个签约通道"}</div>
    <ul class="guide-entries">
      ${guide.entryPoints
        .map(
          (e) => `<li>
            <div class="guide-entry-head">
              <strong>${esc(e.name)}</strong>
              ${e.url ? `<button class="btn btn-ghost btn-sm" data-open="${esc(e.url)}">${esc(e.urlLabel || "打开")}</button>` : `<span class="muted small">App 内操作</span>`}
            </div>
            <div class="guide-entry-path">${esc(e.path)}</div>
            ${e.note ? `<div class="muted small guide-entry-note">${esc(e.note)}</div>` : ""}
          </li>`
        )
        .join("")}
    </ul>`;

  const disclaimer = `<p class="muted small guide-disclaimer">
    subwatch 不能替你取消订阅——自动续费散落在支付宝/微信/Apple/运营商/银行，没有开放接口，第三方程序做不到。
    上面是核对过的路径，照着点就行。</p>`;

  return (
    disclaimer + principleHtml + stepsHtml + matchedLink + matchedConfidence + noteHtml + trialHtml + entriesHtml
  );
}

async function markCanceled(state) {
  const id = guideSubId || actionSubId;
  if (!id) return;
  try {
    await api.update({ id, patch: { canceledAt: state } });
    await refresh();
    closeModals();
    toast(state === "uncanceled" ? "已标记「还没退订」，我会继续提醒你" : "已标记退订完成");
  } catch (err) {
    toast(`保存失败：${err.message}`, true);
  } finally {
    guideSubId = null;
    actionSubId = null;
  }
}

/** 删除本地记录（不动订阅本身） */
async function deleteRecord(subId) {
  try {
    await api.remove({ id: subId });
    await refresh();
    closeModals();
    toast("已移除记录");
  } catch (err) {
    toast(`删除失败：${err.message}`, true);
  } finally {
    guideSubId = null;
    actionSubId = null;
  }
}

function closeModals() {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
}

/**
 * 首次运行引导。
 *
 * 为什么要有这一段：整个应用的价值建立在"系统通知能到达用户"上，但
 * ① 开机自启默认是关的（用户不手动开就永远收不到提醒）
 * ② 未签名应用、专注助手、系统通知设置都可能让通知静默失败
 * 与其等某个该被提醒的日子什么都没发生、用户以为"这工具没用"，
 * 不如在第一次打开时就让他亲手确认这两件事。
 *
 * 用户点过「我已确认」之后就不再出现。
 */
async function refreshSetupBar() {
  const bar = $("setupBar");
  if (!bar) return;
  try {
    const confirmed = await api.getFlag("setupConfirmed");
    if (confirmed) {
      bar.classList.add("hidden");
      return;
    }
    const auto = await api.getAutostart();
    const autoOn = Boolean(auto && auto.enabled);
    $("btnToggleAutostart").textContent = autoOn ? "关闭开机自启" : "开启开机自启";
    $("setupDetail").textContent = autoOn
      ? "已开启开机自启，它会一直在托盘待命。再确认一下通知能弹出来就能放心了。"
      : "subwatch 靠系统通知提醒你。先确认两件事：通知能弹出来、开机后它会自己启动。";
    bar.classList.remove("hidden");
  } catch {
    bar.classList.add("hidden");
  }
}

function openAddModal(tab) {
  editingId = null;
  $("addTitle").textContent = "添加订阅";
  $("tabManual").reset();
  $("tabManual").startDate.value = todayStr();
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  $("tabPreset").classList.toggle("hidden", tab !== "preset");
  $("tabManual").classList.toggle("hidden", tab !== "manual");
  $("addModal").classList.remove("hidden");
  if (tab === "preset") $("presetSearch").focus();
}

function openManualForm(row) {
  editingId = row.id;
  $("addTitle").textContent = `修改「${row.name}」`;
  const f = $("tabManual");
  f.name.value = row.name;
  f.amount.value = row.amount;
  f.currency.value = row.currency || "CNY";
  f.cycle.value = row.cycle;
  f.category.value = row.category || "";
  f.startDate.value = row.startDate;
  f.note.value = row.note || "";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === "manual"));
  $("tabPreset").classList.add("hidden");
  $("tabManual").classList.remove("hidden");
  $("addModal").classList.remove("hidden");
}

/* ---------------- 启动 ---------------- */

async function boot() {
  try {
    [meta, presets, dash] = await Promise.all([api.meta(), api.presets(), api.list()]);

    // 填充下拉框
    $("selCycle").innerHTML = (meta.cycles || [])
      .map((c) => `<option value="${esc(c.value)}">${esc(c.label)}</option>`)
      .join("");
    $("selCycle").value = "monthly";
    $("selCurrency").innerHTML = (meta.currencies || ["CNY"])
      .map((c) => `<option value="${esc(c)}">${esc(c)}</option>`)
      .join("");
    $("categoryList").innerHTML = (meta.categories || [])
      .map((c) => `<option value="${esc(c)}"></option>`)
      .join("");

    renderPresetGrids();
    renderAll();
    bindEvents();
    await refreshSetupBar();

    if (api.platform === "browser") {
      console.info("[subwatch] 浏览器预览模式。数据在 localStorage，与桌面版行为一致。");
    }
  } catch (err) {
    toast(`启动失败：${err.message}`, true);
    console.error(err);
  }
}

boot();
