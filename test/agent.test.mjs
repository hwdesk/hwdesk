/*
 * agent.js 作业内嵌 Agent 对话测试（零依赖，Node >= 16）
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

console.log("agent.js " + Agent.version + " | presets: " + Agent.PRESET_ORDER.join(", "));

/* ---------- 预设 ---------- */
test("presets include deepseek / kimi / qwen / doubao / custom", () => {
  for (const id of ["deepseek", "kimi", "qwen", "doubao", "custom"]) {
    assert.ok(Agent.PRESETS[id], id + " missing");
  }
});
test("web presets carry https baseUrl and default model", () => {
  for (const id of ["deepseek", "kimi", "qwen"]) {
    assert.match(Agent.PRESETS[id].baseUrl, /^https:/);
    assert.ok(Agent.PRESETS[id].model.length > 0);
  }
});

/* ---------- 配置 ---------- */
test("default config is deepseek with empty key; ready() false without key", () => {
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7 };
  assert.equal(Agent.ready(), false);
});
test("applyPreset switches preset; keys are stored per-preset and survive switching", () => {
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7, keys: {} };
  Agent.setKey("deepseek", "sk-ds");
  Agent.applyPreset("kimi");
  assert.equal(Agent.config.preset, "kimi");
  assert.equal(Agent.config.baseUrl, Agent.PRESETS.kimi.baseUrl);
  assert.equal(Agent.config.model, "moonshot-v1-8k");
  assert.equal(Agent.config.apiKey, "");            // kimi 还没配 key
  Agent.setKey("kimi", "sk-kimi");
  assert.equal(Agent.config.apiKey, "sk-kimi");
  Agent.use("deepseek");
  assert.equal(Agent.config.preset, "deepseek");
  assert.equal(Agent.config.apiKey, "sk-ds");       // 切回 deepseek，key 还在
  const fresh = JSON.parse(localStorage.getItem("wb_hwdesk_agent"));
  assert.equal(fresh.keys.deepseek, "sk-ds");
  assert.equal(fresh.keys.kimi, "sk-kimi");
});
test("ready() true only with baseUrl+model+key; use() syncs the preset key", () => {
  Agent.applyPreset("doubao");            // model 为空、doubao 无 key
  assert.equal(Agent.ready(), false);
  Agent.config.model = "ep-123";
  Agent.save();                           // setKey 内部会 load()，先把修改落盘
  Agent.setKey("doubao", "sk-ark");
  assert.equal(Agent.ready(), true);
  Agent.use("deepseek");
  assert.equal(Agent.ready(), true);      // deepseek 的 key 还在
  Agent.config.apiKey = "";
  Agent.save();
  assert.equal(Agent.ready(), false);
  Agent.applyPreset("deepseek");          // key 从 keys 里恢复
  assert.equal(Agent.ready(), true);
});

/* ---------- 多 Agent Key 管理（1.1.0：选择 Agent / 按预设分存 Key） ---------- */
test("legacy single apiKey migrates into keys[preset] on load", () => {
  store.clear();
  Agent.config.keys = {};                 // 模拟全新浏览器（内存里也不留旧 keys）
  localStorage.setItem("wb_hwdesk_agent", JSON.stringify({
    preset: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKey: "sk-legacy", model: "moonshot-v1-8k"
  }));
  Agent.load();
  assert.equal(Agent.config.keys.kimi, "sk-legacy");
  assert.equal(Agent.config.apiKey, "sk-legacy");
});
test("usablePresets lists only presets with keys, in PRESET_ORDER", () => {
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7, keys: {} };
  Agent.setKey("qwen", "sk-q");
  Agent.setKey("deepseek", "sk-d");
  assert.deepEqual(Agent.usablePresets(), ["deepseek", "qwen"]);
});
test("use() applies a known preset and rejects unknown ones", () => {
  assert.equal(Agent.use("nope"), false);
  assert.equal(Agent.use("kimi"), true);
  assert.equal(Agent.config.preset, "kimi");
  Agent.applyPreset("deepseek");
});

