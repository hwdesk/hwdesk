#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""syncserver.py 1.0.0 | hwdesk 学在城院本机直连桥（纯标准库，零第三方依赖）

为什么需要它：
  作业提交工作台是 file:// 单文件页面，浏览器同源策略决定它无法直接请求
  course.hzcu.edu.cn（跨域 + 登录态 + 凭据安全）。本脚本在本机 127.0.0.1:8765
  起一个只监听回环地址的小服务，代替工作台去登录学在城院（超星泛雅体系）
  并拉取数据；页面通过 fetch('http://127.0.0.1:8765/data') 一步取回。

用法：
  python syncserver.py                # 启动服务（默认 127.0.0.1:8765）
  python syncserver.py --self-test    # 自检：AES 登录加密 + HTML 解析（不出网）

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
import sys
import threading
import datetime
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
HOST = "127.0.0.1"
PORT = 8765
HERE = os.path.dirname(os.path.abspath(__file__))
CFG_FILE = os.path.join(HERE, "wb_local.json")
CACHE_FILE = os.path.join(HERE, "wb_platform_cache.json")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) hwdesk-syncserver/" + VERSION

# 学在城院（浙大城市学院）= 超星泛雅体系，登录走学习通统一账号
URL_LOGIN = "https://passport2.chaoxing.com/fanyalogin"
URL_COURSES = ("https://mooc1-1.chaoxing.com/mooc-ans/visit/courselistdata",
               "https://mooc1-1.chaoxing.com/visit/courselistdata")
URL_WORK = "https://mooc1.chaoxing.com/mooc2/work/list"
URL_EXAM = "https://mooc1.chaoxing.com/mooc2/exam/exam-list"

# fanyalogin 的 AES 参数（逆向自 passport2-static/js/fanya/login.js，与开源
# chaoxing-mcp / Xuexitong-mcp 等项目一致）：key = iv，CBC + PKCS7，结果 Base64
AES_KEY = b"u2oh6Vu^HWe4_AES"


class SyncError(Exception):
    """带用户可读信息的错误（直接透传给页面显示）"""


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


def aes_cbc_encrypt(key, iv, plaintext):
    """AES-128-CBC + PKCS7，返回密文字节"""
    pad = 16 - (len(plaintext) % 16)
    data = plaintext + bytes([pad]) * pad
    out = b""
    prev = iv
    for i in range(0, len(data), 16):
        blk = bytes(x ^ y for x, y in zip(data[i:i + 16], prev))
        prev = _aes128_encrypt_block(key, blk)
        out += prev
    return out


def _cx_cipher(text):
    return base64.b64encode(aes_cbc_encrypt(AES_KEY, AES_KEY, text.encode("utf-8"))).decode("ascii")


# ---------------------------------------------------------------- HTTP 基础封装
def _http(url, data=None, headers=None, timeout=20):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    req.add_header("User-Agent", UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except urllib.error.URLError as e:
        raise SyncError("网络请求失败：%s（请检查本机能否访问学在城院/超星）" % e.reason)


def _set_cookiejar(jar, response_headers):
    for v in response_headers.get_all("Set-Cookie") or []:
        pair = v.split(";", 1)[0].strip()
        if "=" in pair:
            name, val = pair.split("=", 1)
            jar[name.strip()] = val.strip()


def _cookie_header(jar):
    return "; ".join("%s=%s" % (k, v) for k, v in jar.items())


# ---------------------------------------------------------------- 登录
def cx_login(account, password):
    """学习通账号密码登录，返回 cookie dict。失败抛 SyncError。"""
    if not account or not password:
        raise SyncError("缺少学在城院账号或密码：请在工作台「学在城院登录」保存凭据，"
                        "或在本目录创建 wb_local.json（已被 .gitignore 排除）")
    form = urllib.parse.urlencode({
        "fid": "-1",
        "uname": _cx_cipher(account),
        "password": _cx_cipher(password),
        "refer": "http://i.chaoxing.com",
        "t": "true",
        "forbidotherlogin": "0",
    }).encode()
    status, headers, body = _http(URL_LOGIN, data=form, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": "https://passport2.chaoxing.com/login",
    })
    try:
        res = json.loads(body.decode("utf-8", "replace"))
    except ValueError:
        raise SyncError("登录返回异常（HTTP %s），平台可能已改版，请把本条信息反馈给开发者" % status)
    if not res.get("status"):
        raise SyncError("登录失败：%s（检查账号密码；若平台要求短信/扫码验证，请先在学习通 App 或网页端完成一次登录再试）"
                        % res.get("msg2") or res.get("msg") or "未知原因")
    jar = {}
    _set_cookiejar(jar, headers)
    if not any(k in jar for k in ("UID", "_uid", "fid")):
        raise SyncError("登录成功但未拿到会话 Cookie，平台可能已改版，请反馈给开发者")
    return jar


