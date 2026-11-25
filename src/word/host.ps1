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

# Word's main window. Word's Application has no Hwnd (it reads as empty, so the card's picture was always "hidden" and Show in Word raised nothing):
# a document window has one (Word 2013+); Word's own process's main window when no document window answers. Never another program's window.
function Word-Hwnd($a, $d) {
  foreach ($w in @($(if ($d) { try { $d.ActiveWindow } catch { $null } }), $(try { $a.ActiveWindow } catch { $null }))) {
    if ($w) { try { $h = [int64]$w.Hwnd; if ($h -ne 0) { return $h } } catch { } }
  }
  try { $p = Get-Process WINWORD -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if ($p) { return [int64]$p.MainWindowHandle } } catch { }
  return [int64]0
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
  $nums = [bool](Arg $req 'numbers' $false)   # [n] before each paragraph (a table: its first row), the number para and inspect take
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
      $first = $true
      foreach ($ri in $order) { $line = '| ' + ($rows[$ri] -join ' | ') + ' |'; if ($nums -and $first) { $line = '[' + $i + '] ' + $line }; $first = $false; [void]$out.Add($line); $used += $line.Length }
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
    if ($nums) { $line = '[' + $i + '] ' + $line }
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
  if ($req.ContainsKey('para') -or $req.ContainsKey('under')) {
    # after paragraph para, or at the end of the section under a heading path
    $sc = Scope-Of $d $req
    if ($req.ContainsKey('para')) { $target = [int]$sc.a } else { $target = [int]$sc.b }
    $pr = $d.Paragraphs.Item($target).Range
    if ($pr.Information(12)) { $pr = $pr.Tables.Item(1).Range }
    if ($target -ge $n -or $pr.End -ge $d.Content.End) { return (Locate $d @{ at = 'end' }) }
    return @{ pos = [int]$pr.End; lead = $false; trail = $true }
  }
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

# In the text, right after the first place find matches: text, a footnote or endnote, or a cross-reference (a caption "Figure 2" / "Table 1",
# or a bookmark), with Word's own Footnotes.Add / Endnotes.Add / InsertCrossReference.
function Cmd-InsertAt($d, $req) {
  $hits = Find-All $d ([string]$req['find']) 1 $false (Scope-Of $d $req) (Skip-Of $d $req)
  if ($hits.Count -eq 0) { throw ('No match for "' + [string]$req['find'] + '" (find is the exact text, with its case). Use read to see the text.') }
  $r = $d.Range([int]$hits[0].End, [int]$hits[0].End)
  $done = @{}
  if ($req.ContainsKey('ref')) {
    $ref = [string]$req['ref']
    if ($req.ContainsKey('text')) { $r.InsertAfter([string]$req['text']); $r.Collapse(0) }
    elseif (-not ([string]$req['find']).EndsWith(' ')) { $r.InsertAfter(' '); $r.Collapse(0) }
    if ($ref -match '^(?i)(figure|table) (\d+)$') {
      $label = $Matches[1].Substring(0, 1).ToUpper() + $Matches[1].Substring(1).ToLower()
      $items = @($d.GetCrossReferenceItems($label))
      if ([int]$Matches[2] -gt $items.Count) { throw ('There is no ' + $label + ' ' + $Matches[2] + ' caption to point at. Add one with a caption, or use read to see the captions.') }
      $r.InsertCrossReference($label, 3, [int]$Matches[2], $true)
    } else {
      if (-not $d.Bookmarks.Exists($ref)) { throw ('There is no bookmark named ' + $ref + '. Make one with style (find, bookmark).') }
      $r.InsertCrossReference(2, -1, $ref, $true)
    }
    $done.ref = $ref
  } elseif ($req.ContainsKey('note')) {
    $miss = [Type]::Missing
    if ([string]$req['note'] -eq 'endnote') { [void]$d.Endnotes.Add($r, $miss, [string]$req['text']) } else { [void]$d.Footnotes.Add($r, $miss, [string]$req['text']) }
    $done.note = @{ kind = [string]$req['note'] }
  } else {
    foreach ($tok in ([regex]::Split([string]$req['text'], '(\{date\})', 'IgnoreCase'))) {
      if ($tok -eq '') { continue }
      if ($tok -match '^(?i)\{date\}$') { $f = $d.Fields.Add($r, 31, '\@ "MMMM d, yyyy"', $false); $r = $d.Range([int]$f.Result.End + 1, [int]$f.Result.End + 1) } else { $r.InsertAfter($tok); $r.Collapse(0) }
    }
    $done.text = $true
  }
  $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].End + 1)
  return @{ doc = [string]$d.Name; done = $done; tracking = [bool]$d.TrackRevisions }
}

function Cmd-Insert($req) {
  $d = Find-Doc $req
  if ($req.ContainsKey('find')) { return (Cmd-InsertAt $d $req) }
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

# Every place `find` occurs (up to a cap): ranges. scope (Scope-Of): only there; skip (Field-Spans): not inside those (the table of contents
# and fields), counted in $script:skipped.
$script:skipped = 0
function Find-All($d, [string]$find, [int]$cap, [bool]$whole = $false, $scope = $null, $skip = $null) {
  $res = New-Object System.Collections.ArrayList
  $script:skipped = 0
  $end = [int]$d.Content.End
  $pos = 0
  if ($scope) { $pos = [int]$scope.s; $end = [int]$scope.e }
  # (each search starts where the last match ended: inside a field Word can hand back the same match again, so a search that does not move on
  # steps one character instead of looping)
  $guard = 0
  while ($res.Count -lt $cap -and $pos -lt $end -and $guard -lt ($cap + 5000)) {
    $guard++
    $r = $d.Range($pos, $end)
    $f = $r.Find
    $f.ClearFormatting()
    $f.Text = (Esc-Find $find)
    $f.Forward = $true; $f.Wrap = 0; $f.MatchCase = $true; $f.MatchWildcards = $false; $f.MatchWholeWord = $whole
    if (-not $f.Execute()) { break }
    $rs = [int]$r.Start; $re = [int]$r.End
    if ($re -gt $end) { break }   # (past the scope)
    if ($rs -lt $pos) { $pos++; continue }
    if ($skip -and (In-Spans $rs $re $skip)) { $script:skipped++ } else { [void]$res.Add($d.Range($rs, $re)) }
    $pos = [Math]::Max($re, $pos + 1)
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
  $scope = Scope-Of $d $req
  $hits = Find-All $d $find $cap ([bool](Arg $req 'wholeWord' $false)) $scope (Skip-Of $d $req)
  $skipped = $script:skipped
  $count = 0
  if ($hits.Count -gt 0) { $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].Start + $rep.Length) }
  $locked = 0
  for ($k = $hits.Count - 1; $k -ge 0; $k--) {
    $cc = Unlock-Around $hits[$k]   # (inside a locked content control: unlocked for this change, locked again after)
    if ($cc) { $locked++ }
    try {
      $hits[$k].Text = $rep
      if ($rep -ne '') { Set-Char $hits[$k].Font $req; Set-Highlight $hits[$k] $req }   # (the new text's look, when one is asked for)
    } finally { Relock $cc }
    $count++
  }
  return @{ doc = [string]$d.Name; replaced = $count; capped = ($count -ge $cap); skipped = $skipped; locked = $locked; scope = $(if ($scope) { @{ a = $scope.a; b = $scope.b; name = $scope.name } } else { $null }) }
}

