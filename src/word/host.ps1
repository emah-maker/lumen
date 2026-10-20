# [word] The Microsoft Word helper (src/word/com.js starts it hidden, on the first use of the word tool, and ends it when idle).
# One request per line on stdin, one answer per line on stdout, both JSON: {"id":1,"cmd":"list"} -> {"id":1,"ok":true,...}.
# Nothing from a request is ever run as code: a command name picks one of the functions below, and every value (document text, find text,
# file names) is data handed to Word's object model as an argument. It starts no program except Word (through COM), opens no file the
# request did not name, never closes a document, and quits Word only if it started that Word itself and no document is open.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Web.Extensions
$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue
$ser.RecursionLimit = 100
# Test seam (src/word tests only; the client sets these variables only in a development test run, never in a packaged Lumen):
# LUMEN_WORD_TEST: the echo command and cleanup; LUMEN_WORD_NEW: always start a Word of our own (never attach to the user's);
# LUMEN_WORD_HIDDEN: never show Word's window.
$TEST = ($env:LUMEN_WORD_TEST -eq '1')
$NEW = ($env:LUMEN_WORD_NEW -eq '1')
$HIDDEN = ($env:LUMEN_WORD_HIDDEN -eq '1')
$script:app = $null
$script:ours = $false
$script:last = @{}
$CR = [string][char]13
$BEL = [string][char]7

function Send($o) { [Console]::Out.WriteLine($ser.Serialize($o)); [Console]::Out.Flush() }
function Arg($req, $name, $default = $null) { if ($req.ContainsKey($name) -and $null -ne $req[$name]) { return $req[$name] } else { return $default } }

function Is-Installed { return ($null -ne [type]::GetTypeFromProgID('Word.Application')) }

