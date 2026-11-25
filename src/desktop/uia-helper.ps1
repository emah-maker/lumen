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
using System; using System.Diagnostics; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.IO; using System.Linq; using System.Runtime.InteropServices;
public static class LumenNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder sb, int max);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
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
  // ---- the live picture of the card (the "frame" command): the window scaled to the card, compared with the last picture sent, a JPEG only when it changed
  public class FrameResult { public string Image, Skip; public bool Same; public int W, H; public long Ms; }
  static byte[] prevPix; static long prevHwnd; static int prevW, prevH;
  static Bitmap fullBmp; static int fullW, fullH;
  public static long OwnerPid(long hwnd) { IntPtr h = new IntPtr(hwnd); if (!IsWindow(h)) return 0; uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static string Title(long hwnd) { System.Text.StringBuilder sb = new System.Text.StringBuilder(512); GetWindowText(new IntPtr(hwnd), sb, 512); return sb.ToString(); }
  public static FrameResult Frame(long hwnd, int maxW, long quality, bool reset) {
    Stopwatch sw = Stopwatch.StartNew();
    FrameResult res = new FrameResult(); IntPtr h = new IntPtr(hwnd); RECT r;
    if (IsIconic(h)) { res.Skip = "minimized"; return res; }
    int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
    if (!IsWindowVisible(h) || cloaked != 0) { res.Skip = "hidden"; return res; }
    if (!GetWindowRect(h, out r)) { res.Skip = "hidden"; return res; }
    int w = r.R - r.L, ht = r.B - r.T;
    if (w <= 0 || ht <= 0) { res.Skip = "hidden"; return res; }
    if (fullBmp == null || fullW != w || fullH != ht) { if (fullBmp != null) fullBmp.Dispose(); fullBmp = new Bitmap(w, ht, PixelFormat.Format24bppRgb); fullW = w; fullH = ht; }
    using (Graphics g = Graphics.FromImage(fullBmp)) { IntPtr dc = g.GetHdc(); bool ok = PrintWindow(h, dc, 2); g.ReleaseHdc(dc); if (!ok) { res.Skip = "hidden"; return res; } } // 2 = PW_RENDERFULLCONTENT
    int nw = Math.Min(w, Math.Max(80, maxW)); int nh = Math.Max(1, (int)Math.Round((double)ht * nw / w));
    using (Bitmap small = new Bitmap(nw, nh, PixelFormat.Format24bppRgb)) {
      using (Graphics g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.Bilinear; g2.DrawImage(fullBmp, 0, 0, nw, nh); }
      BitmapData bd = small.LockBits(new Rectangle(0, 0, nw, nh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      int stride = bd.Stride; byte[] cur = new byte[stride * nh];
      System.Runtime.InteropServices.Marshal.Copy(bd.Scan0, cur, 0, cur.Length); small.UnlockBits(bd);
      if (!reset && prevPix != null && prevHwnd == hwnd && prevW == nw && prevH == nh && prevPix.Length == cur.Length) {
        // changed = at least 3 pixels that moved by more than 20 in some colour: a blinking caret or a clock second is not a change
        int count = 0;
        for (int y = 0; y < nh && count < 3; y++) { int row = y * stride; for (int x = 0; x < nw; x++) { int i = row + x * 3; if (Math.Abs(cur[i] - prevPix[i]) > 20 || Math.Abs(cur[i + 1] - prevPix[i + 1]) > 20 || Math.Abs(cur[i + 2] - prevPix[i + 2]) > 20) { if (++count >= 3) break; } } }
        if (count < 3) { res.Same = true; res.Ms = sw.ElapsedMilliseconds; return res; }
      }
      prevPix = cur; prevHwnd = hwnd; prevW = nw; prevH = nh;
      ImageCodecInfo jpg = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
      EncoderParameters ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      using (MemoryStream ms = new MemoryStream()) { small.Save(ms, jpg, ep); res.Image = Convert.ToBase64String(ms.ToArray()); }
      res.W = nw; res.H = nh; res.Ms = sw.ElapsedMilliseconds; return res;
    }
  }
  // A picture of the window: the JPEG, its size, and the window's size when it was taken (click_at maps the picture's pixels back onto the window with them).
  public class Shot { public string Image; public int W, H, RW, RH; }
  public static Shot Capture(long hwnd, int maxW, long quality) {
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
        using (MemoryStream ms = new MemoryStream()) { small.Save(ms, jpg, ep); return new Shot { Image = Convert.ToBase64String(ms.ToArray()), W = nw, H = nh, RW = w, RH = ht }; }
      }
    }
  }
  // ---- the mouse (the "mouse" command): where a window is, which program owns the window at a screen point, and SendInput
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; } // (MOUSEINPUT is the union's largest member, so the size is right on x86 and x64)
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static int[] Rect(long hwnd) { IntPtr h = new IntPtr(hwnd); RECT r; if (!IsWindow(h) || IsIconic(h) || !GetWindowRect(h, out r)) return null; return new int[] { r.L, r.T, r.R, r.B }; }
  // The program whose top-level window is at this screen point (GA_ROOT), so a click is only sent where the approved program would get it.
  public static long PidAt(int x, int y) { POINT p; p.X = x; p.Y = y; IntPtr w = WindowFromPoint(p); if (w == IntPtr.Zero) return 0; IntPtr root = GetAncestor(w, 2); uint pid; GetWindowThreadProcessId(root == IntPtr.Zero ? w : root, out pid); return pid; }
  static void Send(uint flags, int dx, int dy, uint data) { INPUT[] i = new INPUT[1]; i[0].type = 0; i[0].mi.dx = dx; i[0].mi.dy = dy; i[0].mi.flags = flags; i[0].mi.data = data; SendInput(1, i, Marshal.SizeOf(typeof(INPUT))); }
  public static void Move(int x, int y) { // absolute, over the whole virtual desktop (every monitor)
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = Math.Max(2, GetSystemMetrics(78)), vh = Math.Max(2, GetSystemMetrics(79));
    Send(0x0001 | 0x8000 | 0x4000, (int)Math.Round((x - vx) * 65535.0 / (vw - 1)), (int)Math.Round((y - vy) * 65535.0 / (vh - 1)), 0);
  }
  public static void Button(string b, bool down) { uint f = b == "right" ? (down ? 0x0008u : 0x0010u) : b == "middle" ? (down ? 0x0020u : 0x0040u) : (down ? 0x0002u : 0x0004u); Send(f, 0, 0, 0); }
  public static void Wheel(int delta, bool horizontal) { Send(horizontal ? 0x01000u : 0x0800u, 0, 0, unchecked((uint)delta)); }
  // ---- without the system pointer: window messages posted to the window at a point (the person's mouse never moves)
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern IntPtr ChildWindowFromPointEx(IntPtr h, POINT p, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder sb, int max);
  // The deepest visible child of the approved window at a screen point (CWP_SKIPINVISIBLE | CWP_SKIPTRANSPARENT): the window a click there
  // reaches, found from the app's own window down, so another window covering the spot is never the one written to.
  public static long DeepChild(long hwnd, int x, int y) {
    IntPtr h = new IntPtr(hwnd);
    for (int i = 0; i < 32; i++) { POINT p; p.X = x; p.Y = y; ScreenToClient(h, ref p); IntPtr c = ChildWindowFromPointEx(h, p, 0x0001 | 0x0004); if (c == IntPtr.Zero || c == h) break; h = c; }
    return h.ToInt64();
  }
  public static string ClassOf(long hwnd) { System.Text.StringBuilder sb = new System.Text.StringBuilder(256); GetClassName(new IntPtr(hwnd), sb, 256); return sb.ToString(); }
  static IntPtr Pack(int x, int y) { return new IntPtr(unchecked((int)(((uint)(y & 0xffff) << 16) | (uint)(x & 0xffff)))); }
  // Button and move messages carry the point in the window's client coordinates; the wheel carries it in screen coordinates.
  public static bool PostClient(long hwnd, uint msg, uint wp, int sx, int sy) { IntPtr h = new IntPtr(hwnd); POINT p; p.X = sx; p.Y = sy; ScreenToClient(h, ref p); return PostMessage(h, msg, new IntPtr((long)wp), Pack(p.X, p.Y)); }
  public static bool PostScreen(long hwnd, uint msg, uint wp, int sx, int sy) { return PostMessage(new IntPtr(hwnd), msg, new IntPtr((long)wp), Pack(sx, sy)); }
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

