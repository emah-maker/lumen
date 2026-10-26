// Pure unit test for Settings → Tabs and browsing > Page unloading (features/tab-sleep.js): the settings and their defaults, the migration of the
// old single choice, which tabs unload and in what order (idle time, Never, site lists, memory pressure levels, the cap, Performance
// mode), every exception, the status tally, and that every string the page uses is in locales/en.json.
const fs = require('fs');
const path = require('path');
const TS = require('../../src/features/tab-sleep');

let failed = 0;
const check = (label, ok, detail = '') => { if (!ok) { failed++; console.error(`FAIL ${label} ${detail}`); } else console.log(`ok   ${label}`); };
const MIN = 60e3;
const NOW = 10_000 * MIN;
const GB = 1024 ** 3;
const tab = (id, idleMin, extra = {}) => ({ id, lastActive: NOW - idleMin * MIN, host: `site${id}.com`, ...extra });
const ids = (r) => r.sleep.map((x) => x.id);
const why = (r) => r.sleep.map((x) => x.why).join();
// the "latest tabs stay" rule is off unless a test turns it on; pinned/audio rules use their defaults
const decide = (tabs, settings = {}, memory = null, limits = {}) => TS.decideSleep({ tabs, settings: { tabSleepKeepRecent: 0, ...settings }, now: NOW, memory, limits });
const okMem = { totalBytes: 16 * GB, freeBytes: 8 * GB, lumenBytes: 1 * GB };
const mem = (freePercent) => ({ totalBytes: 100 * GB, freeBytes: freePercent * GB, lumenBytes: 1 * GB });

// ---- defaults: what Lumen always did, plus the new switches
const d = TS.normalize({});
check('on by default', d.master === true && d.mode === 'both');
check('default time is 20 minutes', d.minutes === 20);
check('default memory level is Medium (under 10% free, 2 minutes idle)', d.pressure === 'medium' && d.freePercent === 10 && d.memoryIdleMs === 2 * MIN);
check('default: audio, pinned, forms and transfers are kept; groups are not', d.keepAudio && d.keepPinned && d.keepForms && d.keepTransfers && !d.keepGroups);
check('default: dim on, freed estimate on, reload immediately', d.dim === true && d.showFreed === true && d.onReturn === 'reload');
check('default: no site lists, soon-timer 5 minutes, no cap', d.never.length === 0 && d.soon.length === 0 && d.soonMinutes === 5 && d.maxAwake === 0);
check('the master switch off turns it all off', TS.normalize({ tabSleep: false }).mode === 'off' && decide([tab(1, 999)], { tabSleep: false }).sleep.length === 0);
check('invalid values fall back to the defaults', JSON.stringify(TS.normalize({ tabSleepPressure: 'x', tabSleepOnReturn: 'y', tabSleepSoonMinutes: 7, tabSleepMaxAwake: -4, tabSleepMinutes: 'abc', tabSleepSoon: 5 })) === JSON.stringify(d));
check('every section key has a default or is the master switch', TS.KEYS.includes('tabSleep') && TS.KEYS.includes('tabPreload') && Object.keys(TS.DEFAULTS).every((k) => TS.KEYS.includes(k)));

// ---- Unload after: presets, Never, custom
check('cleanAfter: 0 is Never, bounds hold', TS.cleanAfter(0) === 0 && TS.cleanAfter('0') === 0 && TS.cleanAfter('') === null && TS.cleanAfter(null) === null && TS.cleanAfter(-1) === null && TS.cleanAfter(10081) === null && TS.cleanAfter(45) === 45);
check('every preset is accepted', [5, 15, 20, 30, 60, 120, 240].every((m) => TS.normalize({ tabSleepMinutes: m }).minutes === m));
{
  const r = decide([tab(1, 14), tab(2, 16), tab(3, 31)], { tabSleepMinutes: 15 }, okMem);
  check('15 minutes: tabs idle 15+ unload, oldest first', JSON.stringify(ids(r)) === '[3,2]' && why(r) === 'idle,idle', JSON.stringify(r.sleep));
  const never = decide([tab(1, 5000), tab(2, 90)], { tabSleepMinutes: 0 }, okMem);
  check('Never: the idle timer does nothing', never.sleep.length === 0, JSON.stringify(never.sleep));
  const neverMem = decide([tab(1, 3), tab(2, 1)], { tabSleepMinutes: 0 }, mem(4));
  check('Never still lets memory pressure unload (tabs idle 2+ minutes)', JSON.stringify(ids(neverMem)) === '[1]' && why(neverMem) === 'memory', JSON.stringify(neverMem.sleep));
}
{
  const perf = { sleepAfterMs: 5 * MIN };
  check('Performance mode shortens the time', JSON.stringify(ids(decide([tab(1, 6), tab(2, 4)], { tabSleepMinutes: 30 }, okMem, perf))) === '[1]');
  check('...never lengthens it', JSON.stringify(ids(decide([tab(1, 4.5), tab(2, 3.5)], { tabSleepMinutes: 4 }, okMem, perf))) === '[1]');
  check('...and shortens Never too (it is the effective time)', JSON.stringify(ids(decide([tab(1, 6), tab(2, 4)], { tabSleepMinutes: 0, tabSleepPressure: 'off' }, okMem, perf))) === '[1]');
}

