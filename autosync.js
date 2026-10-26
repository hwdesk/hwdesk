/*! autosync.js 1.0.0 | hwdesk 登录后自动同步编排（纯计算，DOM 无关） */
(function (global) {
  "use strict";

  var AutoSync = { version: "1.0.0" };

  /* ---------- 存储约定 ----------
   * 设置键：任何非 "off" 的值（含不存在）= 开启；显式写 "off" 才算关。
   * 时间键：ISO 字符串；解析失败按从未同步处理。
   * 与 sync.js / platform.js 互不依赖，也互不读写对方的键。 */
  AutoSync.LS_ENABLED = "wb_hwdesk_autosync";
  AutoSync.LS_LAST = "wb_hwdesk_lastAutoSync";
  AutoSync.DEFAULT_MIN_MINUTES = 30;   /* 节流窗口：窗口内重复登录不重复拉取 */

  function lsGet(key) {
    try { return global.localStorage ? global.localStorage.getItem(key) : null; }
    catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { if (global.localStorage) global.localStorage.setItem(key, val); } catch (e) { /* 隐私模式等，静默 */ }
  }

  AutoSync.isEnabled = function () { return lsGet(AutoSync.LS_ENABLED) !== "off"; };
  AutoSync.setEnabled = function (on) {
    lsSet(AutoSync.LS_ENABLED, on ? "on" : "off");
    return AutoSync.isEnabled();
  };
  AutoSync.lastRun = function () { return lsGet(AutoSync.LS_LAST) || ""; };
  AutoSync.markRun = function (iso) { lsSet(AutoSync.LS_LAST, iso || new Date().toISOString()); };

  /* 毫秒 → 「X 分钟」/「X 小时 Y 分钟」 */
  AutoSync.humanizeWait = function (ms) {
    if (!(ms > 0)) return "0 分钟";
    var m = Math.ceil(ms / 60000);
    if (m < 60) return m + " 分钟";
    var h = Math.floor(m / 60);
    return h + " 小时 " + (m - h * 60) + " 分钟";
  };

  /* ---------- 该不该在这次登录后自动同步？（纯函数） ----------
   * opts = { enabled, hasCreds, lastRun, now, minIntervalMinutes, force }
   * 返回 { run, reason, detail }；reason ∈ disabled | no-creds | throttled | ok
   * force = true 时无视节流（手动「一键获取」走自己的通道，不用这里）。 */
  AutoSync.shouldRun = function (opts) {
    var o = opts || {};
    if (o.enabled === false) return { run: false, reason: "disabled", detail: "设置里已关闭自动同步" };
    if (!o.hasCreds) return { run: false, reason: "no-creds", detail: "本机没有保存的学在城院凭据" };
    var min = o.minIntervalMinutes;
    if (typeof min !== "number" || !(min >= 0)) min = AutoSync.DEFAULT_MIN_MINUTES;
    if (!o.force && o.lastRun) {
      var last = Date.parse(o.lastRun);
      var now = Date.parse(o.now || new Date().toISOString());
      if (!isNaN(last) && !isNaN(now)) {
        var waitMs = min * 60000 - (now - last);
        if (waitMs > 0) {
          return { run: false, reason: "throttled", detail: AutoSync.humanizeWait(waitMs) + "内已自动同步过，跳过（手动一键获取不受限）" };
        }
      }
    }
    return { run: true, reason: "ok", detail: "" };
  };

  /* ---------- 结果一句话（纯函数） ----------
   * stats 用 PlatformKit.mergeOps().stats 的形状；errors 为平台回报的未取到列表。 */
  AutoSync.summarize = function (stats, errors) {
    stats = stats || {};
    var s = "作业/考试 " + (stats.items || 0) + " 项（新增 " + (stats.added || 0)
      + "、更新截止 " + (stats.updated || 0) + "），采集入库 " + (stats.captures || 0) + " 条";
    if (stats.capturesUpdated) s += "（更新 " + stats.capturesUpdated + " 条课程记忆）";
    if (errors && errors.length) s += "；部分未取到：" + errors.join("；");
    return s;
  };

  /* 自动同步发现本机服务未启动时给用户的指引 */
  AutoSync.offlineHint = function () {
    return "本机同步服务未启动：在项目目录运行 python syncserver.py 后，到「数据获取」点「⚡ 从学在城院一键获取」即可";
  };

  global.AutoSync = AutoSync;
})(typeof window !== "undefined" ? window : globalThis);
