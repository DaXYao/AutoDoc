import { execFile } from 'node:child_process'

/**
 * 调用操作系统原生「选择文件夹」对话框，返回用户选中的绝对路径；
 * 取消或环境不支持（非 Windows / 无 WinForms）时返回 null。
 *
 * 浏览器出于安全无法从文件夹选择器拿到本地绝对路径，因此由本地服务端代为弹窗。
 * 实现借助系统自带 PowerShell + WinForms FolderBrowserDialog，不引入任何新依赖。
 */

const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = 'Select project root folder'
$dlg.ShowNewFolderButton = $false
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dlg.SelectedPath
}
`

/** 弹出文件夹选择对话框；超时或失败返回 null（前端回退为手动输入） */
export function pickFolder(timeoutMs = 120_000): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve(null)
      return
    }
    execFile(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', PS_SCRIPT],
      { timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) {
          resolve(null)
          return
        }
        const lines = stdout.trim().split(/\r?\n/).filter((l) => l.trim().length > 0)
        resolve(lines.length > 0 ? lines[lines.length - 1].trim() : null)
      }
    )
  })
}
