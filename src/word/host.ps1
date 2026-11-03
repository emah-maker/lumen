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
  if ($script:app) { try { $null = $script:app.Version; if ($null -eq $script:app.Documents) { throw 'closing' }; return $script:app } catch { $script:app = $null } }   # (a Word the user closed, or one that is closing, is let go)
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
  if ($null -eq $d) { throw 'Word did not open the file: it may be showing a message, or the file is open in another Word window. Ask the user to look at Word, then try open again.' }
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
  $budget = [int](Arg $req 'budget' 6000)
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

$STYLE_ID = @{ 'Normal' = -1; 'Heading 1' = -2; 'Heading 2' = -3; 'Heading 3' = -4; 'Heading 4' = -5; 'Heading 5' = -6; 'Heading 6' = -7; 'Title' = -63; 'List Bullet' = -49; 'List Number' = -50; 'Quote' = -181 }
# A style by name: a built-in one by its number (the name differs by the language Word is in), else the document's own by its name.
function Get-Style($d, [string]$name) {
  if ($STYLE_ID.ContainsKey($name)) { return $d.Styles.Item([int]$STYLE_ID[$name]) }
  try { return $d.Styles.Item($name) } catch { throw ('This document has no style named "' + $name + '", so nothing was changed. To make one, use format with style "' + $name + '" and based_on (such as "Normal").') }
}
function Set-Style($d, $range, [string]$name) { $range.Style = (Get-Style $d $name) }
# Character formatting on a Font (and the highlight, which is the range's): bold, italic, underline, strike, color, font, size.
$UNDERLINE = @{ 'none' = 0; 'single' = 1; 'words' = 2; 'double' = 3; 'dotted' = 4; 'thick' = 6; 'dash' = 7; 'wave' = 11 }
$HIGHLIGHT = @{ 'none' = 0; 'black' = 1; 'blue' = 2; 'cyan' = 3; 'green' = 4; 'magenta' = 5; 'red' = 6; 'yellow' = 7; 'white' = 8; 'darkBlue' = 9; 'darkCyan' = 10; 'darkGreen' = 11; 'darkMagenta' = 12; 'darkRed' = 13; 'darkYellow' = 14; 'darkGray' = 15; 'lightGray' = 16 }
function Set-Char($font, $req) {
  if ($req.ContainsKey('font')) { $font.Name = [string]$req['font'] }
  if ($req.ContainsKey('size')) { $font.Size = [double]$req['size'] }
  if ($req.ContainsKey('bold')) { $font.Bold = [int]([bool]$req['bold']) }
  if ($req.ContainsKey('italic')) { $font.Italic = [int]([bool]$req['italic']) }
  if ($req.ContainsKey('strike')) { $font.StrikeThrough = [int]([bool]$req['strike']) }
  if ($req.ContainsKey('underline')) { $font.Underline = [int]$UNDERLINE[[string]$req['underline']] }
  if ($req.ContainsKey('color')) {
    $c = [string]$req['color']
    if ($c -eq 'auto') { $font.Color = -16777216 } else { $font.Color = [Convert]::ToInt32($c.Substring(0, 2), 16) + 256 * [Convert]::ToInt32($c.Substring(2, 2), 16) + 65536 * [Convert]::ToInt32($c.Substring(4, 2), 16) }   # (Word's colors are BGR)
  }
}
function Set-Highlight($range, $req) { if ($req.ContainsKey('highlight')) { $range.HighlightColorIndex = [int]$HIGHLIGHT[[string]$req['highlight']] } }

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
  $levels = @(Arg $req 'levels' @())
  for ($i = 0; $i -lt $levels.Count -and $i -lt [int]$nr.Paragraphs.Count; $i++) { if ([int]$levels[$i] -gt 1) { $nr.Paragraphs.Item($i + 1).Range.ListFormat.ListLevelNumber = [int]$levels[$i] } }
  $script:last[(Doc-Key $d)] = @($s, $e)
  return @{ doc = [string]$d.Name; paragraphs = $paras.Count; tracking = [bool]$d.TrackRevisions }
}