# The Word to use: the running one (never a second window for the user), else, when asked to, one of our own.
function Get-App([bool]$create) {
  if ($script:app) { try { $null = $script:app.Version; return $script:app } catch { $script:app = $null } }
  if (-not $NEW) {
    try { $script:app = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application'); $script:ours = $false; return $script:app } catch { $script:app = $null }
  }
  if (-not $create) { return $null }
  if (-not (Is-Installed)) { throw 'Microsoft Word is not installed.' }
  $a = New-Object -ComObject Word.Application
  $a.DisplayAlerts = 0
  try { $a.AutomationSecurity = 3 } catch { }   # macros in a document never run
  $script:app = $a
  $script:ours = $true
  return $a
}

function Show-App($a) { if (-not $HIDDEN) { try { if (-not $a.Visible) { $a.Visible = $true } } catch { } } }

function Norm([string]$p) { try { return [IO.Path]::GetFullPath($p).TrimEnd('\').ToLowerInvariant() } catch { return $p.ToLowerInvariant() } }
function Doc-Key($d) { if ($d.Path) { return (Norm $d.FullName) } else { return $d.Name.ToLowerInvariant() } }

# The document the request is about: doc = a full path or the name as list shows it; none given: the active document.
function Find-Doc($req) {
  $a = Get-App $false
  if (-not $a) { throw 'Word is not running. Use open or new first.' }
  $want = [string](Arg $req 'doc' '')
  if ($want -eq '' -and $req.ContainsKey('path')) { $want = [string]$req['path'] }
  if ($a.Documents.Count -eq 0) { throw 'No document is open in Word. Use open or new.' }
  if ($want -eq '') { return $a.ActiveDocument }
  $w = $want.Trim().ToLowerInvariant()
  $wn = Norm $want
  $hits = @()
  foreach ($d in $a.Documents) {
    if ($d.Path -and (Norm $d.FullName) -eq $wn) { return $d }
    $n = $d.Name.ToLowerInvariant()
    if ($n -eq $w -or [IO.Path]::GetFileNameWithoutExtension($n) -eq $w) { $hits += $d }
  }
  if ($hits.Count -eq 1) { return $hits[0] }
  if ($hits.Count -gt 1) { throw "More than one open document is called $want. Use its full path (list shows them)." }
  throw "No open document matches $want. Use list to see what is open, or open it."
}

function Doc-Info($d, $active) {
  $info = @{ name = [string]$d.Name; path = [string]$d.FullName; saved = [bool]$d.Saved; tracking = [bool]$d.TrackRevisions; paragraphs = [int]$d.Paragraphs.Count; active = $active }
  if (-not $d.Path) { $info.path = '' }
  return $info
}

function Cmd-Status($req) {
  $running = $false
  try { $running = ($null -ne [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')) } catch { }
  return @{ installed = (Is-Installed); running = ($running -or ($null -ne $script:app)) }
}

function Cmd-List($req) {
  $a = Get-App $false
  if (-not $a) { return @{ running = $false; docs = @() } }
  $docs = New-Object System.Collections.ArrayList
  $act = ''
  try { if ($a.Documents.Count -gt 0) { $act = Doc-Key $a.ActiveDocument } } catch { }
  foreach ($d in $a.Documents) { [void]$docs.Add((Doc-Info $d ((Doc-Key $d) -eq $act))) }
  return @{ running = $true; docs = $docs.ToArray() }
}

function Cmd-Open($req) {
  $path = [string]$req['path']
  if (-not [IO.File]::Exists($path)) { throw 'That file does not exist.' }
  $a = Get-App $true
  $wn = Norm $path
  foreach ($d in $a.Documents) { if ($d.Path -and (Norm $d.FullName) -eq $wn) { Show-App $a; return @{ doc = (Doc-Info $d $true); already = $true } } }
  # (a made-up password turns a password prompt into an error; no encoding or conversion dialogs; not added to the recent list)
  $d = $a.Documents.Open($path, $false, $false, $false, 'lumen-no-password', 'lumen-no-password', $false, 'lumen-no-password', 'lumen-no-password', 0, 65001, $true, $false, 0, $true)
  Show-App $a
  return @{ doc = (Doc-Info $d $true); already = $false }
}

function Cmd-New($req) {
  $a = Get-App $true
  $d = $a.Documents.Add()
  Show-App $a
  return @{ doc = (Doc-Info $d $true) }
}

# ---- reading
function Clean-Cell([string]$s) { return ($s.Replace($CR, ' ').Replace($BEL, '').Replace([string][char]11, ' ').Trim()) }

function Cmd-Read($req) {
  $d = Find-Doc $req
  $off = [int](Arg $req 'offset' 0)
  $budget = [int](Arg $req 'budget' 9000)
  $n = [int]$d.Paragraphs.Count
  $out = New-Object System.Collections.ArrayList
  $used = 0
  $i = $off + 1
  while ($i -le $n -and $used -lt $budget) {
    $p = $d.Paragraphs.Item($i)
    $r = $p.Range
    if ($r.Information(12)) {
      $t = $r.Tables.Item(1)
      $cnt = [int]$t.Range.Paragraphs.Count
      $rows = @{}
      $order = New-Object System.Collections.ArrayList
      $cells = 0
      foreach ($c in $t.Range.Cells) {
        $cells++
        if ($cells -gt 3000) { break }
        $ri = [int]$c.RowIndex
        if (-not $rows.ContainsKey($ri)) { $rows[$ri] = New-Object System.Collections.ArrayList; [void]$order.Add($ri) }
        [void]$rows[$ri].Add((Clean-Cell $c.Range.Text))
      }
      foreach ($ri in $order) { $line = '| ' + ($rows[$ri] -join ' | ') + ' |'; [void]$out.Add($line); $used += $line.Length }
      $i += [Math]::Max($cnt, 1)
      continue
    }
    $text = ([string]$r.Text).TrimEnd([char]13, [char]7)
    $level = [int]$p.OutlineLevel
    $prefix = ''
    if ($level -ge 1 -and $level -le 6 -and $text.Trim() -ne '') { $prefix = ('#' * $level) + ' ' }
    elseif ($r.ListFormat.ListType -ne 0) {
      $lv = [Math]::Max([int]$r.ListFormat.ListLevelNumber, 1)
      $ls = [string]$r.ListFormat.ListString
      $mark = '-'
      if ($ls -match '^[0-9A-Za-z]+[.)]?$') { $mark = $ls }
      $prefix = (' ' * (2 * ($lv - 1))) + $mark + ' '
    }
    $line = $prefix + $text
    [void]$out.Add($line)
    $used += $line.Length + 1
    $i++
  }
  $res = @{ doc = [string]$d.Name; total = $n; offset = $off; text = ($out -join "`n"); next = $(if ($i -le $n) { $i - 1 } else { $null }) }
  if ($off -eq 0) {
    $c = New-Object System.Collections.ArrayList
    $cc = [int]$d.Comments.Count
    $k = 0
    foreach ($m in $d.Comments) {
      $k++
      if ($k -gt 30) { break }
      $anchor = ''
      try { $anchor = ([string]$m.Scope.Text) } catch { }
      if ($anchor.Length -gt 60) { $anchor = $anchor.Substring(0, 59) + '...' }
      $body = ([string]$m.Range.Text)
      if ($body.Length -gt 400) { $body = $body.Substring(0, 399) + '...' }
      [void]$c.Add(@{ author = [string]$m.Author; on = $anchor; text = $body })
    }
    $res.comments = $c.ToArray()
    $res.commentCount = $cc
    $rc = [int]$d.Revisions.Count
    $ins = 0; $del = 0; $oth = 0
    $authors = @{}
    $k = 0
    foreach ($rv in $d.Revisions) {
      $k++
      if ($k -gt 500) { break }
      $ty = [int]$rv.Type
      if ($ty -eq 1) { $ins++ } elseif ($ty -eq 2) { $del++ } else { $oth++ }
      $authors[[string]$rv.Author] = $true
    }
    $res.revisions = @{ total = $rc; inserted = $ins; deleted = $del; other = $oth; authors = @($authors.Keys); tracking = [bool]$d.TrackRevisions }
  }
  return $res
}

# ---- where new content goes
# -> the position (a character offset) a block of new paragraphs is put at, and whether it needs its own leading paragraph mark.
function Para-Level($p) { return [int]$p.OutlineLevel }

function Match-Para($d, [string]$heading, [bool]$headingOnly) {
  $want = $heading.Trim().ToLowerInvariant()
  $n = [int]$d.Paragraphs.Count
  $exact = 0; $starts = 0; $has = 0
  for ($i = 1; $i -le $n; $i++) {
    $p = $d.Paragraphs.Item($i)
    if ($headingOnly -and (Para-Level $p) -gt 9) { continue }
    $t = ([string]$p.Range.Text).TrimEnd([char]13, [char]7).Trim().ToLowerInvariant()
    if ($t -eq '') { continue }
    if ($t -eq $want) { $exact = $i; break }
    if ($starts -eq 0 -and $t.StartsWith($want)) { $starts = $i }
    if ($has -eq 0 -and $t.Contains($want)) { $has = $i }
  }
  if ($exact) { return $exact }
  if ($starts) { return $starts }
  if ($has) { return $has }
  throw "No heading or paragraph matches `"$heading`". Use read to see the headings."
}

# Returns @{ pos; lead } : insert at pos; lead = the text needs a paragraph mark in front (it goes after the last paragraph's text).
function Locate($d, $req) {
  $at = [string](Arg $req 'at' 'end')
  $n = [int]$d.Paragraphs.Count
  $last = $d.Paragraphs.Item($n).Range
  if ($at -eq 'end') {
    if (([string]$last.Text).TrimEnd([char]13, [char]7) -eq '' -and -not $last.Information(12)) { return @{ pos = [int]$last.Start; lead = $false; trail = $false } }
    return @{ pos = [int]($last.End - 1); lead = $true; trail = $false }
  }
  if ($at -eq 'start') { return @{ pos = 0; lead = $false; trail = $true } }
  $h = [string]$req['heading']
  $idx = Match-Para $d $h ($at -eq 'section_end')
  $target = $idx
  if ($at -eq 'section_end') {
    $lv = Para-Level ($d.Paragraphs.Item($idx))
    $target = $n
    for ($j = $idx + 1; $j -le $n; $j++) {
      $pl = Para-Level ($d.Paragraphs.Item($j))
      if ($pl -le $lv) { $target = $j - 1; break }
    }
  }
  $pr = $d.Paragraphs.Item($target).Range
  if ($pr.Information(12)) { $pr = $pr.Tables.Item(1).Range }
  if ($target -ge $n -or $pr.End -ge $d.Content.End) { return (Locate $d @{ at = 'end' }) }
  return @{ pos = [int]$pr.End; lead = $false; trail = $true }
}

$STYLE_ID = @{ 'Normal' = -1; 'Heading 1' = -2; 'Heading 2' = -3; 'Heading 3' = -4; 'Title' = -63; 'List Bullet' = -49; 'List Number' = -50; 'Quote' = -181 }
function Set-Style($d, $range, [string]$name) { if ($STYLE_ID.ContainsKey($name)) { $range.Style = $d.Styles.Item([int]$STYLE_ID[$name]) } else { throw 'Unknown style.' } }

function Cmd-Insert($req) {
  $d = Find-Doc $req
  $text = ([string]$req['text']) -replace "`r`n", "`n" -replace "`r", "`n"
  $text = $text.TrimEnd("`n")
  $paras = $text.Split("`n")
  $loc = Locate $d $req
  $body = ($paras -join $CR)
  if ($loc.lead) { $ins = $CR + $body } elseif ($loc.trail) { $ins = $body + $CR } else { $ins = $body }
  $r = $d.Range($loc.pos, $loc.pos)
  $r.InsertAfter($ins)
  $s = [int]$loc.pos
  if ($loc.lead) { $s++ }
  $e = $s + $body.Length
  $nr = $d.Range($s, $e)
  $style = [string](Arg $req 'style' 'Normal')
  Set-Style $d $nr $style
  if (-not $req.ContainsKey('style')) { try { $nr.ParagraphFormat.Reset(); $nr.Font.Reset() } catch { } }
  if ($req.ContainsKey('bold')) { $nr.Font.Bold = [int]([bool]$req['bold']) }
  if ($req.ContainsKey('italic')) { $nr.Font.Italic = [int]([bool]$req['italic']) }
  $script:last[(Doc-Key $d)] = @($s, $e)
  return @{ doc = [string]$d.Name; paragraphs = $paras.Count; tracking = [bool]$d.TrackRevisions }
}

# Find text is Word's own pattern language: "^" starts a special code, so a literal one is doubled. (Wildcards stay off.)
function Esc-Find([string]$s) { return $s.Replace('^', '^^') }

# Every place `find` occurs (up to a cap): ranges.
function Find-All($d, [string]$find, [int]$cap) {
  $res = New-Object System.Collections.ArrayList
  $r = $d.Content
  $f = $r.Find
  $f.ClearFormatting()
  $f.Text = (Esc-Find $find)
  $f.Forward = $true; $f.Wrap = 0; $f.MatchCase = $true; $f.MatchWildcards = $false
  while ($res.Count -lt $cap -and $f.Execute()) {
    [void]$res.Add($d.Range([int]$r.Start, [int]$r.End))
    $r.Collapse(0)
    $r.End = [int]$d.Content.End
    $f = $r.Find
    $f.Text = (Esc-Find $find)
    $f.Forward = $true; $f.Wrap = 0; $f.MatchCase = $true; $f.MatchWildcards = $false
  }
  return , $res
}

function Cmd-Replace($req) {
  $d = Find-Doc $req
  $find = [string]$req['find']
  $rep = [string](Arg $req 'replace' '')
  $cap = 1000
  # (every match is found first, then changed from the last to the first: with tracked changes the deleted text stays in the document, and
  # searching again after each change would find it again)
  $hits = Find-All $d $find $cap
  $count = 0
  if ($hits.Count -gt 0) { $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].Start + $rep.Length) }
  for ($k = $hits.Count - 1; $k -ge 0; $k--) { $hits[$k].Text = $rep; $count++ }
  return @{ doc = [string]$d.Name; replaced = $count; capped = ($count -ge $cap) }
}

function Cmd-Style($req) {
  $d = Find-Doc $req
  $hits = Find-All $d ([string]$req['find']) 200
  $done = 0
  foreach ($h in $hits) {
    if ($req.ContainsKey('style')) { Set-Style $d $h.Paragraphs.Item(1).Range ([string]$req['style']) }
    if ($req.ContainsKey('bold')) { $h.Font.Bold = [int]([bool]$req['bold']) }
    if ($req.ContainsKey('italic')) { $h.Font.Italic = [int]([bool]$req['italic']) }
    $done++
  }
  if ($done -gt 0) { $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].End) }
  return @{ doc = [string]$d.Name; formatted = $done }
}

function Cmd-Table($req) {
  $d = Find-Doc $req
  $rows = @($req['rows'])
  $nr = $rows.Count
  $nc = 0
  foreach ($r in $rows) { $nc = [Math]::Max($nc, @($r).Count) }
  $loc = Locate $d $req
  $pos = [int]$loc.pos
  if ($loc.lead) { $d.Range($pos, $pos).InsertAfter($CR); $pos++ } else { $d.Range($pos, $pos).InsertBefore($CR) }
  $rng = $d.Range($pos, $pos)
  Set-Style $d $rng 'Normal'
  $t = $d.Tables.Add($rng, $nr, $nc)
  try { $t.Style = $d.Styles.Item(-155) } catch { }
  for ($i = 0; $i -lt $nr; $i++) {
    $cells = @($rows[$i])
    for ($j = 0; $j -lt $cells.Count; $j++) { $t.Cell($i + 1, $j + 1).Range.Text = [string]$cells[$j] }
  }
  if ($nr -gt 1) { $t.Rows.Item(1).Range.Font.Bold = 1 }
  $script:last[(Doc-Key $d)] = @([int]$t.Range.Start, [int]$t.Range.End)
  return @{ doc = [string]$d.Name; rows = $nr; columns = $nc }
}

function Cmd-Image($req) {
  $d = Find-Doc $req
  $path = [string]$req['image']
  if (-not [IO.File]::Exists($path)) { throw 'That picture file does not exist.' }
  $loc = Locate $d $req
  $pos = [int]$loc.pos
  if ($loc.lead) { $d.Range($pos, $pos).InsertAfter($CR); $pos++ } else { $d.Range($pos, $pos).InsertBefore($CR) }
  $rng = $d.Range($pos, $pos)
  Set-Style $d $rng 'Normal'
  $pic = $d.InlineShapes.AddPicture($path, $false, $true, $rng)
  $max = 450
  try { $ps = $d.PageSetup; $max = [Math]::Max(100, $ps.PageWidth - $ps.LeftMargin - $ps.RightMargin) } catch { }
  if ($pic.Width -gt $max) { $pic.LockAspectRatio = -1; $pic.Width = $max }
  $script:last[(Doc-Key $d)] = @($pos, $pos + 1)
  return @{ doc = [string]$d.Name }
}

function Cmd-Comment($req) {
  $d = Find-Doc $req
  $hits = Find-All $d ([string]$req['find']) 1
  if ($hits.Count -eq 0) { throw 'That text was not found in the document, so there is nothing to comment on.' }
  [void]$d.Comments.Add($hits[0], [string]$req['text'])
  $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].End)
  return @{ doc = [string]$d.Name }
}

function Cmd-Track($req) {
  $d = Find-Doc $req
  $d.TrackRevisions = [bool]$req['on']
  return @{ doc = [string]$d.Name; tracking = [bool]$d.TrackRevisions }
}

function Cmd-Save($req) {
  $d = Find-Doc $req
  if (-not $d.Path) { throw 'This document has never been saved. Use save_as with a path.' }
  $d.Save()
  return @{ doc = [string]$d.Name; path = [string]$d.FullName }
}

function Cmd-SaveAs($req) {
  $d = Find-Doc $req
  $path = [string]$req['path']
  $dir = [IO.Path]::GetDirectoryName($path)
  if (-not [IO.Directory]::Exists($dir)) { throw 'The folder for that file does not exist.' }
  if ([string]$req['format'] -eq 'pdf') { $d.ExportAsFixedFormat($path, 17) } else { $d.SaveAs2($path, 16) }
  return @{ doc = [string]$d.Name; path = $path }
}

function Cmd-Show($req) {
  $a = Get-App $false
  $d = Find-Doc $req
  if (-not $HIDDEN) {
    try { $a.Visible = $true; $a.Activate(); $d.Activate() } catch { }
    $span = $script:last[(Doc-Key $d)]
    if ($span) { try { $sel = $a.Selection; $sel.SetRange([int]$span[0], [int]$span[1]); $d.ActiveWindow.ScrollIntoView($sel.Range, $true) } catch { } }
  }
  return @{ doc = [string]$d.Name; shown = (-not $HIDDEN) }
}

# ---- the card's live picture: Word's own window (never any other), scaled to the card, compared with the last picture, a JPEG only when it changed
$script:native = $false
function Ensure-Native {
  if ($script:native) { return }
  Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Drawing; using System.Drawing.Drawing2D; using System.Drawing.Imaging; using System.IO; using System.Linq; using System.Runtime.InteropServices;
public static class LumenWordShot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);
  public class FrameResult { public string Image, Skip; public bool Same; public int W, H; public long Ms; }
  static byte[] prevPix; static int prevW, prevH; static Bitmap fullBmp; static int fullW, fullH;
  public static FrameResult Frame(long hwnd, int maxW, long quality, bool reset) {
    System.Diagnostics.Stopwatch sw = System.Diagnostics.Stopwatch.StartNew();
    FrameResult res = new FrameResult(); IntPtr h = new IntPtr(hwnd); RECT r;
    if (h == IntPtr.Zero) { res.Skip = "hidden"; return res; }
    if (IsIconic(h)) { res.Skip = "minimized"; return res; }
    int cloaked = 0; try { DwmGetWindowAttribute(h, 14, out cloaked, 4); } catch { }
    if (!IsWindowVisible(h) || cloaked != 0) { res.Skip = "hidden"; return res; }
    if (!GetWindowRect(h, out r)) { res.Skip = "hidden"; return res; }
    int w = r.R - r.L, ht = r.B - r.T;
    if (w <= 0 || ht <= 0) { res.Skip = "hidden"; return res; }
    if (fullBmp == null || fullW != w || fullH != ht) { if (fullBmp != null) fullBmp.Dispose(); fullBmp = new Bitmap(w, ht, PixelFormat.Format24bppRgb); fullW = w; fullH = ht; }
    using (Graphics g = Graphics.FromImage(fullBmp)) { IntPtr dc = g.GetHdc(); bool ok = PrintWindow(h, dc, 2); g.ReleaseHdc(dc); if (!ok) { res.Skip = "hidden"; return res; } }
    int nw = Math.Min(w, Math.Max(80, maxW)); int nh = Math.Max(1, (int)Math.Round((double)ht * nw / w));
    using (Bitmap small = new Bitmap(nw, nh, PixelFormat.Format24bppRgb)) {
      using (Graphics g2 = Graphics.FromImage(small)) { g2.InterpolationMode = InterpolationMode.Bilinear; g2.DrawImage(fullBmp, 0, 0, nw, nh); }
      BitmapData bd = small.LockBits(new Rectangle(0, 0, nw, nh), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
      int stride = bd.Stride; byte[] cur = new byte[stride * nh];
      Marshal.Copy(bd.Scan0, cur, 0, cur.Length); small.UnlockBits(bd);
      if (!reset && prevPix != null && prevW == nw && prevH == nh && prevPix.Length == cur.Length) {
        int count = 0;
        for (int y = 0; y < nh && count < 3; y++) { int row = y * stride; for (int x = 0; x < nw; x++) { int i = row + x * 3; if (Math.Abs(cur[i] - prevPix[i]) > 20 || Math.Abs(cur[i + 1] - prevPix[i + 1]) > 20 || Math.Abs(cur[i + 2] - prevPix[i + 2]) > 20) { if (++count >= 3) break; } } }
        if (count < 3) { res.Same = true; res.Ms = sw.ElapsedMilliseconds; return res; }
      }
      prevPix = cur; prevW = nw; prevH = nh;
      ImageCodecInfo jpg = ImageCodecInfo.GetImageEncoders().First(c => c.MimeType == "image/jpeg");
      EncoderParameters ep = new EncoderParameters(1); ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      using (MemoryStream ms = new MemoryStream()) { small.Save(ms, jpg, ep); res.Image = Convert.ToBase64String(ms.ToArray()); }
      res.W = nw; res.H = nh; res.Ms = sw.ElapsedMilliseconds; return res;
    }
  }
}
'@
  $script:native = $true
}

