"use strict";

const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, clipboard, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const { Store } = require("../core/store");
const { Notifier } = require("./notifier");
const { ensureIconFile } = require("./icon");
const { createApi } = require("./app-api");

/**
 * Electron 主进程。
 *
 * 这里只做"平台相关"的事：窗口、托盘、系统通知、开机自启、文件对话框。
 * 业务逻辑一律放在 app-api.js（可测试）与 core/（纯函数）里。
 * 这样即使 Electron 装不上，业务代码也能在纯 node 下跑测试。
 */

let mainWindow = null;
let tray = null;
let store = null;
let notifier = null;
let api = null;
let iconPath = null;

const isDev = !app.isPackaged;

/**
 * 极早期文件日志。
 *
 * 存在的理由：pipeline 崩溃时 stdout 可能完全抓不到（这次开发中就遇到了），
 * 光靠控制台无法判断卡在哪一步。这个日志在 require 阶段就开始写，不依赖
 * app.whenReady()，是排查启动问题最可靠的第一手证据。
 *
 * 路径固定在各平台的临时目录，避免依赖 app.getPath("userData")（它本身可能失败）。
 */
const EARLY_LOG = path.join(require("node:os").tmpdir(), "subwatch-boot.log");
function log(stage, extra) {
  try {
    const line = `${new Date().toISOString()} [${process.pid}] ${stage}${extra ? " " + JSON.stringify(extra) : ""}\n`;
    fs.appendFileSync(EARLY_LOG, line, "utf8");
  } catch {
    /* 日志失败不能影响启动 */
  }
}
log("module:loaded", { electron: process.versions.electron, argv: process.argv.slice(1) });

/**
 * 冒烟探针：设置 SUBWATCH_SMOKE=1 时，启动完成后把关键状态写进 userData/boot.json，
 * 然后自行退出。用于在无法观察窗口的环境里验证"到底有没有启动成功"。
 */
const SMOKE = process.env.SUBWATCH_SMOKE === "1";

/**
 * 是否以"静默"方式启动（开机自启会带 --hidden，只进托盘不弹窗）。
 * 用户的窗口显示入口始终是托盘图标，所以静默启动不会让人找不到它。
 */
const START_HIDDEN = process.argv.includes("--hidden");

function writeBootReport(extra = {}) {
  try {
    const report = {
      ok: extra.ok !== false,
      pid: process.pid,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      userData: app.getPath("userData"),
      dataFile: userDataFile(),
      windowCreated: Boolean(mainWindow),
      trayCreated: Boolean(tray),
      subscriptionCount: store ? store.list().length : -1,
      summary: store ? store.summary() : null,
      args: process.argv.slice(1),
      at: new Date().toISOString(),
      ...extra,
    };
    fs.writeFileSync(path.join(app.getPath("userData"), "boot.json"), JSON.stringify(report, null, 2), "utf8");
    log("boot:report", { ok: report.ok });
  } catch (err) {
    log("boot:report-failed", { error: String(err && err.message) });
    if (SMOKE) process.exitCode = 2;
  }
}

function userDataFile() {
  return path.join(app.getPath("userData"), "data.json");
}

