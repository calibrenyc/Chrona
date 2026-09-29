# Inspect the native wizard without installing or changing registration.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public struct ChronaWindowRect { public int Left, Top, Right, Bottom; } public static class ChronaWizardNative { [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam); [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out ChronaWindowRect rect); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr dc, uint flags); }'
function Save-ChronaWizardImage($window, $filename) {
  $handle = [IntPtr]$window.Current.NativeWindowHandle
  $rect = New-Object ChronaWindowRect
  [void][ChronaWizardNative]::GetWindowRect($handle,[ref]$rect)
  $bitmap = New-Object System.Drawing.Bitmap ($rect.Right-$rect.Left),($rect.Bottom-$rect.Top)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try { [void][ChronaWizardNative]::PrintWindow($handle,$dc,0) } finally { $graphics.ReleaseHdc($dc) }
  $bitmap.Save([IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.qa/screenshots/$filename")),[System.Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
}
$releaseVersion = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json).version
$installerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../dist/ChronaSetup-$releaseVersion.exe"))
# This is the interactive wizard under visual test, not a background helper.
$installerProcess = Start-Process -FilePath $installerPath -PassThru
try {
  $wizard = $null
  for ($attempt = 0; $attempt -lt 60 -and -not $wizard; $attempt++) {
    Start-Sleep -Milliseconds 250
    $condition = New-Object System.Windows.Automation.PropertyCondition ([System.Windows.Automation.AutomationElement]::ProcessIdProperty),$installerProcess.Id
    $wizard = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,$condition)
  }
  if (-not $wizard) { throw 'Installer window did not initialize.' }
  $observed = New-Object System.Collections.Generic.List[string]
  for ($step = 0; $step -lt 6; $step++) {
    $elements = $wizard.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $names = @($elements | ForEach-Object { if ($_.Current.Name) { "$($_.Current.Name) [enabled=$($_.Current.IsEnabled); type=$($_.Current.ControlType.ProgrammaticName)]" } })
    $observed.Add(($names -join ' | '))
    if ($step -eq 0) { Save-ChronaWizardImage $wizard 'installer-welcome.png' }
    if (($names -join ' ') -match 'Make Chrona yours') { Save-ChronaWizardImage $wizard 'installer-preferences.png'; break }
    $next = @($elements | Where-Object { $_.Current.Name -match '^(&)?Next' -and $_.Current.IsEnabled })
    if ($next.Count -eq 0) { break }
    $buttonHandle = [IntPtr]$next[0].Current.NativeWindowHandle
    if ($buttonHandle -eq [IntPtr]::Zero) { throw "Next button has no native handle: $($names -join ' | ')" }
    [void][ChronaWizardNative]::PostMessage($buttonHandle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 400
  }
  $report = $observed -join "`n"
  if ($report -notmatch 'Welcome to Chrona' -or $report -notmatch 'Make Chrona yours' -or $report -notmatch 'Existing Chrona settings detected') { throw "Wizard pages missing: $report" }
  $reportPath = Join-Path $PSScriptRoot '../.qa/installer-wizard.txt'
  [IO.File]::WriteAllText([IO.Path]::GetFullPath($reportPath),$report)
  Write-Output 'PASS native installer: welcome, installation location, existing-profile detection, preferences; stopped before installation.'
} finally {
  if (-not $installerProcess.HasExited) { Stop-Process -Id $installerProcess.Id -Force }
}