# Find text is Word's own pattern language: "^" starts a special code, so a literal one is doubled. (Wildcards stay off.)
# Find text as Word's Find reads it: ^ is literal, and a line break (between two paragraphs, as read shows them) or a tab is Word's ^p or ^t.
function Esc-Find([string]$s) { return ($s.Replace('^', '^^') -replace "`r`n|`r|`n", '^p').Replace("`t", '^t') }
# Replacement text: a line break is a new paragraph, as insert makes one.
function Rep-Text([string]$s) { return ($s -replace "`r`n|`r|`n", $CR) }

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
  $rep = Rep-Text ([string](Arg $req 'replace' ''))
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
  if ($req.ContainsKey('style')) { $null = Get-Style $d ([string]$req['style']) }   # (a style the document lacks changes nothing)
  foreach ($h in $hits) {
    if ($req.ContainsKey('style')) { Set-Style $d $h.Paragraphs.Item(1).Range ([string]$req['style']) }
    Set-Char $h.Font $req
    Set-Highlight $h $req
    $done++
  }
  if ($done -gt 0) { $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].End) }
  return @{ doc = [string]$d.Name; formatted = $done }
}

# ---- format: fonts and spacing through the styles (Normal and the headings, or one style), or on the paragraphs holding some text; margins and
# orientation per section; a page break before a paragraph; heading styles; a real table of contents (it replaces a typed contents list).
$FF = [string][char]12
function Para-Text($p) { return ([string]$p.Range.Text).TrimEnd([char]13, [char]7).Replace($FF, '').Trim() }
# The paragraph a format target names, as the file route picks it: a heading with that text, then the last paragraph with exactly that text
# (a typed contents list comes before the real heading), then the first that starts with it, then the first that contains it. 0: none.
function Find-Para($d, [string]$text) {
  $want = ($text -replace '^#+\s*', '').Trim().ToLowerInvariant()
  $n = [int]$d.Paragraphs.Count
  $head = 0; $last = 0; $starts = 0; $has = 0
  for ($i = 1; $i -le $n; $i++) {
    $p = $d.Paragraphs.Item($i)
    $t = (Para-Text $p).ToLowerInvariant()
    if ($t -eq '') { continue }
    if ($t -eq $want) { $last = $i; if ($head -eq 0 -and (Para-Level $p) -le 9) { $head = $i } }
    elseif ($starts -eq 0 -and $t.StartsWith($want)) { $starts = $i }
    elseif ($has -eq 0 -and $t.Contains($want)) { $has = $i }
  }
  foreach ($k in @($head, $last, $starts, $has)) { if ($k) { return $k } }
  return 0
}
function Need-Paras($d, $texts) {
  $missing = @(); foreach ($t in @($texts)) { if ((Find-Para $d ([string]$t)) -eq 0) { $missing += ('"' + $t + '"') } }
  if ($missing.Count) { throw ('No paragraph matches ' + ($missing -join ', ') + ', so nothing was changed. Use read to see the text.') }
}
function Set-Spacing($pf, $req) {
  if ($req.ContainsKey('line')) {
    $l = [double]$req['line']
    if ($l -gt 5) { $pf.LineSpacingRule = 4; $pf.LineSpacing = $l }   # exactly, in points
    elseif ($l -eq 1) { $pf.LineSpacingRule = 0 } elseif ($l -eq 1.5) { $pf.LineSpacingRule = 1 } elseif ($l -eq 2) { $pf.LineSpacingRule = 2 }
    else { $pf.LineSpacingRule = 5; $pf.LineSpacing = 12 * $l }   # a multiple of a line
  }
  if ($req.ContainsKey('before')) { $pf.SpaceBefore = [double]$req['before'] }
  if ($req.ContainsKey('after')) { $pf.SpaceAfter = [double]$req['after'] }
  if ($req.ContainsKey('align')) { $pf.Alignment = [int](@{ 'left' = 0; 'center' = 1; 'right' = 2; 'justify' = 3 })[[string]$req['align']] }
  if ($req.ContainsKey('indent')) { $pf.LeftIndent = 72 * [double]$req['indent'] }
  if ($req.ContainsKey('firstLine')) { $pf.FirstLineIndent = 72 * [double]$req['firstLine'] }   # (negative: a hanging indent)
  if ($req.ContainsKey('keepNext')) { $pf.KeepWithNext = [int]([bool]$req['keepNext']) }
}
function Has-Text($req) { foreach ($k in @('font', 'size', 'bold', 'italic', 'strike', 'underline', 'color', 'highlight')) { if ($req.ContainsKey($k)) { return $true } }; return $false }
function Has-Spacing($req) { foreach ($k in @('line', 'before', 'after', 'align', 'indent', 'firstLine', 'keepNext')) { if ($req.ContainsKey($k)) { return $true } }; return $false }
# A list on paragraph p (Word's own bullets or numbers, at a level), continuing the list the call started; none takes it out.
function Set-List($p, [string]$kind, [int]$level, [bool]$continue) {
  $lf = $p.Range.ListFormat
  if ($kind -eq 'none') { $lf.RemoveNumbers(); return }
  $gallery = 1; if ($kind -eq 'number') { $gallery = 2 }
  $tpl = $p.Application.ListGalleries.Item($gallery).ListTemplates.Item(1)
  $lf.ApplyListTemplateWithLevel($tpl, $continue, 0, 2)
  if ($level -gt 1) { $lf.ListLevelNumber = $level }
}
$ENTRY_TAIL = '(\s*\.{2,}\s*|\t+|\s+)\d+\s*$'

