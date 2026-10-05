// The Apple Music widget's "Status" mode: what the Apple Music app on this computer is playing, with play, pause,
// next and previous, as a now-playing card like the Spotify widget's. Apple's Music API (MusicKit) has no "what is
// playing on my devices" or remote-control call and needs a paid developer token, so this reads the operating
// system's own now-playing interface instead:
//   Windows: System Media Transport Controls (the same list the volume flyout shows), through a small PowerShell
//            helper (features/apple-music-native.js runs it).
//   macOS:   the Music app's own scripting interface, through osascript.
// This file is the pure part (no Electron, no processes): which media session is Apple's, what the helper and
// osascript print, and what the card is given. The scripts are constants: nothing from a page, a track title or the
// user is ever put into them.
'use strict';

const SV = require('./spotify-view');

const WEB_URL = 'https://music.apple.com/';
const MODES = ['status', 'web'];
const ACTIONS = ['play', 'pause', 'next', 'previous'];
const MAX_TEXT = 200;

// The widget's mode: 'status' (the now-playing card, the default) or 'web' (music.apple.com in the card). `app`: also show the
// desktop Apple Music app when the card's own player is idle.
function cleanMode(c) {
  return c && typeof c === 'object' && MODES.includes(c.mode) ? c.mode : 'status';
}
function cleanConfig(c) {
  const ok = c && typeof c === 'object';
  return { mode: cleanMode(c), art: !ok || c.art !== false, app: !ok || c.app !== false };
}

// ---- which Windows media session is Apple Music ----
// A session's id is the app's AppUserModelId: AppleInc.AppleMusicWin_<hash>!App (the Store app), AppleInc.iTunes_<hash>!iTunes
// (the Store iTunes), or iTunes.exe / AppleMusic.exe (an installed desktop app). Apple TV (AppleInc.AppleTVWin) is not music.
const AUMID_SOURCE = '^(AppleInc\\.(AppleMusic\\w*|iTunes)_|iTunes\\.exe$|AppleMusic\\.exe$)';
const AUMID_RE = new RegExp(AUMID_SOURCE, 'i');
const isAppleAumid = (id) => typeof id === 'string' && id.length < 300 && AUMID_RE.test(id);
const appName = (id) => (/itunes/i.test(String(id)) && !/applemusic/i.test(String(id)) ? 'iTunes' : 'Apple Music');
// The shell address of an app's start entry (what explorer.exe launches): PackageFamilyName!AppId.
const LAUNCH_ID_RE = /^[A-Za-z0-9.-]{3,80}_[a-z0-9]{13}![A-Za-z0-9.]{1,40}$/;

const clip = (v, max = MAX_TEXT) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const ms = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 48 * 3600e3) : 0);

// Which of several sessions the card shows: the one playing, else Apple Music before iTunes, else the first. Only
// Apple's own sessions unless `any` (tests only: a stand-in media app).
function pickSession(sessions, { any = false } = {}) {
  const list = (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s === 'object' && (any || isAppleAumid(s.id)));
  if (!list.length) return null;
  const rank = (s) => (s.status === 'playing' ? 0 : 2) + (appName(s.id) === 'Apple Music' ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b))[0];
}

// What the card is given (the page redraws from this; `art` is a data: URL or '').
function idle(now, extra = {}) {
  return { mode: 'status', state: 'idle', title: '', artist: '', album: '', progressMs: 0, durationMs: 0, at: now, source: '', kind: 'none', reason: '', art: '', ...extra };
}
// Apple Music can't be reached: reason is 'not-installed' | 'denied' | 'unsupported' | 'error'.
function unavailable(reason, now) { return idle(now, { state: 'unavailable', reason }); }

// One session as the helper reports it ({ id, status, title, artist, album, posMs, endMs }) -> the card.
function fromSession(s, now, art = '') {
  const title = clip(s.title);
  const status = s.status === 'playing' ? 'playing' : s.status === 'paused' ? 'paused' : null;
  if (!status && !title) return idle(now, { source: appName(s.id), reason: 'no-track' });
  const durationMs = ms(s.endMs);
  const progress = ms(s.posMs);
  return {
    mode: 'status',
    state: status || 'paused', // stopped with a track still loaded: shown paused
    title: title || 'Untitled',
    artist: clip(s.artist, 120),
    album: clip(s.album, 120),
    progressMs: durationMs ? Math.min(progress, durationMs) : progress,
    durationMs,
    at: now,
    source: appName(s.id),
    kind: 'track',
    reason: '',
    art: typeof art === 'string' ? art : '',
  };
}

