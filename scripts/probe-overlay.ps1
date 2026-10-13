# Probe the TAURI_DRAG_RESIZE_BORDERS overlay: its size and window region after
# a simulated drag-off-maximize, and under crafted WM_SIZE interleavings.
param([string]$Exe = "G:\Workspaces\TestStudio\EdgeTerm\src-tauri\target\release\edgeterm.exe")
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class W6 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, UIntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint m, UIntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
function Find-Overlay([IntPtr]$parent) {
  [W6]::FindWindowExW($parent, [IntPtr]::Zero, "TAURI_DRAG_RESIZE_BORDERS", "TAURI_DRAG_RESIZE_WINDOW")
}
function Overlay-State([IntPtr]$parent, [string]$tag) {
  $child = Find-Overlay $parent
  if ($child -eq [IntPtr]::Zero) { Write-Host "[$tag] overlay: NOT FOUND"; return }
  $r = New-Object W6+RECT
  [void][W6]::GetWindowRect($child, [ref]$r)
  $rgn = [W6]::CreateRectRgn(0,0,0,0)
  $type = [W6]::GetWindowRgn($child, $rgn)
  $box = New-Object W6+RECT
  $boxStr = "none"
  if ($type -eq 0 -or $type -eq 2 -or $type -eq 3) {  # ERROR=0? actually ERROR=0; NULLREGION=1 SIMPLE=2 COMPLEX=3
    $t = [W6]::GetRgnBox($rgn, [ref]$box)
    if ($t -ne 0) { $boxStr = "$($box.L),$($box.T),$($box.R),$($box.B) w=$($box.R-$box.L) h=$($box.B-$box.T)" }
  }
  # GetWindowRgn returns 0 (ERROR) when no region is set
  Write-Host ("[{0}] overlay 0x{1:X}: rect={2},{3},{4},{5} ({6}x{7})  rgnType={8} box={9}" -f `
    $tag, $child.ToInt64(), $r.L, $r.T, $r.R, $r.B, ($r.R-$r.L), ($r.B-$r.T), $type, $boxStr)
}

Get-Process edgeterm -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
$proc = Start-Process -FilePath $Exe -PassThru
Start-Sleep -Seconds 5
$proc.Refresh()
$hwnd = $proc.MainWindowHandle
Write-Host ("main hwnd = 0x{0:X}" -f $hwnd.ToInt64())
Overlay-State $hwnd "fresh window"

# --- baseline: plain restore ---
[void][W6]::PostMessage($hwnd, 0x0112, [UIntPtr][uint32]0xF030, [IntPtr]::Zero)  # SC_MAXIMIZE
Start-Sleep -Milliseconds 1000
Overlay-State $hwnd "maximized"
[void][W6]::PostMessage($hwnd, 0x0112, [UIntPtr][uint32]0xF120, [IntPtr]::Zero)  # SC_RESTORE
Start-Sleep -Milliseconds 1200
Overlay-State $hwnd "after plain restore"

# --- crafted: WM_SIZE delivered while placement still says maximized, i.e. the
#     subclass takes the shrink branch late in the restore; then the restore's
#     own WM_SIZE updates region + async resize (the suspected race) ---
for ($i = 0; $i -lt 5; $i++) {
  [void][W6]::PostMessage($hwnd, 0x0112, [UIntPtr][uint32]0xF030, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  # simulate a maximized-state WM_SIZE arriving now
  [void][W6]::SendMessage($hwnd, 0x0005, [UIntPtr][uint32]2, [IntPtr]::Zero)  # WM_SIZE SIZE_MAXIMIZED
  Start-Sleep -Milliseconds 30
  [void][W6]::PostMessage($hwnd, 0x0112, [UIntPtr][uint32]0xF120, [IntPtr]::Zero)  # SC_RESTORE
  Start-Sleep -Milliseconds 30
  [void][W6]::SendMessage($hwnd, 0x0005, [UIntPtr][uint32]0, [IntPtr]::Zero)  # WM_SIZE SIZE_RESTORED
  Start-Sleep -Milliseconds 1200
  Overlay-State $hwnd ("crafted round " + ($i+1))
}
Get-Process edgeterm -ErrorAction SilentlyContinue | Stop-Process -Force
