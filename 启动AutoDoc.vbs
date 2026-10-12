' AutoDoc quick launcher - double-click to start.
' 先构建最新代码，再以 hub 模式启动 "docgen serve" 并打开浏览器到项目选择页。
' 窗口保持可见：可看到构建进度与服务日志；关闭该窗口即停止服务。
' （改为先 build 再 serve，确保启动的永远是当前代码，不再出现"启动了旧版 dist"的问题。）
Option Explicit
Dim fso, shell, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
' Repo root = folder containing this script
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
' 1 = 可见常规窗口, False = 不等待退出
shell.Run "cmd /c ""pnpm build && node packages\server\dist\cli.js serve --open --port 7788""", 1, False
Set shell = Nothing
Set fso = Nothing
