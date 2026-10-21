/*
 * Laya 决策引擎测试（零依赖，Node >= 16）
 * 运行：node test/laya.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(__dirname, "..", "laya.js"), "utf8");
(0, eval)(src); // 间接 eval：在全局作用域执行，挂载 globalThis.Laya
const Laya = globalThis.Laya;

const NOW = new Date(2026, 9, 21); // 2026-10-21（本地时间）
function due(offset) {
  const t = new Date(NOW);
  t.setDate(t.getDate() + offset);
  return t.toISOString().slice(0, 10);
}
function item(over) {
  return Object.assign(
    { id: 1, name: "", course: "其他", due: due(3), type: "文件上传", note: "", status: "todo", difficulty: "auto" },
    over
  );
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
}

console.log("laya.js " + Laya.VERSION + " | tests with fixed now = 2026-10-21");

/* ---------- score：紧急度 ---------- */
test("urgency: overdue -> level 3", () => {
  const u = Laya.urgency(item({ due: due(-2) }), NOW);
  assert.equal(u.level, 3);
  assert.ok(u.label.indexOf("逾期") !== -1);
});
test("urgency: due today -> level 3", () => {
  assert.equal(Laya.urgency(item({ due: due(0) }), NOW).level, 3);
});
test("urgency: 3 days left -> level 2", () => {
  assert.equal(Laya.urgency(item({ due: due(2) }), NOW).level, 2);
});
test("urgency: >7 days -> level 0", () => {
  assert.equal(Laya.urgency(item({ due: due(10) }), NOW).level, 0);
});
test("urgency: no deadline -> level 0, daysLeft null", () => {
  const u = Laya.urgency(item({ due: "" }), NOW);
  assert.equal(u.level, 0);
  assert.equal(u.daysLeft, null);
});

/* ---------- score：复杂度 ---------- */
test("complexity: report + derivation note >= 4", () => {
  const c = Laya.complexity(item({ type: "附件+报告", name: "课后思考3", note: "推导题，可让AI先做草稿" }));
  assert.ok(c.level >= 4, "level=" + c.level);
});
test("complexity: online quiz stays low", () => {
  const c = Laya.complexity(item({ type: "线上作答", name: "课堂练习", note: "" }));
  assert.ok(c.level <= 2, "level=" + c.level);
});
test("complexity: manual difficulty anchor lifts level", () => {
  const c = Laya.complexity(item({ type: "线上作答", name: "课堂练习", difficulty: "hard" }));
  assert.ok(c.level >= 3, "level=" + c.level);
  assert.equal(c.confidence, 0.92); // 显式指定最可信
});
test("complexity: clamped to 1..5", () => {
  const c = Laya.complexity(item({ type: "附件+报告", note: "推导 证明 建模 仿真 课程设计" }));
  assert.equal(c.level, 5);
});

/* ---------- choice：AI 路由 ---------- */
test("route: derivation note -> reasoner", () => {
  const r = Laya.routeAI(item({ name: "课后思考3", note: "推导题", course: "大学物理(Ⅰ)" }));
  assert.equal(r.ai, "reasoner");
});
test("route: embedded course -> coder", () => {
  const r = Laya.routeAI(item({ name: "实验1", course: "嵌入式系统设计", note: "代码 调试" }));
  assert.equal(r.ai, "coder");
});
test("route: online quiz -> fastsolver", () => {
  const r = Laya.routeAI(item({ type: "线上作答", name: "课堂练习-3", note: "选择 填空" }));
  assert.equal(r.ai, "fastsolver");
});
test("route: report writing -> writer", () => {
  const r = Laya.routeAI(item({ type: "附件+报告", name: "实验报告", note: "总结实验现象" }));
  assert.equal(r.ai, "writer");
});
test("route: probabilities sum to 1", () => {
  const r = Laya.routeAI(item({}));
  const sum = Object.values(r.probs).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, "sum=" + sum);
});

