/*! cloudai.js 1.0.0 | hwdesk 云端 LLM 通道（WorkBuddy Cloud 免密钥，点开即聊） */
(function (global) {
  "use strict";

  var CloudAI = { version: "1.0.0" };

  /* publicConfig：仅含应用标识与数据面端点（无任何密钥；服务端按 Origin 严格校验，
   * 只有本应用的发布域名能调用） */
  CloudAI.config = {
    endpoint: "https://hwdesk-workbench-95242.app.workbuddy.host",
    publishableKey: "wbpk_0652K6obEFhp5et4I5yT2w_IjSxXY3b9DNEc6z4OmhsrJT9RXA0P9NC"
  };

  CloudAI.client = null;
  CloudAI.models = [];      /* 已过滤 disabled 的可用模型 */
  CloudAI.model = null;     /* 当前默认模型 */

  /* 按机覆盖层：重新发布网关后无需改源码即可切换（运维手册见 README「云端 AI 通道」）。
   * 覆盖值持久化在 localStorage[CloudAI.OVERRIDES_KEY]，JSON：{endpoint?, publishableKey?}；
   * 优先级：localStorage 覆盖 > 源码内置 config；非法值拒绝合并且不落盘 */
  CloudAI.OVERRIDES_KEY = "hwdesk.cloudai.overrides";

  /* 合并覆盖配置。opts.transient=true 只改内存不落盘（loadOverrides 回放时用）。
   * 返回 {ok:true, config} 或 {ok:false, error}；失败时不改动任何现有状态 */
  CloudAI.applyConfig = function (overrides, opts) {
    opts = opts || {};
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      return { ok: false, error: "overrides 必须是对象" };
    var next = { endpoint: CloudAI.config.endpoint, publishableKey: CloudAI.config.publishableKey };
    if (overrides.endpoint !== undefined) {
      if (typeof overrides.endpoint !== "string" || overrides.endpoint.indexOf("https://") !== 0)
        return { ok: false, error: "endpoint 必须是 https:// 开头的字符串" };
      next.endpoint = overrides.endpoint.replace(/\/+$/, "");
    }
    if (overrides.publishableKey !== undefined) {
      if (typeof overrides.publishableKey !== "string" || overrides.publishableKey.indexOf("wbpk_") !== 0)
        return { ok: false, error: "publishableKey 必须以 wbpk_ 开头" };
      next.publishableKey = overrides.publishableKey;
    }
    CloudAI.config = next;
    CloudAI.client = null; /* 下次 init() 用新配置重建 */
    if (!opts.transient) {
      try {
        global.localStorage.setItem(CloudAI.OVERRIDES_KEY, JSON.stringify({
          endpoint: next.endpoint, publishableKey: next.publishableKey
        }));
      } catch (e) { /* 环境无 localStorage 时静默跳过（仅本次会话生效） */ }
    }
    return { ok: true, config: { endpoint: next.endpoint, publishableKey: next.publishableKey } };
  };

  /* 从 localStorage 回放已保存的覆盖配置（init() 前调用）；无/坏数据返回 null */
  CloudAI.loadOverrides = function () {
    try {
      var raw = global.localStorage && global.localStorage.getItem(CloudAI.OVERRIDES_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      var r = CloudAI.applyConfig(saved, { transient: true }); /* 本来就来自持久层，不回写 */
      return r.ok ? saved : null;
    } catch (e) {
      return null;
    }
  };

  /* 网关健康检查：探测 /.cloud/llm/models，超时/网络/HTTP 三类失败都给出稳定错误码，
   * 让「发布链接已失效」在用户打字之前就能被发现（Issue #45）。
   * 返回 Promise<{ok:true, modelCount}> 或 Promise<{ok:false, code, detail?}> */
  CloudAI.healthCheck = function (timeoutMs) {
    var f = (typeof global.fetch === "function") ? global.fetch.bind(global) : null;
    if (!f || !CloudAI.config.endpoint)
      return Promise.resolve({ ok: false, code: "gateway_network_error", detail: "fetch 或 endpoint 不可用" });
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000) : null;
    return f(CloudAI.config.endpoint + "/.cloud/llm/models", {
      method: "GET",
      headers: { "Accept": "application/json", "x-wb-webapp-access-key": CloudAI.config.publishableKey },
      signal: ctrl && ctrl.signal
    }).then(function (res) {
      if (timer) clearTimeout(timer);
      if (!res.ok) return { ok: false, code: "gateway_http_" + res.status };
      return res.json().then(function (list) {
        var n = 0;
        (list || []).forEach(function (m) { if (m && m.disabled !== true) n++; });
        return { ok: true, modelCount: n };
      }).catch(function () {
        return { ok: false, code: "gateway_invalid_response" };
      });
    }).catch(function (err) {
      if (timer) clearTimeout(timer);
      if (err && err.name === "AbortError") return { ok: false, code: "gateway_timeout" };
      return { ok: false, code: "gateway_network_error", detail: err && err.message };
    });
  };

  CloudAI.ok = function () {
    return !!(global.WorkBuddyCloud && global.WorkBuddyCloud.createWorkBuddyCloud);
  };
  CloudAI.init = function () {
    if (!CloudAI.ok()) return null;
    if (!CloudAI.client) {
      CloudAI.loadOverrides(); /* 按机覆盖优先于源码内置 config（#45） */
      CloudAI.client = global.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: CloudAI.config.endpoint,
        publishableKey: CloudAI.config.publishableKey
      });
    }
    return CloudAI.client;
  };
  CloudAI.ready = function () { return !!(CloudAI.init() && CloudAI.model); };

  /* 拉模型目录：首次开聊前调用；空列表是合法结果，由调用方处理 */
  CloudAI.refreshModels = async function () {
    var c = CloudAI.init();
    if (!c) return [];
    var list = await c.llm.models.list();
    CloudAI.models = (list || []).filter(function (m) { return m.disabled !== true; });
    CloudAI.model = CloudAI.models[0] || null;
    return CloudAI.models;
  };

  /* 流式对话：opts = { messages(首条必须是 system), conversationId, onDelta, onDone, onErr }
   * 返回 abort 函数（中断当前生成） */
  CloudAI.chat = function (opts) {
    var c = CloudAI.init();
    if (!c) return null;
    var controller = new AbortController();
    (async function () {
      try {
        for await (var chunk of c.llm.chat.completions.create({
          model: CloudAI.model.id,
          messages: opts.messages,
          stream: true,
          temperature: 0.7,
          conversationId: opts.conversationId,
          signal: controller.signal
        })) {
          var d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (d && d.content) opts.onDelta(d.content);
        }
        if (opts.onDone) opts.onDone();
      } catch (err) {
        if (opts.onErr) opts.onErr(err);
      }
    })();
    return function () { controller.abort(); };
  };

  /* 错误转人话（按官方错误码前缀约定） */
  CloudAI.errText = function (err) {
    var code = (err && err.error && err.error.code) || "";
    if (code === "gateway_network_error") {
      var ep = (CloudAI.config && CloudAI.config.endpoint) || "云端发布站点";
      var cause = (err && err.message && String(err.message)) ||
                  (err && err.error && err.error.message) || "";
      return "无法连接云端网关（gateway_network_error）：本页到 " + ep +
        " 的请求没有得到任何响应。常见原因：① 本页不是从发布后的网址打开（file:// 本地打开没有云端权限）；" +
        "② 网络/代理拦截了该域名；③ 发布站点已下线（打开会提示「链接已失效」）。" +
        "请核对打开方式与网络后重试；若持续出现，说明发布链接已失效，请联系维护者重新发布，或在设置里填自己的 API Key。" +
        (cause ? "〔底层错误：" + cause.slice(0, 140) + "〕" : "");
    }
    if (code.indexOf("auth_") === 0) return "云端通道鉴权失败（" + code + "）：请从发布后的网址打开本页使用；本地 file:// 打开没有云端权限。也可以在设置里填自己的 API Key。";
    if (code.indexOf("quota_") === 0) return "云端通道额度受限（" + code + "），稍后再试，或在设置里填自己的 API Key。";
    if (code.indexOf("gateway_") === 0 || code.indexOf("model_") === 0) return "模型服务暂时不可用（" + code + "），请重试一次。";
    if (code.indexOf("request_") === 0) return "请求参数问题（" + code + "），请联系维护者检查版本。";
    return "云端通道请求失败：" + (err && err.message ? String(err.message).slice(0, 120) : JSON.stringify(err).slice(0, 120));
  };

  global.CloudAI = CloudAI;
})(typeof window !== "undefined" ? window : this);
