param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$fixtureOutput = $OutputDirectory
. "$PSScriptRoot/../diagnose-hang.ps1"
function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Entry($id, $parent, $name, $seconds, $command = '') {
    [pscustomobject]@{ ProcessId=$id; ParentProcessId=$parent; Name=$name; CreationDate=[DateTime]'2026-01-01Z' + [TimeSpan]::FromSeconds($seconds); CommandLine=$command }
}
$hostEntry = Entry 20 1 'edgeterm.exe' 10
$otherHost = Entry 25 1 'edgeterm.exe' 10
$entries = @($hostEntry, $otherHost, (Entry 30 20 'msedgewebview2.exe' 11),
    (Entry 31 30 'msedgewebview2.exe' 12 '--type=renderer --private=SECRET'),
    (Entry 32 30 'msedgewebview2.exe' 12 '--type=gpu-process'),
    (Entry 40 25 'msedgewebview2.exe' 11), (Entry 41 40 'msedgewebview2.exe' 12),
    (Entry 50 20 'msedgewebview2.exe' 1), (Entry 51 20 'unrelated.exe' 12))
$ambiguous = $false
try { Select-EdgeTermTarget $entries 0 } catch { $ambiguous = $true }
Assert $ambiguous 'Multiple applications must require a PID.'
$rejected = $false
try { Select-EdgeTermTarget $entries 31 } catch { $rejected = $true }
Assert $rejected 'A renderer PID must not be accepted as the host.'
Assert ((Select-EdgeTermTarget $entries 20).ProcessId -eq 20) 'Explicit target selection failed.'
Assert ((Select-EdgeTermTarget @($hostEntry) 0).ProcessId -eq 20) 'Unique target selection failed.'
$family = @(Get-EdgeTermFamily $entries $hostEntry)
Assert (($family.ProcessId -join ',') -eq '20,30,31,32') 'Included unrelated or reused-parent processes.'
Assert ((Get-EdgeTermProcessRole $entries[3]) -eq 'renderer') 'Renderer role was not parsed.'
Assert ((Get-EdgeTermProcessRole $entries[4]) -eq 'gpu-process') 'GPU role was not parsed.'
Assert ((Get-EdgeTermProcessRole (Entry 52 20 'msedgewebview2.exe' 12 '--type=SECRET')) -eq 'other-webview-child') 'Unknown arguments must not be exported.'

# A real, invisible native window with its own UI thread. It can deliberately
# block WM_NULL, so the production probe must actually time out. No user app.
Initialize-EdgeTermWindowProbe
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;
public class HangProbeFixture : NativeWindow, IDisposable {
  public IntPtr Target;
  public volatile bool Block;
  readonly ManualResetEvent ready = new ManualResetEvent(false);
  readonly ManualResetEvent release = new ManualResetEvent(false);
  readonly Thread thread;
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
  public HangProbeFixture() {
    thread = new Thread(() => {
      CreateHandle(new CreateParams { Caption="EdgeTerm test fixture", Width=200, Height=100 });
      Target=Handle; ready.Set(); Application.Run();
    });
    thread.IsBackground=true; thread.SetApartmentState(ApartmentState.STA); thread.Start();
    if (!ready.WaitOne(5000)) throw new Exception("Fixture did not create its window");
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0 && Block) release.WaitOne(5000);
    if (m.Msg == 0x10) { DestroyHandle(); Application.ExitThread(); return; }
    base.WndProc(ref m);
  }
  public void Dispose() {
    release.Set(); PostMessage(Target,0x10,IntPtr.Zero,IntPtr.Zero);
    if (!thread.Join(5000)) throw new Exception("Fixture did not exit");
    ready.Dispose(); release.Dispose();
  }
}
'@
$fixture = [HangProbeFixture]::new()
try {
    $live = [EdgeTermHang.Native]::Probe($fixture.Target, 200)
    Assert $live.responded 'Healthy native message loop did not respond.'
    $windows = @([EdgeTermHang.Native]::Windows($PID))
    $window = $windows | Where-Object { $_.handle -eq ('0x' + $fixture.Target.ToInt64().ToString('X')) }
    Assert ($null -ne $window -and $window.dpi -gt 0) 'Window/DPI observation failed.'
    $fixture.Block = $true
    $blocked = [EdgeTermHang.Native]::Probe($fixture.Target, 200)
    Assert (-not $blocked.responded) 'Blocked native message loop incorrectly reported responsive.'
    Assert ($blocked.elapsedMs -lt 2000) 'Probe did not respect its deadline.'
    Assert ($blocked.interpretation -match 'not proof of deadlock') 'Timeout was mislabeled as a root cause.'
} finally { $fixture.Dispose() }

# Drive the complete report writer with a synthetic process inventory. OS/GPU
# identity is also synthetic. CPU/window APIs target only this test process.
$self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" |
    Select-Object ProcessId, ParentProcessId, Name, CreationDate, CommandLine, ExecutablePath
$self.Name = 'edgeterm.exe'
$self.CommandLine = 'SECRET-COMMAND-LINE'
function Get-CimInstance {
    param($ClassName, $OperationTimeoutSec)
    switch ($ClassName) {
        'Win32_Process' { return $self }
        'Win32_OperatingSystem' { return [pscustomobject]@{ Caption='fixture'; Version='fixture'; BuildNumber='fixture'; OSArchitecture='x64' } }
        'Win32_VideoController' { return [pscustomobject]@{ Name='fixture'; DriverVersion='fixture'; DriverDate=$null; CurrentHorizontalResolution=100; CurrentVerticalResolution=100 } }
        default { throw "Unexpected query $ClassName" }
    }
}
& "$PSScriptRoot/../diagnose-hang.ps1" -ProcessId $PID -OutputDirectory $fixtureOutput
$reports = @(Get-ChildItem -LiteralPath $fixtureOutput -Filter '*.json')
Assert ($reports.Count -eq 1) 'Report was not written exactly once.'
$raw = Get-Content -Raw -LiteralPath $reports[0].FullName
$report = $raw | ConvertFrom-Json
Assert ($report.schemaVersion -eq 1 -and $report.target.pid -eq $PID) 'Report target/schema mismatch.'
Assert ($report.before.Count -eq 1 -and $report.after.Count -eq 1) 'Missing process samples.'
Assert ($report.before[0].status -eq 'sampled' -and $report.after[0].status -eq 'sampled') 'Own-process sampling failed.'
Assert (-not $raw.Contains('SECRET')) 'Full command line leaked into the report.'
Assert (@(Get-ChildItem -LiteralPath $fixtureOutput -Filter '*.png').Count -eq 0) 'Collection took an unsolicited screenshot.'
Write-Output 'hang probe fixture passed'
