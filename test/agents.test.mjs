/* agents.test.mjs — Agent Hub（唯一 Agent：Qoder CLI · 对话 + 一键交付）零依赖测试
 * 运行：node test/agents.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
for (const f of ["../db.js", "../laya.js", "../humanize.js", "../agents.js"]) {
  const code = readFileSync(join(dir, f), "utf8");
  new Function(code)();          // 各引擎 UMD-lite 挂 globalThis
}

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("  FAIL - " + name); }
}

const AgentHub = globalThis.AgentHub;
const Laya = globalThis.Laya;
const DB = globalThis.DB;

/* 页面同款钩子 */
const hooks = {
  routeFor: (item) => Laya.routeAI(item),
  analyzeFor: (item) => Laya.analyze(item),
  humanizeFor: (item) => globalThis.Humanize.checklist(item)
};

console.log("AgentHub:", AgentHub.VERSION);

/* ---------- 1) 注册表：收敛为唯一 Qoder CLI ---------- */
console.log("registry:");
{
  const ids = Object.keys(AgentHub.REGISTRY);
  ok(ids.length === 1 && ids[0] === "qoder", "registry collapsed to the single qoder agent");
  const ag = AgentHub.REGISTRY.qoder;
  ok(!!(ag.label && ag.desc && Array.isArray(ag.strengths) &&
    Array.isArray(ag.archetypes) && typeof ag.style === "string"),
    "qoder has label/desc/strengths/archetypes/style");
  /* 全部 Laya 原型都由唯一 Agent 承接 */
  const archetypes = Object.keys(Laya.AI_REGISTRY);
  ok(archetypes.every((a) => ag.archetypes.includes(a)),
    "every Laya archetype covered by qoder");
}

/* ---------- 2) 推荐（恒推荐唯一 Agent，但逻辑保持可解释） ---------- */
console.log("recommend:");
{
  const tasks = [
    { name: "课后思考3 推导题", course: "大学物理(Ⅰ)", type: "附件+报告", note: "推导", difficulty: "hard", format: "PDF报告" },
    { name: "PLC 梯形图编程作业", course: "电气控制与PLC及实验", type: "文件上传", note: "代码", format: "文字" },
    { name: "课堂练习-3 选择填空", course: "电机与拖动", type: "线上作答", note: "", format: "文字" }
  ];
  for (const t of tasks) {
    const rec = AgentHub.recommend(t, hooks);
    ok(rec.length === 1 && rec[0].id === "qoder" && rec[0].recommended,
      "recommend -> qoder for " + t.name);
  }
  const rec = AgentHub.recommend(tasks[1], hooks);
  ok(rec[0].reasons.length > 0, "top recommendation carries reasons: " + rec[0].reasons.join("; "));
  const plain = AgentHub.recommend(tasks[0]);
  ok(plain.length === 1 && typeof plain[0].score === "number", "recommend works without hooks");
}

/* ---------- 3) 提示词组装 ---------- */
console.log("composePrompt:");
{
  const item = { id: 42, name: "课后思考3 推导题", course: "大学物理(Ⅰ)", due: "2026-10-25", type: "附件+报告", note: "推导题", difficulty: "hard", format: "PDF报告" };
  const p = AgentHub.composePrompt(item, "qoder", "第三题只用课本第3章的方法", hooks);
  ok(p.includes("hwdesk 任务委托"), "prompt has task delegation header");
  ok(p.includes("课后思考3 推导题") && p.includes("大学物理(Ⅰ)"), "prompt embeds task name & course");
  ok(p.includes("2026-10-25") && p.includes("PDF报告"), "prompt embeds due date & format");
  ok(p.includes("Laya 决策"), "prompt embeds Laya decision (analyzeFor hook)");
  ok(p.includes("第三题只用课本第3章的方法"), "prompt embeds user message");
  ok(p.includes("执行 Agent"), "qoder style directive attached");
  const p2 = AgentHub.composePrompt(item, "qoder", "", { humanizeFor: hooks.humanizeFor });
  ok(p2.includes("降AI") || p2.includes("润色") || p2.includes("自查"), "humanizeFor checklist attached when provided");
  ok(!p2.includes("Laya 决策"), "no Laya decision when analyzeFor not provided (hooks optional)");
  ok(AgentHub.composePrompt(item, "no-such-agent", "x") === "", "unknown agent -> empty prompt");
}

/* ---------- 4) 一键交付指令 ---------- */
console.log("deliverCmd:");
{
  const needs = { id: 7, name: "实验报告", course: "电力电子技术", due: "2026-10-24", type: "附件+报告", note: "", difficulty: "hard", format: "Word文档" };
  const auto = { id: 8, name: "课堂练习", course: "电机与拖动", due: "2026-11-01", type: "线上作答", note: "", difficulty: "easy", format: "文字" };
  const r1 = AgentHub.deliverCmd(needs, "qoder", "报告成稿全文……", hooks);
  ok(r1.cmd.includes("学在城院") && r1.cmd.includes("实验报告"), "deliver cmd targets platform & task");
  ok(r1.cmd.includes("Qoder CLI"), "deliver cmd attributes source agent");
  ok(r1.cmd.includes("Word文档"), "deliver cmd embeds format");
  ok(r1.cmd.includes("报告成稿全文"), "deliver cmd embeds draft excerpt");
  ok(r1.needsReview === true, "needsReview task -> review gate in cmd & flag");
  ok(r1.cmd.includes("先给我看一眼"), "review-gated wording present");
  const r2 = AgentHub.deliverCmd(auto, "qoder", "答案：1.A 2.B", hooks);
  ok(r2.needsReview === false && r2.cmd.includes("直接提交"), "auto-deliver task -> direct submit wording");
}

