/*! sso.js 1.0.0 | hwdesk 学在城院登录凭据（只存本机，不进仓库） */
(function (global) {
  "use strict";

  var SSO = { version: "1.0.0" };

  var LS_KEY = "wb_hwdesk_sso";       // 记住到本机（localStorage）
  var SS_KEY = "wb_hwdesk_sso_sess";  // 仅本次（sessionStorage）

  /* creds = { account, password, savedAt } */
  SSO.MEM = null;   // 第三档：页面内存（不落任何 storage）

  function storage(local) {
    try { return local ? global.localStorage : global.sessionStorage; }
    catch (e) { return null; }
  }
  function read(local) {
    var st = storage(local);
    if (!st) return null;
    try {
      var raw = st.getItem(local ? LS_KEY : SS_KEY);
      var c = raw ? JSON.parse(raw) : null;
      return (c && c.account && c.password) ? c : null;
    } catch (e) { return null; }
  }
  function write(local, creds) {
    var st = storage(local);
    if (!st) return false;
    try { st.setItem(local ? LS_KEY : SS_KEY, JSON.stringify(creds)); return true; }
    catch (e) { return false; }
  }
  function wipe(local) {
    var st = storage(local);
    if (!st) return;
    try { st.removeItem(local ? LS_KEY : SS_KEY); } catch (e) { /* 静默 */ }
  }

  /* mode: "session"（仅本次）| "local"（记住到本机）| "memory"（内存）
   * 每次设置都清掉其他两档，保证 SSO.get() 拿到的就是最近一次保存的那份 */
  SSO.set = function (account, password, mode) {
    var creds = { account: String(account || "").trim(), password: String(password || ""), savedAt: new Date().toISOString() };
    if (!creds.account || !creds.password) return false;
    wipe(true); wipe(false); SSO.MEM = null;
    if (mode === "local") return write(true, creds);
    if (mode === "session") return write(false, creds);
    SSO.MEM = creds;
    return true;
  };
  SSO.get = function () {
    var local = read(true);
    if (local) return { creds: local, where: "local" };
    var sess = read(false);
    if (sess) return { creds: sess, where: "session" };
    if (SSO.MEM) return { creds: SSO.MEM, where: "memory" };
    return null;
  };
  SSO.has = function () { return !!SSO.get(); };
  SSO.clear = function () {
    SSO.MEM = null;
    wipe(true); wipe(false);
  };

  /* 打码：`3202101234` → `3202****234` */
  SSO.mask = function (account) {
    var a = String(account || "");
    if (a.length <= 4) return a.replace(/./g, "*");
    if (a.length <= 8) return a.slice(0, 2) + "****" + a.slice(-2);
    return a.slice(0, 4) + "****" + a.slice(-3);
  };

  /* ---------- 采集指令的登录段落 ----------
   * opts.includePassword = true 时才把密码写进指令（默认绝不写）。
   * 指令是复制给学生本人本机代理的，密码仍不出本机，但要提醒别外传。 */
  SSO.instructionSnippet = function (opts) {
    var st = SSO.get();
    if (!st) return "";
    opts = opts || {};
    var lines = ["登录信息：学在城院账号 " + st.creds.account];
    if (opts.includePassword) {
      lines.push("密码：" + st.creds.password + "（凭据仅用于本次登录，禁止写入日志、截图或转发给任何人）");
    } else {
      lines.push("密码已存本机，需要时向我要，或使用我本机保存的凭据；不要尝试从其他渠道获取。");
    }
    return lines.join("\n");
  };

  global.SSO = SSO;
})(typeof window !== "undefined" ? window : this);
