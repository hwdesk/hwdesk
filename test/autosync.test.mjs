/*
 * autosync.js 测试（零依赖，Node >= 16）
 * 运行：node test/autosync.test.mjs
 *
 * 覆盖登录后自动同步的纯计算层：节流判定（含 force）、设置持久化、
 * 损坏数据容错、等待时间人类可读化、结果摘要拼接。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

/* 极简 localStorage 桩：每个用例前重置 */
function makeLS() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _dump: () => Object.fromEntries(m),
  };
}

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

const NOW = "2026-10-22T15:00:00.000Z";
const BASE = { enabled: true, hasCreds: true, lastRun: "", now: NOW };

console.log("autosync.js 加载 + shouldRun 决策");

/* ---------- 加载（注入 localStorage 桩） ---------- */
globalThis.localStorage = makeLS();
(0, eval)(readFileSync(path.join(root, "autosync.js"), "utf8"));
const AutoSync = globalThis.AutoSync;
assert.ok(AutoSync && AutoSync.version, "AutoSync global missing");

/* ---------- shouldRun ---------- */
test("凭据 + 默认无历史 → 应当同步", () => {
  assert.deepEqual(AutoSync.shouldRun(BASE), { run: true, reason: "ok", detail: "" });
});

test("开关关闭 → disabled，且优先于其他条件", () => {
  const r = AutoSync.shouldRun({ ...BASE, enabled: false, hasCreds: false });
  assert.equal(r.run, false);
  assert.equal(r.reason, "disabled");
});

test("无凭据 → no-creds（关了门禁/刚退出登录时不瞎跑）", () => {
  const r = AutoSync.shouldRun({ ...BASE, hasCreds: false });
  assert.equal(r.run, false);
  assert.equal(r.reason, "no-creds");
});

test("30 分钟窗口内重复登录 → throttled，detail 带可读等待时间", () => {
  const last = "2026-10-22T14:50:00.000Z"; // 10 分钟前
  const r = AutoSync.shouldRun({ ...BASE, lastRun: last });
  assert.equal(r.run, false);
  assert.equal(r.reason, "throttled");
  assert.match(r.detail, /分钟/);
  assert.match(r.detail, /手动/);
});

test("窗口已过 → 再次放行", () => {
  const last = "2026-10-22T13:00:00.000Z"; // 2 小时前
  assert.equal(AutoSync.shouldRun({ ...BASE, lastRun: last }).run, true);
});

test("force = true 无视节流窗口", () => {
  const last = "2026-10-22T14:59:00.000Z"; // 1 分钟前
  const r = AutoSync.shouldRun({ ...BASE, lastRun: last, force: true });
  assert.equal(r.run, true);
  assert.equal(r.reason, "ok");
});

test("损坏的 lastRun（非 ISO）→ 容错放行，不抛错", () => {
  for (const bad of ["", "不是时间", "2026-13-99 99:99", null]) {
    const r = AutoSync.shouldRun({ ...BASE, lastRun: bad });
    assert.equal(r.run, true, "lastRun=" + JSON.stringify(bad));
  }
});

test("minIntervalMinutes = 0 → 每次登录都同步", () => {
  const last = "2026-10-22T14:59:59.000Z";
  assert.equal(AutoSync.shouldRun({ ...BASE, lastRun: last, minIntervalMinutes: 0 }).run, true);
});

test("minIntervalMinutes 非法（负数/字符串）→ 回落默认 30 分钟", () => {
  const last = "2026-10-22T14:50:00.000Z";
  assert.equal(AutoSync.shouldRun({ ...BASE, lastRun: last, minIntervalMinutes: -5 }).run, false);
  assert.equal(AutoSync.shouldRun({ ...BASE, lastRun: last, minIntervalMinutes: "x" }).run, false);
});

test("opts 缺省 / 完全不传 → 不抛错且不同步（无凭据路径）", () => {
  assert.equal(AutoSync.shouldRun().reason, "no-creds");
  assert.equal(AutoSync.shouldRun(null).reason, "no-creds");
});

/* ---------- 设置持久化 ---------- */
test("isEnabled 默认开；setEnabled 关/开 往返一致", () => {
  assert.equal(AutoSync.isEnabled(), true);
  AutoSync.setEnabled(false);
  assert.equal(AutoSync.isEnabled(), false);
  assert.equal(globalThis.localStorage.getItem(AutoSync.LS_ENABLED), "off");
  AutoSync.setEnabled(true);
  assert.equal(AutoSync.isEnabled(), true);
});

test("lastRun / markRun 写读一致；markRun 缺省用当前时间", () => {
  AutoSync.markRun("2026-10-22T15:30:00.000Z");
  assert.equal(AutoSync.lastRun(), "2026-10-22T15:30:00.000Z");
  AutoSync.markRun();
  assert.notEqual(AutoSync.lastRun(), "");
});

/* ---------- 人类可读时间 ---------- */
test("humanizeWait：分钟 / 小时+分钟 / 非正数", () => {
  assert.equal(AutoSync.humanizeWait(90 * 1000), "2 分钟");
  assert.equal(AutoSync.humanizeWait(135 * 60000), "2 小时 15 分钟");
  assert.equal(AutoSync.humanizeWait(0), "0 分钟");
  assert.equal(AutoSync.humanizeWait(-5), "0 分钟");
});

/* ---------- 结果摘要 ---------- */
test("summarize：拼接 stats；errors 附加在末尾", () => {
  const s = AutoSync.summarize({ items: 6, added: 2, updated: 1, captures: 9 }, ["课程A课件"]);
  assert.match(s, /6 项/);
  assert.match(s, /新增 2/);
  assert.match(s, /入库 9 条/);
  assert.match(s, /课程A课件/);
});

test("summarize：空 stats / 无 errors 不炸", () => {
  const s = AutoSync.summarize();
  assert.match(s, /0 项/);
  assert.equal(AutoSync.summarize({}, []).includes("未取到"), false);
});

test("summarize：capturesUpdated 附加在采集入库之后（#58）", () => {
  const s = AutoSync.summarize({ items: 2, added: 1, updated: 0, captures: 3, capturesUpdated: 5 }, []);
  assert.match(s, /入库 3 条/);
  assert.match(s, /更新 5 条课程记忆/);
  assert.equal(AutoSync.summarize({ captures: 1 }, []).includes("课程记忆"), false);
});

test("offlineHint 指向 syncserver.py", () => {
  assert.match(AutoSync.offlineHint(), /syncserver\.py/);
});

console.log("\n" + passed + " passed");
