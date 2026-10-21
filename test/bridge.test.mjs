/*
 * bridge.js AI 直连桥测试（零依赖，Node >= 16）
 * 运行：node test/bridge.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
(0, eval)(readFileSync(path.join(root, "bridge.js"), "utf8"));
const Bridge = globalThis.Bridge;

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

console.log("bridge.js " + Bridge.version + " | AI: " + Bridge.ORDER.join(", "));

/* ---------- 注册表 ---------- */
test("registry includes doubao / yuanbao / deepseek / kimi / qwen / workbuddy", () => {
  for (const id of ["doubao", "yuanbao", "deepseek", "kimi", "qwen", "workbuddy"]) {
    assert.ok(Bridge.AI[id], id + " missing");
    assert.ok(Bridge.AI[id].label);
  }
});
test("web AIs carry a chat url, workbuddy does not", () => {
  for (const id of ["doubao", "yuanbao", "deepseek", "kimi", "qwen"]) {
    assert.match(Bridge.AI[id].url, /^https:/);
  }
  assert.equal(Bridge.AI.workbuddy.url, "");
});
test("every laya route category is covered by at least one AI", () => {
  const cats = ["reasoner", "writer", "fastsolver", "coder", "polisher", "formatter"];
  for (const c of cats) {
    assert.ok(
      Bridge.ORDER.some((id) => Bridge.AI[id].categories.includes(c)),
      "no AI covers " + c
    );
  }
});

/* ---------- 偏好 ---------- */
test("prefs default empty -> pick falls back to auto category match", () => {
  Bridge.reset();
  const r = Bridge.pick("reasoner");
  assert.ok(Bridge.AI[r.ai].categories.includes("reasoner"));
  assert.equal(r.source, "auto");
});
test("global default overrides auto match", () => {
  Bridge.reset();
  Bridge.setPref("defaultAi", "yuanbao");
  const r = Bridge.pick("reasoner");
  assert.equal(r.ai, "yuanbao");
  assert.equal(r.source, "default");
});
test("category preference overrides global default", () => {
  Bridge.reset();
  Bridge.setPref("defaultAi", "yuanbao");
  Bridge.setCategoryPref("reasoner", "deepseek");
  assert.equal(Bridge.pick("reasoner").ai, "deepseek");
  assert.equal(Bridge.pick("writer").ai, "yuanbao");
});
test("unknown ids in prefs are ignored safely", () => {
  Bridge.reset();
  Bridge.setPref("defaultAi", "not-an-ai");
  const r = Bridge.pick("reasoner");
  assert.notEqual(r.ai, "not-an-ai");
  Bridge.setCategoryPref("coder", "garbage");
  assert.notEqual(Bridge.pick("coder").ai, "garbage");
});

/* ---------- 派发描述 ---------- */
test("web AI describe -> open+copy with its url", () => {
  const plan = Bridge.describe(Bridge.pick("coder"));
  assert.equal(plan.action, "open+copy");
  assert.ok(plan.url.startsWith("https://"));
  assert.ok(plan.label.length > 0);
});
test("workbuddy describe -> copy-only legacy flow", () => {
  const plan = Bridge.describe({ ai: "workbuddy" });
  assert.equal(plan.action, "copy");
  assert.equal(plan.url, "");
});
test("describe falls back to workbuddy on empty pick", () => {
  const plan = Bridge.describe({ ai: "" });
  assert.equal(plan.ai, "workbuddy");
  assert.equal(plan.action, "copy");
});

/* ---------- 回执文案 ---------- */
test("toast text mentions the target AI for open+copy", () => {
  const t = Bridge.toastText({ action: "open+copy", label: "豆包" });
  assert.ok(t.includes("豆包") && t.includes("Ctrl+V"));
});
test("toast text keeps workbuddy wording for copy flow", () => {
  const t = Bridge.toastText({ action: "copy" });
  assert.ok(t.includes("WorkBuddy"));
});

console.log(passed + " passed, " + (process.exitCode ? 1 : 0) + " failed");
if (!process.exitCode) console.log("ALL PASS");
