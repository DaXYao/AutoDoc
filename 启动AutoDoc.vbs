' AutoDoc quick launcher - double-click to start (hidden console).
' Starts "docgen serve" in hub mode and opens the browser to the project picker.
Option Explicit
Dim fso, shell, root
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
' Repo root = folder containing this script
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root
' 0 = hidden window, False = do not wait for exit
shell.Run "node packages\server\dist\cli.js serve --open --port 7788", 0, False
Set shell = Nothing
Set fso = Nothing
