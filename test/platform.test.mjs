/*
 * platform.js 测试（零依赖，Node >= 16）
 * 运行：node test/platform.test.mjs
 *
 * 覆盖学在城院平台数据进工作台的纯计算层：normalize 容错、
 * 待办新增 / 截止更新、已提交永不改动、采集库去重。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
(0, eval)(readFileSync(path.join(root, "platform.js"), "utf8"));
const PlatformKit = globalThis.PlatformKit;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name + "\n    " + String(e.message).split("\n")[0]);
    process.exitCode = 1;
  }
}

console.log("platform.js " + PlatformKit.version);

/* ---------- normalize ---------- */
test("normalize keeps a well-formed payload", () => {
  const p = PlatformKit.normalize({
    fetchedAt: "2026-10-22 13:00", source: "chaoxing",
    courses: [{ id: "2261", name: "电力电子技术" }],
    assignments: [{ course: "电力电子技术", title: "实验1", kind: "作业", due: "2026-11-02 23:59", status: "todo", note: "" }],
    materials: [{ course: "电力电子技术", title: "第3章课件", kind: "课件", note: "" }],
    errors: []
  });
  assert.equal(p.assignments.length, 1);
  assert.equal(p.assignments[0].due, "2026-11-02");
  assert.equal(p.materials.length, 1);
  assert.deepEqual(p.errors, []);
});

test("normalize tolerates null / garbage payloads without throwing", () => {
  for (const bad of [null, undefined, 42, "x", {}, { assignments: null, materials: 7 }]) {
    const p = PlatformKit.normalize(bad);
    assert.deepEqual(p.assignments, []);
    assert.deepEqual(p.materials, []);
    assert.deepEqual(p.courses, []);
  }
});

test("normalize drops entries without a title and clamps unknown status", () => {
  const p = PlatformKit.normalize({
    assignments: [
      { course: "C", title: "A", status: "weird" },
      { course: "C", title: "  ", status: "todo" },
      { title: "无课程的作业" }
    ]
  });
  assert.equal(p.assignments.length, 2);
  assert.equal(p.assignments[0].status, "unknown");
  assert.equal(p.assignments[1].course, "通用");
});

test("normalize coerces due to YYYY-MM-DD from several shapes", () => {
  const p = PlatformKit.normalize({ assignments: [
    { title: "a", due: "2026/11/2 23:59" },
    { title: "b", due: "2026.12.31" },
    { title: "c", due: "无期限" }
  ]});
  assert.equal(p.assignments[0].due, "2026-11-02");
  assert.equal(p.assignments[1].due, "2026-12-31");
  assert.equal(p.assignments[2].due, "");
});

/* ---------- mergeOps ---------- */
const PAYLOAD = {
  fetchedAt: "2026-10-22 13:00", source: "chaoxing", courses: [],
  assignments: [
    { course: "电力电子技术", title: "实验1 报告", kind: "作业", due: "2026-11-02", status: "todo", note: "" },
    { course: "电机与拖动", title: "课堂练习3", kind: "考试", due: "2026-10-30", status: "submitted", note: "" },
    { course: "电力电子技术", title: "实验1 报告", kind: "作业", due: "2026-11-02", status: "unknown", note: "" }
  ],
  materials: [{ course: "电力电子技术", title: "第3章 Buck变换器课件", kind: "课件", note: "开关频率 20kHz" }],
  errors: ["电机与拖动：缺少 enc 参数"]
};

test("mergeOps adds todo assignments as workbench items", () => {
  const r = PlatformKit.mergeOps(PAYLOAD, [], []);
  assert.equal(r.itemsToAdd.length, 1);
  const it = r.itemsToAdd[0];
  assert.equal(it.name, "实验1 报告");
  assert.equal(it.course, "电力电子技术");
  assert.equal(it.due, "2026-11-02");
  assert.equal(it.status, "todo");
  assert.equal(it.ai, false);
  assert.equal(r.stats.added, 1);
});

test("unknown status is treated as a todo item, unknown-kind exams map to 线上作答", () => {
  const p = PlatformKit.normalize({ assignments: [{ course: "C", title: "期末考试", kind: "考试", due: "2026-12-01", status: "unknown" }] });
  const r = PlatformKit.mergeOps(p, [], []);
  assert.equal(r.itemsToAdd.length, 1);
  assert.equal(r.itemsToAdd[0].type, "线上作答");
});

