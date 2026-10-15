# [desktop apps] The Windows UI Automation helper (src/desktop/client.js starts it hidden and keeps it while the AI uses other apps).
# One request per line on stdin, one answer per line on stdout, both JSON: {"id":1,"cmd":"apps"} -> {"id":1,"ok":true,...}.
# Nothing from a request is ever run as code: a command name picks one of the functions below, and every value is data.
# It never touches a password field: such a node is reported as {pw:true} with nothing else, and settext / invoke refuse one.
# It starts no program except through `launch`, and then only a shortcut or App Paths entry that `resolve` itself reported.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Web.Extensions, System.Windows.Forms, System.Drawing
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$ser.RecursionLimit = 200
$script:els = @{}
$script:seq = 0
$script:procs = @{}
$script:native = $false
$script:launchable = @{}
# A field that says it is a password (or a PIN, secret, card code) is treated as one even when the app does not report IsPassword.
$PWRE = '(?i)pass(word|code|phrase)|\bpin\b|secret|\bcvv\b|\bcvc\b|security code'
$PWTYPES = @('Edit', 'Pane', 'ComboBox', 'Document', 'Custom', 'Spinner')
$SHELL = @('Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'NotifyIconOverflowWindow', 'TopLevelWindowForOverflowXamlIsland', 'XamlExplorerHostIslandWindow', 'Windows.UI.Core.CoreWindow', 'MSCTFIME UI', 'IME', 'tooltips_class32')

# A second runspace, opened in the background, for Invoke (which can wait on a dialog): ready by the first click.
$script:rs = [runspacefactory]::CreateRunspace()
$script:rs.ApartmentState = 'MTA'
$script:rs.OpenAsync()

function Send($o) { [Console]::Out.WriteLine($ser.Serialize($o)); [Console]::Out.Flush() }

# P/Invoke is compiled the first time a screenshot or a focus needs it (about half a second), never at start.
function Ensure-Native {
  if ($script:native) { return }
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.IO; using System.Linq; using System.Runtime.InteropServices;
public static class LumenNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Init() { try { SetProcessDPIAware(); } catch { } }
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static bool Raise(long hwnd) { IntPtr h = new IntPtr(hwnd); if (IsIconic(h)) ShowWindow(h, 9); return SetForegroundWindow(h); }
  public static string Capture(long hwnd, int maxW, long quality) {
    IntPtr h = new IntPtr(hwnd); RECT r;
    if (!GetWindowRect(h, out r)) return null;
    int w = r.R - r.L, ht = r.B - r.T;
    if (w <= 0 || ht <= 0 || IsIconic(h)) return null;
    using (Bitmap full = new Bitmap(w, ht, PixelFormat.Format24bppRgb)) {
      using (Graphics g = Graphics.FromImage(full)) { IntPtr dc = g.GetHdc(); bool ok = PrintWindow(h, dc, 2); g.ReleaseHdc(dc); if (!ok) return null; }
      int nw = Math.Min(w, Math.Max(80, maxW)); int nh = Math.Max(1, (int)Math.Round((double)ht * nw / w));
      using (Bitmap small = new Bitmap(nw, nh, PixelFormat.Format24bppRgb)) {
        using (Graphics g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.Bilinear; g2.DrawImage(full, 0, 0, nw, nh); }
        ImageCodecInfo jpg = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
        EncoderParameters ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
        using (MemoryStream ms = new MemoryStream()) { small.Save(ms, jpg, ep); return Convert.ToBase64String(ms.ToArray()); }
      }
    }
  }
}
'@
  [LumenNative]::Init()
  $script:native = $true
}

function Proc-Info($procId) {
  if ($script:procs.ContainsKey($procId)) { return $script:procs[$procId] }
  $info = @{ proc = ''; exe = ''; description = '' }
  try {
    $p = [System.Diagnostics.Process]::GetProcessById([int]$procId)
    $info.proc = $p.ProcessName
    try { $info.exe = $p.MainModule.FileName } catch { }
    if ($info.exe) { try { $info.description = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($info.exe).FileDescription } catch { } }
  } catch { }
  $script:procs[$procId] = $info
  return $info
}

function Win-Element($hwnd) { return $A::FromHandle([IntPtr][int64]$hwnd) }