# A typed contents list: the paragraphs after a "Table of Contents" title that look like entries (a heading's text, or text ending in a page
# number), with blank lines between them. -> @{ title; entries } or $null.
function Typed-Contents($d) {
  $n = [int]$d.Paragraphs.Count
  $t = 0
  for ($i = 1; $i -le $n; $i++) { if ((Para-Text ($d.Paragraphs.Item($i))) -match '^(?i)(table of contents|contents):?$') { $t = $i; break } }
  if (-not $t) { return $null }
  $heads = @{}
  for ($i = 1; $i -le $n; $i++) { $p = $d.Paragraphs.Item($i); if ($i -ne $t -and (Para-Level $p) -le 9) { $heads[(Para-Text $p).ToLowerInvariant()] = $true } }
  $entries = New-Object System.Collections.ArrayList
  $blanks = New-Object System.Collections.ArrayList
  for ($i = $t + 1; $i -le $n; $i++) {
    $p = $d.Paragraphs.Item($i)
    if ((Para-Level $p) -le 9) { break }
    $raw = [string]$p.Range.Text
    if ($raw.Contains($FF)) { break }
    $x = $raw.TrimEnd([char]13, [char]7).Trim()
    if ($x -eq '') { [void]$blanks.Add($i); continue }
    $k = (($x -replace $ENTRY_TAIL, '') -replace '^[\d.]+\s+', '').Trim().ToLowerInvariant()
    if (-not (($x -match $ENTRY_TAIL) -or $heads.ContainsKey($k))) { break }
    foreach ($b in $blanks) { [void]$entries.Add($b) }
    $blanks.Clear()
    [void]$entries.Add($i)
  }
  return @{ title = $t; entries = $entries.ToArray() }
}