// The helper's whole picture on Windows: { sessions, installed, launchId } -> the card.
function fromWindows(msg, now, { any = false, art = '' } = {}) {
  const m = msg && typeof msg === 'object' ? msg : {};
  const s = pickSession(m.sessions, { any });
  if (!s) return m.installed === false && !any ? unavailable('not-installed', now) : idle(now, { reason: 'not-running' });
  return fromSession(s, now, art);
}

// ---- the Windows helper's output ----
// One line of the helper's stdout -> an object of ours, or null. Only the shapes we know, every string bounded.
function parseHelperLine(line) {
  let m;
  try { m = JSON.parse(String(line)); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.t === 'hello') return { t: 'hello', installed: m.installed === true, launchId: typeof m.launchId === 'string' && LAUNCH_ID_RE.test(m.launchId) ? m.launchId : '' };
  if (m.t === 'ack') return { t: 'ack', cmd: ACTIONS.includes(m.cmd) ? m.cmd : '', ok: m.ok === true };
  if (m.t === 'sessions' && Array.isArray(m.list)) {
    const list = m.list.slice(0, 12).filter((s) => s && typeof s.id === 'string' && s.id.length < 300).map((s) => ({
      id: s.id,
      status: ['playing', 'paused', 'stopped'].includes(s.status) ? s.status : 'other',
      title: clip(s.title), artist: clip(s.artist, 120), album: clip(s.album, 120),
      posMs: ms(s.posMs), endMs: ms(s.endMs),
      thumb: typeof s.thumb === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(s.thumb) && s.thumb.length < 3e6 ? s.thumb : '',
    }));
    return { t: 'sessions', list };
  }
  return null;
}

// A card state with the moving parts left out (the playhead): when this changes the page is told, not for every second.
function signature(d) {
  return JSON.stringify([d.state, d.reason, d.title, d.artist, d.album, d.durationMs, d.source, d.art ? d.art.length : 0, d.progressMs > 0 && d.state === 'paused' ? Math.round(d.progressMs / 3000) : 0]);
}

// ---- macOS: the Music app through osascript ----
// Reads without launching Music (running() doesn't); prints one JSON line. The first call that talks to Music makes macOS ask
// the user for Automation permission; a refusal comes back as error -1743 ("Not authorized to send Apple events").
const MAC_READ = `(() => {
  const app = Application('Music');
  if (!app.running()) return JSON.stringify({ running: false });
  const out = { running: true, state: String(app.playerState()), position: 0, track: null };
  try { out.position = Number(app.playerPosition()) || 0; } catch (e) {}
  try {
    const t = app.currentTrack;
    out.track = { name: String(t.name()), artist: String(t.artist()), album: String(t.album()), duration: Number(t.duration()) || 0 };
  } catch (e) {}
  return JSON.stringify(out);
})()`;
// One script per button, chosen by name from this table (never built from input). Each does nothing when Music isn't running.
const macControl = (call) => `(() => { const app = Application('Music'); if (!app.running()) return 'not-running'; app.${call}(); return 'ok'; })()`;
const MAC_CONTROL = { play: macControl('play'), pause: macControl('pause'), next: macControl('nextTrack'), previous: macControl('previousTrack') };
// The current track's artwork written to the file given as the script's only argument (a path of ours in the temp folder).
const MAC_ARTWORK = [
  'on run argv',
  'set p to item 1 of argv',
  'tell application "Music"',
  'if not running then return "none"',
  'if not (exists current track) then return "none"',
  'if (count of artworks of current track) is 0 then return "none"',
  'set d to raw data of artwork 1 of current track',
  'end tell',
  'set f to open for access POSIX file p with write permission',
  'try',
  'set eof f to 0',
  'write d to f',
  'close access f',
  'on error',
  'try',
  'close access f',
  'end try',
  'return "error"',
  'end try',
  'return "ok"',
  'end run',
];

// osascript's stderr -> whether the user refused (or hasn't yet allowed) Lumen to control Music.
const isDenied = (stderr) => /-1743|not authori[sz]ed|not allowed/i.test(String(stderr || ''));

