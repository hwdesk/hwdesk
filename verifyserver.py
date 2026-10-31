#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verifyserver.py 1.2.0 | hwdesk 云端验证 + 同步服务（无状态）

解决什么问题：
  登录门禁与一键同步原本都只认本机桥（syncserver.py，127.0.0.1:8765）——每个
  新用户都得先装 Python、手动起服务才能登录和拉数据。本服务部署在公网后，工作台
  在「本机桥不在」时自动降级到它（verifynet.js 分层端点），任何用户打开工作台
  即可直接登录 + 一键同步学在城院数据。

1.2.0 为什么有异步模式（/data/start + /data/poll）：
  完整采集（登录 + 全部课程待办翻页 + 逐课作业）可能超过公网网关的单请求
  超时——一次长 POST 被网关掐断后，页面只能看到「同步服务全部连不上」。
  异步模式：start 秒回任务号（随机 token），后台线程采集，页面用短请求轮询
  poll 取结果。任务与凭据只存在内存：15 分钟 TTL、上限 32 个、结果交付一次
  即焚，进程重启全失忆——依然不落盘、不写日志。

端点（全部无状态护栏：凭据只活在本次请求/任务内存里，用完即弃）：
  POST /verify       {"account","password"} → 真实登录一次。{"ok":true|false,"error"}
  POST /data         {"account","password"} → 同步长请求版采集（本机桥同构响应）
  POST /data/start   {"account","password"} → {"ok":true,"job":"<32hex>"} 秒回
  POST /data/poll    {"job":"<token>"} → running | {"status":"done","payload":{…}} | error
                     （任务号走 body 不走 URL query：query 会进中间网关的 access log，
                      15 分钟 TTL 内凭日志就能取走别人的采集结果）

隐私与安全护栏（与 syncserver 同源逻辑，多一层公网护栏）：
  - 凭据只在处理本次请求的内存里存活，响应完立即丢弃；
  - 永不写日志、永不落盘（log_message 静默）；
  - 无任何存储依赖，进程重启即失忆；
  - 简单内存速率限制（全局滑动窗口；/data 一次触发几十次上游调用按 5 次计费），
    防止被当 CAS 爆破跳板；
  - /ingest（外部结果投递）等有落盘语义的端点一律不提供。

用法：
  python verifyserver.py              # 本地试跑（默认 127.0.0.1:8787）
  PORT=8787 python verifyserver.py    # 平台部署时读 PORT 环境变量，监听 0.0.0.0
  python verifyserver.py --self-test  # 自检（不出网）

