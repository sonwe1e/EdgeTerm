# Capture an existing EdgeTerm hang from OUTSIDE its UI (Windows 11/PowerShell 5.1+).
# No restart, termination, screenshots, terminal text, or full command lines.
# Usage: powershell -NoProfile -File .\diagnose-hang.ps1 -ProcessId <PID>
# With no PID, exactly one edgeterm.exe must exist; ambiguity is an error.
[CmdletBinding()]
param(
    [ValidateRange(0, 2147483647)][int]$ProcessId = 0,
    [string]$OutputDirectory = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'EdgeTerm-diagnostics')
)

function Select-EdgeTermTarget {
    param([object[]]$Processes, [int]$RequestedId)
    $candidates = @($Processes | Where-Object { $_.Name -ieq 'edgeterm.exe' })
    if ($RequestedId -gt 0) {
        $selected = @($candidates | Where-Object { $_.ProcessId -eq $RequestedId })
        if ($selected.Count -ne 1) { throw "PID $RequestedId is not a running edgeterm.exe." }
        return $selected[0]
    }
    if ($candidates.Count -ne 1) {
        $ids = ($candidates | ForEach-Object { $_.ProcessId }) -join ', '
        throw "Expected one edgeterm.exe, found $($candidates.Count) (PIDs: $ids). Specify -ProcessId."
    }
    return $candidates[0]
}

function Get-EdgeTermFamily {
    param([object[]]$Processes, [object]$Target)
    $family = @($Target)
    $seen = @{ ([int]$Target.ProcessId) = $true }
    for ($level = 0; $level -lt 16; $level++) {
        $next = @($Processes | Where-Object {
            $child = $_
            if ($seen.ContainsKey([int]$child.ProcessId) -or $child.Name -ine 'msedgewebview2.exe') { return $false }
            $parent = $family | Where-Object { $_.ProcessId -eq $child.ParentProcessId } | Select-Object -First 1
            # Parent IDs can be reused after exit. Do not associate older processes.
            return $null -ne $parent -and $null -ne $child.CreationDate -and
                $null -ne $parent.CreationDate -and $child.CreationDate -ge $parent.CreationDate
        })
        if ($next.Count -eq 0) { break }
        foreach ($item in $next) { $seen[[int]$item.ProcessId] = $true }
        $family += $next
    }
    return $family
}

function Get-EdgeTermProcessRole {
    param([object]$Process)
    if ($Process.Name -ieq 'edgeterm.exe') { return 'host' }
    # Parse only a fixed enum; command lines can contain private URLs/paths.
    if ($Process.CommandLine -match '(?:^|\s)--type=(?:"?)([a-z-]+)(?:"?)(?:\s|$)') {
        if ($Matches[1] -in @('renderer', 'gpu-process', 'utility', 'crashpad-handler')) { return $Matches[1] }
        return 'other-webview-child'
    }
    return 'browser-or-unknown'
}

function Get-EdgeTermProcessSample {
    param([object]$Entry)
    $sample = [ordered]@{
        pid = [int]$Entry.ProcessId; parentPid = [int]$Entry.ParentProcessId
        name = $Entry.Name; role = Get-EdgeTermProcessRole $Entry
        createdUtc = if ($Entry.CreationDate) { $Entry.CreationDate.ToUniversalTime().ToString('o') } else { $null }
        sampledUtc = [DateTime]::UtcNow.ToString('o'); cpuSeconds = $null
        workingSetBytes = $null; handles = $null; status = 'unavailable'
    }
    try {
        $process = Get-Process -Id $Entry.ProcessId -ErrorAction Stop
        try {
            if ($Entry.CreationDate -and [Math]::Abs(($process.StartTime.ToUniversalTime() - $Entry.CreationDate.ToUniversalTime()).TotalSeconds) -ge 1) {
                $sample.status = 'pid-reused'
            } else {
                $sample.cpuSeconds = $process.TotalProcessorTime.TotalSeconds
                $sample.workingSetBytes = $process.WorkingSet64
                $sample.handles = $process.HandleCount
                $sample.status = 'sampled'
            }
        } finally { $process.Dispose() }
    } catch { $sample.status = 'exited-or-inaccessible' }
    return [pscustomobject]$sample
}

