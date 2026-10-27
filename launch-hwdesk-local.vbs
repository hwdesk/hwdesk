' hwdesk local launcher (ASCII only) - issue #70
' One double-click = zero-config chat:
'   1) probe http://127.0.0.1:8765/health ; if the local bridge is not running, start
'      syncserver.py minimized (AI proxy /v1 + course bridge) and wait until ready
'   2) open the LOCAL workbench html (same folder, largest *.html) in Chrome/Edge
'      app mode with direct network (bypasses broken system proxies)
'   3) first run: create a "hwdesk" desktop shortcut
' The page itself picks the best AI layer automatically (proxy -> CloudAI -> local keys).
Option Explicit
Dim fso, sh, repo, pyCmd, bridge, pagePath, url, chrome, profile, lnk, desk, sc
Dim http, ready, i, largest, f, folder

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

repo = fso.GetParentFolderName(WScript.ScriptFullName)
If repo = "" Then repo = sh.CurrentDirectory
bridge   = repo & "\syncserver.py"
profile  = repo & "\.chrome-hwdesk-profile"

' ---- pick the workbench page: the largest *.html in this folder (single-file app) ----
Set folder = fso.GetFolder(repo)
largest = ""
For Each f In folder.Files
  If LCase(fso.GetExtensionName(f.Name)) = "html" And LCase(f.Name) <> "index.html" Then
    If largest = "" Or f.Size > fso.GetFile(repo & "\" & largest).Size Then largest = f.Name
  End If
Next
If largest = "" Then
  MsgBox "workbench html not found next to launch-hwdesk-local.vbs", 16, "hwdesk"
  WScript.Quit 1
End If
pagePath = repo & "\" & largest
url = "file:///" & Replace(Replace(pagePath, "\", "/"), " ", "%20")

' ---- python: py launcher, then any python on PATH ----
If fso.FileExists(sh.SystemFolder & "\py.exe") Then
  pyCmd = """" & sh.SystemFolder & "\py.exe" & """ -3"
ElseIf sh.Run("cmd /c where python >nul 2>nul", 0, True) = 0 Then
  pyCmd = "python"
Else
  pyCmd = ""
End If

' ---- probe the local bridge; start it if not running ----
ready = False
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.open "GET", "http://127.0.0.1:8765/health", False
http.setRequestHeader "Cache-Control", "no-cache"
http.send
ready = (Err.Number = 0 And http.status = 200)
On Error GoTo 0

If Not ready And pyCmd <> "" And fso.FileExists(bridge) Then
  sh.CurrentDirectory = repo
  sh.Run pyCmd & " """ & bridge & """", 7, False   ' minimized window
End If

' ---- wait until /health answers (max ~8s) ----
For i = 1 To 16
  If ready Then Exit For
  WScript.Sleep 500
  On Error Resume Next
  http.open "GET", "http://127.0.0.1:8765/health", False
  http.setRequestHeader "Cache-Control", "no-cache"
  http.send
  ready = (Err.Number = 0 And http.status = 200)
  On Error GoTo 0
Next

' ---- open the local workbench in app mode, direct network ----
chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"

sh.CurrentDirectory = repo
sh.Run """" & chrome & """ --app=""" & url & """" & _
       " --user-data-dir=""" & profile & """" & _
       " --proxy-server=direct:// --proxy-bypass-list=""<-loopback>""" & _
       " --no-first-run --no-default-browser-check", 1, False

' ---- first run: desktop shortcut "hwdesk" ----
desk = sh.SpecialFolders("Desktop")
lnk = desk & "\hwdesk.lnk"
If Not fso.FileExists(lnk) Then
  Set sc = sh.CreateShortcut(lnk)
  sc.TargetPath = "wscript.exe"
  sc.Arguments = """" & WScript.ScriptFullName & """"
  sc.WorkingDirectory = repo
  sc.IconLocation = chrome & ",0"
  sc.Description = "hwdesk workbench (local mode, auto-starts the AI bridge)"
  sc.Save
End If
