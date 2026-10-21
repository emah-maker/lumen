// Quick notes (plain Node: no Electron, no network): the notepad store (ai/notes.js), what the panel and the Add buttons ask main to do
// (features/notes-hub.js) and the AI's `notes` tool.
//   - create / edit / list / search, newest first, a title from the first line
//   - saved to one file with an atomic write; a new store on the same file sees everything (restart); a damaged file is set aside, never overwritten
//   - an add to the end of a note while the editor has it open is kept next to the editor's own typing
//   - append goes to the open note (or starts one); delete can be undone
//   - pictures are kept by content and removed when no note mentions them
//   - the hub quotes page text with its source, accepts only a whole <svg>, and never links a non-web address
//   - the AI's tool reads and adds, cannot edit or delete, and is not in the lists outside agents see
const fs = require('fs');
const os = require('os');
const path = require('path');
const notes = require('../../src/ai/notes');
const hubLib = require('../../src/features/notes-hub');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-notes-units-'));
const file = path.join(dir, 'notes.json');
let clock = 1000;
const mk = () => notes.createNotesStore({ file, now: () => ++clock });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake png body')]);

// ---- create, edit, list
let store = mk();
check('a new notepad is empty', store.count() === 0 && store.list().length === 0);
const a = store.create('# Biology\n\nCells have **membranes**.');
const b = store.create('Shopping: milk, eggs');
check('a note has an id, its text and a title from the first line', /^[a-f0-9]{8}$/.test(a.id) && a.title === 'Biology' && b.title === 'Shopping: milk, eggs', JSON.stringify([a.title, b.title]));
check('the list is newest first', store.list()[0].id === b.id && store.list()[1].id === a.id);
store.update(a.id, '# Biology\n\nCells have membranes and a nucleus.');
check('editing moves a note to the top and keeps its text', store.list()[0].id === a.id && store.get(a.id).text.includes('nucleus'));
check('control characters are dropped and line ends are one kind', store.update(b.id, 'x\r\ny\u0000z').note.text === 'x\nyz');
check('an unknown id is not found', store.get('00000000') === null && store.update('00000000', 'x') === null && store.remove('00000000') === null);

// ---- search
check('search needs every word, in any order, ignoring case', store.list('NUCLEUS cells').map((r) => r.id).join() === a.id && store.list('nucleus milk').length === 0);
check('a search result shows the words in context', /nucleus/.test(store.list('nucleus')[0].preview), store.list('nucleus')[0].preview);
check('an empty search lists everything', store.list('  ').length === 2);

// ---- persistence: a new store on the same file (an app restart) sees the same notes
store = mk();
check('notes survive a restart', store.count() === 2 && store.get(a.id).text.includes('nucleus') && store.current()?.id === b.id, String(store.count()));
check('no temporary file is left behind', fs.readdirSync(dir).every((f) => !f.endsWith('.tmp')), fs.readdirSync(dir).join());
check('the file is plain JSON', JSON.parse(fs.readFileSync(file, 'utf8')).notes.length === 2);

// ---- a change at the end while the editor has the note open is kept
const base = store.get(a.id).text;
store.append(a.id, 'Added by the AI');
const r = store.update(a.id, `${base}\nand typed by me`, base);
check('text added meanwhile is kept next to the editor\'s typing', r.merged && r.note.text.includes('typed by me') && r.note.text.includes('Added by the AI'), r.note.text);
check('an editor that did not change anything keeps what was added', store.update(a.id, store.get(a.id).text, store.get(a.id).text).merged === false);
const r2 = store.update(b.id, 'replaced', 'something else entirely');
check('when the stored text is not simply longer, the editor wins', r2.note.text === 'replaced' && !r2.merged);
check('mergeAppended: no base means a plain save', notes.mergeAppended(undefined, 'new', 'old').text === 'new');

// ---- append and the open note
store.select(a.id);
const ap = store.append(null, 'Second line from a page');
check('append with no id goes to the open note, after a blank line', !ap.created && ap.note.id === a.id && /\n\nSecond line from a page$/.test(ap.note.text));
store.remove(a.id);
const fresh = store.append(null, 'Orphan text');
check('append with no open note starts a new one', fresh.created && store.count() === 2 && fresh.note.text === 'Orphan text');
let threw = false; try { store.append(null, '   '); } catch { threw = true; }
check('adding nothing is refused', threw);
threw = false; try { store.append('00000000', 'x'); } catch { threw = true; }
check('adding to a note that is gone is refused', threw);
check('a very long add is cut', store.append(fresh.note.id, 'y'.repeat(notes.MAX_APPEND + 5000)).note.text.length <= notes.MAX_TEXT);

