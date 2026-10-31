/*! verifynet.js 1.0.0 | hwdesk 账号验证通道选择（纯计算，DOM 无关）
 *
 * 登录门禁的验证走「分层端点」：本机桥（syncserver.py 127.0.0.1:8765，凭据不出本机）
 * 优先；本机桥没启动时降级到云端验证服务（verifyserver.py 部署实例，凭据仅随本次
 * 请求验证后即弃）。任何一台用户电脑开箱即能登录，无需先装 Python / 起本机服务。
 */
(function (global) {
  "use strict";

  var VerifyNet = { version: "1.0.0" };

  /* 默认端点表。云端地址可用 #45 的机覆盖模式随时顶上（发布域名变更时不必发新版）。
   * 云端端点带 sharecode（公开值）：WorkBuddy 发布站点的网关要求完整分享参数，
   * 缺了会回「链接不完整」页（与 cloudai.js 同机制）。 */
  VerifyNet.OVERRIDES_KEY = "hwdesk.verify.overrides";
  VerifyNet.LOCAL_URL = "http://127.0.0.1:8765";
  VerifyNet.CLOUD_URLS = [
    { url: "https://hwdesk-verify.app.workbuddy.host", sharecode: "FAAT2EERTI" }
  ];

  function validHttpUrl(v) {
    if (typeof v !== "string") return false;
    try {
      var u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch (e) { return false; }
  }
  function validSharecode(v) {
    return typeof v === "string" && /^[A-Za-z0-9]{4,64}$/.test(v);
  }
  function trimSlash(v) { return String(v).replace(/\/+$/, ""); }

  /* 云端条目归一：接受 "https://…" 或 { url, sharecode }，统一成 {url, sharecode:""}
   * （sharecode 允许为空 = 网关不要求分享参数的部署；非空时必须是合法格式） */
  function normCloudEntry(e) {
    if (typeof e === "string" && validHttpUrl(e)) return { url: trimSlash(e), sharecode: "" };
    if (e && typeof e === "object" && validHttpUrl(e.url)) {
      var sc = e.sharecode === undefined ? "" : e.sharecode;
      if (sc !== "" && !validSharecode(sc)) return null;
      return { url: trimSlash(e.url), sharecode: sc };
    }
    return null;
  }

  /* —— 覆盖（#45 同款）：{ localUrl, cloudUrls: [...] }，非法字段整条拒绝 —— */
  VerifyNet.normalizeOverrides = function (raw) {
    if (!raw || typeof raw !== "object") return { ok: false, code: "invalid_input" };
    var out = {};
    if (raw.localUrl !== undefined) {
      if (!validHttpUrl(raw.localUrl)) return { ok: false, code: "invalid_local_url" };
      out.localUrl = trimSlash(raw.localUrl);
    }
    if (raw.cloudUrls !== undefined) {
      if (!Array.isArray(raw.cloudUrls) || raw.cloudUrls.length === 0) {
        return { ok: false, code: "invalid_cloud_urls" };
      }
      var norm = [];
      for (var i = 0; i < raw.cloudUrls.length; i++) {
        var e = normCloudEntry(raw.cloudUrls[i]);
        if (!e) return { ok: false, code: "invalid_cloud_urls" };
        norm.push(e);
      }
      out.cloudUrls = norm;
    }
    return { ok: true, patch: out };
  };

  /* 读覆盖（store 需提供 getItem/setItem/removeItem，通常传 localStorage；测试可传内存版）。
   * 存储异常一律视为无覆盖（绝不因覆盖读取出错挡登录）。 */
  VerifyNet.loadOverrides = function (store) {
    var s = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return {};
    try {
      var raw = s.getItem(VerifyNet.OVERRIDES_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      var n = VerifyNet.normalizeOverrides(parsed);
      return n.ok ? n.patch : {};
    } catch (e) { return {}; }
  };

  VerifyNet.saveOverrides = function (store, overrides) {
    var s = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return { ok: false, code: "no_storage" };
    var n = VerifyNet.normalizeOverrides(overrides);
    if (!n.ok) return n;
    try { s.setItem(VerifyNet.OVERRIDES_KEY, JSON.stringify(n.patch)); } catch (e) { /* 忽略写失败 */ }
    return { ok: true, patch: n.patch };
  };

  VerifyNet.clearOverrides = function (store) {
    var s = store || (typeof localStorage !== "undefined" ? localStorage : null);
    if (!s) return false;
    try { s.removeItem(VerifyNet.OVERRIDES_KEY); return true; } catch (e) { return false; }
  };

  /* 端点顺序：本机优先（凭据不出本机），云端兜底（保登录可用性）。
   * localAlive=true 时本机排第一；false 时本机仍保留在队尾再试一次
   * （探测有竞态，可能刚好起来了）。 */
  VerifyNet.endpoints = function (overrides, localAlive) {
    var o = overrides || {};
    var localUrl = trimSlash(o.localUrl || VerifyNet.LOCAL_URL);
    var cloudRaw = (Array.isArray(o.cloudUrls) && o.cloudUrls.length
      ? o.cloudUrls : VerifyNet.CLOUD_URLS);
    var cloud = [];
    for (var i = 0; i < cloudRaw.length; i++) {
      var e = normCloudEntry(cloudRaw[i]);
      if (e) cloud.push({
        url: e.url, sharecode: e.sharecode, kind: "cloud",
        label: "云端验证服务" + (cloud.length ? String(cloud.length + 1) : "")
      });
    }
    var local = { url: localUrl, sharecode: "", kind: "local", label: "本机验证服务" };
    return (localAlive === false ? cloud.concat([local]) : [local].concat(cloud));
  };

  /* 端点的 verify 请求地址：云端发布站点需带 sharecode（公开值），否则网关拦截 */
  VerifyNet.verifyPath = function (ep) {
    ep = ep || {};
    return trimSlash(ep.url) + "/verify" +
      (ep.sharecode ? "?sharecode=" + encodeURIComponent(ep.sharecode) : "");
  };

  /* 单次验证结果分类：
   *  - ok            验证通过
   *  - rejected      服务已连通且明确拒绝（账号密码错误等）→ 不再降级，直接展示原因
   *  - stale         服务是旧版（无 /verify 接口，404 not found）→ 可降级
   *  - unreachable   连不上 / 超时 / 服务端 5xx → 可降级 */
  VerifyNet.classify = function (status, res) {
    var r = (res && typeof res === "object") ? res : {};
    if (status >= 200 && status < 300 && r.ok === true) return "ok";
    if (status === 404 || r.error === "not found") return "stale";
    if (status >= 500) return "unreachable";
    if (r.ok === false && r.error) return "rejected";
    return "unreachable";
  };

  /* fetch 层异常分类（网络错误 / 超时中断）→ 全部按 unreachable 处理 */
  VerifyNet.classifyError = function (e) {
    if (e && e.name === "AbortError") return "timeout";
    return "unreachable";
  };

  /* 组合提示：所有端点都连不上时给用户的落地指引 */
  VerifyNet.allDownHint = function (eps) {
    var hasCloud = (eps || []).some(function (e) { return e.kind === "cloud"; });
    return "✗ 验证服务全部连不上（本机 + 云端" + (hasCloud ? "" : "未配置") + "）。"
      + "可在本机运行 python syncserver.py 后重试，或检查网络。";
  };

  global.VerifyNet = VerifyNet;
})(typeof window !== "undefined" ? window : this);
