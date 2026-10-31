/*
 * verifynet.js 登录验证通道选择测试（零依赖，Node >= 16）
 * 运行：node test/verifynet.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
(0, eval)(readFileSync(path.join(root, "verifynet.js"), "utf8"));
const VerifyNet = globalThis.VerifyNet;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("  ok - " + name);
    passed++;
  } catch (e) {
    console.log("FAIL - " + name + ": " + e.message);
    process.exitCode = 1;
  }
}

function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}

/* ---------- 端点顺序 ---------- */
test("default endpoints: local first, then cloud", () => {
  const eps = VerifyNet.endpoints({});
  assert.equal(eps[0].kind, "local");
  assert.ok(eps[0].url.startsWith("http://127.0.0.1"));
  assert.ok(eps.slice(1).every((e) => e.kind === "cloud"));
  assert.ok(eps.length >= 2);
});
test("localAlive=false pushes local to the tail (retry once at the end)", () => {
  const eps = VerifyNet.endpoints({}, false);
  assert.equal(eps[eps.length - 1].kind, "local");
  assert.ok(eps.slice(0, -1).every((e) => e.kind === "cloud"));
});
test("overrides can replace localUrl and cloudUrls (trailing slashes trimmed)", () => {
  const eps = VerifyNet.endpoints(
    VerifyNet.normalizeOverrides(
      { localUrl: "http://127.0.0.1:9999/", cloudUrls: ["https://v.example.com/"] }
    ).patch
  );
  assert.equal(eps[0].url, "http://127.0.0.1:9999");
  assert.deepEqual(eps.slice(1).map((e) => e.url), ["https://v.example.com"]);
});
test("default cloud endpoint carries a sharecode (platform gateway requires it)", () => {
  const cloud = VerifyNet.endpoints({}).filter((e) => e.kind === "cloud");
  assert.ok(cloud.length >= 1);
  assert.ok(cloud.every((e) => /^[A-Za-z0-9]{4,64}$/.test(e.sharecode)));
});
test("verifyPath appends ?sharecode only for endpoints that have one", () => {
  assert.equal(VerifyNet.verifyPath({ url: "http://127.0.0.1:8765/", sharecode: "" }),
               "http://127.0.0.1:8765/verify");
  assert.equal(
    VerifyNet.verifyPath({ url: "https://v.example.com", sharecode: "ABCD1234" }),
    "https://v.example.com/verify?sharecode=ABCD1234");
});
test("cloudUrls accept both plain strings and {url, sharecode} objects", () => {
  const n = VerifyNet.normalizeOverrides(
    { cloudUrls: ["https://a.example.com", { url: "https://b.example.com/", sharecode: "S1X2Y3Z4" }] });
  assert.equal(n.ok, true);
  assert.deepEqual(n.patch.cloudUrls, [
    { url: "https://a.example.com", sharecode: "" },
    { url: "https://b.example.com", sharecode: "S1X2Y3Z4" }
  ]);
});
test("cloudUrls with a malformed sharecode are rejected wholesale", () => {
  assert.equal(VerifyNet.normalizeOverrides(
    { cloudUrls: [{ url: "https://b.example.com", sharecode: "not ok!" }] }).code,
    "invalid_cloud_urls");
});

/* ---------- 覆盖校验 ---------- */
test("normalizeOverrides rejects bad input wholesale", () => {
  assert.equal(VerifyNet.normalizeOverrides(null).ok, false);
  assert.equal(VerifyNet.normalizeOverrides("x").ok, false);
  assert.equal(VerifyNet.normalizeOverrides({ localUrl: "ftp://x" }).code, "invalid_local_url");
  assert.equal(VerifyNet.normalizeOverrides({ cloudUrls: [] }).code, "invalid_cloud_urls");
  assert.equal(VerifyNet.normalizeOverrides({ cloudUrls: ["notaurl"] }).code, "invalid_cloud_urls");
  assert.equal(VerifyNet.normalizeOverrides({}).ok, true);
});
test("overrides round-trip through the store; corrupt JSON reads as none", () => {
  const store = mkStore();
  const r = VerifyNet.saveOverrides(store, { localUrl: "http://127.0.0.1:9999" });
  assert.equal(r.ok, true);
  assert.deepEqual(VerifyNet.loadOverrides(store), { localUrl: "http://127.0.0.1:9999" });
  store.setItem(VerifyNet.OVERRIDES_KEY, "{broken");
  assert.deepEqual(VerifyNet.loadOverrides(store), {});
  assert.equal(VerifyNet.clearOverrides(store), true);
  assert.deepEqual(VerifyNet.loadOverrides(store), {});
});
test("invalid overrides in storage are ignored (never block login)", () => {
  const store = mkStore();
  store.setItem(VerifyNet.OVERRIDES_KEY, JSON.stringify({ localUrl: "javascript:alert(1)" }));
  assert.deepEqual(VerifyNet.loadOverrides(store), {});
});

/* ---------- 结果分类 ---------- */
test("classify: 2xx+ok=true -> ok", () => {
  assert.equal(VerifyNet.classify(200, { ok: true }), "ok");
});
test("classify: 404 or not-found body -> stale (downgrade allowed)", () => {
  assert.equal(VerifyNet.classify(404, { error: "not found" }), "stale");
  assert.equal(VerifyNet.classify(200, { ok: false, error: "not found" }), "stale");
});
test("classify: 5xx -> unreachable (downgrade allowed)", () => {
  assert.equal(VerifyNet.classify(500, {}), "unreachable");
  assert.equal(VerifyNet.classify(503, { error: "boom" }), "unreachable");
});
test("classify: explicit rejection -> rejected (never downgrade)", () => {
  assert.equal(VerifyNet.classify(200, { ok: false, error: "统一身份认证登录失败：用户名或密码错误" }), "rejected");
});
test("classify: anything else -> unreachable", () => {
  assert.equal(VerifyNet.classify(200, { ok: false }), "unreachable");
  assert.equal(VerifyNet.classify(401, {}), "unreachable");
});
test("classifyError: abort -> timeout; others -> unreachable", () => {
  assert.equal(VerifyNet.classifyError({ name: "AbortError" }), "timeout");
  assert.equal(VerifyNet.classifyError(new TypeError("fetch failed")), "unreachable");
});

/* ---------- 兜底提示 ---------- */
test("allDownHint mentions both paths when cloud configured", () => {
  const hint = VerifyNet.allDownHint(VerifyNet.endpoints({}));
  assert.ok(/本机/.test(hint) && /云端/.test(hint) && /python syncserver\.py/.test(hint));
});
test("allDownHint notes unconfigured cloud", () => {
  const hint = VerifyNet.allDownHint([{ url: "http://127.0.0.1:8765", kind: "local" }]);
  assert.ok(/未配置/.test(hint));
});

console.log("\n" + passed + " passed");
if (process.exitCode) console.log("ALL FAIL");
else console.log("ALL PASS");