function Cmd-Frame($req) {
  $a = Get-App $false
  if (-not $a) { throw 'Word is not running.' }
  if ($HIDDEN) { return @{ skip = 'hidden' } }
  $vis = $false
  try { $vis = [bool]$a.Visible } catch { }
  if (-not $vis) { return @{ skip = 'hidden' } }
  Ensure-Native
  $f = [LumenWordShot]::Frame([int64]$a.Hwnd, [int]$req['w'], [int64]$req['q'], [bool]$req['reset'])
  if ($f.Skip) { return @{ skip = [string]$f.Skip } }
  if ($f.Same) { return @{ same = $true; ms = [int64]$f.Ms } }
  return @{ image = $f.Image; w = [int]$f.W; h = [int]$f.H; ms = [int64]$f.Ms }
}

# The few paragraphs around the last change, for the card's page preview when Word's window cannot be shown (hidden, minimized): [{ k, t, hl }]
function Cmd-Peek($req) {
  $d = Find-Doc $req
  $span = $script:last[(Doc-Key $d)]
  $n = [int]$d.Paragraphs.Count
  $at = 1
  if ($span) { $at = [Math]::Max(1, [int]$d.Range(0, [int]$span[0]).Paragraphs.Count) }
  $from = [Math]::Max(1, $at - 3)
  $to = [Math]::Min($n, $at + 9)
  $lines = New-Object System.Collections.ArrayList
  for ($i = $from; $i -le $to; $i++) {
    $p = $d.Paragraphs.Item($i)
    $r = $p.Range
    $t = ([string]$r.Text).TrimEnd([char]13, [char]7).Replace([string][char]7, ' ')
    if ($t.Length -gt 220) { $t = $t.Substring(0, 219) + '...' }
    $k = 'p'
    $lv = [int]$p.OutlineLevel
    if ($r.Information(12)) { $k = 'tr' }
    elseif ($lv -ge 1 -and $lv -le 3) { $k = 'h' + $lv }
    elseif ($lv -ge 4 -and $lv -le 9) { $k = 'h3' }
    elseif ($r.ListFormat.ListType -ne 0) { $k = 'li' }
    $hl = $false
    if ($span) { $hl = ([int]$r.End -gt [int]$span[0] -and [int]$r.Start -lt [Math]::Max([int]$span[1], [int]$span[0] + 1)) }
    [void]$lines.Add(@{ k = $k; t = $t; hl = $hl })
  }
  return @{ doc = [string]$d.Name; lines = $lines.ToArray(); total = $n; from = $from }
}