function Cmd-Format($req) {
  $d = Find-Doc $req
  $done = @{}
  # every paragraph a change names is found first: a missing one changes nothing
  $heads = @(Arg $req 'headings' @())
  $breaks = @(Arg $req 'breaks' @())
  $targets = @(Arg $req 'paras' @())
  $texts = @(); foreach ($h in $heads) { $texts += [string]$h['text'] }; foreach ($b in $breaks) { $texts += [string]$b }; foreach ($t in $targets) { $texts += [string]$t }
  if ($req.ContainsKey('toc') -and $req.ContainsKey('tocAt')) { $texts += [string]$req['tocAt'] }
  if ($texts.Count) { Need-Paras $d $texts }
  if ($req.ContainsKey('find') -and ((Has-Text $req) -or (Has-Spacing $req) -or $req.ContainsKey('list'))) { if ((Find-All $d ([string]$req['find']) 1).Count -eq 0) { throw ('No paragraph contains "' + [string]$req['find'] + '". Use read to see the text.') } }
  $style = $null
  if ($req.ContainsKey('style')) {
    $name = [string]$req['style']
    $base = $null; if ($req.ContainsKey('basedOn')) { $base = Get-Style $d ([string]$req['basedOn']) }
    try { $style = Get-Style $d $name } catch { if ($null -eq $base) { throw } }
    if ($null -eq $style) { $style = $d.Styles.Add($name, 1); $style.BaseStyle = [string]$base.NameLocal; $style.NextParagraphStyle = $d.Styles.Item(-1); $done.created = $true }
    elseif ($null -ne $base) { $style.BaseStyle = [string]$base.NameLocal }
  }
  $first = $null
  if ($heads.Count) {
    foreach ($h in $heads) { $p = $d.Paragraphs.Item((Find-Para $d ([string]$h['text']))); Set-Style $d $p.Range ('Heading ' + [int]$h['level']); if ($null -eq $first) { $first = [int]$p.Range.Start } }
    $done.headings = $heads.Count
  }
  if ($req.ContainsKey('toc')) {
    if ($d.TablesOfContents.Count -gt 0) {
      foreach ($c in $d.TablesOfContents) { $c.Update() }
      $done.toc = @{ already = $true }
    } else {
      $typed = Typed-Contents $d
      $replaced = 0
      $title = ''
      if ($typed) {
        $ents = @($typed.entries)
        for ($k = $ents.Count - 1; $k -ge 0; $k--) { $d.Paragraphs.Item([int]$ents[$k]).Range.Text = ''; $replaced++ }   # (the lines' text goes, as a replace with "" takes it; tracked when tracking is on)
        $tp = $d.Paragraphs.Item([int]$typed.title)
        $title = Para-Text $tp
        $tp.Range.InsertParagraphAfter()
        $at = [int]$d.Paragraphs.Item([int]$typed.title + 1).Range.Start
      } elseif ($req.ContainsKey('tocAt')) {
        $p = $d.Paragraphs.Item((Find-Para $d ([string]$req['tocAt'])))
        $p.Range.InsertParagraphAfter()
        $at = [int]$p.Next(1).Range.Start
      } else {
        $d.Range(0, 0).InsertParagraphBefore()
        $at = 0
      }
      $toc = $d.TablesOfContents.Add($d.Range($at, $at), $true, 1, 3)
      $toc.Update()
      $done.toc = @{ replaced = $replaced; title = $title }
      if ($null -eq $first) { $first = $at }
    }
  }
  if ($breaks.Count) {
    $added = @(); $had = @()
    $targets = @(); foreach ($b in $breaks) { $targets += [pscustomobject]@{ t = [string]$b; i = [int](Find-Para $d ([string]$b)) } }
    foreach ($x in @($targets | Sort-Object -Property i -Descending)) {
      $p = $d.Paragraphs.Item($x.i)
      $name = Para-Text $p
      $before = ''; if ($x.i -gt 1) { $before = ([string]$d.Paragraphs.Item($x.i - 1).Range.Text).TrimEnd([char]13) }
      if ($x.i -eq 1 -or $p.Format.PageBreakBefore -or ([string]$p.Range.Text).StartsWith($FF) -or $before.EndsWith($FF)) { $had = @($name) + $had; continue }
      $d.Range($p.Range.Start, $p.Range.Start).InsertBreak(7)
      $added = @($name) + $added
      $first = [int]$p.Range.Start
    }
    $done.breaks = @{ added = $added; had = $had }
  }
  if ($targets.Count -or ($req.ContainsKey('find') -and $req.ContainsKey('list'))) {
    # the paragraphs named (or holding the find text): their own formatting, and a list
    $ps = New-Object System.Collections.ArrayList
    if ($targets.Count) { foreach ($t in $targets) { [void]$ps.Add($d.Paragraphs.Item((Find-Para $d ([string]$t)))) } }
    else { $seen = @{}; foreach ($h in (Find-All $d ([string]$req['find']) 200)) { foreach ($hp in $h.Paragraphs) { $k = [int]$hp.Range.Start; if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; [void]$ps.Add($hp) } } } }
    $sorted = @($ps | Sort-Object -Property { [int]$_.Range.Start } -Unique)
    $n = 0
    foreach ($p in $sorted) {
      if ($req.ContainsKey('list')) { Set-List $p ([string]$req['list']) ([int](Arg $req 'level' 1)) ($n -gt 0) }
      if (Has-Text $req) { Set-Char $p.Range.Font $req; Set-Highlight $p.Range $req }
      if (Has-Spacing $req) { Set-Spacing $p.Format $req }
      $n++
    }
    if ($sorted.Count) { $first = [int]$sorted[0].Range.Start }
    $done.text = @{ find = (Arg $req 'find' $null); paragraphs = $sorted.Count; list = (Arg $req 'list' $null) }
  } elseif ($null -ne $style) {
    Set-Char $style.Font $req
    Set-Spacing $style.ParagraphFormat $req
    $done.text = @{ style = [string]$req['style']; created = [bool]$done.created; basedOn = (Arg $req 'basedOn' $null) }
    $done.Remove('created')
  } elseif ((Has-Text $req) -or (Has-Spacing $req)) {
    $paras = $null
    if ($req.ContainsKey('find')) {
      $hits = Find-All $d ([string]$req['find']) 200
      $seen = @{}
      foreach ($h in $hits) {
        if (Has-Text $req) { Set-Char $h.Font $req; Set-Highlight $h $req }
        if (Has-Spacing $req) { foreach ($hp in $h.Paragraphs) { $k = [int]$hp.Range.Start; if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; Set-Spacing $hp.Format $req } } }
      }
      $paras = $hits.Count
      if ($hits.Count) { $first = [int]$hits[0].Start }
    } else {
      # the whole document: Normal (spacing, font, size), the headings' and title's font, then the paragraphs whose own formatting still hides it
      $normal = $d.Styles.Item(-1)
      Set-Char $normal.Font $req
      Set-Spacing $normal.ParagraphFormat $req
      if ($req.ContainsKey('font')) { foreach ($id in @(-2, -3, -4, -5, -63, -75)) { try { $d.Styles.Item($id).Font.Name = [string]$req['font'] } catch { } } }
      $font = [string](Arg $req 'font' '')
      $rule = [int]$normal.ParagraphFormat.LineSpacingRule; $ls = [double]$normal.ParagraphFormat.LineSpacing
      foreach ($p in $d.Paragraphs) {
        if ($font -and [string]$p.Range.Font.Name -ne $font) { $p.Range.Font.Name = $font }
        if ($req.ContainsKey('line') -and (Para-Level $p) -gt 9 -and ([int]$p.Format.LineSpacingRule -ne $rule -or [double]$p.Format.LineSpacing -ne $ls)) { Set-Spacing $p.Format @{ line = $req['line'] } }
      }
    }
    $done.text = @{ style = (Arg $req 'style' $null); find = (Arg $req 'find' $null); paragraphs = $paras }
  }
  if ($req.ContainsKey('margins') -or $req.ContainsKey('orientation')) {
    $secs = @(); $i = 0
    foreach ($s in $d.Sections) { $i++; if (-not $req.ContainsKey('section') -or [int]$req['section'] -eq $i) { $secs += $s } }
    if ($req.ContainsKey('section') -and [int]$req['section'] -gt $i) { throw ('The document has ' + $i + ' section(s), so there is no section ' + [int]$req['section'] + '.') }
    foreach ($s in $secs) {
      $ps = $s.PageSetup
      if ($req.ContainsKey('orientation')) { if ([string]$req['orientation'] -eq 'landscape') { $ps.Orientation = 1 } else { $ps.Orientation = 0 } }
      if ($req.ContainsKey('margins')) { $m = $req['margins']; $ps.TopMargin = 72 * [double]$m['top']; $ps.RightMargin = 72 * [double]$m['right']; $ps.BottomMargin = 72 * [double]$m['bottom']; $ps.LeftMargin = 72 * [double]$m['left'] }
    }
    $done.sections = $secs.Count
  }
  if ($null -ne $first) { $script:last[(Doc-Key $d)] = @([int]$first, [int]$first + 1) }
  return @{ doc = [string]$d.Name; done = $done }
}