# Invoke, Toggle, Select (and Expand when asked) on an element, on its own thread: Invoke can wait for a dialog it opens to close, so the
# answer comes after a moment either way ('pending'). 'none': the element has none of these.
function Invoke-Patterns($e, [bool]$expand) {
  $ps = [PowerShell]::Create()
  if ($script:rs -and $script:rs.RunspaceStateInfo.State -eq 'Opened' -and $script:rs.RunspaceAvailability -eq 'Available') { $ps.Runspace = $script:rs }
  [void]$ps.AddScript({
    param($e, $expand)
    $p = $null
    if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); return 'invoke' }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); return 'toggle' }
    if ($e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); return 'select' }
    if ($expand -and $e.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { if ($p.Current.ExpandCollapseState -eq 'Expanded') { $p.Collapse() } else { $p.Expand() }; return 'expand' }
    return 'none'
  }).AddArgument($e).AddArgument($expand)
  $async = $ps.BeginInvoke()
  if (-not $async.AsyncWaitHandle.WaitOne(3500)) { return 'pending' }
  $method = [string]($ps.EndInvoke($async) | Select-Object -Last 1)
  $ps.Dispose()
  return $method
}

# Where an element is in its window, as fractions of the window (both rectangles come from UI Automation, so the display scale cancels out):
# Lumen draws the AI's cursor there (cursor.js). Empty when either rectangle is unknown.
function Frac-Of($e, $win) {
  try {
    $b = $e.Current.BoundingRectangle; $w = $win.Current.BoundingRectangle
    if ($b.IsEmpty -or $w.IsEmpty -or $w.Width -le 0 -or $w.Height -le 0) { return @{} }
    $fx = ($b.X + [Math]::Min($b.Width / 2, 40) - $w.X) / $w.Width; $fy = ($b.Y + $b.Height / 2 - $w.Y) / $w.Height
    if ($fx -lt 0 -or $fx -gt 1 -or $fy -lt 0 -or $fy -gt 1) { return @{} }
    return @{ fx = [Math]::Round($fx, 4); fy = [Math]::Round($fy, 4) }
  } catch { return @{} }
}

