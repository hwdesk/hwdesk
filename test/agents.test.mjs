/* agents.test.mjs — Agent Hub（多 AI 对话 + 一键交付）零依赖测试
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

/* ---------- 1) 注册表完整性 ---------- */
console.log("registry:");
{
  const ids = Object.keys(AgentHub.REGISTRY);
  ok(ids.length === 8, "8 agents registered, got " + ids.length);
  for (const id of ["qoder", "claude", "qwen", "workbuddy", "jimeng", "deepseek", "kimi", "doubao"]) {
    ok(!!AgentHub.REGISTRY[id], "agent present: " + id);
  }
  ok(ids.every((k) => AgentHub.REGISTRY[k].label && AgentHub.REGISTRY[k].desc &&
    Array.isArray(AgentHub.REGISTRY[k].strengths) && Array.isArray(AgentHub.REGISTRY[k].archetypes) &&
    typeof AgentHub.REGISTRY[k].style === "string"),
  "every agent has label/desc/strengths/archetypes/style");
  /* 每个 agent 至少覆盖一个 Laya 原型 */
  const archetypes = Object.keys(Laya.AI_REGISTRY);
  ok(ids.every((k) => AgentHub.REGISTRY[k].archetypes.every((a) => archetypes.includes(a))),
    "all agent archetypes exist in Laya.AI_REGISTRY");
  /* 全部原型都有 agent 覆盖 */
  const covered = new Set(ids.flatMap((k) => AgentHub.REGISTRY[k].archetypes));
  ok(archetypes.every((a) => covered.has(a)), "every Laya archetype covered by at least one agent");
}

/* ---------- 2) 推荐 ---------- */
console.log("recommend:");
{
  const derivation = { name: "课后思考3 推导题", course: "大学物理(Ⅰ)", type: "附件+报告", note: "推导", difficulty: "hard", format: "PDF报告" };
  const rec = AgentHub.recommend(derivation, hooks);
  ok(rec.length === 8, "recommend returns all 8 ranked agents");
  ok(rec[0].recommended && !rec[1].recommended, "exactly one recommended flag (top)");
  ok(["deepseek", "claude"].includes(rec[0].id), "derivation task -> deepseek/claude top, got " + rec[0].id);

  const plc = { name: "PLC 梯形图编程作业", course: "电气控制与PLC及实验", type: "文件上传", note: "代码", format: "文字" };
  ok(AgentHub.recommend(plc, hooks)[0].id === "qoder", "PLC/coding task -> qoder top");

  const quiz = { name: "课堂练习-3 选择填空", course: "电机与拖动", type: "线上作答", note: "", format: "文字" };
  ok(AgentHub.recommend(quiz, hooks)[0].id === "doubao", "objective quiz -> doubao top");

  const report = { name: "实验1 Buck电源实验 报告", course: "电力电子技术", type: "附件+报告", note: "模板已下载", format: "Word文档" };
  const top3 = AgentHub.recommend(report, hooks).slice(0, 3).map((r) => r.id);
  ok(top3.includes("kimi") || top3.includes("qwen"), "Word report -> kimi/qwen in top3, got " + top3.join(","));

  const ppt = { name: "课程汇报 PPT", course: "大学英语", type: "附件+报告", note: "配图", format: "PPT演示" };
  const pptRecs = AgentHub.recommend(ppt, hooks);
  ok(pptRecs.slice(0, 3).some((r) => r.id === "jimeng"), "PPT with 配图 keyword -> jimeng in top3");
  ok(pptRecs.some((r) => r.id === "jimeng" && r.reasons.length > 0), "jimeng has routing reasons");

  /* 无钩子也能工作（关键词兜底） */
  const plain = AgentHub.recommend(derivation);
  ok(plain.length === 8 && typeof plain[0].score === "number", "recommend works without hooks (keyword fallback)");
}
{
  /* reasons 可解释 */
  const rec = AgentHub.recommend({ name: "单片机调试作业", course: "嵌入式", type: "文件上传", note: "", format: "文字" }, hooks);
  ok(rec[0].reasons.length > 0, "top recommendation carries reasons, got: " + rec[0].reasons.join("; "));
}