function Cmd-Apps($req) {
  $kids = $A::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $list = New-Object System.Collections.ArrayList
  foreach ($w in $kids) {
    try {
      $c = $w.Current
      $h = [int64]$c.NativeWindowHandle
      if ($h -eq 0) { continue }
      if ($SHELL -contains $c.ClassName) { continue }
      if (-not $c.Name) { continue }
      $pi = Proc-Info $c.ProcessId
      $min = $false
      try { $wp = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); $min = ($wp.Current.WindowVisualState -eq 'Minimized') } catch { }
      [void]$list.Add(@{ hwnd = $h; pid = [int]$c.ProcessId; proc = $pi.proc; exe = $pi.exe; description = $pi.description; title = $c.Name; minimized = $min })
    } catch { }
  }
  return @{ apps = $list.ToArray() }
}

function Cmd-Focus($req) {
  $e = Win-Element $req['hwnd']
  try { $wp = $e.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); if ($wp.Current.WindowVisualState -eq 'Minimized') { $wp.SetWindowVisualState('Normal') } } catch { }
  try { $e.SetFocus() } catch { }
  if ($req['raise']) { Ensure-Native; [void][LumenNative]::Raise([int64]$req['hwnd']) }
  Start-Sleep -Milliseconds 80
  $fg = 0; if ($script:native) { $fg = [LumenNative]::Foreground() }
  return @{ foreground = ($fg -eq [int64]$req['hwnd']) }
}

# ---- the tree
$script:nodeBudget = 0
$script:deadline = [DateTime]::MinValue
$script:truncated = $false
$script:rootOff = $false

function Pat($el, $pattern) {
  try { return $el.GetCurrentPattern($pattern) } catch { return $null }
}