/* ---------- 聊天历史 ---------- */
test("loadChat returns empty structure for unknown item", () => {
  store.delete("wb_hwdesk_chats");
  const c = Agent.loadChat(42);
  assert.deepEqual(c, { system: "", messages: [] });
});
test("saveChat/loadChat roundtrip is per-item isolated", () => {
  Agent.saveChat(1, { system: "s1", messages: [{ role: "user", content: "a" }] });
  Agent.saveChat(2, { system: "s2", messages: [] });
  assert.equal(Agent.loadChat(1).system, "s1");
  assert.equal(Agent.loadChat(2).system, "s2");
  assert.equal(Agent.loadChat(3).messages.length, 0);
});
test("clearChat wipes the item conversation", () => {
  Agent.clearChat(1);
  assert.deepEqual(Agent.loadChat(1), { system: "", messages: [] });
});

/* ---------- 系统提示词 ---------- */
const item = { id: 7, name: "第二章作业", course: "PLC", due: "2026-10-24", format: "文字", note: "2 道计算题" };
test("system prompt embeds task fields", () => {
  const s = Agent.buildSystemPrompt(item, {});
  assert.ok(s.includes("第二章作业") && s.includes("PLC") && s.includes("2026-10-24"));
  assert.ok(s.includes("【最终交付】"));
});
test("system prompt includes context brief and humanize checklist when provided", () => {
  const s = Agent.buildSystemPrompt(item, { contextBrief: "课件：开关频率 20kHz", humanizeChecklist: "禁用AI套话" });
  assert.ok(s.includes("开关频率 20kHz") && s.includes("禁用AI套话"));
});
test("system prompt reflects Laya decision review flag", () => {
  const d = { route: { label: "代码AI", confidence: 0.7 }, review: { needed: true } };
  assert.ok(Agent.buildSystemPrompt(item, { decision: d }).includes("先给出完整草稿"));
  const d2 = { route: { label: "代码AI", confidence: 0.7 }, review: { needed: false } };
  assert.ok(Agent.buildSystemPrompt(item, { decision: d2 }).includes("可直接产出"));
});

/* ---------- 消息组装 ---------- */
test("buildMessages prefixes system and drops invalid entries", () => {
  const msgs = Agent.buildMessages("SYS", [
    { role: "user", content: "q1" },
    { role: "tool", content: "noise" },
    { role: "assistant", content: "a1" },
    null
  ]);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[1].content, "q1");
  assert.equal(msgs[2].role, "assistant");
});

/* ---------- 交付提取 ---------- */
test("extractDeliverable prefers 【最终交付】 section", () => {
  const msgs = [{ role: "assistant", content: "先给草稿。\n【最终交付】\n答案是 42。" }];
  assert.equal(Agent.extractDeliverable(msgs), "答案是 42。");
});
test("extractDeliverable falls back to last assistant message", () => {
  assert.equal(Agent.extractDeliverable([{ role: "assistant", content: "  直接成稿 " }]), "直接成稿");
});
test("extractDeliverable empty when no assistant message", () => {
  assert.equal(Agent.extractDeliverable([{ role: "user", content: "hi" }]), "");
});

/* ---------- CORS 标注 ---------- */
test("every preset declares a cors mode (ok / proxy / custom)", () => {
  for (const id of Agent.PRESET_ORDER) {
    assert.ok(["ok", "proxy", "custom"].includes(Agent.PRESETS[id].cors), id + " cors missing");
    assert.ok(Agent.corsLabel(id).length > 0, id + " label missing");
  }
});
test("doubao is flagged as proxy-preferred, web presets as browser-direct", () => {
  assert.equal(Agent.PRESETS.doubao.cors, "proxy");
  assert.equal(Agent.PRESETS.deepseek.cors, "ok");
  assert.equal(Agent.corsLabel("doubao"), "建议本地代理");
});