function BGR([string]$c) { return [Convert]::ToInt32($c.Substring(0, 2), 16) + 256 * [Convert]::ToInt32($c.Substring(2, 2), 16) + 65536 * [Convert]::ToInt32($c.Substring(4, 2), 16) }
# A table's look: the header row (repeats on each page, bold), column widths (inches), borders, the header's fill, alignment.
function Table-Look($t, $req) {
  if ($req.ContainsKey('header')) { $h = [bool]$req['header']; $t.Rows.Item(1).HeadingFormat = [int](-1 * [int]$h); $t.Rows.Item(1).Range.Font.Bold = [int]$h }
  if ($req.ContainsKey('borders')) {
    $b = [string]$req['borders']
    if ($b -eq 'none') { $t.Borders.Enable = 0 } elseif ($b -eq 'all') { $t.Borders.Enable = 1 } else { $t.Borders.Enable = 1; $t.Borders.InsideLineStyle = 0 }
  }
  if ($req.ContainsKey('shading')) { $t.Rows.Item(1).Shading.BackgroundPatternColor = (BGR ([string]$req['shading'])) }
  if ($req.ContainsKey('align')) { $t.Rows.Alignment = [int](@{ 'left' = 0; 'center' = 1; 'right' = 2 })[[string]$req['align']] }
  if ($req.ContainsKey('widths')) {
    $w = @($req['widths'])
    if ($w.Count -ne [int]$t.Columns.Count) { throw ('widths has ' + $w.Count + ' columns but the table has ' + [int]$t.Columns.Count + '. Nothing was changed.') }
    try { for ($i = 0; $i -lt $w.Count; $i++) { $t.Columns.Item($i + 1).Width = 72 * [double]$w[$i] } } catch { throw 'This table has merged cells, so its columns are not changed here. Change them in Word.' }
  }
}
# A table that is there: index (1-based) or find (text in one of its cells); its cells, new rows, a new column and its look.
function Cmd-TableEdit($d, $req) {
  $n = [int]$d.Tables.Count
  if ($n -eq 0) { throw 'This document has no table. Add one with table and rows.' }
  $t = $null; $no = 0
  if ($req.ContainsKey('index')) { $no = [int]$req['index']; if ($no -gt $n) { throw ('The document has ' + $n + ' table(s), so there is no table ' + $no + '.') }; $t = $d.Tables.Item($no) }
  else { $want = ([string]$req['find']).ToLowerInvariant(); for ($i = 1; $i -le $n; $i++) { if (([string]$d.Tables.Item($i).Range.Text).ToLowerInvariant().Contains($want)) { $t = $d.Tables.Item($i); $no = $i; break } } }
  if ($null -eq $t) { throw ('No table has a cell with "' + [string]$req['find'] + '". Use read to see the tables.') }
  $done = @{ index = $no; tables = $n }
  $cells = @(Arg $req 'cells' @())
  foreach ($c in $cells) { $r = [int]$c[0]; $k = [int]$c[1]; try { $cell = $t.Cell($r, $k) } catch { throw ('The table has no cell at row ' + $r + ', column ' + $k + '. Nothing more was changed.') }; $cell.Range.Text = (Rep-Text ([string]$c[2])) }
  if ($cells.Count) { $done.cells = $cells.Count }
  if ($req.ContainsKey('addRows')) {
    $after = [int]$req['addRows']; $rows = @($req['rows']); $count = [int]$t.Rows.Count
    if ($after -lt 0 -or $after -gt $count) { $after = $count }
    for ($i = 0; $i -lt $rows.Count; $i++) {
      $at = $after + $i
      if ($at -ge [int]$t.Rows.Count) { $row = $t.Rows.Add() } else { $row = $t.Rows.Add($t.Rows.Item($at + 1)) }
      $vals = @($rows[$i]); $nc = [int]$row.Cells.Count
      if ($vals.Count -gt $nc) { throw ('The table has ' + $nc + ' columns, so a row of ' + $vals.Count + ' cells does not fit.') }
      for ($j = 0; $j -lt $vals.Count; $j++) { $row.Cells.Item($j + 1).Range.Text = [string]$vals[$j] }
    }
    $done.rows = $rows.Count
  }
  if ($req.ContainsKey('addColumn')) {
    $after = [int]$req['addColumn']; $nc = [int]$t.Columns.Count
    try { if ($after -lt 0 -or $after -ge $nc) { [void]$t.Columns.Add() } else { [void]$t.Columns.Add($t.Columns.Item($after + 1)) } } catch { throw 'This table has merged cells, so its columns are not changed here. Change them in Word.' }
    if ($after -lt 0 -or $after -gt $nc) { $after = $nc }
    $done.column = $after + 1
  }
  Table-Look $t $req
  $script:last[(Doc-Key $d)] = @([int]$t.Range.Start, [int]$t.Range.End)
  return @{ doc = [string]$d.Name; done = $done }
}