部署：单端口 HTTP 服务（纯标准库），同目录需要 syncserver.py（复用其 CAS 登录
与 Tronclass 采集实现 hzcu_login / hzcu_collect；本文件自身不含任何平台逻辑）。
"""

import os
import re
import sys
import threading
import time
import json
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 复用 syncserver 的城院 CAS 登录与 Tronclass 采集（302 链 + AES 表单提交 + 会话确认）
from syncserver import SyncError, hzcu_login, hzcu_collect, self_test as sync_self_test  # noqa: E402

VERSION = "1.2.0"

# 平台部署注入 PORT 时监听 0.0.0.0；本地试跑默认回环
_BIND_ALL = bool(os.environ.get("PORT"))
HOST = "0.0.0.0" if _BIND_ALL else "127.0.0.1"
PORT = int(os.environ.get("PORT") or 8787)

# 全局滑动窗口限速：max(120, 每分钟)——防爆破跳板，不防正常登录
_RL_LOCK = threading.Lock()
_RL_HITS = []          # [timestamp, ...]
_RL_WINDOW = 60.0
_RL_LIMIT = 120

# ---------- 无状态边界内的异步采集任务（1.2.0） ----------
# 为什么要有 /data/start + /data/poll：完整采集（登录 + 全部课程待办翻页 +
# 逐课作业）可能超过公网网关的单请求超时，一次长 POST 会被网关掐断，
# 页面只能看到「连不上」。改为：start 秒回任务号，后台线程采集，页面短请求
# 轮询。任务只存在内存（凭据与结果永不落盘），TTL 过期即焚。
JOBS_LOCK = threading.Lock()
JOBS = {}              # token -> {"status":"running|done|error","payload"/"error","ts"}
JOB_TTL = 900.0        # 15 分钟后任务结果不可再取
JOB_MAX = 32           # 最多同时保留 32 个任务
JOBS_CAP_WARNING = "采集任务数已达上限，请稍后再试"
# 后台采集线程单独设上限：一个线程就要对上游发起几十次请求（登录 + 全部课程待办
# 翻页 + 逐课作业），高频 start 会并发拉起几十个对上游平台的会话
COLLECT_MAX = 4
COLLECT_SLOTS = threading.BoundedSemaphore(COLLECT_MAX)
COLLECT_BUSY_WARNING = "采集任务排队已满，请稍后再试"
JOB_ERROR_TEXT = "采集失败，请稍后重试"   # 未知异常固定文案：内部细节不回传页面


def _jobs_cleanup():
    """回收过期任务；超上限时只回收已交付/已失败的任务。

    running 的任务绝不逐出：它正在采集，被后来的请求挤掉后页面会一直轮询到
    「任务不存在或已过期」，用户永远拿不到结果。
    """
    now = time.time()
    with JOBS_LOCK:
        for k in [k for k, v in JOBS.items() if now - v["ts"] > JOB_TTL]:
            del JOBS[k]
        finished = sorted((k for k, v in JOBS.items() if v["status"] != "running"),
                          key=lambda k: JOBS[k]["ts"])
        for k in finished:
            if len(JOBS) < JOB_MAX:
                break
            del JOBS[k]


def _run_job(token, account, password):
    def work():
        try:
            s = hzcu_login(account, password)
            payload = hzcu_collect(s)
            with JOBS_LOCK:
                JOBS[token] = {"status": "done", "payload": payload, "ts": time.time()}
        except SyncError as e:
            # SyncError 自带用户可读文案（账号密码错、平台改版…），与 /data 同口径透传
            with JOBS_LOCK:
                JOBS[token] = {"status": "error", "error": str(e), "ts": time.time()}
        except Exception as e:
            # 未知异常一律固定文案：内部路径 / 上游响应片段不回传页面
            print("[job %s] unexpected: %r" % (token[:8], e), file=sys.stderr)
            with JOBS_LOCK:
                JOBS[token] = {"status": "error", "error": JOB_ERROR_TEXT, "ts": time.time()}
        finally:
            COLLECT_SLOTS.release()
    threading.Thread(target=work, daemon=True).start()


def _rate_limited(cost=1):
    """滑动窗口限速；cost = 本次请求按几次计（/data 一次触发几十次上游调用，重计）"""
    now = time.time()
    with _RL_LOCK:
        while _RL_HITS and now - _RL_HITS[0] > _RL_WINDOW:
            _RL_HITS.pop(0)
        if len(_RL_HITS) + cost > _RL_LIMIT:
            return True
        _RL_HITS.extend([now] * cost)
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "hwdesk-verifyserver/" + VERSION

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 静默：凭据绝不出现在任何日志
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "version": VERSION,
                             "service": "hwdesk-verifyserver",
                             "platform": "学在城院 CAS 验证 + 无状态同步（凭据用完即弃，不落盘）"})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def _read_json(self):
        """请求体 → dict；空 / 非 JSON / 非对象一律给 {}（由调用方报错）"""
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw.decode("utf-8", "replace")) if raw else {}
        except ValueError:
            body = {}
        return body if isinstance(body, dict) else {}

    def _read_creds(self):
        """请求体 → (account, password)；缺字段给空串（由调用方报错）"""
        body = self._read_json()
        return str(body.get("account") or "").strip(), str(body.get("password") or "")

    def _poll(self):
        """POST /data/poll {"job":"<32hex>"}：任务号走 body，不落 URL / 不进网关日志"""
        tok = str(self._read_json().get("job") or "").strip()
        if not tok or not re.fullmatch(r"[0-9a-f]{32}", tok):
            self._json(200, {"ok": False, "error": "任务号不合法", "stale": True})
            return
        with JOBS_LOCK:
            job = JOBS.get(tok)
            if job is None:
                self._json(200, {"ok": False, "error": "任务不存在或已过期", "stale": True})
                return
            if job["status"] == "running":
                self._json(200, {"ok": True, "status": "running"})
                return
            if job["status"] == "error":
                del JOBS[tok]
                self._json(200, {"ok": True, "status": "error", "error": job["error"]})
                return
            payload = job["payload"]
            del JOBS[tok]   # 结果取走即焚（一次成功轮询交付后任务消失）
        self._json(200, {"ok": True, "status": "done", "cached": False,
                         "via": "cloud", "payload": payload})

    def do_POST(self):
        is_verify = self.path.startswith("/verify")
        is_start = self.path.startswith("/data/start")
        is_poll = self.path.startswith("/data/poll")
        is_data = self.path.startswith("/data")
        if not (is_verify or is_data):
            self._json(404, {"ok": False, "error": "not found"})
            return
        # /data（含 /data/start）一次触发几十次上游调用，按 5 次计费；
        # /verify 与 /data/poll 只是一次轻量请求（轮询仅读内存），按 1 次
        if _rate_limited(1 if is_poll else (5 if is_data else 1)):
            self._json(429, {"ok": False, "error": "请求过于频繁，请稍后再试"})
            return
        if is_poll:
            self._poll()
            return
        try:
            account, password = self._read_creds()
            if not account or not password:
                self._json(200, {"ok": False, "error": "请求缺少 account / password 字段"})
                return
            # 凭据只活在本次调用的内存里：verify 只登录；data 登录后实时采集，
            # 结果直接随响应返回（hzcu_collect 不写任何文件，缓存逻辑在本桥 syncserver 的
            # collect_payload 里，这里刻意不复用它以保持无状态）。
            if is_verify:
                hzcu_login(account, password)
                self._json(200, {"ok": True, "source": "hzcu-xzc", "via": "cloud"})
            elif is_start:
                # 异步采集：秒回任务号，后台线程登录+采集，页面轮询 /data/poll 取结果。
                # 解决网关掐断单条长请求导致的「同步服务全部连不上」。
                _jobs_cleanup()
                if len(JOBS) >= JOB_MAX:
                    self._json(200, {"ok": False, "error": JOBS_CAP_WARNING})
                    return
                if not COLLECT_SLOTS.acquire(blocking=False):
                    self._json(200, {"ok": False, "error": COLLECT_BUSY_WARNING})
                    return
                tok = secrets.token_hex(16)
                with JOBS_LOCK:
                    JOBS[tok] = {"status": "running", "ts": time.time()}
                _run_job(tok, account, password)
                self._json(200, {"ok": True, "job": tok, "via": "cloud"})
            else:
                s = hzcu_login(account, password)
                payload = hzcu_collect(s)
                self._json(200, {"ok": True, "cached": False, "via": "cloud", "payload": payload})
        except SyncError as e:
            self._json(200, {"ok": False, "error": str(e)})
        except Exception as e:  # 未知异常也给出可读信息（不暴露堆栈）
            self._json(200, {"ok": False, "error": "服务内部错误：%s" % e})


def self_test():
    """不出网：确认复用的 syncserver 自检全过 + 限速器工作正常"""
    ok = True
    print("— syncserver 复用逻辑自检 —")
    ok &= (sync_self_test() == 0)

    print("— verifyserver 限速器自检 —")
    _RL_HITS.clear()
    global _RL_LIMIT, _RL_WINDOW
    old_limit = _RL_LIMIT
    _RL_LIMIT = 3
    a, b, c = (_rate_limited(), _rate_limited(), _rate_limited())
    d = _rate_limited()
    good = (not a) and (not b) and (not c) and d
    _RL_HITS.clear()
    # /data 按 cost 计费：cost=2 一次占两个坑，窗口满后小请求也进不来
    a, b = _rate_limited(2), _rate_limited(1)
    c, d = _rate_limited(2), _rate_limited(1)
    good &= (not a) and (not b) and c and d
    _RL_LIMIT = old_limit
    _RL_HITS.clear()
    print(("ok  - rate limiter opens after _RL_LIMIT hits (per-request cost aware)"
           if good else "FAIL - rate limiter"))
    ok &= good

    print("— verifyserver 异步任务自检 —")
    JOBS.clear()
    tok = "a" * 32
    with JOBS_LOCK:
        JOBS[tok] = {"status": "running", "ts": time.time() - JOB_TTL - 1}
    _jobs_cleanup()
    ttl_ok = tok not in JOBS          # 过期任务被清理
    for i in range(JOB_MAX):
        JOBS["%032x" % i] = {"status": "running", "ts": time.time()}
    _jobs_cleanup()
    cap_ok = len(JOBS) == JOB_MAX     # 超上限不越界，且 running 的任务不被逐出
    JOBS.clear()
    jobs_good = ttl_ok and cap_ok
    print(("ok  - job TTL expiry + cap enforcement" if jobs_good
           else "FAIL - async jobs (%s/%s)" % (ttl_ok, cap_ok)))
    ok &= jobs_good
    print("SELF-TEST " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main():
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("hwdesk-verifyserver %s | http://%s:%s" % (VERSION, HOST, PORT))
    print("  GET  /health       健康检查")
    print("  POST /verify       学在城院账号验证（无状态，凭据验证后即弃）")
    print("  POST /data         学在城院同步（同步长请求版，响应即结果）")
    print("  POST /data/start   异步采集：秒回任务号，后台登录+采集（任务只在内存）")
    print("  POST /data/poll    轮询任务：body {\"job\":\"<token>\"}，done 一次性交付后即焚")
    print("  Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
