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
test("presets include cloudproxy / deepseek / kimi / qwen / hunyuan / doubao / custom", () => {
  for (const id of ["cloudproxy", "deepseek", "kimi", "qwen", "hunyuan", "doubao", "custom"]) {
    assert.ok(Agent.PRESETS[id], id + " missing");
  }
});
test("hunyuan preset is OpenAI-compatible + proxy-flagged (#70)", () => {
  assert.match(Agent.PRESETS.hunyuan.baseUrl, /^https:\/\/api\.hunyuan\.cloud\.tencent\.com\/v1$/);
  assert.equal(Agent.PRESETS.hunyuan.cors, "proxy");
  assert.ok(Agent.PRESETS.hunyuan.model.length > 0);
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
test("usablePresets lists keyOptional (cloudproxy) + keyed presets, in PRESET_ORDER (#81)", () => {
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7, keys: {} };
  Agent.setKey("qwen", "sk-q");
  Agent.setKey("deepseek", "sk-d");
  assert.deepEqual(Agent.usablePresets(), ["cloudproxy", "deepseek", "qwen"]);
});
test("use() applies a known preset and rejects unknown ones", () => {
  assert.equal(Agent.use("nope"), false);
  assert.equal(Agent.use("kimi"), true);
  assert.equal(Agent.config.preset, "kimi");
  Agent.applyPreset("deepseek");
});

/* ---------- 本地检测采用（matchPreset / applyDiscovered） ---------- */
test("matchPreset maps a known baseUrl to its preset (trailing slash tolerated), unknown to custom", () => {
  assert.equal(Agent.matchPreset("https://api.deepseek.com/v1"), "deepseek");
  assert.equal(Agent.matchPreset("https://api.deepseek.com/v1/"), "deepseek");
  assert.equal(Agent.matchPreset("https://www.onetopai.com/v1"), "custom");
  assert.equal(Agent.matchPreset(""), "custom");
});
test("applyDiscovered adopts a local candidate: preset by baseUrl, key per-preset, model/baseUrl overridden", () => {
  store.clear();
  const preset = Agent.applyDiscovered({
    baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-test-1",
    model: "gpt-6-astra", label: "Codex CLI"
  });
  assert.equal(preset, "custom");
  assert.equal(Agent.config.preset, "custom");
  assert.equal(Agent.config.baseUrl, "https://www.onetopai.com/v1");
  assert.equal(Agent.config.model, "gpt-6-astra");
  assert.equal(Agent.config.apiKey, "sk-test-1");
  assert.equal(Agent.config.keys.custom, "sk-test-1");
  assert.ok(Agent.ready(), "ready() right after adoption (baseUrl+model+key)");
});
test("applyDiscovered picks the matching preset when the baseUrl belongs to one", () => {
  store.clear();
  const preset = Agent.applyDiscovered({
    baseUrl: "https://api.moonshot.cn/v1", apiKey: "sk-kimi", model: "moonshot-v1-8k"
  });
  assert.equal(preset, "kimi");
  assert.equal(Agent.config.preset, "kimi");
  assert.equal(Agent.config.keys.kimi, "sk-kimi");
  assert.equal(Agent.config.model, "moonshot-v1-8k");
});
test("applyDiscovered returns null for incomplete candidates", () => {
  assert.equal(Agent.applyDiscovered({ baseUrl: "https://x/v1" }), null);
  assert.equal(Agent.applyDiscovered({ apiKey: "sk-x" }), null);
  assert.equal(Agent.applyDiscovered(null), null);
});

/* ---------- 启动自动采用（所有对话统一走本机 Agent） ---------- */
test("pickLocalCandidate prefers openai+model over relay, and skips incomplete entries", () => {
  const best = Agent.pickLocalCandidate([
    { baseUrl: "https://relay/x", apiKey: "k1", protocol: "relay" },
    { baseUrl: "https://www.onetopai.com/v1", apiKey: "k2", protocol: "openai", model: "gpt-6-astra" },
    { baseUrl: "", apiKey: "k3" },
    null
  ]);
  assert.equal(best.apiKey, "k2");
  assert.equal(Agent.pickLocalCandidate([]), null);
  assert.equal(Agent.pickLocalCandidate(null), null);
});
test("autoAdoptLocal adopts the best candidate when config is not ready", () => {
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7, keys: {}, manualLock: false };
  const p = Agent.autoAdoptLocal([
    { baseUrl: "https://timesniper.club", apiKey: "k-relay", protocol: "relay" },
    { baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-auto", model: "gpt-6-astra", protocol: "openai" }
  ]);
  assert.equal(p, "custom");
  assert.equal(Agent.config.apiKey, "sk-auto");
  assert.equal(Agent.config.model, "gpt-6-astra");
});
test("autoAdoptLocal adopts on a pristine default profile (cloudproxy keyOptional is ready()==true but counts as unconfigured, issue #81)", () => {
  store.clear();
  Agent.config = { preset: "cloudproxy", baseUrl: Agent.PRESETS.cloudproxy.baseUrl, apiKey: "", model: Agent.PRESETS.cloudproxy.model, temperature: 0.7, keys: {}, manualLock: false };
  const p = Agent.autoAdoptLocal([{ baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-auto", model: "gpt-6-astra", protocol: "openai" }]);
  assert.equal(p, "custom");
  assert.equal(Agent.config.apiKey, "sk-auto");
});
test("autoAdoptLocal never overrides a ready config or a manualLock one", () => {
  // ready（已采用/已手动配置）→ 不动
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "sk-d", model: Agent.PRESETS.deepseek.model, temperature: 0.7, keys: { deepseek: "sk-d" }, manualLock: false };
  assert.equal(Agent.autoAdoptLocal([{ baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-auto", model: "gpt-6-astra", protocol: "openai" }]), null);
  assert.equal(Agent.config.preset, "deepseek");
  assert.equal(Agent.config.apiKey, "sk-d");
  // 已通过采用按钮配好（custom + key，未手动保存）→ 不动
  store.clear();
  Agent.config = { preset: "custom", baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-prev", model: "gpt-6-astra", temperature: 0.7, keys: { custom: "sk-prev" }, manualLock: false };
  assert.equal(Agent.autoAdoptLocal([{ baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-new", model: "gpt-6-astra", protocol: "openai" }]), null);
  assert.equal(Agent.config.apiKey, "sk-prev");
  // manualLock → 绝不覆盖
  store.clear();
  Agent.config = { preset: "deepseek", baseUrl: Agent.PRESETS.deepseek.baseUrl, apiKey: "", model: Agent.PRESETS.deepseek.model, temperature: 0.7, keys: {}, manualLock: true };
  assert.equal(Agent.autoAdoptLocal([{ baseUrl: "https://www.onetopai.com/v1", apiKey: "sk-auto2", model: "gpt-6-astra", protocol: "openai" }]), null);
  assert.equal(Agent.config.apiKey, "");
  // 空候选 → null
  Agent.config.manualLock = false;
  assert.equal(Agent.autoAdoptLocal([]), null);
  assert.equal(Agent.autoAdoptLocal(null), null);
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

/* ---------- 请求体预算裁剪（云端网关拒绝超大 POST 的根因修复） ---------- */
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

  await atest("probeLayers: 代理可达且 models 非空 → layer1 cloudproxy（带令牌时请求带头）", async () => {
    freshConfig();
    let seen = null;
    globalThis.fetch = async (u, o) => { seen = o || {}; return { ok: true, json: async () => ({ object: "list", data: [{ id: "deepseek-chat" }] }) }; };
    delete globalThis.CloudAI;
    Agent.setKey("cloudproxy", "tok-1");
    const r = await Agent.probeLayers(500);
    assert.equal(r.layer, 1); assert.equal(r.presetId, "cloudproxy");
    assert.equal(seen.headers["Authorization"], "Bearer tok-1");
  });

  await atest("probeLayers: 代理可达但 models 为空（一台 key 都没配）→ 跳过 layer1 落 CloudAI（#70）", async () => {
    freshConfig();
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ object: "list", data: [] }) });
    globalThis.CloudAI = { healthCheck: async () => ({ ok: true, models: [] }) };
    const r = await Agent.probeLayers(500);
    assert.equal(r.layer, 2); assert.equal(r.presetId, null);
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

  await atest("autoSelect: 探测带回宿主模型目录 → 自动对应第一个可用模型（免 Key 不 502）", async () => {
    freshConfig();
    Agent.autoSelect({ layer: 1, presetId: "cloudproxy",
                       models: { data: [{ id: "hunyuan-turbos-latest" }, { id: "deepseek-chat" }] } });
    assert.equal(Agent.config.preset, "cloudproxy");
    assert.equal(Agent.config.model, "hunyuan-turbos-latest");
  });

  await atest("autoSelect: 模型目录为字符串数组也能对应；空目录保持预设默认模型", async () => {
    freshConfig();
    Agent.autoSelect({ layer: 1, presetId: "cloudproxy", models: { data: ["qwen-plus"] } });
    assert.equal(Agent.config.model, "qwen-plus");
    freshConfig();
    Agent.autoSelect({ layer: 1, presetId: "cloudproxy" });
    assert.equal(Agent.config.model, Agent.PRESETS.cloudproxy.model);
    freshConfig();
    Agent.autoSelect({ layer: 1, presetId: "cloudproxy", models: { data: [] } });
    assert.equal(Agent.config.model, Agent.PRESETS.cloudproxy.model);
  });

  globalThis.fetch = realFetch;
  if (realCloudAI === undefined) delete globalThis.CloudAI; else globalThis.CloudAI = realCloudAI;
  console.log(passed + " passed, " + (process.exitCode ? 1 : 0) + " failed");
  if (!process.exitCode) console.log("ALL PASS");
})();
