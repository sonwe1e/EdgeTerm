# Repro harness: maximize EdgeTerm, drag its custom titlebar (menubar) until the
# window restores, then check whether the main window has hung.
# On hang: capture a minidump with comsvcs.dll so the deadlock stack can be read.

param(
  [string]$Exe = "G:\Workspaces\TestStudio\EdgeTerm\src-tauri\target\release\edgeterm.exe",
  [int]$Iterations = 15
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo;
  }
  public const uint MOUSEEVENTF_MOVE = 0x0001;
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
}
"@

function Move-Abs([int]$x, [int]$y) {
  $w = [Win]::GetSystemMetrics(0); $h = [Win]::GetSystemMetrics(1)
  $ax = [int](($x * 65536) / $w); $ay = [int](($y * 65536) / $h)
  $inp = New-Object Win+INPUT
  $inp.type = 0  # INPUT_MOUSE
  $inp.mi.dx = $ax; $inp.mi.dy = $ay
  $inp.mi.dwFlags = [Win]::MOUSEEVENTF_MOVE -bor [Win]::MOUSEEVENTF_ABSOLUTE
  [void][Win]::SendInput(1, @($inp), [Runtime.InteropServices.Marshal]::SizeOf($inp))
}
function Click-Down() {
  $inp = New-Object Win+INPUT
  $inp.type = 0; $inp.mi.dwFlags = [Win]::MOUSEEVENTF_LEFTDOWN
  [void][Win]::SendInput(1, @($inp), [Runtime.InteropServices.Marshal]::SizeOf($inp))
}
function Click-Up() {
  $inp = New-Object Win+INPUT
  $inp.type = 0; $inp.mi.dwFlags = [Win]::MOUSEEVENTF_LEFTUP
  [void][Win]::SendInput(1, @($inp), [Runtime.InteropServices.Marshal]::SizeOf($inp))
}

function Get-Cursor() {
  Add-Type -AssemblyName System.Windows.Forms
  $c = [System.Windows.Forms.Cursor]::Position
  "{0},{1}" -f $c.X, $c.Y
}
function Shot([string]$path) {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

function Test-Hung([IntPtr]$hwnd, [uint32]$timeoutMs) {
  $hung = [Win]::IsHungAppWindow($hwnd)
  $res = [IntPtr]::Zero
  $ok = [Win]::SendMessageTimeout($hwnd, 0x0000, [UIntPtr]::Zero, [IntPtr]::Zero, 0x0002, $timeoutMs, [ref]$res)  # WM_NULL, SMTO_ABORTIFHUNG
  return @{ Hung = $hung; Responds = ($ok -ne [IntPtr]::Zero) }
}

Get-Process edgeterm -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
Write-Host "Launching $Exe"
$proc = Start-Process -FilePath $Exe -PassThru
$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 100; $i++) {
  Start-Sleep -Milliseconds 200
  if ($proc.HasExited) { throw "process exited during startup" }
  $proc.Refresh()
  $mh = $proc.MainWindowHandle
  if ($mh -and $mh -ne [IntPtr]::Zero -and [Win]::IsWindowVisible($mh)) {
    $hwnd = $mh; break
  }
}
if ($hwnd -eq [IntPtr]::Zero) { throw "main window never appeared" }
Write-Host ("hwnd = 0x{0:X}" -f $hwnd.ToInt64())
Start-Sleep -Seconds 2   # let the frontend finish loading

$screenW = [Win]::GetSystemMetrics(0); $screenH = [Win]::GetSystemMetrics(1)

for ($iter = 1; $iter -le $Iterations; $iter++) {
  # 1. maximize
  [void][Win]::PostMessage($hwnd, 0x0112, [UIntPtr][uint32]0xF030, [IntPtr]::Zero)  # WM_SYSCOMMAND SC_MAXIMIZE
  Start-Sleep -Milliseconds 900
  if (-not [Win]::IsZoomed($hwnd)) { Write-Host "iter ${iter}: maximize did not take"; continue }

  # 2. drag the menubar: press at the centered title, drag down-left past the
  #    restore threshold, end near screen center
  # Simulate the message sequence a drag-off-maximize produces, without the
  # modal loop itself (synthetic physical input is unavailable here):
  # WM_ENTERSIZEMOVE -> SC_RESTORE -> WM_MOVE series -> WM_EXITSIZEMOVE.
  [void][Win]::SetForegroundWindow($hwnd)
  Start-Sleep -Milliseconds 300
  $res = [IntPtr]::Zero
  [void][Win]::SendMessageTimeout($hwnd, 0x0231, [UIntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$res)  # WM_ENTERSIZEMOVE
  Start-Sleep -Milliseconds 120
  [void][Win]::PostMessage($hwnd, 0x0112, [UIntPtr][uint32]0xF120, [IntPtr]::Zero)  # WM_SYSCOMMAND SC_RESTORE
  Start-Sleep -Milliseconds 700
  $endX = [int]($screenW / 2); $endY = [int]($screenH / 2)
  $steps = 10
  for ($s = 1; $s -le $steps; $s++) {
    $x = [int]($endX * $s / $steps); $y = [int]($endY * $s / $steps)
    $lp = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    [void][Win]::SendMessageTimeout($hwnd, 0x0003, [UIntPtr]::Zero, $lp, 0x0002, 2000, [ref]$res)  # WM_MOVE
    Start-Sleep -Milliseconds 50
  }
  [void][Win]::SendMessageTimeout($hwnd, 0x0232, [UIntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$res)  # WM_EXITSIZEMOVE
  Start-Sleep -Milliseconds 1500
  Shot "G:\Workspaces\TestStudio\EdgeTerm\repro-iter-$iter.png"

  # 3. verdict
  $zoomed = [Win]::IsZoomed($hwnd)
  $state = Test-Hung $hwnd 2000
  Write-Host ("iter {0}: zoomed={1} hung={2} responds={3}" -f $iter, $zoomed, $state.Hung, $state.Responds)
  if ($state.Hung -or -not $state.Responds) {
    $dump = "G:\Workspaces\TestStudio\EdgeTerm\edgeterm-hang.dmp"
    rundll32.exe comsvcs.dll, MiniDump $proc.Id $dump full
    Write-Host "HUNG at iteration $iter - dump written to $dump"
    break
  }
}

Write-Host "Done (process still running: pid $($proc.Id))"
