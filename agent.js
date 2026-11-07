/*! agent.js 2.2.0 | hwdesk 作业内嵌 Agent 对话（唯一 Agent：本机 Qoder CLI）
 * 2.2.0：档位对齐 agent.config.json（RoleWeave 语义）——getModel/setModel 持久化
 * 选择（默认 provider-default＝跟随账号默认），modelOptions(status) 按桥的账号目录
 * 标注可选档位，目录里没有的档位由桥拒绝下传；问答/流式都带 model 字段并回读 CLI
 * 真实生效的 model 与 modelNote。
 * 2.1.0：askQoderStream 流式问答（NDJSON thinking/answer/done 事件实时进对话框，
 * 旧桥 404 自动降级一轮一出）。
 * 2.0.0：工作台 AI 全部收敛为 Qoder CLI —— 删除 API 预设 / 分层降级 / 云端
 * 免密钥通道 / 本机凭据发现采用；对话改为本机桥 /agent/qoder（syncserver
 * 调 Qoder CLI -p，提示词走 stdin，不出本机）。零配置：无 Key、无 baseUrl。 */
(function (global) {
  "use strict";

  var Agent = { version: "2.2.0" };  /* 2.2.0: 档位（跟随账号默认 + tier）与生效模型回读；2.1.0: askQoderStream 流式（思考过程实时进对话框，旧桥降级）；2.0.0: 收敛为唯一 Agent Qoder CLI（删预设/分层/发现采用），移植 1.3.2 的 buildMessages 请求体预算裁剪 */

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

  /* ---------- 档位选择（agent.config.json 的 model.tiers） ----------
   * 默认 provider-default＝跟随账号默认。桥会用 --list-models 的账号目录校验档位，
   * 目录里没有的档位不下传（实测硬塞会被 CLI 静默降级，页面显示的模型就成了假的）。 */
  var LS_MODEL = "hwdesk.agentModel";
  Agent.getModel = function () {
    var g = typeof global !== "undefined" ? global : globalThis;
    try { return (g.localStorage.getItem(LS_MODEL) || "provider-default") || "provider-default"; }
    catch (e) { return "provider-default"; }
  };
  Agent.setModel = function (id) {
    var g = typeof global !== "undefined" ? global : globalThis;
    try { g.localStorage.setItem(LS_MODEL, String(id || "provider-default")); } catch (e) { /* noop */ }
    return Agent.getModel();
  };
  /* status → 可选项：档位 + 账号目录里额外列出的模型（bridge 已标好 available） */
  Agent.modelOptions = function (status) {
    var tiers = (status && status.tiers) || [];
    var out = [], seen = {};
    tiers.forEach(function (t) {
      if (!t || !t.id || seen[t.id]) return;
      seen[t.id] = 1;
      out.push({ id: t.id, name: t.name || t.id, available: t.available !== false,
                 note: t.note || "", group: t.group || "tiers" });
    });
    ((status && status.catalog) || []).forEach(function (m) {
      if (seen[m]) return;
      seen[m] = 1;
      out.push({ id: m, name: m + "（账号目录）", available: true, note: "", group: "catalog" });
    });
    if (!out.length) out.push({ id: "provider-default", name: "跟随账号默认", available: true,
                                note: "", group: "default" });
    return out;
  };

  /* ---------- 问答（POST /agent/qoder）----------
   * messages = Agent.buildMessages 的产物；CLI 一轮一出（无流式），耗时
   * 数十秒属正常。opts.model 为档位 id（默认跟随账号默认）。成功 resolve
   * {output, model, modelNote}，失败 reject {code, message}。 */
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
        body: JSON.stringify({ messages: messages || [], model: opts.model || Agent.getModel() }),
        signal: ctl ? ctl.signal : undefined
      });
      var j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (res.ok && j && j.ok) {
        return { output: j.output || "", model: j.model || "", modelNote: j.modelNote || "",
                 tools: j.tools || null };
      }
      var msg = (j && (j.error || j.message)) || ("HTTP " + res.status);
      throw { code: res.status === 403 ? "forbidden" : "qoder_error", message: String(msg) };
    } catch (e) {
      if (e && e.code) throw e;                       /* 已是结构化错误 */
      throw { code: "network", message: "本机桥连不上（127.0.0.1:8765）——请先运行 python syncserver.py" };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /* ---------- 流式问答（POST /agent/qoder/stream）----------
   * NDJSON 逐行事件：{type:"thinking"|"answer",text} 过程实时回调 onEvent，
   * {type:"done",text} 收尾 resolve {output}，{type:"error",message} reject。
   * 旧桥（<3.1.0）无此端点回 404 → 自动降级走一轮一出的 /agent/qoder。 */
  Agent.askQoderStream = async function (messages, onEvent, opts) {
    opts = opts || {};
    var g = typeof global !== "undefined" ? global : globalThis;
    if (typeof g.fetch !== "function" || !g.ReadableStream) {
      var r = await Agent.askQoder(messages, opts);   /* 环境不支持流 → 旧通道 */
      if (onEvent) onEvent({ type: "answer", text: r.output });
      return r;
    }
    var ctl = g.AbortController ? new g.AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, opts.timeoutMs || 330000) : null;
    if (ctl && opts.signal && opts.signal.addEventListener) {
      opts.signal.addEventListener("abort", function () { try { ctl.abort(); } catch (e) { /* noop */ } });
    }
    try {
      var res = await g.fetch(Agent.bridgeRoot() + "/agent/qoder/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages || [], model: opts.model || Agent.getModel() }),
        signal: ctl ? ctl.signal : undefined
      });
      if (res.status === 404) {                       /* 旧桥：降级一轮一出 */
        var legacy = await Agent.askQoder(messages, opts);
        if (onEvent) onEvent({ type: "answer", text: legacy.output });
        return legacy;
      }
      if (!res.ok) {
        var j = null;
        try { j = await res.json(); } catch (e) { j = null; }
        var msg = (j && (j.error || j.message)) || ("HTTP " + res.status);
        throw { code: res.status === 403 ? "forbidden" : "qoder_error", message: String(msg) };
      }
      var reader = res.body.getReader(), decoder = new TextDecoder("utf-8");
      var buf = "", done = null, errMsg = null;
      function consume(line){
        if (!line || line.charAt(0) !== "{") return;
        var ev;
        try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.type === "thinking" || ev.type === "answer") { if (onEvent) onEvent(ev); }
        else if (ev.type === "done") done = ev;
        else if (ev.type === "error") errMsg = ev.message || "Qoder CLI 出错";
      }
      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        var nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          consume(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      consume(buf);
      if (done && !done.is_error) {
        return { output: done.text || "", model: done.model || "",
                 modelNote: done.modelNote || "", tools: done.tools || null };
      }
      if (done) throw { code: "qoder_error", message: done.text || "Qoder CLI 返回了错误" };
      throw { code: "qoder_error", message: errMsg || "本机桥流式响应异常中断，请重试" };
    } catch (e) {
      if (e && e.code) throw e;
      if (e && (e.name === "AbortError" || e.code === 20)) {
        if (opts.signal && opts.signal.aborted) throw { code: "aborted", message: "已中断" };
        throw { code: "timeout", message: "Qoder 响应超时，请重试或精简任务" };
      }
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
  Agent.BODY_BUDGET = 140000;  /* 与桥侧 QODER_MAX_PROMPT=150000 同步放大：课件上下文 + 长对话不再被裁 */
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
