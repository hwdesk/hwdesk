/*
 * cloudai.js 云端通道回归测试（零依赖，Node >= 16）
 * 运行：node test/cloudai.test.mjs
 *
 * 背景（#42）：gateway_network_error 是浏览器 fetch() 连响应都没拿到的
 * 网络层失败（发布站点下线 / 非发布页打开 / 代理拦截），却被
 * errText() 的 gateway_* 兜底误标成「模型服务暂时不可用，请重试一次」，
 * 误导排查方向。这里守住：网络层失败必须说清真实原因，其余前缀分支不回退。
 *
 * 背景（#45）：发布链接全体同时失效是单点故障——守住三件加固：
 * ① applyConfig 按机覆盖（合法才合并落盘、非法整单拒绝、init() 启动即读）；
 * ② healthCheck 主动体检（ok/network-fail/timeout/http-error 四路稳定错误码）；
 * ③ errText 文案不回退（原有 8 项断言原样保留）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

/* 在 vm 沙箱里执行 cloudai.js（浏览器 IIFE：window.CloudAI） */
const src = readFileSync(path.join(root, "cloudai.js"), "utf8");

/* 默认实例：errText 文案断言用（无需 localStorage / fetch） */
const plainSandbox = { window: {} };
vm.runInNewContext(src, plainSandbox);
const CloudAI = plainSandbox.window.CloudAI;

assert.ok(CloudAI && typeof CloudAI.errText === "function", "cloudai.js 应在 window.CloudAI 上暴露 errText()");

let passed = 0;

