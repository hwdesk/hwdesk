/*!
 * sync.js — hwdesk 平台一键同步引擎（学在城院 ⇄ 工作台）
 * ------------------------------------------------------------
 * 解决「数据获取」区块的三次手工跳步：逐课程生成指令 → 粘给代理 →
 * 逐条手工登记采集结果。改为：
 *   1) 一键生成**全平台**同步指令（SyncKit.buildInstruction，要代理
 *      以严格 JSON 回报所有课程的课件/作业/成绩）
 *   2) 代理回报后，粘贴 JSON → SyncKit.parse（容忍 ```json 围栏，
 *      拒绝坏数据）→ SyncKit.planMerge（纯函数算出增量操作）
 *   3) 页面应用操作：采集库批量入库 + 作业自动建档/更新截止，零手工
 *
 * 诚实约束（与 README 隐私节一致）：file:// 页面无法也不应直接登录
 * 学在城院（跨域不可读、凭据不进页面），代理仍是唯一持凭据的执行者，
 * 本模块只是把代理往返之外的所有手工环节去掉。
 *
 * 依赖约定：与其他引擎互不依赖，无 DOM、无网络请求。
 */
(function (global) {
  "use strict";

  var SyncKit = {};
  SyncKit.VERSION = "1.0.0";

  /* 同步状态键（页面读写，引擎只提供常量） */
  SyncKit.LS_LAST = "wb_hwdesk_lastSync";

  /* ---------- 1) 全平台同步指令 ----------
   * 要求代理以严格 JSON 回报（schema 内嵌在指令里），替代旧逐课程文案。
   */
  SyncKit.buildInstruction = function () {
    return "【学在城院 · 全平台一键同步】请登录学在城院，采集**全部课程**的以下信息，并**只回复一个 JSON 对象**（不要多余文字，不要 markdown 说明）：\n"
      + "{\n"
      + '  "courseware":  [{"course":"课程名","title":"课件文件名","note":"内容摘要（参数要求/格式规范/老师强调点）"}],\n'
      + '  "assignments": [{"course":"课程名","name":"作业名","due":"YYYY-MM-DD","type":"文件上传|线上作答|附件+报告","note":"要求原文"}],\n'
      + '  "grades":      [{"course":"课程名","title":"作业名","note":"成绩与老师批语"}]\n'
      + "}\n"
      + "要求：\n"
      + "1. courseware：每门课全部 PPT/Word 课件，逐个给文件名与摘要\n"
      + "2. assignments：当前已发布的全部作业（含截止日期与要求原文）\n"
      + "3. grades：我已提交作业的成绩与批语\n"
      + "4. 日期一律 YYYY-MM-DD；没有的字段给空数组；不要编造平台上看不到的内容";
  };

  /* ---------- 2) 解析代理回报 ----------
   * 容忍 ```json … ``` 围栏与前后杂文字，取第一个平衡的 JSON 对象。
   * 返回 { ok:true, data } 或 { ok:false, error }。
   */
  SyncKit.parse = function (text) {
    if (!text || !String(text).trim()) return { ok: false, error: "empty" };
    var s = String(text).trim();
    var fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) s = fenced[1].trim();
    var start = s.indexOf("{");
    if (start === -1) return { ok: false, error: "no-json" };
    /* 从第一个 { 起找平衡的右括号（忽略字符串内的括号） */
    var depth = 0, inStr = false, esc = false, end = -1;
    for (var i = start; i < s.length; i++) {
      var c = s.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) return { ok: false, error: "unbalanced" };
    var data;
    try { data = JSON.parse(s.slice(start, end)); }
    catch (e) { return { ok: false, error: "invalid-json" }; }
    if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "not-object" };
    var out = { courseware: [], assignments: [], grades: [] };
    ["courseware", "assignments", "grades"].forEach(function (k) {
      if (Array.isArray(data[k])) {
        out[k] = data[k].filter(function (r) {
          return r && typeof r === "object" && String(r.course || "").trim() &&
            String(r.title || r.name || "").trim();
        });
      }
    });
    if (!out.courseware.length && !out.assignments.length && !out.grades.length)
      return { ok: false, error: "no-valid-rows" };
    return { ok: true, data: out };
  };

  /* ---------- 3) 增量合并计划（纯函数） ----------
   * payload : SyncKit.parse(...).data
   * captures: 现有采集库记录（DB.list("captures")）
   * items   : 现有作业（state.items）
   * 返回 { capturesToAdd, itemsToAdd, itemsToUpdate, stats }
   * 页面负责把 ops 应用到 DB / state。
   */
  SyncKit.planMerge = function (payload, captures, items) {
    captures = captures || []; items = items || [];
    var capKey = function (course, kind, title) { return (course + "|" + kind + "|" + title); };
    var existCap = {};
    captures.forEach(function (c) { existCap[capKey(c.course, c.kind, c.title)] = true; });

    var capturesToAdd = [];
    (payload.courseware || []).forEach(function (r) {
      var key = capKey(r.course, "课件", r.title);
      if (!existCap[key]) { existCap[key] = true; capturesToAdd.push({ kind: "课件", course: r.course, title: r.title, note: r.note || "", source: "sync" }); }
    });
    (payload.grades || []).forEach(function (r) {
      var key = capKey(r.course, "成绩", r.title);
      if (!existCap[key]) { existCap[key] = true; capturesToAdd.push({ kind: "成绩", course: r.course, title: r.title, note: r.note || "", source: "sync" }); }
    });
    (payload.assignments || []).forEach(function (r) {
      var key = capKey(r.course, "作业要求", r.name);
      if (!existCap[key]) { existCap[key] = true; capturesToAdd.push({ kind: "作业要求", course: r.course, title: r.name, note: r.note || "", source: "sync" }); }
    });

    var itemKey = function (course, name) {
      return (String(course || "").trim() + "|" + String(name || "").trim());
    };
    var existItem = {};
    items.forEach(function (it) { existItem[itemKey(it.course, it.name)] = it; });

    var itemsToAdd = [], itemsToUpdate = [], dupItems = 0;
    (payload.assignments || []).forEach(function (r) {
      var key = itemKey(r.course, r.name);
      var ex = existItem[key];
      if (!ex) {
        var fresh = {
          name: r.name, course: r.course, due: r.due || "",
          type: r.type || "文件上传", note: r.note || "", status: "todo",
          ai: false, difficulty: "auto", format: "文字", source: "sync"
        };
        /* 本批次去重索引：同一批 JSON 里的同课程同名重复条目不会再建第二份待办 */
        existItem[key] = fresh;
        itemsToAdd.push(fresh);
      } else if (ex.id === undefined) {
        /* 同一批次内重复：只补截止日期，不重复建档 */
        dupItems++;
        if (r.due && ex.due !== r.due) ex.due = r.due;
      } else if (r.due && ex.due !== r.due && ex.status !== "submitted") {
        itemsToUpdate.push({ id: ex.id, from: ex.due, to: r.due });
      }
    });

    return {
      capturesToAdd: capturesToAdd,
      itemsToAdd: itemsToAdd,
      itemsToUpdate: itemsToUpdate,
      stats: {
        courseware: (payload.courseware || []).length,
        assignments: (payload.assignments || []).length,
        grades: (payload.grades || []).length,
        newCaptures: capturesToAdd.length,
        newItems: itemsToAdd.length,
        updatedItems: itemsToUpdate.length,
        dupItems: dupItems
      }
    };
  };

  /* UMD-lite */
  global.SyncKit = SyncKit;
})(typeof window !== "undefined" ? window : globalThis);
