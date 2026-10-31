' hwdesk online launcher (ASCII only) - v3, no machine-specific paths
' Opens the PUBLISHED workbench in a dedicated Chrome profile with:
'   - separate user-data-dir  -> no extensions / stale settings from the daily profile
'   - --proxy-server=direct:// -> bypasses any broken proxy config (Issue #45 diagnosis)
' 1) starts local bridge syncserver.py (for login gate / local data fetch)
' 2) opens the published workbench in Chrome app mode
Option Explicit
Dim fso, sh, repo, pyCmd, bridge, url, chrome, profile, lnk, desk, sc

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

' repo = the folder this script lives in
repo = fso.GetParentFolderName(WScript.ScriptFullName)
If repo = "" Then repo = sh.CurrentDirectory
bridge   = repo & "\syncserver.py"
url      = "https://hwdesk-workbench-95242.app.workbuddy.host/?sharecode=COAVIMSN3Z"
chrome   = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
profile  = repo & "\.chrome-hwdesk-profile"

' python for the bridge: windowless first (pyw/pythonw -> zero extra windows),
' console python as hidden fallback; skip the bridge if neither exists
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

If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"

sh.CurrentDirectory = repo

' start the local bridge (hidden: pythonw has no window; console python is hidden too)
If bridgeCmd <> "" And fso.FileExists(bridge) Then
  sh.Run bridgeCmd & " """ & bridge & """", 0, False
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
  sc.TargetPath = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
  sc.Arguments = """" & WScript.ScriptFullName & """"
  sc.WorkingDirectory = repo
  sc.IconLocation = chrome & ",0"
  sc.Description = "hwdesk workbench (isolated clean profile, direct network)"
  sc.Save
End If