/* ---------- 定稿二次确认 ---------- */
test("extractDeliverableInfo marks 【最终交付】 as confirmed", () => {
  const r = Agent.extractDeliverableInfo([{ role: "assistant", content: "草稿…\n【最终交付】\n定稿 42" }]);
  assert.equal(r.confirmed, true);
  assert.equal(r.text, "定稿 42");
});
test("extractDeliverableInfo marks the fallback as NOT confirmed", () => {
  const r = Agent.extractDeliverableInfo([{ role: "assistant", content: "好的已修改" }]);
  assert.equal(r.confirmed, false);
  assert.equal(r.text, "好的已修改");
});
test("extractDeliverable keeps its old string signature", () => {
  assert.equal(Agent.extractDeliverable([{ role: "assistant", content: "【最终交付】x" }]), "x");
  assert.equal(Agent.extractDeliverable([{ role: "user", content: "hi" }]), "");
});

console.log(passed + " passed, " + (process.exitCode ? 1 : 0) + " failed");

/* ---------- 分层自动降级（#56，异步） ---------- */
const realFetch = globalThis.fetch;
const realCloudAI = globalThis.CloudAI;
function okFetch(body) {
  return async (url, opts) => ({ ok: true, url, opts, json: async () => body });
}
function downFetch() {
  return async () => { throw new TypeError("Failed to fetch"); };
}

async function atest(name, fn) {
  try { await fn(); passed++; console.log("  ok - " + name); }
  catch (e) { console.error("  FAIL - " + name + "\n    " + e.message); process.exitCode = 1; }
}

(async () => {
  const freshConfig = () => { store.clear();
    Agent.config = { preset: "cloudproxy", baseUrl: Agent.PRESETS.cloudproxy.baseUrl, apiKey: "",
      model: Agent.PRESETS.cloudproxy.model, temperature: 0.7, keys: {}, manualLock: false }; };

  await atest("probeLayers: 代理可达 → layer1 cloudproxy（带令牌时请求带头）", async () => {
    freshConfig();
    let seen = null;
    globalThis.fetch = async (u, o) => { seen = o || {}; return { ok: true, json: async () => ({ object: "list", data: [] }) }; };
    delete globalThis.CloudAI;
    Agent.setKey("cloudproxy", "tok-1");
    const r = await Agent.probeLayers(500);
    assert.equal(r.layer, 1); assert.equal(r.presetId, "cloudproxy");
    assert.equal(seen.headers["Authorization"], "Bearer tok-1");
  });

  await atest("probeLayers: 代理挂 + CloudAI 体检通过 → layer2", async () => {
    freshConfig();
    globalThis.fetch = downFetch();
    globalThis.CloudAI = { healthCheck: async () => ({ ok: true, models: [] }) };
    const r = await Agent.probeLayers(500);
    assert.equal(r.layer, 2); assert.equal(r.presetId, null);
  });

  await atest("probeLayers: 前两层灭 + 有本机 key → layer3 手动预设（不含 cloudproxy）", async () => {
    freshConfig();
    globalThis.fetch = downFetch();
    globalThis.CloudAI = { healthCheck: async () => ({ ok: false, code: "gateway_network_error" }) };
    Agent.setKey("deepseek", "sk-ds");
    const r = await Agent.probeLayers(500);
    assert.equal(r.layer, 3); assert.equal(r.presetId, "deepseek");
  });

  await atest("probeLayers: 全灭 → layer0", async () => {
    freshConfig();
    globalThis.fetch = downFetch();
    globalThis.CloudAI = { healthCheck: async () => ({ ok: false, code: "gateway_timeout" }) };
    const r = await Agent.probeLayers(500);
    assert.equal(r.layer, 0); assert.equal(r.presetId, null);
  });

  await atest("autoSelect: 自动切到探测层；manualLock 后不再抢", async () => {
    freshConfig();
    assert.equal(Agent.autoSelect({ layer: 1, presetId: "cloudproxy" }), "cloudproxy");
    assert.equal(Agent.config.preset, "cloudproxy");
    Agent.applyPreset("deepseek");
    Agent.config.manualLock = true;
    assert.equal(Agent.autoSelect({ layer: 1, presetId: "cloudproxy" }), null);
    assert.equal(Agent.config.preset, "deepseek");
  });

  globalThis.fetch = realFetch;
  if (realCloudAI === undefined) delete globalThis.CloudAI; else globalThis.CloudAI = realCloudAI;
  console.log(passed + " passed, " + (process.exitCode ? 1 : 0) + " failed");
  if (!process.exitCode) console.log("ALL PASS");
})();
