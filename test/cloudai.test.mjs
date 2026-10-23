/*
 * cloudai.js 云端通道回归测试（零依赖，Node >= 16）
 * 运行：node test/cloudai.test.mjs
 *
 * 守住两块：
 * 1) errText 人话映射（#42）：gateway_network_error 不许谎报「模型服务暂时不可用」，
 *    必须说清真实原因并透出底层错误（#45 补充）；
 * 2) 配置完备化（#45）：applyConfig 按机覆盖（校验/持久化/重建客户端）、
 *    init() 回放覆盖、healthCheck 三类失败给出稳定错误码。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const src = readFileSync(path.join(root, "cloudai.js"), "utf8");

/* 沙箱工厂：mock localStorage + fetch（+ AbortController），隔离每个用例 */
function makeSandbox(fetchImpl) {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const window = { localStorage, fetch: fetchImpl };
  const ctx = { window, AbortController, setTimeout, clearTimeout };
  vm.runInNewContext(src, ctx);
  return { CloudAI: window.CloudAI, store, window };
}

let passed = 0;
let failed = 0;
const pending = [];
function test(name, fn) {
  const run = Promise.resolve().then(fn).then(() => {
    passed++;
    console.log("  ok - " + name);
  }, (e) => {
    failed++;
    process.exitCode = 1;
    console.error("  FAIL - " + name + "\n    " + String(e.message).split("\n")[0]);
  });
  if (fn && fn.constructor.name === "AsyncFunction") pending.push(run);
}

/* ---------- errText ---------- */

{
  const { CloudAI } = makeSandbox();
  const text = (code) => CloudAI.errText({ error: { code } });

  test("gateway_network_error 不再谎报「模型服务暂时不可用」", () => {
    const t = text("gateway_network_error");
    assert.ok(!t.includes("模型服务暂时不可用"), "不得复用模型不可用文案: " + t);
    assert.ok(t.includes("无法连接云端网关"), "点明网络层失败: " + t);
    assert.ok(t.includes(CloudAI.config.endpoint), "带上网关端点: " + t);
    assert.ok(t.includes("链接已失效"), "提及发布站点下线特征: " + t);
    assert.ok(t.includes("API Key"), "给出兜底出路: " + t);
  });

  test("gateway_network_error 透出底层错误便于定位（#45）", () => {
    const t = CloudAI.errText({ message: "Network error: Failed to fetch", error: { code: "gateway_network_error" } });
    assert.ok(t.includes("底层错误"), "应有底层错误段落: " + t);
    assert.ok(t.includes("Failed to fetch"), "应包含 cause: " + t);
  });

  test("无底层信息时不追加空的底层错误段落", () => {
    const t = text("gateway_network_error");
    assert.ok(!t.includes("底层错误"));
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
}

/* ---------- applyConfig / loadOverrides / init ---------- */

test("applyConfig 合法覆盖：合并 + 持久化 + 重建客户端", () => {
  const { CloudAI, store } = makeSandbox();
  CloudAI.client = { old: true };
  const r = CloudAI.applyConfig({ endpoint: "https://new-gw.example.com/" });
  assert.ok(r.ok);
  assert.equal(CloudAI.config.endpoint, "https://new-gw.example.com", "末尾斜杠应被剥掉");
  assert.equal(CloudAI.client, null, "客户端应被置空待重建");
  assert.ok(CloudAI.config.publishableKey.startsWith("wbpk_"));
  const saved = JSON.parse(store[CloudAI.OVERRIDES_KEY]);
  assert.equal(saved.endpoint, "https://new-gw.example.com");
});

test("applyConfig 拒绝 http:// endpoint，且不改动不落盘", () => {
  const { CloudAI, store } = makeSandbox();
  const before = CloudAI.config.endpoint;
  const r = CloudAI.applyConfig({ endpoint: "http://insecure.example.com" });
  assert.ok(!r.ok && r.error.includes("https"));
  assert.equal(CloudAI.config.endpoint, before, "配置不得被改动");
  const savedRaw = store[CloudAI.OVERRIDES_KEY];
  assert.ok(!savedRaw || !savedRaw.includes("insecure"), "非法值不得落盘");
});

test("applyConfig 拒绝非 wbpk_ 前缀的 key", () => {
  const { CloudAI } = makeSandbox();
  const r = CloudAI.applyConfig({ publishableKey: "sk-xxx" });
  assert.ok(!r.ok && r.error.includes("wbpk_"));
});

test("init() 回放 localStorage 覆盖并用于建客户端", () => {
  const sb2 = makeSandbox();
  sb2.store[sb2.CloudAI.OVERRIDES_KEY] = JSON.stringify({
    endpoint: "https://override.example.com", publishableKey: "wbpk_abc"
  });
  sb2.window.WorkBuddyCloud = { createWorkBuddyCloud: (cfg) => ({ __cfg: cfg }) };
  const client = sb2.CloudAI.init();
  assert.ok(client, "init 应返回客户端");
  assert.equal(client.__cfg.endpoint, "https://override.example.com");
  assert.equal(client.__cfg.publishableKey, "wbpk_abc");
});

test("坏覆盖数据不致命：loadOverrides 返回 null，init 用内置配置", () => {
  const sb = makeSandbox();
  sb.store[sb.CloudAI.OVERRIDES_KEY] = "{not json";
  assert.equal(sb.CloudAI.loadOverrides(), null);
  sb.window.WorkBuddyCloud = { createWorkBuddyCloud: (cfg) => ({ __cfg: cfg }) };
  const client = sb.CloudAI.init();
  assert.equal(client.__cfg.endpoint, sb.CloudAI.config.endpoint);
});

/* ---------- healthCheck ---------- */

test("healthCheck ok：统计未 disabled 的模型数", async () => {
  const sb = makeSandbox(async () => ({
    ok: true, status: 200,
    json: async () => [{ id: "a" }, { id: "b", disabled: true }, { id: "c", disabled: false }],
  }));
  const r = await sb.CloudAI.healthCheck(5000);
  assert.equal(r.ok, true);
  assert.equal(r.modelCount, 2);
});

test("healthCheck 网络失败 → gateway_network_error", async () => {
  const sb = makeSandbox(async () => { throw new TypeError("Failed to fetch"); });
  const r = await sb.CloudAI.healthCheck(5000);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gateway_network_error");
  assert.ok(String(r.detail).includes("Failed to fetch"));
});

test("healthCheck 超时 → gateway_timeout", async () => {
  const sb = makeSandbox((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
  }));
  const r = await sb.CloudAI.healthCheck(30);
  assert.equal(r.ok, false);
  assert.equal(r.code, "gateway_timeout");
});

test("healthCheck 非 2xx → gateway_http_<status>", async () => {
  const sb = makeSandbox(async () => ({ ok: false, status: 404, json: async () => ({}) }));
  const r = await sb.CloudAI.healthCheck(5000);
  assert.equal(r.code, "gateway_http_404");
});

test("healthCheck 非 JSON 响应 → gateway_invalid_response", async () => {
  const sb = makeSandbox(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("bad json"); } }));
  const r = await sb.CloudAI.healthCheck(5000);
  assert.equal(r.code, "gateway_invalid_response");
});

const summary = () =>
  console.log("\ncloudai.test.mjs: " + passed + " passed" + (failed ? ", " + failed + " FAILED" : ""));
if (pending.length) await Promise.all(pending);
summary();
