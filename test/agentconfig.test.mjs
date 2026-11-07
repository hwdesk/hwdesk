/*
 * agent.config.json 回归测试（零依赖，Node >= 16）
 * 运行：node test/agentconfig.test.mjs
 *
 * 这份配置是 hwdesk 侧「按 RoleWeave 语义」写出来的 Agent 策略：引擎绑定锁定、
 * CLI 解析顺序、模型档位、工具权限（deny + 只读白名单）、MCP、预算、回合环境隔离。
 * 它一旦被人改坏（比如 defaultEffect 写成 allow、白名单里混进 Bash、envAllow 里
 * 漏进 SDK 鉴权变量），syncserver 的收敛闸会兜住并回退，但页面看到的「生效配置」
 * 和真实下发就会各说各话。这里在 CI 上把随包发布的这份文件本身钉死。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const cfg = JSON.parse(readFileSync(path.join(root, "agent.config.json"), "utf8"));
const py = readFileSync(path.join(root, "syncserver.py"), "utf8");
const ag = readFileSync(path.join(root, "agent.js"), "utf8");
const html = readFileSync(path.join(root, "作业提交工作台.html"), "utf8");
const gitignore = readFileSync(path.join(root, ".gitignore"), "utf8");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok - " + name);
  } catch (e) {
    failed++;
    process.exitCode = 1;
    console.error("  FAIL - " + name + "\n    " + String(e.message).split("\n")[0]);
  }
}

/* 只读工具集合：与 syncserver.READONLY_TOOLS 保持同一份口径 */
const READONLY_TOOLS = ["Read", "Grep", "Glob", "LS", "ViewImage"];
const LEAKY_ENV = ["QODER_SDK_AUTH_PAYLOAD_FILE", "QODER_SESSION_ACCESS_TOKEN",
                   "QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN"];

test("配置文件本身可解析且带 RoleWeave 的形状标记", () => {
  assert.equal(cfg.schemaVersion, "hwdesk-agent.v1");
  assert.equal(cfg.engine.schemaVersion, "roleweave-agent-binding.v1");
  assert.equal(cfg.permissions.schemaVersion, "workbench-permissions.v1");
  assert.equal(cfg.mcp.schemaVersion, "workbench-mcp.v1");
});

test("引擎绑定：唯一 Agent = 本机 Qoder CLI 且锁定，页面不可切换", () => {
  assert.equal(cfg.engine.name, "qoder");
  assert.equal(cfg.engine.locked, true);
});

test("CLI 解析顺序：自己的变量排第一，且只有它有「非法即停摆」的资格", () => {
  assert.equal(cfg.cli.envOrder[0], "HWDESK_QODER_CLI");
  assert.deepEqual(cfg.cli.envFailClosed, ["HWDESK_QODER_CLI"]);
  cfg.cli.envFailClosed.forEach((v) => {
    assert.ok(cfg.cli.envOrder.includes(v), v + " 必须先出现在 envOrder 里");
  });
  /* RoleWeave / 数字员工自己的变量名也要认，但它们指向坏值时只告警、继续往下找 */
  assert.ok(cfg.cli.envOrder.includes("ORG_WORKBENCH_QODER_BIN"));
  assert.ok(cfg.cli.envOrder.includes("DIGITAL_EMPLOYEE_QODER_COMMAND"));
  assert.ok(cfg.cli.pathNames.length >= 3, "PATH 上至少要试 qodercli / qoderclicn / qoder");
});

test("CLI 候选路径逐条精确校验，绝不扫整个家目录", () => {
  for (const c of cfg.cli.userCandidates) {
    assert.ok(c.startsWith("~/") || path.isAbsolute(c), c + " 必须是明确的候选路径");
    assert.ok(c.split("/").length >= 3, c + " 太浅（可能是目录级扫描的口子）");
    assert.ok(!/[*]/.test(c), c + " 不许用通配符");
  }
});

test("模型目录探测预算够冷启动（3s 会被抖动打成 unavailable）", () => {
  assert.ok(cfg.cli.probeTimeoutMs >= 5000 && cfg.cli.probeTimeoutMs <= 10000,
      "probeTimeoutMs=" + cfg.cli.probeTimeoutMs);
  assert.ok(cfg.cli.catalogCacheSeconds >= 60, "目录探测不便宜，成功结果要长缓存");
});

test("模型策略：跟随账号默认，档位只是可选的覆写", () => {
  assert.equal(cfg.model.policy, "follow-account-default");
  assert.equal(cfg.model.default, "provider-default");
  assert.deepEqual(cfg.model.catalogArgs, ["--list-models"]);
  const first = cfg.model.tiers[0];
  assert.equal(first.id, "provider-default");
  assert.equal(first.model, null, "默认档位不下传 -m，才能真正跟随账号默认");
  const ids = cfg.model.tiers.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "档位 id 不能重复");
  cfg.model.tiers.slice(1).forEach((t) => {
    assert.ok(typeof t.model === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/.test(t.model),
        t.id + " 必须写明确的模型 id，否则和 provider-default 重复");
  });
});