function Cmd-Style($req) {
  $d = Find-Doc $req
  $scope = Scope-Of $d $req
  $skipped = 0
  if ($req.ContainsKey('find')) { $hits = Find-All $d ([string]$req['find']) 200 $false $scope (Skip-Of $d $req); $skipped = $script:skipped }
  else { $hits = New-Object System.Collections.ArrayList; foreach ($p in $d.Range([int]$scope.s, [int]$scope.e).Paragraphs) { [void]$hits.Add($p.Range) } }   # (para or under alone: those whole paragraphs)
  $done = 0
  if ($req.ContainsKey('style')) { $null = Get-Style $d ([string]$req['style']) }   # (a style the document lacks changes nothing)
  foreach ($h in $hits) {
    if ($req.ContainsKey('style')) { Set-Style $d $h.Paragraphs.Item(1).Range ([string]$req['style']) }
    Set-Char $h.Font $req
    Set-Highlight $h $req
    $done++
  }
  $extra = @{ formatted = $done; skipped = $skipped; paragraphs = (-not $req.ContainsKey('find')) }
  if ($req.ContainsKey('bookmark') -and $done -gt 0) {
    if ($d.Bookmarks.Exists([string]$req['bookmark'])) { throw ('There is already a bookmark named ' + [string]$req['bookmark'] + '. Use another name.') }
    [void]$d.Bookmarks.Add([string]$req['bookmark'], $hits[0]); $extra.bookmark = [string]$req['bookmark']
  }
  if ($req.ContainsKey('link') -and $done -gt 0) {
    $l = [string]$req['link']; $links = 0
    for ($k = $hits.Count - 1; $k -ge 0; $k--) { if ($l.StartsWith('#')) { [void]$d.Hyperlinks.Add($hits[$k], '', $l.Substring(1)) } else { [void]$d.Hyperlinks.Add($hits[$k], $l) }; $links++ }
    $extra.links = $links
  }
  if ($done -gt 0) { $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].End) }
  return (@{ doc = [string]$d.Name } + $extra)
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
  $missing = @(); foreach ($t in @($texts)) { if ((Para-Of $d $t) -eq 0) { $missing += ('"' + $t + '"') } }
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

# A header's or footer's text: "left <tab> center <tab> right" on the Header / Footer style's own tab stops, with {page}, {pages} and {date}
# as Word's PAGE, NUMPAGES and DATE fields. parts: @{ left; center; right }.
function Set-HeaderText($d, $r, $parts) {
  $r.Text = ''
  $pieces = @([string](Arg $parts 'left' ''), [string](Arg $parts 'center' ''), [string](Arg $parts 'right' ''))
  $seq = New-Object System.Collections.ArrayList
  [void]$seq.Add($pieces[0])
  if ($pieces[1] -or $pieces[2]) { [void]$seq.Add("`t"); [void]$seq.Add($pieces[1]) }
  if ($pieces[2]) { [void]$seq.Add("`t"); [void]$seq.Add($pieces[2]) }
  foreach ($chunk in $seq) {
    foreach ($tok in ([regex]::Split([string]$chunk, '(\{page\}|\{pages\}|\{date\})', 'IgnoreCase'))) {
      if ($tok -eq '') { continue }
      $end = $r.Duplicate; $end.Collapse(0)
      switch -regex ($tok) {
        '^(?i)\{page\}$' { [void]$d.Fields.Add($end, 33) }
        '^(?i)\{pages\}$' { [void]$d.Fields.Add($end, 26) }
        '^(?i)\{date\}$' { [void]$d.Fields.Add($end, 31, '\@ "MMMM d, yyyy"', $false) }
        default { $end.InsertAfter($tok) }
      }
      $r.End = $r.StoryLength
    }
  }
}

