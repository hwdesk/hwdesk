' hwdesk online launcher (ASCII only) - v2, isolated clean profile
' Opens the PUBLISHED workbench in a dedicated Chrome profile with:
'   - separate user-data-dir  -> no extensions / stale settings from the daily profile
'   - --proxy-server=direct:// -> bypasses any broken proxy config (Issue #45 diagnosis)
' 1) starts local bridge syncserver.py (for login gate / local data fetch)
' 2) opens the published workbench in Chrome app mode
Option Explicit
Dim fso, sh, repo, py, bridge, url, chrome, profile, lnk, desk, sc

repo     = "F:\hwdesk"
py       = "C:\Users\liyuanyang\.local\bin\python3.12.exe"
bridge   = repo & "\syncserver.py"
url      = "https://hwdesk-workbench-95242.app.workbuddy.host/?sharecode=COAVIMSN3Z"
chrome   = "C:\Program Files\Google\Chrome\Application\chrome.exe"
profile  = repo & "\.chrome-hwdesk-profile"

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"

sh.CurrentDirectory = repo

' start the local bridge (minimized) so login gate / local fetch keeps working
If fso.FileExists(py) And fso.FileExists(bridge) Then
  sh.Run """" & py & """ """ & bridge & """", 7, False
  WScript.Sleep 1800
End If

' open the published workbench in an isolated clean profile, direct network
sh.Run """" & chrome & """ --app=""" & url & """" & _
       " --user-data-dir=""" & profile & """" & _
       " --proxy-server=direct:// --proxy-bypass-list=""<-loopback>""" & _
       " --no-first-run --no-default-browser-check", 1, False

' create a desktop shortcut "hwdesk online" on first run
desk = sh.SpecialFolders("Desktop")
lnk  = desk & "\hwdesk online.lnk"
If Not fso.FileExists(lnk) Then
  Set sc = sh.CreateShortcut(lnk)
  sc.TargetPath = "wscript.exe"
  sc.Arguments = """" & WScript.ScriptFullName & """"
  sc.WorkingDirectory = repo
  sc.IconLocation = chrome & ",0"
  sc.Description = "hwdesk workbench (isolated clean profile, direct network)"
  sc.Save
End If
