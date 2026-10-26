// upload_file's chooser route (agent.js setFilesByChooser / chooserClick, page-scripts.js fileHook*), plain Node: how the clicks are made (a real
// press, else a script click with a user gesture), the page hook that catches an <input type=file> the page click()s without ever adding it to the
// document, the file chooser answer, and the error text that says which route failed and why. A real page: test/e2e/drive-upload.js.
require('../helpers/_tmp-cleanup');
const vm = require('vm');
const { Agent } = require('../../src/ai/agent');
const scripts = require('../../src/ai/page-scripts');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;

// ---- the hook, run against a stand-in page (a vm context with the few globals it touches)
function pageWith({ picker = true } = {}) {
  const sandbox = { Symbol, Object, Promise, DOMException: class extends Error { constructor(m, name) { super(m); this.name = name; } } };
  class HTMLElement { click() { this.clicked = (this.clicked || 0) + 1; } }
  class HTMLInputElement extends HTMLElement {
    constructor(type, attrs = {}) { super(); this.type = type; this.attrs = attrs; this.multiple = Boolean(attrs.multiple); this.disabled = false; }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    hasAttribute(n) { return n in this.attrs; }
    showPicker() { this.shown = true; }
  }
  sandbox.HTMLInputElement = HTMLInputElement;
  sandbox.window = sandbox;
  if (picker) sandbox.showOpenFilePicker = () => Promise.resolve(['handle']);
  vm.createContext(sandbox);
  return { sandbox, HTMLInputElement, HTMLElement, run: (code) => vm.runInContext(code, sandbox) };
}