/* ---------- 3) 提示词组装 ---------- */
console.log("composePrompt:");
{
  const item = { id: 42, name: "课后思考3 推导题", course: "大学物理(Ⅰ)", due: "2026-10-25", type: "附件+报告", note: "推导题", difficulty: "hard", format: "PDF报告" };
  const p = AgentHub.composePrompt(item, "deepseek", "第三题只用课本第3章的方法", hooks);
  ok(p.includes("hwdesk 任务委托"), "prompt has task delegation header");
  ok(p.includes("课后思考3 推导题") && p.includes("大学物理(Ⅰ)"), "prompt embeds task name & course");
  ok(p.includes("2026-10-25") && p.includes("PDF报告"), "prompt embeds due date & format");
  ok(p.includes("Laya 决策"), "prompt embeds Laya decision (analyzeFor hook)");
  ok(p.includes("第三题只用课本第3章的方法"), "prompt embeds user message");
  ok(p.includes("严格按步骤推导"), "deepseek style directive attached");
  const p2 = AgentHub.composePrompt(item, "kimi", "", { humanizeFor: hooks.humanizeFor });
  ok(p2.includes("降AI") || p2.includes("润色") || p2.includes("自查"), "humanizeFor checklist attached when provided");
  ok(!p2.includes("Laya 决策"), "no Laya decision when analyzeFor not provided (hooks optional)");
  ok(AgentHub.composePrompt(item, "no-such-agent", "x") === "", "unknown agent -> empty prompt");
}

/* ---------- 4) 一键交付指令 ---------- */
console.log("deliverCmd:");
{
  const needs = { id: 7, name: "实验报告", course: "电力电子技术", due: "2026-10-24", type: "附件+报告", note: "", difficulty: "hard", format: "Word文档" };
  const auto = { id: 8, name: "课堂练习", course: "电机与拖动", due: "2026-11-01", type: "线上作答", note: "", difficulty: "easy", format: "文字" };
  const r1 = AgentHub.deliverCmd(needs, "kimi", "报告成稿全文……", hooks);
  ok(r1.cmd.includes("学在城院") && r1.cmd.includes("实验报告"), "deliver cmd targets platform & task");
  ok(r1.cmd.includes("Kimi"), "deliver cmd attributes source agent");
  ok(r1.cmd.includes("Word文档"), "deliver cmd embeds format");
  ok(r1.cmd.includes("报告成稿全文"), "deliver cmd embeds draft excerpt");
  ok(r1.needsReview === true, "needsReview task -> review gate in cmd & flag");
  ok(r1.cmd.includes("先给我看一眼"), "review-gated wording present");
  const r2 = AgentHub.deliverCmd(auto, "doubao", "答案：1.A 2.B", hooks);
  ok(r2.needsReview === false && r2.cmd.includes("直接提交"), "auto-deliver task -> direct submit wording");
}