// ---- memory pressure levels
{
  const tabs = [tab(1, 6), tab(2, 3), tab(3, 1.5), tab(4, 0.5)];
  const at = (level, pct) => decide(tabs, { tabSleepMinutes: 0, tabSleepPressure: level }, mem(pct));
  check('Off: nothing unloads however low memory is', at('off', 1).sleep.length === 0);
  check('Low: waits for under 5% free', at('low', 8).sleep.length === 0 && at('low', 4).low === true);
  check('Low: tabs idle 5+ minutes only', JSON.stringify(ids(at('low', 4))) === '[1]', JSON.stringify(at('low', 4).sleep));
  check('Medium: under 10% free, tabs idle 2+ minutes, oldest first', JSON.stringify(ids(at('medium', 9))) === '[1,2]' && at('medium', 11).sleep.length === 0);
  check('Aggressive: under 20% free, tabs idle 1+ minute, oldest first', JSON.stringify(ids(at('aggressive', 15))) === '[1,2,3]' && at('aggressive', 25).sleep.length === 0);
  check('...with the reason "memory"', why(at('aggressive', 15)) === 'memory,memory,memory');
  check('the macOS pressure verdict stands in for the percentage', decide(tabs, { tabSleepMinutes: 0, tabSleepPressure: 'low' }, { pressure: true }).low === true);
  const lumen = decide(tabs, { tabSleepMinutes: 0, tabSleepPressure: 'low', tabSleepLumenGb: 2 }, { totalBytes: 100 * GB, freeBytes: 90 * GB, lumenBytes: 3 * GB });
  check('Lumen using more than the limit counts as low memory', lumen.low === true && ids(lumen).length === 1);
  check('the Lumen limit is ignored with the level Off', decide(tabs, { tabSleepMinutes: 0, tabSleepPressure: 'off', tabSleepLumenGb: 2 }, { totalBytes: 100 * GB, freeBytes: 90 * GB, lumenBytes: 3 * GB }).sleep.length === 0);
  const mixed = decide([tab(1, 25), tab(2, 4), tab(3, 30)], { tabSleepPressure: 'medium' }, mem(5));
  check('under pressure and over the idle time: all go, least recently used first', JSON.stringify(ids(mixed)) === '[3,1,2]' && why(mixed) === 'idle,idle,memory', JSON.stringify(mixed.sleep));
}

// ---- the old single choice: read as it always was, and migrated once
{
  check('a profile with the old mode "idle" has the memory level Off', TS.normalize({ tabSleepMode: 'idle' }).pressure === 'off');
  check('the old mode "memory" has no timer', TS.normalize({ tabSleepMode: 'memory', tabSleepMinutes: 0 }).useIdle === false && TS.normalize({ tabSleepMode: 'memory' }).useIdle === false);
  check('the old 5% / 25% free choices become Low / Aggressive', TS.normalize({ tabSleepFreePercent: 5 }).pressure === 'low' && TS.normalize({ tabSleepFreePercent: 25 }).pressure === 'aggressive');
  check('nothing stored: nothing to migrate', TS.migrate({}) === null && TS.migrate({ theme: 'dark' }) === null);
  const idle = TS.migrate({ tabSleepMode: 'idle', tabSleepMinutes: 30 });
  check('migrate: idle -> level Off, time kept', idle.tabSleepPressure === 'off' && idle.tabSleep === true && !('tabSleepMinutes' in idle));
  const memory = TS.migrate({ tabSleepMode: 'memory', tabSleepFreePercent: 20 });
  check('migrate: memory only -> Never + level', memory.tabSleepMinutes === 0 && memory.tabSleepPressure === 'aggressive');
  const off = TS.migrate({ tabSleepMode: 'off' });
  check('migrate: Off -> master switch off, mode back to both', off.tabSleep === false && off.tabSleepMode === 'both');
  const migrated = { tabSleepMode: 'idle', tabSleepMinutes: 30, ...TS.migrate({ tabSleepMode: 'idle', tabSleepMinutes: 30 }) };
  check('migrate: once only, and what it wrote reads the same', TS.migrate(migrated) === null && decide([tab(1, 31), tab(2, 5)], migrated, mem(1)).sleep.length === 1);
}