function Walk-Node($el, $depth, $walker) {
  if ($script:nodeBudget -le 0 -or [DateTime]::UtcNow -gt $script:deadline) { $script:truncated = $true; return $null }
  $c = $el.Cached
  if ($c.IsPassword) { return @{ pw = $true } }   # nothing else about a password field is read
  $script:nodeBudget--
  $ct = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
  $node = @{ t = $ct }
  $name = $c.Name
  if ($name) { $node['n'] = $name.Substring(0, [Math]::Min($name.Length, 200)) }
  if ($c.AutomationId) { $node['a'] = $c.AutomationId }
  if (-not $c.IsEnabled) { $node['en'] = $false }
  if ($depth -eq 0) { $script:rootOff = [bool]$c.IsOffscreen }
  if ($c.IsOffscreen -and -not $script:rootOff) { $node['off'] = $true }
  if (-not $c.IsOffscreen -or $script:rootOff -or $depth -eq 0) {
    $letters = ''
    if ($el.GetCachedPropertyValue($A::IsInvokePatternAvailableProperty)) { $letters += 'i' }
    $hasValue = [bool]$el.GetCachedPropertyValue($A::IsValuePatternAvailableProperty)
    if ($hasValue) { $letters += 'v' }
    $hasToggle = [bool]$el.GetCachedPropertyValue($A::IsTogglePatternAvailableProperty)
    if ($hasToggle) { $letters += 't' }
    $hasSel = [bool]$el.GetCachedPropertyValue($A::IsSelectionItemPatternAvailableProperty)
    if ($hasSel) { $letters += 's' }
    $hasExp = [bool]$el.GetCachedPropertyValue($A::IsExpandCollapsePatternAvailableProperty)
    if ($hasExp) { $letters += 'e' }
    if ($hasValue -and ($ct -eq 'Edit' -or $ct -eq 'ComboBox' -or $ct -eq 'Document' -or $ct -eq 'Spinner' -or $ct -eq 'Slider')) {
      $vp = Pat $el ([System.Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { $v = $vp.Current.Value; if ($v) { $node['v'] = $v.Substring(0, [Math]::Min($v.Length, 400)) }; if ($vp.Current.IsReadOnly) { $node['ro'] = $true } }
    } elseif ($ct -eq 'Document' -or $ct -eq 'Edit') {
      $tp = Pat $el ([System.Windows.Automation.TextPattern]::Pattern)
      if ($tp) { try { $v = $tp.DocumentRange.GetText(1500); if ($v) { $node['v'] = $v } } catch { } }
    }
    if ($hasToggle) { $tg = Pat $el ([System.Windows.Automation.TogglePattern]::Pattern); if ($tg -and $tg.Current.ToggleState -eq 'On') { $node['k'] = $true } }
    if ($hasSel) { $sp = Pat $el ([System.Windows.Automation.SelectionItemPattern]::Pattern); if ($sp -and $sp.Current.IsSelected) { $node['s'] = $true; if ($ct -eq 'RadioButton') { $node['k'] = $true } } }
    if ($hasExp) { $ep = Pat $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern); if ($ep -and $ep.Current.ExpandCollapseState -eq 'Expanded') { $node['x'] = $true } }
    if ($letters -or $name -or $node.ContainsKey('v')) {
      $script:seq++
      $id = 'e' + $script:seq
      $script:els[$id] = $el
      $node['i'] = $id
      $node['p'] = $letters
    }
  }
  if ($depth -lt 22) {
    $kids = New-Object System.Collections.ArrayList
    try {
      $k = $walker.GetFirstChild($el, $script:cr)
      while ($k -ne $null) {
        $child = Walk-Node $k ($depth + 1) $walker
        if ($child -ne $null) { [void]$kids.Add($child) }
        if ($script:nodeBudget -le 0) { break }
        $k = $walker.GetNextSibling($k, $script:cr)
      }
    } catch { }
    if ($kids.Count) { $node['c'] = $kids.ToArray() }
  }
  return $node
}

function Cmd-Tree($req) {
  $script:els = @{}
  $script:seq = 0
  $script:nodeBudget = [int]$req['max']; if ($script:nodeBudget -le 0) { $script:nodeBudget = 700 }
  $script:deadline = [DateTime]::UtcNow.AddMilliseconds(4500)
  $script:truncated = $false
  $script:cr = New-Object System.Windows.Automation.CacheRequest
  $cr = $script:cr
  foreach ($p in @($A::NameProperty, $A::ControlTypeProperty, $A::IsPasswordProperty, $A::IsEnabledProperty, $A::IsOffscreenProperty, $A::AutomationIdProperty, $A::IsInvokePatternAvailableProperty, $A::IsValuePatternAvailableProperty, $A::IsTogglePatternAvailableProperty, $A::IsSelectionItemPatternAvailableProperty, $A::IsExpandCollapsePatternAvailableProperty)) { $cr.Add($p) }
  $cr.TreeScope = $TS::Element
  $scope = $cr.Activate()
  try {
    $root = Win-Element $req['hwnd']
    $tree = Walk-Node $root 0 ([System.Windows.Automation.TreeWalker]::ControlViewWalker)
  } finally { $scope.Dispose() }
  return @{ tree = $tree; truncated = $script:truncated }
}

# ---- acting
function Get-El($id) {
  $e = $script:els[[string]$id]
  if ($e -eq $null) { throw "No item $id. Read the app again (read_app) and use an id from that." }
  try { $ec = $e.Current; $ect = ($ec.ControlType.ProgrammaticName -replace '^ControlType\.', ''); if ($ec.IsPassword -or (($PWTYPES -contains $ect) -and (([string]$ec.Name -match $PWRE) -or ([string]$ec.AutomationId -match $PWRE)))) { throw 'That is a password field. The AI never uses these.' } } catch [System.Windows.Automation.ElementNotAvailableException] { throw "Item $id is gone. Read the app again." }
  return $e
}

function Cmd-Invoke($req) {
  $e = Get-El $req['el']
  if (-not $e.Current.IsEnabled) { throw 'That item is disabled.' }
  # Invoke can wait for a dialog it opens to close: run it on its own thread and answer after a moment either way.
  $ps = [PowerShell]::Create()
  if ($script:rs -and $script:rs.RunspaceStateInfo.State -eq 'Opened' -and $script:rs.RunspaceAvailability -eq 'Available') { $ps.Runspace = $script:rs }
  [void]$ps.AddScript({
    param($e)
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return 'toggle' }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return 'select' }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { if ($p.Current.ExpandCollapseState -eq 'Expanded') { $p.Collapse() } else { $p.Expand() }; return 'expand' }
    return 'none'
  }).AddArgument($e)
  $async = $ps.BeginInvoke()
  if (-not $async.AsyncWaitHandle.WaitOne(3500)) { return @{ method = 'invoke'; note = 'It is still working or opened a dialog that waits for an answer. Read the app again.' } }
  $method = [string]($ps.EndInvoke($async) | Select-Object -Last 1)
  $ps.Dispose()
  if ($method -ne 'none') { return @{ method = $method } }
  # No pattern: focus it and press Enter (what a keyboard user would do).
  $e.SetFocus(); Start-Sleep -Milliseconds 80
  Check-Focus ($e.Current.ProcessId)
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  return @{ method = 'keys' }
}

function Check-Focus($procId) {
  $f = $A::FocusedElement
  if ($f -eq $null -or $f.Current.ProcessId -ne $procId) { throw 'The keyboard focus is not in that app (the user may have switched away), so nothing was typed. Use focus_app and try again.' }
}

function Escape-Keys([string]$s) { return [regex]::Replace($s, '[+^%~(){}\[\]]', '{$0}') }

