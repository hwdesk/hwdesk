/*! agent.js 2.0.0 | hwdesk 作业内嵌 Agent 对话（唯一 Agent：本机 Qoder CLI）
 * 2.0.0：工作台 AI 全部收敛为 Qoder CLI —— 删除 API 预设 / 分层降级 / 云端
 * 免密钥通道 / 本机凭据发现采用；对话改为本机桥 /agent/qoder（syncserver
 * 调 Qoder CLI -p，提示词走 stdin，不出本机）。零配置：无 Key、无 baseUrl、
 * 无模型选择。 */
(function (global) {
  "use strict";

  var Agent = { version: "2.0.0" };  /* 2.0.0: 收敛为唯一 Agent Qoder CLI（删预设/分层/发现采用），移植 1.3.2 的 buildMessages 请求体预算裁剪 */

  /* ---------- 本机桥定位 ----------
   * 页面被本机桥同源托管（syncserver GET /，见 PR #91）时直接用同源；
   * file:// 或其他来源回退 http://127.0.0.1:8765。 */
  Agent.bridgeRoot = function () {
    try {
      if (global.location && global.location.origin
          && /^https?:\/\/(127\.0\.0\.1|localhost):8765$/.test(global.location.origin)) {
        return global.location.origin;
      }
    } catch (e) { /* file:// 下 origin 可能抛错，走默认 */ }
    return "http://127.0.0.1:8765";
  };

  /* ---------- 就绪语义 ----------
   * Qoder 通道零配置：配置层面永远就绪；真实可用性在发送/检测时确认
   * （桥没开 / CLI 没装会在发送时报人话错误，不把用户赶去填 Key）。 */
  Agent.ready = function () { return true; };

  /* ---------- Qoder CLI 状态检测（GET /agent/qoder/status） ---------- */
  Agent.qoderStatus = async function (timeoutMs) {
    var ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 6000;
    var g = typeof global !== "undefined" ? global : globalThis;
    if (typeof g.fetch !== "function") return { ok: false, error: "环境无 fetch" };
    try {
      var ctl = g.AbortController ? new g.AbortController() : null;
      var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;
      var res = await g.fetch(Agent.bridgeRoot() + "/agent/qoder/status", ctl ? { signal: ctl.signal } : undefined);
      if (timer) clearTimeout(timer);
      var j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (res.status === 403) return { ok: false, error: "本机 Agent 只对本机页面开放（当前页面来源不被信任）" };
      if (j && typeof j === "object") return j;
      return { ok: false, error: "本机桥响应异常（HTTP " + res.status + "）" };
    } catch (e) {
      return { ok: false, error: "本机桥连不上（127.0.0.1:8765）——请先运行 python syncserver.py" };
    }
  };

  /* ---------- 问答（POST /agent/qoder）----------
   * messages = Agent.buildMessages 的产物；CLI 一轮一出（无流式），耗时
   * 数十秒属正常。成功 resolve {output, model}，失败 reject {code, message}。 */
  Agent.askQoder = async function (messages, opts) {
    opts = opts || {};
    var g = typeof global !== "undefined" ? global : globalThis;
    if (typeof g.fetch !== "function") {
      throw { code: "no_fetch", message: "当前环境不支持 fetch" };
    }
    var ctl = g.AbortController ? new g.AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, opts.timeoutMs || 330000) : null;
    try {
      var res = await g.fetch(Agent.bridgeRoot() + "/agent/qoder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages || [] }),
        signal: ctl ? ctl.signal : undefined
      });
      var j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (res.ok && j && j.ok) return { output: j.output || "", model: j.model || "" };
      var msg = (j && (j.error || j.message)) || ("HTTP " + res.status);
      throw { code: res.status === 403 ? "forbidden" : "qoder_error", message: String(msg) };
    } catch (e) {
      if (e && e.code) throw e;                       /* 已是结构化错误 */
      throw { code: "network", message: "本机桥连不上（127.0.0.1:8765）——请先运行 python syncserver.py" };
    } finally {
      if (timer) clearTimeout(timer);
    }
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

  /* ---------- 消息组装 ----------
   * 消息体整体作为 /agent/qoder 的 JSON body 发出，桥侧再拼成 CLI 提示词。
   * 请求体预算裁剪（自 1.3.2 移植）：课程材料上下文 + 长对话历史越滚越大，
   * 会超出 CLI/桥的处理预算 —— 先丢最旧的对话历史，还超限再截断 system 里
   * 的巨型材料。 */
  Agent.BODY_BUDGET = 80000;   /* JSON 字符数预算；中文 UTF-8 最坏 ≈240KB，留足安全余量 */
  Agent.buildMessages = function (system, messages) {
    var out = [{ role: "system", content: String(system || "") }];
    (messages || []).forEach(function (m) {
      if (m && (m.role === "user" || m.role === "assistant") && m.content) {
        out.push({ role: m.role, content: String(m.content) });
      }
    });
    var jsonLen = function (arr) { return JSON.stringify(arr).length; };
    if (jsonLen(out) <= Agent.BODY_BUDGET) return out;
    /* 1) 从最旧的对话消息丢起，至少保留最近两轮 */
    while (out.length > 3 && jsonLen(out) > Agent.BODY_BUDGET) {
      out.splice(1, 1);
    }
    /* 2) 还超限 → system 里多半是巨型课程材料：截断并说明 */
    if (jsonLen(out) > Agent.BODY_BUDGET) {
      var rest = Agent.BODY_BUDGET - jsonLen(out.slice(1)) - 80;
      if (rest < 1000) rest = 1000;
      out[0].content = out[0].content.slice(0, rest)
        + "\n\n〔系统提示：课程材料过长，已按请求体上限截断；缺失部分请让学生粘贴原文或补充材料。〕";
    }
    /* 3) 兜底：单条消息本身就是巨物（如粘贴整篇文档）→ 压到 8000 字符 */
    if (jsonLen(out) > Agent.BODY_BUDGET) {
      out.slice(1).forEach(function (m) {
        if (m.content.length > 8000) m.content = m.content.slice(0, 8000) + "…〔已截断〕";
      });
    }
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