/** 创建主窗口 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    title: "subwatch",
    icon: iconPath,
    backgroundColor: "#16181d",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      // 安全基线：渲染层拿不到 node，只能通过 preload 暴露的白名单接口
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // 先隐藏再显示，避免白屏闪一下。
  //
  // --hidden 的处理很关键：开机自启就是用这个参数启动的，
  // 如果不管它，每次开机都会弹出一个窗口。而"会弹窗的常驻工具"，
  // 用户第一次开机就会去把开机自启关掉 —— 而开机自启正是提醒能生效的前提。
  // 所以带 --hidden 时只进托盘，不显示窗口。
  mainWindow.once("ready-to-show", () => {
    if (START_HIDDEN) {
      log("start:hidden", { reason: "带 --hidden 启动，只进托盘不显示窗口" });
      return;
    }
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: "detach" });
  });

  // 关闭时收进托盘而不是退出（提醒是产品价值，得让它常驻）
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // 外链一律用系统浏览器打开，不在应用内导航
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

/** 发送系统通知；点击后聚焦窗口 */
function sendNotification({ title, body }) {
  if (!Notification.isSupported()) {
    console.warn("[main] 当前系统不支持通知，已跳过：", title);
    return;
  }
  const n = new Notification({
    title,
    body,
    icon: iconPath,
    silent: false,
  });
  n.on("click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  n.show();
}

/** 托盘：常驻 + 快捷操作 + 显示本月支出（给用户一个"顺路打开"的理由） */
function createTray() {
  tray = new Tray(iconPath);
  refreshTray();
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function refreshTray() {
  if (!tray) return;
  const subs = store.list();
  const summary = store.summary();
  const due = subs.filter((s) => {
    try {
      const { evaluateReminder } = require("../core/reminder");
      return evaluateReminder(s).shouldNotify;
    } catch {
      return false;
    }
  });

  tray.setToolTip(
    due.length > 0
      ? `subwatch · ${due.length} 项订阅近期要扣费`
      : `subwatch · ${summary.count} 项订阅，月均 ${summary.monthlyText}`
  );

  const menu = Menu.buildFromTemplate([
    { label: `本月支出 ${summary.monthlyText}　本年 ${summary.yearlyText}`, enabled: false },
    { type: "separator" },
    {
      label: due.length > 0 ? `⚠ ${due.length} 项近期要扣费` : "近期无扣费",
      enabled: false,
    },
    { type: "separator" },
    {
      label: "打开 subwatch",
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: "立即检查提醒",
      click: () => {
        const sent = notifier.check();
        if (sent.length === 0) {
          sendNotification({ title: "近期没有要扣费的订阅", body: "放心，有情况我会提醒你。" });
        }
        refreshTray();
      },
    },
    { type: "separator" },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--hidden"] });
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

/** 把 api 方法表挂到 ipcMain */
function registerIpc() {
  for (const [channel, handler] of Object.entries(api)) {
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        return { ok: true, data: await handler(payload) };
      } catch (err) {
        // 统一错误信封：界面永远拿得到可显示的信息，而不是一个裸异常
        return { ok: false, error: String((err && err.message) || err) };
      }
    });
  }

  // 这几个需要 Electron 能力，不进 app-api
  ipcMain.handle("shell:openExternal", async (_e, url) => {
    await shell.openExternal(String(url));
    return { ok: true, data: true };
  });
  ipcMain.handle("clipboard:write", async (_e, text) => {
    clipboard.writeText(String(text));
    return { ok: true, data: true };
  });

  /**
   * 发一条测试通知，让用户亲手确认"提醒真的能弹出来"。
   *
   * 为什么这个必须有：整套应用的价值都建立在"系统通知能到达用户"上。
   * 而未签名的应用、专注助手、系统通知设置都可能让它静默失败——
   * 如果没人验证过，用户会在某个该被提醒的日子什么都没看到，
   * 然后以为"这工具没用"。与其等那天，不如现在让他点一下看到。
   */
  ipcMain.handle("notify:test", async () => {
    const supported = Notification.isSupported();
    if (!supported) {
      return { ok: true, data: { shown: false, reason: "当前系统不支持桌面通知" } };
    }
    sendNotification({
      title: "subwatch 工作正常",
      body: "扣费前 7/3/1 天，我就会这样提醒你。看到这条说明通知没问题。",
    });
    return { ok: true, data: { shown: true } };
  });

  /** 读取 / 切换开机自启（决定"应用不在前台时还能不能提醒你"） */
  ipcMain.handle("autostart:get", async () => {
    const settings = app.getLoginItemSettings();
    return { ok: true, data: { enabled: settings.openAtLogin } };
  });
  ipcMain.handle("autostart:set", async (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ["--hidden"] });
    return { ok: true, data: { enabled: app.getLoginItemSettings().openAtLogin } };
  });

  /** 记住"用户已确认过首次引导"，不再打扰 */
  ipcMain.handle("app:getFlag", async (_e, key) => {
    return { ok: true, data: Boolean(store.getFlag(key)) };
  });
  ipcMain.handle("app:setFlag", async (_e, { key, value }) => {
    store.setFlag(key, value);
    return { ok: true, data: Boolean(value) };
  });

  ipcMain.handle("dialog:saveCsv", async (_e, csv) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: "导出订阅清单",
      defaultPath: `subwatch-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (canceled || !filePath) return { ok: true, data: false };
    fs.writeFileSync(filePath, "\uFEFF" + String(csv), "utf8"); // BOM 让 Excel 正确识别中文
    return { ok: true, data: true };
  });
}

// 单实例：第二次启动时聚焦已有窗口，而不是开第二个（否则会重复提醒）
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    log("app:ready");
    iconPath = ensureIconFile(app.getPath("userData"));
    log("icon:ready", { iconPath });
    store = new Store({ filePath: userDataFile() });
    log("store:ready", { file: userDataFile() });
    notifier = new Notifier({ store, send: sendNotification });
    api = createApi({ store, notifier });

    registerIpc();
    log("ipc:ready");
    createWindow();
    log("window:created");
    createTray();
    log("tray:created");

    // 启动检查提醒：firstRunCheck 会避免"一次导入多条订阅后被通知轰炸"
    notifier.start();
    refreshTray();
    log("notifier:started");

    // 窗口加载完成后再写报告，这样 windowCreated / 渲染层是否报错都是可信的
    mainWindow.webContents.once("did-finish-load", () => {
      log("window:loaded");
      if (SMOKE) {
        writeBootReport();
        // 留一点时间让渲染层把首屏渲染出来，再自行退出
        setTimeout(() => app.quit(), 1500);
      }
    });

    mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
      log("window:load-failed", { code, desc, url });
      writeBootReport({ ok: false, loadFailed: { code, desc, url } });
    });

    mainWindow.webContents.on("console-message", (_e, level, message) => {
      // 把渲染层 console 汇总到启动日志，便于排错
      if (level >= 2) log("renderer:console", { level, message: String(message).slice(0, 400) });
    });

    mainWindow.webContents.on("render-process-gone", (_e, details) => {
      log("renderer:gone", details);
      writeBootReport({ ok: false, renderProcessGone: details });
    });

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 全局兜底：构造期崩溃也要留下证据
  process.on("uncaughtException", (err) => {
    log("uncaught", { error: String(err && err.stack) });
    writeBootReport({ ok: false, uncaughtException: String(err && err.stack) });
    if (SMOKE) process.exit(1);
  });

  process.on("exit", (code) => log("process:exit", { code }));

  app.on("window-all-closed", () => {
    // Windows 上不退出：常驻托盘才能持续提醒
    if (process.platform !== "darwin") {
      // 保持运行
    }
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    if (notifier) notifier.stop();
  });
}
