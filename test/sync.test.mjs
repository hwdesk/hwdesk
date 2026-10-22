/* sync.test.mjs — 平台一键同步引擎零依赖测试
 * 运行：node test/sync.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(dir, "../sync.js"), "utf8");
new Function(code)();

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("  FAIL - " + name); }
}
const SyncKit = globalThis.SyncKit;

console.log("SyncKit:", SyncKit.VERSION);

/* ---------- 1) 同步指令 ---------- */
console.log("buildInstruction:");
{
  const s = SyncKit.buildInstruction();
  ok(s.includes("学在城院"), "instruction names the platform");
  ok(s.includes("全部课程"), "instruction pulls all courses at once");
  ok(s.includes("JSON"), "instruction demands strict JSON");
  ok(s.includes("courseware") && s.includes("assignments") && s.includes("grades"), "instruction embeds the payload schema");
  ok(s.includes("YYYY-MM-DD"), "instruction pins the date format");
  ok(s.includes("不要编造"), "instruction forbids fabrication");
  ok(SyncKit.buildInstruction() === s, "instruction is deterministic");
  ok(typeof SyncKit.LS_LAST === "string" && SyncKit.LS_LAST.startsWith("wb_hwdesk_"), "LS_LAST key exported");
}

/* ---------- 2) 解析 ---------- */
console.log("parse:");
{
  const good = { courseware: [{ course: "大学物理(Ⅰ)", title: "第3章.pptx", note: "刚体转动" }],
                 assignments: [{ course: "大学物理(Ⅰ)", name: "课后思考4", due: "2026-10-28", type: "附件+报告", note: "推导" }],
                 grades: [{ course: "电机与拖动", title: "课堂练习-2", note: "95 良好" }] };
  const r1 = SyncKit.parse(JSON.stringify(good));
  ok(r1.ok && r1.data.assignments.length === 1, "plain JSON parses");
  ok(SyncKit.parse("好的，以下是同步结果：\n```json\n" + JSON.stringify(good) + "\n```\n请查收。").ok, "fenced JSON with prose parses");
  ok(SyncKit.parse("前言文字 " + JSON.stringify(good) + " 尾巴").ok, "JSON embedded in prose parses (balanced scan)");

  ok(!SyncKit.parse("").ok && SyncKit.parse("").error === "empty", "empty -> error empty");
  ok(!SyncKit.parse("没有 JSON 的回复").ok && SyncKit.parse("没有 JSON 的回复").error === "no-json", "no JSON -> error no-json");
  ok(!SyncKit.parse('{"courseware": [').ok && SyncKit.parse('{"courseware": [').error === "unbalanced", "truncated JSON -> unbalanced");
  ok(!SyncKit.parse("{bad json}").ok, "malformed JSON -> error");
  ok(!SyncKit.parse("[1,2,3]").ok, "top-level array -> error not-object");
  ok(!SyncKit.parse('{"foo": "bar"}').ok && SyncKit.parse('{"foo": "bar"}').error === "no-valid-rows", "no valid rows -> error");
  /* 无效行被过滤而不是整体失败 */
  const mixed = SyncKit.parse(JSON.stringify({ courseware: [{ course: "c", title: "t" }, null, { title: "no course" }], assignments: [], grades: [] }));
  ok(mixed.ok && mixed.data.courseware.length === 1, "invalid rows filtered, valid ones kept");
  /* 字符串内的括号不干扰配对扫描 */
  const tricky = SyncKit.parse('{"grades": [{"course":"c","title":"t","note":"成绩(92)与{批语}"}]}');
  ok(tricky.ok && tricky.data.grades[0].note.includes("{批语}"), "braces inside strings survive scanning");
}