test("权限：deny 打底 + 只读白名单，写/执行/联网一律在 deny 里", () => {
  assert.equal(cfg.permissions.defaultEffect, "deny");
  assert.ok(cfg.permissions.allow.length > 0, "白名单为空＝纯对话，也要显式写出来");
  cfg.permissions.allow.forEach((t) => {
    assert.ok(READONLY_TOOLS.includes(t), t + " 不是只读工具，不该出现在白名单里");
  });
  for (const danger of ["Write", "Edit", "Bash", "WebFetch", "WebSearch"]) {
    assert.ok(cfg.permissions.deny.includes(danger), danger + " 必须显式 deny");
    assert.ok(!cfg.permissions.allow.includes(danger), danger + " 不能同时被 allow");
  }
  assert.ok(["default", "accept_edits"].includes(cfg.permissions.permissionMode),
      "permission-mode 不许是 bypass/dont-ask/auto");
  assert.ok(["app", "home"].includes(cfg.permissions.workspace),
      "检索范围只能是工作台目录或家目录");
});

test("MCP：默认拒绝且随包配置不挂任何外部 server", () => {
  assert.equal(cfg.mcp.defaultEffect, "deny");
  assert.deepEqual(cfg.mcp.servers, [], "工作台辅导对话不需要外部 MCP；要加就走 allow + 白名单");
});

test("回合环境隔离：白名单里不许漏进鉴权/凭据变量", () => {
  assert.equal(cfg.isolation.cleanEnv, true);
  assert.ok(cfg.isolation.envAllow.length > 10, "PATH/HOME 这类基本变量要在白名单里");
  for (const v of LEAKY_ENV) {
    assert.ok(!cfg.isolation.envAllow.includes(v), v + " 泄漏出去会把 CLI 打死（exit 41）");
    assert.ok(cfg.isolation.envDropAlways.includes(v), v + " 必须无条件剔除");
  }
  assert.equal(cfg.isolation.envAllow[0], "PATH", "缺 PATH 时 Windows 上根本起不来");
  assert.equal(cfg.isolation.settingSources, "", "不加载 user/project/local 设置＝别处改不动这轮对话");
  assert.equal(cfg.isolation.noSessionPersistence, true, "辅导对话不落 CLI 会话历史");
});

test("预算：数值都在 sane 区间，且熔断用的是真报得出的量", () => {
  const t = cfg.budget.perTask;
  const d = cfg.budget.perDay;
  assert.ok(t.timeoutSeconds >= 60 && t.timeoutSeconds <= 900, "timeoutSeconds=" + t.timeoutSeconds);
  assert.ok(t.maxPromptChars >= 1000 && t.maxPromptChars <= 200000, "maxPromptChars 过大只会吃掉整个提示词预算");
  assert.ok(t.maxOutputTokens >= 1000 && t.maxOutputTokens <= 32000);
  assert.ok(t.iterations >= 1 && t.iterations <= 16);
  assert.ok(d.turns >= 1 && d.turns <= 2000, "perDay.turns=" + d.turns);
});

test("syncserver 内置默认值与随包配置同源（安全项一字不差）", () => {
  const block = py.slice(py.indexOf("AGENT_CONFIG_DEFAULTS = {"), py.indexOf("def _deep_merge"));
  assert.ok(block.length > 200, "找不到内置默认值定义");
  assert.ok(block.includes('"defaultEffect": "deny"'), "默认值也是 deny 打底");
  assert.ok(block.includes('"Read", "Grep", "Glob"'), "默认白名单与配置一致");
  cfg.cli.envOrder.forEach((v) => {
    assert.ok(block.includes('"' + v + '"'), v + " 在默认值里也得出现，否则缺文件时行为不同");
  });
  cfg.isolation.envDropAlways.forEach((v) => {
    assert.ok(block.includes('"' + v + '"'), v + " 的无条件剔除要写进默认值");
  });
});

test("页面与 agent.js 不写死档位：只认 provider-default 这一个兜底 id", () => {
  assert.ok(/id="agModelSel"[^>]*><\/select>/.test(html),
      "档位下拉必须是空壳，选项全部由 populateAgentModels 从桥的账号目录生成");
  assert.ok(/Agent\.modelOptions\(/.test(html), "页面走 agent.js modelOptions");
  assert.ok(!/"(efficient|performance|ultimate)"/.test(ag),
      "agent.js 不许硬编 RoleWeave 的档位名，档位来自 agent.config.json");
  assert.ok(cfg.model.tiers.some((t) => t.id === "provider-default"),
      "agent.js 兜底用的 id 必须在配置里存在");
});

test("配置随包发布：不被 .gitignore 排除，也不含任何账号凭据", () => {
  assert.ok(!/agent\.config\.json/.test(gitignore), "这份配置要进仓库（不含密钥）");
  const raw = readFileSync(path.join(root, "agent.config.json"), "utf8");
  assert.ok(!/(api[_-]?key|token|password|secret)\s*"\s*:\s*"[^"]+"/i.test(raw),
      "配置里不许出现任何密钥字段");
});

console.log("\n" + passed + " passed, " + failed + " failed");
