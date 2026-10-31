# -*- coding: utf-8 -*-
"""open.py — 以 Chrome/Edge 应用模式打开同目录工作台（脚本相对定位，无机器硬编码）。
推荐入口是 launch-hwdesk-local.vbs（会先自动拉起本机 AI 代理）；本脚本仅作轻量兜底。"""
import os, subprocess, glob, sys

here = os.path.dirname(os.path.abspath(__file__))
htmls = [p for p in glob.glob(os.path.join(here, "*.html"))
         if os.path.basename(p) != "index.html"]
if not htmls:
    sys.exit("no workbench html found next to open.py")
page = max(htmls, key=os.path.getsize)   # 工作台是目录里最大的 html（单文件内联全部资源）

chrome = os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe")
if not os.path.exists(chrome):
    for c in (r"C://Program Files//Google//Chrome//Application//chrome.exe",
              r"C://Program Files (x86)//Microsoft//Edge//Application//msedge.exe",
              r"C://Program Files//Microsoft//Edge//Application//msedge.exe"):
        if os.path.exists(c):
            chrome = c
            break

url = "file:///" + page.replace("\\", "/").replace(" ", "%20")
subprocess.Popen([chrome, "--app=" + url])
print("launched:", os.path.basename(page))