/* ---------- 3) 增量合并计划 ---------- */
console.log("planMerge:");
{
  const payload = {
    courseware: [
      { course: "大学物理(Ⅰ)", title: "第3章.pptx", note: "刚体转动" },
      { course: "大学物理(Ⅰ)", title: "第4章.pptx", note: "动量守恒" }
    ],
    assignments: [
      { course: "大学物理(Ⅰ)", name: "课后思考4", due: "2026-10-28", type: "附件+报告", note: "推导" },
      { course: "电机与拖动", name: "课堂练习-3 选择填空", due: "2026-10-20", type: "线上作答", note: "" }
    ],
    grades: [{ course: "电机与拖动", title: "课堂练习-2", note: "95 良好" }]
  };
  const captures = [
    { kind: "课件", course: "大学物理(Ⅰ)", title: "第3章.pptx", note: "" }   // 已存在 → 跳过
  ];
  const items = [
    { id: 1, course: "大学物理(Ⅰ)", name: "课后思考4", due: "2026-10-25", status: "todo" },  // 截止变化 → 更新
    { id: 2, course: "电机与拖动", name: "课堂练习-3 选择填空", due: "2026-10-20", status: "todo" } // 完全一致 → 跳过
  ];
  const plan = SyncKit.planMerge(payload, captures, items);
  ok(plan.capturesToAdd.length === 4, "capture dedupe: 第4章课件 + 成绩 + 两条作业要求（第3章课件已存在被跳过）, got " + plan.capturesToAdd.length);
  ok(plan.capturesToAdd.every(c => c.source === "sync"), "captures tagged source:sync");
  ok(plan.capturesToAdd.some(c => c.kind === "作业要求"), "assignment briefs land as 作业要求 captures");
  ok(plan.itemsToAdd.length === 0, "no new items when both assignments already exist");
  ok(plan.itemsToUpdate.length === 1 && plan.itemsToUpdate[0].id === 1 &&
     plan.itemsToUpdate[0].from === "2026-10-25" && plan.itemsToUpdate[0].to === "2026-10-28",
     "changed due produces one update op with from/to");
  ok(plan.stats.newItems === 0 && plan.stats.updatedItems === 1 && plan.stats.newCaptures === 4, "stats consistent");
}
{
  /* 全新数据：作业建档 + 已提交作业不更新截止 */
  const payload = { courseware: [], grades: [],
    assignments: [
      { course: "工厂供电", name: "第三章作业", due: "2026-11-02", type: "文件上传", note: "" },
      { course: "电机与拖动", name: "课堂练习-3 选择填空", due: "2026-12-01", type: "线上作答", note: "" }
    ] };
  const items = [
    { id: 9, course: "电机与拖动", name: "课堂练习-3 选择填空", due: "2026-10-20", status: "submitted" } // 已提交 → 不动
  ];
  const plan = SyncKit.planMerge(payload, [], items);
  ok(plan.itemsToAdd.length === 1 && plan.itemsToAdd[0].name === "第三章作业" &&
     plan.itemsToAdd[0].status === "todo" && plan.itemsToAdd[0].id === undefined,
     "new assignment becomes a todo item (id assigned by page)");
  ok(plan.itemsToAdd[0].type === "文件上传" && plan.itemsToAdd[0].difficulty === "auto", "new item carries defaults");
  ok(plan.itemsToUpdate.length === 0, "submitted items are never updated");
}
{
  /* 空库冷启动 */
  const plan = SyncKit.planMerge({ courseware: [], assignments: [{ course: "c", name: "n", due: "2026-11-01", type: "文件上传", note: "" }], grades: [] }, [], []);
  ok(plan.itemsToAdd.length === 1 && plan.capturesToAdd.length === 1, "cold start: item + brief both created");
  ok(plan.stats.courseware === 0 && plan.stats.grades === 0, "stats count raw rows");
}

{
  /* 同一批次内同课程同名去重（P2） */
  const payload = { courseware: [], grades: [], assignments: [
    { course: "电路", name: "第一章作业", due: "", type: "文件上传", note: "" },
    { course: "电路", name: "第一章作业", due: "2026-11-05", type: "文件上传", note: "补交" },
    { course: "电路 ", name: " 第一章作业 ", due: "2026-11-05", type: "文件上传", note: "" }
  ] };
  const plan = SyncKit.planMerge(payload, [], []);
  ok(plan.itemsToAdd.length === 1, "same course+name in one batch -> one todo, got " + plan.itemsToAdd.length);
  ok(plan.itemsToAdd[0].due === "2026-11-05", "duplicate row backfills due instead of a second item");
  ok(plan.stats.dupItems === 2, "duplicates counted in stats, got " + plan.stats.dupItems);
  ok(plan.stats.newItems === 1, "newItems counts de-duplicated adds, got " + plan.stats.newItems);
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