// osascript's stdout for MAC_READ -> the card. `denied` and `failed` come from the process (see isDenied).
function fromMac(stdout, now, { art = '', denied = false, failed = false } = {}) {
  if (denied) return unavailable('denied', now);
  let m;
  try { m = JSON.parse(String(stdout).trim()); } catch { m = null; }
  if (!m || typeof m !== 'object') return failed ? unavailable('error', now) : idle(now, { reason: 'not-running' });
  if (m.running !== true) return idle(now, { reason: 'not-running' });
  const t = m.track && typeof m.track === 'object' ? m.track : null;
  const status = m.state === 'playing' ? 'playing' : m.state === 'paused' ? 'paused' : null;
  if (!t || !clip(t.name) || !status) return idle(now, { source: 'Music', reason: 'no-track' });
  const durationMs = ms(t.duration * 1000);
  const progress = ms(Number(m.position) * 1000);
  return {
    mode: 'status', state: status, title: clip(t.name), artist: clip(t.artist, 120), album: clip(t.album, 120),
    progressMs: durationMs ? Math.min(progress, durationMs) : progress, durationMs, at: now, source: 'Music', kind: 'track', reason: '', art: typeof art === 'string' ? art : '',
  };
}
// What identifies the track whose artwork is cached.
const trackKey = (d) => `${d.source}|${d.title}|${d.artist}|${d.album}`;

