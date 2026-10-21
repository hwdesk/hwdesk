# -*- coding: utf-8 -*-
"""用 WScript.Shell COM 重建桌面快捷方式"""
import os
import win32com.client

ws = win32com.client.Dispatch("WScript.Shell")
desktop = os.path.join(os.environ["USERPROFILE"], "Desktop")
chrome = os.path.join(os.environ["LOCALAPPDATA"], r"Google\Chrome\Application\chrome.exe")
url = "file:///C:/Users/feng/hwdesk/%E4%BD%9C%E4%B8%9A%E6%8F%90%E4%BA%A4%E5%B7%A5%E4%BD%9C%E5%8F%B0.html"
p = os.path.join(desktop, "作业提交工作台.lnk")
if os.path.exists(p):
    os.remove(p)
lnk = ws.CreateShortCut(p)
lnk.TargetPath = chrome
lnk.Arguments = '--app="%s"' % url
lnk.IconLocation = r"C:\Users\feng\hwdesk\hwdesk.ico,0"
lnk.WorkingDirectory = os.path.dirname(chrome)
lnk.Save()
print("created", p, os.path.exists(p), os.path.getsize(p))
