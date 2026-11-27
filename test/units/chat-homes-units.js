// ai/chat-homes.js: a deleted chat's CLI-engine homes (Antigravity's, Codex's) all go, and the homes of chats that are gone are all
// pruned, through the one list of engines main.js calls. Plain Node, temp folders only.
require('../helpers/_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${detail}`}`); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-chathomes-'));

const homes = require('../../src/ai/chat-homes');
const ag = require('../../src/ai/antigravity');
const cx = require('../../src/ai/codex');

const make = (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'x.txt'), 'x'); return dir; };

(async () => {
  const userData = path.join(tmp, 'userData');
  const engines = [['Antigravity', ag], ['Codex', cx]];
  for (const id of ['a', 'b', 'c', 'chat with spaces']) for (const [, e] of engines) make(e.chatHomeFor(userData, id));

  await homes.removeChatHomes(userData, 'a');
  for (const [name, e] of engines) check(`remove: the deleted chat's ${name} home is gone`, !fs.existsSync(e.chatHomeFor(userData, 'a')));
  for (const [name, e] of engines) check(`remove: other chats' ${name} homes stay`, fs.existsSync(e.chatHomeFor(userData, 'b')) && fs.existsSync(e.chatHomeFor(userData, 'chat with spaces')));
  check('remove: no chat id removes nothing', (await homes.removeChatHomes(userData, '')).every((r) => r === false) && fs.existsSync(ag.chatHomeFor(userData, 'b')));

  const pruned = await homes.pruneChatHomes(userData, new Set(['b', 'chat with spaces']));
  for (const [name, e] of engines) check(`prune: a ${name} home of a chat that is gone is removed`, !fs.existsSync(e.chatHomeFor(userData, 'c')));
  for (const [name, e] of engines) check(`prune: ${name} homes of kept chats stay (a hashed key too)`, fs.existsSync(e.chatHomeFor(userData, 'b')) && fs.existsSync(e.chatHomeFor(userData, 'chat with spaces')));
  check('prune: each engine says what it removed', pruned.length === 2 && pruned.every((g) => JSON.stringify(g) === JSON.stringify(['c'])), JSON.stringify(pruned));
  check('prune: no engine folder yet is not an error', JSON.stringify(await homes.pruneChatHomes(path.join(tmp, 'empty'), new Set(['b']))) === '[[],[]]');

  const mainSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
  check('main.js names no CLI engine for chat homes: it calls ai/chat-homes.js', !/\.(removeChatHome|pruneChatHomes)\(/.test(mainSrc.replace(/require\('\.\/ai\/chat-homes'\)\.(removeChatHomes|pruneChatHomes)\(/g, '')) && (mainSrc.match(/require\('\.\/ai\/chat-homes'\)\.removeChatHomes\(/g) || []).length === 2 && (mainSrc.match(/require\('\.\/ai\/chat-homes'\)\.pruneChatHomes\(/g) || []).length === 1);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nAll chat-home checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
