$ErrorActionPreference = 'Stop'
$mutex = $null
$ownsMutex = $false
try {
    . "$PSScriptRoot/windows-tools.ps1"
    $request = $env:EDGETERM_TASK_REQUEST | ConvertFrom-Json
    if (-not $request.task) { throw 'Missing task request. Use dev.ps1 or npm run.' }
    Set-Location (Split-Path $PSScriptRoot)
    $node = Find-EdgeTermNode
    if (-not (Test-Path -LiteralPath (Join-Path (Split-Path $node) 'node_modules/npm/bin/npm-cli.js'))) {
        throw "Selected Node has no sibling npm installation: $node. Choose a complete Node LTS installation with EDGETERM_NODE."
    }
    $env:Path = (Get-EdgeTermInstalledPath) + ';' + $env:Path
    # The same CPU set across invocations prevents overlapping runs from adding
    # up to all cores. Children inherit affinity, including rustc/link/esbuild.
    $self = [Diagnostics.Process]::GetCurrentProcess()
    $available = $self.ProcessorAffinity.ToInt64()
    [long]$mask = 0
    $count = 0
    $limit = [Math]::Max(1, [Math]::Min(4, [Math]::Floor([Environment]::ProcessorCount / 2)))
    if ($env:EDGETERM_CPU_COUNT -match '^[1-4]$') { $limit = [int]$env:EDGETERM_CPU_COUNT }
    for ($bit = 0; $bit -lt 63 -and $count -lt $limit; $bit++) {
        [long]$flag = [long]1 -shl $bit
        if (($available -band $flag) -ne 0) { $mask = $mask -bor $flag; $count++ }
    }
    if ($mask -eq 0) { throw 'Could not establish a safe CPU affinity mask.' }
    $self.ProcessorAffinity = [IntPtr]$mask
    $self.PriorityClass = 'BelowNormal'
    $env:EDGETERM_CPU_MASK = $mask.ToString()
    $env:EDGETERM_CPU_COUNT = $count.ToString()

    # OS-owned mutex has no stale lock file after a crash. Tauri's frontend
    # hooks inherit the live owner and are part of the same budget.
    $nested = $false
    if ($env:EDGETERM_TASK_OWNER -and $env:EDGETERM_TASK_ROOT -eq (Get-Location).Path) {
        $owner = Get-Process -Id ([int]$env:EDGETERM_TASK_OWNER) -ErrorAction SilentlyContinue
        # PID alone can be reused after an interrupted task exits.
        $nested = $null -ne $owner -and $owner.StartTime.ToUniversalTime().Ticks.ToString() -eq $env:EDGETERM_TASK_OWNER_START
    }
    if (-not $nested -and $request.task -ne 'doctor') {
        $mutex = [Threading.Mutex]::new($false, 'Local\EdgeTerm.BuildBudget')
        try { $ownsMutex = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $ownsMutex = $true }
        if (-not $ownsMutex) { throw 'Another EdgeTerm task is running. Wait for it to finish, or stop its dev server before starting another build/test.' }
        $env:EDGETERM_TASK_OWNER = $PID.ToString()
        $env:EDGETERM_TASK_OWNER_START = $self.StartTime.ToUniversalTime().Ticks.ToString()
        $env:EDGETERM_TASK_ROOT = (Get-Location).Path
    }
    if ($request.native) { Initialize-EdgeTermNativeTools }
    $env:Path = (Split-Path $node) + ';' + $env:Path
    $env:EDGETERM_NODE = $node
    & $node "$PSScriptRoot/run-task.mjs" --execute
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine("[edgeterm] $($_.Exception.Message)")
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
