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

  CloudAI.ok = function () {
    return !!(global.WorkBuddyCloud && global.WorkBuddyCloud.createWorkBuddyCloud);
  };
  CloudAI.init = function () {
    if (!CloudAI.ok()) return null;
    if (!CloudAI.client) {
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
      return "无法连接云端网关（gateway_network_error）：本页到 " + ep +
        " 的请求没有得到任何响应。常见原因：① 本页不是从发布后的网址打开（file:// 本地打开没有云端权限）；" +
        "② 网络/代理拦截了该域名；③ 发布站点已下线（打开会提示「链接已失效」）。" +
        "请核对打开方式与网络后重试；若持续出现，说明发布链接已失效，请联系维护者重新发布，或在设置里填自己的 API Key。";
    }
    if (code.indexOf("auth_") === 0) return "云端通道鉴权失败（" + code + "）：请从发布后的网址打开本页使用；本地 file:// 打开没有云端权限。也可以在设置里填自己的 API Key。";
    if (code.indexOf("quota_") === 0) return "云端通道额度受限（" + code + "），稍后再试，或在设置里填自己的 API Key。";
    if (code.indexOf("gateway_") === 0 || code.indexOf("model_") === 0) return "模型服务暂时不可用（" + code + "），请重试一次。";
    if (code.indexOf("request_") === 0) return "请求参数问题（" + code + "），请联系维护者检查版本。";
    return "云端通道请求失败：" + (err && err.message ? String(err.message).slice(0, 120) : JSON.stringify(err).slice(0, 120));
  };

  global.CloudAI = CloudAI;
})(typeof window !== "undefined" ? window : this);
