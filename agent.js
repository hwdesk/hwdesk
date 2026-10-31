/*! agent.js 1.1.0 | hwdesk 作业内嵌 Agent 对话（OpenAI 兼容 API 直连） */
(function (global) {
  "use strict";

  var Agent = { version: "1.2.0" };  /* 1.2.0: cloud-proxy 预设 + 分层自动降级（issue #56） */

  /* ---------- API 预设（OpenAI 兼容 chat/completions） ----------
   * key 只存本机 localStorage，不进仓库、不进页面源码（与仓库隐私原则一致）。
   * 豆包走火山方舟兼容模式，model 需填自己的推理接入点或模型 ID。 */
  Agent.PRESETS = {
    cloudproxy: {
      label: "云端代理（免配置）",
      baseUrl: "http://127.0.0.1:8765/v1",
      model: "deepseek-chat",
      keyUrl: "",
      hint: "维护者本机 syncserver.py /v1 代理网关：厂商 key 全在服务端环境变量，本机零配置即可用；令牌可选",
      cors: "ok",
      builtin: true
    },
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
    hunyuan: {
      label: "腾讯混元",
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      model: "hunyuan-turbos-latest",
      keyUrl: "https://console.cloud.tencent.com/hunyuan/api-key",
      hint: "腾讯混元（OpenAI 兼容端点）；浏览器直连一般被拦，建议走本机代理",
      cors: "proxy"
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
  Agent.PRESET_ORDER = ["cloudproxy", "deepseek", "kimi", "qwen", "hunyuan", "doubao", "custom"];

  /* ---------- 配置存取 ----------
   * keys = 按预设分存的 API Key（换 Agent 不丢 Key）；兼容旧的单 apiKey 字段。 */
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
  Agent.config = { preset: "cloudproxy", baseUrl: Agent.PRESETS.cloudproxy.baseUrl, apiKey: "", model: Agent.PRESETS.cloudproxy.model, temperature: 0.7, keys: {}, manualLock: false };

  Agent.load = function () {
    try {
      var raw = global.localStorage ? global.localStorage.getItem(LS_CFG) : null;
      var c = raw ? JSON.parse(raw) : null;
      if (c && typeof c === "object") {
        for (var k in Agent.config) if (k in c) Agent.config[k] = c[k];
      }
    } catch (e) { /* 损坏即回默认 */ }
    if (!Agent.config.keys || typeof Agent.config.keys !== "object") Agent.config.keys = {};
    /* 迁移：旧版只存单 apiKey → 归入当前预设名下 */
    if (Agent.config.apiKey && !Agent.config.keys[Agent.config.preset]) {
      Agent.config.keys[Agent.config.preset] = Agent.config.apiKey;
    }
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
    Agent.config.apiKey = Agent.config.keys[presetId] || "";
    Agent.save();
  };
  /* 一键切换到某个 Agent（含 Key 同步）；页面「选择 Agent」后调用 */
  Agent.use = function (presetId) {
    if (!Agent.PRESETS[presetId]) return false;
    Agent.applyPreset(presetId);
    return true;
  };
  Agent.setKey = function (presetId, key) {
    Agent.load();
    Agent.config.keys[presetId] = key;
    if (presetId === Agent.config.preset) Agent.config.apiKey = key;
    Agent.save();
  };
  /* 已配好 Key 的预设（「选择 Agent」列表只把这些标为可用） */
  Agent.usablePresets = function () {
    Agent.load();
    return Agent.PRESET_ORDER.filter(function (id) { return !!Agent.config.keys[id]; });
  };
  /* ---------- 分层自动降级（issue #56） ----------
   * 第 1 层 cloudproxy（本机 syncserver /v1，key 在服务端）
   * 第 2 层 CloudAI（发布站点免密钥通道）
   * 第 3 层 本机已存 key 的手动预设
   * 全灭 → { layer: 0 }，维持现状提示配 Key。 */
  Agent.currentProxyBase = function () {
    if (Agent.config.preset === "cloudproxy" && Agent.config.baseUrl) {
      return String(Agent.config.baseUrl).replace(/\/+$/, "");
    }
    return Agent.PRESETS.cloudproxy.baseUrl;
  };

  Agent.probeLayers = async function (timeoutMs) {
    var ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 4000;
    var g = typeof global !== "undefined" ? global : globalThis;
    /* 第 1 层：本机代理网关 */
    if (typeof g.fetch === "function") {
      try {
        var ctl = new g.AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, ms);
        var headers = {};
        var tok = Agent.config.keys && Agent.config.keys.cloudproxy;
        if (tok) headers["Authorization"] = "Bearer " + tok;
        var res = await g.fetch(Agent.currentProxyBase() + "/models", { signal: ctl.signal, headers: headers });
        clearTimeout(timer);
        var models = null;
        if (res.ok) { try { models = await res.json(); } catch (e) { models = null; } }
        /* 代理可达但一台 key 都没配（models 目录为空）→ 有库无药，继续向下层降级（issue #70） */
        var hasModels = !!(models && models.data && models.data.length);
        if (res.ok && hasModels) return { layer: 1, presetId: "cloudproxy", models: models, detail: "cloud-proxy reachable" };
      } catch (e) { /* 代理未开，落到下一层 */ }
    }
    /* 第 2 层：发布站点免密钥通道 */
    if (g.CloudAI && typeof g.CloudAI.healthCheck === "function") {
      try {
        var hc = await g.CloudAI.healthCheck(ms);
        if (hc && hc.ok) return { layer: 2, presetId: null, models: hc.models, detail: "cloudai" };
      } catch (e) { /* 网关不可达 */ }
    }
    /* 第 3 层：本机已配 key 的手动预设（不含 cloudproxy / custom 空壳） */
    var usable = Agent.usablePresets().filter(function (id) { return id !== "cloudproxy"; });
    if (usable.length) return { layer: 3, presetId: usable[0], detail: usable.join(",") };
    return { layer: 0, presetId: null, detail: "none" };
  };

  /* 按探测结果自动切换；用户显式选过（manualLock）则不抢 */
  Agent.autoSelect = function (result) {
    if (!result || !result.presetId || !Agent.PRESETS[result.presetId]) return null;
    if (Agent.config.manualLock) return null;
    Agent.applyPreset(result.presetId);
    return Agent.config.preset;
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
