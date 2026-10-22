/*
 * sso.js 学在城院登录凭据测试（零依赖，Node >= 16）
 * 运行：node test/sso.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
(0, eval)(readFileSync(path.join(root, "sso.js"), "utf8"));
const SSO = globalThis.SSO;

/* 最小 storage 桩 */
function mkStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k)
  };
}
globalThis.localStorage = mkStore();
globalThis.sessionStorage = mkStore();

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

console.log("sso.js " + SSO.version);

/* ---------- 写入与读取 ---------- */
test("set/get roundtrip in local mode", () => {
  SSO.clear();
  assert.equal(SSO.set("3202101234", "p@ss", "local"), true);
  const st = SSO.get();
  assert.equal(st.where, "local");
  assert.equal(st.creds.account, "3202101234");
  assert.equal(st.creds.password, "p@ss");
});
test("session mode writes sessionStorage, not localStorage", () => {
  SSO.clear();
  SSO.set("a1", "p1", "session");
  assert.equal(SSO.get().where, "session");
  assert.equal(localStorage.getItem("wb_hwdesk_sso"), null);
});
test("memory mode touches no storage at all", () => {
  SSO.clear();
  SSO.set("a2", "p2", "memory");
  assert.equal(SSO.get().where, "memory");
  assert.equal(localStorage.getItem("wb_hwdesk_sso"), null);
  assert.equal(sessionStorage.getItem("wb_hwdesk_sso_sess"), null);
});

/* ---------- 优先级与覆盖 ---------- */
test("local takes priority over session and memory", () => {
  SSO.clear();
  SSO.set("mem-user", "pm", "memory");
  SSO.set("sess-user", "ps", "session");
  SSO.set("loc-user", "pl", "local");
  const st = SSO.get();
  assert.equal(st.where, "local");
  assert.equal(st.creds.account, "loc-user");
});
test("new set overwrites previous mode storage", () => {
  SSO.clear();
  SSO.set("old", "p", "local");
  SSO.set("new", "p", "session");
  assert.equal(SSO.get().where, "session");
  assert.equal(localStorage.getItem("wb_hwdesk_sso"), null);
});

/* ---------- 校验 ---------- */
test("set rejects empty account or password", () => {
  SSO.clear();
  assert.equal(SSO.set("", "p", "local"), false);
  assert.equal(SSO.set("a", "", "local"), false);
  assert.equal(SSO.has(), false);
});

/* ---------- 清除 ---------- */
test("clear wipes all three modes", () => {
  SSO.set("a", "p", "local");
  SSO.set("b", "p", "session");
  SSO.set("c", "p", "memory");
  SSO.clear();
  assert.equal(SSO.has(), false);
  assert.equal(localStorage.getItem("wb_hwdesk_sso"), null);
  assert.equal(sessionStorage.getItem("wb_hwdesk_sso_sess"), null);
});

/* ---------- 打码 ---------- */
test("mask hides middle of long account", () => {
  assert.equal(SSO.mask("3202101234"), "3202****234");
});
test("mask handles short and tiny accounts", () => {
  assert.equal(SSO.mask("abcd1234"), "ab****34");
  assert.equal(SSO.mask("abc"), "***");
  assert.equal(SSO.mask(""), "");
});

/* ---------- 采集指令片段 ---------- */
test("snippet without password never leaks it", () => {
  SSO.clear();
  SSO.set("3202101234", "SECRET", "local");
  const s = SSO.instructionSnippet({});
  assert.ok(s.includes("3202101234"));
  assert.ok(!s.includes("SECRET"));
  assert.ok(s.includes("向我要"));
});
test("snippet with includePassword embeds it plus warning", () => {
  const s = SSO.instructionSnippet({ includePassword: true });
  assert.ok(s.includes("SECRET"));
  assert.ok(s.includes("禁止写入日志"));
});
test("snippet empty when no credentials stored", () => {
  SSO.clear();
  assert.equal(SSO.instructionSnippet({ includePassword: true }), "");
});

console.log(passed + " passed, " + (process.exitCode ? 1 : 0) + " failed");
if (!process.exitCode) console.log("ALL PASS");
