// The AI's manners in the user's browser (agent.js and main.js wire this to the tabs and the tools).
//
// This file is the pure part:
//   openedBy            which tabs the AI opened, and when one becomes the user's (they clicked or typed in it,
//                       navigated it, pinned it, moved it into a group)
//   closeSelection()    which of those tabs "Close the tabs the AI opened" may close
//   handsOffRefusal()   "Don't let the AI act on my pages": the tools that act, and the refusal for a tab that is not the AI's
//   typingWait()        how long the AI's typing waits while the user types in the same tab
//   guardsFocus()       whether the user's caret in a page needs putting back after the AI acted there
//   showsTab()          may open_tab / switch_tab bring the tab to the front (never by default)
//   closeAfterRun()     what the "close the tabs the AI opened" setting does when a run ends
//   agentInput / userInput   which keys and clicks in a tab came from the AI's tools and which from the user
//
// The model, in short: the AI works in the background. A tab it opens stays behind the tab the user is on,
// nothing it does moves the user's focus (address bar, a field in a page, the sidebar, another app), and what it
// opened can be closed again in one step. With hands-off mode on it also leaves the user's own tabs alone.

// ---- tabs the AI opened
// `by`: { chatId, runId } of the run that opened it (null ids: an outside agent, or Lumen opening a tab for a chat).
function markOpened(tab, by = {}, now = Date.now()) {
  if (!tab) return tab;
  tab.openedBy = { chatId: by.chatId ?? null, runId: by.runId ?? null, at: now };
  return tab;
}
// The tab is the user's from now on. True when it had been the AI's.
function handOver(tab) {
  if (!tab || !tab.openedBy) return false;
  tab.openedBy = null;
  return true;
}
const isAiTab = (tab) => Boolean(tab && tab.openedBy);
// Has the user taken this tab over without handOver having been called (pinned, dragged to a place by hand)?
// A group the AI or Lumen's own automatic grouping put it in does not count: only a move or a pin of the user's.
const takenOver = (tab) => Boolean(tab?.openedBy && (tab.pinned || tab.userMoved));

// Which tabs may be closed as "the tabs the AI opened".
//   runId / chatId   only that run's / that chat's tabs (neither: every tab the AI opened)
//   boundIds         tabs a chat lives in: never closed
//   busyIds          tabs a run is working in right now: never closed
//   activeId         with `auto`, the tab the user is looking at stays
//   auto             an automatic close (the setting) rather than the user's own click
// A pinned tab, one the user took over, and one that is closing already are never in it.
function closeSelection(tabs, { runId = null, chatId = null, boundIds = [], busyIds = [], activeId = null, auto = false } = {}) {
  const bound = new Set(boundIds);
  const busy = new Set(busyIds);
  return (tabs || []).filter((tab) => {
    if (!tab || !tab.openedBy || tab.closing) return false;
    if (runId != null && tab.openedBy.runId !== runId) return false;
    if (chatId != null && tab.openedBy.chatId !== chatId) return false;
    if (tab.pinned || takenOver(tab)) return false;
    if (bound.has(tab.id) || busy.has(tab.id)) return false;
    if (auto && tab.id === activeId) return false;
    return true;
  });
}

const CLOSE_SETTINGS = ['off', 'ask', 'always'];
const cleanCloseSetting = (value) => (CLOSE_SETTINGS.includes(value) ? value : 'off');
// What happens when a run that opened `n` closeable tabs ends: 'none' (it opened none), 'offer' (a quiet
// "Close N tabs" under the reply), 'ask' (the same, as a question), 'close' (closes them, with Undo).
function closeAfterRun({ setting = 'off', n = 0 } = {}) {
  if (!n) return 'none';
  const s = cleanCloseSetting(setting);
  return s === 'always' ? 'close' : s === 'ask' ? 'ask' : 'none'; // Off: nothing under the reply (the tab menu and the chat's row still close them)
}

// ---- hands-off mode
// The tools that click, type, move or run something in a page (or close a tab). Reading tools are not here.
const ACTION_TOOLS = new Set(['click', 'click_at', 'type_text', 'fill_form', 'press_key', 'scroll', 'navigate', 'reload', 'go_back', 'go_forward', 'run_script', 'hover', 'close_tab', 'group_tabs', 'ungroup_tabs']);
const isActionTool = (name) => ACTION_TOOLS.has(name);

const handsOffRefusal = (tool) => `Hands-off mode is on: the user does not let the AI click, type, scroll or navigate in their own tabs, so ${tool} was not run on this tab. Open a tab of your own with open_tab (it opens in the background) and work there. Reading the user's tabs (read_page, find, screenshot, read_tabs, list_tabs) still works.`;

