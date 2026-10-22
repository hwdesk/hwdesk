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
const py = readFileSync(path.join(root, "syncserver.py"), "utf8");
function pyHas(re, what) {
  assert.ok(re.test(py), "syncserver.py is missing: " + what);
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

/* ---------- 5. 流式对话的失败恢复与落盘（回归：失败一次按钮永久卡死） ---------- */
test("streamChat failure path resets _chatBusy and the send button", () => {
  has(/\.catch\(function\(err\)\{\s*resetChatBtn\(\);/, "catch() -> resetChatBtn() before rendering");
  has(/function resetChatBtn\(\)\{[\s\S]{0,160}_chatBusy = false;/, "resetChatBtn() clears _chatBusy");
  has(/function resetChatBtn\(\)\{[\s\S]{0,300}b\.textContent = "发送"/, 'resetChatBtn() restores the "发送" label');
});
test("streaming persists partial output instead of saving only at the end", () => {
  has(/Date\.now\(\) - _lastSave > 1000\)\{ _lastSave = Date\.now\(\); Agent\.saveChat\(_chatId, chat\); \}/,
      "periodic Agent.saveChat() while streaming");
  has(/function closeChat\(\)\{[\s\S]{0,200}if\(_chatBusy[\s\S]{0,120}Agent\.saveChat\(_chatId, c\);/,
      "closeChat() flushes a half-finished answer");
});

/* ---------- 6. 交付二次确认（回归：「好的已修改」被当成交付） ---------- */
test("submitting without a 【最终交付】 block asks for confirmation", () => {
  has(/if\(!info\.confirmed\)\{[\s\S]{0,400}window\.confirm\(/, "confirm() when the deliverable is only a fallback");
  has(/Agent\.extractDeliverableInfo\(chat\.messages\)/, "onChatSubmit uses extractDeliverableInfo()");
});
test("needsReview keeps the card and the approval queue in sync", () => {
  has(/if\(needsReview\)\{[\s\S]{0,200}it\.reviewPending = true;/, "item flagged reviewPending");
  has(/it\.status = "submitted"; it\.reviewPending = false;/, "approval clears the flag");
});

/* ---------- 7. CORS 标注 ---------- */
test("preset dropdown is annotated with the browser-direct (CORS) status", () => {
  has(/Agent\.corsLabel\(id\)/, "corsLabel() used when rendering the preset options");
  has(/浏览器直连：/, "hint line carries the CORS status");
});

/* ---------- 8. 登录门禁真实验证（凭据先过本机桥 → course.hzcu.edu.cn） ---------- */
test("login card has an error line and the bridge hint", () => {
  assert.ok(ids.has("loginErr"), "#loginErr error line missing");
  has(/连不上本机验证服务/, "catch path explains the bridge is required");
  has(/python syncserver\.py/, "guidance names the exact command to run");
});
test("onLogin verifies credentials via the bridge /verify before SSO.set", () => {
  has(/fetch\(DIRECT_URL \+ "\/verify"/, "onLogin POSTs to the local bridge /verify");
  has(/JSON\.stringify\(\{\s*account:\s*acc,\s*password:\s*pw\s*\}\)/, "request body carries account+password");
  has(/err = el\("loginErr"\)/, "error line element bound");
  has(/if\(!res\.ok\)\{[\s\S]{0,300}err\.style\.display = "block";[\s\S]{0,160}return;/, "non-ok response blocks entry and shows the reason");
  has(/if\(!res\.ok\)\{[\s\S]{0,300}return;[\s\S]{0,400}SSO\.set\(acc,\s*pw,/, "SSO.set only runs after the platform says ok");
  has(/登录工作台（平台验证通过）/, "audit log marks the platform-verified login");
});
test("bridge /verify only logs in (no collection) and returns ok/error JSON", () => {
  pyHas(/def do_POST[\s\S]{0,600}"\/verify"/, "syncserver handles POST /verify");
  pyHas(/cx_login\(str\(creds\["account"\]\),\s*str\(creds\["password"\]\)\)/, "/verify calls cx_login with the request creds");
  pyHas(/"ok": False, "error": str\(e\)/, "SyncError surfaces as a readable error field");
});

console.log("\n" + passed + " passed");