function Cmd-Table($req) {
  $d = Find-Doc $req
  if ($req.ContainsKey('index') -or $req.ContainsKey('find')) { return (Cmd-TableEdit $d $req) }
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
  if (-not $req.ContainsKey('header') -and $nr -gt 1) { $req['header'] = $true }
  Table-Look $t $req
  $n = $null
  if ($req.ContainsKey('caption')) { $n = Add-Caption $d $t.Range 'Table' ([string]$req['caption']) 0 }
  $script:last[(Doc-Key $d)] = @([int]$t.Range.Start, [int]$t.Range.End)
  return @{ doc = [string]$d.Name; rows = $nr; columns = $nc; caption = $n }
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
  $pic.LockAspectRatio = -1
  if ($req.ContainsKey('width') -and $req.ContainsKey('height')) { $pic.LockAspectRatio = 0; $pic.Width = 72 * [double]$req['width']; $pic.Height = 72 * [double]$req['height'] }
  elseif ($req.ContainsKey('width')) { $pic.Width = 72 * [double]$req['width'] }
  elseif ($req.ContainsKey('height')) { $pic.Height = 72 * [double]$req['height'] }
  elseif ($pic.Width -gt $max) { $pic.Width = $max }
  if ($req.ContainsKey('alt')) { $pic.AlternativeText = [string]$req['alt'] }
  $align = [string](Arg $req 'align' 'center')
  $wrap = [string](Arg $req 'wrap' 'inline')
  if ($wrap -eq 'inline') { $pic.Range.ParagraphFormat.Alignment = [int](@{ 'left' = 0; 'center' = 1; 'right' = 2 })[$align] }
  $n = $null
  if ($req.ContainsKey('caption')) { $n = Add-Caption $d $pic.Range 'Figure' ([string]$req['caption']) 1; $pic.Range.ParagraphFormat.KeepWithNext = -1 }
  if ($wrap -ne 'inline') {
    $sh = $pic.ConvertToShape()
    $sh.WrapFormat.Type = [int](@{ 'square' = 0; 'tight' = 1; 'top_bottom' = 4; 'behind' = 5; 'front' = 3 })[$wrap]
    $sh.RelativeHorizontalPosition = 2
    $sh.Left = [int](@{ 'left' = -999998; 'center' = -999995; 'right' = -999996 })[$align]
  }
  $script:last[(Doc-Key $d)] = @($pos, $pos + 1)
  return @{ doc = [string]$d.Name; caption = $n; size = @{ width = [Math]::Round($pic.Width / 72, 2); height = [Math]::Round($pic.Height / 72, 2) } }
}