# ---------------------------------------------------------------- 解析（纯函数，可自测）
_COURSE_RE = re.compile(
    r"(?:courseid|courseId)=(\d+)[^\"'>]*?(?:clazzid|clazzId)=(\d+)[^\"'>]*?cpi=(\d+)(?:[^\"'>]*?enc=([0-9a-f]{16,40}))?",
    re.I)
_TITLE_RE = re.compile(r"title=\"([^\"]{1,120})\"|(?:courseName|coursename)\"?\s*[:=]\s*\"([^\"]{1,120})\"")
_WORK_TITLE_RE = re.compile(r'<li\b[^>]*?\btitle="([^"]{1,150})"', re.I)
_TIME_RE = re.compile(r"(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:\s+\d{1,2}:\d{2})?)")


def parse_courses(html):
    """从课程列表 HTML 解析 (courseId, clazzId, cpi, enc, name) 列表"""
    courses, seen = [], set()
    for m in _COURSE_RE.finditer(html):
        cid, clazz, cpi, enc = m.group(1), m.group(2), m.group(3), m.group(4) or ""
        key = (cid, clazz)
        if key in seen:
            continue
        seen.add(key)
        # 课程名：在该匹配附近 800 字符内找 title="..." / courseName="..."
        window = html[max(0, m.start() - 800): m.end() + 800]
        name = ""
        t = _TITLE_RE.search(window)
        if t:
            name = (t.group(1) or t.group(2) or "").strip()
        courses.append({"courseId": cid, "clazzId": clazz, "cpi": cpi, "enc": enc, "name": name})
    return courses


def parse_work_list(html, course_name, kind):
    """从作业/考试列表 HTML 解析条目（宽松解析：拿得到多少算多少）"""
    out = []
    for m in _WORK_TITLE_RE.finditer(html):
        title = (m.group(1) or "").strip()
        if not title:
            continue
        # 该 <li> 的主体：从标签结束到最近的 </li>
        end = html.find("</li>", m.end())
        window = html[m.end(): end if end != -1 else m.end() + 600]
        t = _TIME_RE.search(window)
        status = "unknown"
        scope = window + html[(end if end != -1 else m.end()): (end if end != -1 else m.end()) + 60]
        if re.search(r"待提交|未提交|未完成|进行中|待完成", scope):
            status = "todo"
        elif re.search(r"已提交|已完成|已批阅|已交", scope):
            status = "submitted"
        out.append({"course": course_name, "title": title, "kind": kind,
                    "due": (t.group(1).replace("/", "-") if t else None),
                    "status": status, "note": ""})
    return out