/* —— #45 沙箱脚手架：可注入 localStorage / fetch / WorkBuddyCloud 的全新实例 —— */
function mockStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}
function mockCloudSdk() {
  const calls = [];
  return {
    calls,
    WorkBuddyCloud: {
      createWorkBuddyCloud: (cfg) => { calls.push(cfg); return { cfg, fake: true }; },
    },
  };
}
function makeCloudAI(mocks) {
  const sandbox = {
    window: {},
    URL, Promise, setTimeout, clearTimeout, AbortController, console,
  };
  Object.assign(sandbox.window, mocks || {});
  vm.runInNewContext(src, sandbox);
  return sandbox.window.CloudAI;
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/* ============ errText 文案（#42，原 8 项原样保留） ============ */
const err = (code) => ({ error: { code } });
const text = (code) => CloudAI.errText(err(code));

test("gateway_network_error 不再谎报「模型服务暂时不可用」", () => {
  const t = text("gateway_network_error");
  assert.ok(!t.includes("模型服务暂时不可用"), "不得复用模型不可用文案: " + t);
  assert.ok(!t.includes("请重试一次"), "重试提示救不了下线的站点: " + t);
});

test("gateway_network_error 指出真实原因与入口", () => {
  const t = text("gateway_network_error");
  assert.ok(t.includes("gateway_network_error"), "保留原始错误码便于检索");
  assert.ok(t.includes("无法连接云端网关"), "点明是网络层连不上网关: " + t);
  assert.ok(t.includes(CloudAI.config.endpoint), "带上出问题的网关端点: " + t);
  assert.ok(t.includes("链接已失效"), "提及发布站点下线的特征: " + t);
  assert.ok(t.includes("API Key"), "给出可操作的兜底出路: " + t);
});

test("其余 gateway_* 前缀仍走「模型服务暂时不可用」兜底", () => {
  const t = text("gateway_invalid_response");
  assert.ok(t.includes("模型服务暂时不可用") && t.includes("gateway_invalid_response"));
});

test("model_* 前缀仍走「模型服务暂时不可用」兜底", () => {
  const t = text("model_overloaded");
  assert.ok(t.includes("模型服务暂时不可用") && t.includes("model_overloaded"));
});

test("auth_* 仍是鉴权失败提示", () => {
  const t = text("auth_origin_denied");
  assert.ok(t.includes("鉴权失败") && t.includes("auth_origin_denied"));
});

test("quota_* 仍是额度受限提示", () => {
  const t = text("quota_exceeded");
  assert.ok(t.includes("额度受限") && t.includes("quota_exceeded"));
});

test("request_* 仍是请求参数提示", () => {
  const t = text("request_bad_param");
  assert.ok(t.includes("请求参数问题") && t.includes("request_bad_param"));
});

test("无错误码 / 未知结构走通用兜底，且原样透出 message", () => {
  const t1 = CloudAI.errText({ message: "boom" });
  assert.ok(t1.includes("云端通道请求失败") && t1.includes("boom"));
  const t2 = CloudAI.errText(null);
  assert.ok(t2.includes("云端通道请求失败"), "null 也不能抛异常");
});

test("gateway_network_error 透出底层错误便于定位（截 140 字）", () => {
  const t = CloudAI.errText({ message: "Network error: Failed to fetch", error: { code: "gateway_network_error" } });
  assert.ok(t.includes("底层错误"), "应有底层错误段落: " + t);
  assert.ok(t.includes("Failed to fetch"), "应包含底层 cause: " + t);
});

test("无底层信息时不追加空的底层错误段落", () => {
  const t = text("gateway_network_error");
  assert.ok(!t.includes("底层错误"), "不该有空段落: " + t);
});

/* ============ applyConfig / loadOverrides 按机覆盖（#45） ============ */

test("applyConfig 合法覆盖：合并 + 客户端重建，init() 用新 endpoint", async () => {
  const sdk = mockCloudSdk();
  const C = makeCloudAI({ localStorage: mockStorage(), ...sdk });
  C.init();                                   /* 先用内置配置建一次客户端 */
  assert.equal(sdk.calls.length, 1);
  const r = C.applyConfig({ endpoint: "https://new-gw.example.com" });
  assert.ok(r.ok === true, "合法覆盖应成功: " + JSON.stringify(r));
  assert.equal(C.config.endpoint, "https://new-gw.example.com", "config 应已合并覆盖");
  assert.equal(C.client, null, "客户端应被重置等待重建");
  C.init();
  assert.equal(sdk.calls.length, 2, "init() 应重建客户端");
  assert.equal(sdk.calls[1].endpoint, "https://new-gw.example.com", "重建必须用新 endpoint");
});

test("applyConfig 落盘本机 localStorage（hwdesk.cloudai.overrides）", async () => {
  const store = mockStorage();
  const C = makeCloudAI({ localStorage: store });
  const r = C.applyConfig({ endpoint: "https://ov.example.com", publishableKey: "wbpk_abc123" });
  assert.ok(r.ok === true);
  const raw = store.getItem("hwdesk.cloudai.overrides");
  assert.ok(raw, "覆盖应持久化到 localStorage");
  const saved = JSON.parse(raw);
  assert.equal(saved.endpoint, "https://ov.example.com");
  assert.equal(saved.publishableKey, "wbpk_abc123");
});

test("applyConfig 非法输入整单拒绝：config / 落盘零改动", async () => {
  const store = mockStorage();
  const C = makeCloudAI({ localStorage: store });
  const r0 = C.applyConfig({ endpoint: "https://good.example.com" });
  assert.ok(r0.ok === true);
  const before = JSON.stringify(C.config);
  const rawBefore = store.getItem("hwdesk.cloudai.overrides");

  assert.ok(C.applyConfig({ endpoint: "http://insecure.example.com" }).ok === false, "非 https 拒绝");
  assert.ok(C.applyConfig({ publishableKey: "sk-not-wbpk" }).ok === false, "非 wbpk_ 前缀拒绝");
  const mixed = C.applyConfig({ endpoint: "https://also-good.example.com", publishableKey: "bad" });
  assert.ok(mixed.ok === false, "同单混入非法值 → 整单拒绝");
  assert.equal(C.config.endpoint, "https://good.example.com", "合法的一半也不许合并进来");
  assert.ok(C.applyConfig({ endpoint: "https://x.example.com", evil: 1 }).ok === false, "未知键拒绝");
  assert.equal(JSON.stringify(C.config), before, "config 不得被非法调用改动");
  assert.equal(store.getItem("hwdesk.cloudai.overrides"), rawBefore, "落盘不得被非法调用改动");
});

test("init() 启动即读本机覆盖（换站点不等新版）", async () => {
  const sdk = mockCloudSdk();
  const store = mockStorage({
    "hwdesk.cloudai.overrides": JSON.stringify({
      endpoint: "https://transition-gw.example.com",
      publishableKey: "wbpk_transient",
    }),
  });
  const C = makeCloudAI({ localStorage: store, ...sdk });
  const c = C.init();
  assert.ok(c && c.fake, "init() 应建客户端");
  assert.equal(sdk.calls[0].endpoint, "https://transition-gw.example.com");
  assert.equal(sdk.calls[0].publishableKey, "wbpk_transient");
});

test("loadOverrides 忽略脏数据（坏 JSON / 非法值不炸不生效）", async () => {
  const sdk = mockCloudSdk();
  const store = mockStorage({ "hwdesk.cloudai.overrides": "{not json" });
  const C = makeCloudAI({ localStorage: store, ...sdk });
  C.init();
  assert.equal(sdk.calls[0].endpoint, C.config.endpoint, "脏 JSON 不抛异常");

  const store2 = mockStorage({ "hwdesk.cloudai.overrides": JSON.stringify({ endpoint: "ftp://bad" }) });
  const C2 = makeCloudAI({ localStorage: store2, ...sdk });
  C2.init();
  assert.notEqual(sdk.calls[sdk.calls.length - 1].endpoint, "ftp://bad", "非法覆盖值不生效");
});

/* ============ healthCheck 主动体检（#45） ============ */

test("healthCheck 网关正常 → ok:true + models（含覆盖后的 endpoint 与正确认证头）", async () => {
  let seenUrl = "", seenHeaders = null;
  const fetchMock = async (url, opts) => {
    seenUrl = url; seenHeaders = opts.headers;
    return { ok: true, status: 200, json: async () => [{ id: "auto" }, { id: "hy4-preview" }] };
  };
  const C = makeCloudAI({ fetch: fetchMock, localStorage: mockStorage() });
  C.applyConfig({ endpoint: "https://probe-gw.example.com" });
  const r = await C.healthCheck(500);
  assert.ok(r.ok === true, "应探活成功: " + JSON.stringify(r));
  assert.deepEqual(r.models.map((m) => m.id), ["auto", "hy4-preview"]);
  assert.equal(seenUrl, "https://probe-gw.example.com/.cloud/llm/models", "探测地址 = 覆盖后 endpoint + 模型目录");
  assert.equal(seenHeaders["x-wb-webapp-access-key"], C.config.publishableKey, "认证头必须是 x-wb-webapp-access-key");
});

test("healthCheck fetch 拒绝 → gateway_network_error", async () => {
  const C = makeCloudAI({ fetch: async () => { throw new Error("ECONNREFUSED"); }, localStorage: mockStorage() });
  const r = await C.healthCheck(500);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gateway_network_error");
});

test("healthCheck 超时 → gateway_timeout（AbortController 真实生效）", async () => {
  const fetchHangs = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const C = makeCloudAI({ fetch: fetchHangs, localStorage: mockStorage() });
  const r = await C.healthCheck(20);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gateway_timeout");
});

test("healthCheck 非 2xx → gateway_http_<状态码>", async () => {
  const C = makeCloudAI({
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    localStorage: mockStorage(),
  });
  const r = await C.healthCheck(500);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gateway_http_404");
});

test("healthCheck 响应不是合法 JSON → gateway_invalid_response", async () => {
  const C = makeCloudAI({
    fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } }),
    localStorage: mockStorage(),
  });
  const r = await C.healthCheck(500);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gateway_invalid_response");
});

