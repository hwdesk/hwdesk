#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""syncserver.py 2.0.0 | hwdesk 学在城院本机直连桥（纯标准库，零第三方依赖）

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
import sys
import threading
import datetime
import http.cookiejar
import html as html_lib
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "2.2.0"
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
URL_CAS = "https://ca.hzcu.edu.cn"                 # 学校统一身份认证账密表单

# ca.hzcu.edu.cn 账密登录的 AES 参数（逆向自登录页内联脚本 submitForm('0')：
# CryptoJS.AES.encrypt(psw, "c6dda3852e2d4be2", {mode: ECB, padding: Pkcs7}).toString()）
CAS_AES_KEY = b"c6dda3852e2d4be2"

# Tronclass 待办类型 → 中文（与学在浙大一致）
TYPE_CN = {"homework": "作业", "exam": "考试", "quiz": "测验", "survey": "问卷"}


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


# ---------------------------------------------------------------- HTTP 会话
class Session:
    """带 CookieJar 的 urllib 会话（跨 courses/identity/ca 三个域自动带 cookie）。
    强制直连：校园 CAS / Tronclass 都在国内，系统代理（Clash 等）只会把请求带进 502。"""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
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
            raise SyncError("网络请求失败：%s（请检查本机能否访问 courses.hzcu.edu.cn）" % e.reason)


def _resp_text(resp, body):
    status = getattr(resp, "status", None) or getattr(resp, "code", 0)
    return status, body.decode("utf-8", "replace")


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
    post_url = urllib.parse.urljoin(getattr(resp, "url", URL_CAS + "/cas/login"), form_info["action"])
    resp2, body2 = s.open(post_url, data=form, headers={
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": getattr(resp, "url", URL_CAS),
        "Origin": URL_CAS,
    })
    status2, text2 = _resp_text(resp2, body2)

    # 3) 成功：最终应回到课程端并返回 JSON；失败：仍是 CAS 登录页
    if is_cas_login_page(text2, getattr(resp2, "url", "")):
        err = parse_cas_error(text2)
        raise SyncError("统一身份认证登录失败：%s（检查账号密码；多次失败后平台可能要求验证码，"
                        "请到 course.hzcu.edu.cn 网页端正常登录一次后再试）" % (err or "账号或密码错误"))
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
    """/api/courses/{id}/homework-activities 条目 → payload.assignments 条目"""
    if hw.get("submitted"):
        status = "submitted"
    elif hw.get("is_closed"):
        status = "unknown"   # 已截止未提交：平台不再接受，标记未知由页面归档
    else:
        status = "todo"
    note = "进行中" if hw.get("is_in_progress") else ""
    return {
        "course": str(course_name or "").strip() or "通用",
        "title": str(hw.get("title") or "").strip(),
        "kind": _type_cn(hw.get("type")),
        "due": to_bj_time(hw.get("end_time") or hw.get("deadline")),
        "status": status,
        "note": note,
    }


def course_to_entry(c):
    """/api/my-courses 的 courses 条目 → payload.courses 条目"""
    return {"id": str(c.get("id") or "").strip(), "name": str(c.get("name") or "").strip()}


# ---------------------------------------------------------------- 课件（资料目录）采集
MATERIALS_MAX = 400   # 单课程课件条目上限（接口异常返回超大列表时防爆炸）
FOLDERS_MAX = 20      # 资料目录一级展开上限


def _strip_html(text, limit=200):
    """HTML 片段 → 纯文本摘要（课件描述 / 作业要求共用，#57）
    去 tag → 反转义 → 空白压成单空格 → 删除与中文相邻的空格（换行断词残留）"""
    t = re.sub(r"<[^>]+>", " ", str(text or ""))
    t = html_lib.unescape(t)
    t = re.sub(r"\s+", " ", t).strip()
    return re.sub(r" ?([\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]) ?", r"\1", t)[:limit]


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
        todos = api_json(s, "/api/todos?no-intercept=true").get("todo_list") or []
        for t in todos:
            if isinstance(t, dict):
                put(todo_to_assignment(t))
    except SessionLost:
        raise
    except SyncError as e:
        errors.append("待办列表：%s" % e)

    for c in courses:
        cid = str(c.get("id") or "").strip()
        cname = str(c.get("name") or "").strip() or str(c.get("course_code") or "").strip() \
            or ("课程 " + cid)
        if not cid:
            continue
        try:
            hws = paged(s, "/api/courses/%s/homework-activities" % cid, "homework_activities")
            for hw in hws:
                if isinstance(hw, dict):
                    put(hw_to_assignment(hw, cname))
        except SessionLost:
            raise
        except SyncError as e:
            errors.append("%s：%s" % (cname, e))
        # 课件（资料目录）：与作业采集相互独立，任一失败只记 errors（#57）
        materials.extend(collect_course_materials(s, cid, cname, errors))

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


_STATE = {"last": None, "lock": threading.Lock()}


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
    """入口：优先用请求携带的凭据（仅内存），否则用 wb_local.json。带缓存。"""
    with _STATE["lock"]:
        if not force and _STATE["last"]:
            return _STATE["last"], True
        account, password = None, None
        if creds and creds.get("account") and creds.get("password"):
            account, password = str(creds["account"]), str(creds["password"])
        else:
            account, password = load_cfg_creds()
        s = hzcu_login(account, password)
        try:
            payload = hzcu_collect(s)
        except SessionLost:
            # 采集中途登录态失效：重登一次再拉
            s = hzcu_login(account, password)
            payload = hzcu_collect(s)
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
            self._json(200, {"ok": True, "version": VERSION, "service": "hwdesk-syncserver",
                             "platform": "学在城院 courses.hzcu.edu.cn (Tronclass)"})
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

    # 5) 待办映射：UTC → 北京时间 +8，类型映射
    row = todo_to_assignment({"course_name": "电力电子技术", "title": "实验1报告",
                           "type": "homework", "end_time": "2026-11-01T15:59:59.000Z"})
    good = row["course"] == "电力电子技术" and row["title"] == "实验1报告" and \
        row["kind"] == "作业" and row["due"] == "2026-11-01 23:59" and row["status"] == "todo"
    print(("ok  - todo_to_assignment maps fields & UTC+8 due" if good
           else "FAIL - todo_to_assignment: %r" % row))
    ok &= good

    # 6) 作业映射：已提交/已截止/进行中三种状态
    r1 = hw_to_assignment({"title": "作业A", "type": "homework", "submitted": True,
                        "end_time": "2026-10-01T01:00:00.000Z"}, "课程X")
    r2 = hw_to_assignment({"title": "作业B", "type": "exam", "submitted": False,
                        "is_closed": True, "end_time": ""}, "课程X")
    r3 = hw_to_assignment({"title": "作业C", "type": "quiz", "submitted": False,
                        "is_in_progress": True, "deadline": "2026-12-31 12:00"}, "课程X")
    good = r1["status"] == "submitted" and r1["due"] == "2026-10-01 09:00" and \
        r2["status"] == "unknown" and r2["kind"] == "考试" and \
        r3["status"] == "todo" and r3["due"] == "2026-12-31 12:00" and r3["note"] == "进行中"
    print(("ok  - hw_to_assignment maps submitted/closed/in-progress" if good
           else "FAIL - hw_to_assignment: %r %r %r" % (r1, r2, r3)))
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
    print("  凭据文件：%s（不要提交）" % CFG_FILE)
    print("  Ctrl+C 退出")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