function Cmd-SetText($req) {
  $e = Get-El $req['el']
  $text = [string]$req['text']
  $vp = $null
  if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly) {
    if ($req['append']) { $text = [string]$vp.Current.Value + $text }
    $vp.SetValue($text)
    $method = 'value'
  } else {
    $e.SetFocus(); Start-Sleep -Milliseconds 100
    Check-Focus ($e.Current.ProcessId)
    [System.Windows.Forms.SendKeys]::SendWait((Escape-Keys $text))
    $method = 'keys'
  }
  if ($req['submit']) {
    if ($method -eq 'value') { $e.SetFocus(); Start-Sleep -Milliseconds 60; Check-Focus ($e.Current.ProcessId) }
    [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  }
  return @{ method = $method }
}

function Cmd-Keys($req) {
  $w = Win-Element $req['hwnd']
  try { $w.SetFocus() } catch { }
  Start-Sleep -Milliseconds 120
  Check-Focus ($w.Current.ProcessId)
  [System.Windows.Forms.SendKeys]::SendWait([string]$req['seq'])
  return @{ sent = $true }
}

function Cmd-Shot($req) {
  Ensure-Native
  $b64 = [LumenNative]::Capture([int64]$req['hwnd'], [int]$req['w'], [int64]$req['q'])
  if (-not $b64) { return @{ image = $null } }
  return @{ image = $b64 }
}

# ---- opening an app: only what `resolve` found (a Start menu shortcut or an App Paths entry); never a path or arguments from the request
function Cmd-Resolve($req) {
  $want = ([string]$req['name']).Trim().ToLowerInvariant()
  if (-not $want) { throw 'No app name.' }
  $found = New-Object System.Collections.ArrayList
  $dirs = @([Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('Programs'))
  $sh = New-Object -ComObject WScript.Shell
  foreach ($d in $dirs) {
    if (-not $d -or -not (Test-Path $d)) { continue }
    foreach ($f in (Get-ChildItem -Path $d -Filter '*.lnk' -Recurse -ErrorAction SilentlyContinue)) {
      $base = $f.BaseName.ToLowerInvariant()
      if ($base -eq $want -or $base.StartsWith($want) -or $base.Contains($want)) {
        $target = ''
        try { $target = $sh.CreateShortcut($f.FullName).TargetPath } catch { }
        $key = [Guid]::NewGuid().ToString('N')
        $script:launchable[$key] = $f.FullName
        [void]$found.Add(@{ key = $key; name = $f.BaseName; exe = $target; via = 'start menu'; exact = ($base -eq $want) })
      }
    }
  }
  foreach ($root in @('HKLM:', 'HKCU:')) {
    $k = "$root\Software\Microsoft\Windows\CurrentVersion\App Paths\$want.exe"
    try {
      if (Test-Path $k) {
        $exe = (Get-ItemProperty $k).'(default)'
        if ($exe) { $key = [Guid]::NewGuid().ToString('N'); $script:launchable[$key] = $exe; [void]$found.Add(@{ key = $key; name = $want; exe = $exe; via = 'app paths'; exact = $true }) }
      }
    } catch { }
  }
  return @{ found = $found.ToArray() }
}

function Cmd-Launch($req) {
  $path = $script:launchable[[string]$req['key']]
  if (-not $path) { throw 'That app was not found by resolve.' }
  Start-Process -FilePath $path
  return @{ started = $true }
}

function Handle($req) {
  switch ([string]$req['cmd']) {
    'ping' { return @{ pong = $true } }
    'apps' { return Cmd-Apps $req }
    'focus' { return Cmd-Focus $req }
    'tree' { return Cmd-Tree $req }
    'invoke' { return Cmd-Invoke $req }
    'settext' { return Cmd-SetText $req }
    'keys' { return Cmd-Keys $req }
    'shot' { return Cmd-Shot $req }
    'resolve' { return Cmd-Resolve $req }
    'launch' { return Cmd-Launch $req }
    'quit' { exit 0 }
    default { throw "Unknown command $($req['cmd'])" }
  }
}

Send @{ t = 'hello'; v = 1; pid = $PID }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq '') { continue }
  $rid = $null
  try {
    $req = $ser.DeserializeObject($line)
    $rid = $req['id']
    $all = @(Handle $req)
    $res = $all[$all.Count - 1]
    if ($res -isnot [System.Collections.IDictionary]) { $res = @{} }
    $res['id'] = $rid
    $res['ok'] = $true
    Send $res
  } catch {
    Send @{ id = $rid; ok = $false; error = [string]$_.Exception.Message }
  }
}