function Initialize-EdgeTermWindowProbe {
    if ('EdgeTermHang.Native' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
namespace EdgeTermHang {
  public sealed class WindowInfo {
    public string handle, className, parentHandle, ownerHandle, dpiAwareness;
    public int pid, threadId, regionType, regionApiError;
    public bool visible, enabled, rectAvailable;
    public uint dpi;
    public int[] rect, regionBox;
  }
  public sealed class Response {
    public bool responded;
    public int lastError;
    public long elapsedMs;
    public string interpretation;
  }
  public static class Native {
    public delegate bool EnumProc(IntPtr h, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint command);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr h);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr h);
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError=true)] static extern int GetWindowRgn(IntPtr h, IntPtr region);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l,int t,int r,int b);
    [DllImport("gdi32.dll")] static extern int GetRgnBox(IntPtr region, out RECT box);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr item);
    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeoutW(IntPtr h,uint msg,UIntPtr w,IntPtr l,uint flags,uint timeout,out UIntPtr result);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint value);
    static string Hex(IntPtr h) { return "0x" + h.ToInt64().ToString("X"); }
    static int[] Box(RECT r) { return new int[] {r.L,r.T,r.R,r.B}; }
    static WindowInfo Read(IntPtr h, IntPtr parent) {
      uint pid; uint thread = GetWindowThreadProcessId(h, out pid);
      var name = new StringBuilder(256); GetClassName(h, name, name.Capacity);
      RECT rect; bool hasRect = GetWindowRect(h, out rect);
      IntPtr context = GetWindowDpiAwarenessContext(h);
      string awareness = GetAwarenessFromDpiAwarenessContext(context).ToString();
      if (AreDpiAwarenessContextsEqual(context, new IntPtr(-4))) awareness = "per-monitor-v2";
      var result = new WindowInfo {
        handle=Hex(h), parentHandle=Hex(parent), ownerHandle=Hex(GetWindow(h,4)), pid=(int)pid, threadId=(int)thread,
        className=name.ToString(), visible=IsWindowVisible(h), enabled=IsWindowEnabled(h),
        rectAvailable=hasRect, rect=hasRect ? Box(rect) : null, dpi=GetDpiForWindow(h), dpiAwareness=awareness,
        regionType=-1
      };
      if (result.className == "TAURI_DRAG_RESIZE_BORDERS") {
        IntPtr region = CreateRectRgn(0,0,0,0);
        if (region != IntPtr.Zero) try {
          SetLastError(0); result.regionType=GetWindowRgn(h,region);
          result.regionApiError=Marshal.GetLastWin32Error();
          RECT box; if (result.regionType != 0 && GetRgnBox(region,out box) != 0) result.regionBox=Box(box);
        } finally { DeleteObject(region); }
      }
      return result;
    }
    public static WindowInfo[] Windows(int pid) {
      var result = new List<WindowInfo>();
      IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
      try {
        EnumWindows((h,d) => {
          uint owner; GetWindowThreadProcessId(h,out owner);
          if (owner != pid) return true;
          result.Add(Read(h,IntPtr.Zero));
          EnumChildWindows(h,(child,unused) => {
            if (result.Count >= 128) return false;
            result.Add(Read(child,h)); return true;
          },IntPtr.Zero);
          return result.Count < 128;
        },IntPtr.Zero);
      } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
      return result.ToArray();
    }
    public static Response Probe(IntPtr h, uint timeout) {
      var watch=Stopwatch.StartNew(); UIntPtr value;
      SetLastError(0);
      // BLOCK + ABORTIFHUNG + ERRORONEXIT; never NOTIMEOUTIFNOTHUNG.
      IntPtr ok=SendMessageTimeoutW(h,0,UIntPtr.Zero,IntPtr.Zero,0x23,timeout,out value);
      int error=Marshal.GetLastWin32Error(); watch.Stop();
      return new Response { responded=ok!=IntPtr.Zero, lastError=error, elapsedMs=watch.ElapsedMilliseconds,
        interpretation=ok!=IntPtr.Zero ? "native-message-returned; JavaScript/GPU health unknown" : "timeout-or-API-failure; dump needed, not proof of deadlock" };
    }
  }
}
'@
}

