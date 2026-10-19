// Marking and taking over the tabs the AI opened (features/ai-manners.js), plain Node: no Electron.
// A tab the AI opens carries { chatId, runId, at }. It stays the AI's until the user takes it over (pins it, navigates it, drags it into
// a group of theirs, moves it to another window, types or clicks in it). The mark is saved with the session and put back on restore.
// "Close tabs the AI opened" takes only what is still the AI's, keeps what a run is working in and says so.
const M = require('../src/features/ai-manners');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const J = (v) => JSON.stringify(v);
const ids = (list) => list.map((t) => t.id).join(',');
const mk = (id, extra = {}, by = { chatId: 'c1', runId: 7 }) => M.markOpened({ id, ...extra }, by, 5000);

// ---- the mark
{
  const tab = mk(1);
  check('mark: chat, run and time of the tool call that opened it', J(tab.openedBy) === '{"chatId":"c1","runId":7,"at":5000}');
  check('mark: a tab nobody marked is the user\'s (the tab they were on when the AI started is never marked)', !M.isAiTab({ id: 2 }) && !M.isAiTab(null) && !M.isAiTab(undefined));
  check('mark: no ids (an outside agent, or Lumen opening a tab for a chat) still counts', M.isAiTab(M.markOpened({ id: 3 })));
  check('mark: marking nothing is harmless', M.markOpened(null) === null);
}

// ---- taking over
{
  const tab = mk(1);
  check('takeover: handOver clears the mark once and says it had one', M.handOver(tab) === true && tab.openedBy === null && !M.isAiTab(tab) && M.handOver(tab) === false);
  check('takeover: viewing a tab is not a takeover (nothing here changes the mark)', (() => { const t = mk(2); t.lastViewedAt = Date.now(); return M.isAiTab(t); })());
  check('takeover: a pinned tab is taken over even when handOver was missed', M.takenOver(mk(3, { pinned: true })) === true && ids(M.closeSelection([mk(3, { pinned: true })])) === '');
  check('takeover: a tab placed by hand (dragged into a group or a position) is taken over', M.takenOver(mk(4, { userMoved: true })) === true && ids(M.closeSelection([mk(4, { userMoved: true })])) === '');
  check('takeover: a group the AI or automatic grouping chose is not a takeover', M.takenOver(mk(5, { groupId: 'g1' })) === false && ids(M.closeSelection([mk(5, { groupId: 'g1' })])) === '5');
  check('takeover: a tab the user has not touched is not taken over', M.takenOver(mk(6)) === false);
  check('takeover: handOver on a tab that was never the AI\'s changes nothing', M.handOver({ id: 9 }) === false && M.handOver(null) === false);
}

// ---- which tabs "close" takes
{
  const tabs = [mk(1), mk(2, { pinned: true }), mk(3), { id: 4 }, mk(5, { closing: true }), mk(6, {}, { chatId: 'c2', runId: 8 }), mk(7)];
  check('close: all chats: every marked tab that is still the AI\'s', ids(M.closeSelection(tabs)) === '1,3,6,7', ids(M.closeSelection(tabs)));
  check('close: one chat', ids(M.closeSelection(tabs, { chatId: 'c1' })) === '1,3,7' && ids(M.closeSelection(tabs, { chatId: 'c2' })) === '6');
  check('close: one run', ids(M.closeSelection(tabs, { runId: 7 })) === '1,3,7');
  check('close: never the user\'s own tab, a pinned one, one already closing', !ids(M.closeSelection(tabs)).split(',').some((i) => ['2', '4', '5'].includes(i)));
  check('close: never the tab a chat lives in', ids(M.closeSelection(tabs, { boundIds: [1] })) === '3,6,7');
}

