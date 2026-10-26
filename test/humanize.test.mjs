/*
 * humanize.js / ContextKit 测试（零依赖，Node >= 16）
 * 运行：node test/humanize.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

// 顺序加载 laya.js（Humanize.levelFor 会用到 Laya.complexity）与 humanize.js
(0, eval)(readFileSync(path.join(root, "laya.js"), "utf8"));
(0, eval)(readFileSync(path.join(root, "humanize.js"), "utf8"));

const Laya = globalThis.Laya;
const Humanize = globalThis.Humanize;
const ContextKit = globalThis.ContextKit;

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
function base(over) {
  return Object.assign(
    { id: 1, name: "作业", course: "电力电子技术", due: "2026-10-31", type: "附件+报告",
      note: "", status: "todo", difficulty: "auto", format: "Word文档" },
    over
  );
}

console.log("humanize.js " + Humanize.VERSION + " | ContextKit " + ContextKit.VERSION);

/* ---------- Humanize.risk：AI 检测风险评估 ---------- */
const aiText =
  "综上所述，在当今科技迅猛发展的时代背景下，电力电子技术无疑起着重要的作用。" +
  "首先，随着半导体器件的快速发展，变换器效率不断提升。其次，控制策略持续优化。" +
  "最后，值得注意的是，研究成果不断涌现，展望未来前景广阔。";
const humanText =
  "我先按照讲义把占空比调到0.4，测出来输出电压是11.8V，比算的12V低了0.2，估计是二极管压降没算进去。" +
  "后来把探头换成10X档，波形毛刺少了不少，这一版数据我用的是第三次测的。课本第3章那张图我一开始看漏了，绕了挺久。";

test("risk: cliché-heavy uniform text scores high", () => {
  const r = Humanize.risk(aiText);
  assert.ok(r.hits.length >= 3, "hits=" + JSON.stringify(r.hits));
  assert.ok(r.uniformPenalty > 0, "uniformPenalty=" + r.uniformPenalty);
  assert.ok(r.score >= 60, "score=" + r.score + " label=" + r.label);
});
test("risk: natural varied student text scores low", () => {
  const r = Humanize.risk(humanText);
  assert.ok(r.score < 30, "score=" + r.score + " label=" + r.label);
  assert.equal(r.hits.length, 0);
});
test("risk: empty text returns null", () => {
  assert.equal(Humanize.risk(""), null);
  assert.equal(Humanize.risk("   "), null);
});
test("risk: detection risk sorts AI text above human text", () => {
  assert.ok(Humanize.risk(aiText).score > Humanize.risk(humanText).score);
});

/* ---------- Humanize.levelFor：按交付格式决定润色强度 ---------- */
test("level: Word / PPT / PDF -> strict", () => {
  ["Word文档", "PPT演示", "PDF报告"].forEach((f) => {
    assert.equal(Humanize.levelFor(base({ format: f })).level, "strict", f);
  });
});
test("level: report-type plain text -> strict", () => {
  assert.equal(Humanize.levelFor(base({ type: "附件+报告", format: "文字" })).level, "strict");
});
test("level: simple online quiz -> off", () => {
  const q = base({ type: "线上作答", format: "文字", name: "课堂练习", note: "选择 填空" });
  assert.equal(Humanize.levelFor(q).level, "off");
});
test("level: complex online answer -> light", () => {
  const q = base({ type: "线上作答", format: "文字", note: "推导受控源工作原理", difficulty: "hard" });
  assert.equal(Humanize.levelFor(q).level, "light");
});
test("level: missing format migrates to 文字", () => {
  assert.equal(Humanize.levelFor({ type: "文件上传", note: "" }).format, "文字");
});

/* ---------- Humanize.directives / checklist ---------- */
test("directives: strict level includes blacklist + first-person rules", () => {
  const ds = Humanize.directives(base({ format: "Word文档" }));
  assert.ok(ds.length >= 4);
  assert.ok(ds.some((d) => d.indexOf("驳回") >= 0 || d.indexOf("套话") >= 0), JSON.stringify(ds));
  assert.ok(ds.some((d) => d.indexOf("第一人称") >= 0 || d.indexOf("先测") >= 0));
});
test("directives: PPT gets spoken-slide rules", () => {
  const ds = Humanize.directives(base({ format: "PPT演示" }));
  assert.ok(ds.some((d) => d.indexOf("讲稿") >= 0 || d.indexOf("备注") >= 0));
});
test("directives: off level returns none", () => {
  const off = base({ type: "线上作答", format: "文字", note: "选择 填空" });
  assert.equal(Humanize.directives(off).length, 0);
  assert.equal(Humanize.checklist(off), "");
});
test("checklist: includes format header and audit line", () => {
  const cl = Humanize.checklist(base({ format: "Word文档" }));
  assert.ok(cl.indexOf("去AI化要求") !== -1);
  assert.ok(cl.indexOf("Word文档") !== -1);
  assert.ok(cl.indexOf("交付前自查") !== -1);
  assert.ok(cl.indexOf("30%") !== -1);
});