// ---- site lists
check('cleanHosts: wildcards are kept, junk goes, repeats merge', JSON.stringify(TS.cleanHosts(['*.Example.com', 'https://www.mail.*/x', '*', '**', 'a b', '*.example.com'])) === '["*.example.com","mail.*"]', JSON.stringify(TS.cleanHosts(['*.Example.com', 'https://www.mail.*/x', '*', '**', 'a b', '*.example.com'])));
check('a plain name covers subdomains', TS.hostListed('docs.example.com', ['example.com']) && TS.hostListed('example.com', ['example.com']) && !TS.hostListed('notexample.com', ['example.com']));
check('*.example.com covers subdomains only', TS.hostListed('a.b.example.com', ['*.example.com']) && !TS.hostListed('example.com', ['*.example.com']));
check('mail.* covers that name on any domain', TS.hostListed('mail.google.de', ['mail.*']) && TS.hostListed('mail.example.co.uk', ['mail.*']) && !TS.hostListed('webmail.example.com', ['mail.*']));
check('a wildcard in the middle', TS.hostListed('eu.cdn.example.com', ['eu.*.example.com']) && !TS.hostListed('eu.example.org', ['eu.*.example.com']));
{
  const tabs = [tab(1, 100, { host: 'keep.example.com' }), tab(2, 100, { host: 'x.org' }), tab(3, 100, { host: 'mail.google.com' })];
  const r = decide(tabs, { tabSleepNever: ['example.com', 'mail.*'] }, okMem);
  check('"always keep loaded" sites never unload, wildcards included', JSON.stringify(ids(r)) === '[2]', JSON.stringify(r.sleep));
  check('...not even under memory pressure or the cap', decide(tabs, { tabSleepNever: ['example.com', 'mail.*'], tabSleepMaxAwake: 1 }, mem(1)).sleep.every((x) => x.id === 2));
  const soon = decide([tab(1, 6, { host: 'news.com' }), tab(2, 6, { host: 'other.com' }), tab(3, 4, { host: 'news.com' }), tab(4, 7, { host: 'www.news.com' })], { tabSleepSoon: ['news.com'], tabSleepSoonMinutes: 5 }, okMem);
  check('"unload these sites sooner": their own shorter timer, others keep the usual one', JSON.stringify(ids(soon)) === '[4,1]' && why(soon) === 'site,site', JSON.stringify(soon.sleep));
  check('...even among the latest tabs', JSON.stringify(ids(decide([tab(1, 6, { host: 'news.com', viewedAt: 1 })], { tabSleepSoon: ['news.com'], tabSleepKeepRecent: 3 }, okMem))) === '[1]');
  check('...also with the usual timer on Never', JSON.stringify(ids(decide([tab(1, 6, { host: 'news.com' }), tab(2, 600)], { tabSleepSoon: ['news.com'], tabSleepMinutes: 0, tabSleepPressure: 'off' }, okMem))) === '[1]');
  check('...never longer than the usual time', JSON.stringify(ids(decide([tab(1, 11, { host: 'news.com' })], { tabSleepSoon: ['news.com'], tabSleepSoonMinutes: 30, tabSleepMinutes: 10 }, okMem))) === '[1]');
  check('a site on both lists is kept', decide([tab(1, 100, { host: 'both.com' })], { tabSleepSoon: ['both.com'], tabSleepNever: ['both.com'] }, okMem).sleep.length === 0);
}

