import subprocess, os
chrome = os.path.join(os.environ["LOCALAPPDATA"], r"Google\Chrome\Application\chrome.exe")
url = "file:///C:/Users/feng/hwdesk/%E4%BD%9C%E4%B8%9A%E6%8F%90%E4%BA%A4%E5%B7%A5%E4%BD%9C%E5%8F%B0.html"
subprocess.Popen([chrome, "--app=" + url])
print("launched")