function Cmd-Invoke($req) {
  $t = Get-Target $req
  $e = Get-El $req['el']
  if (-not $e.Current.IsEnabled) { throw 'That item is disabled.' }
  $at = Frac-Of $e $t.el
  $method = Invoke-Patterns $e $true
  if ($method -eq 'pending') { return @{ method = 'invoke'; note = 'It is still working or opened a dialog that waits for an answer. Read the app again.'; fx = $at.fx; fy = $at.fy } }
  if ($method -ne 'none') { return @{ method = $method; fx = $at.fx; fy = $at.fy } }
  # No pattern: focus it and press Enter (what a keyboard user would do), guarded like any other keys.
  $e.SetFocus(); Start-Sleep -Milliseconds 80
  $r = Send-Guarded @(@{ keys = '{ENTER}'; n = 1 }) $t.pids $req
  Refuse-Partial $r
  return @{ method = 'keys'; fx = $at.fx; fy = $at.fy }
}

function Cmd-SetText($req) {
  $t = Get-Target $req
  $e = Get-El $req['el']
  $text = [string]$req['text']
  $at = Frac-Of $e $t.el
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
  $res['fx'] = $at.fx; $res['fy'] = $at.fy
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
  $s = [LumenNative]::Capture([int64]$req['hwnd'], [int]$req['w'], [int64]$req['q'])
  if ($s -eq $null) { return @{ image = $null } }
  return @{ image = $s.Image; w = $s.W; h = $s.H; rw = $s.RW; rh = $s.RH }
}