// ---- exceptions: each one keeps its tab, and its switch lets go where it is optional
{
  const base = { tabSleepKeepRecent: 0 };
  const kept = (extra, settings = {}) => decide([tab(1, 100, extra)], { ...base, ...settings }, okMem).sleep.length === 0;
  check('audio or video: kept by default, released by its switch', kept({ audible: true }) && !kept({ audible: true }, { tabSleepKeepAudio: false }));
  check('pinned: kept by default, released by its switch', kept({ pinned: true }) && !kept({ pinned: true }, { tabSleepKeepPinned: false }));
  check('download in progress: kept by default, released by its switch', kept({ downloading: true }) && !kept({ downloading: true }, { tabSleepKeepTransfers: false }));
  check('tab group: not kept by default, kept by its switch', !kept({ groupId: 4 }) && kept({ groupId: 4 }, { tabSleepKeepGroups: true }) && kept({ grouped: true }, { tabSleepKeepGroups: true }));
  check('a call or camera/microphone/screen share: always kept, whatever else is set', kept({ capturing: true }, { tabSleepKeepAudio: false, tabSleepKeepPinned: false, tabSleepKeepTransfers: false, tabSleepKeepForms: false, tabSleepKeepGroups: false }) && kept({ capturing: true }, { tabSleepMinutes: 5 }));
  check('the AI agent or a background task: always kept', kept({ agentUsing: true }) && kept({ aiBusy: true }) && kept({ aiLock: true }) && kept({ agentUsing: true }, { tabSleepKeepAudio: false, tabSleepKeepTransfers: false }));
  check('the tab in front, a loading tab, full screen, DevTools, popups: kept', kept({ active: true }) && kept({ loading: true }) && kept({ fullscreen: true }) && kept({ devTools: true }) && kept({ openPopups: 1 }));
  check('Lumen pages (settings, history, ...) are kept', kept({ webPage: false }) && kept({ settings: true }));
  check('an exempt tab under memory pressure and the cap is still kept', decide([tab(1, 100, { audible: true }), tab(2, 100, { capturing: true })], { ...base, tabSleepMaxAwake: 1 }, mem(1)).sleep.length === 0);
  check('keepReason names the reason', TS.keepReason({ alive: true, webPage: true, audible: true }) === 'audio' && TS.keepReason({ alive: true, webPage: true, downloading: true }) === 'transfer' && TS.keepReason({ alive: true, webPage: true, grouped: true, keepGroups: true }) === 'group' && TS.keepReason({ alive: true, webPage: true }) === null);
}

// ---- Most background tabs kept loaded: which go, in what order
{
  const bg = [tab(1, 50), tab(2, 40), tab(3, 30), tab(4, 20), tab(5, 10), tab(6, 5)];
  const r = decide(bg, { tabSleepMinutes: 0, tabSleepPressure: 'off', tabSleepMaxAwake: 3 }, okMem);
  check('cap 3 with 6 loaded: 3 over, least recently used first', r.capExcess === 3 && ids(r).slice(0, 3).join() === '1,2,3', JSON.stringify(r));
  check('...the caller stops at capExcess: the list is longest-idle first', ids(r).join() === '1,2,3,4,5,6' && r.capExcess === 3);
  check('Unlimited sets no cap', decide(bg, { tabSleepMinutes: 0, tabSleepPressure: 'off', tabSleepMaxAwake: 0 }, okMem).capExcess === 0);
  check('a custom cap is any number up to 500', TS.normalize({ tabSleepMaxAwake: 37 }).maxAwake === 37 && TS.normalize({ tabSleepMaxAwake: 501 }).maxAwake === 0 && TS.cleanMaxAwake(500) === 500 && TS.cleanMaxAwake('') === null);
  const idle = decide([...bg, tab(7, 61)], { tabSleepMinutes: 60, tabSleepPressure: 'off', tabSleepMaxAwake: 3 }, okMem);
  check('tabs already unloading for being idle count against the excess', idle.capExcess === 3 && idle.sleep[0].why === 'idle' && idle.sleep[0].id === 7, JSON.stringify(idle));
  check('a tab used in the last minute is never taken by the cap', !ids(decide([tab(1, 0.5), tab(2, 0.4), tab(3, 0.2)], { tabSleepMinutes: 0, tabSleepPressure: 'off', tabSleepMaxAwake: 1 }, okMem)).length);
  check('exempt tabs are skipped by the cap, the next oldest goes', ids(decide([tab(1, 90, { pinned: true }), tab(2, 80), tab(3, 70), tab(4, 60)], { tabSleepMinutes: 0, tabSleepPressure: 'off', tabSleepMaxAwake: 2 }, okMem)).join() === '2,3,4');
  check('Performance mode\'s cap and the setting: the lower wins', decide(bg, { tabSleepMinutes: 0, tabSleepPressure: 'off', tabSleepMaxAwake: 5 }, okMem, { maxLiveBackgroundTabs: 4 }).capExcess === 2);
  const rec = decide(bg.map((t) => ({ ...t, viewedAt: 1 })), { tabSleepMinutes: 20, tabSleepPressure: 'off', tabSleepKeepRecent: 2 }, okMem);
  check('the latest 2 tabs are not taken by the timer', JSON.stringify(ids(rec)) === '[1,2,3,4]' && !ids(rec).includes(6) && !ids(rec).includes(5), JSON.stringify(rec.sleep));
}

