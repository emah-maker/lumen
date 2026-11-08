// [quiet run] A run that goes on after one of its turns ends (Claude Code's helpers, reviewers or agents still at work on the card) keeps the chat
// quiet until it is over: what that turn said is the card's status line, not a bubble; a file it writes again is the same card, updated; the
// "Save how I did this as a skill?" offer comes once, at the very end. Pure: a plain script in the UI (window.runQuiet, before chat-core.js) and
// require()d by the tests.
//
//   asks(text)                     whether the words ask the user something (they end on a question): those stay in the chat
//   interim(text, { waiting })     the words to fold into the card ('' when there are none, they ask the user, or an approval waits)
//   fileKey(file)                  one key per file path ('C:\\a\\B.md' and 'c:/a/b.md' are one file)
//   offerGate()                    one skill offer per run: hold(run, offer) while it goes on, show(run, offer) at its end, release(run) the held
//                                  one; a run that showed one (whatever the user then picked) shows no other. run: any object (the run's card)
(function (root) {
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function asks(text) {
    const s = clean(text).replace(/[\s*_`)\]"'”’]+$/, '');
    return /\?$/.test(s);
  }

  function interim(text, { waiting = false } = {}) {
    const s = clean(text);
    if (!s || waiting || asks(s)) return '';
    return s;
  }

  function fileKey(file) {
    const p = String(file?.path || file?.name || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    return p.toLowerCase();
  }

  function offerGate() {
    const shown = new WeakSet();
    const held = new WeakMap();
    return {
      hold(run, offer) { if (run && offer && !shown.has(run)) held.set(run, offer); },
      show(run, offer) {
        if (!run || !offer || shown.has(run)) return null;
        shown.add(run);
        held.delete(run);
        return offer;
      },
      release(run) {
        const offer = run ? held.get(run) : null;
        if (!offer) return null;
        held.delete(run);
        if (shown.has(run)) return null;
        shown.add(run);
        return offer;
      },
      shown: (run) => Boolean(run) && shown.has(run),
    };
  }

  const api = { asks, interim, fileKey, offerGate };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.runQuiet = api;
})(this);