# Dot-sourcing exposes the same functions to the regression fixture without collecting.
if ($MyInvocation.InvocationName -eq '.') { return }
$ErrorActionPreference = 'Stop'
try {
    $processes = @(Get-CimInstance Win32_Process -OperationTimeoutSec 10)
    $target = Select-EdgeTermTarget $processes $ProcessId
    $family = @(Get-EdgeTermFamily $processes $target)
    Write-Host "Collecting PID $($target.ProcessId): $($target.ExecutablePath)"
    $warnings = [Collections.Generic.List[string]]::new()
    Initialize-EdgeTermWindowProbe
    $identity = Get-EdgeTermProcessSample $target
    if ($identity.status -ne 'sampled') { throw 'The selected process exited, changed identity, or became inaccessible. Select it again.' }
    $windows = @([EdgeTermHang.Native]::Windows([int]$target.ProcessId))
    $main = $windows | Where-Object { $_.parentHandle -eq '0x0' -and $_.ownerHandle -eq '0x0' -and $_.visible } |
        Sort-Object -Property @{ Expression = { if ($_.rectAvailable) { ($_.rect[2] - $_.rect[0]) * ($_.rect[3] - $_.rect[1]) } else { 0 } }; Descending = $true } |
        Select-Object -First 1
    if (-not $main) { $main = $windows | Where-Object { $_.parentHandle -eq '0x0' } | Select-Object -First 1 }
    $probe = $null
    $before = @($family | ForEach-Object { Get-EdgeTermProcessSample $_ })
    $interval = [Diagnostics.Stopwatch]::StartNew()
    if ($main) {
        $probe = [EdgeTermHang.Native]::Probe([IntPtr][Convert]::ToInt64($main.handle.Substring(2),16), 2000)
    } else { $warnings.Add('No top-level window was found for the selected process.') }
    Start-Sleep -Milliseconds 2000
    $after = @($family | ForEach-Object { Get-EdgeTermProcessSample $_ })
    $interval.Stop()
    $versions = @($family | ForEach-Object {
        $entry = $_; $version = $null
        try { if ($entry.ExecutablePath) { $version = (Get-Item -LiteralPath $entry.ExecutablePath).VersionInfo.FileVersion } }
        catch { $warnings.Add("Version unavailable for PID $($entry.ProcessId).") }
        [pscustomobject]@{ pid = [int]$entry.ProcessId; fileVersion = $version }
    })
    $appHash = $null
    try { if ($target.ExecutablePath) { $appHash = (Get-FileHash -LiteralPath $target.ExecutablePath -Algorithm SHA256).Hash } }
    catch { $warnings.Add('Application SHA-256 unavailable.') }
    $os = $null; $gpus = @()
    try { $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 10 | Select-Object Caption, Version, BuildNumber, OSArchitecture }
    catch { $warnings.Add('OS query unavailable.') }
    try { $gpus = @(Get-CimInstance Win32_VideoController -OperationTimeoutSec 10 | Select-Object Name, DriverVersion, DriverDate, CurrentHorizontalResolution, CurrentVerticalResolution) }
    catch { $warnings.Add('Display adapter query unavailable.') }
    $report = [ordered]@{
        schemaVersion = 1; capturedUtc = [DateTime]::UtcNow.ToString('o')
        target = @{ pid = [int]$target.ProcessId; path = $target.ExecutablePath; sha256 = $appHash }
        os = $os; displayAdapters = $gpus; executableVersions = $versions
        nativeProbeWindow = if ($main) { $main.handle } else { $null }
        nativeMessageProbe = $probe; windows = $windows
        sampleIntervalSeconds = $interval.Elapsed.TotalSeconds; before = $before; after = $after
        warnings = @($warnings.ToArray())
        limits = @('Only this host and its observed WebView2 descendants are included.',
            'Native message response does not prove JavaScript or GPU responsiveness.',
            'Region type 0 is an API error/absence result, not evidence that a window eats clicks.',
            'CPU values are cumulative process seconds; compare before/after, not percent.',
            'This report has no stack traces and cannot identify a deadlock by itself.')
    }
    $null = New-Item -ItemType Directory -Force -Path $OutputDirectory
    $path = Join-Path $OutputDirectory ("edgeterm-hang-{0}-{1}-{2}.json" -f $target.ProcessId, (Get-Date -Format 'yyyyMMdd-HHmmss'), [Guid]::NewGuid().ToString('N').Substring(0,8))
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($path), ($report | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Write-Host "Saved: $([IO.Path]::GetFullPath($path))"
    if ($probe) { Write-Host "Native message: $($probe.interpretation)" }
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