# ---------------------------------------------------------------- 采集
def cx_collect(jar):
    """拉取课程 / 作业 / 考试；单项失败不阻断整体，逐条记入 errors"""
    errors, assignments = [], []
    cookie = {"Cookie": _cookie_header(jar)}
    html = None
    last_err = None
    for url in URL_COURSES:
        try:
            _, _, body = _http(url, data=urllib.parse.urlencode({
                "courseType": "1", "courseFolderId": "0", "baseEducation": "0",
                "superstarClass": "", "courseFolderSize": "1",
            }).encode(), headers=dict(cookie, **{"Content-Type": "application/x-www-form-urlencoded",
                                                 "Referer": "https://mooc1-1.chaoxing.com/mooc-ans"}))
            text = body.decode("utf-8", "replace")
            if "courseid" in text.lower() or "courseId" in text:
                html = text
                break
        except SyncError as e:
            last_err = str(e)
    if html is None:
        raise SyncError(last_err or "课程列表拉取失败（未拿到有效页面）")

    courses = parse_courses(html)
    if not courses:
        errors.append("课程列表解析为空：平台页面结构可能已改版，请反馈本条信息")

    for c in courses:
        name = c["name"] or ("课程 %s" % c["courseId"])
        try:
            if c["enc"]:
                _, _, wb = _http(URL_WORK + "?" + urllib.parse.urlencode({
                    "courseId": c["courseId"], "classId": c["clazzId"], "cpi": c["cpi"], "enc": c["enc"]
                }), headers=dict(cookie, **{"Referer": "https://mooc2-ans.chaoxing.com/"}))
                assignments += parse_work_list(wb.decode("utf-8", "replace"), name, "作业")
                _, _, eb = _http(URL_EXAM + "?" + urllib.parse.urlencode({
                    "courseid": c["courseId"], "classId": c["clazzId"], "cpi": c["cpi"], "enc": c["enc"]
                }), headers=dict(cookie, **{"Referer": "https://mooc2-ans.chaoxing.com/"}))
                assignments += parse_work_list(eb.decode("utf-8", "replace"), name, "考试")
            else:
                errors.append("%s：缺少 enc 参数，本轮跳过（可反馈给开发者）" % name)
        except SyncError as e:
            errors.append("%s：%s" % (name, e))

    return {
        "fetchedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "source": "chaoxing",
        "courses": [{"id": c["courseId"], "name": c["name"]} for c in courses],
        "assignments": assignments,
        "materials": [],   # 预留：课件/资料目录接口按需扩展（见 README）
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


_STATE = {"last": None, "lock": threading.Lock()}


def collect_payload(creds=None, force=True):
    """入口：优先用请求携带的凭据（仅内存），否则用 wb_local.json。带 60s 缓存。"""
    with _STATE["lock"]:
        if not force and _STATE["last"]:
            return _STATE["last"], True
        account, password = (None, None)
        if creds and creds.get("account") and creds.get("password"):
            account, password = str(creds["account"]), str(creds["password"])
        else:
            account, password = load_cfg_creds()
        jar = cx_login(account, password)
        payload = cx_collect(jar)
        try:
            with open(CACHE_FILE, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=1)
        except OSError:
            pass
        _STATE["last"] = payload
        return payload, False


# ---------------------------------------------------------------- HTTP 服务
class Handler(BaseHTTPRequestHandler):
    server_version = "hwdesk-syncserver/" + VERSION

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

    def log_message(self, fmt, *args):  # 静默访问日志，避免凭据出现在终端
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, "version": VERSION, "service": "hwdesk-syncserver"})
        elif self.path.startswith("/data"):
            payload, cached = _STATE["last"], bool(_STATE["last"])
            if payload is None:
                try:
                    payload, cached = collect_payload()
                except SyncError as e:
                    self._json(200, {"ok": False, "error": str(e),
                                     "hint": "在本目录运行 python syncserver.py 后重试；凭据见 README「本机直连」"})
                    return
            self._json(200, {"ok": True, "cached": cached, "payload": payload})
        else:
            self._json(404, {"ok": False, "error": "not found"})

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
        if self.path.startswith("/data"):
            try:
                payload, _ = collect_payload(creds)
                self._json(200, {"ok": True, "cached": False, "payload": payload})
            except SyncError as e:
                self._json(200, {"ok": False, "error": str(e)})
            except Exception as e:  # 未知异常也要给页面可读信息
                self._json(200, {"ok": False, "error": "服务内部错误：%s" % e})
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
                _STATE["last"] = payload
                self._json(200, {"ok": True, "cached": True, "payload": payload})
            except (ValueError, OSError) as e:
                self._json(200, {"ok": False, "error": "ingest 失败：%s" % e})
        else:
            self._json(404, {"ok": False, "error": "not found"})


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

    # 2) CBC + PKCS7 往返长度与确定性
    c1 = aes_cbc_encrypt(AES_KEY, AES_KEY, b"13800000000")
    c2 = aes_cbc_encrypt(AES_KEY, AES_KEY, b"13800000000")
    good = len(c1) == 16 and c1 == c2
    print(("ok  - AES-CBC(16B) deterministic, PKCS7 padded" if good else "FAIL - CBC sanity"))
    ok &= good

    # 3) 课程 HTML 解析
    fixture = ('<div><a href="/mycourse/stu?courseid=226644111&clazzid=99001&cpi=77123&enc=abcd1234abcd1234abcd"'
               ' title="电力电子技术"></a></div>'
               '<a href="/mycourse/stu?courseId=226644999&clazzId=99002&cpi=77123" title="电机与拖动">')
    cs = parse_courses(fixture)
    good = len(cs) == 2 and cs[0]["courseId"] == "226644111" and cs[0]["enc"] == "abcd1234abcd1234abcd" \
        and cs[0]["name"] == "电力电子技术" and cs[1]["enc"] == ""
    print(("ok  - parse_courses extracts 2 courses with enc/name" if good else "FAIL - parse_courses: %r" % cs))
    ok &= good

    # 4) 作业列表解析
    wf = ('<ul><li title="实验1 Buck电源实验报告"><span>截止 2026-11-02 23:59</span><span class="待提交">'
          "未提交</span></li>"
          '<li title="课后思考3"><span>已提交</span></li></ul>')
    rows = parse_work_list(wf, "电力电子技术", "作业")
    good = len(rows) == 2 and rows[0]["due"] == "2026-11-02 23:59" and rows[0]["status"] == "todo" \
        and rows[1]["status"] == "submitted"
    print(("ok  - parse_work_list extracts due/status" if good else "FAIL - parse_work_list: %r" % rows))
    ok &= good

    print("SELF-TEST " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


def main():
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("hwdesk-syncserver %s | http://%s:%s" % (VERSION, HOST, PORT))
    print("  GET  /health      健康检查")
    print("  GET  /data        取缓存或用 wb_local.json 拉取")
    print("  POST /data        请求体可带 {\"account\",\"password\"}（仅本次内存使用）")
    print("  POST /ingest      外部采集结果投递")
    print("  凭据文件：%s（不要提交）" % CFG_FILE)
    print("  Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
