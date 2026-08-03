@echo off
rem Claude Code CLI wrapper for agents-to-im
rem Invokes Claude Code Haha's bundled CLI (NOT the desktop app)
setlocal
set HOME=C:\Users\oadan
set USERPROFILE=C:\Users\oadan
set APPDATA=C:\Users\oadan\AppData\Roaming
set CLAUDE_HOME=C:\Users\oadan\.claude
rem Point to Claude Code Haha resources directory for the actual CLI binary
set SIDEKAR_DIR=C:\Program Files\Claude Code Haha\resources\app.asar.unpacked\src-tauri\binaries
rem Allow access to key directories
set PATH=C:\Users\oadan\AppData\Local\Microsoft\WinGet\Links;%PATH%
"C:\Program Files\Claude Code Haha\resources\app.asar.unpacked\src-tauri\binaries\claude-sidecar-x86_64-pc-windows-msvc.exe" cli %*