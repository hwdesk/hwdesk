/*
 * bridge.js 1.1.0 AI 直连桥测试（唯一 Agent：Qoder CLI；零依赖，Node >= 16）
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

/* ---------- 注册表：收敛为唯一 Qoder CLI ---------- */
test("registry collapsed to the single qoder agent", () => {
  assert.deepEqual(Bridge.ORDER, ["qoder"]);
  assert.ok(Bridge.AI.qoder && Bridge.AI.qoder.label);
});
test("qoder is local: no web url (copy-only fallback flow)", () => {
  assert.equal(Bridge.AI.qoder.url, "");
});
test("every laya route category is covered by qoder", () => {
  const cats = ["reasoner", "writer", "fastsolver", "coder", "polisher", "formatter"];
  for (const c of cats) {
    assert.ok(Bridge.AI.qoder.categories.includes(c), "qoder does not cover " + c);
  }
});

/* ---------- 偏好 ---------- */
test("prefs default empty -> pick falls back to auto category match (qoder)", () => {
  Bridge.reset();
  const r = Bridge.pick("reasoner");
  assert.equal(r.ai, "qoder");
  assert.equal(r.source, "auto");
});
test("global default overrides auto match", () => {
  Bridge.reset();
  Bridge.setPref("defaultAi", "qoder");
  const r = Bridge.pick("reasoner");
  assert.equal(r.ai, "qoder");
  assert.equal(r.source, "default");
});
test("stale byCategory cannot override the default", () => {
  Bridge.reset();
  Bridge.setPref("defaultAi", "qoder");
  Bridge.setCategoryPref("reasoner", "not-an-ai");
  const r = Bridge.pick("reasoner");
  assert.equal(r.ai, "qoder");
  assert.equal(r.source, "default");
});
test("stale/unknown ids in prefs are ignored safely", () => {
  Bridge.reset();
  Bridge.setPref("defaultAi", "doubao");   /* 已下线的外部 AI */
  const r = Bridge.pick("reasoner");
  assert.equal(r.ai, "qoder");
  Bridge.setCategoryPref("coder", "garbage");
  assert.equal(Bridge.pick("coder").ai, "qoder");
});

/* ---------- 派发描述 ---------- */
test("qoder describe -> copy-only flow (no web page)", () => {
  const plan = Bridge.describe(Bridge.pick("coder"));
  assert.equal(plan.action, "copy");
  assert.equal(plan.url, "");
  assert.ok(plan.label.length > 0);
});
test("describe falls back to qoder on empty pick", () => {
  const plan = Bridge.describe({ ai: "" });
  assert.equal(plan.ai, "qoder");
  assert.equal(plan.action, "copy");
});
test("describe falls back to qoder on unknown id (fields stay consistent)", () => {
  const plan = Bridge.describe({ ai: "chatgpt" });
  assert.equal(plan.ai, "qoder");
  assert.equal(plan.label, Bridge.AI.qoder.label);
  assert.equal(plan.action, "copy");
  assert.equal(plan.url, "");
});

/* ---------- 回执文案 ---------- */
test("toast text mentions the target AI for open+copy", () => {
  const t = Bridge.toastText({ action: "open+copy", label: "示例AI" });
  assert.ok(t.includes("示例AI") && t.includes("Ctrl+V"));
});
test("toast text points at AI 对话 for copy flow", () => {
  const t = Bridge.toastText({ action: "copy" });
  assert.ok(t.includes("AI 对话"));
});

console.log(passed + " passed, " + (process.exitCode ? 1 : 0) + " failed");
if (!process.exitCode) console.log("ALL PASS");
