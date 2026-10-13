# Diagnose EdgeTerm's post-drag unresponsive state, in place.
#
# When the bug reproduces (drag the window out of maximized and the content
# no longer reacts to clicks), run this script on THAT machine. It reads the
# window tree state without sending any input, prints a verdict, and saves a
# screenshot. No arguments needed:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-hang.ps1
#
# What it tells you:
#   1. hung/responds  -> whether the main thread is dead (deadlock) or alive
#   2. overlay        -> the TAURI_DRAG_RESIZE_BORDERS child: its rect and its
#                        window region. If rect covers the whole window and
#                        rgnType=ERROR (no region), it is eating every click
#                        (the resize borders are exactly what still works).
#   3. webview child  -> whether WebView2's own child windows are enabled and
#                        visible.

$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class D {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowRgn(IntPtr h, IntPtr rgn);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")] public static extern int GetRgnBox(IntPtr rgn, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@

$proc = Get-Process edgeterm -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Host "edgeterm.exe is not running"; exit 1 }
$proc.Refresh()
$hwnd = $proc.MainWindowHandle
if (-not $hwnd -or $hwnd -eq [IntPtr]::Zero) { Write-Host "main window not found"; exit 1 }

$r = New-Object D+RECT
[void][D]::GetWindowRect($hwnd, [ref]$r)
$ww = $r.R - $r.L; $wh = $r.B - $r.T
Write-Host ("main hwnd 0x{0:X}  rect={1},{2}..{3},{4} ({5}x{6})  zoomed={7} visible={8}" -f `
  $hwnd.ToInt64(), $r.L, $r.T, $r.R, $r.B, $ww, $wh, [D]::IsZoomed($hwnd), [D]::IsWindowVisible($hwnd))

$hung = [D]::IsHungAppWindow($hwnd)
$res = [IntPtr]::Zero
$ok = [D]::SendMessageTimeout($hwnd, 0x0000, [UIntPtr]::Zero, [IntPtr]::Zero, 0x0002, 2000, [ref]$res)
Write-Host ("main thread: hung={0} responds-to-WM_NULL={1}" -f $hung, ($ok -ne [IntPtr]::Zero))
if ($hung -or $ok -eq [IntPtr]::Zero) {
  Write-Host "VERDICT CANDIDATE A: main thread is deadlocked (WebView2 COM call inside the drag modal loop)."
}

# walk the child tree
$found = New-Object System.Collections.ArrayList
$cb = [D+EnumProc]{ param($h, $l) $null = $found.Add($h); return $true }
[D]::EnumChildWindows($hwnd, $cb, [IntPtr]::Zero) | Out-Null
$overlayBad = $false
foreach ($h in $found) {
  $sb = New-Object System.Text.StringBuilder 256
  [void][D]::GetClassName($h, $sb, 256)
  $cls = $sb.ToString()
  $cr = New-Object D+RECT
  [void][D]::GetWindowRect($h, [ref]$cr)
  $cw = $cr.R - $cr.L; $ch = $cr.B - $cr.T
  $line = ("  child 0x{0:X} {1}  rect={2}x{3}  enabled={4} visible={5}" -f `
    $h.ToInt64(), $cls, $cw, $ch, [D]::IsWindowEnabled($h), [D]::IsWindowVisible($h))
  if ($cls -eq "TAURI_DRAG_RESIZE_BORDERS") {
    $rgn = [D]::CreateRectRgn(0, 0, 0, 0)
    $type = [D]::GetWindowRgn($h, $rgn)
    $box = New-Object D+RECT
    $boxStr = "NO REGION"
    if ($type -ne 0) {
      [void][D]::GetRgnBox($rgn, [ref]$box)
      $boxStr = "$($box.L),$($box.T)..$($box.R),$($box.B)"
    }
    $line += "  rgnType=$type rgnBox=$boxStr"
    if ($type -eq 0 -and $cw -gt 100 -and $ch -gt 100) { $overlayBad = $true }
  }
  Write-Host $line
}
if ($overlayBad) {
  Write-Host "VERDICT CANDIDATE B: the resize-border overlay is full-window with NO cutout region -> it eats all clicks."
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$out = Join-Path $env:USERPROFILE ("edgeterm-hang-{0}.png" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot: $out"
