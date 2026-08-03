Set objShell = CreateObject("WScript.Shell")
objShell.Run "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\D\opt\agents-to-im\start-codex.ps1""", 0, False
