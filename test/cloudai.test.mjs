/*
 * cloudai.js 云端通道错误转人话回归测试（零依赖，Node >= 16）
 * 运行：node test/cloudai.test.mjs
 *
 * 背景（#42）：gateway_network_error 是浏览器 fetch() 连响应都没拿到的
 * 网络层失败（发布站点下线 / 非发布页打开 / 代理拦截），却被
 * errText() 的 gateway_* 兜底误标成「模型服务暂时不可用，请重试一次」，
 * 误导排查方向。这里守住：网络层失败必须说清真实原因，其余前缀分支不回退。
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
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const CloudAI = sandbox.window.CloudAI;

assert.ok(CloudAI && typeof CloudAI.errText === "function", "cloudai.js 应在 window.CloudAI 上暴露 errText()");

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

console.log("\ncloudai.test.mjs: " + passed + " passed" + (process.exitCode ? " (with failures)" : ""));