# Typing into whatever has the keyboard focus in the approved program (a field the AI clicked with click_at, which UI Automation may not list).
# The same guard as every other key: before each piece the foreground and the focus must be the approved program's, and never a password field.
function Cmd-TypeFocus($req) {
  $t = Get-Target $req
  $text = [string]$req['text']
  if ($text.Length -gt 500) { throw 'Typing without an item id is limited to 500 characters a call. Type it in smaller parts.' }
  $r = Send-Guarded (Split-Text $text) $t.pids $req
  Refuse-Partial $r
  if ($req['submit']) { $r2 = Send-Guarded @(@{ keys = '{ENTER}'; n = 1 }) $t.pids $req; Refuse-Partial $r2 }
  return @{ method = 'keys'; sink = $r.sink }
}

# click_at, drag and scroll. The points are in the pixels of the last screenshot_app picture (pw x ph) of a window that was rw x rh then;
# they are mapped onto the window where it is now. Nothing is sent unless every point is inside the window AND the window at that screen
# point belongs to the approved program (so a click can never land in another app, a blocked one, or Lumen's banner). If another window
# covers a point, the app is raised once and checked again.
function Cmd-Mouse($req) {
  $t = Get-Target $req
  Ensure-Native
  $hwnd = [int64]$req['hwnd']
  $r = [LumenNative]::Rect($hwnd)
  if ($r -eq $null) { throw 'That window is minimized or hidden. Use focus_app, then screenshot_app.' }
  $w = $r[2] - $r[0]; $h = $r[3] - $r[1]
  if ($w -le 0 -or $h -le 0) { throw 'That window is minimized or hidden. Use focus_app, then screenshot_app.' }
  if ([Math]::Abs($w - [int]$req['rw']) -gt 2 -or [Math]::Abs($h - [int]$req['rh']) -gt 2) { throw 'The window changed size since the last screenshot_app, so the point would be wrong. Take a new screenshot first.' }
  $pw = [double]$req['pw']; $ph = [double]$req['ph']
  if ($pw -le 0 -or $ph -le 0) { throw 'Take a screenshot_app first.' }
  $pts = New-Object System.Collections.ArrayList
  foreach ($p in $req['points']) {
    $sx = $r[0] + [int][Math]::Floor(([double]$p[0] + 0.5) * $w / $pw)
    $sy = $r[1] + [int][Math]::Floor(([double]$p[1] + 0.5) * $h / $ph)
    $sx = [Math]::Min([Math]::Max($sx, $r[0]), $r[2] - 1); $sy = [Math]::Min([Math]::Max($sy, $r[1]), $r[3] - 1)
    [void]$pts.Add(@($sx, $sy))
  }
  $covered = { foreach ($q in $pts) { if ($t.pids -notcontains [int][LumenNative]::PidAt($q[0], $q[1])) { return $true } }; return $false }
  $button = [string]$req['button']; if (@('left', 'right', 'middle') -notcontains $button) { $button = 'left' }
  $sink = New-Object System.Collections.ArrayList
  $sinking = ($TEST -and $req['test'] -and $req['test']['sink'])
  $p0 = $pts[0]
  # Three ways, tried in this order by Lumen (src/desktop/index.js), one call each: 'uia' and 'post' never move the person's pointer;
  # 'real' does, and Lumen puts it back. A way that does not fit answers skip (with why) and nothing is sent.
  $via = [string]$req['via']; if (@('uia', 'post', 'real') -notcontains $via) { $via = 'real' }
  if ($via -eq 'uia') { return Mouse-Uia $req $t $pts $button $covered }
  if ($via -eq 'post') { return Mouse-Post $req $t $pts $button $sink $sinking }
  if (& $covered) { [void][LumenNative]::Raise($hwnd); Start-Sleep -Milliseconds 150 }
  if (& $covered) { throw 'Another window covers that point, so nothing was clicked. Use focus_app to bring the app forward, then take a new screenshot.' }
  $do = { param($op, $a, $b) if ($sinking) { [void]$sink.Add("$op $a $b") } else { switch ($op) { 'move' { [LumenNative]::Move($a, $b) } 'down' { [LumenNative]::Button($a, $true) } 'up' { [LumenNative]::Button($a, $false) } 'wheel' { [LumenNative]::Wheel($a, $b) } } } }
  switch ([string]$req['op']) {
    'click' {
      & $do 'move' $p0[0] $p0[1]; Start-Sleep -Milliseconds 40
      $n = 1; if ($req['double']) { $n = 2 }
      for ($i = 0; $i -lt $n; $i++) { & $do 'down' $button 0; & $do 'up' $button 0; Start-Sleep -Milliseconds 40 }
    }
    'drag' {
      $p1 = $pts[1]
      & $do 'move' $p0[0] $p0[1]; Start-Sleep -Milliseconds 40
      & $do 'down' $button 0; Start-Sleep -Milliseconds 80
      for ($i = 1; $i -le 12; $i++) { & $do 'move' ([int]($p0[0] + ($p1[0] - $p0[0]) * $i / 12)) ([int]($p0[1] + ($p1[1] - $p0[1]) * $i / 12)); Start-Sleep -Milliseconds 16 }
      Start-Sleep -Milliseconds 60
      & $do 'up' $button 0
    }
    'scroll' {
      & $do 'move' $p0[0] $p0[1]; Start-Sleep -Milliseconds 40
      $dy = [int]$req['dy']; $dx = [int]$req['dx']
      if ($dy) { & $do 'wheel' (-120 * $dy) $false }
      if ($dx) { & $do 'wheel' (120 * $dx) $true }
    }
    default { throw "Unknown mouse action $($req['op'])" }
  }
  Start-Sleep -Milliseconds 120
  return @{ method = 'mouse'; at = $pts.ToArray(); sink = $sink.ToArray() }
}

