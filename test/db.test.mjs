/*
 * db.js 库管理层测试（零依赖，Node >= 16）
 * 运行：node test/db.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
(0, eval)(readFileSync(path.join(root, "db.js"), "utf8"));
const DB = globalThis.DB;

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

console.log("db.js " + DB.VERSION + " | stores: " + Object.keys(DB.STORES).join(", "));

/* ---------- 库注册 ---------- */
test("registry defines captures / submissions / reviews / chats", () => {
  assert.deepEqual(Object.keys(DB.STORES).sort(), ["captures", "chats", "reviews", "submissions"]);
});

/* ---------- CRUD ---------- */
test("insert assigns id and prepends (list returns latest first)", () => {
  DB.clear("captures");
  const a = DB.insert("captures", { title: "课件A", course: "电力电子技术", kind: "课件", note: "", time: "2026-10-21" });
  const b = DB.insert("captures", { title: "课件B", course: "电机与拖动", kind: "课件", note: "", time: "2026-10-21" });
  assert.ok(a.id && b.id && a.id !== b.id);
  const list = DB.list("captures");
  assert.equal(list[0].title, "课件B");
  assert.equal(list.length, 2);
});
test("find / update / remove", () => {
  DB.clear("submissions");
  const s = DB.insert("submissions", { itemId: 9, name: "实验报告", course: "电力电子技术", ai: "写作AI", status: "pending", time: "t" });
  assert.equal(DB.find("submissions", s.id).name, "实验报告");
  DB.update("submissions", s.id, { status: "submitted", risk: 22 });
  const u = DB.find("submissions", s.id);
  assert.equal(u.status, "submitted");
  assert.equal(u.risk, 22);
  DB.remove("submissions", s.id);
  assert.equal(DB.find("submissions", s.id), null);
});
test("cap at 200 records prevents unbounded growth", () => {
  DB.clear("reviews");
  for (let i = 0; i < 210; i++) DB.insert("reviews", { name: "r" + i, decision: "approved", time: "t" });
  assert.equal(DB.list("reviews").length, 200);
  DB.clear("reviews");
});
test("corrupted store falls back to empty array", () => {
  DB.clear("captures");
  localStorage.setItem(DB.STORES.captures, "{not json");
  assert.deepEqual(DB.list("captures"), []);
  DB.clear("captures");
});

/* ---------- 交付状态机 ---------- */
test("pending can go to submitted or changes", () => {
  assert.ok(DB.canTransition("pending", "submitted"));
  assert.ok(DB.canTransition("pending", "changes"));
});
test("changes can be resubmitted (back to pending) or force-submitted", () => {
  assert.ok(DB.canTransition("changes", "pending"));
  assert.ok(DB.canTransition("changes", "submitted"));
});
test("submitted is terminal", () => {
  assert.equal(DB.canTransition("submitted", "pending"), false);
  assert.equal(DB.canTransition("submitted", "changes"), false);
});
test("unknown states cannot transition", () => {
  assert.equal(DB.canTransition("unknown", "submitted"), false);
});

/* ---------- 多库隔离 ---------- */
test("stores are isolated from each other", () => {
  DB.clear("captures"); DB.clear("submissions");
  DB.insert("captures", { title: "X" });
  assert.equal(DB.list("submissions").length, 0);
  assert.equal(DB.list("captures").length, 1);
  DB.clear("captures");
});

/* ---------- 每库上限（#59） ---------- */
test("captures holds up to 2000 records (course memory is not silently truncated)", () => {
  DB.clear("captures");
  for (let i = 0; i < 600; i++) DB.insert("captures", { title: "m" + i, course: "C", kind: "课件", note: "" });
  assert.equal(DB.list("captures").length, 600);
  DB.clear("captures");
});
test("other stores keep the 200-record cap", () => {
  DB.clear("submissions");
  for (let i = 0; i < 210; i++) DB.insert("submissions", { name: "s" + i, status: "pending", time: "t" });
  assert.equal(DB.list("submissions").length, 200);
  DB.clear("submissions");
  assert.equal(DB.CAPS.captures, 2000);
  assert.equal(DB.CAPS.reviews, 200);
});

console.log(passed + " passed, " + (process.exitCode ? "FAILED" : "0 failed"));

/* ---------- 账号命名空间（#92 多账号数据串号） ---------- */
test("scope(account) 后读写落到 ::<account> 后缀键，与默认空间互不可见", () => {
  DB.clear("captures");
  DB.insert("captures", { title: "A的课件", course: "C", kind: "课件", note: "" });
  DB.scope("32402235");
  assert.deepEqual(DB.list("captures"), []);                     // 别人的空间是空的
  const a = DB.insert("captures", { title: "A的课件2", course: "C", kind: "课件", note: "" });
  assert.equal(localStorage.getItem("wb_hwdesk_captures::32402235") !== null, true);
  DB.scope("8888");
  assert.deepEqual(DB.list("captures"), []);                     // 第二个账号也看不到
  DB.scope("32402235");
  assert.equal(DB.list("captures")[0].title, "A的课件2");
  DB.update("captures", a.id, { note: "x" });
  assert.equal(JSON.parse(localStorage.getItem("wb_hwdesk_captures::32402235"))[0].note, "x");
  DB.remove("captures", a.id);
  assert.deepEqual(DB.list("captures"), []);
  DB.scope("");
  DB.clear("captures");
});
test("adoptLegacy 把无后缀旧库迁移进账号空间并清空旧键", () => {
  localStorage.setItem("wb_hwdesk_captures", JSON.stringify([{ id: 7, title: "旧课件" }]));
  localStorage.setItem("wb_hwdesk_chats", JSON.stringify([{ id: 8 }]));
  DB.scope("");
  assert.equal(DB.adoptLegacy("32402235") >= 2, true);
  assert.deepEqual(JSON.parse(localStorage.getItem("wb_hwdesk_captures")), []);
  DB.scope("32402235");
  assert.equal(DB.list("captures")[0].title, "旧课件");
  assert.equal(DB.list("chats")[0].id, 8);
  DB.clear("captures"); DB.clear("chats");
  DB.scope("");
  localStorage.removeItem("wb_hwdesk_captures"); localStorage.removeItem("wb_hwdesk_chats");
});
