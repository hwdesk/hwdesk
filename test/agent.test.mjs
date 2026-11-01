/*
 * agent.js 2.0.0 作业内嵌 Agent 对话测试（唯一 Agent：Qoder CLI；零依赖，Node >= 16）
 * 运行：node test/agent.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
(0, eval)(readFileSync(path.join(root, "agent.js"), "utf8"));
const Agent = globalThis.Agent;

/* 最小 localStorage 桩 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    failed++;
    console.error("  FAIL - " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    failed++;
    console.error("  FAIL - " + name + "\n    " + e.message);
    process.exitCode = 1;
  }
}

console.log("agent.js " + Agent.version + " | 唯一 Agent：Qoder CLI（本机桥 /agent/qoder）");

/* ---------- 旧通道确实删干净了 ---------- */
test("2.0.0：API 预设 / 分层降级 / 凭据发现全部移除", () => {
  for (const gone of ["PRESETS", "PRESET_ORDER", "probeLayers", "autoSelect",
    "usablePresets", "applyPreset", "setKey", "needsKey", "matchPreset",
    "applyDiscovered", "pickLocalCandidate", "autoAdoptLocal", "config"]) {
    assert.ok(!(gone in Agent), "Agent." + gone + " 应已删除");
  }
});

/* ---------- 本机桥定位 ---------- */
test("bridgeRoot：同源 8765 直接用，其余回退 http://127.0.0.1:8765", () => {
  globalThis.location = { origin: "http://127.0.0.1:8765" };
  assert.equal(Agent.bridgeRoot(), "http://127.0.0.1:8765");
  globalThis.location = { origin: "http://localhost:8765" };
  assert.equal(Agent.bridgeRoot(), "http://localhost:8765");
  globalThis.location = { origin: "https://hwdesk.example.com" };
  assert.equal(Agent.bridgeRoot(), "http://127.0.0.1:8765");
  delete globalThis.location;
  assert.equal(Agent.bridgeRoot(), "http://127.0.0.1:8765");
});

test("ready() 恒真（零配置；真实可用性在发送/检测时确认）", () => {
  assert.equal(Agent.ready(), true);
});

/* ---------- Qoder 状态检测 ---------- */
await testAsync("qoderStatus：桥回 ok → 透传 status", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, entry: "qoderclicn.exe", model: "Qwen3.8-Flash" }) };
  };
  globalThis.AbortController = class { constructor(){ this.signal = {}; } abort(){} };
  const r = await Agent.qoderStatus(1000);
  assert.equal(r.ok, true);
  assert.equal(r.model, "Qwen3.8-Flash");
  assert.match(calls[0].url, /\/agent\/qoder\/status$/);
});

await testAsync("qoderStatus：403 → 本机-only 提示", async () => {
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ ok: false, error: "local-only" }) });
  const r = await Agent.qoderStatus(1000);
  assert.equal(r.ok, false);
  assert.match(r.error, /只对本机页面开放/);
});

await testAsync("qoderStatus：网络异常 → 人话指引", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  const r = await Agent.qoderStatus(1000);
  assert.equal(r.ok, false);
  assert.match(r.error, /syncserver/);
});

/* ---------- askQoder ---------- */
await testAsync("askQoder：POST messages → 成功取 output", async () => {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, json: async () => ({ ok: true, output: "收到", model: "Qwen3.8-Flash" }) };
  };
  const r = await Agent.askQoder([{ role: "system", content: "s" }, { role: "user", content: "hi" }]);
  assert.equal(r.output, "收到");
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body.messages.map(m => m.role), ["system", "user"]);
  assert.equal(calls[0].opts.method, "POST");
});

await testAsync("askQoder：桥回业务错误 → reject 结构化错误", async () => {
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: "Qoder CLI 正在处理上一条请求，请稍候再发" }) });
  await assert.rejects(
    () => Agent.askQoder([{ role: "user", content: "x" }]),
    (e) => e.code === "qoder_error" && /上一条请求/.test(e.message)
  );
});

await testAsync("askQoder：桥不可达 → network 错误带修复指引", async () => {
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(
    () => Agent.askQoder([{ role: "user", content: "x" }]),
    (e) => e.code === "network" && /syncserver/.test(e.message)
  );
});

/* ---------- 聊天历史（按作业 ID 分库） ---------- */
test("loadChat 缺省返回空会话；saveChat/loadChat 往返一致", () => {
  store.clear();
  const c = Agent.loadChat(42);
  assert.deepEqual(c, { system: "", messages: [] });
  c.system = "sys";
  c.messages.push({ role: "user", content: "q" }, { role: "assistant", content: "a" });
  Agent.saveChat(42, c);
  const back = Agent.loadChat(42);
  assert.equal(back.system, "sys");
  assert.equal(back.messages.length, 2);
  assert.equal(Agent.loadChat(43).messages.length, 0);   // 分库互不串
});
test("clearChat 清空指定作业，不动别家", () => {
  Agent.clearChat(42);
  assert.equal(Agent.loadChat(42).messages.length, 0);
  assert.equal(Agent.loadChat(43).messages.length, 0);
});