# 'uia': a single left click, or a scroll, done through UI Automation on the element at the point (the person's pointer never moves).
# Only where the approved program is what shows at the point, never on a password field, and only Invoke / Toggle / Select for a click
# (a text field is left to 'post', which puts the caret where the click is) and ScrollPattern for a scroll. Anything else: skip.
function Mouse-Uia($req, $t, $pts, $button, $covered) {
  $op = [string]$req['op']
  if ($op -eq 'drag') { return @{ skip = 'a drag has no UI Automation pattern' } }
  if ($op -eq 'click' -and ($button -ne 'left' -or $req['double'])) { return @{ skip = 'only a single left click has a UI Automation pattern' } }
  if (& $covered) { return @{ skip = 'another window covers the point' } }
  $p0 = $pts[0]
  $el = $null
  try { $el = $A::FromPoint((New-Object System.Windows.Point($p0[0], $p0[1]))) } catch { }
  if ($el -eq $null) { return @{ skip = 'no element at the point' } }
  try { if ($t.pids -notcontains [int]$el.Current.ProcessId) { return @{ skip = 'the element belongs to another program' } } } catch { return @{ skip = 'the element is gone' } }
  if (Test-PwElement $el) { return @{ skip = 'a password field' } }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  if ($op -eq 'scroll') {
    $dy = [int]$req['dy']; $dx = [int]$req['dx']
    $cur = $el
    for ($i = 0; $i -lt 8 -and $cur -ne $null; $i++) {
      $sp = Pat $cur ([System.Windows.Automation.ScrollPattern]::Pattern)
      if ($sp -ne $null -and ((-not $dy) -or $sp.Current.VerticallyScrollable) -and ((-not $dx) -or $sp.Current.HorizontallyScrollable)) {
        $no = [System.Windows.Automation.ScrollAmount]::NoAmount
        for ($k = 0; $k -lt 3 * [Math]::Abs($dy); $k++) { $sp.Scroll($no, $(if ($dy -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement })) }
        for ($k = 0; $k -lt 3 * [Math]::Abs($dx); $k++) { $sp.Scroll($(if ($dx -gt 0) { [System.Windows.Automation.ScrollAmount]::SmallIncrement } else { [System.Windows.Automation.ScrollAmount]::SmallDecrement }), $no) }
        return @{ method = 'uia-scroll'; at = $pts.ToArray() }
      }
      try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
      if ($cur -ne $null -and $t.pids -notcontains [int]$cur.Current.ProcessId) { break }
    }
    return @{ skip = 'nothing scrollable through UI Automation at the point' }
  }
  # A click on a label or icon inside a button or list item counts as a click on that item: up to two such parents are asked.
  $cur = $el
  for ($i = 0; $i -lt 3 -and $cur -ne $null; $i++) {
    if (-not $cur.Current.IsEnabled) { return @{ skip = 'the element is disabled' } }
    $m = Invoke-Patterns $cur $false
    if ($m -eq 'pending') { return @{ method = 'uia-invoke'; at = $pts.ToArray(); note = 'It is still working or opened a dialog that waits for an answer.' } }
    if ($m -ne 'none') { return @{ method = "uia-$m"; at = $pts.ToArray() } }
    $ct = ($cur.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
    if (@('Text', 'Image') -notcontains $ct) { break }
    try { $cur = $walker.GetParent($cur) } catch { $cur = $null }
    if ($cur -ne $null -and $t.pids -notcontains [int]$cur.Current.ProcessId) { break }
  }
  return @{ skip = 'the element at the point has no Invoke, Toggle or Select' }
}

# Windows whose input comes from the system pointer only, not from window messages: Store (UWP / WinUI) content and input sites.
$REALONLY = @('Windows.UI.Core.CoreWindow', 'ApplicationFrameInputSinkWindow', 'Windows.UI.Input.InputSite.WindowClass', 'Microsoft.UI.Content.DesktopChildSiteBridge', 'InputSite')

# 'post': the click, drag or wheel as window messages posted to the approved window's own child at the point (found from the app's window
# down, so it reaches the app even under another window, and never another program). The person's pointer never moves.
function Mouse-Post($req, $t, $pts, $button, $sink, $sinking) {
  $hwnd = [int64]$req['hwnd']
  $p0 = $pts[0]
  $h = [LumenNative]::DeepChild($hwnd, $p0[0], $p0[1])
  if ($t.pids -notcontains [int][LumenNative]::OwnerPid($h)) { return @{ skip = 'the window at the point belongs to another program' } }
  $cls = [LumenNative]::ClassOf($h)
  if ($REALONLY -contains $cls) { return @{ skip = "this app takes only real mouse input ($cls)" } }
  $msg = @{ left = @(0x0201, 0x0202, 0x0203, 0x0001); right = @(0x0204, 0x0205, 0x0206, 0x0002); middle = @(0x0207, 0x0208, 0x0209, 0x0010) }[$button]
  $post = { param($m, $wp, $x, $y, $screen) if ($sinking) { [void]$sink.Add("post $m $wp $x $y") } elseif ($screen) { [void][LumenNative]::PostScreen($h, $m, $wp, $x, $y) } else { [void][LumenNative]::PostClient($h, $m, $wp, $x, $y) } }
  switch ([string]$req['op']) {
    'click' {
      & $post 0x0200 0 $p0[0] $p0[1] $false
      & $post $msg[0] $msg[3] $p0[0] $p0[1] $false; & $post $msg[1] 0 $p0[0] $p0[1] $false
      if ($req['double']) { Start-Sleep -Milliseconds 40; & $post $msg[2] $msg[3] $p0[0] $p0[1] $false; & $post $msg[1] 0 $p0[0] $p0[1] $false }
    }
    'drag' {
      $p1 = $pts[1]
      & $post 0x0200 0 $p0[0] $p0[1] $false
      & $post $msg[0] $msg[3] $p0[0] $p0[1] $false; Start-Sleep -Milliseconds 40
      for ($i = 1; $i -le 12; $i++) { & $post 0x0200 $msg[3] ([int]($p0[0] + ($p1[0] - $p0[0]) * $i / 12)) ([int]($p0[1] + ($p1[1] - $p0[1]) * $i / 12)) $false; Start-Sleep -Milliseconds 16 }
      & $post $msg[1] 0 $p1[0] $p1[1] $false
    }
    'scroll' {
      $dy = [int]$req['dy']; $dx = [int]$req['dx']
      if ($dy) { & $post 0x020A ([uint32](((-120 * $dy) -band 0xffff) * 65536)) $p0[0] $p0[1] $true }
      if ($dx) { & $post 0x020E ([uint32](((120 * $dx) -band 0xffff) * 65536)) $p0[0] $p0[1] $true }
    }
    default { throw "Unknown mouse action $($req['op'])" }
  }
  Start-Sleep -Milliseconds 120
  return @{ method = 'post'; at = $pts.ToArray(); sink = $sink.ToArray() }
}

# The card's live picture. The caller names the window, the program it was approved for and the title it was approved with. Every call checks
# that the window is still owned by that process; every verify call (about once a second) checks the program fully, as every other call does.
# A window whose title is not the approved one is NOT captured: its title is returned, the caller judges it, and asks again.
function Cmd-Frame($req) {
  Ensure-Native
  $hwnd = [int64]$req['hwnd']
  $owner = [LumenNative]::OwnerPid($hwnd)
  if ($owner -eq 0) { throw 'That window is gone.' }
  if ([int]$req['pid'] -ne [int]$owner) { throw 'That window now belongs to a different program. Call list_apps again.' }
  if ($req['verify']) { $null = Get-Target $req }
  $title = [LumenNative]::Title($hwnd)
  if ($title -ne [string]$req['title']) { return @{ retitle = $title } }
  $f = [LumenNative]::Frame($hwnd, [int]$req['w'], [int64]$req['q'], [bool]$req['reset'])
  if ($f.Skip) { return @{ skip = [string]$f.Skip } }
  if ($f.Same) { return @{ same = $true; ms = [int64]$f.Ms } }
  return @{ image = $f.Image; w = [int]$f.W; h = [int]$f.H; ms = [int64]$f.Ms }
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
  $file = [string]$req['file']
  if (-not $file) { Start-Process -FilePath $path; return @{ started = $true } }
  # A document: the program is started with the file as its one argument (no shell). A Start menu shortcut is followed to the program it points at.
  if ($path -like '*.lnk') { $sh = New-Object -ComObject WScript.Shell; $path = $sh.CreateShortcut($path).TargetPath }
  if (-not $path -or $path -notlike '*.exe' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'That app is not a program that can be given a file.' }
  if (-not [System.IO.Path]::IsPathRooted($file) -or $file.StartsWith('\') -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'That file path is not valid.' }
  Start-Process -FilePath $path -ArgumentList ('"' + $file.Replace('"', '') + '"')
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
    'mouse' { return Cmd-Mouse $req }
    'typefocus' { return Cmd-TypeFocus $req }
    'frame' { return Cmd-Frame $req }
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
