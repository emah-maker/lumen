// A picture that arrives after a reply already ended early (Claude Code's reply_complete comes at the end of the text; the
// pictures a CLI made with its own tools are found after that, in agent.js enginePictures) is drawn under that reply in the
// real app, instead of being dropped with the finished turn. Run: node test/late-picture.js (a throwaway profile).
require('./_tmp-cleanup'); // removes the temp folders this suite makes when it exits, pass or fail
const { _electron: electron } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-latepic-'));
  const app = await electron.launch({
    args: [path.join(__dirname, '..')],
    env: { ...process.env, CLAUDE_BROWSER_TEST: '1', CLAUDE_BROWSER_PROFILE: profile, LUMEN_TEST_BACKGROUND: '1', ANTHROPIC_API_KEY: 'sk-ant-test' },
  });
  const ui = await app.firstWindow();
  const errors = [];
  ui.on('pageerror', (e) => errors.push(e.message));
  await ui.waitForSelector('.tab');
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  const redPng = await app.evaluate(({ nativeImage }) => {
    const buf = Buffer.alloc(24 * 24 * 4);
    for (let i = 0; i < buf.length; i += 4) buf.set([0, 0, 255, 255], i);
    return nativeImage.createFromBitmap(buf, { width: 24, height: 24 }).toPNG().toString('base64');
  });

  // The run a Claude Code reply makes, in its order: the words, reply_complete (the screen shows the reply as finished), then the
  // picture found in the reply's file path, then 'done'.
  await app.evaluate((_e, { png }) => {
    const agent = global.__agent;
    agent.run = async (_text, emit, _valid, opts) => {
      emit({ type: 'text', text: 'Your tabby cat is ready: `C:\\tmp\\tabby.jpg`' });
      emit({ type: 'reply_complete' });
      await new Promise((r) => setTimeout(r, 300));
      const ref = agent.imageStore.save(opts?.meta?.chatId, Buffer.from(png, 'base64'), { alt: 'tabby.jpg' });
      emit({ type: 'image', id: ref.id, mime: ref.mime, alt: ref.alt, caption: 'tabby.jpg' });
      await new Promise((r) => setTimeout(r, 200));
      emit({ type: 'done', model: 'claudecode:auto' });
    };
  }, { png: redPng });

  await ui.evaluate(() => document.getElementById('toggle-sidebar').click());
  await ui.waitForTimeout(400);
  await ui.fill('#prompt', 'generate me a tabby cat');
  await ui.press('#prompt', 'Enter');
  await ui.waitForSelector('.msg.gen-pics .gen-img img', { timeout: 8000 }).catch(() => {});

  const got = await ui.evaluate(() => {
    const pic = document.querySelector('.msg.gen-pics');
    const img = pic?.querySelector('.gen-img img');
    const reply = [...document.querySelectorAll('.msg.assistant')].find((m) => /tabby cat is ready/.test(m.textContent));
    return {
      pics: document.querySelectorAll('.msg.gen-pics').length,
      decoded: Boolean(img && img.complete && img.naturalWidth === 24),
      caption: pic?.textContent || '',
      afterReply: Boolean(reply && pic && (reply.compareDocumentPosition(pic) & Node.DOCUMENT_POSITION_FOLLOWING)),
      composerFree: !document.getElementById('send').classList.contains('stop'),
    };
  });
  check('a picture sent after reply_complete is shown in the chat (one, decoded)', got.pics === 1 && got.decoded, JSON.stringify(got));
  check('it sits under the reply it belongs to, with the file name', got.afterReply && /tabby\.jpg/.test(got.caption), JSON.stringify(got));
  check('the composer is free (the reply stayed finished)', got.composerFree, JSON.stringify(got));
  check('no page errors', errors.length === 0, errors.join(' | '));

  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
