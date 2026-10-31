#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verifyserver.py 1.0.0 | hwdesk 云端账号验证服务（无状态，只做 /verify）

解决什么问题：
  登录门禁原本只认本机桥（syncserver.py，127.0.0.1:8765）——每个新用户都得先
  装 Python、手动起服务才能登录。本服务部署在公网后，工作台在「本机桥不在」
  时自动降级到它（verifynet.js 分层端点），任何用户打开工作台即可直接登录。

只做一件事：
  POST /verify  {"account","password"} → 代用户向城院统一身份认证（CAS）做
  一次真实登录。成功 {"ok":true}；失败 {"ok":false,"error":"可读原因"}。

隐私与安全护栏（与 syncserver 同源逻辑，多一层公网护栏）：
  - 凭据只在处理本次请求的内存里存活，验证完立即丢弃；
  - 永不写日志、永不落盘（log_message 静默）；
  - 无任何存储依赖，进程重启即失忆；
  - 简单内存速率限制（全局滑动窗口），防止被当 CAS 爆破跳板；
  - /data、/ingest 等数据面端点一律不提供——数据同步仍然只走用户本机桥。

用法：
  python verifyserver.py              # 本地试跑（默认 127.0.0.1:8787）
  PORT=8787 python verifyserver.py    # 平台部署时读 PORT 环境变量，监听 0.0.0.0
  python verifyserver.py --self-test  # 自检（不出网）

部署：单端口 HTTP 服务（纯标准库），同目录需要 syncserver.py（复用其 CAS
登录实现 hzcu_login；本文件自身不含任何平台逻辑）。
"""

import os
import sys
import threading
import time
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

# 复用 syncserver 的城院 CAS 登录（hzcu_login 内含 302 链 + AES 表单提交 + 会话确认）
from syncserver import SyncError, hzcu_login, self_test as sync_self_test  # noqa: E402

VERSION = "1.0.0"

# 平台部署注入 PORT 时监听 0.0.0.0；本地试跑默认回环
_BIND_ALL = bool(os.environ.get("PORT"))
HOST = "0.0.0.0" if _BIND_ALL else "127.0.0.1"
PORT = int(os.environ.get("PORT") or 8787)

# 全局滑动窗口限速：max(120, 每分钟)——防爆破跳板，不防正常登录
_RL_LOCK = threading.Lock()
_RL_HITS = []          # [timestamp, ...]
_RL_WINDOW = 60.0
_RL_LIMIT = 120


def _rate_limited():
    now = time.time()
    with _RL_LOCK:
        while _RL_HITS and now - _RL_HITS[0] > _RL_WINDOW:
            _RL_HITS.pop(0)
        if len(_RL_HITS) >= _RL_LIMIT:
            return True
        _RL_HITS.append(now)
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
                             "platform": "学在城院 CAS 账号验证（无状态，验证后凭据即弃）"})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/verify"):
            self._json(404, {"ok": False, "error": "not found"})
            return
        if _rate_limited():
            self._json(429, {"ok": False, "error": "验证请求过于频繁，请稍后再试"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw.decode("utf-8", "replace")) if raw else {}
            account = str(body.get("account") or "").strip()
            password = str(body.get("password") or "")
            if not account or not password:
                self._json(200, {"ok": False, "error": "请求缺少 account / password 字段"})
                return
            # 真实登录一次；hzcu_login 的凭据只活在本次调用的内存里
            hzcu_login(account, password)
            self._json(200, {"ok": True, "source": "hzcu-xzc", "via": "cloud"})
        except SyncError as e:
            self._json(200, {"ok": False, "error": str(e)})
        except Exception as e:  # 未知异常也给出可读信息（不暴露堆栈）
            self._json(200, {"ok": False, "error": "验证服务内部错误：%s" % e})


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
    _RL_LIMIT = old_limit
    _RL_HITS.clear()
    print(("ok  - rate limiter opens after _RL_LIMIT hits" if good else "FAIL - rate limiter"))
    ok &= good
    print("SELF-TEST " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main():
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("hwdesk-verifyserver %s | http://%s:%s" % (VERSION, HOST, PORT))
    print("  GET  /health   健康检查")
    print("  POST /verify   学在城院账号验证（无状态，凭据验证后即弃）")
    print("  Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
