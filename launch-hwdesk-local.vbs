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

' ---- python for the bridge: windowless first, console as hidden fallback ----
' pyw.exe / pythonw.exe run the bridge with NO window at all: the workbench
' window is the only thing the user ever sees. Console python stays as a
' fallback and is started hidden (style 0), so nothing else pops on screen.
Dim pyWinCmd, ex, pyLines, firstLine, pywPath, bridgeCmd
pyCmd = ""
pyWinCmd = ""
If fso.FileExists(sh.SystemFolder & "\pyw.exe") Then
  pyWinCmd = """" & sh.SystemFolder & "\pyw.exe" & """ -3"
End If
pyLines = ""
On Error Resume Next
Set ex = sh.Exec("cmd /c where python")
pyLines = ex.StdOut.ReadAll()
On Error GoTo 0
If pyLines <> "" Then
  firstLine = Trim(Split(Replace(pyLines, vbCr, ""), vbLf)(0))
  If firstLine <> "" Then
    If pyCmd = "" And fso.FileExists(firstLine) Then pyCmd = """" & firstLine & """"
    pywPath = Replace(firstLine, "python.exe", "pythonw.exe", 1, -1, vbTextCompare)
    If pyWinCmd = "" And pywPath <> firstLine And fso.FileExists(pywPath) Then
      pyWinCmd = """" & pywPath & """"
    End If
  End If
End If
If pyWinCmd = "" And pyCmd = "" And fso.FileExists(sh.SystemFolder & "\py.exe") Then
  pyCmd = """" & sh.SystemFolder & "\py.exe" & """ -3"
End If
bridgeCmd = pyWinCmd
If bridgeCmd = "" Then bridgeCmd = pyCmd

' ---- keep this machine on the default gateway: neutralize local system proxy ----
' The workbench stack is already direct (Chrome --proxy-server=direct://,
' syncserver ProxyHandler({})), but a Clash-style system proxy switched on later
' still hijacks every other page / app. Policy (user decision 2026-10-31): if the
' system proxy is ON and points at a loopback port (Clash/mihomo style), switch
' the system back to direct (default gateway). Non-local / corporate proxies and
' PAC are left untouched.
Dim proxyOn, proxyAddr
On Error Resume Next
proxyOn = sh.RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyEnable")
proxyAddr = sh.RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyServer")
On Error GoTo 0
If proxyOn = 1 And VarType(proxyAddr) = vbString _
   And InStr(LCase(proxyAddr & ""), "127.0.0.1") > 0 Then
  sh.RegWrite "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyEnable", 0, "REG_DWORD"
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

If Not ready And bridgeCmd <> "" And fso.FileExists(bridge) Then
  sh.CurrentDirectory = repo
  sh.Run bridgeCmd & " """ & bridge & """", 0, False   ' hidden: pythonw has no window; console python is hidden too
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
chrome = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
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
  sc.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
  sc.Arguments = """" & WScript.ScriptFullName & """"
  sc.WorkingDirectory = repo
  sc.IconLocation = chrome & ",0"
  sc.Description = "hwdesk workbench (local mode, auto-starts the AI bridge)"
  sc.Save
End If

' ---- upgrade legacy desktop shortcuts that open the workbench html directly ----
' Older setups (make_lnk.py) put Chrome --app="file:///...html" on the desktop:
' those skip the local bridge, so login gate / data fetch fail and the user has
' to start files one by one. Repoint any such shortcut to THIS launcher so one
' double-click boots bridge + page together. Idempotent: our own shortcuts
' (wscript.exe + a .vbs argument) never match the --app=/.html filter.
Dim dskFolder, scOld, isLegacy, iconPath
Set dskFolder = fso.GetFolder(desk)
For Each f In dskFolder.Files
  If LCase(fso.GetExtensionName(f.Name)) = "lnk" Then
    isLegacy = False
    On Error Resume Next
    Set scOld = sh.CreateShortcut(dskFolder.Path & "\" & f.Name)
    If Err.Number = 0 Then
      isLegacy = (InStr(LCase(scOld.Arguments), "--app=") > 0 _
        And InStr(LCase(scOld.Arguments), ".html") > 0)
    End If
    On Error GoTo 0
    If isLegacy Then
      iconPath = repo & "\hwdesk.ico,0"
      If Not fso.FileExists(repo & "\hwdesk.ico") Then iconPath = chrome & ",0"
      scOld.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
      scOld.Arguments = """" & WScript.ScriptFullName & """"
      scOld.WorkingDirectory = repo
      scOld.IconLocation = iconPath
      scOld.Description = "hwdesk workbench (one click: auto-starts the local bridge + opens the page)"
      scOld.Save
    End If
  End If
Next