test("errText: 403 → 链接不完整 / 404 → 链接已失效（不掉进「模型服务暂时不可用」兜底）", () => {
  const t403 = CloudAI.errText(err("gateway_http_403"));
  assert.ok(t403.includes("链接不完整"), "403 must say 链接不完整");
  assert.ok(!t403.includes("模型服务暂时不可用"), "403 must not hit the gateway_ fallback");
  const t404 = CloudAI.errText(err("gateway_http_404"));
  assert.ok(t404.includes("链接已失效"), "404 must say 链接已失效");
  assert.ok(!t404.includes("模型服务暂时不可用"), "404 must not hit the gateway_ fallback");
  assert.ok(!t404.includes("链接不完整"), "404 must not tell users to re-open with sharecode");
  const tn = CloudAI.errText(err("gateway_network_error"));
  assert.ok(tn.includes("链接不完整") && tn.includes("链接已失效"), "network_error copy covers both states");
});

/* ============ contextHints 打开方式自检（#54） ============ */
/* 裸 vm 上下文没有 URL 全局，isPublishedHost 判定需要带 URL 的沙箱实例 */
const C54 = makeCloudAI({});
test("contextHints: file:// 打开 → isFile，需横幅", () => {
  const h = C54.contextHints({ protocol: "file:", search: "", hostname: "" });
  assert.equal(h.isFile, true);
  assert.equal(h.hasSharecode, false);
});
test("contextHints: 完整分享链接 → isPublishedHost 且带 sharecode", () => {
  const h = C54.contextHints({ protocol: "https:", search: "?sharecode=COAVIMSN3Z",
    hostname: "hwdesk-workbench-95242.app.workbuddy.host" });
  assert.equal(h.isFile, false);
  assert.equal(h.isPublishedHost, true);
  assert.equal(h.hasSharecode, true);
});
test("contextHints: 发布域名但缺 sharecode → 横幅条件成立", () => {
  const h = C54.contextHints({ protocol: "https:", search: "",
    hostname: "hwdesk-workbench-95242.app.workbuddy.host" });
  assert.equal(h.isPublishedHost, true);
  assert.equal(h.hasSharecode, false);
});
test("contextHints: fullLink = endpoint + /?sharecode=…，第三方域名不算发布域", () => {
  const h = C54.contextHints({ protocol: "https:", search: "", hostname: "example.com" });
  assert.ok(h.fullLink.indexOf(C54.config.endpoint + "/?sharecode=") === 0);
  assert.equal(h.isPublishedHost, false);
});
test("applyConfig: sharecode 可合法覆盖、非法值整单拒绝", () => {
  const s = mockStorage({});
  const C = makeCloudAI({ localStorage: s });
  assert.equal(C.applyConfig({ sharecode: "COAVIMSN3Z" }).ok, true);
  const bad = C.applyConfig({ sharecode: "has space" });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "invalid_sharecode");
});

