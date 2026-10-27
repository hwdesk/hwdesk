/*! platform.js 1.1.0 | hwdesk 学在城院平台数据 → 工作台数据（纯计算，DOM 无关） */
(function (global) {
  "use strict";

  var PlatformKit = { version: "1.1.0" };

  /* 把 syncserver.py / 外部采集（POST /ingest）返回的 payload 规整成内部结构。
   * payload 期望形如：
   * { fetchedAt, source,
   *   courses:     [{ id, name }],
   *   assignments: [{ course, title, kind:"作业|考试", due:"YYYY-MM-DD[ HH:MM]", status:"todo|submitted|unknown", note }],
   *   materials:   [{ course, title, kind, note }],
   *   errors:      ["..."] }
   * 宽松容错：缺字段按空处理，绝不抛错（平台改版时页面也要能合并拿到的部分数据）。 */
  PlatformKit.normalize = function (raw) {
    var p = (raw && typeof raw === "object") ? raw : {};
    function arr(v) { return Array.isArray(v) ? v : []; }
    function str(v) { return (v == null ? "" : String(v)).trim(); }
    function dateOnly(v) {
      var m = str(v).match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
      return m ? (m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2)) : "";
    }
    var out = { fetchedAt: str(p.fetchedAt), source: str(p.source) || "hzcu-xzc", errors: arr(p.errors).map(str) };
    out.courses = arr(p.courses).map(function (c) {
      return { id: str(c && c.id), name: str(c && c.name) };
    }).filter(function (c) { return c.id || c.name; });
    out.assignments = arr(p.assignments).map(function (a) {
      if (!a) return null;
      var status = str(a.status).toLowerCase();
      if (status !== "submitted" && status !== "todo") status = "unknown";
      return {
        course: str(a.course) || "通用", title: str(a.title),
        kind: str(a.kind) || "作业", due: dateOnly(a.due), status: status, note: str(a.note)
      };
    }).filter(function (a) { return a.title; });
    out.materials = arr(p.materials).map(function (m) {
      if (!m) return null;
      return { course: str(m.course) || "通用", title: str(m.title), kind: str(m.kind) || "课件", note: str(m.note) };
    }).filter(function (m) { return m.title; });
    return out;
  };

  /* 按课程过滤 payload（纯计算）：course 为空 / "全部课程" 时原样返回全量。
   * 用于「数据」页的单课程精拉：选择器里选了某一门课时，
   * 只合并该课程的作业与材料，其他课程的数据不进工作台。 */
  PlatformKit.filterCourse = function (raw, course) {
    var p = PlatformKit.normalize(raw);
    var c = (course == null ? "" : String(course)).trim();
    if (!c || c === "全部课程") return p;
    p.courses = p.courses.filter(function (x) { return x.name === c; });
    p.assignments = p.assignments.filter(function (a) { return a.course === c; });
    p.materials = p.materials.filter(function (m) { return m.course === c; });
    return p;
  };

  /* 规整后的平台数据 → 工作台增量操作（与既有采集库/作业库语义一致）：
   *   待办/状态未知的作业、考试 → 新作业或截止日期更新（已提交项永不改动）
   *   已提交的历史作业、课件材料 → 采集库（去重键：课程+类型+标题）
   *   平台带回更丰富的 note → 既有采集记录的更新 op（capturesToUpdate，#58）
   * 返回 { capturesToAdd, capturesToUpdate, itemsToAdd, itemsToUpdate, stats } */
  PlatformKit.mergeOps = function (raw, captures, items) {
    var p = PlatformKit.normalize(raw);
    var caps = Array.isArray(captures) ? captures : [];
    var its = Array.isArray(items) ? items : [];
    var capKey = function (c) { return [c.course, c.kind, c.title].join("|"); };
    var itemKey = function (it) { return [it.course, it.name].join("|"); };
    var capRec = {}, itemSet = {};
    caps.forEach(function (c) { capRec[capKey(c)] = c; });
    its.forEach(function (it) { itemSet[itemKey(it)] = it; });

    var result = { capturesToAdd: [], capturesToUpdate: [], itemsToAdd: [], itemsToUpdate: [],
                   stats: { added: 0, updated: 0, captures: 0, capturesUpdated: 0, skipped: 0, items: 0 } };
    var updSet = {};

    /* 采集记录更新 op（#58）：平台带回的 note 比本地更丰富（更长）才更新，
     * 保证重复同步幂等、历史记忆只增不缩；同键同批只排一次 */
    function queueCaptureUpdate(key, fresh) {
      var rec = capRec[key];
      if (!rec || !fresh.note || String(rec.note || "").length >= String(fresh.note).length) return false;
      if (updSet[key]) return false;
      updSet[key] = 1;
      var patch = { note: fresh.note };
      if (fresh.time) patch.time = fresh.time;
      result.capturesToUpdate.push({ key: key, patch: patch });
      result.stats.capturesUpdated++;
      return true;
    }

    /* 材料 / 已提交历史作业 → 采集库 */
    p.materials.forEach(function (m) {
      var c = { kind: m.kind, course: m.course, title: m.title, note: m.note, time: (p.fetchedAt || "").slice(0, 10) || undefined };
      var k = [c.course, c.kind, c.title].join("|");
      if (capRec[k]) {
        if (!queueCaptureUpdate(k, c)) result.stats.skipped++;
        return;
      }
      capRec[k] = c;
      result.capturesToAdd.push(c);
      result.stats.captures++;
    });
    p.assignments.forEach(function (a) {
      if (a.status === "submitted") {
        var c = { kind: "历史作业", course: a.course, title: a.title,
                  time: (p.fetchedAt || "").slice(0, 10) || undefined,
                  note: ("平台状态：已提交" + (a.due ? "（截止 " + a.due + "）" : "") + (a.note ? "；" + a.note : "")) };
        var k = [c.course, c.kind, c.title].join("|");
        if (capRec[k]) {
          if (!queueCaptureUpdate(k, c)) result.stats.skipped++;
          return;
        }
        capRec[k] = c;
        result.capturesToAdd.push(c);
        result.stats.captures++;
        return;
      }
      /* 待办 / 状态未知 → 作业库 */
      var key = [a.course, a.title].join("|");
      var existing = itemSet[key];
      if (!existing) {
        var it = { name: a.title, course: a.course, due: a.due || "", type: a.kind === "考试" ? "线上作答" : "附件+报告",
                   note: a.note || ("来自学在城院" + (p.fetchedAt ? "（" + p.fetchedAt + "）" : "")), status: "todo",
                   ai: false, difficulty: "auto", format: "文字" };
        itemSet[key] = it;
        result.itemsToAdd.push(it);
        result.stats.added++;
        result.stats.items++;
        return;
      }
      result.stats.items++;
      if (a.due && existing.due !== a.due && !updSet[key]) {
        updSet[key] = 1;
        result.itemsToUpdate.push({ key: key, patch: { due: a.due } });
        result.stats.updated++;
      } else {
        result.stats.skipped++;
      }
    });
    return result;
  };

  global.PlatformKit = PlatformKit;
})(typeof window !== "undefined" ? window : this);