/* ---------- 系统提示词 ---------- */
test("buildSystemPrompt：任务卡 + 路由 + 上下文 + 交付规则", () => {
  const s = Agent.buildSystemPrompt(
    { name: "PLC 实验", course: "电气控制", due: "2026-11-05", format: "Word", note: "要实验报告" },
    {
      decision: { route: { label: "编程实操", confidence: 0.82 }, review: { needed: true } },
      contextBrief: "课件要点…", humanizeChecklist: "口语化…"
    }
  );
  assert.match(s, /作业执行 Agent/);
  assert.match(s, /PLC 实验/);
  assert.match(s, /编程实操.*82%/);
  assert.match(s, /先给出完整草稿/);
  assert.match(s, /课件要点/);
  assert.match(s, /【最终交付】/);
});

/* ---------- 消息组装 ---------- */
test("buildMessages：system 置顶，只收 user/assistant 且非空", () => {
  const out = Agent.buildMessages("sys", [
    { role: "user", content: "u1" },
    { role: "tool", content: "junk" },
    { role: "assistant", content: "" },
    { role: "assistant", content: "a1" }
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" }
  ]);
});

/* ---------- 请求体预算裁剪（自 1.3.2 移植；Qoder CLI/桥同样怕超大请求体） ---------- */
test("buildMessages trims oversized course context and keeps the latest user turn", () => {
  const huge = "材料。".repeat(60000);   /* ≈180K 字符，远超预算 */
  const out = Agent.buildMessages("你是作业助手。\n【课程上下文】\n" + huge, [
    { role: "user", content: "q1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "请直接作答" },
  ]);
  const len = JSON.stringify(out).length;
  assert.ok(len <= Agent.BODY_BUDGET + 500, "组装结果应回到预算内: " + len);
  assert.ok(out[0].content.includes("已按请求体上限截断"), "system 截断须附说明");
  assert.equal(out[out.length - 1].content, "请直接作答", "最后一条用户消息必须原样保留");
});
test("buildMessages drops oldest history first before touching the system prompt", () => {
  const big = "历史消息内容。".repeat(3000);   /* 每条 ≈21K 字符 */
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push({ role: "user", content: "第" + i + "轮 " + big });
  const out = Agent.buildMessages("SYS", msgs);
  assert.ok(JSON.stringify(out).length <= Agent.BODY_BUDGET + 500, "应回到预算内");
  assert.equal(out[0].content, "SYS", "预算够丢历史时不应截断 system");
  assert.ok(out.length >= 3, "至少保留最近两轮对话");
  assert.ok(JSON.stringify(out).includes("第9轮"), "最新一轮必须保留");
  assert.ok(!JSON.stringify(out).includes("第0轮 "), "最旧的历史先被丢弃");
});
test("buildMessages leaves normal-sized conversations untouched", () => {
  const out = Agent.buildMessages("SYS", [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好，开始作业吧" },
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, "SYS");
  assert.equal(out[1].content, "你好");
});

/* ---------- 交付提取 ---------- */
test("extractDeliverableInfo：有【最终交付】→ confirmed + 定稿体", () => {
  const msgs = [
    { role: "user", content: "开工" },
    { role: "assistant", content: "先给草稿：略" },
    { role: "user", content: "可以" },
    { role: "assistant", content: "好的。\n【最终交付】\n# 实验报告\n正文…" }
  ];
  const info = Agent.extractDeliverableInfo(msgs);
  assert.equal(info.confirmed, true);
  assert.match(info.text, /^# 实验报告/);
});
test("extractDeliverableInfo：无定稿块 → fallback 最后一条回复且 confirmed=false", () => {
  const msgs = [{ role: "user", content: "改一下" }, { role: "assistant", content: "好的已修改" }];
  const info = Agent.extractDeliverableInfo(msgs);
  assert.equal(info.confirmed, false);
  assert.equal(info.text, "好的已修改");
});
test("extractDeliverable（旧签名）与 Info 版文本一致", () => {
  const msgs = [{ role: "assistant", content: "x\n【最终交付】：定稿" }];
  assert.equal(Agent.extractDeliverable(msgs), "定稿");
});

console.log("");
console.log(failed ? ("存在失败用例：" + failed) : ("agent.test: all passed"));