// ---- the status panel
{
  const tabs = [
    { id: 1, active: true, host: 'a.com' }, { id: 2, host: 'b.com' }, { id: 3, host: 'c.com', audible: true }, { id: 4, host: 'd.com', pinned: true },
    { id: 5, asleep: true, sleeping: true }, { id: 6, asleep: true, sleeping: true }, { id: 7, frozen: true, sleeping: true, host: 'e.com' }, { id: 8, host: 'f.com', groupId: 2 }, { id: 9, closing: true },
    { id: 10, host: 'g.com', webPage: false }, { id: 11, host: 'h.com', downloading: true }, { id: 12, host: 'mail.google.com' },
  ];
  const t = TS.tally(tabs, { tabSleepNever: ['mail.*'] });
  check('tally: loaded counts the front tab and frozen tabs', t.loaded === 9 && t.frozen === 1, JSON.stringify(t));
  check('tally: unloaded counts closed pages only', t.unloaded === 2);
  check('tally: exempt = loaded background tabs that would not unload now, with reasons', t.exempt === 5 && t.reasons.audio === 1 && t.reasons.pinned === 1 && t.reasons.internal === 1 && t.reasons.transfer === 1 && t.reasons.site === 1, JSON.stringify(t));
  const g = TS.tally(tabs, { tabSleepKeepGroups: true });
  check('tally follows the switches (tab groups kept)', g.reasons.group === 1 && g.exempt === 5, JSON.stringify(g));
  const off = TS.tally(tabs, { tabSleepKeepAudio: false, tabSleepKeepPinned: false });
  check('tally: released exceptions no longer count', !off.reasons.audio && !off.reasons.pinned, JSON.stringify(off));
}

// ---- every string the page uses is in locales/en.json
{
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8').replace(/\r\n/g, '\n');
  const EN = JSON.parse(read('src/locales/en.json'));
  const src = read('src/renderer/settings-unload.js');
  const keys = [...src.matchAll(/\bun\('([^']+)',\s*'((?:[^'\\]|\\.)*)'/g)];
  check('the page has strings', keys.length > 80, String(keys.length));
  const missing = keys.filter(([, k]) => !(`settings.unload.${k}` in EN)).map(([, k]) => k);
  check('every settings.unload.* key the page uses is in en.json', missing.length === 0, missing.join(', '));
  const stale = keys.filter(([, k, english]) => EN[`settings.unload.${k}`] !== english.replace(/\\'/g, "'")).map(([, k]) => k);
  check('...and en.json says what the page falls back to', stale.length === 0, stale.join(', '));
  const reasons = ['audio', 'transfer', 'pinned', 'site', 'group', 'popups', 'ai', 'internal', 'settings', 'loading', 'fullscreen', 'devtools', 'capturing'];
  check('every exemption reason has a name', reasons.every((r) => `settings.unload.why.${r}` in EN));
  check('the menu and hover strings exist', ['menu.unloadTab', 'menu.unloadOtherTabs', 'menu.neverSleepSite', 'menu.allowSiteSleep', 'tabs.freedHover', 'unloaded.title', 'unloaded.lead', 'unloaded.freed', 'unloaded.reload'].every((k) => k in EN));
  const noLong = Object.entries(EN).filter(([k, v]) => k.startsWith('settings.unload.') && /\bdesc$/i.test(k) === false && v.length > 140 && !/Desc$/.test(k));
  check('only descriptions are long', noLong.length === 0, noLong.map(([k]) => k).join(', '));
}

if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('tab-unload units OK');
