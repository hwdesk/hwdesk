/*! bridge.js 1.1.0 | hwdesk AI 直连桥（唯一 Agent：Qoder CLI）
 * 1.1.0：注册表收敛 —— 外部 AI 网页（豆包/元宝/DeepSeek/Kimi/通义/WorkBuddy）
 * 全部下线，只剩本机 Qoder CLI 一个条目（url 为空 → 复制指令兜底流程）。 */
(function (global) {
  "use strict";

  var Bridge = { version: "1.1.0" };

  /* ---------- 直连 AI 注册表 ----------
   * 每个条目 = 一个可从工作台直达的 AI。
   * url 为空（qoder）时退回旧的「复制指令」流程；
   * 带任务上下文的派发一律走工作台内嵌对话（agent.js /agent/qoder 通道）。
   * categories：承接 laya.js 全部路由类别（reasoner/writer/fastsolver/coder/polisher/formatter）。 */
  Bridge.AI = {
    qoder: {
      label: "Qoder CLI（本机）",
      url: "",
      categories: ["reasoner", "writer", "fastsolver", "coder", "polisher", "formatter"],
      desc: "本机唯一执行 Agent：工作台内嵌对话，自动开工"
    }
  };

  Bridge.ORDER = ["qoder"];

  /* ---------- 偏好：默认 AI + 按路由类别的指定 ---------- */
  var LS_KEY = "wb_hwdesk_bridge";
  Bridge.prefs = { defaultAi: "", byCategory: {} };

  Bridge.load = function () {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(LS_KEY) : null;
      var p = raw ? JSON.parse(raw) : null;
      if (p && typeof p === "object") {
        /* 只接受注册表里真实存在的 id：旧数据指向已下线的 AI 时直接丢弃，
         * 避免 localStorage 残留悄悄劫持派发目标 */
        Bridge.prefs.defaultAi = known(p.defaultAi || "");
        var byCat = {};
        var stale = p.byCategory || {};
        for (var k in stale) {
          if (known(stale[k])) byCat[k] = stale[k];
        }
        Bridge.prefs.byCategory = byCat;
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
   * 优先级：全局默认 > 类别指定 > 注册表中第一个承接该类别的 AI。
   * （默认优先修复：旧版本写进 localStorage 的 byCategory 残留会永久压住
   *   用户后来设置的默认 AI —— 表现为“无论默认选谁，打开都是豆包”。
   *   现在没有按类别指定的 UI，默认 AI 必须最优先，残留不许劫持。）
   * 未设默认且类别无匹配时返回 ""（调用方弹选择器）。 */
  Bridge.pick = function (category) {
    Bridge.load();
    var def = known(Bridge.prefs.defaultAi);
    if (def) return { ai: def, source: "default" };
    if (category) {
      var byCat = known(Bridge.prefs.byCategory[category]);
      if (byCat) return { ai: byCat, source: "category" };
    }
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
   *          = "copy"      → 仅复制（qoder 本机流程） */
  Bridge.describe = function (pickResult) {
    var knownId = pickResult && Bridge.AI[pickResult.ai] ? pickResult.ai : "qoder";
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
    return "指令已复制，粘到「AI 对话」发送即可";
  };

  global.Bridge = Bridge;
})(typeof window !== "undefined" ? window : this);
