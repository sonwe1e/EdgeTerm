# Bootstrap without relying on the caller's (possibly stale or agent-owned) PATH.
$ErrorActionPreference = 'Stop'
try {
    . "$PSScriptRoot/scripts/windows-tools.ps1"
    $node = Find-EdgeTermNode
    & $node "$PSScriptRoot/scripts/run-task.mjs" @args
    exit $LASTEXITCODE
} catch {
    Write-Error $_
    exit 1
}