(async () => {
  // ---- the hook
  {
    const page = pageWith();
    const nativePicker = page.sandbox.showOpenFilePicker;
    check('the hook scripts are valid page code', ['fileHookInstall', 'fileHookRead', 'fileHookInput', 'fileHookRemove', 'domPress'].every((n) => { try { new Function(`return ${n === 'domPress' ? scripts.domPress(1) : scripts[n]()}`); return true; } catch { return false; } }));
    check('before it is installed, nothing is recorded (read: null)', page.run(scripts.fileHookRead()) === null);
    check('it installs', page.run(scripts.fileHookInstall()) === true && page.run(scripts.fileHookInstall()) === true);
    const detached = new page.HTMLInputElement('file', { accept: '.docx', multiple: true });
    detached.click();
    const text = new page.HTMLInputElement('text');
    text.click();
    let seen = page.run(scripts.fileHookRead());
    check('a click() on a file input that is not in any document is recorded, and still runs', seen.calls === 1 && seen.input.accept === '.docx' && seen.input.multiple === true && detached.clicked === 1, J(seen));
    check('a click() on a text input is not recorded', text.clicked === 1 && seen.calls === 1);
    check('the recorded input is handed back as an object', page.run(scripts.fileHookInput()) === detached);
    const second = new page.HTMLInputElement('file');
    second.showPicker();
    seen = page.run(scripts.fileHookRead());
    check('showPicker() is recorded too, and the newest input wins', seen.calls === 2 && page.run(scripts.fileHookInput()) === second && second.shown === true, J(seen));
    const aborted = await page.run('window.showOpenFilePicker()').then(() => null, (e) => e);
    check('showOpenFilePicker is refused with an AbortError (no native dialog opens unattended) and counted', aborted && aborted.name === 'AbortError' && page.run(scripts.fileHookRead()).picker === 1, aborted && aborted.name);
    check('it removes itself: the page\'s own functions are back', page.run(scripts.fileHookRemove()) === true
      && page.sandbox.showOpenFilePicker === nativePicker && !Object.prototype.hasOwnProperty.call(page.HTMLInputElement.prototype, 'click') && page.HTMLInputElement.prototype.click === page.HTMLElement.prototype.click
      && page.run(scripts.fileHookRead()) === null);
    const after = new page.HTMLInputElement('file');
    after.click();
    check('after removal nothing is recorded', page.run(scripts.fileHookRead()) === null && after.clicked === 1);
    const bare = pageWith({ picker: false });
    check('a page without showOpenFilePicker installs and removes cleanly', bare.run(scripts.fileHookInstall()) === true && bare.run(scripts.fileHookRemove()) === true);
  }

  // ---- setFilesByChooser against a stand-in tab
  const file = (name) => ({ name, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 11000, path: `C:\\files\\${name}` });
  const docs = [file('A.docx'), file('B.docx')];
  const paths = docs.map((f) => f.path);
  const rig = ({ chooser = null, hook = null, clickFails = 0, aborted = false } = {}) => {
    const calls = [];
    const listeners = new Set();
    const clicks = [];
    const dbg = {
      on: (_e, fn) => listeners.add(fn), removeListener: (_e, fn) => listeners.delete(fn),
      sendCommand: async (method, params) => {
        calls.push([method, params]);
        if (method === 'Runtime.evaluate') {
          const e = params.expression;
          if (e === scripts.fileHookInstall()) return { result: { value: true } };
          if (e === scripts.fileHookRead()) return { result: { value: hook } };
          if (e === scripts.fileHookInput()) return { result: { objectId: 'detached-1' } };
          if (e === scripts.fileHookRemove()) return { result: { value: true } };
        }
        if (method === 'DOM.describeNode') return { node: { attributes: ['type', 'file', 'accept', '.docx'] } };
        return {};
      },
    };
    const wc = { debugger: dbg };
    const self = {
      signalAborted: () => aborted,
      async chooserClick(_wc, step) {
        if (clicks.length < clickFails) { clicks.push('fail'); throw new Error('no such menu item'); }
        clicks.push(step.text || `#${step.element_id}`);
        if (chooser) setTimeout(() => listeners.forEach((fn) => fn(null, 'Page.fileChooserOpened', chooser)), 20);
        return 'a real mouse click';
      },
    };
    return { calls, clicks, wc, self, run: (id, open) => Agent.prototype.setFilesByChooser.call(self, wc, id, docs, paths, open) };
  };
  const sent = (r, method) => r.calls.filter(([m]) => m === method);
  {
    const r = rig({ chooser: { backendNodeId: 9, mode: 'selectMultiple' } });
    const how = await r.run(undefined, ['New', 'File upload']);
    const set = sent(r, 'DOM.setFileInputFiles')[0]?.[1];
    check('the menu steps are clicked in order and the chooser the page opens is answered with the files', J(r.clicks) === J(['New', 'File upload']) && set?.backendNodeId === 9 && J(set.files) === J(paths) && /file chooser/.test(how), `${J(r.clicks)} ${J(set)} ${how}`);
    check('interception and the hook are switched off again', J(sent(r, 'Page.setInterceptFileChooserDialog').map(([, p]) => p.enabled)) === J([true, false]) && sent(r, 'Runtime.evaluate').some(([, p]) => p.expression === scripts.fileHookRemove()));
  }
  {
    const r = rig({ hook: { calls: 1, picker: 0, input: { accept: '', multiple: true, disabled: false, directory: false } } });
    const how = await r.run(7, []);
    const set = sent(r, 'DOM.setFileInputFiles')[0]?.[1];
    check('no chooser, but the page click()ed a file input outside its document: that input gets the files', set?.objectId === 'detached-1' && J(set.files) === J(paths) && /never put in its document/.test(how), `${J(set)} ${how}`);
    check('its remote object is released', sent(r, 'Runtime.releaseObject').some(([, p]) => p.objectId === 'detached-1'));
  }
  {
    const r = rig({ hook: { calls: 1, picker: 0, input: { accept: '.pdf', multiple: true, disabled: false, directory: false } } });
    const err = await r.run(7, []).then(() => null, (e) => e);
    check('the field the page opened still refuses files it does not accept, before anything is set', /a type this field accepts/.test(err?.message || '') && sent(r, 'DOM.setFileInputFiles').length === 0, err?.message);
    const dis = rig({ hook: { calls: 1, picker: 0, input: { accept: '', multiple: true, disabled: true, directory: false } } });
    check('a disabled field it opened is refused', /disabled/.test((await dis.run(7, []).then(() => '', (e) => e.message))));
  }
  {
    const r = rig({ hook: { calls: 0, picker: 0, input: null } });
    const err = await r.run(7, []).then(() => null, (e) => e);
    check('nothing opened: the error says what was clicked, how, and that the page asked for no file field', err?.noChooser === true && /Clicked element 7 \(a real mouse click\)/.test(err.message) && /never asked a file field to open/.test(err.message) && sent(r, 'DOM.setFileInputFiles').length === 0, err?.message);
    check('and the hook is removed even then', sent(r, 'Runtime.evaluate').some(([, p]) => p.expression === scripts.fileHookRemove()) && sent(r, 'Page.setInterceptFileChooserDialog').at(-1)[1].enabled === false);
  }
  {
    const r = rig({ hook: { calls: 0, picker: 1, input: null } });
    const err = await r.run(7, []).then(() => null, (e) => e);
    check('a page that used showOpenFilePicker is named as such', err?.noChooser === true && /showOpenFilePicker/.test(err.message) && /File System Access/.test(err.message), err?.message);
  }
  {
    const r = rig({ clickFails: 9 });
    const err = await r.run(undefined, ['New', 'Nope']).then(() => null, (e) => e);
    check('a step that cannot be clicked says which, and that nothing was uploaded (not a "no chooser" error)', /Could not click .New./.test(err?.message || '') && /Nothing was uploaded/.test(err.message) && !err.noChooser && r.clicks.length === 3, `${err?.message} ${J(r.clicks)}`);
  }

  // ---- the error of the whole route list
  {
    const self = {
      signalAborted: () => false,
      setFilesByChooser: async () => { const e = new Error('Clicked "File upload" (a real mouse click), but the page opened no file chooser within 6 s.'); e.noChooser = true; throw e; },
      setFilesOnAnyInput: async () => false,
      dropFiles: async () => '',
    };
    const err = await Agent.prototype.setFilesAnyWay.call(self, {}, undefined, ['New', 'File upload'], docs, paths).then(() => null, (e) => e);
    check('when every route fails, the error lists each one with its reason', /Route 1, the page's own file chooser: Clicked "File upload"/.test(err?.message || '') && /Route 2, a file field anywhere/.test(err.message) && /Route 3, dropping/.test(err.message) && /Nothing was uploaded/.test(err.message), err?.message);
    const noClick = await Agent.prototype.setFilesAnyWay.call(self, {}, undefined, [], docs, paths).then(() => null, (e) => e);
    check('with nothing to click, route 1 says so', /not tried/.test(noClick?.message || ''), noClick?.message);
    self.setFilesByChooser = async () => { throw new Error('Could not click "New" to reach the file chooser: x Nothing was uploaded.'); };
    const stopped = await Agent.prototype.setFilesAnyWay.call(self, {}, undefined, ['New'], docs, paths).then(() => null, (e) => e);
    check('a failed click is reported as it is, with no drop attempted after it', /Could not click .New./.test(stopped?.message || '') && !/Route 3/.test(stopped.message), stopped?.message);
  }

  // ---- chooserClick: which kind of click
  {
    const mk = (target, { held = true, gestureOk = true } = {}) => {
      const log = [];
      const self = {
        resolveTarget: async (_wc, text) => { log.push(`resolve ${text}`); return 5; },
        locateElement: async () => target,
        backgroundClick: async (_wc, x, y) => { log.push(`press ${x},${y}`); return held; },
        elementRun: async (_wc, id, make, opts) => { log.push(`script ${make === scripts.domPress ? 'domPress' : 'other'} gesture=${Boolean(opts?.userGesture)}`); return gestureOk; },
      };
      return { log, self };
    };
    let t = mk({ x: 10, y: 20, covered: false, frame: null });
    let how = await Agent.prototype.chooserClick.call(t.self, {}, { text: 'File upload' });
    check('an element in plain view is pressed with a real mouse click, no script click', J(t.log) === J(['resolve File upload', 'press 10,20']) && /real mouse click/.test(how), J(t.log));
    t = mk({ x: 10, y: 20, covered: true, frame: null });
    how = await Agent.prototype.chooserClick.call(t.self, {}, { element_id: 4 });
    check('an element something covers gets the page\'s events with a user gesture (a real press would hit the cover)', J(t.log) === J(['script domPress gesture=true']) && /user gesture/.test(how) && /covers/.test(how), J(t.log));
    t = mk({ x: 10, y: 20, covered: false, frame: null }, { held: false });
    how = await Agent.prototype.chooserClick.call(t.self, {}, { element_id: 4 });
    check('a real press that never reached the page falls back to the same gesture click', J(t.log) === J(['press 10,20', 'script domPress gesture=true']) && /did not reach/.test(how), J(t.log));
    t = mk(null);
    const gone = await Agent.prototype.chooserClick.call(t.self, {}, { element_id: 4 }).then(() => null, (e) => e);
    check('an id the page no longer has is said to need a fresh read', /No element with id 4/.test(gone?.message || ''), gone?.message);
    const press = scripts.domPress(3);
    check('the gesture click sends pointer and mouse events before click()', /pointerdown/.test(press) && /mouseup/.test(press) && /el\.click\(\)/.test(press));
  }

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