/* ---------- noul：学生自查 ---------- */
test("review: complex report needs review", () => {
  const d = Laya.analyze(item({ type: "附件+报告", name: "实验报告", note: "建模分析", due: due(5) }), NOW);
  assert.equal(d.review.needed, true);
  assert.equal(d.autoDeliver, false);
});
test("review: simple online quiz auto-delivers", () => {
  const d = Laya.analyze(item({ type: "线上作答", name: "课堂练习", note: "选择 填空", due: due(2) }), NOW);
  assert.equal(d.review.needed, false);
  assert.equal(d.autoDeliver, true);
});
test("review: ambiguous routing escalates (act threshold)", () => {
  // 无关键词、无课程先验：路由置信度应低于阈值并升级学生自查
  const r = Laya.routeAI(item({ name: "任务", course: "其他", note: "", type: "文件上传" }));
  assert.ok(r.confidence < Laya.ACT_THRESHOLD, "conf=" + r.confidence);
  const d = Laya.analyze(item({ name: "任务", course: "其他", note: "", type: "文件上传" }), NOW);
  assert.equal(d.review.needed, true);
});

/* ---------- 综合优先级与排序 ---------- */
test("priority: overdue outranks far-future complex task", () => {
  const overdue = Laya.analyze(item({ name: "第二章作业", due: due(-1), type: "文件上传" }), NOW);
  const later = Laya.analyze(item({ name: "大作业", due: due(9), type: "附件+报告", note: "推导" }), NOW);
  assert.ok(overdue.priority > later.priority, overdue.priority + " vs " + later.priority);
});
test("rank: sorted by priority desc, todo only", () => {
  const ranked = Laya.rank([
    item({ id: 1, name: "far", due: due(9) }),
    item({ id: 2, name: "overdue", due: due(-1) }),
    item({ id: 3, name: "today", due: due(0) }),
    item({ id: 4, name: "done", due: due(-1), status: "submitted" }),
  ], NOW);
  assert.equal(ranked.length, 3);
  assert.ok(ranked[0].priority >= ranked[1].priority);
  assert.ok(ranked[1].priority >= ranked[2].priority);
  assert.equal(ranked[0].item.name, "overdue");
});

/* ---------- 执行计划与自动交付编排 ---------- */
test("plan: instruction maps task -> AI in priority order", () => {
  const plan = Laya.buildPlan([
    item({ id: 1, name: "第二章作业", course: "电气控制与PLC及实验", due: due(-1), type: "文件上传", note: "" }),
    item({ id: 2, name: "课后思考3", course: "大学物理(Ⅰ)", due: due(3), type: "附件+报告", note: "推导题" }),
    item({ id: 3, name: "课堂练习", course: "电机与拖动", due: due(2), type: "线上作答", note: "选择 填空" }),
  ], NOW);
  assert.ok(plan.queue.length === 3);
  assert.ok(plan.instruction.indexOf("第二章作业") < plan.instruction.indexOf("课后思考3"));
  assert.ok(plan.instruction.indexOf("AI") !== -1);
  assert.ok(plan.instruction.indexOf("自动交付") !== -1);
  // 复杂报告必须出现在"等我本人审核"分组
  assert.ok(plan.instruction.indexOf("等我本人审核") !== -1);
  assert.ok(plan.reviewCount >= 1);
});
test("plan: empty todo -> empty instruction", () => {
  const plan = Laya.buildPlan([item({ status: "submitted" })], NOW);
  assert.equal(plan.queue.length, 0);
  assert.equal(plan.instruction, "");
});

/* ---------- 数据迁移（旧 localStorage 数据缺字段） ---------- */
test("migration: legacy item without difficulty/type fields works", () => {
  const d = Laya.analyze({ id: 9, name: "旧数据", course: "其他", due: due(1), note: "" }, NOW);
  assert.ok(d.priority >= 0 && d.priority <= 100);
  assert.ok(d.route.ai);
});

console.log(passed + " passed, " + (process.exitCode ? "FAILED" : "0 failed"));