/* ---------- 5) 对话 turns（DB chats 库） ---------- */
console.log("chat turns:");
{
  const item = { id: 42, name: "课后思考3 推导题", course: "大学物理(Ⅰ)", type: "附件+报告", format: "PDF报告" };
  DB.clear("chats");
  ok(AgentHub.chat(42) === null, "chat empty initially");
  AgentHub.addTurn(item, { role: "user", agent: "qoder", agentLabel: "Qoder CLI", text: "先给思路", prompt: "full prompt..." });
  AgentHub.addTurn(item, { role: "ai", agent: "qoder", agentLabel: "Qoder CLI", text: "推导如下……" });
  const rec = AgentHub.chat(42);
  ok(!!rec && rec.turns.length === 2, "multi-turn transcript persisted, got " + (rec ? rec.turns.length : 0));
  ok(rec.turns[0].role === "user" && rec.turns[1].role === "ai", "turn order preserved");
  ok(rec.turns.every((t) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t.time)), "every turn timestamped");
  ok(typeof rec.updatedAt === "string" && rec.updatedAt.length > 0, "updatedAt maintained");
  /* 60 轮上限防膨胀 */
  for (let i = 0; i < 70; i++) AgentHub.addTurn(item, { role: "user", agent: "qoder", agentLabel: "Qoder CLI", text: "t" + i });
  ok(AgentHub.chat(42).turns.length === 60, "transcript capped at 60 turns, got " + AgentHub.chat(42).turns.length);
  AgentHub.clearChat(42);
  ok(AgentHub.chat(42) === null, "clearChat removes transcript");
}

/* ---------- 6) 与 bridge.js（唯一 Agent 桥）协作 ---------- */
console.log("bridge interop:");
{
  ok(AgentHub.openUrl("qoder") === null, "no bridge loaded -> openUrl null (safe fallback)");
  globalThis.Bridge = { AI: { qoder: { label: "Qoder CLI（本机）", url: "" } } };
  ok(AgentHub.openUrl("qoder") === null, "empty url (local agent) -> null, copy-only flow");
  delete globalThis.Bridge;
}

/* ---------- 7) 提示词携带已有对话（多轮续聊） ---------- */
console.log("history in prompt:");
{
  const item = { id: 77, name: "实验报告", course: "电力电子技术", due: "2026-11-01", note: "", format: "文字" };
  const turns = [
    { role: "user", agent: "qoder", agentLabel: "Qoder CLI", text: "第三题用第3章的方法" },
    { role: "ai", agent: "qoder", agentLabel: "Qoder CLI", text: "方案A：先用戴维南等效" }
  ];
  const withHist = AgentHub.composePrompt(item, "qoder", "核对一下方案A", { history: turns });
  ok(withHist.includes("【已有对话记录】"), "prompt carries a conversation-history section");
  ok(withHist.includes("Qoder CLI"), "history labels the agent that produced each turn");
  ok(withHist.includes("方案A：先用戴维南等效"), "history carries the previous answer verbatim");
  ok(withHist.includes("核对一下方案A"), "the new request is still appended");
  ok(!AgentHub.composePrompt(item, "qoder", "你好", {}).includes("【已有对话记录】"), "no history -> no history section");
  ok(AgentHub.composePrompt(item, "qoder", "x", { history: [] }) === AgentHub.composePrompt(item, "qoder", "x", {}),
     "empty history behaves like none");
  const long = [];
  for (let i = 0; i < 30; i++) long.push({ role: "user", agent: "qoder", agentLabel: "Qoder CLI", text: "第" + i + "轮提问" });
  const capped = AgentHub.composePrompt(item, "qoder", "继续", { history: long });
  ok(capped.includes("第29轮提问") && !capped.includes("第0轮提问"),
     "only the latest " + AgentHub.HISTORY_TURNS + " turns are carried");
}

/* ---------- 8) 我的默认 Agent（唯一 Agent 语义下恒为 qoder） ---------- */
console.log("default agent:");
{
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };
  try {
    ok(AgentHub.getDefault() === "", "no default initially");
    AgentHub.setDefault("qoder");
    ok(AgentHub.getDefault() === "qoder", "setDefault persists the choice");
    AgentHub.setDefault("nope");
    ok(AgentHub.getDefault() === "qoder", "invalid id is ignored (keeps previous)");
    AgentHub.setDefault("");
    ok(AgentHub.getDefault() === "", "empty string clears the default");
    AgentHub.setDefault("qoder");
    const raw = localStorage.getItem("wb_hwdesk_default_agent");
    ok(raw === "qoder", "stored under wb_hwdesk_default_agent");
  } finally {
    delete globalThis.localStorage;   // 恢复无 LS 环境，不影响其他用例
  }
}
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