test("mergeOps routes submitted history into the capture store, never into todos", () => {
  const r = PlatformKit.mergeOps(PAYLOAD, [], []);
  assert.equal(r.itemsToAdd.length, 1);
  const hist = r.capturesToAdd.filter((c) => c.kind === "历史作业");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].title, "课堂练习3");
  assert.match(hist[0].note, /已提交/);
});

test("mergeOps routes materials into the capture store", () => {
  const r = PlatformKit.mergeOps(PAYLOAD, [], []);
  const mats = r.capturesToAdd.filter((c) => c.kind === "课件");
  assert.equal(mats.length, 1);
  assert.equal(mats[0].title, "第3章 Buck变换器课件");
});

test("re-running mergeOps is idempotent (dedupe by course+kind+title / course+name)", () => {
  const items = PlatformKit.mergeOps(PAYLOAD, [], []).itemsToAdd;
  const caps = PlatformKit.mergeOps(PAYLOAD, [], []).capturesToAdd;
  const r2 = PlatformKit.mergeOps(PAYLOAD, caps, items);
  assert.equal(r2.itemsToAdd.length, 0);
  assert.equal(r2.capturesToAdd.length, 0);
  assert.ok(r2.stats.skipped >= 3);
});

test("a changed due date produces an update op; identical dates do not", () => {
  const first = PlatformKit.mergeOps(PAYLOAD, [], []);
  const items = first.itemsToAdd.map((it) => ({ ...it, id: 1 }));
  const changed = JSON.parse(JSON.stringify(PAYLOAD));
  changed.assignments[0].due = "2026-11-09";
  const r2 = PlatformKit.mergeOps(changed, [], items);
  assert.equal(r2.itemsToUpdate.length, 1);
  assert.equal(r2.itemsToUpdate[0].patch.due, "2026-11-09");
  const r3 = PlatformKit.mergeOps(PAYLOAD, [], items);
  assert.equal(r3.itemsToUpdate.length, 0);
});

test("submitted items are never touched even when their due date changed upstream", () => {
  const items = [{ id: 9, name: "课堂练习3", course: "电机与拖动", due: "2026-10-30", status: "submitted" }];
  const changed = JSON.parse(JSON.stringify(PAYLOAD));
  changed.assignments[1].due = "2026-12-31";
  const r = PlatformKit.mergeOps(changed, [], items);
  assert.equal(r.itemsToUpdate.length, 0);
  assert.equal(r.itemsToAdd.length, 1);   /* 实验1 是新待办，与课堂练习3 无关 */
  assert.ok(!r.itemsToAdd.some((it) => it.name === "课堂练习3"));
  assert.ok(r.capturesToAdd.some((c) => c.title === "课堂练习3"));
});

test("an existing todo item with a stale due date gets updated, not duplicated", () => {
  const items = [{ id: 5, name: "实验1 报告", course: "电力电子技术", due: "2026-10-20", status: "todo" }];
  const r = PlatformKit.mergeOps(PAYLOAD, [], items);
  assert.equal(r.itemsToAdd.length, 0);
  assert.equal(r.itemsToUpdate.length, 1);
  assert.equal(r.itemsToUpdate[0].patch.due, "2026-11-02");
});

test("errors are preserved by normalize for the page to surface", () => {
  const p = PlatformKit.normalize(PAYLOAD);
  assert.deepEqual(p.errors, ["电机与拖动：缺少 enc 参数"]);
});

test("stats summarize the whole merge", () => {
  const r = PlatformKit.mergeOps(PAYLOAD, [], []);
  assert.equal(r.stats.added, 1);
  assert.equal(r.stats.captures, 2);
  assert.equal(r.stats.items, 2);
});

/* ---------- filterCourse ---------- */
test("filterCourse keeps everything for empty / 全部课程 selectors", () => {
  for (const sel of [null, undefined, "", "全部课程"]) {
    const p = PlatformKit.filterCourse(PAYLOAD, sel);
    assert.equal(p.assignments.length, 3);
    assert.equal(p.materials.length, 1);
  }
});

