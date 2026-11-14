# ui_automation.ps1 — Drive the Adobe InDesign window via Windows input APIs.
#
# Reads a JSON array of actions from -ActionsPath (a file) and executes each
# in order against the InDesign window. Emits one JSON summary line on stdout
# so the Node side can parse results.
#
# Actions (each object's 'type' field):
#   focus                       — find and foreground the InDesign window
#   sleep   { ms }              — wait N ms (default 120)
#   move    { x, y }            — move cursor to absolute screen coords
#   click   { x, y, button?, double?, modifier? }
#                                 — move + left/right click (button: left|right)
#                                   modifier: shift|ctrl|alt|cmd (one at a time)
#   type    { text }            — send Unicode text as keystrokes
#   key     { name }            — press a named key once
#                                 (enter, tab, escape, backspace, delete,
#                                  left, right, up, down, home, end,
#                                  f1..f12, pageup, pagedown)
#   wheel   { x, y, delta }     — scroll wheel at coords (delta: +120 up / −120 down)
#
# Safety:
#   • Every click/move/wheel validates coords against -Bounds when given
#     (JSON: {left,top,width,height}). Out-of-bounds actions abort the batch.
#   • If $env:INDESIGN_MCP_UI_DISABLE is '1', the script does nothing and
#     reports {success:false, code:"UI_DISABLED"}.
#   • Default 120 ms delay between actions unless overridden.

param(
  [Parameter(Mandatory = $true)] [string] $ActionsPath,
  [string] $Bounds,
  [string] $TitleMatch = 'Adobe InDesign',
  [int] $DefaultSleepMs = 120
)

$ErrorActionPreference = 'Stop'

if ($env:INDESIGN_MCP_UI_DISABLE -eq '1') {
  Write-Output '{"success":false,"error":"UI automation is disabled via INDESIGN_MCP_UI_DISABLE=1","code":"UI_DISABLED"}'
  exit 4
}

Add-Type -AssemblyName System.Windows.Forms

$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class UIA {
  [DllImport("user32.dll")]  public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")]  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")]  public static extern uint SendInput(uint nInputs, [In] INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")]  public static extern IntPtr GetMessageExtraInfo();
  [DllImport("user32.dll")]  public static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")]  public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")]  public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")]  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")]  public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")]  public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")]  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")]  public static extern bool EnumWindows(EnumWindowsProc enumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")]  public static extern int GetWindowTextLength(IntPtr hWnd);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
    public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
    public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo;
  }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT {
    public uint uMsg; public ushort wParamL, wParamH;
  }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT {
    public uint type; public INPUTUNION u;
  }

  public const uint INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP     = 0x0002;
  public const uint KEYEVENTF_UNICODE   = 0x0004;
  public const uint KEYEVENTF_SCANCODE  = 0x0008;
  public const uint KEYEVENTF_EXTENDED  = 0x0001;

  public const uint MOUSEEVENTF_LEFTDOWN   = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP     = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN  = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP    = 0x0010;
  public const uint MOUSEEVENTF_WHEEL      = 0x0800;
}
'@
if (-not ('UIA' -as [type])) { Add-Type -TypeDefinition $signature }

# --- Window finding ---------------------------------------------------------

function Find-InDesignWindow([string] $match) {
  $found = @()
  $enum = [UIA+EnumWindowsProc] {
    param($hWnd, $lParam)
    if (-not [UIA]::IsWindowVisible($hWnd)) { return $true }
    if ([UIA]::IsIconic($hWnd)) { return $true }
    $len = [UIA]::GetWindowTextLength($hWnd)
    if ($len -le 0) { return $true }
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [void][UIA]::GetWindowText($hWnd, $sb, $sb.Capacity)
    $t = $sb.ToString()
    if ($t -like "*$match*") {
      $script:found += [pscustomobject]@{ Handle = $hWnd; Title = $t }
    }
    return $true
  }
  [void][UIA]::EnumWindows($enum, [IntPtr]::Zero)
  return $found
}