# On the way out: Word is quit only when this helper started it and nothing is open in it. A document is never closed.
function Cmd-Quit {
  try {
    if ($script:app -and $script:ours -and $script:app.Documents.Count -eq 0) { $no = 0; $script:app.Quit([ref]$no) }
  } catch { }
  $script:app = $null
}

# Tests only: close every document without saving and quit the Word this helper started.
function Cmd-TestCleanup($req) {
  if ($script:app -and $script:ours) {
    $no = 0
    try { foreach ($d in @($script:app.Documents)) { $d.Close([ref]$no) } } catch { }
    try { $script:app.Quit([ref]$no) } catch { }
  }
  $script:app = $null
  return @{ done = $true }
}

function Handle($req) {
  switch ([string]$req['cmd']) {
    'ping' { return @{ pong = $true } }
    'status' { return Cmd-Status $req }
    'list' { return Cmd-List $req }
    'open' { return Cmd-Open $req }
    'new' { return Cmd-New $req }
    'read' { return Cmd-Read $req }
    'insert' { return Cmd-Insert $req }
    'replace' { return Cmd-Replace $req }
    'style' { return Cmd-Style $req }
    'table' { return Cmd-Table $req }
    'image' { return Cmd-Image $req }
    'comment' { return Cmd-Comment $req }
    'track' { return Cmd-Track $req }
    'save' { return Cmd-Save $req }
    'save_as' { return Cmd-SaveAs $req }
    'show' { return Cmd-Show $req }
    'frame' { return Cmd-Frame $req }
    'peek' { return Cmd-Peek $req }
    'echo' { if (-not $TEST) { throw 'Unknown command echo' }; return @{ echo = $req['value'] } }
    'test_cleanup' { if (-not $TEST) { throw 'Unknown command test_cleanup' }; return Cmd-TestCleanup $req }
    'quit' { Cmd-Quit; exit 0 }
    default { throw "Unknown command $($req['cmd'])" }
  }
}

Send @{ t = 'hello'; v = 1; pid = $PID }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { Cmd-Quit; break }
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
