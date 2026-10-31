' hwdesk online launcher (ASCII only) - v3, no machine-specific paths
' Opens the PUBLISHED workbench in a dedicated Chrome profile with:
'   - separate user-data-dir  -> no extensions / stale settings from the daily profile
'   - --proxy-server=direct:// -> bypasses any broken proxy config (Issue #45 diagnosis)
' 1) starts local bridge syncserver.py (for login gate / local data fetch)
' 2) opens the published workbench in Chrome app mode
Option Explicit

' BestPy: within <folderPath>'s subfolders, pick the one with the highest version
' number that contains <exeName>; returns the full path or "" (missing folder safe).
Function BestPy(folderPath, exeName)
  Dim f, subf, best, bestKey, k
  best = "" : bestKey = -1
  Set subf = Nothing
  On Error Resume Next
  Set subf = fso.GetFolder(folderPath)
  On Error GoTo 0
  If subf Is Nothing Then Exit Function
  For Each f In subf.SubFolders
    If fso.FileExists(f.Path & "\" & exeName) Then
      k = VerKey(f.Name)
      If k > bestKey Then bestKey = k : best = f.Path & "\" & exeName
    End If
  Next
  BestPy = best
End Function
' VerKey: digits of a name as a number ("3.13.12" -> 31312, "Python313" -> 313)
Function VerKey(nm)
  Dim r, s
  s = ""
  For r = 1 To Len(nm)
    If Mid(nm, r, 1) >= "0" And Mid(nm, r, 1) <= "9" Then s = s & Mid(nm, r, 1)
  Next
  If s = "" Then VerKey = 0 Else VerKey = CLng(Left(s, 9))
End Function

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
' ---- location probes: app-managed / per-user pythons that are NOT on PATH ----
' wscript only sees the user PATH; pythons installed per-user or managed by apps
' (WorkBuddy-managed runtime, per-user Python, Anaconda) are invisible to
' `where python`. The bridge MUST start, so probe known locations explicitly,
' preferring windowless pythonw.exe. Highest version number wins per location.
If pyWinCmd = "" Then
  pywPath = BestPy(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\Python"), "pythonw.exe")
  If pywPath = "" Then pywPath = BestPy(sh.ExpandEnvironmentStrings("%USERPROFILE%\.workbuddy\binaries\python\versions"), "pythonw.exe")
  If pywPath = "" And fso.FileExists(sh.ExpandEnvironmentStrings("%USERPROFILE%\anaconda3\pythonw.exe")) Then pywPath = sh.ExpandEnvironmentStrings("%USERPROFILE%\anaconda3\pythonw.exe")
  If pywPath = "" And fso.FileExists(sh.ExpandEnvironmentStrings("%USERPROFILE%\miniconda3\pythonw.exe")) Then pywPath = sh.ExpandEnvironmentStrings("%USERPROFILE%\miniconda3\pythonw.exe")
  If pywPath = "" And fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramData%\Anaconda3\pythonw.exe")) Then pywPath = sh.ExpandEnvironmentStrings("%ProgramData%\Anaconda3\pythonw.exe")
  If pywPath <> "" Then pyWinCmd = """" & pywPath & """"
End If
If pyCmd = "" Then
  firstLine = BestPy(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\Python"), "python.exe")
  If firstLine = "" Then firstLine = BestPy(sh.ExpandEnvironmentStrings("%USERPROFILE%\.workbuddy\binaries\python\versions"), "python.exe")
  If firstLine = "" And fso.FileExists(sh.ExpandEnvironmentStrings("%USERPROFILE%\anaconda3\python.exe")) Then firstLine = sh.ExpandEnvironmentStrings("%USERPROFILE%\anaconda3\python.exe")
  If firstLine <> "" Then pyCmd = """" & firstLine & """"
End If
bridgeCmd = pyWinCmd
If bridgeCmd = "" Then bridgeCmd = pyCmd

If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
If Not fso.FileExists(chrome) Then chrome = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"

sh.CurrentDirectory = repo

' ---- keep this machine on the default gateway: neutralize local system proxy ----
' Same policy as the local launcher: if the system proxy is ON and points at a
' loopback port (Clash/mihomo style), switch the system back to direct (default
' gateway). Non-local / corporate proxies and PAC are left untouched.
Dim proxyOn, proxyAddr
On Error Resume Next
proxyOn = sh.RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyEnable")
proxyAddr = sh.RegRead("HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyServer")
On Error GoTo 0
If proxyOn = 1 And VarType(proxyAddr) = vbString _
   And InStr(LCase(proxyAddr & ""), "127.0.0.1") > 0 Then
  sh.RegWrite "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyEnable", 0, "REG_DWORD"
End If

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