// null when the call may go ahead, else the error text for the model.
//   handsOff    the setting
//   ownTab      the tab the tool would act on is one the AI opened
function handsOffCheck({ tool, handsOff = false, ownTab = false } = {}) {
  if (!handsOff || !isActionTool(tool) || ownTab) return null;
  return handsOffRefusal(tool);
}

// The same rule for the opt-in Automation (CDP) server (automation/automation.js), which outside programs drive. There it is an
// ALLOWLIST: on a tab the AI did not open (and for commands that name no tab at all) only commands that read are let through, so
// a method nobody listed (a future Chromium one, Page.crash, ServiceWorker.*, CacheStorage.*, Autofill.trigger, Browser.setDownloadBehavior,
// Storage.clearCookies, ...) is refused by default.
const AUTOMATION_READS = new RegExp('^(' + [
  '(?!Fetch\\.|Debugger\\.)[A-Za-z]+\\.(enable|disable)$', // switching a domain's events on / off (not Fetch: paused requests would hang; not the debugger)
  '[A-Za-z]+\\.get[A-Z]\\w*$', // getFrameTree, getDocument, getBoxModel, getProperties, getCookies, getTargets, getVersion, getFullAXTree, ...
  'DOM\\.(querySelector|querySelectorAll|describeNode|resolveNode|requestChildNodes|requestNode|performSearch|getSearchResults|discardSearchResults|collectClassNamesFromSubtree)$',
  'Page\\.(captureScreenshot|captureSnapshot|printToPDF|createIsolatedWorld|setLifecycleEventsEnabled)$',
  'Runtime\\.(releaseObject|releaseObjectGroup|runIfWaitingForDebugger)$',
  'Accessibility\\.(queryAXTree)$',
  'CSS\\.(collectClassNames)$',
  'Target\\.(setDiscoverTargets|setAutoAttach|autoAttachRelated|attachToTarget|detachFromTarget|createTarget)$',
  'Browser\\.(getVersion)$',
].join('|') + ')');
// Init-time calls clients (Playwright connectOverCDP, Puppeteer) make when they attach: answered with an empty success and NOT run on a
// tab the AI did not open, so attaching still works and the session simply stays read-only.
const AUTOMATION_INIT_NOOPS = new Set(['Page.addScriptToEvaluateOnNewDocument', 'Emulation.setFocusEmulationEnabled', 'Runtime.addBinding', 'Network.setCacheDisabled', 'Emulation.setEmulatedMedia', 'Page.setBypassCSP', 'Emulation.setAutoDarkModeOverride']);
const isAutomationRead = (method) => AUTOMATION_READS.test(String(method || ''));
// { ok: true } (run it), { noop: true } (answer {} without running it) or { error } (refuse, with the text for the client).
//   handsOff   the setting
//   ownTab     the command is for a tab the AI opened
// Not for hands-off mode: everything is { ok: true }.
function automationVerdict({ method, handsOff = false, ownTab = false } = {}) {
  if (!handsOff || ownTab || isAutomationRead(method)) return { ok: true };
  if (AUTOMATION_INIT_NOOPS.has(method)) return { noop: true };
  return { error: `Hands-off mode is on in Lumen: ${method} is not a read-only command, and this is not a tab the AI opened, so it was not run. Reads (screenshots, DOM, accessibility tree, Runtime.enable) work; evaluating script here (Runtime.evaluate) is refused. Open your own tab (Target.createTarget) to act.` };
}

// One line for the system prompt, so the model plans around it instead of finding out by being refused.
const HANDS_OFF_PROMPT = 'Hands-off mode is on: the user does not let you click, type, scroll or navigate in their own tabs. You can read them (read_page, find, screenshot, read_tabs, list_tabs). To act, open your own tab with open_tab (it opens in the background) and work there; those tabs are yours.';

// ---- the user's focus
const TYPING_GRACE_MS = 1500; // the AI's typing waits this long after the user's last key in the same tab
const TYPING_WAIT_CAP_MS = 20000; // ...and gives up waiting after this long, so a user who keeps typing doesn't stall a run forever
const FOCUS_RECENT_MS = 15000; // the user's caret in a page is put back when they were active there this recently

// Milliseconds the AI must still wait before it types in a tab: the user's last key there was at `typedAt`.
function typingWait({ typedAt = 0, now = Date.now(), grace = TYPING_GRACE_MS } = {}) {
  if (!typedAt) return 0;
  return Math.max(0, typedAt + grace - now);
}