// ---- delete and undo
const gone = store.remove(fresh.note.id);
check('delete removes the note', gone && store.get(fresh.note.id) === null);
check('undo puts it back as it was', store.restore(gone) && store.get(fresh.note.id).text === gone.text);
check('restoring twice does nothing', store.restore(gone) === false);

// ---- a damaged file is set aside, never written over
fs.writeFileSync(file, '{ this is not json');
store = mk();
check('a damaged file gives an empty notepad', store.count() === 0);
check('the damaged file is kept as .bad-…', fs.readdirSync(dir).some((f) => f.startsWith('notes.json.bad-')) && !fs.existsSync(file));
store.create('after the damage');
check('the notepad works again afterwards', mk().count() === 1);
fs.writeFileSync(file, JSON.stringify({ v: 1, notes: [{ id: 'zzzz', text: 'bad id' }, { id: 'abcdef01', text: 'good' }, { id: 'abcdef01', text: 'duplicate' }, { id: 'abcdef02', text: 5 }] }));
check('entries with a bad id, a duplicate id or no text are skipped', mk().count() === 1 && mk().get('abcdef01').text === 'good');

// ---- pictures
store = mk();
const pic = store.addImage(PNG, 'A [cell]\ndiagram');
check('a picture is stored by its content', /^[a-f0-9]{16}\.png$/.test(pic.name) && pic.markdown === `![A  cell  diagram](note-image:${pic.name})`, pic.markdown);
check('the same picture is stored once', store.addImage(PNG, 'again').name === pic.name && fs.readdirSync(path.join(dir, 'notes-media')).length === 1);
check('its bytes come back with the type', store.image(pic.name).bytes.equals(PNG) && store.image(pic.name).type === 'image/png');
check('a name that is not one of ours is refused', store.image('../notes.json') === null && store.image('x.png') === null);
threw = false; try { store.addImage(Buffer.from('not an image at all'), ''); } catch { threw = true; }
check('something that is not a picture is refused', threw);
const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
const orphan = path.join(dir, 'notes-media', '0123456789abcdef.png');
fs.writeFileSync(orphan, PNG);
fs.utimesSync(orphan, old, old);
const kept = store.append(null, pic.markdown).note;
const swept = mk();
check('a picture no note mentions is removed once it is a day old', swept.sweep() === 1 && !fs.existsSync(orphan) && fs.existsSync(path.join(dir, 'notes-media', pic.name)));
check('a picture a note mentions stays', mk().image(pic.name) !== null && kept.text.includes(pic.name));

// ---- the hub
let pushes = 0;
const hubStore = notes.createNotesStore({ file: path.join(dir, 'hub-notes.json'), now: () => ++clock });
const hub = hubLib.create({ store: hubStore, push: () => { pushes++; }, imageBytes: (id) => (id === 'gen~1' ? { buffer: PNG, mime: 'image/png' } : null) });
const q = hub.act('add-selection', { text: 'Mitochondria make ATP.\nThey have two membranes.', title: 'Cell [biology]', url: 'https://example.com/cells_(1)' });
check('a page selection is added as a quotation with its source', q.ok && q.created && pushes === 1);
const text1 = hubStore.get(q.id).text;
check('the quotation names the page and links it', text1.startsWith('> Mitochondria make ATP.\n> They') && text1.includes('> from [Cell  biology](https://example.com/cells_%281%29)'), text1);
const noLink = hub.act('add-selection', { text: 'x', title: 'T', url: 'javascript:alert(1)' });
check('an address that is not http(s) is not linked', !/\]\(/.test(hubStore.get(noLink.id).text.split('\n\n').pop()), hubStore.get(noLink.id).text);
check('an empty selection is refused', hub.act('add-selection', { text: '  ' }).ok === false);
check('add-svg takes a whole svg and wraps it as a diagram', hub.act('add-svg', { svg: '<svg viewBox="0 0 10 10"><circle r="3"/></svg>' }).ok && /```svg\n<svg[\s\S]*<\/svg>\n```$/.test(hubStore.get(noLink.id).text));
check('add-svg refuses anything else', !hub.act('add-svg', { svg: '<div>hi</div>' }).ok && !hub.act('add-svg', { svg: '<svg></svg><script>x</script>x' }).ok && !hub.act('add-svg', { svg: `<svg>${'a'.repeat(210 * 1024)}</svg>` }).ok);
const gi = hub.act('add-image', { id: 'gen~1', alt: 'Cell' });
check('a generated picture is copied into the notepad', gi.ok && /note-image:[a-f0-9]{16}\.png/.test(hubStore.get(gi.id).text));
check('a picture that is gone is refused', hub.act('add-image', { id: 'gen~2' }).ok === false);
const name = /note-image:([a-f0-9]{16}\.png)/.exec(hubStore.get(gi.id).text)[1];
check('the panel can load a picture as a data URL', /^data:image\/png;base64,/.test(hub.act('image', { name }).url) && hub.act('image', { name: '../x' }).ok === false);
const n1 = hub.act('new', { text: 'First' }).note;
const saved = hub.act('save', { id: n1.id, text: 'First, edited', base: 'First' });
check('save through the hub returns the note', saved.ok && saved.note.text === 'First, edited');
const del = hub.act('delete', { id: n1.id });
check('delete gives an undo token that works once', del.ok && hub.act('undo', { token: del.token }).ok && !hub.act('undo', { token: del.token }).ok);
check('an unknown operation is refused', hub.act('format-disk', {}).ok === false);
check('every change tells the windows', pushes >= 8, String(pushes));

