/*
 * 作业提交工作台.html 接线回归测试（零依赖，Node >= 16）
 * 运行：node test/wiring.test.mjs
 *
 * 这类 bug 的特征：DOM 结构在、处理函数也在，但
 *   (a) bind() 忘了接监听器 → 按钮点了没反应（用户主观感受是「卡顿」）；
 *   (b) 引用的 id 在页面里根本不存在 → el() 返回 null，一抛错把 bind()
 *       剩下的绑定和整个页面初始化全部带崩。
 * AI 直连选择器（取消键点不动、只能刷新页面退出）和设置页缺失的
 * 「Agent 对话 API」区块都栽在这上面，这里用静态解析把这两类问题守住。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const html = readFileSync(path.join(root, "作业提交工作台.html"), "utf8");

/* 内联脚本 = 页面自身逻辑（外链 <script src=...> 由各自单测覆盖） */
const app = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  .map((m) => m[1])
  .join("\n");

/* 静态标记里的 id，加上 JS 动态拼出来的 id（如 ' id="chatLast'） */
const ids = new Set([...html.matchAll(/\sid\s*=\s*"([^"]+)"/g)].map((m) => m[1]));
const dynamic = new Set([...app.matchAll(/id\s*=\s*["']([A-Za-z][\w-]*)["']?/g)].map((m) => m[1]));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    console.error("  FAIL - " + name + "\n    " + String(e.message).split("\n")[0]);
    process.exitCode = 1;
  }
}
function has(re, what) {
  assert.ok(re.test(app), "inline script is missing: " + what);
}

console.log("wiring | ids: " + ids.size + ", inline script: " + app.length + " chars");

/* ---------- 1. el() 引用的 id 必须真的存在 ---------- */
test('every el("id") in the inline script resolves to a real element', () => {
  const refs = [...new Set([...app.matchAll(/\bel\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]))];
  assert.ok(refs.length > 20, "expected many el() refs, got " + refs.length);
  const missing = refs.filter((id) => !ids.has(id) && !dynamic.has(id));
  assert.deepEqual(missing, [], "unresolved ids: " + missing.join(", "));
});

/* ---------- 2. AI 直连选择器（回归：取消键点不动 / 选 AI 无反应） ---------- */
test("picker markup exposes #aiPicker / #aiPickerList / #aiPickerCancel", () => {
  for (const id of ["aiPicker", "aiPickerList", "aiPickerCancel"]) {
    assert.ok(ids.has(id), "#" + id + " missing");
  }
});
test("取消 is wired to closeAiPicker", () => {
  has(/el\("aiPickerCancel"\)\.addEventListener\(\s*"click",\s*closeAiPicker\s*\)/,
      'el("aiPickerCancel").addEventListener("click", closeAiPicker)');
});
test("picker list has a delegated click handler", () => {
  has(/el\("aiPickerList"\)\.addEventListener\(\s*"click"/, 'el("aiPickerList").addEventListener("click"');
});
test("「设为默认」 is handled by that delegated handler", () => {
  has(/closest\(\s*"\[data-setdef\]"\s*\)/, 'closest("[data-setdef]")');
  has(/confirmAiPick\(setdef\.getAttribute\("data-setdef"\), true\)/, "confirmAiPick(<id>, true)");
});
test("clicking an AI row dispatches once", () => {
  has(/closest\(\s*"\.ai-pick-item\[data-ai\]"\s*\)/, 'closest(".ai-pick-item[data-ai]")');
  has(/confirmAiPick\(row\.getAttribute\("data-ai"\), false\)/, "confirmAiPick(<id>, false)");
});
test("clicking the mask closes the picker", () => {
  has(/el\("aiPicker"\)\.addEventListener\(\s*"click"/, 'el("aiPicker").addEventListener("click"');
  has(/e\.target === el\("aiPicker"\)\s*\)\s*closeAiPicker\(\)/, "mask click -> closeAiPicker()");
});
test("Escape closes the picker", () => {
  has(/e\.key === "Escape" && el\("aiPicker"\)\.style\.display !== "none"/, "Escape handler for #aiPicker");
});
test("AI rows are keyboard reachable (Enter / Space)", () => {
  has(/el\("aiPickerList"\)\.addEventListener\(\s*"keydown"/, "keydown handler on the picker list");
  has(/role="button" tabindex="0"/, 'role="button" tabindex="0" on each AI row');
});

/* ---------- 3. 设置页「Agent 对话 API」区块（回归：markup 丢失 → bind() 抛错） ---------- */
test("Agent settings block exists (agPreset / agUrl / agKey / agModel / agHint / agKeyLink / agSave)", () => {
  for (const id of ["agPreset", "agUrl", "agKey", "agModel", "agHint", "agKeyLink", "agSave"]) {
    assert.ok(ids.has(id), "#" + id + " missing from the settings view");
  }
});
test("Agent bindings are guarded so a missing block cannot abort bind()", () => {
  has(/if\(typeof Agent !== "undefined" && el\("agPreset"\) && el\("agSave"\)\)/,
      "guard around the ag* bindings");
  has(/function fillAgentSettings\(\)\{[\s\S]{0,200}if\(!el\("agPreset"\)\) return;/,
      "fillAgentSettings() bails out when the block is absent");
});

/* ---------- 4. 初始化容错 ---------- */
test("startup runs each step through safe() so one failure cannot abort init", () => {
  has(/function safe\(name, fn\)\{[\s\S]{0,120}try \{ fn\(\); \} catch\(e\)/, "safe(name, fn) helper");
  for (const step of ["bind", "fillAgentSettings", "refreshAll", "switchView"]) {
    assert.ok(app.includes('safe("' + step + '"'), "init step not wrapped: " + step);
  }
});

console.log("\n" + passed + " passed");
