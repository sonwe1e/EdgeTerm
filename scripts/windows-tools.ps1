function Get-EdgeTermInstalledPath {
    return [Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User'))
}

function Find-EdgeTermNode {
    if ($env:EDGETERM_NODE) {
        $candidate = $env:EDGETERM_NODE
        if (-not [IO.Path]::IsPathRooted($candidate) -or -not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            throw 'EDGETERM_NODE must name an existing absolute node.exe path.'
        }
        return (Resolve-Path -LiteralPath $candidate).Path
    }
    # Read the installed environment, not an IDE's injected runtime directories.
    $installedPath = Get-EdgeTermInstalledPath
    foreach ($directory in ($installedPath -split ';')) {
        $directory = [Environment]::ExpandEnvironmentVariables($directory.Trim().Trim('"'))
        if (-not $directory -or -not [IO.Path]::IsPathRooted($directory)) { continue }
        $candidate = Join-Path $directory 'node.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return (Resolve-Path -LiteralPath $candidate).Path }
    }
    throw 'Node.js is missing from the installed user/machine PATH. Install Node LTS, or set EDGETERM_NODE to its absolute node.exe path.'
}

function Initialize-EdgeTermNativeTools {
    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $rustup = Join-Path $cargoHome 'bin/rustup.exe'
    if (-not (Test-Path -LiteralPath $rustup)) { throw "Missing $rustup. Install Rust using rustup (MSVC toolchain)." }
    $active = & $rustup show active-toolchain
    if ($LASTEXITCODE -ne 0) { throw 'rustup could not resolve the project toolchain.' }
    $toolchain = ($active -split ' ')[0]
    if ($toolchain -notmatch 'x86_64-pc-windows-msvc$') { throw "Expected x86_64 MSVC Rust; selected $toolchain. Select an MSVC toolchain with rustup." }
    $cargo = & $rustup which --toolchain $toolchain cargo
    if ($LASTEXITCODE -ne 0) { throw 'Selected Rust toolchain has no Cargo.' }
    $rustc = & $rustup which --toolchain $toolchain rustc
    if ($LASTEXITCODE -ne 0) { throw 'Selected Rust toolchain has no rustc.' }
    if ($env:RUSTC -and $env:RUSTC -ne $rustc) { throw "RUSTC conflicts with the selected toolchain: $env:RUSTC. Clear RUSTC or select that toolchain through rustup." }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswhere)) { throw 'Install Visual Studio Build Tools with Desktop development with C++ and Windows SDK.' }
    $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'No Visual Studio installation with MSVC x64 tools. Install Desktop development with C++ and Windows SDK.' }
    $devcmd = Join-Path $installation 'Common7/Tools/VsDevCmd.bat'
    # cmd is used only to load VS's own environment; task arguments never enter it.
    $lines = & "$env:SystemRoot/System32/cmd.exe" /d /c "call `"$devcmd`" -no_logo -arch=x64 -host_arch=x64 >nul && set"
    if ($LASTEXITCODE -ne 0) { throw "VsDevCmd failed: $devcmd" }
    foreach ($line in $lines) {
        if ($line -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process') }
    }
    $selectedTools = @{}
    foreach ($tool in @('cl.exe', 'link.exe', 'rc.exe', 'mt.exe')) {
        $resolved = Get-Command $tool -CommandType Application -ErrorAction Stop | Select-Object -First 1
        $expected = if ($tool -in @('cl.exe', 'link.exe')) { $env:VCToolsInstallDir } else { $env:WindowsSdkDir }
        if (-not $expected -or -not $resolved.Source.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Wrong $tool selected: $($resolved.Source). Expected tools under $expected."
        }
        $selectedTools[$tool] = $resolved.Source
    }
    foreach ($tool in @('git.exe', 'cmake.exe', 'ninja.exe')) {
        $resolved = Get-Command $tool -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($resolved) { $selectedTools[$tool] = $resolved.Source }
    }
    $env:EDGETERM_NATIVE_TOOLS = $selectedTools | ConvertTo-Json -Compress
    $env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $selectedTools['link.exe']
    $env:RUSTUP_TOOLCHAIN = $toolchain
    $env:EDGETERM_CARGO = $cargo
    $env:RUSTC = $rustc
    $env:RUSTDOC = Join-Path (Split-Path $rustc) 'rustdoc.exe'
    $env:Path = (Split-Path $cargo) + ';' + (Join-Path $cargoHome 'bin') + ';' + $env:Path
}