# A caption (Word's own Insert Caption: the Caption style and a SEQ field): below (1) a picture, above (0) a table. -> its number.
function Add-Caption($d, $range, [string]$label, [string]$text, [int]$where) {
  $labels = $d.Application.CaptionLabels
  $have = $false; foreach ($l in $labels) { if ([string]$l.Name -eq $label) { $have = $true } }
  if (-not $have) { [void]$labels.Add($label) }
  $title = ''; if ($text) { $title = ': ' + $text }
  $range.InsertCaption($label, $title, '', $where)
  # the numbers in order again (the captions after this one move up), and this caption's number: the SEQ field nearest the picture or table
  $best = $null; $gap = [int]::MaxValue
  foreach ($f in $d.Fields) {
    if (([string]$f.Code.Text) -notmatch ('^\s*SEQ ' + $label + '\b')) { continue }
    [void]$f.Update()
    $g = [Math]::Min([Math]::Abs([int]$f.Result.Start - [int]$range.End), [Math]::Abs([int]$f.Result.Start - [int]$range.Start))
    if ($g -lt $gap) { $gap = $g; $best = $f }
  }
  if ($null -eq $best) { return $null }
  return [int]([string]$best.Result.Text -replace '\D', '')
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
    try { $a.Visible = $true; if ([int]$a.WindowState -eq 2) { $a.WindowState = 0 }; $a.Activate(); $d.Activate() } catch { }   # (a minimized Word is restored)
    $span = $script:last[(Doc-Key $d)]
    # at: the paragraph a read began at (the card's "Show in Word" before anything was changed); data, clamped, never text of a script
    $at = Arg $req 'at' $null
    if ($null -ne $at) {
      try { $n = [int]$d.Paragraphs.Count; if ($n -ge 1) { $r = $d.Paragraphs.Item([Math]::Min([Math]::Max([int]$at + 1, 1), $n)).Range; $span = @([int]$r.Start, [int]$r.Start) } } catch { }
    }
    if ($span) { try { $sel = $a.Selection; $sel.SetRange([int]$span[0], [int]$span[1]); $d.ActiveWindow.ScrollIntoView($sel.Range, $true) } catch { } }
  }
  $hwnd = 0; try { $hwnd = [int64]$a.Hwnd } catch { }
  return @{ doc = [string]$d.Name; shown = (-not $HIDDEN); hwnd = $hwnd }   # (hwnd: Lumen raises the window, having the foreground at the click)
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
    'format' { return Cmd-Format $req }
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
    'test_text' { if (-not $TEST) { throw 'Unknown command test_text' }; return @{ find = (Esc-Find ([string]$req['value'])); replace = (Rep-Text ([string]$req['value'])) } }
    'test_fail' { if (-not $TEST) { throw 'Unknown command test_fail' }; $script:app = 'held'; $x = $null; $x.Open() }
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
    $msg = [string]$_.Exception.Message
    # Word went away under us (the user closed it, or it is closing or busy with a dialog): let it go, so the next call finds the Word that is
    # running now, and say what to do instead of PowerShell's words.
    if ($msg -match 'null-valued expression|RPC server is unavailable|disconnected from its clients|0x800706BA|0x80010108|0x80010001|Call was rejected') {
      $script:app = $null
      $msg = 'Word stopped answering: it was closed, or it is showing a message. Call list to see what Word has open now, then open the document again.'
    }
    Send @{ id = $rid; ok = $false; error = $msg }
  }
}
