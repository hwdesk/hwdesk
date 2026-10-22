/*! agent.js 1.0.0 | hwdesk 作业内嵌 Agent 对话（OpenAI 兼容 API 直连） */
(function (global) {
  "use strict";

  var Agent = { version: "1.0.0" };

  /* ---------- API 预设（OpenAI 兼容 chat/completions） ----------
   * key 只存本机 localStorage，不进仓库、不进页面源码（与仓库隐私原则一致）。
   * 豆包走火山方舟兼容模式，model 需填自己的推理接入点或模型 ID。 */
  Agent.PRESETS = {
    deepseek: {
      label: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      keyUrl: "https://platform.deepseek.com/api_keys",
      hint: "性价比高，推理 / 写作均衡",
      cors: "ok"
    },
    kimi: {
      label: "Kimi（月之暗面）",
      baseUrl: "https://api.moonshot.cn/v1",
      model: "moonshot-v1-8k",
      keyUrl: "https://platform.moonshot.cn/console/api-keys",
      hint: "长上下文，适合带课件摘要的任务",
      cors: "ok"
    },
    qwen: {
      label: "通义千问",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
      hint: "代码 / 仿真类任务表现好",
      cors: "ok"
    },
    doubao: {
      label: "豆包（火山方舟）",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      model: "",
      keyUrl: "https://console.volcengine.com/ark",
      hint: "model 需填你在方舟创建的推理接入点 ID；方舟一般不允许浏览器直连，建议走本地代理",
      cors: "proxy"
    },
    custom: {
      label: "自定义（OpenAI 兼容）",
      baseUrl: "",
      model: "",
      keyUrl: "",
      hint: "任何兼容 /chat/completions 的服务（含本地网关）",
      cors: "custom"
    }
  };
  Agent.PRESET_ORDER = ["deepseek", "kimi", "qwen", "doubao", "custom"];

  /* ---------- 浏览器直连（CORS）标注 ----------
   * ok     = 该服务放行了跨域请求，浏览器可直连
   * proxy  = 官方未放行跨域，建议填本地代理地址（如 http://127.0.0.1:8787/v1）
   * custom = 取决于自建网关，由使用者自行判断 */
  Agent.CORS_LABEL = {
    ok: "可浏览器直连",
    proxy: "建议本地代理",
    custom: "取决于网关"
  };
  Agent.corsLabel = function (presetId) {
    var p = Agent.PRESETS[presetId];
    return Agent.CORS_LABEL[(p && p.cors) || "custom"] || Agent.CORS_LABEL.custom;
  };

  /* ---------- 配置存取 ---------- */
  var LS_CFG = "wb_hwdesk_agent";
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7 };

  Agent.load = function () {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(LS_CFG) : null;
      var c = raw ? JSON.parse(raw) : null;
      if (c && typeof c === "object") {
        for (var k in Agent.config) if (k in c) Agent.config[k] = c[k];
      }
    } catch (e) { /* 损坏即回默认 */ }
    return Agent.config;
  };
  Agent.save = function () {
    try {
      if (global.localStorage) global.localStorage.setItem(LS_CFG, JSON.stringify(Agent.config));
    } catch (e) { /* 隐私模式等，静默 */ }
  };
  Agent.applyPreset = function (presetId) {
    var p = Agent.PRESETS[presetId];
    if (!p) return;
    Agent.load();
    Agent.config.preset = presetId;
    Agent.config.baseUrl = p.baseUrl;
    Agent.config.model = p.model;
    Agent.save();
  };
  Agent.ready = function () {
    Agent.load();
    return !!(Agent.config.baseUrl && Agent.config.model && Agent.config.apiKey);
  };

  /* ---------- 聊天历史（按作业 ID 分库，独立 LS 键） ---------- */
  var LS_CHAT = "wb_hwdesk_chats";
  Agent.loadChat = function (itemId) {
    var all = {};
    try { all = JSON.parse(global.localStorage.getItem(LS_CHAT) || "{}") || {}; } catch (e) { all = {}; }
    return all[itemId] || { system: "", messages: [] };   // messages: [{role, content}]
  };
  Agent.saveChat = function (itemId, chat) {
    var all = {};
    try { all = JSON.parse(global.localStorage.getItem(LS_CHAT) || "{}") || {}; } catch (e) { all = {}; }
    all[itemId] = chat;
    try { global.localStorage.setItem(LS_CHAT, JSON.stringify(all)); } catch (e) { /* 超限时静默 */ }
    return chat;
  };
  Agent.clearChat = function (itemId) {
    Agent.saveChat(itemId, { system: "", messages: [] });
  };

  /* ---------- 系统提示词：任务 + Laya 决策 + 上下文 + 去AI化 ----------
   * ctx = { contextBrief, humanizeChecklist, decision }（页面组装，允许缺省） */
  Agent.buildSystemPrompt = function (item, ctx) {
    ctx = ctx || {};
    var lines = [];
    lines.push("你是学生的作业执行 Agent，与学生一起把这项作业完成到可交付状态。");
    lines.push("作业：" + (item.name || "-") + "｜课程：" + (item.course || "-")
      + "｜截止：" + (item.due || "-") + "｜提交形式：" + (item.format || "文字"));
    if (item.note) lines.push("作业要求 / 备注：" + item.note);
    if (ctx.decision && ctx.decision.route) {
      lines.push("路由建议：以「" + ctx.decision.route.label + "」的方式完成（置信度 "
        + Math.round(ctx.decision.route.confidence * 100) + "%）");
      lines.push(ctx.decision.review.needed
        ? "该任务学生要求先自查：先给出完整草稿，等学生确认后再定稿。"
        : "该任务可直接产出可交付的最终答案。");
    }
    if (ctx.contextBrief) lines.push("\n【课程上下文（优先依据，不凭通用知识自由发挥）】\n" + ctx.contextBrief);
    if (ctx.humanizeChecklist) lines.push("\n【交付要求】\n" + ctx.humanizeChecklist);
    lines.push("\n【对话规则】");
    lines.push("1. 学生会给你补充资料或修改意见，逐条吸收；");
    lines.push("2. 每轮回复保持简洁：先给结果，必要时附 2-3 条说明；");
    lines.push("3. 当学生认可后（或首轮即可交付的简单任务），输出最终交付版本，格式：");
    lines.push("   【最终交付】\n   （可直接提交的完整成稿，不要附加解释）");
    lines.push("4. 【最终交付】之后的内容视为定稿，学生将原样提交。");
    return lines.join("\n");
  };

  /* ---------- 消息组装 ---------- */
  Agent.buildMessages = function (system, messages) {
    var out = [{ role: "system", content: system }];
    (messages || []).forEach(function (m) {
      if (m && (m.role === "user" || m.role === "assistant") && m.content) {
        out.push({ role: m.role, content: m.content });
      }
    });
    return out;
  };

  /* ---------- 结果提取 ----------
   * extractDeliverableInfo 额外返回 confirmed：
   *   true  = 助手确实输出了【最终交付】定稿块，可放心提交
   *   false = 只是 fallback 到最后一条回复（可能是「好的已修改」这类短句），
   *           页面必须二次确认，不能当成定稿直接交付 */
  Agent.extractDeliverableInfo = function (messages) {
    var last = null;
    for (var i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === "assistant") { last = messages[i].content || ""; break; }
    }
    if (!last) return { text: "", confirmed: false };
    var idx = last.indexOf("【最终交付】");
    if (idx !== -1) {
      var out = last.slice(idx + "【最终交付】".length);
      return { text: out.replace(/^\s*[:：]?\s*/, "").trim(), confirmed: true };
    }
    return { text: last.trim(), confirmed: false };
  };

  /* 取【最终交付】之后的内容，缺省取最后一条助手消息（保留旧签名，页面侧请用 Info 版拿 confirmed） */
  Agent.extractDeliverable = function (messages) {
    return Agent.extractDeliverableInfo(messages).text;
  };

  global.Agent = Agent;
})(typeof window !== "undefined" ? window : this);