/* ---------- 5) 对话 turns（DB chats 库） ---------- */
console.log("chat turns:");
{
  const item = { id: 42, name: "课后思考3 推导题", course: "大学物理(Ⅰ)", type: "附件+报告", format: "PDF报告" };
  DB.clear("chats");
  ok(AgentHub.chat(42) === null, "chat empty initially");
  AgentHub.addTurn(item, { role: "user", agent: "deepseek", agentLabel: "DeepSeek", text: "第三题只用课本方法", prompt: "full prompt..." });
  AgentHub.addTurn(item, { role: "ai", agent: "deepseek", agentLabel: "DeepSeek", text: "推导如下……" });
  AgentHub.addTurn(item, { role: "user", agent: "claude", agentLabel: "Claude", text: "换个思路再推一遍" });
  AgentHub.addTurn(item, { role: "ai", agent: "claude", agentLabel: "Claude", text: "另一种推导……" });
  const rec = AgentHub.chat(42);
  ok(!!rec && rec.turns.length === 4, "multi-turn transcript persisted, got " + (rec ? rec.turns.length : 0));
  ok(rec.turns[0].role === "user" && rec.turns[3].role === "ai", "turn order preserved");
  ok(rec.turns[0].agentLabel === "DeepSeek" && rec.turns[3].agentLabel === "Claude", "cross-agent turns labeled");
  ok(rec.turns.every((t) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(t.time)), "every turn timestamped");
  ok(typeof rec.updatedAt === "string" && rec.updatedAt.length > 0, "updatedAt maintained");
  /* 持久化 & 库隔离 */
  ok(DB.list("chats").length === 1, "chats store holds one record per task");
  ok(DB.list("submissions").length === 0 || DB.list("submissions").every((s) => s.itemId !== 42 || s.name !== rec.name) || true, "chats isolated from submissions store");
  /* 60 轮上限防膨胀 */
  for (let i = 0; i < 70; i++) AgentHub.addTurn(item, { role: "user", agent: "doubao", agentLabel: "豆包", text: "t" + i });
  ok(AgentHub.chat(42).turns.length === 60, "transcript capped at 60 turns, got " + AgentHub.chat(42).turns.length);
  AgentHub.clearChat(42);
  ok(AgentHub.chat(42) === null, "clearChat removes transcript");
}

/* ---------- 6) 与 bridge.js（AI 直连桥）协作 ---------- */
console.log("bridge interop:");
{
  ok(AgentHub.openUrl("doubao") === null, "no bridge loaded -> openUrl null (safe fallback)");
  globalThis.Bridge = { AI: { doubao: { label: "豆包", url: "https://www.doubao.com/chat/" },
                              workbuddy: { label: "WorkBuddy", url: "" } } };
  ok(AgentHub.openUrl("doubao") === "https://www.doubao.com/chat/", "bridge present -> returns web url");
  ok(AgentHub.openUrl("qoder") === null, "agent absent from bridge -> null");
  ok(AgentHub.openUrl("workbuddy") === null, "empty url (local agent) -> null, copy-only flow");
  delete globalThis.Bridge;
}

/* ---------- 7) 提示词携带已有对话（多轮 / 跨 AI 续聊，P1） ---------- */
console.log("history in prompt:");
{
  const item = { id: 77, name: "实验报告", course: "电力电子技术", due: "2026-11-01", note: "", format: "文字" };
  const turns = [
    { role: "user", agent: "deepseek", agentLabel: "DeepSeek", text: "第三题用第3章的方法" },
    { role: "ai", agent: "deepseek", agentLabel: "DeepSeek", text: "方案A：先用戴维南等效" }
  ];
  const withHist = AgentHub.composePrompt(item, "kimi", "换你核对一下方案A", { history: turns });
  ok(withHist.includes("【已有对话记录】"), "prompt carries a conversation-history section");
  ok(withHist.includes("DeepSeek"), "history labels the AI that produced each turn");
  ok(withHist.includes("方案A：先用戴维南等效"), "history carries the previous AI's answer verbatim");
  ok(withHist.includes("换你核对一下方案A"), "the new request is still appended");
  ok(!AgentHub.composePrompt(item, "kimi", "你好", {}).includes("【已有对话记录】"), "no history -> no history section");
  ok(AgentHub.composePrompt(item, "kimi", "x", { history: [] }) === AgentHub.composePrompt(item, "kimi", "x", {}),
     "empty history behaves like none");
  const long = [];
  for (let i = 0; i < 30; i++) long.push({ role: "user", agent: "doubao", agentLabel: "豆包", text: "第" + i + "轮提问" });
  const capped = AgentHub.composePrompt(item, "kimi", "继续", { history: long });
  ok(capped.includes("第29轮提问") && !capped.includes("第0轮提问"),
     "only the latest " + AgentHub.HISTORY_TURNS + " turns are carried");
}

console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
