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

/* ---------- 4. Agent 独立板块（配置搬家：设置页不再放 Agent 配置） ---------- */
test("nav exposes a dedicated Agent view hosting the config blocks", () => {
  assert.ok(html.includes('data-view="agent"'), "nav button data-view=agent missing");
  const agentStart = html.indexOf('id="view-agent"');
  const settingsStart = html.indexOf('id="view-settings"');
  assert.ok(agentStart !== -1 && settingsStart !== -1 && agentStart < settingsStart,
      "view-agent section missing or misordered");
  const agentView = html.slice(agentStart, settingsStart);
  for (const id of ["agPreset", "agKey", "agSave", "selDefaultAi"]) {
    assert.ok(agentView.includes('id="' + id + '"'), "#" + id + " not inside the Agent view");
  }
  assert.ok(!html.slice(settingsStart).includes('id="agPreset"'), "agPreset still inside settings view");
});

/* ---------- 5. 极简 Agent 选择器（AI 代提交：只选 Agent，选完工作台内开聊） ---------- */
test("agent picker markup exists (agPick / agPickList / agPickFor / agPickCfg)", () => {
  for (const id of ["agPick", "agPickList", "agPickFor", "agPickCfg"]) {
    assert.ok(ids.has(id), "#" + id + " missing");
  }
});
test("agent picker rows are keyboard reachable and wired", () => {
  has(/el\("agPickList"\)\.addEventListener\(\s*"click"/, "agPickList delegated click");
  has(/closest\(\s*"\.ag-pick-item\[data-ag\]"\s*\)/, 'closest(".ag-pick-item[data-ag]")');
  has(/confirmAgPick\(row\.getAttribute\("data-ag"\)\)/, "confirmAgPick(<preset>)");
  has(/el\("agPickList"\)\.addEventListener\(\s*"keydown"/, "agPickList keydown");
  has(/role="button" tabindex="0"/, 'role="button" tabindex="0"');
});
test("agent picker closes via mask click / Escape / 管理配置 button", () => {
  has(/e\.target === el\("agPick"\)\s*\)\s*closeAgPick\(\)/, "mask click -> closeAgPick()");
  has(/e\.key === "Escape" && el\("agPick"\)\.style\.display !== "none"/, "Escape closes agPick");
  has(/el\("agPickCfg"\)\.addEventListener\(\s*"click"/, "agPickCfg wired");
  has(/closeAgPick\(\); switchView\("agent"\); fillAgentSettings\(\);/, "管理配置 jumps to the Agent view");
});

/* ---------- 6. AI 代提交改走工作台内嵌对话（不再开浏览器） ---------- */
test("data-ai buttons go through onAiChat, not the browser dispatch", () => {
  has(/function onAiChat\(id, auto\)/, "onAiChat(id, auto) exists");
  has(/if\(b\) onAiChat\(\+b\.getAttribute\("data-ai"\), true\);/, "todayBox data-ai -> onAiChat");
  has(/onAiChat\(\+t\.getAttribute\("data-ai"\), true\)/, "hwList data-ai -> onAiChat");
  const aiSubmitRefs = [...app.matchAll(/onAiSubmit\(/g)].length;
  assert.equal(aiSubmitRefs, 2, "onAiSubmit should only be defined + called from the Laya flow, got " + aiSubmitRefs);
  const dispatchChunk = app.slice(app.indexOf("function doDispatch"));
  assert.ok(!/window\.open\(/.test(app), "the workbench must never window.open an AI website");
  assert.ok(dispatchChunk.includes("copyText(cmd)"), "doDispatch stays the copy-only fallback");
});
test("picker / default dispatch always lands in the in-workbench chat drawer", () => {
  has(/function doAgentChat\(aiId, cmd, taskName, taskId\)/, "doAgentChat(aiId, cmd, taskName, taskId)");
  has(/if\(ctx\.taskId\)\{\s*doAgentChat\(id, ctx\.cmd, ctx\.taskName, ctx\.taskId\);/,
      "picker confirm opens the drawer for every AI (元宝 / WorkBuddy included)");
  has(/if\(taskId\)\{ return doAgentChat\(pick\.ai, cmd, taskName, taskId\); \}/,
      "default-AI dispatch opens the drawer");
  has(/function openAgentChatWith\(taskId, cmd\)[\s\S]{0,300}onChatSend\(\)/,
      "the dispatch instruction is auto-sent into the drawer when a channel is ready");
});
test("Laya 执行计划 also opens the in-workbench drawer (top task context)", () => {
  has(/dispatchToAi\(plan\.instruction, "", "Laya 执行计划（" \+ plan\.queue\.length \+ " 项）", plan\.queue\[0\]\.item\.id\)/,
      "onLayaPlan forwards the top task id");
});
test("AI 代提交 with multiple usable agents opens the picker; unconfigured nudges to Agent view", () => {
  has(/openAgPick\(id\); return;/, "multiple usable agents -> openAgPick");
  has(/switchView\("agent"\); fillAgentSettings\(\); return;/, "not-configured path jumps to Agent view");
});

/* ---------- 7. 对话抽屉：提交预览（选择性提交） ---------- */
test("submit preview panel exists and is fully wired", () => {
  for (const id of ["chatFinal", "chatFinalText", "chatFinalRisk", "chatFinalSend", "chatFinalReview", "chatFinalCancel"]) {
    assert.ok(ids.has(id), "#" + id + " missing");
  }
  has(/el\("chatSubmit"\)\.addEventListener\(\s*"click",\s*onChatSubmitOpen\s*\)/, "chatSubmit -> onChatSubmitOpen");
  has(/function onChatFinal\(mode\)/, "onChatFinal(mode) exists");
  has(/onChatFinal\("direct"\)/, "直接提交 path");
  has(/onChatFinal\("review"\)/, "送审批队列 path");
  has(/el\("chatFinalCancel"\)\.addEventListener\(\s*"click",\s*closeChatFinal\s*\)/, "cancel wired");
  has(/status: direct \? "submitted" : "pending"/, "direct submit records status submitted");
});
test("对话 opens the drawer without config noise; header shows course/due only", () => {
  has(/function startAgentChat\(id, auto\)/, "startAgentChat exists");
  has(/chatSub"\)\.textContent = it\.course \+ " · " \+ dueText\(it\)/, "chatSub shows course/due, no preset/model");
  assert.ok(!/先到「设置 · Agent 对话 API」/.test(app), "old settings nudge text still present");
  has(/auto && !chat\.messages\.length && !_chatBusy/, "auto mode sends the kickoff message");
});

/* ---------- 8. 初始化容错 ---------- */
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
  has(/JSON\.stringify\(\{\s*account:\s*acc,\s*password:\s*pw,\s*remember:\s*el\("lgMode"\)\.value === "local"\s*\}\)/,
      "request body carries account+password+remember");
  has(/err = el\("loginErr"\)/, "error line element bound");
  has(/if\(!res\.ok\)\{[\s\S]{0,300}err\.style\.display = "block";[\s\S]{0,160}return;/, "non-ok response blocks entry and shows the reason");
  has(/if\(!res\.ok\)\{[\s\S]{0,300}return;[\s\S]{0,400}SSO\.set\(acc,\s*pw,/, "SSO.set only runs after the platform says ok");
  has(/登录工作台（平台验证通过）/, "audit log marks the platform-verified login");
});
test("bridge /verify only logs in (no collection) and returns ok/error JSON", () => {
  pyHas(/def do_POST[\s\S]*?self\.path\.startswith\("\/verify"\)/, "syncserver handles POST /verify");
  pyHas(/hzcu_login\(str\(creds\["account"\]\),\s*str\(creds\["password"\]\)\)/,
        "/verify calls hzcu_login with the request creds");
  pyHas(/"ok": False, "error": str\(e\)/, "SyncError surfaces as a readable error field");
});

/* ---------- 8b. 登录链路对准真实平台：城院 CAS → courses.hzcu.edu.cn（Tronclass） ---------- */
test("syncserver logs in via the ZUCC unified-auth CAS into the Tronclass LMS", () => {
  pyHas(/URL_CAS = "https:\/\/ca\.hzcu\.edu\.cn"/, "CAS endpoint of ca.hzcu.edu.cn");
  pyHas(/URL_LMS = "https:\/\/courses\.hzcu\.edu\.cn"/, "data lives on the Tronclass LMS host");
  pyHas(/def hzcu_login\(account, password\)/, "hzcu_login() submits the CAS form");
  pyHas(/"execution": form_info\["execution"\],\s*"_eventId": "submit"/, "CAS form carries execution/_eventId");
  pyHas(/CAS_AES_KEY = b"c6dda3852e2d4be2"/, "CAS password is AES-128-ECB encrypted with the page key");
  pyHas(/class="\[\^"\]\*errorMsg/, "CAS error page is parsed for a readable reason");
  pyHas(/登录后未能建立课程端会话/, "session probe rejects a logged-out shell");
  assert.ok(!/chaoxing/.test(readFileSync(path.join(root, "syncserver.py"), "utf8")),
            "syncserver must not target chaoxing anymore");
});
test("collection targets the Tronclass JSON APIs on courses.hzcu.edu.cn", () => {
  pyHas(/\/api\/my-courses/, "my-courses list API");
  pyHas(/\/api\/todos\?no-intercept=true/, "todos API");
  pyHas(/homework-activities/, "per-course homework API");
  pyHas(/def hzcu_collect\(s\)/, "hzcu_collect() pulls courses/todos/homework");
});
test("login auto-config: verified credentials land in gitignored wb_local.json", () => {
  pyHas(/def save_creds\(account, password\)/, "save_creds() writes wb_local.json on success");
  pyHas(/creds\.get\("remember"\)[\s\S]{0,200}save_creds/, "/verify persists creds only when remember is set");
  const gi = readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.ok(/wb_local\.json/.test(gi), ".gitignore must exclude wb_local.json");
  assert.ok(/wb_platform_cache\.json/.test(gi), ".gitignore must exclude wb_platform_cache.json");
});


/* ---------- 8. AI 对话：默认 Agent + 切换二次确认 ---------- */
test("confirm bar markup exists (agentConfirm / agentConfirmText / btnAgentConfirm / btnAgentCancel)", () => {
  for (const id of ["agentConfirm", "agentConfirmText", "btnAgentConfirm", "btnAgentCancel"]) {
    assert.ok(ids.has(id), "#" + id + " missing");
  }
});
test("clicking a chip only marks pendingAgent; switching requires 确认切换", () => {
  has(/state\.chat\.pendingAgent = id;/, "chip click marks pendingAgent instead of switching");
  has(/state\.chat\.agentId = state\.chat\.pendingAgent;/, "commit happens only in the confirm handler");
  assert.ok(!/state\.chat\.agentId = c\.getAttribute\("data-agent"\)/.test(app),
      "regression: agentGrid click switches instantly again");
  has(/el\("btnAgentConfirm"\)\.addEventListener\(\s*"click"/, "btnAgentConfirm wired");
  has(/el\("btnAgentCancel"\)\.addEventListener\(\s*"click"/, "btnAgentCancel wired");
});
test("default agent: ☆ 设默认 handled before the switch path, default wins on first entry", () => {
  has(/closest\(\s*"\[data-agdef\]"\s*\)/, 'closest("[data-agdef]")');
  const idxDef = app.indexOf('closest("[data-agdef]")');
  const idxSwitch = app.indexOf('closest("[data-agent]")');
  assert.ok(idxDef !== -1 && idxSwitch !== -1 && idxDef < idxSwitch,
      "data-agdef must be checked before data-agent (else setting default triggers a switch)");
  has(/AgentHub\.setDefault\(did\)/, "setDefault called from the grid");
  has(/var def = AgentHub\.getDefault\(\);/, "grid reads the default");
  has(/state\.chat\.agentId = def \|\| recs\[0\]\.id;/, "default wins over Laya recommendation on first entry");
});

/* ---------- 8. 登录后自动同步（autosync.js；回归：登录只存凭据、啥都不干） ---------- */
test("autosync.js is loaded by the page", () => {
  assert.ok(/<script src="autosync\.js"><\/script>/.test(html), 'missing <script src="autosync.js">');
});
test("login success kicks the auto-sync", () => {
  /* onLogin 含 #29 的真实验证流程（远超 700 字符），锚定「凭据写入成功」到钩子的近邻更稳 */
  has(/SSO\.set\(acc, pw, el\("lgMode"\)\.value\);[\s\S]{0,400}autoSyncAfterLogin\(\{ verbose: true \}\)/,
      "onLogin() -> SSO.set ... autoSyncAfterLogin({verbose:true})");
});
test("boot with saved creds auto-syncs too (throttled by autosync.js)", () => {
  has(/safe\("autoSyncOnBoot", function\(\)\{ setTimeout\(function\(\)\{ autoSyncAfterLogin\(\{\}\); \}, 600\); \}\)/,
      'init step safe("autoSyncOnBoot", ...)');
});
test("manual and auto direct-sync share one fetch pipeline", () => {
  has(/function runDirectSync\(opts\)\{[\s\S]{0,200}var auto = !!opts\.auto;/, "runDirectSync(opts) with auto flag");
  has(/function onDirectSync\(\)\{ runDirectSync\(\{ auto: false \}\); \}/, "manual click goes through the shared pipeline");
  has(/applyPlatformPayload\(res\.payload, auto\)/, "auto flag reaches applyPlatformPayload()");
});
test("settings expose the auto-sync toggle and last-run time", () => {
  for (const id of ["asEnabled", "asLast"]) {
    assert.ok(ids.has(id), "#" + id + " missing from the settings view");
  }
  has(/el\("asEnabled"\)\.checked = AutoSync\.isEnabled\(\)/, "checkbox reflects AutoSync state");
  has(/AutoSync\.setEnabled\(el\("asEnabled"\)\.checked\)/, "checkbox writes back");
  has(/renderAutoSyncHint\(\)/, "last-run hint is rendered");
});
test("auto run is marked before fetching (crash-safe throttle state)", () => {
  has(/AutoSync\.markRun\(\);\s*renderAutoSyncHint\(\);[\s\S]{0,400}runDirectSync\(\{ auto: true \}\)/,
      "markRun() happens before runDirectSync({auto:true})");
});

/* ---------- 9. issue #25：选用此版 / 输出格式选择 / ⚡一键提交闭环 ---------- */
test("assistant replies expose 选用此版 and the picked reply is the deliverable", () => {
  has(/data-pick="/, "pick button rendered on assistant bubbles");
  has(/function onChatPick\(i\)/, "onChatPick(i) exists");
  has(/chat\.pick = \(chat\.pick === i\) \? null : i;/, "pick toggles and persists on the chat");
  has(/function chatDeliverable\(\)/, "chatDeliverable() exists");
  assert.ok(/chat\.pick != null[\s\S]{0,300}Agent\.extractDeliverableInfo/.test(app),
      "deliverable extraction honors chat.pick before the default rule");
  has(/el\("chatMsgs"\)\.addEventListener\(\s*"click"/, "pick buttons delegated on the message list");
  has(/chat-b ' \+ m\.role \+ \(picked \? " picked" : ""\)/, "picked bubble gets the picked style");
});
test("output-format select produces .doc/.md/.txt and stores format+file", () => {
  for (const id of ["chatFmt", "chatQuick"]) assert.ok(ids.has(id), "#" + id + " missing");
  for (const opt of ['<option value="doc">', '<option value="md">', '<option value="txt">']) {
    assert.ok(html.includes(opt), "format option missing: " + opt);
  }
  has(/function deliverFile\(fmt, text, it\)/, "deliverFile(fmt, text, it)");
  has(/urn:schemas-microsoft-com:office:word/, ".doc uses an HTML container Word can open");
  has(/function downloadDeliver\(f\)/, "downloadDeliver(f) writes the file locally");
  has(/format: fmtLabel\(fmt, it\)/, "submission record stores format");
  has(/file: f \? f\.name : ""/, "submission record stores the file name");
  has(/localStorage\.setItem\("hwdesk_chatFmt"/, "last format choice is remembered");
});
test("⚡ 一键提交 closes the loop without leaving the workbench", () => {
  has(/el\("chatQuick"\)\.addEventListener\(\s*"click",\s*onChatQuickSubmit\s*\)/, "chatQuick wired");
  has(/function onChatQuickSubmit\(\)/, "onChatQuickSubmit exists");
  has(/function submitDeliverable\(text, fmt, direct\)/, "shared delivery path submitDeliverable");
  has(/it\.status = direct \? "submitted" : "review";/, "pending delivery flips the item to the review queue");
  has(/status: direct \? "submitted" : "pending"/, "submission stays pending until the platform receipt");
  assert.ok(!/window\.open\(/.test(app), "still no window.open anywhere");
});
test("UI cleanup: long help paragraphs are gone", () => {
  assert.ok(!/怎么用？/.test(html), "行动 long how-to paragraph removed");
  assert.ok(!/发送后到所选 AI 自己的窗口/.test(html), "old copy-flow long hint removed");
  assert.ok(!/点开即聊）。想用你自己的模型服务时才填这里/.test(html), "chat setup long hint removed");
});

/* ---------- 10. cloudai 体检接线：发送前 healthCheck 拦下失效链接 ---------- */
test("cloud send probes the gateway with healthCheck before the first chat", () => {
  has(/CloudAI\.healthCheck\(8000\)/, "streamChat probes the gateway via CloudAI.healthCheck(8000)");
  has(/if\(CloudAI\._hcOk\)\{ doCloudChat\(\); return; \}\s*CloudAI\.healthCheck\(8000\)\.then/,
      "the only chat call is gated behind the healthCheck probe");
  has(/var doCloudChat = function\(\)/, "chat call wrapped in doCloudChat for the probe gate");
  has(/cloudChatFail\(chat, \{ error: \{ code: \(hc && hc\.code\) \|\| "gateway_network_error" \} \}\)/,
      "failed probe lands in cloudChatFail with the real healthCheck code");
  has(/CloudAI\._hcOk = true/, "a passing probe is cached for the session");
});
const vbs = readFileSync(path.join(root, "launch-hwdesk-online.vbs"), "utf8");
test("online launcher has no machine-specific hardcoding", () => {
  assert.ok(/GetParentFolderName\(WScript\.ScriptFullName\)/.test(vbs), "repo path auto-detected from the script location");
  assert.ok(!/F:\\hwdesk/.test(vbs), "no hardcoded F:\\hwdesk repo path");
  assert.ok(!/C:\\Users/.test(vbs), "no hardcoded user-directory python path");
  assert.ok(/py\.exe/.test(vbs) && /where python/.test(vbs), "python resolved via py launcher or PATH");
});

console.log("\n" + passed + " passed");