// ---- the AI's tool
const tool = (input) => notes.runTool(input, { store: hubStore, changed: () => { pushes++; } });
const before = hubStore.count();
const listed = tool({ action: 'list' });
check('list gives ids and titles', listed.total === hubStore.count() && listed.notes.every((x) => x.id && 'title' in x));
check('search finds a note by its words', tool({ action: 'search', query: 'mitochondria' }).notes.length === 1);
check('read returns the text', tool({ action: 'read', id: q.id }).text.includes('Mitochondria'));
check('read with no id and no open note says so', (() => { hubStore.select(null); try { tool({ action: 'read' }); return false; } catch (e) { return /No note is open/.test(e.message); } })());
const c = tool({ action: 'create', text: 'From the AI' });
check('create makes a note', c.ok && c.created && hubStore.count() === before + 1);
const ap2 = tool({ action: 'append', id: c.id, text: 'more' });
check('append adds to the end and never replaces', ap2.ok && hubStore.get(c.id).text === 'From the AI\n\nmore');
let unknown = '';
for (const action of ['update', 'delete', 'replace', 'remove']) { try { tool({ action, id: c.id, text: 'x' }); } catch (e) { unknown += action; } }
check('the tool has no way to edit or delete', unknown === 'updatedeletereplaceremove' && hubStore.get(c.id).text === 'From the AI\n\nmore');
check('append without text is refused', (() => { try { tool({ action: 'append', id: c.id }); return false; } catch { return true; } })());
const longText = 'z'.repeat(30000);
tool({ action: 'append', id: c.id, text: longText });
check('a long note is cut when read', tool({ action: 'read', id: c.id }).text.length < 20100);
check('steps read plainly', notes.stepLabel({ action: 'append' }) === 'Adding to your notes' && notes.stepLabel({}) === 'Using your notes');

// ---- the tool in the agent's lists
const agent = require('../../src/ai/agent');
check('the notes tool description stays short', agent.NOTES_TOOL.description.length <= 200, String(agent.NOTES_TOOL.description.length));
const offered = (...texts) => agent.Agent.prototype.notesOffered.call({}, texts.map((t) => (typeof t === 'string' ? { role: 'user', content: t } : t)));
check('the tool is not in the default request (the tool list is paid for every time)', !agent.requestFor({ model: agent.DEFAULT_MODEL }, [{ role: 'user', content: 'hi' }]).tools.some((t) => t.name === 'notes'));
check('it is offered when the request says notes', agent.requestFor({ model: agent.DEFAULT_MODEL }, [{ role: 'user', content: 'x' }], undefined, { notes: true }).tools.some((t) => t.name === 'notes'));
check('it is offered when the user talks about their notes', offered('What did I write in my notes about the lab?') && offered('add this to my notes') && offered('Save that in the notepad') && offered('put a summary into notes') && offered('check the notes on photosynthesis'));
check('it is not offered for the word note in other uses', !offered('note that the page is slow') && !offered('Please take note of the deadline') && !offered('a footnote, then the keynote speech'));
check('it stays offered in a chat that already used it', offered('thanks', { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'notes', input: { action: 'list' } }] }, 'and now something else'));
check('the notes tool is not offered to MCP clients or CLI engines', !agent.EXTERNAL_TOOLS.some((t) => t.name === 'notes'));
check('the notes tool schema names its actions', JSON.stringify(agent.NOTES_TOOL.input_schema.properties.action.enum) === JSON.stringify(['list', 'search', 'read', 'append', 'create']));

const agentSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ai', 'agent.js'), 'utf8');
check('wiring: the tool runs through notesTool, is tab-free and has a step label', agentSrc.includes("case 'notes': return this.notesTool(input)") && /TAB_FREE_TOOLS = new Set\([^)]*'notes'/.test(agentSrc) && agentSrc.includes("if (name === 'notes') return require('./notes').stepLabel"));
check('wiring: the tool is refused to outside agents', agentSrc.includes("scope.gate?.external) throw new Error('Unknown tool: notes')"));

fs.rmSync(dir, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
