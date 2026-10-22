/*! bridge.js 1.0.0 | hwdesk AI 直连桥 */
(function (global) {
  "use strict";

  var Bridge = { version: "1.0.0" };

  /* ---------- 直连 AI 注册表 ----------
   * 每个条目 = 一个可从工作台直达的 AI。
   * url 为空（workbuddy）时退回旧的「复制指令」流程。
   * categories：该 AI 擅长承接的 Laya 路由类别（reasoner/writer/fastsolver/coder/polisher/formatter），
   * 用于按 Laya 决策结果自动挑选直连目标。 */
  Bridge.AI = {
    doubao: {
      label: "豆包",
      url: "https://www.doubao.com/chat/",
      categories: ["reasoner", "writer", "fastsolver", "polisher"],
      desc: "综合对话 / 写作 / 快速作答"
    },
    yuanbao: {
      label: "腾讯元宝",
      url: "https://yuanbao.tencent.com/",
      categories: ["writer", "polisher", "formatter", "fastsolver"],
      desc: "写作、文档处理与润色"
    },
    deepseek: {
      label: "DeepSeek",
      url: "https://chat.deepseek.com/",
      categories: ["reasoner", "coder", "writer"],
      desc: "深度推理与代码"
    },
    kimi: {
      label: "Kimi",
      url: "https://kimi.moonshot.cn/",
      categories: ["writer", "reasoner", "formatter"],
      desc: "长文档阅读与写作"
    },
    qwen: {
      label: "通义千问",
      url: "https://www.tongyi.com/",
      categories: ["coder", "reasoner", "formatter"],
      desc: "代码 / 仿真 / 格式处理"
    },
    workbuddy: {
      label: "WorkBuddy（本地代理）",
      url: "",
      categories: ["reasoner", "writer", "fastsolver", "coder", "polisher", "formatter"],
      desc: "复制指令回本地代理执行（可代登录学在城院提交）"
    }
  };

  Bridge.ORDER = ["doubao", "yuanbao", "deepseek", "kimi", "qwen", "workbuddy"];

  /* ---------- 偏好：默认 AI + 按路由类别的指定 ---------- */
  var LS_KEY = "wb_hwdesk_bridge";
  Bridge.prefs = { defaultAi: "", byCategory: {} };

  Bridge.load = function () {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(LS_KEY) : null;
      var p = raw ? JSON.parse(raw) : null;
      if (p && typeof p === "object") {
        Bridge.prefs.defaultAi = p.defaultAi || "";
        Bridge.prefs.byCategory = p.byCategory || {};
      }
    } catch (e) { /* 损坏即回默认 */ }
    return Bridge.prefs;
  };
  Bridge.save = function () {
    try {
      if (global.localStorage) {
        global.localStorage.setItem(LS_KEY, JSON.stringify(Bridge.prefs));
      }
    } catch (e) { /* 隐私模式等，静默 */ }
  };

  Bridge.setPref = function (key, value) {
    Bridge.load();
    Bridge.prefs[key] = value;
    Bridge.save();
  };
  Bridge.setCategoryPref = function (category, aiId) {
    Bridge.load();
    if (aiId) Bridge.prefs.byCategory[category] = aiId;
    else delete Bridge.prefs.byCategory[category];
    Bridge.save();
  };
  Bridge.reset = function () {
    Bridge.prefs = { defaultAi: "", byCategory: {} };
    Bridge.save();
  };

  function known(id) { return Bridge.AI[id] ? id : ""; }

  /* ---------- 挑选直连目标 ----------
   * 优先级：类别指定 > 全局默认 > 注册表中第一个承接该类别的 AI。
   * 未设默认且类别无匹配时返回 ""（调用方弹选择器）。 */
  Bridge.pick = function (category) {
    Bridge.load();
    if (category) {
      var byCat = known(Bridge.prefs.byCategory[category]);
      if (byCat) return { ai: byCat, source: "category" };
    }
    var def = known(Bridge.prefs.defaultAi);
    if (def) return { ai: def, source: "default" };
    if (category) {
      for (var i = 0; i < Bridge.ORDER.length; i++) {
        var id = Bridge.ORDER[i];
        if (Bridge.AI[id].categories.indexOf(category) !== -1) {
          return { ai: id, source: "auto" };
        }
      }
    }
    return { ai: "", source: "none" };
  };

  /* ---------- 派发描述（DOM 无关，纯计算，便于单测） ----------
   * 返回 { ai, label, url, action }：
   *   action = "open+copy" → 复制指令并打开 url
   *          = "copy"      → 仅复制（workbuddy 旧流程） */
  Bridge.describe = function (pickResult) {
    var knownId = pickResult && Bridge.AI[pickResult.ai] ? pickResult.ai : "workbuddy";
    var ai = Bridge.AI[knownId];
    return {
      ai: knownId,
      label: ai.label,
      url: ai.url || "",
      action: ai.url ? "open+copy" : "copy"
    };
  };

  /* ---------- 提交回执文案（供页面 toast 使用） ---------- */
  Bridge.toastText = function (plan) {
    if (plan.action === "open+copy") {
      return "指令已复制并打开" + plan.label + "，在对话框 Ctrl+V 发送即可";
    }
    return "指令已复制，回 WorkBuddy 粘贴发送即可";
  };

  global.Bridge = Bridge;
})(typeof window !== "undefined" ? window : this);
