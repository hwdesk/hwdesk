#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""syncserver.py 2.6.0 | hwdesk 学在城院本机直连桥（纯标准库，零第三方依赖）

为什么需要它：
  作业提交工作台是 file:// 单文件页面，浏览器同源策略决定它无法直接请求
  courses.hzcu.edu.cn（跨域 + 登录态 + 凭据安全）。本脚本在本机 127.0.0.1:8765
  起一个只监听回环地址的小服务，代替工作台去登录学在城院并拉取数据；
  页面通过 fetch('http://127.0.0.1:8765/data') 一步取回。

学在城院是什么：
  浙大城市学院自建教学平台（course.hzcu.edu.cn 门户 + courses.hzcu.edu.cn 课程
  端），课程端是 Tronclass 体系（与「学在浙大」courses.zju.edu.cn 同构，
  identity.hzcu.edu.cn 的 realm 名 zju-xzzj 可证）。注意它不是超星学习通。

登录链路（全程 302 跳转，只需账号密码，首次登录无验证码）：
  courses.hzcu.edu.cn/api/*            未登录 → 302
  identity.hzcu.edu.cn (Keycloak, CAS 协议) → 302
  ca.hzcu.edu.cn/cas/login             学校统一身份认证账密表单
    · 密码用 AES-128-ECB + PKCS7 加密后 Base64 提交（密钥硬编码在登录页脚本里）
    · 表单字段：username / password / authType=0 / lt / execution / _eventId=submit / validTime=5
  提交成功 → 按原链路 302 回 courses.hzcu.edu.cn，会话 Cookie 建立

数据接口（Tronclass，均为 JSON）：
  POST/GET /api/my-courses                          我的课程（分页：courses + pages）
  GET      /api/todos?no-intercept=true             全部待办（todo_list：作业/考试/测验/问卷）
  GET      /api/courses/{id}/homework-activities    某课程作业列表（homework_activities，含已提交）

用法：
  python syncserver.py                # 启动服务（默认 127.0.0.1:8765）
  python syncserver.py --self-test    # 自检：AES 加密 + CAS 页面解析 + 数据映射（不出网）

Agent 配置（语义对齐本机 RoleWeave 数字员工工作台）：
  同目录 agent.config.json 决定引擎绑定 / CLI 解析顺序 / 模型档位 / 工具白名单 /
  MCP / 逐任务与逐日预算 / 回合环境隔离。文件缺失或 JSON 坏了自动回退内置默认值，
  GET /agent/qoder/status 端出真正生效的值与 configError、configWarnings，
  页面显示的工具档位与实际下发的 --tools 恒一致。

登录门禁：工作台「登录」按钮会把账号密码 POST 到本机 /verify，由本脚本代为
登录城院统一身份认证验证真伪；验证通过才放行进入工作台。

凭据来源（优先级从高到低）：
  1. 页面请求体（工作台「学在城院登录」保存的账号密码，只在本次请求内存中使用）
  2. 同目录 wb_local.json：{"account": "...", "password": "..."}（已被 .gitignore 排除）

隐私：
  - 只监听 127.0.0.1，局域网内其他设备连不上；
  - 凭据永不写入日志、缓存或任何文件；缓存 wb_platform_cache.json 只存拉到的数据。
"""

import base64
import json
import os
import re
import ssl
import subprocess
import sys
import threading
import time
import datetime
import http.cookiejar
import html as html_lib
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "3.2.0"  # 3.2.0: Agent 配置对齐 RoleWeave —— agent.config.json（引擎绑定锁定 / CLI 解析顺序含 ORG_WORKBENCH_QODER_BIN 且显式值非法即失败 / 模型跟随账号默认 + 档位只在 --list-models 目录里出现才下传 / 权限 defaultEffect=deny + 只读白名单 / MCP deny / perTask+perDay 预算 / 回合环境白名单隔离），status 端出全量生效配置与收敛告警；3.1.0: /agent/qoder/stream NDJSON 流式（思考过程实时进对话框）+ CLI 子进程 CREATE_NO_WINDOW 不弹窗 + 剥离会话泄漏的 SDK 鉴权变量 + 纯对话参数（禁工具/空MCP）；3.0.0: 工作台 AI 收敛为唯一 Agent —— /agent/qoder（本机 Qoder CLI，提示词走 stdin）+ /agent/qoder/status，移除 /agents/discover；2.7.0: /agents/discover 本机 Agent 凭据发现；2.6.0: 逐课采集线程池并行（同步提速）；2.5.0: 数据属主标记 + 缓存按账号分桶（#92 多账号串号）；2.4.0: PNA 预检头；2.3.0: 历史作业详情补齐（#58）；2.2.0: 课件采集（#57）+ AI 代理网关（#55）
HOST = "127.0.0.1"
PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.path.join(HERE, "wb_local.json")
CACHE_FILE = os.path.join(HERE, "wb_platform_cache.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 hwdesk-syncserver/" + VERSION)

# 学在城院（浙大城市学院，Tronclass 体系；不是超星学习通）
URL_LMS = "https://courses.hzcu.edu.cn"            # 课程端（数据都在这）
URL_IDENTITY = "https://identity.hzcu.edu.cn"      # Keycloak（CAS 协议中间层）
URL_CAS = "http://ca.hzcu.edu.cn"                  # 学校统一身份认证账密表单（当前公开链路为 HTTP）

# ca.hzcu.edu.cn 账密登录的 AES 参数（逆向自登录页内联脚本 submitForm('0')：
# CryptoJS.AES.encrypt(psw, "c6dda3852e2d4be2", {mode: ECB, padding: Pkcs7}).toString()）
CAS_AES_KEY = b"c6dda3852e2d4be2"

# Tronclass 待办类型 → 中文（与学在浙大一致）
TYPE_CN = {"homework": "作业", "exam": "考试", "quiz": "测验", "survey": "问卷"}

# 逐课并行采集线程数（2.6.0）：每门课 2+ 个上游请求 × 课程数，串行是同步慢的主因。
# 4 路并发对校园平台是浏览器正常水位（网页端本身就并发拉课程数据），不宜再高。
COLLECT_WORKERS = 4


class SyncError(Exception):
    """带用户可读信息的错误（直接透传给页面显示）"""


class SessionLost(SyncError):
    """登录态失效（接口返回了 HTML 而非 JSON），需要重新登录"""


# ---------------------------------------------------------------- AES-128 加密
def _xtime(a):
    a <<= 1
    if a & 0x100:
        a ^= 0x11B
    return a & 0xFF


def _mul(a, b):
    out = 0
    while b:
        if b & 1:
            out ^= a
        a = _xtime(a)
        b >>= 1
    return out


_SBOX = [
    0x63, 0x7C, 0x77, 0x7B, 0xF2, 0x6B, 0x6F, 0xC5, 0x30, 0x01, 0x67, 0x2B, 0xFE, 0xD7, 0xAB, 0x76,
    0xCA, 0x82, 0xC9, 0x7D, 0xFA, 0x59, 0x47, 0xF0, 0xAD, 0xD4, 0xA2, 0xAF, 0x9C, 0xA4, 0x72, 0xC0,
    0xB7, 0xFD, 0x93, 0x26, 0x36, 0x3F, 0xF7, 0xCC, 0x34, 0xA5, 0xE5, 0xF1, 0x71, 0xD8, 0x31, 0x15,
    0x04, 0xC7, 0x23, 0xC3, 0x18, 0x96, 0x05, 0x9A, 0x07, 0x12, 0x80, 0xE2, 0xEB, 0x27, 0xB2, 0x75,
    0x09, 0x83, 0x2C, 0x1A, 0x1B, 0x6E, 0x5A, 0xA0, 0x52, 0x3B, 0xD6, 0xB3, 0x29, 0xE3, 0x2F, 0x84,
    0x53, 0xD1, 0x00, 0xED, 0x20, 0xFC, 0xB1, 0x5B, 0x6A, 0xCB, 0xBE, 0x39, 0x4A, 0x4C, 0x58, 0xCF,
    0xD0, 0xEF, 0xAA, 0xFB, 0x43, 0x4D, 0x33, 0x85, 0x45, 0xF9, 0x02, 0x7F, 0x50, 0x3C, 0x9F, 0xA8,
    0x51, 0xA3, 0x40, 0x8F, 0x92, 0x9D, 0x38, 0xF5, 0xBC, 0xB6, 0xDA, 0x21, 0x10, 0xFF, 0xF3, 0xD2,
    0xCD, 0x0C, 0x13, 0xEC, 0x5F, 0x97, 0x44, 0x17, 0xC4, 0xA7, 0x7E, 0x3D, 0x64, 0x5D, 0x19, 0x73,
    0x60, 0x81, 0x4F, 0xDC, 0x22, 0x2A, 0x90, 0x88, 0x46, 0xEE, 0xB8, 0x14, 0xDE, 0x5E, 0x0B, 0xDB,
    0xE0, 0x32, 0x3A, 0x0A, 0x49, 0x06, 0x24, 0x5C, 0xC2, 0xD3, 0xAC, 0x62, 0x91, 0x95, 0xE4, 0x79,
    0xE7, 0xC8, 0x37, 0x6D, 0x8D, 0xD5, 0x4E, 0xA9, 0x6C, 0x56, 0xF4, 0xEA, 0x65, 0x7A, 0xAE, 0x08,
    0xBA, 0x78, 0x25, 0x2E, 0x1C, 0xA6, 0xB4, 0xC6, 0xE8, 0xDD, 0x74, 0x1F, 0x4B, 0xBD, 0x8B, 0x8A,
    0x70, 0x3E, 0xB5, 0x66, 0x48, 0x03, 0xF6, 0x0E, 0x61, 0x35, 0x57, 0xB9, 0x86, 0xC1, 0x1D, 0x9E,
    0xE1, 0xF8, 0x98, 0x11, 0x69, 0xD9, 0x8E, 0x94, 0x9B, 0x1E, 0x87, 0xE9, 0xCE, 0x55, 0x28, 0xDF,
    0x8C, 0xA1, 0x89, 0x0D, 0xBF, 0xE6, 0x42, 0x68, 0x41, 0x99, 0x2D, 0x0F, 0xB0, 0x54, 0xBB, 0x16,
]


def _sbox():
    return _SBOX


_RCON = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36]


def _expand_key(key):
    words = [list(key[i * 4:i * 4 + 4]) for i in range(4)]
    sbox = _sbox()
    for i in range(4, 44):
        tmp = list(words[i - 1])
        if i % 4 == 0:
            tmp = tmp[1:] + tmp[:1]
            tmp = [sbox[b] for b in tmp]
            tmp[0] ^= _RCON[i // 4 - 1]
        words.append([words[i - 4][j] ^ tmp[j] for j in range(4)])
    return words


def _aes128_encrypt_block(key, block):
    """AES-128 单块加密（FIPS-197），输入 16 字节，输出 16 字节"""
    words = _expand_key(key)
    # AES state 按列装入：s[r][c] = block[4c + r]
    s = [[block[r + 4 * c] for c in range(4)] for r in range(4)]
    sbox = _sbox()

    def add_round(rk):
        for c in range(4):
            for r in range(4):
                s[r][c] ^= words[rk * 4 + c][r]

    add_round(0)
    for rnd in range(1, 11):
        # SubBytes
        for r in range(4):
            for c in range(4):
                s[r][c] = sbox[s[r][c]]
        # ShiftRows
        for r in range(1, 4):
            s[r] = s[r][r:] + s[r][:r]
        # MixColumns（最后一轮不做）
        if rnd != 10:
            for c in range(4):
                a = [s[r][c] for r in range(4)]
                t = a[0] ^ a[1] ^ a[2] ^ a[3]
                for r in range(4):
                    s[r][c] = a[r] ^ t ^ _mul(a[r] ^ a[(r + 1) % 4], 2)
        add_round(rnd)
    out = bytearray(16)
    for c in range(4):
        for r in range(4):
            out[c * 4 + r] = s[r][c]
    return bytes(out)


def aes_ecb_pkcs7_encrypt(key, plaintext):
    """AES-128-ECB + PKCS7，返回密文字节（城院 CAS 的密码加密方式）"""
    pad = 16 - (len(plaintext) % 16)
    data = plaintext + bytes([pad]) * pad
    return b"".join(_aes128_encrypt_block(key, data[i:i + 16])
                    for i in range(0, len(data), 16))


def cas_cipher(text):
    """城院 CAS 密码加密：AES-128-ECB/PKCS7 → Base64（等价于登录页里的 CryptoJS 调用）"""
    return base64.b64encode(aes_ecb_pkcs7_encrypt(CAS_AES_KEY, text.encode("utf-8"))).decode("ascii")


# ---------------------------------------------------------------- CAS 登录页解析（纯函数，可自测）
_FORM_RE = re.compile(r'<form\s+id="fm1"[^>]*?action="([^"]+)"', re.I)
_EXEC_RE = re.compile(r'<input[^>]*?name="execution"[^>]*?value="([^"]*)"', re.I)
_LT_RE = re.compile(r'<input[^>]*?name="lt"[^>]*?value="([^"]*)"', re.I)
_ERR_RE = re.compile(r'class="[^"]*errorMsg[^"]*"[^>]*>\s*([^<]{1,120})', re.I)

# CAS 失败页常见英文文案 → 用户可读中文（借鉴 #35 的实测映射）
_CAS_ERR_ZH = [
    ("cannot be determined to be authentic", "用户名或密码错误"),
    ("account was locked", "账号已被锁定，请稍后再试或先在校园门户解锁"),
    ("captcha", "需要图形验证码：请先在浏览器登录一次校园门户再试"),
    ("Authentication handler", "登录方式不被支持（请用账号密码方式）"),
]


def is_cas_login_page(text, final_url=""):
    return ('id="fm1"' in text) and ("execution" in text) and \
           (not final_url or URL_CAS.split("//")[1].split("/")[0] in final_url)


def parse_cas_login(html_text):
    """从 CAS 登录页提取表单 action 与 execution；解析失败抛 SyncError"""
    m = _FORM_RE.search(html_text)
    action = html_lib.unescape(m.group(1)) if m else ""
    if not action:
        raise SyncError("统一身份认证页面解析失败（未找到登录表单），平台可能已改版，请反馈本条信息")
    e = _EXEC_RE.search(html_text)
    if not e:
        raise SyncError("统一身份认证页面解析失败（未找到 execution），平台可能已改版，请反馈本条信息")
    lt = _LT_RE.search(html_text)
    return {"action": action, "execution": e.group(1), "lt": lt.group(1) if lt else ""}


def cas_origin(page_url):
    """从实际 CAS 表单页派生 Origin，避免把协议或端口写死。"""
    parsed = urllib.parse.urlsplit(page_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise SyncError("统一身份认证页面地址异常，无法确定请求来源")
    return "%s://%s" % (parsed.scheme, parsed.netloc)


def parse_cas_error(html_text):
    """尽力从 CAS 登录失败页提取错误文案并译成中文（拿不到就返回空）"""
    m = _ERR_RE.search(html_text)
    if not m:
        return ""
    raw = m.group(1).strip()
    for key, zh in _CAS_ERR_ZH:
        if key.lower() in raw.lower():
            return zh
    return raw


# ---------------------------------------------------------------- TLS 信任锚
# 有些 Windows 上的 python（典型是 msys2 的 mingw64 版）自带 OpenSSL 却**没有 CA 信任库**，
# 于是对任何 https 站点都报 CERTIFICATE_VERIFY_FAILED: unable to get local issuer
# certificate —— 实测学校站与 GitHub、百度一起挂，站点本身毫无问题。旧代码把这种失败
# 说成「请检查本机能否访问 courses.hzcu.edu.cn」，把排查方向整个带偏。
# 这里显式补齐信任锚，并把真实原因说清楚（绝不放宽校验，只补锚点）。
# ---------------------------------------------------------------- TLS 信任根
_TLS_CTX = None


def ca_bundle_candidates():
    """本机可能的 CA bundle，按可信度排序（certifi 装在哪都算，用户目录也一样正常）。"""
    paths = []
    try:
        import certifi
        paths.append(certifi.where())
    except Exception:
        pass
    paths += [
        r"C:\Program Files\Common Files\SSL\cert.pem",
        r"C:\msys64\usr\ssl\certs\ca-bundle.crt",
        r"C:\msys64\mingw64\etc\ssl\certs\ca-bundle.crt",
        os.path.join(sys.prefix, "ssl", "cert.pem"),
        os.path.join(sys.prefix, "etc", "ssl", "certs", "ca-bundle.crt"),
        "/etc/ssl/certs/ca-certificates.crt",
        "/etc/pki/tls/certs/ca-bundle.crt",
        "/etc/ssl/cert.pem",
    ]
    return [p for p in paths if p and os.path.isfile(p)]


def tls_anchor_count(ctx):
    """已加载的可信根证书数量（0 = 这个上下文任何 https 都验不过）。"""
    stats = ctx.cert_store_stats()
    return stats.get("x509_ca", 0) or stats.get("x509", 0)


def fill_trust_anchors(ctx, bundles=None):
    """ctx 一个可信根都没有时，逐个试外部 bundle 灌进去。
    成功返回用到的路径；全部失败返回 None —— 绝不抛异常（没网/没装证书也要能起服务）。"""
    if tls_anchor_count(ctx) > 0:
        return None
    for path in (ca_bundle_candidates() if bundles is None else bundles):
        try:
            ctx.load_verify_locations(cafile=path)
        except Exception:
            continue
        if tls_anchor_count(ctx) > 0:
            return path
    return None


def tls_context():
    """带可信根的 SSL 上下文，进程内建一次即复用。
    某些 Python 发行版（msys2/mingw 的 pythonw 就是典型）默认信任库是空的，
    于是本机所有 https 都被拒成「unable to get local issuer certificate」，
    看起来像学校站点挂了，其实是解释器不认任何证书。这里补外部 bundle 兜底。"""
    global _TLS_CTX
    if _TLS_CTX is None:
        ctx = ssl.create_default_context()
        fill_trust_anchors(ctx)
        _TLS_CTX = ctx
    return _TLS_CTX


def https_handler():
    return urllib.request.HTTPSHandler(context=tls_context())


def net_error_text(reason):
    """底层网络异常 → 人话。TLS 信任库缺失是本机解释器的事，不能赖学校站点。"""
    raw = str(reason)
    if "CERTIFICATE_VERIFY_FAILED" in raw or "certificate verify failed" in raw:
        return ("本机 Python（%s）没有可用的 TLS 信任库，任何 https 都会被拒成"
                "「unable to get local issuer certificate」，这与学校站点无关 —— "
                "执行 pip install certifi 或换用 python.org 官方安装的 Python 即可解决。"
                ) % (sys.executable or "python")
    return "%s（请检查本机能否访问 courses.hzcu.edu.cn）" % raw


# ---------------------------------------------------------------- HTTP 会话
class Session:
    """带 CookieJar 的 urllib 会话（跨 courses/identity/ca 三个域自动带 cookie）。
    强制直连：校园 CAS / Tronclass 都在国内，系统代理（Clash 等）只会把请求带进 502。"""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            https_handler(),
            urllib.request.HTTPCookieProcessor(self.jar))

    def open(self, url, data=None, headers=None, timeout=25):
        req = urllib.request.Request(url, data=data, headers=headers or {},
                                     method="POST" if data is not None else "GET")
        req.add_header("User-Agent", UA)
        try:
            resp = self.opener.open(req, timeout=timeout)
            return resp, resp.read()
        except urllib.error.HTTPError as e:
            return e, e.read()
        except urllib.error.URLError as e:
            raise SyncError("网络请求失败：%s" % net_error_text(e.reason))


def _resp_text(resp, body):
    status = getattr(resp, "status", None) or getattr(resp, "code", 0)
    return status, body.decode("utf-8", "replace")


def clone_session(s):
    """并行采集用：克隆会话 —— 共享同一 CookieJar（登录态一致），opener 各自独立。
    http.cookiejar.CookieJar 内部自带线程锁，多线程共用是安全的；
    urllib opener 本身无每请求共享状态，逐线程各建一个即可。"""
    t = Session()
    t.jar = getattr(s, "jar", t.jar)   # 自检桩（object()）没有 jar 时退回空 jar，桩下 api_json 本就被替换
    t.opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        https_handler(),
        urllib.request.HTTPCookieProcessor(t.jar))
    return t


# ---------------------------------------------------------------- 登录
def hzcu_login(account, password):
    """学在城院账号密码登录，返回已建立会话的 Session。失败抛 SyncError。"""
    if not account or not password:
        raise SyncError("缺少学在城院账号或密码：请在工作台「学在城院登录」保存凭据，"
                        "或在本目录创建 wb_local.json（已被 .gitignore 排除）")
    s = Session()

    # 1) 先打一个 API，让 302 链把会话带到 CAS 登录页
    resp, body = s.open(URL_LMS + "/api/todos?no-intercept=true")
    status, text = _resp_text(resp, body)
    if not is_cas_login_page(text, getattr(resp, "url", "")):
        # 返回的已是 JSON → 会话仍然有效，无需登录
        try:
            json.loads(text)
            return s
        except ValueError:
            raise SyncError("统一身份认证跳转异常（HTTP %s），平台可能已改版，请反馈本条信息" % status)

    # 2) 解析账密表单并提交（密码 AES-128-ECB 加密，首次登录无验证码）
    form_info = parse_cas_login(text)
    form = urllib.parse.urlencode({
        "username": account,
        "password": cas_cipher(password),
        "authType": "0",
        "lt": form_info["lt"],
        "execution": form_info["execution"],
        "_eventId": "submit",
        "validTime": "5",
    }).encode()
    cas_page_url = getattr(resp, "url", URL_CAS + "/cas/login")
    post_url = urllib.parse.urljoin(cas_page_url, form_info["action"])
    resp2, body2 = s.open(post_url, data=form, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": cas_page_url,
        "Origin": cas_origin(cas_page_url),
    })
    status2, text2 = _resp_text(resp2, body2)

    # 3) 成功：最终应回到课程端并返回 JSON；失败：仍是 CAS 登录页
    if is_cas_login_page(text2, getattr(resp2, "url", "")):
        err = parse_cas_error(text2)
        if err:
            raise SyncError("统一身份认证登录失败：%s（请检查账号密码；若多次失败或平台要求验证，"
                            "请先到 course.hzcu.edu.cn 网页端正常登录一次后再试）" % err)
        raise SyncError("统一身份认证未完成：认证端仍返回登录页（可能是认证请求被拒绝或平台协议已变更；"
                        "请先到 course.hzcu.edu.cn 网页端正常登录一次后再试）")
    try:
        json.loads(text2)
        return s
    except ValueError:
        # POST 链路没有直接落到 JSON（例如回到了门户页）：再探一次 API 确认会话
        resp3, body3 = s.open(URL_LMS + "/api/todos?no-intercept=true",
                              headers={"Accept": "application/json",
                                       "X-Requested-With": "XMLHttpRequest"})
        status3, text3 = _resp_text(resp3, body3)
        try:
            json.loads(text3)
            return s
        except ValueError:
            raise SyncError("登录后未能建立课程端会话（HTTP %s），平台可能已改版，请反馈本条信息" % status3)


# ---------------------------------------------------------------- Tronclass API
_API_HEADERS = {
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": URL_LMS + "/",
}


def api_json(s, path):
    resp, body = s.open(URL_LMS + path, headers=_API_HEADERS)
    _, text = _resp_text(resp, body)
    try:
        return json.loads(text)
    except ValueError:
        if "fm1" in text or "execution" in text:
            raise SessionLost("登录态已失效")
        raise SyncError("接口 %s 返回非 JSON（平台可能已改版）：%s…" % (path, text[:80]))


def _as_int(v, default):
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def paged(s, base_path, array_key, page_size=50, max_items=500):
    """Tronclass 列表接口统一翻页：{ <arrayKey>: [...], pages, page, ... }"""
    out = []
    sep = "&" if "?" in base_path else "?"
    page = 1
    while len(out) < max_items:
        data = api_json(s, "%s%spage=%d&page_size=%d" % (base_path, sep, page, page_size))
        arr = data.get(array_key) if isinstance(data, dict) else None
        arr = arr if isinstance(arr, list) else []
        out.extend(arr)
        pages = _as_int(data.get("pages"), 1) if isinstance(data, dict) else 1
        if not arr or page >= pages:
            break
        page += 1
    return out[:max_items]


# ---------------------------------------------------------------- 数据映射（纯函数，可自测）
def to_bj_time(s):
    """Tronclass 时间（UTC ISO8601）→ 北京时间 'YYYY-MM-DD HH:MM'；解析不了就原样返回"""
    t = str(s or "").strip()
    if not t:
        return ""
    m = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})", t)
    if not m:
        m2 = re.match(r"(\d{4})-(\d{1,2})-(\d{1,2})", t)
        return ("%04d-%02d-%02d" % tuple(int(x) for x in m2.groups())) if m2 else t
    try:
        dt = datetime.datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return t.replace("T", " ")[:16]
    if dt.tzinfo is None:
        return dt.strftime("%Y-%m-%d %H:%M")  # 无时区视为北京时间
    bj = dt.astimezone(datetime.timezone(datetime.timedelta(hours=8)))
    return bj.strftime("%Y-%m-%d %H:%M")


def _type_cn(t):
    t = str(t or "").strip().lower()
    return TYPE_CN.get(t) or (t if t else "作业")


def _strip_html(text, limit=200):
    """HTML 片段 → 纯文本摘要（课件描述 / 作业要求 / 详情描述共用，#57/#58）
    去 tag → 反转义 → 空白压成单空格 → 删除与中文相邻的空格（换行断词残留）"""
    t = re.sub(r"<[^>]+>", " ", str(text or ""))
    t = html_lib.unescape(t)
    t = re.sub(r"\s+", " ", t).strip()
    return re.sub(r" ?([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]) ?", r"\1", t)[:limit]


def todo_to_assignment(t):
    """/api/todos 的 todo_list 条目 → payload.assignments 条目（未完成待办）"""
    return {
        "course": str(t.get("course_name") or "").strip() or "通用",
        "title": str(t.get("title") or "").strip(),
        "kind": _type_cn(t.get("type")),
        "due": to_bj_time(t.get("end_time")),
        "status": "todo",
        "note": "",
    }


def hw_to_assignment(hw, course_name):
    """/api/courses/{id}/homework-activities 条目 → payload.assignments 条目
    （#58：列表里已有的要求描述直接进 note；id 透传供详情补拉）"""
    if hw.get("submitted"):
        status = "submitted"
    elif hw.get("is_closed"):
        status = "unknown"   # 已截止未提交：平台不再接受，标记未知由页面归档
    else:
        status = "todo"
    notes = []
    if hw.get("is_in_progress"):
        notes.append("进行中")
    desc = _strip_html(hw.get("description") or hw.get("intro") or "", 300)
    if desc:
        notes.append("要求：" + desc)
    return {
        "course": str(course_name or "").strip() or "通用",
        "title": str(hw.get("title") or "").strip(),
        "kind": _type_cn(hw.get("type")),
        "due": to_bj_time(hw.get("end_time") or hw.get("deadline")),
        "status": status,
        "id": str(hw.get("id") or ""),
        "note": "；".join(notes),
    }


def _detail_note_parts(data):
    """作业详情响应 → (要求, 成绩, 批语) 三元组（宽松容错，找不到给空串，#58）
    成绩/批语优先取 student_submission 子对象，退化取顶层同名字段。"""
    if not isinstance(data, dict):
        return "", "", ""
    desc = _strip_html(data.get("description") or data.get("intro") or "", 300)
    sub = data.get("student_submission") if isinstance(data.get("student_submission"), dict) else {}
    score = ""
    for k in ("score", "grade", "final_score"):
        if sub.get(k) is not None:
            score = str(sub[k]).strip()
            break
    if not score:
        for k in ("score", "grade"):
            if data.get(k) is not None:
                score = str(data[k]).strip()
                break
    comment = ""
    for k in ("comment", "teacher_comment", "feedback"):
        if sub.get(k) or data.get(k):
            comment = _strip_html(sub.get(k) or data.get(k) or "", 200)
            break
    return desc, score, comment


def hw_detail_enrich(s, a, errors, failed_courses):
    """已提交作业按 id 拉详情，把要求原文/成绩/老师批语补进 note（#58）。
    失败不阻断：每个课程只记一条 errors（防几十条作业刷屏），薄记忆保留。"""
    if not a.get("id"):
        return a
    try:
        data = api_json(s, "/api/homework-activities/%s" % a["id"])
    except SessionLost:
        raise
    except SyncError as e:
        if a["course"] not in failed_courses:
            failed_courses.add(a["course"])
            errors.append("%s（作业详情未取到，仅保留标题记忆）：%s" % (a["course"], e))
        return a
    desc, score, comment = _detail_note_parts(data)
    extra = []
    if desc and "要求：" not in a["note"]:
        extra.append("要求：" + desc)
    if score:
        extra.append("成绩：" + score)
    if comment:
        extra.append("批语：" + comment)
    if extra:
        a["note"] = (a["note"] + "；" if a["note"] else "") + "；".join(extra)
    return a


def course_to_entry(c):
    """/api/my-courses 的 courses 条目 → payload.courses 条目"""
    return {"id": str(c.get("id") or "").strip(), "name": str(c.get("name") or "").strip()}


# ---------------------------------------------------------------- 课件（资料目录）采集
MATERIALS_MAX = 400   # 单课程课件条目上限（接口异常返回超大列表时防爆炸）
FOLDERS_MAX = 20      # 资料目录一级展开上限


def _material_to_entry(m, course_name, folder=""):
    """Tronclass 资料条目 → payload.materials 条目（宽松容错，无标题返回 None）"""
    if not isinstance(m, dict):
        return None
    title = str(m.get("title") or m.get("name") or m.get("file_name") or "").strip()
    if not title:
        return None
    if folder:
        title = folder + " · " + title
    note = _strip_html(m.get("description") or m.get("intro") or "", 200)
    if not note:
        ftype = str(m.get("material_type") or m.get("file_type") or m.get("type") or "").strip()
        if ftype:
            note = "文件类型：" + ftype
    return {"course": str(course_name or "").strip() or "通用", "title": title, "kind": "课件", "note": note}


def _materials_page(s, cid, folder_id):
    """拉课程资料目录的一页。Tronclass 返回 {materials: [...], folders: [...]}；
    平台改版返回裸数组 / 字段改名时宽松兜底，拿不到就返回空（绝不抛 KeyError）。"""
    data = api_json(s, "/api/courses/%s/materials?folder_id=%s&page=1&page_size=100" % (cid, folder_id))
    if isinstance(data, list):
        return [], data
    if not isinstance(data, dict):
        return [], []
    mats = data.get("materials") if isinstance(data.get("materials"), list) else []
    folders = data.get("folders") if isinstance(data.get("folders"), list) else []
    return folders, mats


def collect_course_materials(s, cid, cname, errors):
    """某门课的课件（资料目录）采集：单项失败只记 errors，不阻断整体（#57）。
    根目录拉一页后，对目录（folder）一级展开；条目总量受 MATERIALS_MAX 限制。"""
    out = []
    try:
        folders, mats = _materials_page(s, cid, 0)
    except SessionLost:
        raise
    except SyncError as e:
        errors.append("%s（课件）：%s" % (cname, e))
        return out
    for m in mats:
        e = _material_to_entry(m, cname)
        if e:
            out.append(e)
        if len(out) >= MATERIALS_MAX:
            return out
    for f in folders[:FOLDERS_MAX]:
        if not isinstance(f, dict):
            continue
        fname = str(f.get("name") or f.get("title") or "").strip()
        fid = str(f.get("id") or "").strip()
        if not fid:
            continue
        try:
            _, sub = _materials_page(s, cid, fid)
        except SessionLost:
            raise
        except SyncError:
            continue          # 单个目录失败不算课程失败
        for m in sub:
            e = _material_to_entry(m, cname, fname)
            if e:
                out.append(e)
            if len(out) >= MATERIALS_MAX:
                return out
    return out


# ---------------------------------------------------------------- 采集
def hzcu_collect(s):
    """拉取课程 / 待办 / 每门课作业；单项失败不阻断整体，逐条记入 errors"""
    errors = []
    courses = []
    try:
        cond = urllib.parse.quote(json.dumps(
            {"keyword": "", "status": ["ongoing", "notStarted", "ended"]},
            separators=(",", ":")))
        courses = paged(s, "/api/my-courses?conditions=" + cond, "courses")
    except SessionLost:
        raise
    except SyncError as e:
        errors.append("课程列表：%s" % e)
    if not courses:
        errors.append("课程列表为空：请确认账号下有课程，或平台已改版")

    by_key = {}
    order = []
    materials = []

    def put(a):
        if not a["title"]:
            return
        key = (a["course"], a["title"])
        if key not in by_key:
            order.append(key)
        by_key[key] = a   # homework-activities（带提交状态）覆盖同键的 todos 条目

    try:
        # 待办是作业的主入口：必须翻页全采（平台按 page/page_size 分页，第一页通常只有十来条，
        # 不翻页 = 登录后作业列不全）。平台若忽略翻页参数返回重复页，put() 按（课程,标题）去重兜底。
        todos = paged(s, "/api/todos?no-intercept=true", "todo_list")
        for t in todos:
            if isinstance(t, dict):
                put(todo_to_assignment(t))
    except SessionLost:
        raise
    except SyncError as e:
        errors.append("待办列表：%s" % e)

    # 逐课作业 + 课件：线程池并行采集（2.6.0）。
    # 原串行逐课是同步慢的主因：每门课 2+ 个上游请求 × 课程数，排队几十秒起步。
    # 每线程用克隆会话（共享 CookieJar）；单项失败不阻断整体，逐条记入 errors；
    # 结果在主线程按课程顺序合并，保持与串行版完全一致的输出顺序。
    def collect_one_course(c):
        cid = str(c.get("id") or "").strip()
        cname = str(c.get("name") or "").strip() or str(c.get("course_code") or "").strip() \
            or ("课程 " + cid)
        if not cid:
            return cname, [], [], []
        ts = clone_session(s)
        local_errors = []
        hws = []
        try:
            hws = paged(ts, "/api/courses/%s/homework-activities" % cid, "homework_activities")
        except SessionLost:
            raise
        except SyncError as e:
            local_errors.append("%s：%s" % (cname, e))
        # 课件（资料目录）：与作业采集相互独立，任一失败只记 errors（#57）
        mats = collect_course_materials(ts, cid, cname, local_errors)
        return cname, hws, mats, local_errors

    if courses:
        workers = max(1, min(COLLECT_WORKERS, len(courses)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(collect_one_course, c) for c in courses]
        # with 块退出即等全部线程收尾；SessionLost 在主线程统一重新抛出，
        # 让上层（collect_payload）走「重登再拉」的既有路径。
        lost = False
        for f in futures:
            try:
                cname, hws, mats, local_errors = f.result()
            except SessionLost:
                lost = True
                continue
            errors.extend(local_errors)
            materials.extend(mats)
            for hw in hws:
                if isinstance(hw, dict):
                    put(hw_to_assignment(hw, cname))
        if lost:
            raise SessionLost("登录态已失效")
    # 已提交作业补详情：要求原文 / 成绩 / 老师批语 → note（#58）
    failed_courses = set()
    for a in by_key.values():
        if a.get("status") == "submitted" and a.get("id"):
            hw_detail_enrich(s, a, errors, failed_courses)

    return {
        "fetchedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "hzcu-xzc",
        "courses": [course_to_entry(c) for c in courses if isinstance(c, dict)],
        "assignments": [by_key[k] for k in order],
        "materials": materials,   # 课程课件（资料目录，含目录一级展开）
        "errors": errors,
    }


# ---------------------------------------------------------------- 凭据
def load_cfg_creds():
    try:
        with open(CFG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        if cfg.get("account") and cfg.get("password"):
            return str(cfg["account"]), str(cfg["password"])
    except (OSError, ValueError):
        pass
    return None, None


_STATE = {"by_account": {}, "lock": threading.Lock()}
# #92：缓存按账号分桶（by_account[account] = payload）。旧版单份 _STATE["last"]
# 会让 GET /data 把上一个同步账号的数据端给任何人 —— 多账号串号的根因之一。


def save_creds(account, password):
    """把验证成功的凭据写进 wb_local.json（.gitignore 排除，永不进仓库）"""
    try:
        with open(CFG_FILE, "w", encoding="utf-8") as f:
            json.dump({"account": account, "password": password}, f, ensure_ascii=False)
        return True
    except OSError:
        return False


def add_log_local(msg):
    try:
        with open(os.path.join(HERE, "wb_local.log"), "a", encoding="utf-8") as f:
            f.write("%s %s\n" % (datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), msg))
    except OSError:
        pass


def collect_payload(creds=None, force=True):
    """入口：优先用请求携带的凭据（仅内存），否则用 wb_local.json。带缓存（按账号分桶，#92）。
    返回的 payload 带属主标记 account = 本次登录的学在城院账号，页面据此校验数据归属。"""
    with _STATE["lock"]:
        account, password = None, None
        if creds and creds.get("account") and creds.get("password"):
            account, password = str(creds["account"]), str(creds["password"])
        else:
            account, password = load_cfg_creds()
        cached = _STATE["by_account"].get(account or "")
        if not force and cached is not None:
            return cached, True
        s = hzcu_login(account, password)
        try:
            payload = hzcu_collect(s)
        except SessionLost:
            # 采集中途登录态失效：重登一次再拉
            s = hzcu_login(account, password)
            payload = hzcu_collect(s)
        payload["account"] = account or ""   # #92 属主标记：这份数据是谁的
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)
        except OSError:
            pass
        _STATE["by_account"][account or ""] = payload
        return payload, False


# ---------------------------------------------------------------- HTTP 服务
# ---- Qoder CLI（工作台唯一 Agent，页面不出本机、提示词不出本机） ----
# 语义对齐本机 RoleWeave（数字员工工作台）的岗位包配置：引擎绑定锁定 → CLI 解析
# 顺序（显式环境变量优先且非法即失败）→ 模型跟随账号默认 + 档位只在账号目录里
# 出现才可选 → 权限 defaultEffect=deny + 只读白名单 → MCP 默认拒绝 → 逐任务/逐日
# 预算 → 环境变量白名单隔离。全部读同目录 agent.config.json；文件缺失或 JSON 坏了
# 回退到下面这份内置默认值，并在 /agent/qoder/status 里回报 configError。
AGENT_CONFIG_FILE = os.path.join(HERE, "agent.config.json")

AGENT_CONFIG_DEFAULTS = {
    "schemaVersion": "hwdesk-agent.v1",
    "engine": {"schemaVersion": "roleweave-agent-binding.v1",
               "name": "qoder", "locked": True},
    "cli": {
        "envOrder": ["HWDESK_QODER_CLI", "ORG_WORKBENCH_QODER_BIN",
                     "DIGITAL_EMPLOYEE_QODER_COMMAND"],
        "envFailClosed": ["HWDESK_QODER_CLI"],
        "pathNames": ["qodercli", "qoderclicn", "qoder"],
        "userCandidates": [
            "~/.qoder-cn/bin/qoderclicn/qoderclicn.exe",
            "~/.qoder-cn/bin/qoderclicn/qoderclicn",
            "~/.qoder-cn/bin/qodercli/qodercli.exe",
            "~/.qoder-cn/bin/qodercli/qodercli",
            "~/.qoder-cn/entry/qodercn.cmd",
            "~/.qoder-cn/entry/qoder",
        ],
        "probeTimeoutMs": 6000,   # 实测 --list-models 冷启动 1.7~2.0s，3s 会被偶发抖动打成 unavailable
        "catalogCacheSeconds": 600,
    },
    "model": {
        "policy": "follow-account-default",
        "default": "provider-default",
        "catalogArgs": ["--list-models"],
        "allowCustom": True,
        "customModelFormat": "qoder",
        "tiers": [
            {"id": "provider-default", "name": "跟随账号默认", "tier": "default",
             "model": None, "group": "default"},
            {"id": "auto", "name": "Auto · Qoder", "tier": "auto", "model": "auto",
             "billing": "qoder", "group": "tiers"},
            {"id": "efficient", "name": "Efficient", "tier": "economy", "model": "efficient",
             "billing": "qoder", "group": "tiers"},
            {"id": "performance", "name": "Performance", "tier": "balanced",
             "model": "performance", "billing": "qoder", "group": "tiers"},
            {"id": "ultimate", "name": "Ultimate", "tier": "powerful", "model": "ultimate",
             "billing": "qoder", "group": "tiers"},
        ],
    },
    "permissions": {
        "schemaVersion": "workbench-permissions.v1",
        "defaultEffect": "deny",
        "allow": ["Read", "Grep", "Glob"],
        "deny": ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "Shell",
                 "WebFetch", "WebSearch", "Task", "ImageGen"],
        "permissionMode": "default",
        "workspace": "app",
    },
    "mcp": {"schemaVersion": "workbench-mcp.v1", "defaultEffect": "deny", "servers": []},
    "isolation": {
        "cleanEnv": True,
        "envAllow": [
            "PATH", "HOME", "USER", "USERPROFILE", "USERNAME", "LOGNAME", "SHELL",
            "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
            "PATHEXT", "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR",
            "ALLUSERSPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
            "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
            "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
            "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
            # QODER_CONFIG_DIR 要放：CLI 靠它找到 ~/.qoder-cn 里的登录态（零 Key 的前提）。
            # 凭据类变量（PAT / API Key / session token）一律不放、并无条件剥：
            # 这条通道只用本机账号自己的登录态，绝不借用拉起本机桥的那个会话的凭据。
            "QODER_CONFIG_DIR",
        ],
        "envDropAlways": [
            "QODER_SDK_AUTH_PAYLOAD_FILE", "QODER_AGENT_SDK_ENTRYPOINT",
            "QODER_AGENT_SDK_DAEMON", "QODER_AGENT_SDK_VERSION",
            "QODER_API_KEY", "QODER_PERSONAL_ACCESS_TOKEN", "QODER_SESSION_ACCESS_TOKEN",
        ],
        "settingSources": "",
        "noSessionPersistence": True,
    },
    "budget": {
        "perTask": {"timeoutSeconds": 300, "maxPromptChars": 150000,
                    "maxOutputTokens": 8000, "iterations": 8},
        "perDay": {"turns": 200, "tokens": 200000},
    },
    "transport": {"outputFormat": "stream-json", "singleFlight": True, "killWindow": True},
}

# 不可协商的硬闸：配置文件写坏了、或被误改成放开写/命令/绕过权限时，这里兜住。
FORBIDDEN_PERMISSION_MODES = ("bypass_permissions", "dont_ask", "auto")
READONLY_TOOLS = ("Read", "Grep", "Glob", "LS", "ViewImage")
MAX_CONFIG_BYTES = 256 * 1024

_agent_cfg_cache = {"key": None, "data": None, "error": "", "warnings": []}


def _deep_merge(base, override):
    """字典逐层合并；列表和标量整体覆盖（配置里写 allow 就是替换而非追加）。"""
    out = {}
    for k, v in (base or {}).items():
        out[k] = _deep_merge(v, {}) if isinstance(v, dict) else (
            list(v) if isinstance(v, list) else v)
    for k, v in (override or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        elif isinstance(v, list):
            out[k] = list(v)
        else:
            out[k] = v
    return out


def _tool_names(values):
    out = []
    for v in values or []:
        if isinstance(v, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.:-]{0,40}", v):
            if v not in out:
                out.append(v)
    return out


def _clamp(value, lo, hi, fallback):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(hi, n))


def _sanitize_config(cfg):
    """把任意（可能被改坏的）配置收敛回安全形状，并把每次收敛记成 warnings，
    让页面/自检看得见「配置写了什么、桥实际执行了什么」。"""
    warnings = []
    out = _deep_merge(AGENT_CONFIG_DEFAULTS, cfg)
    eng = out.setdefault("engine", {})
    if eng.get("name") != "qoder":
        warnings.append("engine.name 只支持 qoder（本机唯一免密钥通道），已按 qoder 执行")
        eng["name"] = "qoder"
    perm = out.setdefault("permissions", {})
    if perm.get("defaultEffect", "deny") != "deny":
        warnings.append("permissions.defaultEffect 必须是 deny，已强制为 deny")
        perm["defaultEffect"] = "deny"
    mode = str(perm.get("permissionMode") or "default")
    if mode in FORBIDDEN_PERMISSION_MODES or mode not in ("default", "accept_edits"):
        warnings.append("permission-mode %s 不允许（绝不绕过权限确认），已强制 default" % mode)
        mode = "default"
    perm["permissionMode"] = mode
    perm["allow"] = _tool_names(perm.get("allow"))
    perm["deny"] = _tool_names(perm.get("deny"))
    mcp = out.setdefault("mcp", {})
    if mcp.get("defaultEffect", "deny") != "deny":
        warnings.append("mcp.defaultEffect 必须是 deny，已强制为 deny")
        mcp["defaultEffect"] = "deny"
    servers = []
    for s in (mcp.get("servers") or []):
        name = s.get("name") if isinstance(s, dict) else None
        if isinstance(s, dict) and s.get("effect") == "allow" \
                and isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", name):
            servers.append(s)
    mcp["servers"] = servers
    # schemaVersion 是 RoleWeave 的写法：形状对不上就明说，绝不「猜」成新语义。
    # 本机只实现 v1 这一套解析器，所以不认识的值一律收敛回 v1 并留告警。
    for node, expected, label in (
            (out, "hwdesk-agent.v1", "配置文件"),
            (eng, "roleweave-agent-binding.v1", "engine"),
            (perm, "workbench-permissions.v1", "permissions"),
            (mcp, "workbench-mcp.v1", "mcp")):
        got = node.get("schemaVersion")
        if got not in (None, "", expected):
            warnings.append("%s.schemaVersion 写了 %r（本机只认 %s），已按 %s 解析"
                            % (label, got, expected, expected))
        node["schemaVersion"] = expected
    iso = out.setdefault("isolation", {})
    cli = out.setdefault("cli", {})
    cli["envOrder"] = [v for v in (cli.get("envOrder") or [])
                       if isinstance(v, str) and re.fullmatch(r"[A-Za-z0-9_]{1,64}", v)]
    if not cli["envOrder"]:
        cli["envOrder"] = list(AGENT_CONFIG_DEFAULTS["cli"]["envOrder"])
    # 只有 hwdesk 自己的变量有「非法即停摆」的资格，且必须是 envOrder 里出现过的名字。
    cli["envFailClosed"] = [v for v in (cli.get("envFailClosed") or [])
                            if v in cli["envOrder"]]
    if "HWDESK_QODER_CLI" in cli["envOrder"] and "HWDESK_QODER_CLI" not in cli["envFailClosed"]:
        cli["envFailClosed"] = ["HWDESK_QODER_CLI"] + cli["envFailClosed"]
    iso["envAllow"] = [k for k in (iso.get("envAllow") or [])
                       if isinstance(k, str) and re.fullmatch(r"[A-Za-z0-9_]{1,64}", k)]
    if not iso["envAllow"]:
        iso["envAllow"] = list(AGENT_CONFIG_DEFAULTS["isolation"]["envAllow"])
    for k in iso.get("envDropAlways") or []:
        if k in iso["envAllow"]:
            iso["envAllow"].remove(k)
    if not isinstance(iso.get("settingSources"), str):
        iso["settingSources"] = ""
    bud = out.setdefault("budget", {})
    task = bud.setdefault("perTask", {})
    day = bud.setdefault("perDay", {})
    task["timeoutSeconds"] = _clamp(task.get("timeoutSeconds"), 10, 900, 300)
    task["maxPromptChars"] = _clamp(task.get("maxPromptChars"), 1000, 1000000, 150000)
    task["maxOutputTokens"] = _clamp(task.get("maxOutputTokens"), 0, 32000, 8000)
    task["iterations"] = _clamp(task.get("iterations"), 1, 64, 8)
    day["turns"] = _clamp(day.get("turns"), 1, 10000, 200)
    day["tokens"] = _clamp(day.get("tokens"), 0, 100000000, 200000)
    out["budget"] = {"perTask": task, "perDay": day}
    tr = out.setdefault("transport", {})
    if tr.get("outputFormat") not in ("stream-json", "json", "text"):
        tr["outputFormat"] = "stream-json"
    return out, warnings


def load_agent_config(path=None):
    """读 agent.config.json（缺文件/坏 JSON 一律回退内置默认值，不抛异常）。
    返回 (cfg, error, warnings)；error 非空表示配置没生效，页面要能看懂为什么。"""
    p = path or AGENT_CONFIG_FILE
    try:
        st = os.stat(p)
        key = (p, int(st.st_mtime), st.st_size)
    except OSError:
        key = (p, None, None)
    if _agent_cfg_cache["key"] == key and _agent_cfg_cache["data"] is not None:
        return _agent_cfg_cache["data"], _agent_cfg_cache["error"], _agent_cfg_cache["warnings"]
    error = ""
    data = None
    if key[1] is not None:
        try:
            if st.st_size > MAX_CONFIG_BYTES:
                raise ValueError("文件超过 %d 字节" % MAX_CONFIG_BYTES)
            with open(p, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if not isinstance(raw, dict):
                raise ValueError("顶层必须是 JSON 对象")
            data = raw
        except (OSError, ValueError) as e:
            error = "agent.config.json 未能生效（已回退内置默认值）：%s" % e
    merged = data if data is not None else AGENT_CONFIG_DEFAULTS
    cfg, warnings = _sanitize_config(merged)
    _agent_cfg_cache.update(key=key, data=cfg, error=error, warnings=warnings)
    return cfg, error, warnings


def agent_config():
    return load_agent_config()[0]


def _is_model_id(value):
    return isinstance(value, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/\-]{0,99}", value))


def executable_target(candidate):
    """候选路径 → 真实可执行文件（realpath + 常规文件 + 可执行校验），否则空串。
    Windows 只认 PATHEXT 里的可执行后缀；扩展名是 .json/.py 这类一律拒绝。"""
    if not isinstance(candidate, str) or not candidate or "\0" in candidate:
        return ""
    if os.name == "nt":
        exts = [e.lower() for e in (os.environ.get("PATHEXT") or
                                    ".COM;.EXE;.BAT;.CMD").split(";") if e]
    try:
        real = os.path.realpath(os.path.expanduser(candidate))
    except OSError:
        return ""
    if not os.path.isfile(real):
        return ""
    if os.name == "nt":
        return real if os.path.splitext(real)[1].lower() in exts else ""
    return real if os.access(real, os.X_OK) else ""


def find_on_path(name, env=None):
    env = env if env is not None else os.environ
    path_value = env.get("PATH") or ""
    if not path_value:
        return ""
    if os.name == "nt" and not os.path.splitext(name)[1]:
        exts = [e for e in (env.get("PATHEXT") or ".COM;.EXE;.BAT;.CMD").split(";") if e]
    else:
        exts = [""]
    for directory in path_value.split(os.pathsep):
        if not directory:
            continue
        for ext in exts:
            hit = executable_target(os.path.join(directory, name + ext))
            if hit:
                return hit
    return ""


def qoder_entry_detail(cfg=None):
    """定位 Qoder CLI，顺序照 RoleWeave 的 resolveQoderExecutable：
    1) envOrder 里第一个非空的显式值；2) PATH 里的 pathNames；3) userCandidates。
    返回 (可执行文件, 来源说明, 告警[])；每个候选都过 realpath + 常规文件 + 可执行校验，
    不做家目录扫描。

    失败语义分两档（本机踩过的坑）：hwdesk 自己的变量（envFailClosed，默认
    HWDESK_QODER_CLI）指向非法值时判未就绪 —— 用户明确指定过路径，不能转头去跑别的
    可执行文件；而 ORG_WORKBENCH_QODER_BIN / DIGITAL_EMPLOYEE_QODER_COMMAND 是
    RoleWeave 适配器的内部变量，桥常被 RoleWeave/Qoder 会话拉起来，这些值会跟着环境
    泄漏进来（实测泄漏过 /home/feng/.local/bin/qoderclicn 这种 POSIX 路径）——
    外来值非法时只是不采纳它并留一条告警，不能把学生的工作台判成「没装 CLI」。"""
    cfg = cfg or agent_config()
    cli = cfg["cli"]
    fail_closed = set(cli.get("envFailClosed") or ["HWDESK_QODER_CLI"])
    warnings = []
    for var in cli.get("envOrder") or []:
        value = (os.environ.get(var) or "").strip()
        if not value:
            continue
        if "\0" in value:
            if var in fail_closed:
                return "", "env:%s" % var, ["%s 含非法字符，已判未就绪" % var]
            warnings.append("%s 含非法字符，已忽略该外来指定" % var)
            break
        if os.path.isabs(value) or "/" in value or "\\" in value:
            hit = executable_target(value)
        else:
            hit = find_on_path(value)
        if hit:
            return hit, "env:%s" % var, warnings
        if var in fail_closed:
            return "", "env:%s" % var, ["%s 指向的不是可用的可执行文件：%s" % (var, value)]
        warnings.append("%s=%s 不是可用的可执行文件，已忽略（它属于 RoleWeave 适配器的环境变量，"
                        "不是 hwdesk 的指定）" % (var, value))
        break
    for name in cli.get("pathNames") or []:
        hit = find_on_path(name)
        if hit:
            return hit, "path:%s" % name, warnings
    for candidate in cli.get("userCandidates") or []:
        hit = executable_target(candidate)
        if hit:
            return hit, "candidate:%s" % candidate, warnings
    return "", "not-found", warnings


def qoder_entry(cfg=None):
    return qoder_entry_detail(cfg)[0]


def qoder_turn_dir(cfg=None):
    """回合工作目录：workspace=app 落到 hwdesk 目录（只读检索的范围就是这里），
    home 落用户家目录；目录不存在一律回落到家目录。"""
    cfg = cfg or agent_config()
    if str(cfg["permissions"].get("workspace") or "app").lower() == "home":
        return os.path.expanduser("~")
    return HERE if os.path.isdir(HERE) else os.path.expanduser("~")


_QODER_LOCK = threading.Lock()
# 当前在跑的 CLI 进程 + 用户中断标记（/agent/qoder/stop 用）
_QODER_CUR = {"proc": None, "killed": False}


def qoder_stop():
    """中断当前 Qoder 生成：杀整个进程树（.cmd 入口会带 cmd.exe 子进程），
    返回是否真杀到了进程。流式循环随 stdout 关闭收尾并释放单飞锁。"""
    proc = _QODER_CUR.get("proc")
    if proc is None or proc.poll() is not None:
        return False
    _QODER_CUR["killed"] = True
    try:
        if os.name == "nt":
            subprocess.call(["taskkill", "/T", "/F", "/PID", str(proc.pid)],
                            creationflags=_NO_WINDOW)
        else:
            proc.kill()
    except OSError:
        try:
            proc.kill()
        except OSError:
            pass
    return True


def qoder_compose_prompt(messages, cfg=None):
    """OpenAI 风格 messages → 单段提示词（CLI -p 一次一轮，无服务端会话态）。
    system 段置顶，user/assistant 轮次带角色前缀，保证多轮上下文不丢。
    顶部压一条与当前 --tools 一致的模式横幅（见 qoder_mode_banner），工具档位
    改了横幅跟着改，不会出现「配了只读工具却告诉学生工具全禁」的漂移。"""
    parts = [qoder_mode_banner(cfg)]
    for m in messages or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or ""
        content = str(m.get("content") or "").strip()
        if not content:
            continue
        if role == "system":
            parts.append(content)
        elif role == "user":
            parts.append("【用户】\n" + content)
        elif role == "assistant":
            parts.append("【你上一轮的回复】\n" + content)
    return "\n\n".join(parts).strip()


# 桥可能被桌面应用/无头 agent 的会话拉起，子进程会继承会话的 SDK 鉴权变量，
# 指向一个已清理的临时凭据文件 → CLI 退出码 41 秒死。调 CLI 前必须剥掉。
_QODER_ENV_DROP = ("QODER_SDK_AUTH_PAYLOAD_FILE", "QODER_AGENT_SDK_ENTRYPOINT",
                   "QODER_AGENT_SDK_DAEMON", "QODER_AGENT_SDK_VERSION")
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0  # 控制台 CLI 不再弹黑窗


# ---- 账号模型目录：--list-models 有界探测 + TTL 缓存（RoleWeave 3s probe 同款） ----
_QODER_CATALOG = {"at": 0.0, "models": [], "status": "unknown", "error": ""}
_QODER_CATALOG_LOCK = threading.Lock()


def parse_model_catalog(text):
    """--list-models 的纯文本表（本机实测首行是 MODEL 表头）→ 模型 id 列表。
    解析不出合法 id 就报「空目录」，绝不硬编一个公开模型名上去冒充可用性。"""
    out = []
    for line in (text or "").splitlines():
        line = line.strip().strip("|").strip()
        if not line or set(line) <= set("-= "):
            continue
        if line.upper() in ("MODEL", "MODELS", "NAME", "ID", "MODEL ID"):
            continue
        # 出错时 CLI 也会往 stdout 写句子（实测「SDK auth payload file not found: …」），
        # 带路径或「词后跟冒号」的一定是散文不是模型 id（qwen3:8b 这种紧贴冒号的 id 保留）。
        if "/" in line or "\\" in line or ": " in line or line.endswith(":"):
            continue
        candidate = line.split()[0].strip(",")
        if _is_model_id(candidate) and candidate not in out:
            out.append(candidate)
    return out[:64]


def _run_catalog_probe(entry, cfg):
    args = [a for a in (cfg["model"].get("catalogArgs") or ["--list-models"])
            if isinstance(a, str) and a.startswith("-")]
    cmd = (["cmd.exe", "/d", "/c", entry] + args) if entry.lower().endswith((".cmd", ".bat")) \
        else ([entry] + args)
    timeout = _clamp(cfg["cli"].get("probeTimeoutMs"), 1000, 10000, 6000) / 1000.0
    try:
        done = subprocess.run(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=timeout, cwd=qoder_turn_dir(cfg),
                              env=_qoder_clean_env(cfg), creationflags=_NO_WINDOW)
    except subprocess.TimeoutExpired:
        return None, "模型目录探测超时（%.1f 秒）" % timeout
    except OSError as exc:
        return None, "模型目录探测无法启动：%s" % exc
    if done.returncode != 0:
        err = (done.stderr or b"").decode("utf-8", "replace").strip()
        return None, "退出码 %d：%s" % (done.returncode, err[:200] or "无错误输出")
    return (done.stdout or b"").decode("utf-8", "replace"), ""


def qoder_catalog(cfg=None, refresh=False):
    """返回 {models, status, error}，status ∈ ok|empty|no-cli|unavailable|unknown。
    status 非 ok 时任何档位/自定义模型都不下传：本机实测把账号没有的档位塞给 -m，
    CLI 静默降级成账号默认（stderr 提示、退出码仍 0），页面显示的模型就成了假的。
    失败只短缓存 30 秒 —— 一次探测超时不该把档位锁死十分钟。"""
    cfg = cfg or agent_config()
    ttl = _clamp(cfg["cli"].get("catalogCacheSeconds"), 30, 86400, 600)
    now = time.time()
    with _QODER_CATALOG_LOCK:
        cached_ttl = _QODER_CATALOG.get("ttl", ttl)
        if not refresh and _QODER_CATALOG["status"] != "unknown" \
                and now - _QODER_CATALOG["at"] < cached_ttl:
            snap = dict(_QODER_CATALOG)
            snap["ageSeconds"] = int(now - _QODER_CATALOG["at"])
            snap.pop("ttl", None)
            return snap
    entry = qoder_entry(cfg)
    if not entry:
        snap = {"at": now, "models": [], "status": "no-cli", "error": "未找到 Qoder CLI"}
    else:
        text, err = _run_catalog_probe(entry, cfg)
        if err:
            snap = {"at": now, "models": [], "status": "unavailable", "error": err}
        else:
            models = parse_model_catalog(text)
            snap = {"at": now, "models": models,
                    "status": "ok" if models else "empty", "error": ""}
    with _QODER_CATALOG_LOCK:
        _QODER_CATALOG.update(snap)
        _QODER_CATALOG["ttl"] = ttl if snap["status"] == "ok" else min(ttl, 30)
        out = dict(_QODER_CATALOG)
    out["ageSeconds"] = 0
    out.pop("ttl", None)
    return out


def _gate_model(target, label, catalog, cfg):
    cat = catalog if isinstance(catalog, dict) else qoder_catalog(cfg)
    if label == (cfg["model"].get("default") or "provider-default"):
        return None, ""
    if cat.get("status") != "ok":
        return None, "账号模型目录没取到（%s%s），已跟随账号默认" % (
            cat.get("status"), "：" + cat.get("error") if cat.get("error") else "")
    models = cat.get("models") or []
    if str(target).lower() not in [m.lower() for m in models]:
        return None, ("%s 不在本机账号的模型目录里（目录：%s），已跟随账号默认"
                      % (label, "、".join(models[:6])))
    return target, ""


def resolve_qoder_model(requested, cfg=None, catalog=None):
    """页面选的档位/自定义模型 → 真正下传给 -m 的模型名（None＝跟随账号默认）。
    返回 (model|None, note)；档位只有在账号目录里真实存在才下传。"""
    cfg = cfg or agent_config()
    model_cfg = cfg["model"]
    want = str(requested or "").strip()
    if not want or want == (model_cfg.get("default") or "provider-default"):
        return None, ""
    for tier in model_cfg.get("tiers") or []:
        if isinstance(tier, dict) and tier.get("id") == want:
            target = tier.get("model")
            if not target:
                return None, ""
            return _gate_model(target, want, catalog, cfg)
    if model_cfg.get("allowCustom"):
        if not _is_model_id(want):
            return None, "模型名不合法（只允许字母数字与 . _ - : /，长度 ≤100），已跟随账号默认"
        return _gate_model(want, want, catalog, cfg)
    return None, "当前配置未开放自选模型（model.allowCustom=false），已跟随账号默认"


def qoder_turn_args(cfg=None, model=None):
    """按配置拼一次回合的 CLI 参数。deny 打底 + 只读白名单在这里落地：--tools 只列
    allow（本机实测 init 事件回报的 tools 就等于这份白名单），MCP 恒为
    --strict-mcp-config + 空 servers，权限模式来自已收敛的配置，绝不出现
    --dangerously-skip-permissions。"""
    cfg = cfg or agent_config()
    perm = cfg["permissions"]
    mcp = cfg["mcp"]
    iso = cfg["isolation"]
    task = cfg["budget"]["perTask"]
    tr = cfg["transport"]
    allow = list(perm.get("allow") or [])
    args = ["-p", "-o", tr.get("outputFormat") or "stream-json"]
    servers = {}
    for entry in mcp.get("servers") or []:
        spec = entry.get("spec")
        if isinstance(spec, dict) and spec:
            servers[entry["name"]] = spec
    args += ["--strict-mcp-config", "--mcp-config",
             json.dumps({"mcpServers": servers}, separators=(",", ":"), ensure_ascii=False)]
    if perm.get("defaultEffect") == "deny" and not allow:
        args += ["--tools", ""]
    elif perm.get("defaultEffect") == "deny":
        args += ["--tools"] + allow        # 变长参数遇到下一个 --xx 自然结束（本机实测）
    else:
        args += ["--tools", "default"]
    if perm.get("deny"):
        args += ["--disallowed-tools", ",".join(perm["deny"])]
    args += ["--permission-mode", perm.get("permissionMode") or "default"]
    if isinstance(iso.get("settingSources"), str):
        args += ["--setting-sources", iso["settingSources"]]
    if iso.get("noSessionPersistence"):
        args.append("--no-session-persistence")
    if int(task.get("maxOutputTokens") or 0) > 0:
        args += ["--max-output-tokens", str(task["maxOutputTokens"])]
    if model:
        args += ["-m", model]
    return args


def _qoder_clean_env(cfg=None):
    """只带白名单变量进 CLI（RoleWeave engine/driver-cli.js 的回合环境白名单同款
    思路）；envDropAlways 再无条件剥一遍，双保险。"""
    cfg = cfg or agent_config()
    iso = cfg["isolation"]
    source = os.environ
    if not iso.get("cleanEnv", True):
        env = dict(source)
    else:
        allow = list(iso.get("envAllow") or [])
        env = {}
        for key in allow:
            value = source.get(key)
            if value is not None:
                env[key] = value
        if os.name == "nt":
            # Windows 环境变量大小写不敏感，注册表里通常是 Path / SystemRoot / Temp，
            # 按精确大写取会漏，漏了 CLI 直接起不来 —— 补齐同名变体。
            wanted = {k.upper() for k in allow}
            for key, value in source.items():
                if key.upper() in wanted and key not in env:
                    env[key] = value
    for key in list(iso.get("envDropAlways") or []) + list(_QODER_ENV_DROP):
        env.pop(key, None)
    return env


def qoder_mode_banner(cfg=None):
    """横幅必须与真正下发的 --tools 一致：工具全关时讲「纯对话」，开了只读白名单时
    讲清「能读什么、不能干什么」。伪调用标记在这里用拼接写 —— 直接写全名会被工具链
    当成标签吞掉，源码和提示词都得留得住这句话。"""
    cfg = cfg or agent_config()
    fake_call = "<" + "tool_call" + ">"
    allow = cfg["permissions"].get("allow") or []
    if not allow:
        return ("【运行模式】本通道是 hwdesk 工作台的纯对话通道：文件、命令、联网检索等工具"
                "全部不可用，也无需可用。绝不要输出 %s 之类的调用文本（那会被当成正文发给学生）。"
                "课程材料以本提示中的上下文为准；上下文里没有的关键信息（具体题目原文、课件内容等），"
                "用一句话向学生索要，学生粘贴后即可继续。请直接用自然语言作答。" % fake_call)
    return ("【运行模式】本通道是 hwdesk 工作台的作业辅导对话：工具默认全部拒绝，只开放只读检索 %s"
            "（只能读工作目录 %s 里的文件，不能写文件、不能执行命令、不能联网）。要看本机资料就用这几个"
            "只读工具，别凭记忆编。绝不要输出 %s 之类的调用文本（那会被当成正文发给学生）。"
            "上下文里没有的关键信息（具体题目原文、课件内容等），先查工作目录，查不到就用一句话向学生"
            "索要。请直接用自然语言作答。"
            % ("、".join(allow), qoder_turn_dir(cfg), fake_call))


# ---- 预算：RoleWeave budget.json 的 perTask/perDay 语义落到本机桥上 ----
_QODER_BUDGET = {"day": "", "turns": 0, "tokens": 0, "credits": 0.0}
_QODER_BUDGET_LOCK = threading.Lock()


def budget_snapshot(cfg=None):
    cfg = cfg or agent_config()
    today = datetime.date.today().isoformat()
    with _QODER_BUDGET_LOCK:
        if _QODER_BUDGET["day"] != today:
            _QODER_BUDGET.update(day=today, turns=0, tokens=0, credits=0.0)
        snap = dict(_QODER_BUDGET)
    per_day = cfg["budget"]["perDay"]
    snap["credits"] = round(snap.get("credits") or 0.0, 4)
    snap["limitTurns"] = per_day["turns"]
    snap["limitTokens"] = per_day["tokens"]
    return snap


def budget_refusal(cfg=None):
    """超预算时给人话说明。本机账号的 CLI usage token 全回 0，所以 token 上限只在
    它真实回报过 token 时才参与熔断，主指标用回合数 —— 不假装统计了 token。"""
    cfg = cfg or agent_config()
    snap = budget_snapshot(cfg)
    if snap["turns"] >= snap["limitTurns"]:
        return ("今天已用 %d 个回合，达到 agent.config.json 里 budget.perDay.turns=%d 的上限，"
                "次日自动恢复；要放宽就改那个数" % (snap["turns"], snap["limitTurns"]))
    if snap["limitTokens"] and snap["tokens"] >= snap["limitTokens"]:
        return ("今天已用 %d token，达到 budget.perDay.tokens=%d 的上限，次日自动恢复"
                % (snap["tokens"], snap["limitTokens"]))
    return ""


def budget_record(result_event):
    ev = result_event if isinstance(result_event, dict) else {}
    usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
    try:
        tokens = int(usage.get("input_tokens") or 0) + int(usage.get("output_tokens") or 0)
    except (TypeError, ValueError):
        tokens = 0
    try:
        credits = float(ev.get("total_credits") or 0.0)
    except (TypeError, ValueError):
        credits = 0.0
    with _QODER_BUDGET_LOCK:
        _QODER_BUDGET["turns"] = int(_QODER_BUDGET.get("turns") or 0) + 1
        _QODER_BUDGET["tokens"] = int(_QODER_BUDGET.get("tokens") or 0) + tokens
        _QODER_BUDGET["credits"] = float(_QODER_BUDGET.get("credits") or 0.0) + credits
    return tokens


def _public_config(value):
    """递归剔掉 _doc / _comment 这类给人读的键，状态接口只端真会生效的字段。"""
    if isinstance(value, dict):
        return {k: _public_config(v) for k, v in value.items()
                if not str(k).startswith("_")}
    if isinstance(value, list):
        return [_public_config(v) for v in value]
    return value


def qoder_status(cfg=None, refresh_catalog=False):
    """页面唯一的 Agent 面板数据源：引擎绑定 / 档位 / 权限 / MCP / 预算 / 隔离
    全在这里，并带上配置文件真实状态（file|defaults）与收敛告警。"""
    cfg, error, warnings = load_agent_config() if cfg is None else (cfg, "", [])
    entry, entry_source, entry_warnings = qoder_entry_detail(cfg)
    cat = qoder_catalog(cfg, refresh=refresh_catalog) if entry \
        else {"models": [], "status": "no-cli", "error": "未找到 Qoder CLI"}
    models = cat.get("models") or []
    default_id = cfg["model"].get("default") or "provider-default"
    tiers = []
    for tier in cfg["model"].get("tiers") or []:
        if not isinstance(tier, dict) or not tier.get("id"):
            continue
        target = tier.get("model")
        available = not target or (cat.get("status") == "ok" and
                                   str(target).lower() in [m.lower() for m in models])
        tiers.append({"id": tier["id"], "name": tier.get("name") or tier["id"],
                      "tier": tier.get("tier") or "default", "model": target,
                      "available": bool(available),
                      "note": "" if available else "本机账号的模型目录里没有这个档位"})
    return {
        "ok": bool(entry),
        "entry": entry,
        "entrySource": entry_source,
        "entryWarnings": list(entry_warnings),
        "error": "" if entry else (
            "本机未找到可用的 Qoder CLI。安装 qoderclicn，或用 %s 显式指向可执行文件；"
            "已尝试：%s（定位告警：%s）"
            % (" / ".join(cfg["cli"].get("envOrder") or ["HWDESK_QODER_CLI"]),
               " → ".join(list(cfg["cli"].get("pathNames") or [])
                          + list(cfg["cli"].get("userCandidates") or [])),
               "; ".join(entry_warnings) or "无")),
        "cli": "qoder-cn",
        "model": models[0] if models else "跟随账号默认",
        "modelPolicy": cfg["model"].get("policy"),
        "modelDefault": default_id,
        "allowCustomModel": bool(cfg["model"].get("allowCustom")),
        "tiers": tiers,
        "catalog": models,
        "catalogStatus": cat.get("status"),
        "catalogAgeSeconds": cat.get("ageSeconds"),
        "catalogError": cat.get("error") or "",
        "engine": _public_config(cfg["engine"]),
        "permissions": {
            "defaultEffect": cfg["permissions"]["defaultEffect"],
            "allow": list(cfg["permissions"]["allow"]),
            "deny": list(cfg["permissions"]["deny"]),
            "permissionMode": cfg["permissions"]["permissionMode"],
            "workspace": cfg["permissions"].get("workspace"),
            "turnDir": qoder_turn_dir(cfg),
        },
        "mcp": {"defaultEffect": cfg["mcp"]["defaultEffect"],
                "servers": [s.get("name") for s in cfg["mcp"].get("servers") or []]},
        "budget": cfg["budget"],
        "spentToday": budget_snapshot(cfg),
        "isolation": {"cleanEnv": bool(cfg["isolation"].get("cleanEnv")),
                      "envAllowCount": len(cfg["isolation"].get("envAllow") or []),
                      "settingSources": cfg["isolation"].get("settingSources"),
                      "noSessionPersistence": bool(cfg["isolation"].get("noSessionPersistence"))},
        "timeoutSeconds": cfg["budget"]["perTask"]["timeoutSeconds"],
        "maxPromptChars": cfg["budget"]["perTask"]["maxPromptChars"],
        "turnArgs": qoder_turn_args(cfg, None),
        "configFile": AGENT_CONFIG_FILE,
        "configSource": "defaults" if error or not os.path.isfile(AGENT_CONFIG_FILE) else "file",
        "configError": error or "",
        "configWarnings": list(warnings or []),
        "version": VERSION,
    }


def _qoder_spawn(prompt, ctx):
    """起 CLI（非交互 stream-json）。参数、工作目录、环境全部来自 agent.config.json
    收敛后的结果。stderr 落临时文件防管道塞死，调用方负责 wait+清理。"""
    cfg = ctx["cfg"]
    entry = ctx["entry"]
    cmd = ([entry] + ctx["args"]) if not entry.lower().endswith((".cmd", ".bat")) \
        else (["cmd.exe", "/d", "/c", entry] + ctx["args"])
    errf = tempfile.NamedTemporaryFile(prefix="wb_qoder_err_", suffix=".log", delete=False)
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=errf, creationflags=_NO_WINDOW,
                            env=_qoder_clean_env(cfg), cwd=qoder_turn_dir(cfg))
    proc._wb_errfile = errf
    try:
        proc.stdin.write(prompt.encode("utf-8"))
        proc.stdin.close()
    except OSError:
        pass  # CLI 启动即死时由后面的退出码路径报真实错误
    return proc


def _qoder_strip_toolcall(text):
    """兜底：模型无视横幅仍漏出工具调用文本时，截到第一个调用标记为止，
    不把 <tool_call> 之类的伪调用原文发给学生。"""
    if text:
        i = text.find("<tool_call>")
        if i >= 0:
            text = text[:i].rstrip()
    return text


def _qoder_events(proc):
    """stdout NDJSON → 事件 dict 流（非 JSON 行忽略）。"""
    for raw in proc.stdout:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("{"):
            continue
        try:
            yield json.loads(line)
        except ValueError:
            pass


def _qoder_prepare(messages, model=None, cfg=None):
    """公共前置：CLI 定位 → 模型档位解析 → 提示词组装 → 预算/长度检查 → 单飞锁。
    返回 (ctx, err)；ctx 里带上下发的参数与解析说明，页面能显示真实生效的档位。"""
    cfg = cfg or agent_config()
    entry = qoder_entry(cfg)
    if not entry:
        return None, ("本机未找到可用的 Qoder CLI。可安装 qoderclicn，或用环境变量 %s "
                      "之一显式指定 CLI 路径（显式指定后路径非法不会回落，请核对）。"
                      % " / ".join(cfg["cli"].get("envOrder") or ["HWDESK_QODER_CLI"]))
    refusal = budget_refusal(cfg)
    if refusal:
        return None, refusal
    catalog = qoder_catalog(cfg)
    resolved, note = resolve_qoder_model(model, cfg, catalog)
    prompt = qoder_compose_prompt(messages, cfg)
    if not prompt:
        return None, "提示词为空"
    limit = cfg["budget"]["perTask"]["maxPromptChars"]
    if len(prompt) > limit:
        return None, ("提示词过长（%d 字符 > 上限 %d，来自 agent.config.json 的 "
                      "budget.perTask.maxPromptChars），请精简资料后重试" % (len(prompt), limit))
    if cfg["transport"].get("singleFlight", True) and not _QODER_LOCK.acquire(blocking=False):
        return None, "Qoder CLI 正在处理上一条请求，请稍候再发"
    ctx = {"cfg": cfg, "entry": entry, "prompt": prompt,
           "args": qoder_turn_args(cfg, resolved),
           "modelRequested": str(model or "").strip() or cfg["model"].get("default"),
           "modelSent": resolved, "modelNote": note,
           "locked": bool(cfg["transport"].get("singleFlight", True))}
    return ctx, None


def _qoder_run(ctx, emit):
    """跑一轮 CLI 并把映射后的事件（thinking/answer/done/error）逐条 emit。
    假定锁已由 _qoder_prepare 拿到；本函数负责收尾与放锁。
    done 事件带上 CLI 在 init 里回报的真实模型 + 档位解析说明，页面显示不靠猜。"""
    cfg = ctx.get("cfg") or agent_config()
    prompt = ctx.get("prompt") or ""
    proc = None
    timer = None
    timed_out = [False]
    observed_model = [None]
    try:
        proc = _qoder_spawn(prompt, ctx)
        _QODER_CUR["proc"] = proc
        _QODER_CUR["killed"] = False
        def _kill():
            timed_out[0] = True
            try:
                proc.kill()
            except OSError:
                pass
        timer = threading.Timer(cfg["budget"]["perTask"]["timeoutSeconds"], _kill)
        timer.start()
        got_result = False
        for ev in _qoder_events(proc):
            t = ev.get("type")
            if t == "system" and ev.get("subtype") == "init":
                observed_model[0] = ev.get("model") or observed_model[0]
                ctx["toolsReported"] = ev.get("tools")
                ctx["mcpReported"] = ev.get("mcp_servers")
            if t == "assistant":
                for b in (ev.get("message") or {}).get("content") or []:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "thinking" and b.get("thinking"):
                        emit({"type": "thinking", "text": b["thinking"]})
                    elif b.get("type") == "text" and b.get("text"):
                        emit({"type": "answer", "text": _qoder_strip_toolcall(b["text"])})
            elif t == "result":
                got_result = True
                used = budget_record(ev)
                emit({"type": "done", "text": _qoder_strip_toolcall(ev.get("result") or ""),
                      "is_error": bool(ev.get("is_error")),
                      "model": observed_model[0] or ctx.get("modelSent") or "",
                      "modelRequested": ctx.get("modelRequested"),
                      "modelNote": ctx.get("modelNote") or "",
                      "tools": ctx.get("toolsReported"),
                      "tokens": used,
                      "turns": ev.get("num_turns"),
                      "durationMs": ev.get("duration_ms")})
        proc.wait()
        timer.cancel()
        if not got_result:
            errf = proc._wb_errfile
            try:
                errf.close()
                with open(errf.name, "rb") as f:
                    err = f.read().decode("utf-8", "replace").strip()
            except OSError:
                err = ""
            finally:
                try:
                    os.unlink(errf.name)
                except OSError:
                    pass
            if _QODER_CUR.get("killed"):
                emit({"type": "error", "message": "已中断", "code": "aborted"})
            elif timed_out[0]:
                emit({"type": "error", "message": "Qoder CLI 超时（%d 秒，来自 budget.perTask.timeoutSeconds）"
                                          "未完成，请重试或精简任务" % cfg["budget"]["perTask"]["timeoutSeconds"]})
            elif proc.returncode != 0:
                emit({"type": "error", "message": "Qoder CLI 退出码 %d：%s" % (proc.returncode, err[:300] or "无错误输出")})
            else:
                emit({"type": "error", "message": "Qoder CLI 未产出结果，请重试"})
    except (BrokenPipeError, ConnectionResetError):
        pass  # 页面中途断开：杀进程走 finally
    except Exception as e:      # 任何意外都不许把桥打挂
        try:
            emit({"type": "error", "message": "Qoder CLI 调用失败：" + str(e)})
        except Exception:
            pass
    finally:
        if timer:
            timer.cancel()
        if _QODER_CUR.get("proc") is proc:
            _QODER_CUR["proc"] = None
        if proc is not None:
            if proc.poll() is None:
                try:
                    proc.kill()
                except OSError:
                    pass
            try:
                proc._wb_errfile.close()
                os.unlink(proc._wb_errfile.name)
            except OSError:
                pass
        if ctx.get("locked"):
            try:
                _QODER_LOCK.release()
            except Exception:
                pass


def qoder_ask(messages, model=None):
    """调 Qoder CLI 完成一轮问答（一轮一出，兼容旧页面）。提示词走 stdin。
    返回 (ok, output, meta)；同一时刻只放行一个 CLI 进程（本机单用户语义）。"""
    ctx, err = _qoder_prepare(messages, model)
    if err:
        return False, err, {}
    box = {}
    def emit(ev):
        if ev.get("type") == "answer":
            box.setdefault("answers", []).append(ev["text"])
        elif ev.get("type") == "done":
            box["done"] = ev
        elif ev.get("type") == "error":
            box["error"] = ev["message"]
    _qoder_run(ctx, emit)
    done = box.get("done") or {}
    meta = {"model": done.get("model") or ctx.get("modelSent") or "",
            "modelRequested": ctx.get("modelRequested"),
            "modelNote": ctx.get("modelNote") or "",
            "tools": ctx.get("toolsReported")}
    if done and not done.get("is_error"):
        return True, done.get("text") or "\n".join(box.get("answers", [])), meta
    if done:
        return False, done.get("text") or "Qoder CLI 返回了错误", meta
    return False, box.get("error") or "Qoder CLI 未产出结果", meta


PAGE_FILE = "作业提交工作台.html"
STATIC_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "hwdesk-syncserver/" + VERSION

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # Chrome Private Network Access（PNA）：云端 https 工作台页 fetch 本机桥
        # 属「公网→本机」请求，Chrome 会发预检并要求响应带这个头，
        # 缺了直接 Failed to fetch（实测 2026-10-31，同步全断的根因之一）。
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):  # 静默访问日志，避免凭据出现在终端
        pass

    def _serve_static(self, path):
        """同源托管工作台页面（PNA/LNA 免疫）：云端 https 页 fetch http://127.0.0.1
        会被 Chrome 的本地网络访问机制拦死（响应头也救不回，需用户授权），
        唯一稳的做法是让页面本身就由本机桥提供 —— 打开 http://127.0.0.1:8765/
        即与 API 同源，零跨域。只允许脚本目录下白名单扩展名的单个文件名，
        绝不提供 wb_*.json（凭据/缓存）、_backup* / _tmp 目录内容。"""
        name = path.split("?", 1)[0].split("#", 1)[0].strip("/")
        if name in ("", "app", "app/", "index.html"):
            name = PAGE_FILE
        name = name.replace("\\", "/").split("/")[-1]  # 只取文件名，防目录穿越
        ext = os.path.splitext(name)[1].lower()
        if (not name or name.startswith("wb_") or ext not in STATIC_MIME
                or name.startswith("_")):
            self._json(404, {"ok": False, "error": "not found"})
            return
        fp = os.path.join(HERE, name)
        if not os.path.isfile(fp):
            self._json(404, {"ok": False, "error": "not found"})
            return
        try:
            with open(fp, "rb") as f:
                body = f.read()
        except OSError:
            self._json(404, {"ok": False, "error": "not found"})
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", STATIC_MIME[ext])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")  # 页面常更新，禁缓存避免旧版残留
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "version": VERSION, "service": "hwdesk-syncserver",
                             "platform": "学在城院 courses.hzcu.edu.cn (Tronclass)"})
        elif self.path.startswith("/agent/qoder/status"):
            # 唯一 Agent（Qoder CLI）就绪状态：只回本机页面。file:// 页（本地模式
            # 回退）的 fetch 会带 Origin: null —— 同样放行；云端 https 页（公网
            # 站点）的 Origin 含真实域名，一律 403，本机 CLI 不对云端开放。
            origin = (self.headers.get("Origin") or "").strip()
            bad_origin = (origin and origin.lower() != "null"
                          and ("127.0.0.1" not in origin) and ("localhost" not in origin))
            if bad_origin:
                self._json(403, {"ok": False,
                                 "error": "local-only: 本机 Agent 只对本机页面开放"})
                return
            self._json(200, qoder_status(
                refresh_catalog="refresh" in (self.path or "")))
        elif self.path.startswith("/v1/models"):
            ok, token, reason = proxy_check_auth(self.headers.get("Authorization"),
                                                 self.headers.get("Origin"))
            if not ok:
                self._json(401 if "token" in reason else 403,
                           {"error": {"message": reason, "type": "proxy_auth"}})
            else:
                self._json(200, {"object": "list",
                                 "data": [{"id": m, "object": "model"} for m in proxy_available_models()]})
        elif self.path.startswith("/data"):
            # #92：无凭据 GET 只返回 wb_local.json 属主账号的缓存，绝不端出别人账号的数据
            cfg_account, _ = load_cfg_creds()
            payload = _STATE["by_account"].get(cfg_account or "")
            cached = payload is not None
            if payload is None:
                try:
                    payload, cached = collect_payload()
                except SyncError as e:
                    self._json(200, {"ok": False, "error": str(e),
                                     "hint": "在本目录运行 python syncserver.py 后重试；凭据见 README「本机直连」"})
                    return
            self._json(200, {"ok": True, "cached": cached, "payload": payload})
        else:
            self._serve_static(self.path)

    def _proxy_chat(self, raw):
        """OpenAI 兼容反代（issue #55）：鉴权 → 配额 → 路由 → 直连上游；stream 逐块透传"""
        ok, token, reason = proxy_check_auth(self.headers.get("Authorization"),
                                             self.headers.get("Origin"))
        if not ok:
            self._json(401 if "token" in reason else 403,
                       {"error": {"message": reason, "type": "proxy_auth"}})
            return
        allowed, used = proxy_quota_bump(token)
        if not allowed:
            self._json(429, {"error": {"message": "今日代理额度已用完（%d/%d）" % (used, proxy_daily_limit()),
                                       "type": "proxy_quota"}})
            return
        try:
            body = json.loads(raw.decode("utf-8", "replace")) if raw else {}
            model = str(body.get("model") or "")
            if not model:
                raise ValueError("model is required")
        except (ValueError, UnicodeDecodeError) as e:
            self._json(400, {"error": {"message": "bad request: %s" % e, "type": "proxy_request"}})
            return
        provider, url, env = proxy_route(model)
        key = proxy_upstream_key(env)
        if not key:
            self._json(502, {"error": {"message": "provider '%s' not configured on host (set %s)"
                                                % (provider, env), "type": "proxy_config"}})
            return
        req = urllib.request.Request(
            url, data=json.dumps(body, ensure_ascii=False).encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": "Bearer " + key,
                     "Accept": "text/event-stream" if body.get("stream") else "application/json"})
        try:
            upstream = _proxy_opener().open(req, timeout=120)
        except urllib.error.HTTPError as e:
            detail = e.read()[:4000]  # 透传上游错误码；key 不出现在任何输出里
            self.send_response(e.code)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(detail)))
            self.end_headers()
            self.wfile.write(detail)
            return
        except Exception as e:
            self._json(502, {"error": {"message": "upstream %s unreachable: %s" % (provider, e),
                                       "type": "proxy_upstream"}})
            return
        code = getattr(upstream, "status", None) or upstream.getcode() or 200
        ctype = upstream.headers.get("Content-Type", "application/json")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        if body.get("stream"):
            # SSE：不设 Content-Length，逐块透传（HTTP/1.0 由连接关闭收尾）
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read(1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except Exception:
                pass  # 客户端中途断开属正常
        else:
            payload = upstream.read()
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def _agent_qoder_stream(self, msgs, model=None):
        """流式问答：NDJSON 逐行推 {type: thinking|answer|done|error} 事件，
        页面实时把思考过程渲染进对话框。HTTP/1.0 语义，由连接关闭收尾。"""
        ctx, err = _qoder_prepare(msgs, model)
        if err:
            self._json(400, {"ok": False, "error": err})
            return
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def emit(ev):
            self.wfile.write((json.dumps(ev, ensure_ascii=False) + "\n").encode("utf-8"))
            self.wfile.flush()

        _qoder_run(ctx, emit)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        creds = None
        try:
            if raw:
                body = json.loads(raw.decode("utf-8", "replace"))
                if isinstance(body, dict):
                    creds = body
        except ValueError:
            pass
        if self.path.startswith("/v1/chat/completions"):
            self._proxy_chat(raw)
            return
        if self.path.startswith("/agent/qoder"):
            # 唯一 Agent（Qoder CLI）问答：body = {messages:[{role,content}...]}；
            # 只回本机页面（Origin 校验与 status 一致），提示词不出本机。
            origin = (self.headers.get("Origin") or "").strip()
            bad_origin = (origin and origin.lower() != "null"
                          and ("127.0.0.1" not in origin) and ("localhost" not in origin))
            if bad_origin:
                self._json(403, {"ok": False,
                                 "error": "local-only: 本机 Agent 只对本机页面开放"})
                return
            if self.path.startswith("/agent/qoder/stop"):
                # 中断当前生成：杀 CLI 进程树；流式循环随之收尾并释放单飞锁
                self._json(200, {"ok": True, "killed": qoder_stop()})
                return
            msgs = creds.get("messages") if isinstance(creds, dict) else None
            if not isinstance(msgs, list):
                msgs = [{"role": "user", "content": (creds or {}).get("prompt", "")}] \
                    if isinstance(creds, dict) and creds.get("prompt") else None
            if not msgs:
                self._json(400, {"ok": False, "error": "请求缺少 messages（或 prompt）字段"})
                return
            agent_model = creds.get("model") if isinstance(creds, dict) else None
            if self.path.startswith("/agent/qoder/stream"):
                self._agent_qoder_stream(msgs, agent_model)
                return
            ok, output, meta = qoder_ask(msgs, agent_model)
            self._json(200, {"ok": ok, "output": output,
                             "model": meta.get("model") or "",
                             "modelRequested": meta.get("modelRequested"),
                             "modelNote": meta.get("modelNote") or "",
                             "tools": meta.get("tools")}
                       if ok else {"ok": False, "error": output,
                                   "modelNote": meta.get("modelNote") or ""})
            return
        if self.path.startswith("/data"):
            try:
                payload, _ = collect_payload(creds)
                self._json(200, {"ok": True, "cached": False, "payload": payload})
            except SyncError as e:
                self._json(200, {"ok": False, "error": str(e)})
            except Exception as e:  # 未知异常也要给页面可读信息
                self._json(200, {"ok": False, "error": "服务内部错误：%s" % e})
        elif self.path.startswith("/verify"):
            # 登录门禁：工作台「登录」按钮把账号密码 POST 过来，真实登录一次验证真伪；
            # 验证通过才放行进入工作台。remember=true 时把凭据存进 wb_local.json（不入仓库）
            if not (creds and creds.get("account") and creds.get("password")):
                self._json(200, {"ok": False, "error": "请求缺少 account / password 字段"})
                return
            try:
                hzcu_login(str(creds["account"]), str(creds["password"]))
                if creds.get("remember"):
                    saved = save_creds(str(creds["account"]), str(creds["password"]))
                    if saved:
                        add_log_local("凭据已自动配置到 wb_local.json（不进仓库）")
                self._json(200, {"ok": True, "source": "hzcu-xzc"})
            except SyncError as e:
                self._json(200, {"ok": False, "error": str(e)})
            except Exception as e:  # 网络/未知异常也要给页面可读信息
                self._json(200, {"ok": False, "error": "登录验证内部错误：%s" % e})
        elif self.path.startswith("/ingest"):
            # 外部采集结果（AI 代理 / 浏览器书签脚本）直接投递，页面照常一键取
            try:
                payload = json.loads(raw.decode("utf-8", "replace"))
                if not isinstance(payload, dict) or "assignments" not in payload:
                    raise ValueError("payload 需为含 assignments 字段的 JSON 对象")
                payload.setdefault("fetchedAt", datetime.datetime.now().strftime("%Y-%m-%d %H:%M"))
                payload.setdefault("source", "external")
                payload.setdefault("courses", [])
                payload.setdefault("materials", [])
                payload.setdefault("errors", [])
                with open(CACHE_FILE, "w", encoding="utf-8") as f:
                    json.dump(payload, f, ensure_ascii=False, indent=1)
                _STATE["by_account"]["__ingest__"] = payload   # #92：外投结果单独存，绝不进任何账号的 GET /data 缓存
                self._json(200, {"ok": True, "cached": True, "payload": payload})
            except (ValueError, OSError) as e:
                self._json(200, {"ok": False, "error": "ingest 失败：%s" % e})
        else:
            self._json(404, {"ok": False, "error": "not found"})


# ---------------------------------------------------------------- AI 代理网关（issue #55）
# ByteFolk 式「凭据留在宿主」：真实厂商 key 只存在于本机环境变量，页面/仓库永远拿不到。
# 页面侧（agent.js cloud-proxy 预设）只需指到 http://127.0.0.1:8765/v1 即可零配置开聊。
CLOUDAI_ENDPOINT = "https://hwdesk-workbench-95242.app.workbuddy.host"
QUOTA_FILE = os.path.join(HERE, "wb_proxy_quota.json")

# (provider, model 前缀元组, 上游 chat/completions 地址, key 的环境变量名)；None 前缀 = 兜底路由
PROXY_ROUTES = [
    ("deepseek", ("deepseek",),
     "https://api.deepseek.com/v1/chat/completions", "HWDESK_PROXY_DEEPSEEK_KEY"),
    ("moonshot", ("moonshot", "kimi"),
     "https://api.moonshot.cn/v1/chat/completions", "HWDESK_PROXY_MOONSHOT_KEY"),
    ("dashscope", ("qwen",),
     "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
     "HWDESK_PROXY_DASHSCOPE_KEY"),
    ("hunyuan", ("hunyuan",),
     "https://api.hunyuan.cloud.tencent.com/v1/chat/completions", "HWDESK_PROXY_HUNYUAN_KEY"),
    ("ark", None,
     "https://ark.cn-beijing.volces.com/api/v3/chat/completions", "HWDESK_PROXY_ARK_KEY"),
]

def proxy_route(model):
    """model → (provider, upstream_url, env_key)；前缀未命中走方舟兜底（接入点 ID 原样透传）"""
    m = (model or "").strip().lower()
    for name, prefixes, url, env in PROXY_ROUTES:
        if prefixes and any(m.startswith(p) for p in prefixes):
            return name, url, env
    name, _, url, env = PROXY_ROUTES[-1]
    return name, url, env


def proxy_tokens():
    """HWDESK_PROXY_TOKENS（逗号分隔）；未设置 = 本机信任模式（服务只监听 127.0.0.1，免 token）"""
    raw = os.environ.get("HWDESK_PROXY_TOKENS", "")
    return [t.strip() for t in raw.split(",") if t.strip()]


def proxy_origin_ok(origin):
    """Origin 白名单：空/null（file:// 与 curl）、localhost/127.0.0.1、发布站点、HWDESK_PROXY_ORIGINS 追加"""
    if not origin or origin == "null":
        return True
    try:
        host = urllib.parse.urlparse(origin).hostname or ""
    except ValueError:
        return False
    if host in ("127.0.0.1", "localhost"):
        return True
    try:
        pub = urllib.parse.urlparse(CLOUDAI_ENDPOINT).hostname
    except ValueError:
        pub = ""
    if host == pub:
        return True
    extra = [h.strip() for h in os.environ.get("HWDESK_PROXY_ORIGINS", "").split(",") if h.strip()]
    return host in extra


def proxy_check_auth(auth_header, origin, tokens=None):
    """纯函数：→ (ok, token, reason)。信任模式 token 记 'local'"""
    if tokens is None:
        tokens = proxy_tokens()
    if not proxy_origin_ok(origin):
        return False, "", "origin not allowed: %s" % origin
    if not tokens:
        return True, "local", ""
    if not auth_header or not auth_header.startswith("Bearer "):
        return False, "", "missing bearer token"
    tok = auth_header[7:].strip()
    if tok not in tokens:
        return False, "", "invalid token"
    return True, tok, ""


def proxy_daily_limit():
    try:
        return max(1, int(os.environ.get("HWDESK_PROXY_DAILY_LIMIT", "200")))
    except ValueError:
        return 200


def proxy_quota_allow(token, limit, today, state):
    """纯函数：→ (allowed, count)。state 为当日计数 dict（按天分桶），命中返回自增后的值"""
    day_map = state.get(today) if isinstance(state.get(today), dict) else {}
    used = int(day_map.get(token, 0))
    if used >= limit:
        return False, used
    day_map[token] = used + 1
    state[today] = day_map
    return True, day_map[token]


def proxy_quota_bump(token):
    """带持久化的配额判定：读 wb_proxy_quota.json → 判定 → 写回（只保留当天，防文件膨胀）"""
    today = datetime.date.today().isoformat()
    try:
        with open(QUOTA_FILE, encoding="utf-8") as f:
            state = json.load(f)
        if not isinstance(state, dict):
            state = {}
    except (OSError, ValueError):
        state = {}
    ok, n = proxy_quota_allow(token, proxy_daily_limit(), today, state)
    if ok:
        try:
            with open(QUOTA_FILE, "w", encoding="utf-8") as f:
                json.dump({today: state.get(today)}, f, ensure_ascii=False)
        except OSError:
            pass  # 磁盘写不进去就只在内存里限，本次进程内仍生效
    return ok, n


def proxy_upstream_key(env_name):
    return os.environ.get(env_name, "")


def proxy_available_models():
    """配置了哪些厂商 key 就暴露哪些模型（绝不返回 key 本身）"""
    out = []
    if proxy_upstream_key("HWDESK_PROXY_DEEPSEEK_KEY"):
        out += ["deepseek-chat", "deepseek-reasoner"]
    if proxy_upstream_key("HWDESK_PROXY_MOONSHOT_KEY"):
        out += ["moonshot-v1-8k"]
    if proxy_upstream_key("HWDESK_PROXY_DASHSCOPE_KEY"):
        out += ["qwen-plus"]
    if proxy_upstream_key("HWDESK_PROXY_HUNYUAN_KEY"):
        out += ["hunyuan-turbos-latest"]
    if proxy_upstream_key("HWDESK_PROXY_ARK_KEY"):
        out += ["ark-endpoint-id (passthrough)"]   # 方舟按接入点 ID 透传，目录里给个可用标记
    return out


def _proxy_opener():
    """强制直连上游（同 Session：系统代理 Clash 会把国内厂商请求带进 502），
    并且共用 tls_context()，否则没信任库的 python 连厂商 https 也会一起挂。"""
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), https_handler())


def _reset_agent_caches():
    """自检/改配置后清掉配置与模型目录缓存，下一次调用重新读盘。"""
    _agent_cfg_cache.update(key=None, data=None, error="", warnings=[])
    with _QODER_CATALOG_LOCK:
        _QODER_CATALOG.update(at=0.0, models=[], status="unknown", error="")


def self_test_agent():
    """agent.config.json（RoleWeave 语义的 hwdesk 侧配置）与回合参数生成的行为断言。
    全程不出网、不依赖本机装了 Qoder CLI。"""
    ok = True
    saved_env = dict(os.environ)
    tmp = tempfile.mkdtemp(prefix="hwdesk_agent_cfg_")

    def check(label, good, extra=""):
        nonlocal ok
        print(("ok  - " if good else "FAIL - ") + label + (("：" + extra) if extra and not good else ""))
        ok &= bool(good)

    try:
        # A1) 随包发布的配置文件必须解析成功、来源是文件、且守住硬闸
        _reset_agent_caches()
        cfg, error, warnings = load_agent_config()
        check("A1 agent.config.json 生效（非回退默认值）",
              not error and cfg is not None and os.path.isfile(AGENT_CONFIG_FILE), error)
        check("A1 权限模型是 deny 打底 + 只读白名单",
              cfg["permissions"]["defaultEffect"] == "deny"
              and set(cfg["permissions"]["allow"]) <= set(READONLY_TOOLS),
              str(cfg["permissions"]))
        check("A1 权限模式绝不绕过确认",
              cfg["permissions"]["permissionMode"] not in FORBIDDEN_PERMISSION_MODES,
              cfg["permissions"]["permissionMode"])
        check("A1 MCP 默认拒绝且没有外部 server",
              cfg["mcp"]["defaultEffect"] == "deny" and not cfg["mcp"]["servers"])
        check("A1 模型策略跟随账号默认 + 档位齐全",
              cfg["model"]["policy"] == "follow-account-default"
              and [t["id"] for t in cfg["model"]["tiers"]][:2]
              == ["provider-default", "auto"]
              and cfg["model"]["tiers"][0]["model"] is None)
        check("A1 CLI 解析顺序含 RoleWeave 的两个环境变量",
              "ORG_WORKBENCH_QODER_BIN" in cfg["cli"]["envOrder"]
              and "DIGITAL_EMPLOYEE_QODER_COMMAND" in cfg["cli"]["envOrder"])
        check("A1 只有 hwdesk 自己的变量有 fail-closed 资格",
              cfg["cli"]["envFailClosed"] == ["HWDESK_QODER_CLI"], str(cfg["cli"]["envFailClosed"]))
        check("A1 模型目录探测预算 ≥ 5 秒（实测冷启动 1.7~2.0s，3s 会被抖动打成 unavailable）",
              cfg["cli"]["probeTimeoutMs"] >= 5000, str(cfg["cli"]["probeTimeoutMs"]))
        check("A1 配置文件与内置默认值同源（关键安全项一致）",
              cfg["permissions"]["defaultEffect"]
              == AGENT_CONFIG_DEFAULTS["permissions"]["defaultEffect"]
              and cfg["permissions"]["allow"] == AGENT_CONFIG_DEFAULTS["permissions"]["allow"]
              and cfg["mcp"]["defaultEffect"] == AGENT_CONFIG_DEFAULTS["mcp"]["defaultEffect"],
              str(cfg["permissions"]["allow"]))

        # A1b) 随包配置与内置默认值的键形状完全对齐：写错一个键名＝静默失效，必须当场抓住
        def _shape(node, prefix=""):
            keys = set()
            if isinstance(node, dict):
                for k, v in node.items():
                    if isinstance(k, str) and k.startswith("_"):
                        continue
                    keys.add(prefix + k)
                    keys |= _shape(v, prefix + k + ".")
            elif isinstance(node, list):
                for item in node:
                    keys |= _shape(item, prefix)
            return keys

        try:
            with open(AGENT_CONFIG_FILE, encoding="utf-8") as fh:
                raw_cfg = json.load(fh)
        except (OSError, ValueError) as e:
            raw_cfg = {}
            check("A1b 能读回随包配置原文", False, str(e))
        only_file = sorted(_shape(raw_cfg) - _shape(AGENT_CONFIG_DEFAULTS))
        only_def = sorted(_shape(AGENT_CONFIG_DEFAULTS) - _shape(raw_cfg))
        check("A1b agent.config.json 没有默认值不认识的键（打错的键会静默失效）",
              not only_file, str(only_file))
        check("A1b agent.config.json 覆盖了默认值的每个键（改默认值时文件要同步）",
              not only_def, str(only_def))
        check("A1b 收敛后的生效配置仍等于随包配置的安全项",
              cfg["permissions"]["allow"] == AGENT_CONFIG_DEFAULTS["permissions"]["allow"]
              and cfg["permissions"]["deny"] == AGENT_CONFIG_DEFAULTS["permissions"]["deny"]
              and cfg["permissions"]["schemaVersion"] == "workbench-permissions.v1",
              str(cfg["permissions"]))

        # A2) 配置文件不存在 → 回退内置默认值，形状与随包发布的一致
        _reset_agent_caches()
        cfg2, err2, _w = load_agent_config(os.path.join(tmp, "missing.json"))
        check("A2 缺文件回退默认值且不报错给页面看空",
              err2 == "" and cfg2["permissions"]["allow"] == ["Read", "Grep", "Glob"]
              and cfg2["budget"]["perTask"]["timeoutSeconds"] == 300)

        # A3) 部分覆盖是逐层合并，没写的键保持默认
        partial = os.path.join(tmp, "partial.json")
        with open(partial, "w", encoding="utf-8") as f:
            f.write('{"permissions": {"allow": []}}')
        _reset_agent_caches()
        cfg3, _e3, _w3 = load_agent_config(partial)
        check("A3 局部覆盖：allow 被替换、deny/permissionMode/budget 保持默认",
              cfg3["permissions"]["allow"] == []
              and cfg3["permissions"]["permissionMode"] == "default"
              and cfg3["budget"]["perDay"]["turns"] == 200)

        # A4) 坏 JSON → 回退默认值 + 可读的 configError，绝不抛异常打挂桥
        broken = os.path.join(tmp, "broken.json")
        with open(broken, "w", encoding="utf-8") as f:
            f.write('{"permissions": ')
        _reset_agent_caches()
        cfg4, err4, _w4 = load_agent_config(broken)
        check("A4 坏 JSON 静默回退并回报原因",
              bool(err4) and cfg4["permissions"]["defaultEffect"] == "deny", err4)

        # A5) 硬闸：配置被改成放开写/绕过权限/MCP 全开时，一律收敛并留 warning
        hostile = {
            "permissions": {"defaultEffect": "allow", "permissionMode": "bypass_permissions",
                            "schemaVersion": "workbench-permissions.v2",
                            "allow": ["Read", {"bad": 1}, "Bash", "Read"]},
            "mcp": {"defaultEffect": "allow", "schemaVersion": "not-a-real-schema",
                    "servers": [{"name": "ok-server", "effect": "allow"},
                                {"name": "not-allowed"}, {"name": "bad name;rm"}]},
            "isolation": {"cleanEnv": False,
                          "envAllow": ["PATH", "HOME", "QODER_SDK_AUTH_PAYLOAD_FILE", 123]},
            "budget": {"perTask": {"timeoutSeconds": 99999, "maxOutputTokens": -5},
                       "perDay": {"turns": 0}},
        }
        cfg5, warn5 = _sanitize_config(hostile)
        check("A5 defaultEffect 被强制回 deny",
              cfg5["permissions"]["defaultEffect"] == "deny")
        check("A5 permission-mode 被强制回 default",
              cfg5["permissions"]["permissionMode"] == "default")
        check("A5 工具白名单去重且剔掉非法项",
              cfg5["permissions"]["allow"] == ["Read", "Bash"], str(cfg5["permissions"]["allow"]))
        check("A5 MCP servers 只留显式 allow 且名字合法",
              [s["name"] for s in cfg5["mcp"]["servers"]] == ["ok-server"],
              str(cfg5["mcp"]["servers"]))
        check("A5 不认识的 schemaVersion 收敛回本机真正实现的那一套并留痕",
              cfg5["permissions"]["schemaVersion"] == "workbench-permissions.v1"
              and cfg5["mcp"]["schemaVersion"] == "workbench-mcp.v1"
              and sum(1 for w in warn5 if "schemaVersion" in w) == 2, str(warn5))
        check("A5 envDropAlways 变量被从白名单里剔掉",
              "QODER_SDK_AUTH_PAYLOAD_FILE" not in cfg5["isolation"]["envAllow"]
              and "PATH" in cfg5["isolation"]["envAllow"])
        check("A5 预算数字被夹到合理区间",
              cfg5["budget"]["perTask"]["timeoutSeconds"] == 900
              and cfg5["budget"]["perTask"]["maxOutputTokens"] == 0
              and cfg5["budget"]["perDay"]["turns"] == 1)
        check("A5 每次收敛都留了告警", len(warn5) >= 3, str(warn5))

        # A6) CLI 解析：显式值非法即失败（不回落）；PATH 与每用户路径能找到
        os.environ["HWDESK_QODER_CLI"] = os.path.join(tmp, "definitely-not-here.exe")
        isolated = _deep_merge(AGENT_CONFIG_DEFAULTS,
                               {"cli": {"pathNames": [], "userCandidates": []}})
        check("A6 显式环境变量指向非法路径 → 判未就绪（不静默回落到别的可执行文件）",
              qoder_entry(isolated) == "")
        os.environ["HWDESK_QODER_CLI"] = os.path.join(tmp, "not-a-config.json")
        with open(os.path.join(tmp, "not-a-config.json"), "w", encoding="utf-8") as f:
            f.write("{}")
        check("A6 显式指向非可执行文件 → 同样判未就绪", qoder_entry(isolated) == "")
        os.environ["HWDESK_QODER_CLI"] = os.path.join(tmp, "real.json")
        with open(os.path.join(tmp, "real.json"), "w", encoding="utf-8") as f:
            f.write("{}")
        fake_dir = os.path.join(tmp, "bin")
        os.makedirs(fake_dir, exist_ok=True)
        fake = os.path.join(fake_dir, "fakeqodercli" + (".exe" if os.name == "nt" else ""))
        with open(fake, "w", encoding="utf-8") as f:
            f.write("@echo off\r\n")
        os.chmod(fake, 0o755)
        os.environ["HWDESK_QODER_CLI"] = fake
        check("A6 显式指向合法可执行文件 → 返回 realpath",
              qoder_entry(isolated) == os.path.realpath(fake), qoder_entry(isolated))
        os.environ["HWDESK_QODER_CLI"] = "fakeqodercli"
        os.environ["PATH"] = fake_dir + os.pathsep + os.environ.get("PATH", "")
        check("A6 显式值是裸命令名时走 PATH（PATHEXT）解析",
              qoder_entry(isolated) == os.path.realpath(fake), qoder_entry(isolated))
        no_env = _deep_merge(AGENT_CONFIG_DEFAULTS, {"cli": {"envOrder": []}})
        for var in ("HWDESK_QODER_CLI", "ORG_WORKBENCH_QODER_BIN",
                    "DIGITAL_EMPLOYEE_QODER_COMMAND"):
            os.environ.pop(var, None)
        by_path = qoder_entry(_deep_merge(no_env, {"cli": {"envOrder": [], "pathNames": ["fakeqodercli"],
                                                           "userCandidates": []}}))
        check("A6 PATH 按 pathNames 命中", by_path == os.path.realpath(fake), by_path)
        by_cand = qoder_entry(_deep_merge(no_env, {"cli": {"envOrder": [], "pathNames": [],
                                                           "userCandidates": [fake]}}))
        check("A6 每用户安装路径候选可命中（realpath 后返回）",
              by_cand == os.path.realpath(fake), by_cand)
        miss = qoder_entry(_deep_merge(no_env, {"cli": {"envOrder": [], "pathNames": ["nope-xyz"],
                                                        "userCandidates": [os.path.join(tmp, "nope")]}}))
        check("A6 全部落空 → 空串（页面据此提示安装或指定环境变量）", miss == "", miss)

        # A6b) 失败语义分两档（本机踩过的坑：桥被 RoleWeave/Qoder 会话拉起时，那个
        #      会话的 ORG_WORKBENCH_QODER_BIN 会泄漏进来，值可能是 POSIX 路径）
        own_only = _deep_merge(AGENT_CONFIG_DEFAULTS, {"cli": {"pathNames": [], "userCandidates": []}})
        os.environ["HWDESK_QODER_CLI"] = os.path.join(tmp, "gone.exe")
        hit_closed, src_closed, warn_closed = qoder_entry_detail(own_only)
        check("A6b hwdesk 自己的变量非法 → 判未就绪并说明（不转头跑别的可执行文件）",
              hit_closed == "" and src_closed == "env:HWDESK_QODER_CLI" and warn_closed,
              str((hit_closed, src_closed, warn_closed)))
        os.environ.pop("HWDESK_QODER_CLI", None)
        os.environ["ORG_WORKBENCH_QODER_BIN"] = "/home/feng/.local/bin/qoderclicn"
        fallback_cfg = _deep_merge(own_only, {"cli": {"userCandidates": [fake]}})
        hit_fk, src_fk, warn_fk = qoder_entry_detail(fallback_cfg)
        check("A6b RoleWeave 的外部变量非法 → 不采纳它、继续走候选路径、留告警",
              hit_fk == os.path.realpath(fake) and src_fk.startswith("candidate:") and warn_fk,
              str((hit_fk, src_fk)))
        check("A6b 告警写明白是哪来的变量",
              bool(warn_fk) and "ORG_WORKBENCH_QODER_BIN" in warn_fk[0], str(warn_fk))
        os.environ["ORG_WORKBENCH_QODER_BIN"] = fake
        hit_inh, src_inh, _wi = qoder_entry_detail(own_only)
        check("A6b 外部变量指向合法可执行文件时按 RoleWeave 语义优先采纳",
              hit_inh == os.path.realpath(fake) and src_inh == "env:ORG_WORKBENCH_QODER_BIN",
              str((hit_inh, src_inh)))
        os.environ.pop("ORG_WORKBENCH_QODER_BIN", None)

        # A7) 回合参数：deny + 白名单 / 空 allow / MCP 恒严格 / 无绕过开关
        cfg_ro = _deep_merge(AGENT_CONFIG_DEFAULTS, {"permissions": {"allow": ["Read", "Grep", "Glob"]}})
        args_ro = qoder_turn_args(cfg_ro, None)
        i = args_ro.index("--tools")
        check("A7 只读白名单原样下发",
              args_ro[i + 1:i + 4] == ["Read", "Grep", "Glob"]
              and str(args_ro[i + 4]).startswith("--"), str(args_ro))
        check("A7 空 MCP + 严格模式（RoleWeave workbench-mcp deny 同款）",
              "--strict-mcp-config" in args_ro
              and args_ro[args_ro.index("--mcp-config") + 1] == '{"mcpServers":{}}')
        check("A7 权限模式 default 且绝不让 --dangerously-skip-permissions 出现",
              args_ro[args_ro.index("--permission-mode") + 1] == "default"
              and not any("skip-permissions" in a for a in args_ro), str(args_ro))
        check("A7 写/命令/联网在 deny 之外再挂一道 disallowed",
              args_ro[args_ro.index("--disallowed-tools") + 1].startswith("Write,Edit"))
        check("A7 预算落到 --max-output-tokens，不自选时不带 -m",
              args_ro[args_ro.index("--max-output-tokens") + 1] == "8000" and "-m" not in args_ro)
        check("A7 不加载用户 settings + 对话不落本机会话",
              args_ro[args_ro.index("--setting-sources") + 1] == ""
              and "--no-session-persistence" in args_ro)
        cfg_none = _deep_merge(AGENT_CONFIG_DEFAULTS, {"permissions": {"allow": []}})
        args_none = qoder_turn_args(cfg_none, "Qwen3.8-Flash")
        check("A7 allow 置空即纯对话：--tools 空串",
              args_none[args_none.index("--tools") + 1] == "")
        check("A7 明确选了账号里存在的模型才下传 -m",
              args_none[args_none.index("-m") + 1] == "Qwen3.8-Flash")

        # A8) 环境隔离：只带白名单，会话泄漏的 SDK 鉴权变量必须掉
        os.environ["QODER_SDK_AUTH_PAYLOAD_FILE"] = os.path.join(tmp, "payload.json")
        os.environ["QODER_PERSONAL_ACCESS_TOKEN"] = "someone-elses-credential"
        os.environ["HWDESK_TEST_SECRET"] = "never-forward"
        os.environ["ANTHROPIC_API_KEY"] = "never-forward"
        clean = _qoder_clean_env(agent_config())
        check("A8 白名单外的一切（含密钥类）不进子进程环境",
              "QODER_SDK_AUTH_PAYLOAD_FILE" not in clean
              and "HWDESK_TEST_SECRET" not in clean and "ANTHROPIC_API_KEY" not in clean)
        check("A8 别人的凭据绝不借用（PAT 在白名单里也被无条件剥掉）",
              "QODER_PERSONAL_ACCESS_TOKEN" not in clean)
        check("A8 CLI 自己的登录态目录照常转（零 Key 靠它，剥了就变成未登录）",
              clean.get("QODER_CONFIG_DIR") == os.environ.get("QODER_CONFIG_DIR"))
        check("A8 子进程仍拿得到 PATH / 家目录 / 临时目录",
              bool(clean.get("PATH") or clean.get("Path"))
              and bool(clean.get("HOME") or clean.get("USERPROFILE") or clean.get("home"))
              and bool(clean.get("TEMP") or clean.get("Temp") or clean.get("TMPDIR")))

        # A9) 档位解析：跟随默认不下传；目录没探到/档位不存在一律回默认并说明
        cat_ok = {"status": "ok", "models": ["Qwen3.8-Flash"], "error": ""}
        m, _n = resolve_qoder_model("provider-default", agent_config(), cat_ok)
        check("A9 provider-default 不下传 -m（跟随账号默认）", m is None)
        m, n = resolve_qoder_model("ultimate", agent_config(), cat_ok)
        check("A9 账号目录里没有的档位不硬塞（实测会被 CLI 静默降级）",
              m is None and "不在本机账号的模型目录里" in n, n)
        m, _n = resolve_qoder_model("Qwen3.8-Flash", agent_config(), cat_ok)
        check("A9 自定义模型在目录里才下传", m == "Qwen3.8-Flash")
        m, n = resolve_qoder_model("efficient", agent_config(),
                                   {"status": "unavailable", "models": [], "error": "超时"})
        check("A9 目录没探到时任何选择都回默认并说明原因",
              m is None and "账号模型目录没取到" in n, n)
        m, n = resolve_qoder_model("bad model;rm -rf", agent_config(), cat_ok)
        check("A9 非法模型名被拒（不进 argv）",
              m is None and "不合法" in n, n)

        # A10) 预算：perDay.turns 用满即熔断，换日自动恢复
        cfg_b = _deep_merge(AGENT_CONFIG_DEFAULTS, {"budget": {"perDay": {"turns": 2, "tokens": 0}}})
        _QODER_BUDGET.update(day=datetime.date.today().isoformat(), turns=0, tokens=0, credits=0.0)
        budget_record({"usage": {"input_tokens": 3, "output_tokens": 4}, "total_credits": 0.1})
        budget_record({"usage": {}})
        check("A10 回合计数与 token 记账（本账号 usage 全 0 时不假装统计）",
              _QODER_BUDGET["turns"] == 2 and _QODER_BUDGET["tokens"] == 7)
        check("A10 超 perDay.turns 即熔断", bool(budget_refusal(cfg_b)))
        _QODER_BUDGET.update(day="2000-01-01", turns=5, tokens=0, credits=0.0)
        check("A10 换日自动清零", budget_snapshot(cfg_b)["turns"] == 0 and not budget_refusal(cfg_b))

        # A11) 横幅与 --tools 真值同步，且始终禁止伪调用原文
        banner_ro = qoder_mode_banner(cfg_ro)
        banner_none = qoder_mode_banner(cfg_none)
        check("A11 开了只读工具时横幅讲明范围（不再谎称工具全禁）",
              "只读检索" in banner_ro and "Read" in banner_ro and "Grep" in banner_ro)
        check("A11 工具全关时横幅仍讲纯对话", "纯对话通道" in banner_none)
        fake_call = "<" + "tool_call" + ">"
        check("A11 两种横幅都禁止把伪调用当正文", fake_call in banner_ro and fake_call in banner_none)
        composed = qoder_compose_prompt([{"role": "system", "content": "S"},
                                         {"role": "user", "content": "U"},
                                         {"role": "assistant", "content": "A"},
                                         {"role": "bogus", "content": "X"},
                                         "not-a-dict"], cfg_ro)
        check("A11 提示词保留多轮角色且非法项被跳过",
              composed.startswith("【运行模式】") and "【用户】\nU" in composed
              and "【你上一轮的回复】\nA" in composed and "X" not in composed)

        # A12) --list-models 文本表解析（本机实测首行是 MODEL 表头）
        check("A12 表头/分隔线被剔掉，只留模型 id",
              parse_model_catalog("MODEL\nQwen3.8-Flash\n") == ["Qwen3.8-Flash"]
              and parse_model_catalog("| --- |\n| auto | efficient |\n") == ["auto"]
              and parse_model_catalog("") == []
              and parse_model_catalog("SDK auth payload file not found: /tmp/x") == [])
        # A13) 模型目录缓存窗口：成功长缓存、失败 30 秒就重试（一次抖动不该锁死档位）
        orig_probe = globals()["_run_catalog_probe"]
        calls = []

        def fake_probe(entry, cfg):
            calls.append(1)
            return None, "模拟探测超时"

        globals()["_run_catalog_probe"] = fake_probe
        try:
            _reset_agent_caches()
            slow_cfg = _deep_merge(AGENT_CONFIG_DEFAULTS, {"cli": {"catalogCacheSeconds": 600}})
            for var in ("HWDESK_QODER_CLI", "ORG_WORKBENCH_QODER_BIN",
                        "DIGITAL_EMPLOYEE_QODER_COMMAND"):
                os.environ.pop(var, None)
            cat1 = qoder_catalog(slow_cfg)
            qoder_catalog(slow_cfg)
            if qoder_entry(slow_cfg):
                check("A13 探测失败回报 unavailable + 原因",
                      cat1["status"] == "unavailable" and "模拟探测超时" in cat1["error"], str(cat1))
                check("A13 失败结果 30 秒内不重复探测（页面不会被拖慢）", len(calls) == 1, str(calls))
                _QODER_CATALOG["at"] = time.time() - 31
                qoder_catalog(slow_cfg)
                check("A13 过了短窗口会再试一次", len(calls) == 2, str(calls))
            globals()["_run_catalog_probe"] = lambda entry, cfg: ("MODEL\nQwen3.8-Flash\n", "")
            _reset_agent_caches()
            if qoder_entry(slow_cfg):
                cat3 = qoder_catalog(slow_cfg)
                check("A13 成功时解析出模型并长缓存",
                      cat3["status"] == "ok" and cat3["models"] == ["Qwen3.8-Flash"], str(cat3))
                _QODER_CATALOG["at"] = time.time() - 60
                cat3b = qoder_catalog(slow_cfg)
                check("A13 成功结果在 TTL 内不重探", cat3b.get("ageSeconds") == 60, str(cat3b))
            no_cli_cfg = _deep_merge(AGENT_CONFIG_DEFAULTS,
                                     {"cli": {"envOrder": [], "pathNames": [], "userCandidates": []}})
            _reset_agent_caches()
            cat4 = qoder_catalog(no_cli_cfg)
            check("A13 没装 CLI 时明确报 no-cli（不假装成空目录）",
                  cat4["status"] == "no-cli", str(cat4))
        finally:
            globals()["_run_catalog_probe"] = orig_probe
            _reset_agent_caches()
    finally:
        os.environ.clear()
        os.environ.update(saved_env)
        _reset_agent_caches()
        try:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)
        except OSError:
            pass
    return ok


def self_test_tls():
    ok = True

    # T1) 当前解释器必须拿得出可信根，否则一切 https 都是「certificate verify failed」
    ctx = tls_context()
    anchors = tls_anchor_count(ctx)
    good = anchors > 0
    print(("ok  - tls_context has %d trust anchors" % anchors if good
           else "FAIL - tls_context has no trust anchors (x509_ca=0)，本机 python 无信任库且找不到 CA bundle"))
    ok &= good

    # T2) 进程内复用，别每次请求重建
    good = tls_context() is ctx
    print(("ok  - tls_context cached per process" if good else "FAIL - tls_context rebuilt each call"))
    ok &= good

    # T3) 三个出口（Session / clone_session / _proxy_opener）都挂上了这个上下文
    def opener_ctx(opener):
        for h in opener.handlers:
            c = getattr(h, "_context", None)
            if c is not None:
                return c
        return None

    s = Session()
    c1 = opener_ctx(s.opener) is ctx
    c2 = opener_ctx(clone_session(s).opener) is ctx
    c3 = opener_ctx(_proxy_opener()) is ctx
    good = c1 and c2 and c3
    print(("ok  - Session / clone_session / _proxy_opener share tls_context" if good
           else "FAIL - https context not wired: session=%r clone=%r proxy=%r" % (c1, c2, c3)))
    ok &= good

    # T4) 兜底真的能灌进锚点；坏路径静默跳过、不抛异常
    bogus = fill_trust_anchors(ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT), ["C:\\nope\\missing-ca.pem"])
    bare = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    bundles = ca_bundle_candidates()
    if bundles:
        used = fill_trust_anchors(bare, bundles)
        good = (bogus is None and used in bundles and tls_anchor_count(bare) > 0)
        detail = "used=%r anchors=%d" % (used, tls_anchor_count(bare))
    else:   # 干净机器上没有外部 bundle，只核对「不抛 + 不假装成功」
        good = bogus is None and tls_anchor_count(bare) == 0
        detail = "no external bundle on this host"
    print(("ok  - fill_trust_anchors fills an empty store, ignores bad paths (%s)" % detail if good
           else "FAIL - fill_trust_anchors: bogus=%r %s" % (bogus, detail)))
    ok &= good

    # T5) CA bundle 候选列表只含真实存在的文件
    good = all(os.path.isfile(p) for p in ca_bundle_candidates())
    print(("ok  - ca_bundle_candidates lists only existing files" if good
           else "FAIL - ca_bundle_candidates: %r" % (ca_bundle_candidates(),)))
    ok &= good

    # T6) 报错文案：信任库问题说成本机 python 的事，其它网络错误才让查站点
    ssl_reason = ssl.SSLError(1, "[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: "
                                 "unable to get local issuer certificate (_ssl.c:1010)")
    t_ssl = net_error_text(ssl_reason)
    t_net = net_error_text(OSError(10061, "Connection refused"))
    good = ("本机 Python" in t_ssl and "certifi" in t_ssl and "courses.hzcu.edu.cn" not in t_ssl
            and "courses.hzcu.edu.cn" in t_net)
    print(("ok  - net_error_text separates TLS-trust failures from site failures" if good
           else "FAIL - net_error_text: %r / %r" % (t_ssl, t_net)))
    ok &= good

    return ok


def self_test_proxy():
    ok = True

    # 8) 路由表：前缀命中与方舟兜底
    r1 = proxy_route("deepseek-chat")
    r2 = proxy_route("kimi-x")
    r3 = proxy_route("qwen-plus")
    r3b = proxy_route("hunyuan-turbos-latest")
    r4 = proxy_route("ep-20260101-abc123")   # 方舟接入点 ID → 兜底
    good = r1[0] == "deepseek" and r2[0] == "moonshot" and r3[0] == "dashscope" \
        and r3b[0] == "hunyuan" and r4[0] == "ark"
    print(("ok  - proxy_route maps deepseek/moonshot/qwen prefixes, ark fallback" if good
           else "FAIL - proxy_route: %r %r %r %r" % (r1, r2, r3, r4)))
    ok &= good

    # 9) 鉴权：token 模式 / 信任模式 / Origin 白名单
    t = ["tok-a", "tok-b"]
    good = proxy_check_auth("Bearer tok-a", None, t)[0] \
        and proxy_check_auth("Bearer tok-b", "http://localhost:9999", t)[0] \
        and not proxy_check_auth("Bearer nope", None, t)[0] \
        and not proxy_check_auth(None, None, t)[0] \
        and proxy_check_auth(None, "null", [])[0] \
        and proxy_check_auth(None, "https://" + urllib.parse.urlparse(CLOUDAI_ENDPOINT).hostname, [])[0] \
        and not proxy_check_auth(None, "https://evil.example.com", [])[0] \
        and proxy_check_auth(None, None, [])[1] == "local"
    print(("ok  - proxy_check_auth token/origin rules (trust mode, file://, published host)" if good
           else "FAIL - proxy_check_auth rules"))
    ok &= good

    # 10) 配额：限额内放行、超限拒绝、次日重置
    st = {}
    a1 = proxy_quota_allow("t", 2, "2026-10-26", st)
    a2 = proxy_quota_allow("t", 2, "2026-10-26", st)
    a3 = proxy_quota_allow("t", 2, "2026-10-26", st)
    a4 = proxy_quota_allow("t", 2, "2026-10-27", st)
    good = a1 == (True, 1) and a2 == (True, 2) and a3 == (False, 2) and a4 == (True, 1)
    print(("ok  - proxy_quota_allow caps per token per day, resets next day" if good
           else "FAIL - proxy_quota_allow: %r %r %r %r" % (a1, a2, a3, a4)))
    ok &= good

    # 11) models 目录：不配 key 为空；只配方舟也有 passthrough 标记（探测层据此判定可用）
    saved = {k: os.environ.get(k) for k in
             ("HWDESK_PROXY_DEEPSEEK_KEY", "HWDESK_PROXY_MOONSHOT_KEY",
              "HWDESK_PROXY_DASHSCOPE_KEY", "HWDESK_PROXY_HUNYUAN_KEY", "HWDESK_PROXY_ARK_KEY")}
    for k in saved:
        os.environ.pop(k, None)
    empty_ok = proxy_available_models() == []
    os.environ["HWDESK_PROXY_ARK_KEY"] = "test-only"
    ark_ok = proxy_available_models() == ["ark-endpoint-id (passthrough)"]
    os.environ["HWDESK_PROXY_HUNYUAN_KEY"] = "test-only"
    hy_ok = "hunyuan-turbos-latest" in proxy_available_models()
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    good = empty_ok and ark_ok and hy_ok
    print(("ok  - proxy_available_models empty-when-unconfigured, ark passthrough marker, hunyuan" if good
           else "FAIL - proxy_available_models: %r %r %r" % (empty_ok, ark_ok, hy_ok)))
    ok &= good

    return ok


# ---------------------------------------------------------------- 自检
def self_test():
    ok = True

    # 1) AES FIPS-197 标准测试向量
    key = bytes(range(16))
    pt = bytes.fromhex("00112233445566778899aabbccddeeff")
    want = "69c4e0d86a7b0430d8cdb78070b4c55a"
    got = _aes128_encrypt_block(key, pt).hex()
    print(("ok  - AES-128 single block == FIPS-197 vector" if got == want
           else "FAIL - AES got %s want %s" % (got, want)))
    ok &= got == want

    # 2) ECB 模式接线：与 OpenSSL（Node crypto）实测对齐的单块向量
    key = bytes.fromhex("2b7e151628aed2a6abf7158809cf4fab")
    pt = bytes.fromhex("6bc1bee22e409f96e93d7e117393172a")
    want = "b1f46e53b610e01b89eef3546e8f2c1a"   # OpenSSL aes-128-ecb 无填充输出
    got = aes_ecb_pkcs7_encrypt(key, pt).hex()[:32]  # PKCS7 整块填充在第二个块，不影响首块
    print(("ok  - AES-128-ECB == OpenSSL reference vector" if got == want
           else "FAIL - ECB got %s want %s" % (got, want)))
    ok &= got == want

    # 3) cas_cipher：与登录页 CryptoJS.AES(ECB/PKCS7) 等价 —— 用 OpenSSL 独立算出的基准值
    c1, c2 = cas_cipher("Test@123"), cas_cipher("Test@123")
    c3 = cas_cipher("x" * 16)
    good = c1 == c2 and c1 == "50lIWQbJK5c+VIm234TNTA==" and \
        c3 == "zlXGTrLxKmcgSpWDy/NXWu95dJ6XTY5RQ5j0NF6OQuY=" and \
        len(CAS_AES_KEY) == 16
    print(("ok  - cas_cipher matches CryptoJS/OpenSSL reference (AES-128-ECB+PKCS7)" if good
           else "FAIL - cas_cipher: %r" % [c1, c3]))
    ok &= good

    # 4) CAS 登录页解析
    fixture = ('<form id="fm1" name="fm1" action="/cas//login;jsessionid=ABC123'
               '?service=https%3A%2F%2Fidentity.hzcu.edu.cn%2Fauth%2Frealms%2Fzju-xzzj'
               '%2Fbroker%2Fcas-client%2Fendpoint%3Fstate%3Dxyz" method="post">'
               '<input id="username" name="username" type="text"/>'
               '<input id="password" name="password" type="password"/>'
               '<input type="hidden" name="lt" value="" />'
               '<input type="hidden" name="execution" value="e1s2" />'
               '<input type="hidden" name="_eventId" value="submit" /></form>')
    info = parse_cas_login(fixture)
    good = info["action"].startswith("/cas//login;jsessionid=ABC123") and \
        info["execution"] == "e1s2" and info["lt"] == ""
    print(("ok  - parse_cas_login extracts action/execution/lt" if good
           else "FAIL - parse_cas_login: %r" % info))
    ok &= good

    # 5) Origin 必须跟随实际表单页协议，不能固定为 HTTPS。
    good = cas_origin("http://ca.hzcu.edu.cn/cas//login?service=x") == "http://ca.hzcu.edu.cn" and \
        cas_origin("https://ca.hzcu.edu.cn:8443/cas/login") == "https://ca.hzcu.edu.cn:8443"
    print(("ok  - cas_origin follows the actual CAS page URL" if good
           else "FAIL - cas_origin"))
    ok &= good

    # 6) 待办映射：UTC → 北京时间 +8，类型映射
    row = todo_to_assignment({"course_name": "电力电子技术", "title": "实验1报告",
                           "type": "homework", "end_time": "2026-11-01T15:59:59.000Z"})
    good = row["course"] == "电力电子技术" and row["title"] == "实验1报告" and \
        row["kind"] == "作业" and row["due"] == "2026-11-01 23:59" and row["status"] == "todo"
    print(("ok  - todo_to_assignment maps fields & UTC+8 due" if good
           else "FAIL - todo_to_assignment: %r" % row))
    ok &= good

    # 6) 作业映射：已提交/已截止/进行中三种状态 + 要求描述进 note + id 透传（#58）
    r1 = hw_to_assignment({"id": 88, "title": "作业A", "type": "homework", "submitted": True,
                        "end_time": "2026-10-01T01:00:00.000Z"}, "课程X")
    r2 = hw_to_assignment({"title": "作业B", "type": "exam", "submitted": False,
                        "is_closed": True, "end_time": ""}, "课程X")
    r3 = hw_to_assignment({"title": "作业C", "type": "quiz", "submitted": False,
                        "is_in_progress": True, "deadline": "2026-12-31 12:00"}, "课程X")
    r4 = hw_to_assignment({"title": "作业D", "type": "homework", "submitted": True,
                        "description": "<p>提交<b>实验代码</b>与报告</p>"}, "课程X")
    good = r1["status"] == "submitted" and r1["due"] == "2026-10-01 09:00" and r1["id"] == "88" and \
        r2["status"] == "unknown" and r2["kind"] == "考试" and \
        r3["status"] == "todo" and r3["due"] == "2026-12-31 12:00" and r3["note"] == "进行中" and \
        r4["note"] == "要求：提交实验代码与报告"
    print(("ok  - hw_to_assignment maps submitted/closed/in-progress (+desc/id #58)" if good
           else "FAIL - hw_to_assignment: %r %r %r %r" % (r1, r2, r3, r4)))
    ok &= good

    # 6b) 详情字段提取（#58）：要求/成绩/批语，子对象优先，垃圾输入零输出
    d1 = _detail_note_parts({"description": "<p>用 Multisim 仿真</p>",
                             "student_submission": {"score": 92, "comment": "<i>波形图缺失</i>"}})
    d2 = _detail_note_parts({"score": 88, "teacher_comment": "注意单位"})
    d3 = _detail_note_parts("垃圾响应")
    good = d1 == ("用Multisim仿真", "92", "波形图缺失") \
        and d2 == ("", "88", "注意单位") and d3 == ("", "", "")
    print(("ok  - _detail_note_parts extracts desc/score/comment tolerantly" if good
           else "FAIL - _detail_note_parts: %r %r %r" % (d1, d2, d3)))
    ok &= good

    # 6c) 详情补拉（#58）：note 注入 + 无 id / 失败时不炸且每课程只记一条 error
    real_api2 = api_json
    try:
        globals()["api_json"] = lambda s, path: {"description": "<p>要求原文</p>",
                                                 "student_submission": {"score": 95, "comment": "很好"}}
        a = hw_to_assignment({"id": 5, "title": "作业E", "type": "homework", "submitted": True}, "课程Y")
        errs, failed = [], set()
        hw_detail_enrich(object(), a, errs, failed)
        good = a["note"].index("要求：要求原文") != -1 and "成绩：95" in a["note"] and "批语：很好" in a["note"]
        globals()["api_json"] = lambda s, path: (_ for _ in ()).throw(SyncError("接口 404"))
        b = hw_to_assignment({"id": 6, "title": "作业F", "type": "homework", "submitted": True}, "课程Z")
        hw_detail_enrich(object(), b, errs, failed)
        hw_detail_enrich(object(), b, errs, failed)
        good &= b["note"] == "" and len([e for e in errs if "课程Z" in e]) == 1
    finally:
        globals()["api_json"] = real_api2
    print(("ok  - hw_detail_enrich injects note & dedupes per-course errors" if good
           else "FAIL - hw_detail_enrich: %r" % errs))
    ok &= good

    # 6d) 待办翻页全采：todo_list 跨 2 页，课程/作业/课件桩不动，断言第 2 页待办也在结果里
    real_api3 = api_json
    titles = []
    def _fake_api(s, path):
        if path.startswith("/api/my-courses"):
            return {"courses": [{"id": "1", "name": "课程P"}], "pages": 1, "page": 1}
        if path.startswith("/api/todos"):
            m = re.search(r"page=(\d+)", path)
            pg = int(m.group(1)) if m else 1
            if pg <= 1:
                return {"todo_list": [{"course_name": "课程P", "title": "待办P1", "type": "homework", "end_time": ""}],
                        "pages": 2, "page": 1}
            return {"todo_list": [{"course_name": "课程P", "title": "待办P2", "type": "exam", "end_time": ""}],
                    "pages": 2, "page": 2}
        if "/homework-activities" in path:
            return {"homework_activities": [], "pages": 1, "page": 1}
        return {"materials": [], "folders": []}   # 课件桩
    try:
        globals()["api_json"] = _fake_api
        payload = hzcu_collect(object())
        titles = [a["title"] for a in payload["assignments"]]
        good = "待办P1" in titles and "待办P2" in titles and not payload["errors"]
    finally:
        globals()["api_json"] = real_api3
    print(("ok  - hzcu_collect walks all todo pages (P1+P2)" if good
           else "FAIL - hzcu_collect todo pages: %r errors=%r" % (titles, payload.get("errors"))))
    ok &= good

    # 7) 课程映射
    ce = course_to_entry({"id": "12345", "name": "电机与拖动"})
    good = ce == {"id": "12345", "name": "电机与拖动"}
    print(("ok  - course_to_entry extracts id/name" if good else "FAIL - course_to_entry: %r" % ce))
    ok &= good

    # 8) 课件映射（#57）：标题兜底字段、HTML 摘要、目录前缀、无标题丢弃
    m1 = _material_to_entry({"name": "第3章 Buck变换器", "description": "<p>开关频率<b>20kHz</b>，报告需含波形图</p>"},
                            "电力电子技术")
    good = m1 == {"course": "电力电子技术", "title": "第3章 Buck变换器", "kind": "课件",
                  "note": "开关频率20kHz，报告需含波形图"}
    print(("ok  - _material_to_entry maps name/description with html stripped" if good
           else "FAIL - _material_to_entry: %r" % m1))
    ok &= good
    m2 = _material_to_entry({"file_name": "讲义.pdf", "file_type": "pdf"}, "课程X", "第1章 基础")
    good = m2 and m2["title"] == "第1章 基础 · 讲义.pdf" and m2["note"] == "文件类型：pdf"
    print(("ok  - _material_to_entry folder prefix + file type note" if good
           else "FAIL - _material_to_entry folder: %r" % m2))
    ok &= good
    m3 = _material_to_entry({"description": "<i>没有标题的条目</i>"}, "课程X")
    good = m3 is None
    print(("ok  - _material_to_entry drops title-less entries" if good
           else "FAIL - _material_to_entry none: %r" % m3))
    ok &= good

    # 9) _strip_html（#57）
    good = _strip_html("<p>A&nbsp;B</p>  C") == "A B C" and _strip_html(None) == "" and \
        _strip_html("x" * 500) == "x" * 200
    print(("ok  - _strip_html unescapes/squeezes/truncates" if good
           else "FAIL - _strip_html: %r" % _strip_html("<p>A&nbsp;B</p>  C")))
    ok &= good

    # 10) _materials_page 宽松兜底（打桩模块级 api_json，测完还原）
    real_api = api_json
    try:
        globals()["api_json"] = lambda s, path: {"materials": [{"title": "课件A"}], "folders": [{"id": 7, "name": "目录B"}]}
        folds, ms = _materials_page(object(), "1", 0)
        good = len(ms) == 1 and len(folds) == 1
        globals()["api_json"] = lambda s, path: [{"title": "裸数组兜底"}]
        folds2, ms2 = _materials_page(object(), "1", 0)
        good &= len(ms2) == 1 and folds2 == []
        globals()["api_json"] = lambda s, path: "垃圾响应"
        folds3, ms3 = _materials_page(object(), "1", 0)
        good &= folds3 == [] and ms3 == []
    finally:
        globals()["api_json"] = real_api
    print(("ok  - _materials_page tolerates dict/list/garbage responses" if good
           else "FAIL - _materials_page fallback"))
    ok &= good

    # 11) 数据属主（#92）：payload 带 account 标记 + 缓存按账号分桶互不串号
    real_login, real_collect, real_cache = hzcu_login, hzcu_collect, CACHE_FILE
    fd, tmp_cache = tempfile.mkstemp(suffix=".json")
    os.close(fd)
    try:
        globals()["hzcu_login"] = lambda a, p: object()
        globals()["hzcu_collect"] = lambda s: {"fetchedAt": "t", "source": "hzcu-xzc",
                                               "courses": [], "assignments": [],
                                               "materials": [], "errors": []}
        globals()["CACHE_FILE"] = tmp_cache
        _STATE["by_account"].clear()
        p1, c1 = collect_payload({"account": "a1", "password": "x"})
        p2, c2 = collect_payload({"account": "a2", "password": "x"})
        good = (not c1) and (not c2) and p1.get("account") == "a1" and p2.get("account") == "a2"
        q1, h1 = collect_payload({"account": "a1", "password": "x"}, force=False)
        q2, h2 = collect_payload({"account": "a2", "password": "x"}, force=False)
        good &= h1 and h2 and q1.get("account") == "a1" and q2.get("account") == "a2"
        q3, h3 = collect_payload({"account": "a3", "password": "x"}, force=False)
        good &= (not h3) and q3.get("account") == "a3"   # 新账号绝不命中别人的缓存
    finally:
        globals()["hzcu_login"], globals()["hzcu_collect"] = real_login, real_collect
        globals()["CACHE_FILE"] = real_cache
        _STATE["by_account"].clear()
        try:
            os.unlink(tmp_cache)
        except OSError:
            pass
    print(("ok  - collect_payload stamps owner account & caches per-account (#92)" if good
           else "FAIL - collect_payload per-account: %r %r %r" % (p1, p2, q3)))
    ok &= good

    ok &= self_test_agent()
    ok &= self_test_tls()
    ok &= self_test_proxy()

    print("SELF-TEST " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main():
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("hwdesk-syncserver %s | http://%s:%s" % (VERSION, HOST, PORT))
    print("  平台：学在城院 %s（Tronclass；非超星学习通）" % URL_LMS)
    print("  GET  /health      健康检查")
    print("  GET  /data        取缓存或用 wb_local.json 拉取")
    print("  POST /data        请求体可带 {\"account\",\"password\"}（仅本次内存使用）")
    print("  POST /ingest      外部采集结果投递")
    print("  GET  /v1/models   AI 代理：已配置的模型目录（issue #55）")
    print("  POST /v1/chat/completions  AI 代理：OpenAI 兼容反代，厂商 key 全在环境变量")
    print("  凭据文件：%s（不要提交）" % CFG_FILE)
    print("  Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