/* ---------- ContextKit.pack：上下文摄取 ---------- */
const items = [
  base({ id: 1, name: "实验1 报告", status: "submitted" }),
  base({ id: 2, name: "实验2 报告", course: "电机与拖动", status: "submitted" }),
  base({ id: 3, name: "实验3 报告", status: "todo" }),
];
const materials = [
  { id: 11, kind: "课件", course: "电力电子技术", title: "第3章 Buck变换器", note: "开关频率取20kHz" },
  { id: 12, kind: "作业要求", course: "通用", title: "报告格式要求", note: "需含误差分析" },
  { id: 13, kind: "课件", course: "电机与拖动", title: "直流电机拖动", note: "" },
];

test("context: packs same-course materials + global materials", () => {
  const p = ContextKit.pack(base({ id: 3 }), items, materials);
  assert.equal(p.materialCount, 2);
  assert.ok(p.brief.indexOf("第3章 Buck变换器") !== -1);
  assert.ok(p.brief.indexOf("报告格式要求") !== -1);
});
test("context: packs same-course submitted history as style anchor", () => {
  const p = ContextKit.pack(base({ id: 3 }), items, materials);
  assert.equal(p.historyCount, 1);
  assert.ok(p.brief.indexOf("实验1 报告") !== -1);
  assert.ok(p.brief.indexOf("实验2 报告") === -1, "other course history excluded");
});
test("context: excludes own entry from history", () => {
  const p = ContextKit.pack(base({ id: 1, status: "todo" }), items, materials);
  assert.ok(p.brief.indexOf("实验1 报告") === -1);
});
test("context: empty when no material and no history", () => {
  const p = ContextKit.pack(base({ id: 3, course: "大学物理(Ⅰ)" }), [], []);
  assert.equal(p.brief, "");
  assert.equal(p.historyCount, 0);
  assert.equal(p.materialCount, 0);
});
test("context: brief tells AI to ground on courseware", () => {
  const p = ContextKit.pack(base({ id: 3 }), items, materials);
  assert.ok(p.brief.indexOf("不要凭通用知识自由发挥") !== -1);
});

/* ---------- buildPlan 集成：上下文 + 去AI化钩子 ---------- */
test("plan: hooks embed context brief and humanization checklist", () => {
  const opts = {
    contextFor: (item) => ContextKit.pack(item, items, materials).brief,
    humanizeFor: (item) => Humanize.checklist(item),
  };
  const plan = Laya.buildPlan([base({ id: 3 })], null, opts);
  assert.ok(plan.instruction.indexOf("上下文参考") !== -1);
  assert.ok(plan.instruction.indexOf("去AI化要求") !== -1);
  assert.ok(plan.instruction.indexOf("第3章 Buck变换器") !== -1);
  assert.ok(plan.instruction.indexOf("交付前自查") !== -1);
});
test("plan: without hooks the instruction stays unchanged in structure", () => {
  const plan = Laya.buildPlan([base({ id: 3 })], null);
  assert.ok(plan.instruction.indexOf("去AI化要求") === -1);
  assert.ok(plan.instruction.indexOf("上下文参考") === -1);
  assert.ok(plan.instruction.indexOf("自动交付") !== -1);
});
test("plan: deliverable format appears in each task line", () => {
  const plan = Laya.buildPlan([base({ id: 3, format: "PPT演示" })], null);
  assert.ok(plan.instruction.indexOf("交付格式PPT演示") !== -1);
});

/* ---------- 路由注册表新增润色档 ---------- */
test("routing: polisher AI exists and can be routed to", () => {
  assert.ok(Laya.AI_REGISTRY.polisher);
  const r = Laya.routeAI(base({ name: "报告润色", note: "润色 改写 降AI率" }));
  assert.equal(r.ai, "polisher");
});

/* ---------- ContextKit 预算与优先级（#59） ---------- */
test("context: brief stays within the budget even with a huge course memory", () => {
  const manyMats = [];
  for (let i = 0; i < 300; i++) manyMats.push({ kind: "课件", course: "电力电子技术", title: "课件" + i, note: "x".repeat(400) });
  const p = ContextKit.pack(base({ id: 3 }), [], manyMats);
  assert.ok(p.materialCount === 300, "all materials counted");
  assert.ok(p.brief.length <= ContextKit.BRIEF_LIMIT + 40, "brief length " + p.brief.length);
  assert.ok(p.brief.indexOf("课件11") !== -1, "first materials shown");
  assert.ok(p.brief.indexOf("课件299") === -1, "later materials omitted");
});
test("context: course materials come before history, general materials last", () => {
  const mats = [
    { kind: "范文", course: "通用", title: "通用范文" },
    { kind: "课件", course: "电力电子技术", title: "本课课件" },
  ];
  const hist = [{ id: 9, name: "历史作业", course: "电力电子技术", status: "submitted", type: "附件+报告" }];
  const p = ContextKit.pack(base({ id: 3 }), hist, mats);
  const iCourse = p.brief.indexOf("本课课件");
  const iHist = p.brief.indexOf("历史作业");
  const iGeneral = p.brief.indexOf("通用范文");
  assert.ok(iCourse !== -1 && iHist !== -1 && iGeneral !== -1);
  assert.ok(iCourse < iHist && iHist < iGeneral, "priority order");
});
test("context: long notes are truncated per entry", () => {
  const p = ContextKit.pack(base({ id: 3 }), [],
    [{ kind: "课件", course: "电力电子技术", title: "T", note: "y".repeat(500) }]);
  assert.ok(p.brief.indexOf("y".repeat(200)) === -1, "note capped at NOTE_LIMIT");
});

console.log(passed + " passed, " + (process.exitCode ? "FAILED" : "0 failed"));
