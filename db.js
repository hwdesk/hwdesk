/*!
 * db.js — hwdesk 库管理层（多区块工作台数据底座）
 * ------------------------------------------------------------
 * 参照 RoleWeave 多区块工作台的数据组织方式，为各功能区块
 * 提供独立的命名库（store），统一 CRUD 与旧数据迁移：
 *
 *   captures    平台采集库：从学在城院拉取的课件/作业要求/历史作业登记
 *   submissions 交付库：每项任务的交付记录（pending → submitted / changes）
 *   reviews     审批库：自查审批记录（通过 / 退回修改）
 *   chats       对话库：每项任务与多个 AI Agent 的对话记录（turns）
 *
 * 兼容性：作业(items)、日志(logs)、材料(materials)仍使用原有
 * localStorage 键（wb_hwdesk_*），由页面直接管理；本模块只负责
 * 新增四库，避免破坏既有数据。
 */
(function (global) {
  "use strict";

  var DB = {};
  DB.VERSION = "1.3.0";

  /* 库注册表：key → localStorage 键名（基准名；账号隔离后实际键名加 ::<account> 后缀） */
  DB.STORES = {
    captures: "wb_hwdesk_captures",
    submissions: "wb_hwdesk_submissions",
    reviews: "wb_hwdesk_reviews",
    chats: "wb_hwdesk_chats"
  };

  /* ---------- 账号命名空间（issue #92：多账号数据串号） ----------
   * DB.scope("32402235") 后所有库的读写都落到 `wb_hwdesk_<store>::32402235`，
   * 不同账号的数据互不可见；scope 为空 = 旧版全局空间（向后兼容）。
   * DB.adoptLegacy(scope) 把无后缀旧库的一次性迁移进指定账号空间。 */
  DB._scope = "";
  DB.scope = function (account) {
    DB._scope = String(account || "").trim();
    return DB._scope;
  };
  function skey(store) {
    var base = DB.STORES[store] || store;
    return DB._scope ? base + "::" + DB._scope : base;
  }
  DB.adoptLegacy = function (scope) {
    var prev = DB._scope;
    DB._scope = "";
    var moved = 0;
    Object.keys(DB.STORES).forEach(function (name) {
      var base = DB.STORES[name];
      var legacy = read(base);
      if (legacy.length) {
        write(base + "::" + scope, legacy.concat(read(base + "::" + scope)));
        write(base, []);
        moved += legacy.length;
      }
    });
    DB._scope = prev;
    return moved;
  };

  /* 每库上限（#59）：captures 是课程记忆库——全部课程的课件 + 历史作业 +
   * 成绩都往这里放，200 条远远不够，提到 2000 防止最老的课程记忆被静默
   * 截断；其余库仍是流水性质，200 防膨胀即可 */
  DB.CAPS = {
    captures: 2000,
    submissions: 200,
    reviews: 200,
    chats: 200
  };

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key) || "[]") || []; }
    catch (e) { return []; }
  }
  function write(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr));
  }

  /* ---------- 通用 CRUD（键名经 skey() 加账号后缀） ---------- */
  DB.list = function (store) { return read(skey(store)); };

  DB.insert = function (store, record) {
    var arr = DB.list(store);
    record.id = record.id || (Date.now() % 100000000 + Math.floor(Math.random() * 1000));
    arr.unshift(record);
    var cap = DB.CAPS[store] || 200;                  // 按库上限（#59）
    if (arr.length > cap) arr.length = cap;
    write(skey(store), arr);
    return record;
  };

  DB.find = function (store, id) {
    var arr = DB.list(store);
    for (var i = 0; i < arr.length; i++) if (arr[i].id === id) return arr[i];
    return null;
  };

  DB.update = function (store, id, patch) {
    var arr = DB.list(store);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i].id === id) {
        Object.keys(patch).forEach(function (k) { arr[i][k] = patch[k]; });
        write(skey(store), arr);
        return arr[i];
      }
    }
    return null;
  };

  DB.remove = function (store, id) {
    var key = skey(store);
    var arr = read(key).filter(function (r) { return r.id !== id; });
    write(key, arr);
    return arr;
  };

  DB.clear = function (store) { write(skey(store), []); };

  /* ---------- 交付状态机（纯函数，供审批流使用） ----------
   * 交付记录生命周期：pending（待审）→ submitted（已交付）/ changes（退回修改）
   * changes 后可重新提交回到 pending。
   */
  DB.TRANSITIONS = {
    pending: ["submitted", "changes"],
    changes: ["pending", "submitted"],
    submitted: []
  };

  DB.canTransition = function (from, to) {
    return (DB.TRANSITIONS[from] || []).indexOf(to) !== -1;
  };

  /* ---------- 兼容层：沙箱/Node 环境无 localStorage 时用内存兜底 ---------- */
  (function () {
    var hasLS = false;
    try { hasLS = typeof localStorage !== "undefined" && !!localStorage.setItem; } catch (e) { hasLS = false; }
    if (!hasLS) {
      var mem = {};
      global.localStorage = {
        getItem: function (k) { return k in mem ? mem[k] : null; },
        setItem: function (k, v) { mem[k] = String(v); },
        removeItem: function (k) { delete mem[k]; }
      };
    }
  })();

  /* UMD-lite */
  global.DB = DB;
})(typeof window !== "undefined" ? window : globalThis);
