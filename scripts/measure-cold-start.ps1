# Cold-start baseline for the packaged release executable.
#
# Measures the time from spawning the release edgeterm.exe (portable layout:
# a fresh data/ directory next to the copied executable) until its main
# window handle exists, then until the process reports itself responding.
# The window handle is a coarse proxy for "first window created", not first
# paint or first interactive frame; WebView2 child startup and React first
# render happen after it. Runs elevated/unconfined in a normal user session
# on one machine - single-machine numbers, not a deployment guarantee.
#
# usage: pwsh -NoProfile -File scripts/measure-cold-start.ps1 -Exe <path-to-release-edgeterm.exe> [-Runs 5]
# Nonzero exit when any run fails to show a window within the deadline.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [int]$Runs = 5,
  [string]$WorkRoot = "",
  [double]$WindowDeadlineSeconds = 30.0,
  [double]$RespondingDeadlineSeconds = 10.0
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Exe)) { throw "executable not found: $Exe" }
if (-not $WorkRoot) { $WorkRoot = Join-Path $env:TEMP "edgeterm-coldstart" }
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

function Stop-Tree([int]$ProcessId) {
  try {
    $children = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId"
    foreach ($child in $children) { Stop-Tree ([int]$child.ProcessId) }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  } catch {}
}

function Measure-Launch([string]$Dir, [string]$Label) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Dir "data") | Out-Null
  $target = Join-Path $Dir "edgeterm.exe"
  if (-not (Test-Path $target)) { Copy-Item $Exe $target -Force }
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $process = Start-Process -FilePath $target -PassThru
  $windowMs = $null
  while ($watch.Elapsed.TotalSeconds -lt $WindowDeadlineSeconds) {
    $process.Refresh()
    if ($process.MainWindowHandle -ne 0) { $windowMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1); break }
    if ($process.HasExited) { break }
    Start-Sleep -Milliseconds 25
  }
  $respondingMs = $null
  if ($null -ne $windowMs) {
    while ($watch.Elapsed.TotalSeconds -lt $WindowDeadlineSeconds + $RespondingDeadlineSeconds) {
      $process.Refresh()
      if ($process.Responding) { $respondingMs = [math]::Round($watch.Elapsed.TotalMilliseconds, 1); break }
      if ($process.HasExited) { break }
      Start-Sleep -Milliseconds 25
    }
  }
  Stop-Tree $process.Id
  # The single-instance plugin's mutex outlives Stop-Process until the
  # process object is gone; the next launch would see it, forward and exit
  # before ever showing a window. Wait the process out plus a settle.
  try { Wait-Process -Id $process.Id -Timeout 15 -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Milliseconds 800
  if ($null -eq $windowMs) {
    $process.Refresh()
    throw ("$Label : no main window within $WindowDeadlineSeconds s" +
      " (exited=$($process.HasExited))")
  }
  [pscustomobject]@{ label = $Label; windowMs = $windowMs; respondingMs = $respondingMs }
}

$results = @()
$failure = $null
try {
  # Cold runs: a fresh directory (fresh portable profile) per run.
  for ($run = 1; $run -le $Runs; $run++) {
    $results += Measure-Launch -Dir (Join-Path $WorkRoot "cold-$run") -Label "cold-$run"
  }
  # Warm run: reuse the first directory so the profile and exe pages are cached.
  $results += Measure-Launch -Dir (Join-Path $WorkRoot "cold-1") -Label "warm"
} catch {
  $failure = $_.Exception.Message
} finally {
  foreach ($row in $results) {
    "{0,-8} window {1,9} ms   responding {2}" -f $row.label, $row.windowMs, $row.respondingMs
  }
  Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
}
if ($null -ne $failure) { throw $failure }

$cold = $results | Where-Object { $_.label -like "cold-*" } | Sort-Object windowMs
$median = $cold[[math]::Floor($cold.Count / 2)]
$warm = $results | Where-Object { $_.label -eq "warm" }
"cold-start baseline: $([System.IO.Path]::GetFileName($Exe)), $Runs cold runs + 1 warm"
"  cold window-handle median $($median.windowMs) ms (min $($cold[0].windowMs), max $($cold[-1].windowMs))"
if ($null -ne $median.respondingMs) { "  cold responding median $($median.respondingMs) ms" }
if ($warm) { "  warm window-handle $($warm.windowMs) ms" }
"  boundary: window handle exists = window created, not first paint/interactive; single machine, unconfined run"
exit 0
