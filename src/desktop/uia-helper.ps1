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
$PWRE = '(?i)pass(word|code|phrase)|\bpin\b|secret|\btoken\b|api[ _-]?key|recovery[ _-]?code|\bcvv\b|\bcvc\b|security code'
$PWTYPES = @('Edit', 'Pane', 'ComboBox', 'Document', 'Custom', 'Spinner')
# Test seam (src/desktop tests only; the client sets this variable only in a development test run, never in a packaged Lumen):
# a request may carry test = { states: [...], sink: true, delay: ms } to script what the keyboard guard sees and to collect keys instead of sending them.
$TEST = ($env:LUMEN_DESKTOP_TEST -eq '1')
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
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, System.Text.StringBuilder name, ref uint size);
  // The image path through QueryFullProcessImageName: works where Process.MainModule is refused (elevated or other-bitness programs).
  public static string ImagePath(long pid) { IntPtr h = OpenProcess(0x1000, false, (uint)pid); if (h == IntPtr.Zero) return ""; try { System.Text.StringBuilder sb = new System.Text.StringBuilder(1024); uint n = 1024; return QueryFullProcessImageName(h, 0, sb, ref n) ? sb.ToString() : ""; } finally { CloseHandle(h); } }
  public static long ForegroundPid() { uint p; IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) return 0; GetWindowThreadProcessId(h, out p); return p; }
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

# Who a process really is: its image path, the name inside the file, its start time. Cached by pid AND start time, so a reused pid is never taken for the old program.
function Proc-Info($procId) {
  $info = @{ proc = ''; exe = ''; description = ''; original = ''; company = ''; start = 0 }
  try {
    $p = [System.Diagnostics.Process]::GetProcessById([int]$procId)
    $info.start = [int64]([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() # (milliseconds: small enough to cross JSON as an exact number)
    $key = "$procId-$($info.start)"
    if ($script:procs.ContainsKey($key)) { return $script:procs[$key] }
    $info.proc = $p.ProcessName
    try { $info.exe = $p.MainModule.FileName } catch { }
    if (-not $info.exe) { try { Ensure-Native; $info.exe = [LumenNative]::ImagePath([int64]$procId) } catch { } }
    if ($info.exe) { try { $vi = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($info.exe); $info.description = [string]$vi.FileDescription; $info.original = [string]$vi.OriginalFilename; $info.company = [string]$vi.CompanyName } catch { } }
    $script:procs[$key] = $info
  } catch { }
  return $info
}

# A top-level window's program. A packaged (UWP) app's window belongs to ApplicationFrameHost; the program is the one that owns the
# Windows.UI.Core.CoreWindow inside it. If that cannot be found the window stays "ApplicationFrameHost", which the policy refuses.
function Resolve-Window($w) {
  $c = $w.Current
  $out = @{ pid = [int]$c.ProcessId; hpid = 0; frame = $false }
  $ident = [int]$c.ProcessId
  if ($c.ClassName -eq 'ApplicationFrameWindow') {
    $out.frame = $true
    try {
      $core = $w.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'Windows.UI.Core.CoreWindow')))
      if ($core -ne $null -and [int]$core.Current.ProcessId -ne $ident) { $out.hpid = [int]$core.Current.ProcessId; $ident = $out.hpid }
    } catch { }
  }
  $out.info = Proc-Info $ident
  return $out
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
      $rw = Resolve-Window $w
      $pi = $rw.info
      $min = $false
      try { $wp = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern); $min = ($wp.Current.WindowVisualState -eq 'Minimized') } catch { }
      [void]$list.Add(@{ hwnd = $h; pid = $rw.pid; hpid = $rw.hpid; frame = $rw.frame; start = $pi.start; proc = $pi.proc; exe = $pi.exe; original = $pi.original; company = $pi.company; description = $pi.description; title = $c.Name; minimized = $min })
    } catch { }
  }
  return @{ apps = $list.ToArray() }
}