/* ============ diagnose 网络失败现场诊断（收窄 errText 罗列的 ①②③） ============ */

/* makeCloudAI 的沙箱不带 location；diagnose 依赖 contextHints 读全局 location，
 * 这里补一个可注入 location 的变体（mocks 仍进 window）。 */
function makeCloudAIAt(loc, mocks) {
  const sandbox = {
    window: {},
    URL, Promise, setTimeout, clearTimeout, AbortController, console,
  };
  if (loc !== undefined) sandbox.location = loc;
  Object.assign(sandbox.window, mocks || {});
  vm.runInNewContext(src, sandbox);
  return sandbox.window.CloudAI;
}
function diagnoseMsg(C) {
  return new Promise((resolve) => C.diagnose((m) => resolve(m)));
}

test("diagnose: 重探测通过 → 判定瞬时抖动/代理干扰，提示可直接重试、不说站点下线", async () => {
  const C = makeCloudAIAt(undefined, {
    fetch: async () => ({ ok: true, status: 200, json: async () => [{ id: "auto" }] }),
    localStorage: mockStorage(),
  });
  const msg = await diagnoseMsg(C);
  assert.ok(msg.includes("重试"), "应告诉用户可直接重试: " + msg);
  assert.ok(msg.includes("代理"), "应点出代理干扰的可能性: " + msg);
  assert.ok(!msg.includes("已下线") && !msg.includes("file://"), "探活通过就不该翻旧账: " + msg);
});

test("diagnose: file:// 打开 → 指向打开方式，别让用户去查网络", async () => {
  const C = makeCloudAIAt(
    { protocol: "file:", search: "", hostname: "" },
    { fetch: async () => { throw new Error("net down"); }, localStorage: mockStorage() },
  );
  const msg = await diagnoseMsg(C);
  assert.ok(msg.includes("file://"), "应指出 file:// 打开没有云端权限: " + msg);
  assert.ok(msg.includes("API Key"), "给出兜底出路: " + msg);
});

test("diagnose: 发布域名但缺 sharecode → 指向完整分享链接", async () => {
  const C = makeCloudAIAt(
    { protocol: "https:", search: "", hostname: "hwdesk-workbench-95242.app.workbuddy.host" },
    { fetch: async () => { throw new Error("net down"); }, localStorage: mockStorage() },
  );
  const msg = await diagnoseMsg(C);
  assert.ok(msg.includes("sharecode"), "应要求带 sharecode 的完整链接: " + msg);
});

test("diagnose: 重探测也失败 → 承认网关不可达（下线/网络代理拦截）+ 兜底出路", async () => {
  const C = makeCloudAIAt(undefined, {
    fetch: async () => { throw new Error("ECONNREFUSED"); },
    localStorage: mockStorage(),
  });
  const msg = await diagnoseMsg(C);
  assert.ok(msg.includes("连不上"), "应承认网关不可达: " + msg);
  assert.ok(msg.includes("代理") && msg.includes("API Key"), "可操作结论 + 兜底出路: " + msg);
});

test("diagnose: 重探测失败时带回真实错误码（gateway_timeout 也要出现在文案里）", async () => {
  const fetchHangs = (url, opts) => new Promise((resolve, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("The operation was aborted");
      e.name = "AbortError";
      reject(e);
    });
  });
  const C = makeCloudAIAt(undefined, { fetch: fetchHangs, localStorage: mockStorage() });
  const msg = await diagnoseMsg(C);
  assert.ok(msg.includes("gateway_timeout"), "保留真实探测错误码便于检索: " + msg);
});

test("diagnose: 无 fetch 环境（旧内核）同步回退提示且不抛异常", async () => {
  const sandbox = { window: {}, URL, Promise, setTimeout, clearTimeout, AbortController, console };
  Object.assign(sandbox.window, { localStorage: mockStorage() });
  vm.runInNewContext(src, sandbox);
  const C = sandbox.window.CloudAI;
  let msg = null;
  C.diagnose((m) => { msg = m; });
  assert.ok(msg && msg.includes("API Key"), "无 fetch 应回退到填 Key 的提示: " + msg);
});

/* ============ runner（异步感知） ============ */
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log("  ok - " + t.name);
    } catch (e) {
      console.error("  FAIL - " + t.name + "\n    " + String(e.message).split("\n")[0]);
      process.exitCode = 1;
    }
  }
  console.log("\ncloudai.test.mjs: " + passed + " passed" + (process.exitCode ? " (with failures)" : ""));
})();