test("filterCourse narrows assignments and materials to the chosen course", () => {
  const p = PlatformKit.filterCourse(PAYLOAD, "电力电子技术");
  assert.equal(p.assignments.length, 2);          /* 实验1 todo + dedupe 条目 */
  assert.ok(p.assignments.every((a) => a.course === "电力电子技术"));
  assert.equal(p.materials.length, 1);
  assert.equal(p.materials[0].title, "第3章 Buck变换器课件");
  assert.equal(p.courses.length, 0);              /* PAYLOAD.courses 为空数组 */
});

test("filterCourse on a course with no data yields an empty payload", () => {
  const p = PlatformKit.filterCourse(PAYLOAD, "不存在的课程");
  assert.deepEqual(p.assignments, []);
  assert.deepEqual(p.materials, []);
});

test("filterCourse output still merges through mergeOps (pipeline check)", () => {
  const filtered = PlatformKit.filterCourse(PAYLOAD, "电机与拖动");
  const r = PlatformKit.mergeOps(filtered, [], []);
  assert.equal(r.itemsToAdd.length, 0);           /* 课堂练习3 已提交 → 只进采集库 */
  const hist = r.capturesToAdd.filter((c) => c.kind === "历史作业");
  assert.equal(hist.length, 1);
  assert.equal(hist[0].course, "电机与拖动");
});

/* ---------- 历史作业记忆（#58） ---------- */
test("submitted captures carry the capture date (采集于 - fix)", () => {
  const r = PlatformKit.mergeOps(PAYLOAD, [], []);
  const hist = r.capturesToAdd.find((c) => c.kind === "历史作业");
  assert.equal(hist.time, "2026-10-22");
});

test("a richer upstream note queues capturesToUpdate; identical note does not", () => {
  const first = PlatformKit.mergeOps(PAYLOAD, [], []);
  const caps = first.capturesToAdd.map((c) => ({ ...c, id: 7 }));
  const rich = JSON.parse(JSON.stringify(PAYLOAD));
  rich.assignments[1].note = "要求：提交源码与报告；成绩：95；批语：注意单位";
  const r2 = PlatformKit.mergeOps(rich, caps, []);
  assert.equal(r2.capturesToAdd.length, 0);
  assert.equal(r2.capturesToUpdate.length, 1);
  assert.equal(r2.capturesToUpdate[0].key, "电机与拖动|历史作业|课堂练习3");
  assert.match(r2.capturesToUpdate[0].patch.note, /成绩：95/);
  assert.equal(r2.capturesToUpdate[0].patch.time, "2026-10-22");
  assert.equal(r2.stats.capturesUpdated, 1);
  /* 更新后再同步：note 一致 → 幂等，不再产生更新 */
  const caps2 = caps.map((c) =>
    c.title === "课堂练习3" ? { ...c, note: r2.capturesToUpdate[0].patch.note } : c);
  const r3 = PlatformKit.mergeOps(rich, caps2, []);
  assert.equal(r3.capturesToUpdate.length, 0);
  assert.equal(r3.stats.capturesUpdated, 0);
});

test("a thinner or equal upstream note never shrinks the stored memory", () => {
  const caps = [{ id: 7, kind: "历史作业", course: "电机与拖动", title: "课堂练习3",
                  note: "平台状态：已提交（截止 2026-10-30）；要求：全文见附件", time: "2026-10-01" }];
  const r = PlatformKit.mergeOps(PAYLOAD, caps, []);
  assert.equal(r.capturesToUpdate.length, 0);
  assert.equal(r.stats.capturesUpdated, 0);
  /* 历史作业不重复入库；唯一新增的是 PAYLOAD 里尚不在库中的那条课件 */
  assert.equal(r.capturesToAdd.filter((c) => c.kind === "历史作业").length, 0);
  assert.deepEqual(r.capturesToAdd.map((c) => c.kind), ["课件"]);
});

test("filterCourse + mergeOps keep capturesToUpdate semantics (pipeline check)", () => {
  const rich = JSON.parse(JSON.stringify(PAYLOAD));
  rich.assignments[1].note = "要求：提交源码与报告";
  const filtered = PlatformKit.filterCourse(rich, "电机与拖动");
  const r = PlatformKit.mergeOps(filtered, [], []);
  assert.equal(r.capturesToAdd.filter((c) => c.kind === "历史作业").length, 1);
  assert.match(r.capturesToAdd[0].note, /要求：提交源码与报告/);
});

console.log("\n" + passed + " passed");
