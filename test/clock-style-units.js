// New-tab clock styles and greeting fonts, pure logic (run from test/units.js): the settings' defaults and
// checks, what the page is sent, the time split into parts, and that every style the settings accept has
// a look on the page and a preview in Settings. No Electron window, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const CS = require('../src/features/clock-styles');
const SB = require('../src/settings/settings-backend');

module.exports = async function clockStyleUnits(check) {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const D = SB.DEFAULTS;

  // ---- defaults: the page as it always was ----
  check('clock styles: the defaults change nothing (Classic, automatic hours, no seconds, date shown, no card, no extra shadow, classic greeting)',
    D.newTabClockStyle === 'classic' && D.newTabClockHours === 'auto' && D.newTabClockSeconds === false && D.newTabClockDate === true
    && D.newTabClockCard === 'none' && D.newTabClockShadow === false && D.newTabGreetingFont === 'classic', JSON.stringify(D));
  check('clock styles: the module\'s defaults are the settings\' defaults',
    JSON.stringify(CS.DEFAULTS) === JSON.stringify({ style: D.newTabClockStyle, hours: D.newTabClockHours, seconds: D.newTabClockSeconds, date: D.newTabClockDate, card: D.newTabClockCard, shadow: D.newTabClockShadow, greeting: D.newTabGreetingFont }), JSON.stringify(CS.DEFAULTS));
  check('clock styles: six styles, Classic first', CS.CLOCK_STYLES.map((s) => s.id).join() === 'classic,rounded,thin,serif,mono,bold' && CS.CLOCK_STYLES.every((s) => s.label && s.hint), '');
  check('greeting fonts: Classic first, then Match clock, all labelled', CS.GREETING_FONTS[0].id === 'classic' && CS.GREETING_FONTS[1].id === 'match' && CS.GREETING_FONTS.every((f) => f.label), '');

  // ---- validation ----
  const v = SB.validate;
  check('clock styles: a known style is kept, anything else refused', v('newTabClockStyle', 'serif') === 'serif' && v('newTabClockStyle', 'comic') === null && v('newTabClockStyle', 3) === null && v('newTabClockStyle', undefined) === null, '');
  check('clock styles: hours are auto, 12 or 24 (a number is taken as its string)', v('newTabClockHours', 'auto') === 'auto' && v('newTabClockHours', '12') === '12' && v('newTabClockHours', 24) === '24' && v('newTabClockHours', '13') === null && v('newTabClockHours', null) === null, '');
  check('clock styles: the card is none, soft or glass', ['none', 'soft', 'glass'].every((c) => v('newTabClockCard', c) === c) && v('newTabClockCard', 'neon') === null, '');
  check('clock styles: seconds, date and shadow are plain booleans', v('newTabClockSeconds', true) === true && v('newTabClockDate', false) === false && v('newTabClockShadow', true) === true && v('newTabClockSeconds', 'yes') === null && v('newTabClockShadow', 1) === null, '');
  check('greeting fonts: a known font is kept, anything else refused', v('newTabGreetingFont', 'hand') === 'hand' && v('newTabGreetingFont', 'match') === 'match' && v('newTabGreetingFont', 'Papyrus') === null && v('newTabGreetingFont', '') === null, '');

  // ---- what the page is sent ----
  let settings = {};
  const backend = SB.create({
    app: { getPath: () => os.tmpdir(), disableHardwareAcceleration() {}, commandLine: { appendSwitch() {} }, getLocale: () => 'en' },
    session: { defaultSession: { availableSpellCheckerLanguages: [], getSpellCheckerLanguages: () => [] } }, nativeTheme: {}, dialog: {}, shell: {}, readSettings: () => settings, writeSettings: (s) => { settings = s; },
  });
  check('clock styles: an untouched profile sends the defaults', JSON.stringify(backend.newTabLook().clockStyle) === JSON.stringify(CS.DEFAULTS), JSON.stringify(backend.newTabLook().clockStyle));
  settings = { newTabClockStyle: 'bold', newTabClockHours: '24', newTabClockSeconds: true, newTabClockDate: false, newTabClockCard: 'glass', newTabClockShadow: true, newTabGreetingFont: 'serif' };
  check('clock styles: chosen values reach the page', JSON.stringify(backend.newTabLook().clockStyle) === JSON.stringify({ style: 'bold', hours: '24', seconds: true, date: false, card: 'glass', shadow: true, greeting: 'serif' }), JSON.stringify(backend.newTabLook().clockStyle));
  settings = { newTabClockStyle: '<script>', newTabClockHours: 'x', newTabClockSeconds: 'on', newTabClockCard: {}, newTabGreetingFont: 'url(x)' };
  check('clock styles: a tampered settings file falls back to the defaults', JSON.stringify(backend.newTabLook().clockStyle) === JSON.stringify(CS.DEFAULTS), JSON.stringify(backend.newTabLook().clockStyle));
  check('clock styles: Settings is given the choices to draw', backend.state().clockStyles === CS.CLOCK_STYLES && backend.state().greetingFonts === CS.GREETING_FONTS, '');

  // ---- the page's own check of the hash ----
  check('clock styles: the page cleans whatever the hash carries', JSON.stringify(CS.clean(null)) === JSON.stringify(CS.DEFAULTS) && JSON.stringify(CS.clean({ style: 'nope', hours: 99, seconds: 'true', date: 0, card: 'x', shadow: 'y', greeting: 'z' })) === JSON.stringify({ ...CS.DEFAULTS, date: true }), JSON.stringify(CS.clean({ date: 0 })));
  check('greeting fonts: Match clock takes the clock\'s face; Stacked (already bold) keeps Classic; a chosen font wins',
    CS.greetingFontFor('match', 'serif') === 'serif' && CS.greetingFontFor('match', 'thin') === 'thin' && CS.greetingFontFor('match', 'bold') === 'classic'
    && CS.greetingFontFor('match', 'junk') === 'classic' && CS.greetingFontFor('mono', 'serif') === 'mono' && CS.greetingFontFor(undefined, 'serif') === 'classic', '');

  // ---- the time in parts ----
  const at = new Date(2026, 0, 5, 21, 4, 7);
  const morning = new Date(2026, 0, 5, 9, 41, 0);
  const p = (d, o) => CS.clockParts(d, { locale: 'en-US', ...o });
  check('clock: automatic in en-US is 12-hour without AM/PM, as before', p(at).text === '9:04' && p(at).text === at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, ''), p(at).text);
  check('clock: 24-hour keeps the leading zero, 12-hour has none', p(morning, { hours: '24' }).text === '09:41' && p(at, { hours: '24' }).text === '21:04' && p(morning, { hours: '12' }).text === '9:41' && CS.clockParts(at, { hours: '12', locale: 'de-DE' }).text === '9:04', `${p(morning, { hours: '24' }).text} ${CS.clockParts(at, { hours: '12', locale: 'de-DE' }).text}`);
  check('clock: 12-hour midnight and noon are 12', p(new Date(2026, 0, 5, 0, 5), { hours: '12' }).h === '12' && p(new Date(2026, 0, 5, 12, 5), { hours: '12' }).h === '12', '');
  const sec = p(at, { hours: '24', seconds: true });
  check('clock: seconds are their own part (drawn small), and off by default', sec.s === '07' && sec.ssep === ':' && sec.text === '21:04:07' && p(at).s === '' && p(at).ssep === '', JSON.stringify(sec));
  check('clock: hours and minutes are separate parts so Stacked can put one over the other', sec.h === '21' && sec.m === '04' && sec.sep === ':', JSON.stringify(sec));
  check('clock: a locale\'s own separator is kept', CS.clockParts(at, { hours: '24', locale: 'fi-FI' }).sep === '.', CS.clockParts(at, { hours: '24', locale: 'fi-FI' }).sep);
  check('clock: a bad locale still gives a time', /^\d{1,2}:\d\d$/.test(CS.clockParts(at, { locale: 'not a locale!!' }).text), CS.clockParts(at, { locale: 'not a locale!!' }).text);

  // ---- every style has a look on the page and a preview in Settings; system fonts only ----
  const page = read('src/renderer/newtab.html');
  const css = read('src/renderer/settings.css');
  const missingLook = CS.CLOCK_STYLES.filter((s) => s.id !== 'classic' && !page.includes(`data-clock-style="${s.id}"`)).map((s) => s.id);
  const missingPreview = CS.CLOCK_STYLES.filter((s) => s.id !== 'classic' && !css.includes(`.cs-${s.id}`)).map((s) => s.id);
  check('clock styles: each one is drawn on the page and previewed in Settings', !missingLook.length && !missingPreview.length, JSON.stringify({ missingLook, missingPreview }));
  const fonts = CS.GREETING_FONTS.map((f) => f.id).filter((f) => f !== 'classic' && f !== 'match');
  const missingFont = fonts.filter((f) => !page.includes(`data-greeting-font="${f}"`) || !css.includes(`.gf-${f}`));
  check('greeting fonts: each one is drawn on the page and previewed in Settings', !missingFont.length, JSON.stringify(missingFont));
  check('clock styles: the cards have their looks', page.includes('data-clock-card="soft"') && page.includes('data-clock-card="glass"') && page.includes('data-clock-shadow="1"'), '');
  check('clock styles: system fonts only (no @font-face, no font-src, no font files)', !/@font-face/.test(page) && !/@font-face/.test(css) && !/font-src/.test(page) && !/\.(woff2?|ttf|otf)\b/i.test(page + css), '');
  check('clock styles: the page\'s CSP is unchanged', /default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src data: file:; frame-src https:; form-action https:/.test(page), '');
  check('clock styles: digits are tabular so they never jitter', /\.clock \{[^}]*tabular-nums/.test(page) && /\.ct-face \{[^}]*tabular-nums/.test(css), '');
  const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  check('clock styles: the page loads the module before newtab.js', scripts.indexOf('../features/clock-styles.js') >= 0 && scripts.indexOf('../features/clock-styles.js') < scripts.indexOf('newtab.js'), JSON.stringify(scripts));
  const js = read('src/renderer/newtab.js');
  check('clock: the time is built from text nodes, never HTML', /replaceChildren\(span\('clock-h'/.test(js) && !/clock[^\n]*innerHTML/.test(js), '');
  check('clock: seconds wake the page every second only when shown, a minute otherwise', /seconds \? 1000 : 60e3/.test(js), '');
};