function Focus-InDesign {
  $wins = Find-InDesignWindow $TitleMatch
  if ($wins.Count -eq 0) { return $null }
  $target = $wins[0]
  [void][UIA]::ShowWindow($target.Handle, 9) # SW_RESTORE
  [void][UIA]::SetForegroundWindow($target.Handle)
  $rect = New-Object UIA+RECT
  [void][UIA]::GetWindowRect($target.Handle, [ref]$rect)
  return [pscustomobject]@{
    Handle = $target.Handle
    Title  = $target.Title
    Bounds = @{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
  }
}

# --- Bounds check -----------------------------------------------------------

$boundsObj = $null
if ($Bounds) { $boundsObj = $Bounds | ConvertFrom-Json }

function Assert-InBounds($x, $y) {
  if ($null -eq $boundsObj) { return $true }
  $l = [int]$boundsObj.left
  $t = [int]$boundsObj.top
  $w = [int]$boundsObj.width
  $h = [int]$boundsObj.height
  return ($x -ge $l -and $y -ge $t -and $x -lt ($l + $w) -and $y -lt ($t + $h))
}

# --- Input primitives -------------------------------------------------------

function Send-MouseButton([string] $button, [bool] $down) {
  $flag = switch ("$button-$down") {
    'left-True'   { [UIA]::MOUSEEVENTF_LEFTDOWN }
    'left-False'  { [UIA]::MOUSEEVENTF_LEFTUP }
    'right-True'  { [UIA]::MOUSEEVENTF_RIGHTDOWN }
    'right-False' { [UIA]::MOUSEEVENTF_RIGHTUP }
    default       { 0 }
  }
  if ($flag -eq 0) { return }
  [UIA]::mouse_event($flag, 0, 0, 0, [UIntPtr]::Zero)
}

function Send-Wheel([int] $delta) {
  [UIA]::mouse_event([UIA]::MOUSEEVENTF_WHEEL, 0, 0, [uint32]$delta, [UIntPtr]::Zero)
}

$KEY_MAP = @{
  'enter'     = 0x0D; 'return' = 0x0D
  'tab'       = 0x09; 'escape' = 0x1B; 'esc' = 0x1B
  'backspace' = 0x08; 'delete' = 0x2E
  'left'      = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28
  'home'      = 0x24; 'end' = 0x23
  'pageup'    = 0x21; 'pagedown' = 0x22
  'space'     = 0x20
  'f1' = 0x70; 'f2' = 0x71; 'f3' = 0x72; 'f4' = 0x73
  'f5' = 0x74; 'f6' = 0x75; 'f7' = 0x76; 'f8' = 0x77
  'f9' = 0x78; 'f10' = 0x79; 'f11' = 0x7A; 'f12' = 0x7B
}
$MOD_MAP = @{ 'shift' = 0x10; 'ctrl' = 0x11; 'alt' = 0x12; 'cmd' = 0x5B }

function Send-VK([ushort] $vk, [bool] $up, [bool] $extended) {
  $i = New-Object UIA+INPUT
  $i.type = [UIA]::INPUT_KEYBOARD
  $k = New-Object UIA+KEYBDINPUT
  $k.wVk = $vk
  $flags = 0
  if ($up) { $flags = $flags -bor [UIA]::KEYEVENTF_KEYUP }
  if ($extended) { $flags = $flags -bor [UIA]::KEYEVENTF_EXTENDED }
  $k.dwFlags = $flags
  $k.dwExtraInfo = [UIA]::GetMessageExtraInfo()
  $i.u.ki = $k
  [UIA]::SendInput(1, @($i), [System.Runtime.InteropServices.Marshal]::SizeOf([type][UIA+INPUT])) | Out-Null
}

function Send-Key([string] $name) {
  $lname = $name.ToLower()
  if (-not $KEY_MAP.ContainsKey($lname)) { throw "unknown key: $name" }
  $vk = [ushort] $KEY_MAP[$lname]
  $extended = @('left','up','right','down','home','end','pageup','pagedown','delete') -contains $lname
  Send-VK $vk $false $extended
  Send-VK $vk $true  $extended
}

function Send-UnicodeChar([char] $ch) {
  $down = New-Object UIA+INPUT
  $down.type = [UIA]::INPUT_KEYBOARD
  $kd = New-Object UIA+KEYBDINPUT
  $kd.wScan = [ushort]$ch
  $kd.dwFlags = [UIA]::KEYEVENTF_UNICODE
  $kd.dwExtraInfo = [UIA]::GetMessageExtraInfo()
  $down.u.ki = $kd

  $up = New-Object UIA+INPUT
  $up.type = [UIA]::INPUT_KEYBOARD
  $ku = New-Object UIA+KEYBDINPUT
  $ku.wScan = [ushort]$ch
  $ku.dwFlags = [UIA]::KEYEVENTF_UNICODE -bor [UIA]::KEYEVENTF_KEYUP
  $ku.dwExtraInfo = [UIA]::GetMessageExtraInfo()
  $up.u.ki = $ku

  [UIA]::SendInput(2, @($down, $up), [System.Runtime.InteropServices.Marshal]::SizeOf([type][UIA+INPUT])) | Out-Null
}

function Send-Text([string] $text) {
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq "`r") { continue }
    if ($ch -eq "`n") { Send-Key 'enter'; continue }
    Send-UnicodeChar $ch
  }
}