// Should the user's focus inside this page (the field they are in, and its caret) be saved before the AI acts
// there and put back after? Only when the page is where the user's keyboard is, or was a moment ago.
function guardsFocus({ pageFocused = false, userInputAt = 0, now = Date.now(), recent = FOCUS_RECENT_MS } = {}) {
  return Boolean(pageFocused) || (Boolean(userInputAt) && now - userInputAt < recent);
}

// May open_tab / switch_tab bring a tab to the front? Never by default: only when the tool asked to show it and
// the user is looking at the run's own tab (they are watching this chat work: tab-chats.js mayTakeFront).
function showsTab({ show = false, runTabId = null, activeId = null } = {}) {
  return show === true && runTabId != null && runTabId === activeId;
}

// ---- which keys and clicks came from the AI
// A tool's sendInputEvent runs inside agentInput(wc, fn); the page view's key and mouse handlers (main.js) ask
// isAgentInput(wc) and so only count what the user did. The events are delivered synchronously, which is what
// makes this safe.
const agentDepth = new WeakMap();
function agentInput(wc, fn) {
  agentDepth.set(wc, (agentDepth.get(wc) || 0) + 1);
  try { return fn(); } finally {
    const left = (agentDepth.get(wc) || 1) - 1;
    if (left > 0) agentDepth.set(wc, left); else agentDepth.delete(wc);
  }
}
const isAgentInput = (wc) => (agentDepth.get(wc) || 0) > 0;
// The same for input sent over the tab's debugger (Input.dispatchMouseEvent): the page view may report such an event to
// before-mouse-event, where the awaited command is the window: the browser process sees the event while it dispatches it to the
// page, which is before the page's acknowledgement that resolves the command, so the flag is up for exactly the events the AI
// sent. No grace period after it by default: a fixed delay would also swallow a real click the user makes right then (`graceMs`
// exists only for a caller that knows it needs one). Counted, so overlapping calls never close each other's window.
async function agentInputAsync(wc, fn, graceMs = 0) {
  agentDepth.set(wc, (agentDepth.get(wc) || 0) + 1);
  try { return await fn(); } finally {
    const release = () => {
      const left = (agentDepth.get(wc) || 1) - 1;
      if (left > 0) agentDepth.set(wc, left); else agentDepth.delete(wc);
    };
    if (graceMs > 0) setTimeout(release, graceMs).unref?.(); else release();
  }
}

// Is a tab on screen for the user? It is the front tab of ITS OWN window (not just the main window's), and that window is not
// minimized. Only such a tab takes the ordinary mouse path; any other gets the background click / DOM click.
const tabInFront = ({ activeId, tabId, minimized = false } = {}) => tabId != null && activeId === tabId && !minimized;

// Did an input the AI sent reach the page? `landed()` reads the page's own record of it (one-shot listener, see page-scripts
// clickProbeArm): polled until it says yes or `timeoutMs` pass. A read that throws (the page navigated away, which a click
// does) counts as landed: the click happened. Input events reach a renderer asynchronously, and a view that is not painting
// yet (a window just torn off, minimized or hidden) can drop them without any error, so the sender cannot trust "no throw".
async function confirmLanded(landed, { timeoutMs = 400, stepMs = 25, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try { if (await landed()) return true; } catch { return true; }
    if (Date.now() >= end) return false;
    await sleep(stepMs);
  }
}

// When the user last pressed a key / clicked in each page ('typed': keys only).
const typed = new WeakMap();
const touched = new WeakMap();
const userInput = {
  key(wc, now = Date.now()) { if (!isAgentInput(wc)) { typed.set(wc, now); touched.set(wc, now); } },
  click(wc, now = Date.now()) { if (!isAgentInput(wc)) touched.set(wc, now); },
  typedAt: (wc) => typed.get(wc) || 0,
  inputAt: (wc) => touched.get(wc) || 0,
};

module.exports = {
  TYPING_GRACE_MS, TYPING_WAIT_CAP_MS, FOCUS_RECENT_MS, CLOSE_SETTINGS, ACTION_TOOLS, HANDS_OFF_PROMPT,
  markOpened, handOver, isAiTab, takenOver, closeSelection, cleanCloseSetting, closeAfterRun,
  isAutomationRead, automationVerdict, isActionTool, handsOffRefusal, handsOffCheck, typingWait, guardsFocus, showsTab,
  agentInput, agentInputAsync, isAgentInput, userInput, tabInFront, confirmLanded,
};
