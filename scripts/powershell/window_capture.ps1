# window_capture.ps1 — Capture the Adobe InDesign window to a PNG.
#
# Finds the first visible InDesign window (title contains "Adobe InDesign"),
# captures it via GDI BitBlt, writes a PNG to -OutPath, and prints a one-line
# JSON summary on stdout so the Node side can parse bounds + path.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File window_capture.ps1 -OutPath "<path>.png"
#   powershell -ExecutionPolicy Bypass -File window_capture.ps1 -OutPath "<path>.png" -Region right -PanelWidth 320
#
# Region values:
#   full   — the whole InDesign window (default)
#   right  — rightmost N pixels of the window (where panels dock); uses -PanelWidth
#
# Exit codes:
#   0 success
#   2 no InDesign window found
#   3 capture failed
#
# The script is read-only on the OS; it never clicks or types.

param(
  [Parameter(Mandatory = $true)] [string] $OutPath,
  [ValidateSet('full', 'right')] [string] $Region = 'full',
  [int] $PanelWidth = 340,
  [string] $TitleMatch = 'Adobe InDesign'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$signature = @'
using System;
using System.Runtime.InteropServices;

public class Win32 {
  [DllImport("user32.dll")]
  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool IsIconic(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc enumFunc, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@

if (-not ('Win32' -as [type])) { Add-Type -TypeDefinition $signature }

function Find-InDesignWindow([string] $match) {
  $found = @()
  $enum = [Win32+EnumWindowsProc] {
    param($hWnd, $lParam)
    if (-not [Win32]::IsWindowVisible($hWnd)) { return $true }
    if ([Win32]::IsIconic($hWnd)) { return $true }
    $len = [Win32]::GetWindowTextLength($hWnd)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $title = $sb.ToString()
    if ($title -like "*$match*") {
      $script:found += [pscustomobject]@{ Handle = $hWnd; Title = $title }
    }
    return $true
  }
  [void][Win32]::EnumWindows($enum, [IntPtr]::Zero)
  return $found
}

$windows = Find-InDesignWindow $TitleMatch
if ($windows.Count -eq 0) {
  Write-Output '{"success":false,"error":"no InDesign window found","code":"NO_WINDOW"}'
  exit 2
}

# Prefer the foreground window if it's one of ours; else the first match.
$fg = [Win32]::GetForegroundWindow()
$target = $windows | Where-Object { $_.Handle -eq $fg } | Select-Object -First 1
if ($null -eq $target) { $target = $windows[0] }

$rect = New-Object Win32+RECT
if (-not [Win32]::GetWindowRect($target.Handle, [ref]$rect)) {
  Write-Output '{"success":false,"error":"GetWindowRect failed","code":"RECT_FAIL"}'
  exit 3
}

$winLeft = $rect.Left
$winTop = $rect.Top
$winWidth = $rect.Right - $rect.Left
$winHeight = $rect.Bottom - $rect.Top

switch ($Region) {
  'right' {
    $captureWidth = [Math]::Min($PanelWidth, $winWidth)
    $captureLeft = $winLeft + $winWidth - $captureWidth
    $captureTop = $winTop
    $captureHeight = $winHeight
  }
  default {
    $captureLeft = $winLeft
    $captureTop = $winTop
    $captureWidth = $winWidth
    $captureHeight = $winHeight
  }
}

if ($captureWidth -le 0 -or $captureHeight -le 0) {
  Write-Output '{"success":false,"error":"invalid capture region","code":"BAD_REGION"}'
  exit 3
}

$outDir = Split-Path -Parent $OutPath
if ($outDir -and -not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$bmp = New-Object System.Drawing.Bitmap $captureWidth, $captureHeight
try {
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  try {
    $g.CopyFromScreen($captureLeft, $captureTop, 0, 0, (New-Object System.Drawing.Size $captureWidth, $captureHeight))
  }
  finally { $g.Dispose() }
  $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally { $bmp.Dispose() }

$summary = [pscustomobject]@{
  success     = $true
  outPath     = $OutPath
  region      = $Region
  windowTitle = $target.Title
  windowBounds = @{
    left   = $winLeft
    top    = $winTop
    width  = $winWidth
    height = $winHeight
  }
  captureBounds = @{
    left   = $captureLeft
    top    = $captureTop
    width  = $captureWidth
    height = $captureHeight
  }
}
$summary | ConvertTo-Json -Compress
exit 0