# --- Execute actions --------------------------------------------------------

$actionsJson = Get-Content -Raw -LiteralPath $ActionsPath
$actions = @()
if ($actionsJson) { $actions = $actionsJson | ConvertFrom-Json }
if ($null -eq $actions) { $actions = @() }
if ($actions -isnot [System.Array]) { $actions = @($actions) }

$log = @()
$focused = $null

try {
  foreach ($a in $actions) {
    $type = ($a.type).ToString().ToLower()
    switch ($type) {
      'focus' {
        $focused = Focus-InDesign
        if ($null -eq $focused) { throw "no InDesign window found" }
        $log += [pscustomobject]@{ type = 'focus'; title = $focused.Title; bounds = $focused.Bounds }
        Start-Sleep -Milliseconds $DefaultSleepMs
      }
      'sleep' {
        $ms = if ($null -ne $a.ms) { [int]$a.ms } else { $DefaultSleepMs }
        Start-Sleep -Milliseconds $ms
        $log += [pscustomobject]@{ type = 'sleep'; ms = $ms }
      }
      'move' {
        $x = [int]$a.x; $y = [int]$a.y
        if (-not (Assert-InBounds $x $y)) { throw "move ($x,$y) out of bounds" }
        [void][UIA]::SetCursorPos($x, $y)
        $log += [pscustomobject]@{ type = 'move'; x = $x; y = $y }
        Start-Sleep -Milliseconds 20
      }
      'click' {
        $x = [int]$a.x; $y = [int]$a.y
        if (-not (Assert-InBounds $x $y)) { throw "click ($x,$y) out of bounds" }
        $button = if ($a.button) { ($a.button).ToString() } else { 'left' }
        $double = [bool]$a.double
        $modifier = if ($a.modifier) { ($a.modifier).ToString().ToLower() } else { $null }
        [void][UIA]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 40
        if ($modifier -and $MOD_MAP.ContainsKey($modifier)) {
          Send-VK ([ushort]$MOD_MAP[$modifier]) $false $false
        }
        Send-MouseButton $button $true
        Start-Sleep -Milliseconds 30
        Send-MouseButton $button $false
        if ($double) {
          Start-Sleep -Milliseconds 50
          Send-MouseButton $button $true
          Start-Sleep -Milliseconds 30
          Send-MouseButton $button $false
        }
        if ($modifier -and $MOD_MAP.ContainsKey($modifier)) {
          Send-VK ([ushort]$MOD_MAP[$modifier]) $true $false
        }
        $log += [pscustomobject]@{ type = 'click'; x = $x; y = $y; button = $button; double = $double; modifier = $modifier }
        Start-Sleep -Milliseconds $DefaultSleepMs
      }
      'type' {
        $text = [string]$a.text
        Send-Text $text
        $log += [pscustomobject]@{ type = 'type'; chars = $text.Length }
        Start-Sleep -Milliseconds $DefaultSleepMs
      }
      'key' {
        $name = [string]$a.name
        Send-Key $name
        $log += [pscustomobject]@{ type = 'key'; name = $name }
        Start-Sleep -Milliseconds $DefaultSleepMs
      }
      'wheel' {
        $x = [int]$a.x; $y = [int]$a.y
        if (-not (Assert-InBounds $x $y)) { throw "wheel ($x,$y) out of bounds" }
        [void][UIA]::SetCursorPos($x, $y)
        Start-Sleep -Milliseconds 20
        Send-Wheel ([int]$a.delta)
        $log += [pscustomobject]@{ type = 'wheel'; x = $x; y = $y; delta = [int]$a.delta }
        Start-Sleep -Milliseconds $DefaultSleepMs
      }
      default { throw "unknown action type: $type" }
    }
  }
}
catch {
  $result = [pscustomobject]@{
    success = $false
    error = $_.Exception.Message
    code = 'ACTION_FAILED'
    completed = $log
  }
  $result | ConvertTo-Json -Depth 6 -Compress
  exit 3
}

[pscustomobject]@{ success = $true; completed = $log } | ConvertTo-Json -Depth 6 -Compress
exit 0