// ---- the Windows helper ----
// A long-lived PowerShell process: prints a JSON line when the media sessions change (about once a second it looks), reads one
// JSON command per line ({"cmd":"play","id":"<a session id it reported>"}). Run with -EncodedCommand; stdin closing ends it.
// LUMEN_AM_ANY=1 (tests only) reports every session instead of only Apple's.
const WINDOWS_HELPER = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
  '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  '$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]',
  '$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]',
  `$re = '${AUMID_SOURCE.replace(/\\/g, '\\')}'`,
  "$any = ($env:LUMEN_AM_ANY -eq '1')",
  "$opName = 'IAsyncOperation' + [char]96 + '1'",
  '$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $opName } | Select-Object -First 1',
  '$asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object { $_.Name -eq "AsStreamForRead" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IInputStream" } | Select-Object -First 1',
  'function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); if ($t.Wait(6000)) { return $t.Result } else { return $null } }',
  'function Emit($o) { [Console]::Out.WriteLine((ConvertTo-Json -InputObject $o -Compress -Depth 6)) }',
  '$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]',
  '$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]',
  '$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]',
  '$mgr = Await ($mgrType::RequestAsync()) $mgrType',
  '$sent = @{}',
  'function Thumb($props) {',
  '  try {',
  '    if (-not $props.Thumbnail) { return "" }',
  '    $rs = Await ($props.Thumbnail.OpenReadAsync()) $streamType',
  '    if (-not $rs -or $rs.Size -gt 2000000) { return "" }',
  '    $st = $asStream.Invoke($null, @($rs))',
  '    $ms = New-Object System.IO.MemoryStream',
  '    $st.CopyTo($ms)',
  '    return [Convert]::ToBase64String($ms.ToArray())',
  '  } catch { return "" }',
  '}',
  'function Status($s) { switch ([int]$s.GetPlaybackInfo().PlaybackStatus) { 4 { "playing" } 5 { "paused" } 3 { "stopped" } default { "other" } } }',
  'function Snapshot() {',
  '  $list = @()',
  '  foreach ($s in $mgr.GetSessions()) {',
  '    $id = [string]$s.SourceAppUserModelId',
  '    if (-not $any -and $id -notmatch $re) { continue }',
  '    $props = Await ($s.TryGetMediaPropertiesAsync()) $propsType',
  '    if (-not $props) { continue }',
  '    $tl = $s.GetTimelineProperties()',
  '    $st = Status $s',
  '    $pos = $tl.Position.TotalMilliseconds',
  '    if ($st -eq "playing") { $pos += ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalMilliseconds }',
  '    $end = ($tl.EndTime - $tl.StartTime).TotalMilliseconds',
  '    if ($end -gt 0 -and $pos -gt $end) { $pos = $end }',
  '    if ($pos -lt 0) { $pos = 0 }',
  '    $key = $id + "|" + $props.Title + "|" + $props.Artist + "|" + $props.AlbumTitle',
  '    $thumb = ""',
  '    if ($sent[$id] -ne $key) { $thumb = Thumb $props; $sent[$id] = $key }',
  '    $list += [ordered]@{ id = $id; status = $st; title = [string]$props.Title; artist = [string]$props.Artist; album = [string]$props.AlbumTitle; posMs = [math]::Round($pos); endMs = [math]::Round($end); thumb = $thumb }',
  '  }',
  '  return $list',
  '}',
  'function Find($id) { foreach ($s in $mgr.GetSessions()) { if ([string]$s.SourceAppUserModelId -eq $id) { return $s } } return $null }',
  '$last = ""',
  '$lastPos = @{}',
  'function Changed($list) {',
  '  $sig = ($list | ForEach-Object { $_.id + "|" + $_.status + "|" + $_.title + "|" + $_.artist + "|" + $_.album + "|" + $_.endMs }) -join "#"',
  '  $jump = $false',
  '  foreach ($i in $list) { $p = $lastPos[$i.id]; if ($p -ne $null -and [math]::Abs($i.posMs - $p) -gt 2500) { $jump = $true }; $lastPos[$i.id] = $i.posMs + $(if ($i.status -eq "playing") { 1000 } else { 0 }) }',
  '  if ($sig -ne $script:last -or $jump) { $script:last = $sig; return $true }',
  '  return $false',
  '}',
  '$stdin = [Console]::OpenStandardInput()',
  '$buf = New-Object byte[] 4096',
  '$read = $stdin.ReadAsync($buf, 0, 4096)',
  '$pending = ""',
  '$first = $true',
  '$tick = 0',
  'while ($true) {',
  '  $force = $false',
  '  if ($read.IsCompleted) {',
  '    $n = $read.Result',
  '    if ($n -le 0) { break }',
  '    $pending += [System.Text.Encoding]::UTF8.GetString($buf, 0, $n)',
  '    $read = $stdin.ReadAsync($buf, 0, 4096)',
  '    while ($pending.Contains("`n")) {',
  '      $i = $pending.IndexOf("`n"); $line = $pending.Substring(0, $i).Trim(); $pending = $pending.Substring($i + 1)',
  '      if (-not $line) { continue }',
  '      try {',
  '        $c = ConvertFrom-Json -InputObject $line',
  '        $ok = $false',
  '        $s = Find ([string]$c.id)',
  '        if ($s) {',
  '          switch ([string]$c.cmd) {',
  '            "play" { $ok = [bool](Await ($s.TryPlayAsync()) ([bool])) }',
  '            "pause" { $ok = [bool](Await ($s.TryPauseAsync()) ([bool])) }',
  '            "next" { $ok = [bool](Await ($s.TrySkipNextAsync()) ([bool])) }',
  '            "previous" { $ok = [bool](Await ($s.TrySkipPreviousAsync()) ([bool])) }',
  '          }',
  '        }',
  '        Emit @{ t = "ack"; cmd = [string]$c.cmd; ok = $ok }',
  '        $force = $true',
  '      } catch { }',
  '    }',
  '  }',
  '  if ($first -or $force -or $tick -ge 4) {',
  '    $tick = 0',
  '    $list = @(Snapshot)',
  '    if ($first -or (Changed $list)) { Emit @{ t = "sessions"; list = $list } }',
  '    if ($first) {',
  '      $first = $false',
  '      $pkg = Get-AppxPackage -Name "AppleInc.AppleMusicWin" -ErrorAction SilentlyContinue | Select-Object -First 1',
  '      $itn = Get-AppxPackage -Name "AppleInc.iTunes" -ErrorAction SilentlyContinue | Select-Object -First 1',
  '      $launch = $null',
  '      if ($pkg) { $launch = $pkg.PackageFamilyName + "!App" } elseif ($itn) { $launch = $itn.PackageFamilyName + "!iTunes" }',
  '      $desk = Test-Path "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\iTunes.exe"',
  '      Emit @{ t = "hello"; installed = [bool]($pkg -or $itn -or $desk); launchId = $launch }',
  '    }',
  '  }',
  '  $tick++',
  '  Start-Sleep -Milliseconds 250',
  '}',
].join('\n');
// powershell.exe -EncodedCommand wants the script as base64 of UTF-16LE.
const windowsHelperArgs = () => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_HELPER, 'utf16le').toString('base64')];

// A card's button -> the action name main may run, or null.
const actionOf = (name) => (ACTIONS.includes(name) ? name : null);
// The playhead now (the same as Spotify's card: it moves while playing, never past the end).
const progressNow = SV.progressNow;

module.exports = {
  WEB_URL, MODES, ACTIONS, AUMID_SOURCE, LAUNCH_ID_RE, MAC_READ, MAC_CONTROL, MAC_ARTWORK, WINDOWS_HELPER, MAX_ART_BYTES: SV.MAX_ART_BYTES,
  cleanMode, cleanConfig, isAppleAumid, appName, pickSession, idle, unavailable, fromSession, fromWindows, parseHelperLine, signature,
  isDenied, fromMac, trackKey, windowsHelperArgs, actionOf, progressNow, dataUrl: SV.dataUrl,
};