function Cmd-Format($req) {
  $d = Find-Doc $req
  $done = @{}
  # every paragraph a change names is found first: a missing one changes nothing
  $heads = @(Arg $req 'headings' @())
  $breaks = @(Arg $req 'breaks' @())
  $targets = @(Arg $req 'paras' @())
  $texts = @(); foreach ($h in $heads) { $texts += [string]$h['text'] }; foreach ($b in $breaks) { $texts += $b }; foreach ($t in $targets) { $texts += $t }; foreach ($k in @('sectionBreaks', 'columnBreaks')) { foreach ($t in @(Arg $req $k @())) { $texts += $t } }   # (a paragraph number stays a number)
  if ($req.ContainsKey('toc') -and $req.ContainsKey('tocAt')) { $texts += [string]$req['tocAt'] }
  if ($texts.Count) { Need-Paras $d $texts }
  $scope = Scope-Of $d $req
  $skip = Skip-Of $d $req
  if ($req.ContainsKey('find') -and ((Has-Text $req) -or (Has-Spacing $req) -or $req.ContainsKey('list'))) { if ((Find-All $d ([string]$req['find']) 1 $false $scope $skip).Count -eq 0) { throw ('No paragraph contains "' + [string]$req['find'] + '". Use read to see the text.') } }
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
    $marks = @(); foreach ($b in $breaks) { $marks += [pscustomobject]@{ t = [string]$b; i = [int](Para-Of $d $b) } }
    foreach ($x in @($marks | Sort-Object -Property i -Descending)) {
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
  if ($targets.Count -or ($req.ContainsKey('find') -and $req.ContainsKey('list')) -or ($scope -and -not $req.ContainsKey('find'))) {
    # the paragraphs named (or holding the find text): their own formatting, and a list
    $ps = New-Object System.Collections.ArrayList
    if ($targets.Count) { foreach ($t in $targets) { [void]$ps.Add($d.Paragraphs.Item((Para-Of $d $t))) } }
    elseif (-not $req.ContainsKey('find')) { foreach ($sp in $d.Range([int]$scope.s, [int]$scope.e).Paragraphs) { [void]$ps.Add($sp) } }   # (para or under: those paragraphs)
    else { $seen = @{}; foreach ($h in (Find-All $d ([string]$req['find']) 200 $false $scope $skip)) { foreach ($hp in $h.Paragraphs) { $k = [int]$hp.Range.Start; if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; [void]$ps.Add($hp) } } } }
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
      $hits = Find-All $d ([string]$req['find']) 200 $false $scope $skip
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
  # section and column breaks before paragraphs (before the section-numbered changes below, which count the sections they make)
  foreach ($pair in @(@('sectionBreaks', 'sectionBreaks'), @('columnBreaks', 'columnBreaks'))) {
    $list = @(Arg $req $pair[0] @())
    if (-not $list.Count) { continue }
    $code = 8; if ($pair[0] -eq 'sectionBreaks') { $code = [int](@{ 'nextPage' = 2; 'continuous' = 3; 'evenPage' = 4; 'oddPage' = 5 })[[string](Arg $req 'sectionBreak' 'nextPage')] }
    $added = @(); $had = @()
    $marks = @(); foreach ($b in $list) { $marks += [pscustomobject]@{ t = [string]$b; i = [int](Para-Of $d $b) } }
    foreach ($x in @($marks | Sort-Object -Property i -Descending)) {
      $p = $d.Paragraphs.Item($x.i)
      $name = Para-Text $p
      if ($x.i -eq 1) { $had = @($name) + $had; continue }
      $d.Range($p.Range.Start, $p.Range.Start).InsertBreak($code)
      $added = @($name) + $added
      $first = [int]$p.Range.Start
    }
    $done[$pair[1]] = @{ added = $added; had = $had }
  }
  $hf = $req.ContainsKey('header') -or $req.ContainsKey('footer') -or $req.ContainsKey('firstPage') -or $req.ContainsKey('pageStart') -or $req.ContainsKey('columns')
  if ($req.ContainsKey('margins') -or $req.ContainsKey('orientation') -or $hf) {
    $secs = @(); $i = 0
    foreach ($s in $d.Sections) { $i++; if (-not $req.ContainsKey('section') -or [int]$req['section'] -eq $i) { $secs += $s } }
    if ($req.ContainsKey('section') -and [int]$req['section'] -gt $i) { throw ('The document has ' + $i + ' section(s), so there is no section ' + [int]$req['section'] + '.') }
    foreach ($s in $secs) {
      $ps = $s.PageSetup
      if ($req.ContainsKey('orientation')) { if ([string]$req['orientation'] -eq 'landscape') { $ps.Orientation = 1 } else { $ps.Orientation = 0 } }
      if ($req.ContainsKey('margins')) { $m = $req['margins']; $ps.TopMargin = 72 * [double]$m['top']; $ps.RightMargin = 72 * [double]$m['right']; $ps.BottomMargin = 72 * [double]$m['bottom']; $ps.LeftMargin = 72 * [double]$m['left'] }
      if ($req.ContainsKey('columns')) { $ps.TextColumns.SetCount([int]$req['columns']) }
      if ($req.ContainsKey('firstPage')) { $ps.DifferentFirstPageHeaderFooter = [int](-1 * [int][bool]$req['firstPage']) }
      foreach ($kind in @('header', 'footer')) {
        if (-not $req.ContainsKey($kind)) { continue }
        if ($kind -eq 'header') { $hdr = $s.Headers.Item(1) } else { $hdr = $s.Footers.Item(1) }
        if ($req.ContainsKey('section')) { $hdr.LinkToPrevious = $false }
        Set-HeaderText $d $hdr.Range $req[$kind]
      }
      if ($req.ContainsKey('pageStart')) { $pn = $s.Footers.Item(1).PageNumbers; $pn.RestartNumberingAtSection = $true; $pn.StartingNumber = [int]$req['pageStart'] }
    }
    $done.sections = $secs.Count
    if ($req.ContainsKey('header') -or $req.ContainsKey('footer') -or $req.ContainsKey('firstPage')) { $done.headers = @{ header = $req.ContainsKey('header'); footer = $req.ContainsKey('footer'); firstPage = (Arg $req 'firstPage' $null) } }
  }
  if ($req.ContainsKey('properties')) { Set-Properties $d $req['properties']; $done.properties = @($req['properties'].Keys) }
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
  # rows or columns taken out (a call of their own): preview says what would go, for the card that asks first; the guard keeps one of each
  foreach ($kind in @('deleteRows', 'deleteColumns')) {
    if (-not $req.ContainsKey($kind)) { continue }
    $a = [int]$req[$kind][0]; $b = [int]$req[$kind][1]
    $isRows = ($kind -eq 'deleteRows')
    if ($isRows) { $total = [int]$t.Rows.Count; $what = 'row' } else { $total = [int]$t.Columns.Count; $what = 'column' }
    if ($b -gt $total) { throw ('The table has ' + $total + ' ' + $what + '(s), so there is no ' + $what + ' ' + $b + '. Nothing was changed.') }
    if ($b - $a + 1 -ge $total) { throw ('That is every ' + $what + ' of the table, so nothing was deleted. To take the table out, remove the whole table instead (in Word: select it, then Layout > Delete > Delete Table); a table keeps at least one ' + $what + ' here.') }
    $lines = @()
    for ($i = $a; $i -le $b; $i++) {
      $texts = @()
      foreach ($c in $t.Range.Cells) { if (($isRows -and [int]$c.RowIndex -eq $i) -or (-not $isRows -and [int]$c.ColumnIndex -eq $i)) { $texts += (Clean-Cell ([string]$c.Range.Text)) } }
      if ($isRows) { $lines += ('Row ' + $i + ': | ' + ($texts -join ' | ') + ' |') } else { $lines += ('Column ' + $i + ': ' + ($texts -join ' / ')) }
    }
    if ($req.ContainsKey('preview')) { return @{ doc = [string]$d.Name; preview = @{ lines = $lines; count = ($b - $a + 1); index = $no } } }
    try {
      for ($i = $b; $i -ge $a; $i--) { if ($isRows) { $t.Rows.Item($i).Delete() } else { $t.Columns.Item($i).Delete() } }
    } catch { throw ('Word could not take those ' + $what + 's out of this table (it has merged cells across them). Unmerge the cells first, or use the file route.') }
    if ($isRows) { $done.deletedRows = $b - $a + 1 } else { $done.deletedColumns = $b - $a + 1 }
    $done.deleted = $lines
  }
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
  $hits = Find-All $d ([string]$req['find']) 1 $false (Scope-Of $d $req) (Skip-Of $d $req)
  if ($hits.Count -eq 0) { throw 'That text was not found in the document, so there is nothing to comment on.' }
  [void]$d.Comments.Add($hits[0], [string]$req['text'])
  $script:last[(Doc-Key $d)] = @([int]$hits[0].Start, [int]$hits[0].End)
  return @{ doc = [string]$d.Name }
}

function Cmd-Track($req) {
  $d = Find-Doc $req
  if ($req.ContainsKey('review')) { return (Cmd-Review $d $req) }
  $d.TrackRevisions = [bool]$req['on']
  return @{ doc = [string]$d.Name; tracking = [bool]$d.TrackRevisions }
}
# The tracked changes accepted or rejected with Word's own Accept and Reject: all, one author's, or those in the paragraphs holding find.
function Cmd-Review($d, $req) {
  $accept = ([string]$req['review'] -eq 'accept')
  $author = [string](Arg $req 'author' '')
  $scopes = New-Object System.Collections.ArrayList
  if ($req.ContainsKey('find')) {
    $hits = Find-All $d ([string]$req['find']) 200
    if ($hits.Count -eq 0) { throw ('No paragraph contains "' + [string]$req['find'] + '". Use read to see the text.') }
    $seen = @{}; foreach ($h in $hits) { foreach ($p in $h.Paragraphs) { $k = [int]$p.Range.Start; if (-not $seen.ContainsKey($k)) { $seen[$k] = $true; [void]$scopes.Add($p.Range) } } }
  } else { [void]$scopes.Add($d.Content) }
  $count = 0
  foreach ($sc in $scopes) {
    $revs = $sc.Revisions
    for ($i = [int]$revs.Count; $i -ge 1; $i--) {
      $rv = $revs.Item($i)
      if ($author -and ([string]$rv.Author).ToLowerInvariant() -ne $author.ToLowerInvariant()) { continue }
      if ($accept) { $rv.Accept() } else { $rv.Reject() }
      $count++
    }
  }
  return @{ doc = [string]$d.Name; reviewed = $count; tracking = [bool]$d.TrackRevisions }
}
# The document's own properties (File > Info): title, author, subject, keywords. (BuiltInDocumentProperties is late-bound, so by name.)
function Set-Properties($d, $props) {
  $map = @{ 'title' = 'Title'; 'author' = 'Author'; 'subject' = 'Subject'; 'keywords' = 'Keywords' }
  $all = $d.BuiltInDocumentProperties
  $flags = [Reflection.BindingFlags]
  foreach ($k in @($props.Keys)) {
    $p = [System.__ComObject].InvokeMember('Item', $flags::GetProperty, $null, $all, @($map[[string]$k]))
    [void][System.__ComObject].InvokeMember('Value', $flags::SetProperty, $null, $p, @([string]$props[$k]))
  }
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
  $hwnd = Word-Hwnd $a $d
  return @{ doc = [string]$d.Name; shown = (-not $HIDDEN); hwnd = $hwnd }   # (hwnd: Lumen raises the window, having the foreground at the click)
}

# ---- targeting: paragraphs by number (para, to) or by a heading path (under), and the table of contents and fields a find leaves out
# The paragraphs in one pass (Paragraphs.Item(i) walks from the start every time): number, start, end, outline level, text.
function Outline($d) {
  $rows = New-Object System.Collections.ArrayList
  $i = 0
  foreach ($p in $d.Paragraphs) { $i++; $r = $p.Range; [void]$rows.Add(@{ i = $i; s = [int]$r.Start; e = [int]$r.End; lv = [int]$p.OutlineLevel; t = (Para-Text $p) }) }
  return , $rows.ToArray()
}
function Toc-Spans($d) { $s = New-Object System.Collections.ArrayList; foreach ($t in $d.TablesOfContents) { [void]$s.Add(@([int]$t.Range.Start, [int]$t.Range.End)) }; return , $s.ToArray() }
# What a find leaves out unless include_fields: the tables of contents and every field whose text Word writes (a hyperlink's text is the author's).
function Field-Spans($d) {
  $s = New-Object System.Collections.ArrayList
  foreach ($t in $d.TablesOfContents) { [void]$s.Add(@([int]$t.Range.Start, [int]$t.Range.End)) }
  foreach ($f in $d.Fields) { if ([int]$f.Type -eq 88) { continue }; try { [void]$s.Add(@([int]$f.Result.Start, [int]$f.Result.End)) } catch { } }
  return , $s.ToArray()
}
function Skip-Of($d, $req) { if ([bool](Arg $req 'fields' $false)) { return $null }; return (Field-Spans $d) }
function In-Spans([int]$a, [int]$b, $spans) { if (-not $spans) { return $false }; foreach ($x in $spans) { if ($a -lt [int]$x[1] -and [Math]::Max($b, $a + 1) -gt [int]$x[0]) { return $true } }; return $false }
function Head-Key([string]$t) { return (($t -replace '^\s*\d+(\.\d+)*[.)]?\s+(?=\S)', '').Trim().ToLowerInvariant()) }
# A heading path ("Results", "Discussion"): each heading found inside the section of the one before it (deeper), never in the table of contents.
# -> @{ a; b (its first and last paragraph numbers); s; e (character offsets); name }
function Under-Span($d, $rows, $path) {
  $toc = Toc-Spans $d
  $from = 0; $to = $rows.Count - 1; $lvl = 0; $name = ''
  foreach ($part in @($path)) {
    $raw = ([string]$part).Trim().ToLowerInvariant(); $want = Head-Key ([string]$part)
    $hit = -1; $loose = -1
    for ($k = $from; $k -le $to; $k++) {
      $row = $rows[$k]
      if ([int]$row.lv -gt 9 -or [int]$row.lv -le $lvl -or $row.t -eq '') { continue }
      if (In-Spans $row.s $row.e $toc) { continue }
      $tl = ([string]$row.t).ToLowerInvariant()
      if ($tl -eq $raw -or (Head-Key $row.t) -eq $want) { $hit = $k; break }
      if ($loose -lt 0 -and (Head-Key $row.t).StartsWith($want)) { $loose = $k }
    }
    if ($hit -lt 0) { $hit = $loose }
    if ($hit -lt 0) { $in = ''; if ($name) { $in = ' under "' + $name + '"' }; throw ('No heading "' + [string]$part + '"' + $in + ' in the document, so nothing was changed. inspect or read shows the headings.') }
    $hl = [int]$rows[$hit].lv
    $end = $to
    for ($k = $hit + 1; $k -le $to; $k++) { if ([int]$rows[$k].lv -le $hl) { $end = $k - 1; break } }
    $from = $hit; $to = $end; $lvl = $hl; $name = [string]$rows[$hit].t
  }
  return @{ a = [int]$rows[$from].i; b = [int]$rows[$to].i; s = [int]$rows[$from].s; e = [int]$rows[$to].e; name = $name }
}
# Where an edit is limited to: $null (the whole document) or @{ a; b; s; e; name }.
function Scope-Of($d, $req) {
  if ($req.ContainsKey('para')) {
    $n = [int]$d.Paragraphs.Count
    $a = [int]$req['para']; $b = [int](Arg $req 'to' $a)
    if ($a -gt $n) { throw ('The document has ' + $n + ' paragraphs, so there is no paragraph ' + $a + '. Nothing was changed; inspect shows the numbers.') }
    if ($b -gt $n) { $b = $n }
    $pa = $d.Paragraphs.Item($a).Range; $pb = $pa
    if ($b -ne $a) { $pb = $d.Paragraphs.Item($b).Range }
    return @{ a = $a; b = $b; s = [int]$pa.Start; e = [int]$pb.End; name = '' }
  }
  if ($req.ContainsKey('under')) { return (Under-Span $d (Outline $d) $req['under']) }
  return $null
}
# A paragraph named by its number (as inspect shows it) or its text (Find-Para). 0: none.
function Para-Of($d, $t) {
  if ($t -is [int] -or $t -is [long] -or $t -is [decimal] -or $t -is [double]) { $k = [int]$t; if ($k -ge 1 -and $k -le [int]$d.Paragraphs.Count) { return $k }; return 0 }
  return (Find-Para $d ([string]$t))
}
function Para-No($d, [int]$pos) { return [int]$d.Range(0, [Math]::Min($pos + 1, [int]$d.Content.End)).Paragraphs.Count }
# A locked content control around a range (Word's own contents block is one): unlocked for the change, and locked again after it.
function Unlock-Around($r) { $cc = $null; try { $cc = $r.ParentContentControl } catch { }; if ($cc -and [bool]$cc.LockContents) { $cc.LockContents = $false; return $cc }; return $null }
function Relock($cc) { if ($cc) { try { $cc.LockContents = $true } catch { } } }

# ---- inspect: each paragraph's formatting as Word has it (style, font, size, spacing, breaks, where it sits), and the body font and pages
$SECTION_START = @{ 0 = 'continuous'; 1 = 'new column'; 2 = 'new page'; 3 = 'even page'; 4 = 'odd page' }
$ALIGN_NAME = @{ 0 = 'left'; 1 = 'center'; 2 = 'right'; 3 = 'justify'; 4 = 'distribute' }
$CC_TYPE = @{ 0 = 'rich text'; 1 = 'text'; 2 = 'picture'; 3 = 'combo box'; 4 = 'drop-down'; 5 = 'building block'; 6 = 'date'; 7 = 'group'; 8 = 'check box'; 9 = 'repeating section' }
function Clip([string]$s, [int]$n) { $t = ($s -replace '[\r\n\a\f\v]+', ' ').Trim(); if ($t.Length -gt $n) { return $t.Substring(0, $n - 3) + '...' }; return $t }
function Line-Of($pf) {
  $rule = [int]$pf.LineSpacingRule; $ls = [double]$pf.LineSpacing
  switch ($rule) { 0 { return '1' } 1 { return '1.5' } 2 { return '2' } 3 { return ('at least ' + $ls + ' pt') } 4 { return ('exactly ' + $ls + ' pt') } default { return ([Math]::Round($ls / 12, 2)).ToString([Globalization.CultureInfo]::InvariantCulture) } }
}
function Font-Of($f) {
  $o = @{ font = [string]$f.Name }
  $sz = [double]$f.Size; if ($sz -lt 9999) { $o.size = $sz }
  $bo = [int]$f.Bold; if ($bo -eq -1 -or $bo -eq 1) { $o.bold = $true } elseif ($bo -ne 0) { $o.bold = 'mixed' }
  $it = [int]$f.Italic; if ($it -eq -1 -or $it -eq 1) { $o.italic = $true } elseif ($it -ne 0) { $o.italic = 'mixed' }
  return $o
}
function Para-Row($d, $p, [int]$i, $ctx) {
  $r = $p.Range
  $raw = [string]$r.Text
  $s = [int]$r.Start; $e = [int]$r.End
  $row = Font-Of $r.Font
  $row.i = $i
  $row.text = Clip (Para-Text $p) 80
  try { $row.style = [string]$p.Style.NameLocal } catch { $row.style = '' }
  $pf = $p.Format
  $row.before = [double]$pf.SpaceBefore; $row.after = [double]$pf.SpaceAfter; $row.line = Line-Of $pf
  $row.align = [string]$ALIGN_NAME[[int]$pf.Alignment]
  if ([double]$pf.LeftIndent -ne 0) { $row.indent = [Math]::Round([double]$pf.LeftIndent / 72, 2) }
  if ([double]$pf.FirstLineIndent -ne 0) { $row.firstLine = [Math]::Round([double]$pf.FirstLineIndent / 72, 2) }
  if ([int]$pf.PageBreakBefore -ne 0) { $row.pageBreakBefore = $true }
  if ([int]$pf.KeepWithNext -ne 0) { $row.keepNext = $true }
  $lv = [int]$p.OutlineLevel; if ($lv -le 9) { $row.level = $lv }
  # a section break ends its paragraph (char 12 in place of the paragraph mark); a manual page break is a char 12 inside it; char 14 a column break
  $ffs = $raw.Length - $raw.Replace($FF, '').Length
  if ($raw.EndsWith($FF) -and $ctx.secs.ContainsKey($e)) { $row.sectionBreak = $ctx.secs[$e]; $ffs-- }
  if ($ffs -gt 0) { $row.pageBreaks = $ffs }
  $cols = $raw.Length - $raw.Replace([string][char]14, '').Length; if ($cols -gt 0) { $row.columnBreaks = $cols }
  try { $row.page = [int]$d.Range($s, $s).Information(3) } catch { }
  if ([int]$r.ListFormat.ListType -ne 0) { $row.list = [string]$r.ListFormat.ListString }
  if ($r.Information(12)) { $row.table = $true }
  if (In-Spans $s $e $ctx.toc) { $row.toc = $true } else {
    $kinds = @(); foreach ($f in $ctx.fields) { if ($s -lt [int]$f[1] -and $e -gt [int]$f[0] -and $kinds -notcontains $f[2]) { $kinds += $f[2] } }
    if ($kinds.Count) { $row.fields = $kinds }
  }
  foreach ($c in $ctx.controls) { if ($s -lt [int]$c[1] -and $e -gt [int]$c[0]) { $row.control = [int]$c[2]; if ($c[3]) { $row.locked = $true }; break } }
  return $row
}
function Inspect-Ctx($d) {
  $secs = @{}
  $n = [int]$d.Sections.Count
  for ($k = 1; $k -lt $n; $k++) { $secs[[int]$d.Sections.Item($k).Range.End] = [string]$SECTION_START[[int]$d.Sections.Item($k + 1).PageSetup.SectionStart] }
  $fields = New-Object System.Collections.ArrayList
  # (each bound in its own parentheses: in @(a - 1, b) the comma binds first)
  foreach ($f in $d.Fields) { try { [void]$fields.Add(@(([int]$f.Code.Start - 1), ([int]$f.Result.End + 1), (Field-Kind $f))) } catch { } }
  $controls = New-Object System.Collections.ArrayList
  $k = 0; foreach ($c in $d.ContentControls) { $k++; try { [void]$controls.Add(@(([int]$c.Range.Start - 1), ([int]$c.Range.End + 1), $k, [bool]$c.LockContents)) } catch { } }
  return @{ secs = $secs; toc = (Toc-Spans $d); fields = $fields.ToArray(); controls = $controls.ToArray() }
}
function Page-Setups($d) {
  $out = New-Object System.Collections.ArrayList
  foreach ($s in $d.Sections) {
    $ps = $s.PageSetup
    [void]$out.Add(@{ o = [int]$ps.Orientation; w = [double]$ps.PageWidth; h = [double]$ps.PageHeight; t = [double]$ps.TopMargin; b = [double]$ps.BottomMargin; l = [double]$ps.LeftMargin; r = [double]$ps.RightMargin; hd = [double]$ps.HeaderDistance; fd = [double]$ps.FooterDistance; first = [int]$ps.DifferentFirstPageHeaderFooter; start = [int]$ps.SectionStart; cols = [int]$ps.TextColumns.Count })
  }
  return , $out.ToArray()
}
function Cmd-Inspect($req) {
  $d = Find-Doc $req
  $n = [int]$d.Paragraphs.Count
  $cap = 40
  $a = 1; $b = [Math]::Min($n, $cap)
  $scope = Scope-Of $d $req
  if ($scope) { $a = [int]$scope.a; $b = [int]$scope.b }
  $want = $null
  $res = @{ doc = [string]$d.Name; total = $n }
  if ($req.ContainsKey('find')) {
    $want = @{}
    foreach ($h in (Find-All $d ([string]$req['find']) 200 $false $scope (Skip-Of $d $req))) { $want[(Para-No $d ([int]$h.Start))] = $true }
    $res.matched = $want.Count; $res.skipped = $script:skipped
    if ($want.Count -eq 0) { $res.rows = @(); return $res }
    $ks = @($want.Keys | Sort-Object); $a = [int]$ks[0]; $b = [int]$ks[$ks.Count - 1]
  } elseif ($scope) { $cap = 60 }
  $ctx = Inspect-Ctx $d
  $rows = New-Object System.Collections.ArrayList
  $next = $null
  $p = $d.Paragraphs.Item($a); $i = $a
  while ($null -ne $p -and $i -le $b) {
    if ($null -eq $want -or $want.ContainsKey($i)) {
      if ($rows.Count -ge $cap) { $next = $i; break }
      [void]$rows.Add((Para-Row $d $p $i $ctx))
    }
    $p = $p.Next(1); $i++
  }
  if ($null -eq $next -and $null -eq $want -and -not $scope -and $b -lt $n) { $next = $b + 1 }
  $res.rows = $rows.ToArray(); $res.next = $next; $res.from = $a
  if ($scope) { $res.scope = @{ a = $scope.a; b = $scope.b; name = $scope.name } }
  $normal = $d.Styles.Item(-1)
  $res.body = Font-Of $normal.Font
  $res.body.before = [double]$normal.ParagraphFormat.SpaceBefore; $res.body.after = [double]$normal.ParagraphFormat.SpaceAfter; $res.body.line = Line-Of $normal.ParagraphFormat
  $res.sections = Page-Setups $d
  $res.tocs = [int]$d.TablesOfContents.Count
  return $res
}

# ---- delete: paragraphs (a range, a section, the empty headings or empty paragraphs), after the user saw them; or the breaks in a range
function Cmd-DeleteParas($req) {
  $d = Find-Doc $req
  if ($req.ContainsKey('breaks')) { return (Cmd-Unbreak $d $req) }
  $n = [int]$d.Paragraphs.Count
  $scope = Scope-Of $d $req
  $a = 1; $b = $n; if ($scope) { $a = [int]$scope.a; $b = [int]$scope.b }
  $heads = [bool](Arg $req 'emptyHeadings' $false); $empty = [bool](Arg $req 'empty' $false)
  $toc = Toc-Spans $d
  $pick = New-Object System.Collections.ArrayList
  $p = $d.Paragraphs.Item($a); $i = $a
  while ($null -ne $p -and $i -le $b) {
    $r = $p.Range
    $t = Para-Text $p
    $take = $true
    if ($heads -or $empty) {
      $take = ($t -eq '' -and -not $r.Information(12) -and -not ([string]$r.Text).Contains($FF) -and -not (In-Spans ([int]$r.Start) ([int]$r.End) $toc))
      if ($take) { try { $take = ([int]$r.InlineShapes.Count -eq 0 -and [int]$r.ShapeRange.Count -eq 0) } catch { } }
      if ($take -and $heads) { $take = ((Para-Level $p) -le 9) }
    }
    if ($take) { [void]$pick.Add(@{ i = $i; s = [int]$r.Start; e = [int]$r.End; t = $t; lv = (Para-Level $p) }) }
    $p = $p.Next(1); $i++
  }
  if ($pick.Count -eq 0) { return @{ doc = [string]$d.Name; count = 0 } }
  if ($pick.Count -ge $n) { throw 'That is every paragraph of the document, so nothing was deleted. A document keeps at least one paragraph here.' }
  if (-not $heads -and -not $empty) {
    # a table is deleted whole or not at all: a range that starts or ends inside one would leave it broken
    $s0 = [int]$pick[0].s; $e0 = [int]$pick[$pick.Count - 1].e
    foreach ($tb in $d.Tables) { $ts = [int]$tb.Range.Start; $te = [int]$tb.Range.End; if ($ts -lt $e0 -and $te -gt $s0 -and ($ts -lt $s0 -or $te -gt $e0)) { throw 'Those paragraphs start or end inside a table, so nothing was deleted. Pick the whole table with it, or change the table with table (delete_rows).' } }
  }
  $lines = @()
  foreach ($x in $pick) {
    if ($lines.Count -ge 30) { $lines += ('... and ' + ($pick.Count - 30) + ' more'); break }
    $mark = ''; if ([int]$x.lv -le 9) { $mark = ('#' * [Math]::Min([int]$x.lv, 6)) + ' ' }
    $txt = Clip ([string]$x.t) 100; if ($txt -eq '') { $txt = '(empty)' }
    $lines += ('[' + $x.i + '] ' + $mark + $txt)
  }
  if ($req.ContainsKey('preview')) { return @{ doc = [string]$d.Name; preview = @{ lines = $lines; count = $pick.Count } } }
  # neighbouring paragraphs go together, from the last run to the first (the earlier offsets stay right)
  $runs = New-Object System.Collections.ArrayList
  foreach ($x in $pick) { if ($runs.Count -and [int]$runs[$runs.Count - 1].i -eq [int]$x.i - 1) { $runs[$runs.Count - 1].e = [int]$x.e; $runs[$runs.Count - 1].i = [int]$x.i } else { [void]$runs.Add(@{ s = [int]$x.s; e = [int]$x.e; i = [int]$x.i }) } }
  for ($k = $runs.Count - 1; $k -ge 0; $k--) {
    $s = [int]$runs[$k].s; $e = [int]$runs[$k].e
    # the document's last paragraph mark cannot go: the mark before the run goes instead (unless that ends a table), so no empty line is left
    if ($e -ge [int]$d.Content.End -and $s -gt 0 -and -not $d.Range($s - 1, $s).Information(12)) { $s-- }
    $gone = $d.Range($s, $e)
    $cc = Unlock-Around $gone
    try { $gone.Delete() | Out-Null } catch { throw ('Word did not delete paragraph ' + $runs[$k].i + ' (' + $_.Exception.Message + '). If it is in a locked content control, unlock it with fields (control, unlock true).') } finally { Relock $cc }
  }
  $script:last[(Doc-Key $d)] = @([int]$pick[0].s, [int]$pick[0].s + 1)
  return @{ doc = [string]$d.Name; deleted = $pick.Count; paragraphs = [int]$d.Paragraphs.Count; tracking = [bool]$d.TrackRevisions }
}
# Word's own codes for the breaks (wildcards off): ^m a manual page break (it finds section breaks too: those are told apart by where their
# section ends), ^n a column break, ^b a section break.
function Find-Code($d, [string]$code, [int]$s, [int]$e) {
  $res = New-Object System.Collections.ArrayList
  $pos = $s; $guard = 0
  while ($res.Count -lt 500 -and $pos -lt $e -and $guard -lt 5000) {
    $guard++
    $r = $d.Range($pos, $e)
    $f = $r.Find; $f.ClearFormatting(); $f.Text = $code; $f.Forward = $true; $f.Wrap = 0; $f.MatchWildcards = $false
    if (-not $f.Execute()) { break }
    $rs = [int]$r.Start; $re = [int]$r.End
    if ($re -gt $e) { break }
    if ($rs -lt $pos) { $pos++; continue }
    [void]$res.Add($d.Range($rs, $re))
    $pos = [Math]::Max($re, $pos + 1)
  }
  return , $res
}
function Cmd-Unbreak($d, $req) {
  $scope = Scope-Of $d $req
  $kind = [string]$req['breaks']
  $s = 0; $e = [int]$d.Content.End; if ($scope) { $s = [int]$scope.s; $e = [int]$scope.e }
  $ends = @{}; foreach ($sec in $d.Sections) { $ends[[int]$sec.Range.End] = $true }
  $done = @{ page = 0; section = 0; column = 0; before = 0 }
  $codes = @(); if ($kind -eq 'page' -or $kind -eq 'all') { $codes += , @('page', '^m') }; if ($kind -eq 'column' -or $kind -eq 'all') { $codes += , @('column', '^n') }; if ($kind -eq 'section' -or $kind -eq 'all') { $codes += , @('section', '^b') }
  foreach ($c in $codes) {
    $hits = Find-Code $d $c[1] $s $e
    for ($k = $hits.Count - 1; $k -ge 0; $k--) {
      $h = $hits[$k]
      if ($c[0] -eq 'page' -and $ends.ContainsKey([int]$h.End)) { continue }   # (a section break)
      # a page or column break on a line of its own (Word puts one there) goes with its empty line
      $gone = $h
      if ($c[0] -ne 'section') { $pr = $h.Paragraphs.Item(1).Range; $raw = [string]$pr.Text; if ($raw.Length -eq 2 -and $raw.EndsWith($CR) -and [int]$pr.End -lt [int]$d.Content.End) { $gone = $pr } }
      $len = [int]$gone.End - [int]$gone.Start
      $gone.Delete() | Out-Null
      $done[$c[0]]++
      if (-not $d.TrackRevisions) { $e -= $len }
    }
  }
  if ($kind -eq 'page' -or $kind -eq 'all') { foreach ($p in $d.Range($s, [Math]::Max($s, $e)).Paragraphs) { if ([int]$p.Format.PageBreakBefore -ne 0) { $p.Format.PageBreakBefore = 0; $done.before++ } } }
  $script:last[(Doc-Key $d)] = @($s, $s + 1)
  return @{ doc = [string]$d.Name; unbroken = $done; tracking = [bool]$d.TrackRevisions }
}

# ---- toc: a real table of contents (Word's own TablesOfContents): a new one, its update, or the one there made again in its place
function Toc-Title($d, $r) {
  foreach ($name in @('TOC Heading')) { try { $r.Style = $d.Styles.Item($name); return } catch { } }
  $r.Font.Bold = 1; $r.Font.Size = 14
}
function Cmd-Toc($req) {
  $d = Find-Doc $req
  $have = [int]$d.TablesOfContents.Count
  $up = [int](Arg $req 'upper' 1); $lo = [int](Arg $req 'lower' 3)
  if ($req.ContainsKey('update')) {
    if ($have -eq 0) { throw 'This document has no table of contents. toc without update adds one.' }
    foreach ($c in $d.TablesOfContents) { $cc = Unlock-Around $c.Range; try { $c.Update() } finally { Relock $cc } }
    $t1 = $d.TablesOfContents.Item(1).Range
    $script:last[(Doc-Key $d)] = @([int]$t1.Start, [int]$t1.Start + 1)
    return @{ doc = [string]$d.Name; updated = $have; entries = [int]$t1.Paragraphs.Count }
  }
  if ($req.ContainsKey('rebuild')) {
    if ($have -eq 0) { throw 'This document has no table of contents to rebuild. toc without rebuild adds one.' }
    # the one there is kept (its place, its title, a contents block around it) and made again from the headings: its levels set, built from the
    # heading styles with links and right-aligned page numbers, then Word fills it in anew (lines typed into it go). It is never deleted first.
    $toc = $d.TablesOfContents.Item(1)
    $start = [int]$toc.Range.Start
    if (-not $req.ContainsKey('upper')) {
      # its own levels: Word's properties, or the \o "1-3" in its field code when those read empty
      $u2 = 0; $l2 = 0; try { $u2 = [int]$toc.UpperHeadingLevel; $l2 = [int]$toc.LowerHeadingLevel } catch { }
      if ($u2 -lt 1 -or $u2 -gt 9 -or $l2 -lt $u2 -or $l2 -gt 9) { foreach ($x in $d.Fields) { if ([int]$x.Type -eq 13 -and ([string]$x.Code.Text) -match '\\o\s+"(\d)-(\d)"') { $u2 = [int]$Matches[1]; $l2 = [int]$Matches[2]; break } } }
      if ($u2 -ge 1 -and $u2 -le 9 -and $l2 -ge $u2 -and $l2 -le 9) { $up = $u2; $lo = $l2 }
    }
    $cc = Unlock-Around $toc.Range
    try {
      $toc.UseHeadingStyles = $true
      if ([int]$toc.LowerHeadingLevel -ne $lo -or [int]$toc.UpperHeadingLevel -ne $up) { $toc.UpperHeadingLevel = 1; $toc.LowerHeadingLevel = $lo; $toc.UpperHeadingLevel = $up }   # (1 first: the upper level may never pass the lower)
      try { $toc.UseHyperlinks = $true; $toc.RightAlignPageNumbers = $true; $toc.IncludePageNumbers = $true } catch { }
      $toc.Update()
    } finally { Relock $cc }
    $script:last[(Doc-Key $d)] = @($start, $start + 1)
    return @{ doc = [string]$d.Name; rebuilt = $true; upper = $up; lower = $lo; entries = [int]$toc.Range.Paragraphs.Count }
  }
  if ($have -gt 0) { throw 'This document already has a table of contents. Use toc with update true (its entries and page numbers) or rebuild true (made again in its place, keeping its title).' }
  $at = 0
  if ($req.ContainsKey('para') -and [int]$req['para'] -gt 0) {
    if ([int]$req['para'] -gt [int]$d.Paragraphs.Count) { throw ('The document has ' + [int]$d.Paragraphs.Count + ' paragraphs, so there is no paragraph ' + [int]$req['para'] + '. Nothing was changed.') }
    $p = $d.Paragraphs.Item([int]$req['para']); $p.Range.InsertParagraphAfter(); $at = [int]$p.Next(1).Range.Start
  } elseif ($req.ContainsKey('heading')) {
    $k = Find-Para $d ([string]$req['heading'])
    if ($k -eq 0) { throw ('No paragraph matches "' + [string]$req['heading'] + '", so nothing was changed. Use read to see the text.') }
    $p = $d.Paragraphs.Item($k); $p.Range.InsertParagraphAfter(); $at = [int]$p.Next(1).Range.Start
  } else { $d.Range(0, 0).InsertParagraphBefore() }
  $title = [string](Arg $req 'title' '')
  if ($title) {
    $d.Range($at, $at).InsertBefore($title + $CR)
    $tr = $d.Range($at, $at + $title.Length)
    Set-Style $d $tr 'Normal'
    Toc-Title $d $tr.Paragraphs.Item(1).Range
    $at = $at + $title.Length + 1
  }
  $toc = $d.TablesOfContents.Add($d.Range($at, $at), $true, $up, $lo)
  $toc.Update()
  $script:last[(Doc-Key $d)] = @($at, $at + 1)
  return @{ doc = [string]$d.Name; added = $true; upper = $up; lower = $lo; title = $title; entries = [int]$toc.Range.Paragraphs.Count }
}

# ---- fields and content controls: list them, update every field, a field made plain text, a content control's text or lock
function Field-Kind($f) { $c = ''; try { $c = ([string]$f.Code.Text).Trim() } catch { }; $k = ($c -split '\s+')[0]; if (-not $k) { $k = 'FIELD' }; return $k.ToUpperInvariant() }
function Cmd-Fields($req) {
  $d = Find-Doc $req
  if ($req.ContainsKey('update')) {
    $count = [int]$d.Fields.Count
    $bad = [int]$d.Fields.Update()
    foreach ($t in $d.TablesOfContents) { $cc = Unlock-Around $t.Range; try { $t.Update() } finally { Relock $cc } }
    foreach ($t in $d.TablesOfFigures) { try { $t.Update() } catch { } }
    $more = 0
    foreach ($s in $d.Sections) { foreach ($hf in @($s.Headers.Item(1), $s.Headers.Item(2), $s.Footers.Item(1), $s.Footers.Item(2))) { try { if ($hf.Exists) { $more += [int]$hf.Range.Fields.Count; [void]$hf.Range.Fields.Update() } } catch { } } }
    return @{ doc = [string]$d.Name; updated = $count; headers = $more; tocs = [int]$d.TablesOfContents.Count; failed = ($bad -ne 0) }
  }
  if ($req.ContainsKey('unlink')) {
    $u = $req['unlink']
    $f = $null
    if ([string]$u -eq 'toc') {
      if ([int]$d.TablesOfContents.Count -eq 0) { throw 'This document has no table of contents.' }
      $ts = [int]$d.TablesOfContents.Item(1).Range.Start
      foreach ($x in $d.Fields) { if ([int]$x.Type -eq 13 -and [int]$x.Result.Start -eq $ts) { $f = $x; break } }
      if ($null -eq $f) { foreach ($x in $d.Fields) { if ([int]$x.Type -eq 13) { $f = $x; break } } }
      if ($null -eq $f) { throw 'Word did not give the table of contents as a field, so it was not changed.' }
    } else {
      if ([int]$u -gt [int]$d.Fields.Count) { throw ('The document has ' + [int]$d.Fields.Count + ' field(s), so there is no field ' + [int]$u + '. fields lists them.') }
      $f = $d.Fields.Item([int]$u)
    }
    $kind = Field-Kind $f
    $rs = [int]$f.Result.Start
    $cc = Unlock-Around $f.Result
    try { $f.Unlink() } finally { Relock $cc }
    $script:last[(Doc-Key $d)] = @($rs, $rs + 1)
    return @{ doc = [string]$d.Name; unlinked = $kind; para = (Para-No $d $rs) }
  }
  if ($req.ContainsKey('control')) {
    $k = [int]$req['control']
    if ($k -gt [int]$d.ContentControls.Count) { throw ('The document has ' + [int]$d.ContentControls.Count + ' content control(s), so there is no control ' + $k + '. fields lists them.') }
    $c = $d.ContentControls.Item($k)
    $out = @{ doc = [string]$d.Name; control = @{ i = $k; title = [string]$c.Title; type = [string]$CC_TYPE[[int]$c.Type] } }
    if ([bool](Arg $req 'unlock' $false)) { $c.LockContents = $false; $c.LockContentControl = $false; $out.unlocked = $true }
    if ($req.ContainsKey('text')) {
      $was = [bool]$c.LockContents
      $c.LockContents = $false
      try { $c.Range.Text = (Rep-Text ([string]$req['text'])) } catch { throw ('Word did not set that content control''s text (a ' + $out.control.type + ' control): ' + $_.Exception.Message) } finally { if ($was) { $c.LockContents = $true } }
      $out.text = $true
    }
    $script:last[(Doc-Key $d)] = @([int]$c.Range.Start, [int]$c.Range.End)
    return $out
  }
  $toc = Toc-Spans $d
  $list = New-Object System.Collections.ArrayList
  $k = 0; $inToc = 0; $more = 0
  foreach ($f in $d.Fields) {
    $k++
    $kind = Field-Kind $f
    $rs = 0; try { $rs = [int]$f.Result.Start } catch { }
    if ($kind -ne 'TOC' -and (In-Spans $rs ($rs + 1) $toc)) { $inToc++; continue }
    if ($list.Count -ge 60) { $more++; continue }
    $res = ''; try { $res = Clip ([string]$f.Result.Text) 80 } catch { }
    [void]$list.Add(@{ i = $k; kind = $kind; code = (Clip ([string]$f.Code.Text) 80); result = $res; para = (Para-No $d $rs) })
  }
  $ctl = New-Object System.Collections.ArrayList
  $j = 0
  foreach ($c in $d.ContentControls) {
    $j++
    if ($ctl.Count -ge 40) { break }
    [void]$ctl.Add(@{ i = $j; title = [string]$c.Title; tag = [string]$c.Tag; type = [string]$CC_TYPE[[int]$c.Type]; locked = [bool]$c.LockContents; fixed = [bool]$c.LockContentControl; text = (Clip ([string]$c.Range.Text) 80); para = (Para-No $d ([int]$c.Range.Start)) })
  }
  return @{ doc = [string]$d.Name; fields = $list.ToArray(); fieldCount = $k; inToc = $inToc; more = $more; controls = $ctl.ToArray(); controlCount = [int]$d.ContentControls.Count; tocs = [int]$d.TablesOfContents.Count }
}

# ---- checkpoints: the whole document (its text, styles, headers, comments: Word's own WordOpenXML) in a file Lumen names in its temp folder, and
# put back with InsertXML; each section's page setup is kept beside it and set again (InsertXML keeps the document's own for the sections).
function Cmd-Checkpoint($req) {
  $d = Find-Doc $req
  $file = [string]$req['file']
  if (-not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($file))) { throw 'The checkpoint folder is not there.' }
  $xml = [string]$d.WordOpenXML
  [IO.File]::WriteAllText($file, $xml, (New-Object System.Text.UTF8Encoding($false)))
  return @{ doc = [string]$d.Name; paragraphs = [int]$d.Paragraphs.Count; sections = (Page-Setups $d); size = $xml.Length }
}
function Set-PageSetup($ps, $v) {
  try { if ([int]$ps.Orientation -ne [int]$v['o']) { $ps.Orientation = [int]$v['o'] } } catch { }
  foreach ($pair in @(@('PageWidth', 'w'), @('PageHeight', 'h'), @('TopMargin', 't'), @('BottomMargin', 'b'), @('LeftMargin', 'l'), @('RightMargin', 'r'), @('HeaderDistance', 'hd'), @('FooterDistance', 'fd'))) {
    try { if ([double]$ps.($pair[0]) -ne [double]$v[$pair[1]]) { $ps.($pair[0]) = [double]$v[$pair[1]] } } catch { }
  }
  try { $ps.DifferentFirstPageHeaderFooter = [int]$v['first'] } catch { }
  try { $ps.SectionStart = [int]$v['start'] } catch { }
  try { if ([int]$ps.TextColumns.Count -ne [int]$v['cols']) { $ps.TextColumns.SetCount([int]$v['cols']) } } catch { }
}
function Cmd-Restore($req) {
  $d = Find-Doc $req
  $file = [string]$req['file']
  if (-not [IO.File]::Exists($file)) { throw 'That checkpoint is gone (Lumen keeps them only while it runs), so nothing was changed.' }
  $xml = [IO.File]::ReadAllText($file)
  $track = [bool]$d.TrackRevisions
  $d.TrackRevisions = $false
  try {
    foreach ($c in $d.ContentControls) { try { $c.LockContentControl = $false; $c.LockContents = $false } catch { } }
    $d.Content.Delete() | Out-Null
    $d.Content.InsertXML($xml)
    $setups = @(Arg $req 'sections' @())
    if ($setups.Count -eq [int]$d.Sections.Count) { $k = 0; foreach ($s in $d.Sections) { Set-PageSetup $s.PageSetup $setups[$k]; $k++ } }
  } finally { $d.TrackRevisions = $track }
  $script:last[(Doc-Key $d)] = @(0, 1)
  return @{ doc = [string]$d.Name; paragraphs = [int]$d.Paragraphs.Count; sections = [int]$d.Sections.Count }
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
  $f = [LumenWordShot]::Frame((Word-Hwnd $a $null), [int]$req['w'], [int64]$req['q'], [bool]$req['reset'])
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
    'inspect' { return Cmd-Inspect $req }
    'delete' { return Cmd-DeleteParas $req }
    'toc' { return Cmd-Toc $req }
    'fields' { return Cmd-Fields $req }
    'checkpoint' { return Cmd-Checkpoint $req }
    'restore' { return Cmd-Restore $req }
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