# Every call that acts on, reads or captures a window names the program it was approved for (pid, hosted pid, start time); if the window now
# belongs to anything else (the handle was reused, the pid was), nothing is done. Returns the window element and the pids that may hold the keyboard.
function Get-Target($req) {
  $e = Win-Element $req['hwnd']
  if ($req['pid'] -ne $null -and [int]$req['pid'] -ne [int]$e.Current.ProcessId) { throw 'That window now belongs to a different program. Call list_apps again.' }
  if ($req['start']) {
    $rw = Resolve-Window $e
    if ([int]$rw.hpid -ne [int]$req['hpid'] -or [int64]$rw.info.start -ne [int64]$req['start']) { throw 'That window now belongs to a different program. Call list_apps again.' }
  }
  $pids = @([int]$e.Current.ProcessId)
  if ($req['hpid']) { $pids += [int]$req['hpid'] }
  return @{ el = $e; pids = $pids }
}

function Cmd-Focus($req) {
  $t = Get-Target $req
  $e = $t.el
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

# A field is a password when the app says so (IsPassword) or when it calls itself one: its own name or automation id, or its label.
function Test-PwText([string]$ct, [string]$name, [string]$aid, [string]$label) {
  if ($PWTYPES -notcontains $ct) { return $false }
  return (($name -match $PWRE) -or ($aid -match $PWRE) -or ($label -match $PWRE))
}
function Label-Of($el) {
  try { $lb = $el.Current.LabeledBy; if ($lb -ne $null) { return [string]$lb.Current.Name } } catch { }
  return ''
}
function Test-PwElement($el) {
  try {
    $ec = $el.Current
    if ($ec.IsPassword) { return $true }
    $ct = ($ec.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    if ($PWTYPES -notcontains $ct) { return $false }
    return (Test-PwText $ct ([string]$ec.Name) ([string]$ec.AutomationId) (Label-Of $el))
  } catch { return $true }
}

function Pat($el, $pattern) {
  try { return $el.GetCurrentPattern($pattern) } catch { return $null }
}

function Walk-Node($el, $depth, $walker) {
  if ($script:nodeBudget -le 0 -or [DateTime]::UtcNow -gt $script:deadline) { $script:truncated = $true; return $null }
  $c = $el.Cached
  if ($c.IsPassword) { return @{ pw = $true } }   # nothing else about a password field is read
  $script:nodeBudget--
  $ct = ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '')
  if ($PWTYPES -contains $ct) { if (Test-PwText $ct ([string]$c.Name) ([string]$c.AutomationId) (Label-Of $el)) { return @{ pw = $true } } } # reads follow the same rule as acts
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
  $null = Get-Target $req
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
  try { if (Test-PwElement $e) { throw 'That is a password field. The AI never uses these.' } } catch [System.Windows.Automation.ElementNotAvailableException] { throw "Item $id is gone. Read the app again." }
  return $e
}

# What the keyboard guard sees right before keys are sent: which program has the foreground, which element has the focus, whether it is a password.
function Get-InputState($req) {
  if ($TEST -and $req['test'] -and $req['test']['states']) {
    $q = $script:testStates
    if ($q -eq $null -or $script:testStatesFor -ne $req['id']) { $script:testStates = [System.Collections.ArrayList]@($req['test']['states']); $script:testStatesFor = $req['id']; $q = $script:testStates }
    $st = $q[0]; if ($q.Count -gt 1) { $q.RemoveAt(0) }
    $fpid = 0; try { $fpid = [int](Win-Element $st['hwnd']).Current.ProcessId } catch { }
    return @{ fgPid = $fpid; focusPid = $fpid; password = [bool]$st['password'] }
  }
  Ensure-Native
  $f = $A::FocusedElement
  $fp = 0; $pw = $false
  if ($f -ne $null) { $fp = [int]$f.Current.ProcessId; $pw = (Test-PwElement $f) }
  return @{ fgPid = [int][LumenNative]::ForegroundPid(); focusPid = $fp; password = $pw }
}

function Escape-Keys([string]$s) { $s = $s -replace "`r`n|`r", "`n"; return [regex]::Replace($s, '[+^%~(){}\[\]\n]', { param($m) if ($m.Value -eq "`n") { '{ENTER}' } else { '{' + $m.Value + '}' } }) }

# Text in pieces of at most 16 characters (never splitting a surrogate pair), each already escaped for SendKeys.
function Split-Text([string]$text) {
  $out = New-Object System.Collections.ArrayList
  $i = 0
  while ($i -lt $text.Length) {
    $n = [Math]::Min(16, $text.Length - $i)
    if ($n -lt $text.Length - $i -and [char]::IsHighSurrogate($text[$i + $n - 1])) { $n-- }
    $piece = $text.Substring($i, $n)
    [void]$out.Add(@{ keys = (Escape-Keys $piece); n = $n })
    $i += $n
  }
  return $out
}

# Sends the pieces one at a time. Before EACH piece: the foreground window must belong to the approved program, the keyboard focus must be in it,
# and the focused element must not be a password field. The first piece that fails stops everything; what was typed so far is reported.
function Send-Guarded($pieces, $pids, $req) {
  $sent = 0; $total = 0; foreach ($p in $pieces) { $total += $p.n }
  $why = ''
  $sink = New-Object System.Collections.ArrayList
  foreach ($p in $pieces) {
    $st = Get-InputState $req
    if ($pids -notcontains [int]$st.fgPid) { $why = 'focus'; break }
    if ($pids -notcontains [int]$st.focusPid) { $why = 'focus'; break }
    if ($st.password) { $why = 'password'; break }
    if ($TEST -and $req['test'] -and $req['test']['sink']) { [void]$sink.Add($p.keys) } else { [System.Windows.Forms.SendKeys]::SendWait($p.keys) }
    $sent += $p.n
    if ($TEST -and $req['test'] -and $req['test']['delay']) { Start-Sleep -Milliseconds ([int]$req['test']['delay']) }
  }
  return @{ sent = $sent; total = $total; stopped = $why; sink = $sink.ToArray() }
}
function Refuse-Partial($r) {
  $tail = ''
  if ($TEST) { $tail = ' [sink: ' + ($r.sink -join '') + ']' } # (test runs only: what would have been typed, so a test can see the rest was not)
  if ($r.stopped -eq 'password') { throw "Stopped: the keyboard focus moved to a password field, which the AI never types into. $($r.sent) of $($r.total) characters were typed before that. The rest was NOT typed.$tail" }
  if ($r.stopped) { throw "Stopped: the keyboard focus left the app (the user or another window took it). $($r.sent) of $($r.total) characters were typed before that. The rest was NOT typed. Use focus_app and check the app before trying again.$tail" }
}

function Cmd-Invoke($req) {
  $t = Get-Target $req
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
  # No pattern: focus it and press Enter (what a keyboard user would do), guarded like any other keys.
  $e.SetFocus(); Start-Sleep -Milliseconds 80
  $r = Send-Guarded @(@{ keys = '{ENTER}'; n = 1 }) $t.pids $req
  Refuse-Partial $r
  return @{ method = 'keys' }
}

function Cmd-SetText($req) {
  $t = Get-Target $req
  $e = Get-El $req['el']
  $text = [string]$req['text']
  $vp = $null
  $forceKeys = ($TEST -and $req['forceKeys'])
  if (-not $forceKeys -and $e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp) -and -not $vp.Current.IsReadOnly) {
    if ($req['append']) { $text = [string]$vp.Current.Value + $text }
    $vp.SetValue($text)
    $method = 'value'
    $res = @{ method = $method }
  } else {
    if ($text.Length -gt 500) { throw 'This field has no way to be set directly, and typing key by key is limited to 500 characters. Type it in smaller parts.' }
    $e.SetFocus(); Start-Sleep -Milliseconds 100
    $r = Send-Guarded (Split-Text $text) $t.pids $req
    Refuse-Partial $r
    $method = 'keys'
    $res = @{ method = $method; sink = $r.sink }
  }
  if ($req['submit']) {
    $e.SetFocus(); Start-Sleep -Milliseconds 60
    $r2 = Send-Guarded @(@{ keys = '{ENTER}'; n = 1 }) $t.pids $req
    Refuse-Partial $r2
  }
  return $res
}

function Cmd-Keys($req) {
  $t = Get-Target $req
  try { $t.el.SetFocus() } catch { }
  Start-Sleep -Milliseconds 120
  $pieces = New-Object System.Collections.ArrayList
  foreach ($k in $req['chords']) { [void]$pieces.Add(@{ keys = [string]$k; n = 1 }) }
  $r = Send-Guarded $pieces $t.pids $req
  Refuse-Partial $r
  return @{ sent = $r.sent; sink = $r.sink }
}

function Cmd-Shot($req) {
  $null = Get-Target $req
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
      if ($base -eq $want -or $base.StartsWith($want)) {
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