// ---- a run still using a tab: kept, and counted for the toast
{
  const tabs = [mk(1), mk(2), mk(3, {}, { chatId: 'c2', runId: 8 })];
  check('busy: a tab a run works in is not closed', ids(M.closeSelection(tabs, { busyIds: [2] })) === '1,3');
  check('busy: ...and is the one the toast says it kept', ids(M.busyKept(tabs, { busyIds: [2] })) === '2');
  check('busy: nothing busy, nothing kept', M.busyKept(tabs, { busyIds: [] }).length === 0 && M.busyKept(tabs).length === 0);
  check('busy: a busy tab of another chat does not count when closing one chat', M.busyKept(tabs, { chatId: 'c1', busyIds: [3] }).length === 0);
  check('busy: a tab the chat lives in is not reported as "still using" (it is never offered)', M.busyKept(tabs, { busyIds: [2], boundIds: [2] }).length === 0);
  check('busy: a tab the user took over is not reported', M.busyKept([mk(4, { pinned: true })], { busyIds: [4] }).length === 0);
  check('busy: closed + kept always add up to what was marked and free', M.closeSelection(tabs, { busyIds: [1, 2] }).length + M.busyKept(tabs, { busyIds: [1, 2] }).length === 3);
}

// ---- the saved session
{
  check('saved: an AI tab saves its chat and time, not the run (run ids start again after a restart)', J(M.savedMark(mk(1))) === '{"chatId":"c1","at":5000}');
  check('saved: the user\'s tab saves nothing', M.savedMark({ id: 2 }) === null && M.savedMark(null) === null);
  check('saved: a pinned tab saves nothing: it is the user\'s', M.savedMark(mk(3, { pinned: true })) === null);
  check('saved: a mark with no chat saves null for it', J(M.savedMark(M.markOpened({ id: 4 }, {}, 9))) === '{"chatId":null,"at":9}');
  const restored = M.restoreMark({ id: 10 }, { chatId: 'c1', at: 5000 });
  check('restore: the tab is the AI\'s again, of that chat, from that time, with no run', J(restored.openedBy) === '{"chatId":"c1","runId":null,"at":5000}' && M.isAiTab(restored));
  check('restore: a restored tab is closed by "this chat\'s tabs" and by "all", but not by a run that has the same number', ids(M.closeSelection([restored], { chatId: 'c1' })) === '10' && ids(M.closeSelection([restored])) === '10' && ids(M.closeSelection([restored], { runId: 7 })) === '');
  check('restore: a pinned or hand-placed restored tab stays the user\'s', !M.isAiTab(M.restoreMark({ id: 11, pinned: true }, { chatId: 'c1', at: 1 })) && !M.isAiTab(M.restoreMark({ id: 12, userMoved: true }, { chatId: 'c1', at: 1 })));
  check('restore: nothing saved, nothing marked; junk is ignored', !M.isAiTab(M.restoreMark({ id: 13 }, null)) && !M.isAiTab(M.restoreMark({ id: 14 }, false)) && M.restoreMark({ id: 15 }, { chatId: 5, at: 'x' }).openedBy.chatId === null);
  check('restore: round trip keeps what the strip and the chat count', (() => { const a = mk(20, {}, { chatId: 'c9', runId: 3 }); const b = M.restoreMark({ id: 20 }, JSON.parse(J(M.savedMark(a)))); return b.openedBy.chatId === 'c9' && b.openedBy.at === 5000; })());
}

// ---- after a run, and the setting
{
  check('after a run: Never (the default) puts a Close button under the reply', M.closeAfterRun({ setting: 'off', n: 5 }) === 'offer' && M.closeAfterRun({ n: 5 }) === 'offer');
  check('after a run: Ask asks; Always closes with Undo; nothing opened shows nothing', M.closeAfterRun({ setting: 'ask', n: 5 }) === 'ask' && M.closeAfterRun({ setting: 'always', n: 5 }) === 'close' && M.closeAfterRun({ setting: 'always', n: 0 }) === 'none' && M.closeAfterRun({ setting: 'off', n: 0 }) === 'none');
  check('setting: anything unknown is Never', M.cleanCloseSetting('sometimes') === 'off' && M.cleanCloseSetting(undefined) === 'off');
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
