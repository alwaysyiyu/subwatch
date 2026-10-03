"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/**
 * 安全桥：渲染层拿不到 node，只能用这里白名单出来的方法。
 *
 * 设计：统一返回 Promise，失败时 reject 一个带 message 的 Error，
 * 让界面层的错误处理保持简单（try/catch 一处搞定）。
 */

async function invoke(channel, payload) {
  const res = await ipcRenderer.invoke(channel, payload);
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || `调用失败：${channel}`);
  }
  return res.data;
}

const API_CHANNELS = [
  "app:meta",
  "subs:list",
  "subs:presets",
  "subs:addFromPreset",
  "subs:add",
  "subs:update",
  "subs:remove",
  "subs:summary",
  "subs:shareCard",
  "subs:exportCsv",
  "subs:previewReminders",
  "subs:checkNow",
];

const bridge = {
  platform: "electron",
  invoke,
};

// 按通道生成具名方法，界面用起来比 invoke("xxx") 清楚
for (const channel of API_CHANNELS) {
  const name = channel.replace(/^[a-z]+:/, "").replace(/:([a-z])/g, (_m, c) => c.toUpperCase());
  bridge[name] = (payload) => invoke(channel, payload);
}

bridge.openExternal = (url) => invoke("shell:openExternal", url);
bridge.copyText = (text) => invoke("clipboard:write", text);
bridge.saveCsv = (csv) => invoke("dialog:saveCsv", csv);

// 需要 Electron 能力、不进 app-api 的几个
bridge.testNotify = () => invoke("notify:test");
bridge.getAutostart = () => invoke("autostart:get");
bridge.setAutostart = (enabled) => invoke("autostart:set", enabled);
bridge.getFlag = (key) => invoke("app:getFlag", key);
bridge.setFlag = (key, value) => invoke("app:setFlag", { key, value });

contextBridge.exposeInMainWorld("subwatch", bridge);
