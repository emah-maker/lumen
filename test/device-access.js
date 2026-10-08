// [device access] In a real window: drag (a pointer-events slider and an HTML5 drag-and-drop list) and trackpad pinch-to-zoom
// (a synthesized pinch magnifies the page: visualViewport.scale > 1, the layout keeps its width). The file and clipboard
// rules are test/device-access-units.js.
const { _electron: electron } = require('playwright-core');
const http = require('http');
const path = require('path');

const PAGE = `<!doctype html><title>Drag</title><style>body{margin:0;font:16px sans-serif}#track{position:absolute;left:20px;top:40px;width:300px;height:20px;background:#ddd}
#knob{position:absolute;left:0;top:0;width:20px;height:20px;background:#333;touch-action:none}
li{width:200px;height:40px;margin:4px;background:#cde;list-style:none}#out{position:absolute;top:400px}</style>
<div id=track><button id=knob aria-label="Knob"></button></div>
<ul style="position:absolute;top:120px"><li draggable=true id=a>Alpha</li><li draggable=true id=b>Beta</li><li id=zone>Drop here</li></ul>
<p id=out></p><p id=w></p>
<script>
const knob=document.getElementById('knob');let down=false;
knob.addEventListener('pointerdown',e=>{down=true;knob.setPointerCapture(e.pointerId)});
knob.addEventListener('pointermove',e=>{if(down)knob.style.left=Math.max(0,Math.min(280,e.clientX-20-10))+'px'});
knob.addEventListener('pointerup',()=>{down=false;document.title='slid:'+parseInt(knob.style.left)});
document.getElementById('a').addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','Alpha'));
const zone=document.getElementById('zone');
zone.addEventListener('dragover',e=>e.preventDefault());
zone.addEventListener('drop',e=>{e.preventDefault();document.title='dropped:'+e.dataTransfer.getData('text/plain')});
</script>`;

(async () => {
  const server = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(PAGE); }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const app = await electron.launch({ args: [path.join(__dirname, '..')], env: { ...process.env, CLAUDE_BROWSER_TEST: '1' } });
  const ui = await app.firstWindow();
  await ui.waitForSelector('.tab');
  const run = (name, input) => app.evaluate(async (_e, [n, i]) => {
    try { const r = await global.__agent.execute(n, i); return typeof r === 'string' ? r : JSON.stringify(r).slice(0, 200); } catch (err) { return 'ERROR: ' + err.message; }
  }, [name, input]);
  const title = () => app.evaluate(() => global.__agent.browser.activeTab().webContents.getTitle());
  const inPage = (code) => app.evaluate((_e, c) => global.__agent.browser.activeTab().webContents.executeJavaScript(c), code);
  let failures = 0;
  const check = (label, ok, detail) => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 300)}`}`); };

  try {
    await run('navigate', { url });
    const page = await run('read_page', { elements: true });
    const elements = JSON.parse(page.split('\n')[1]).elements;
    const id = (label) => elements.find((e) => e.label === label || e.text === label)?.id;
    check('the page reads', id('Knob'), JSON.stringify(elements).slice(0, 300));

    // a slider: knob at x 30 (page), drag to x 230
    let r = await run('drag', { from_id: id('Knob'), to_x: 0, to_y: 0 });
    check('drag by screenshot point without a screenshot says to take one', /screenshot/i.test(r), r);
    await run('screenshot', {});
    const ratio = await app.evaluate(() => global.__agent.screenshotScale?.ratio || 1);
    r = await run('drag', { from_id: id('Knob'), to_x: 240 / ratio, to_y: 50 / ratio });
    const slid = await title();
    check('drag moves a pointer-events slider', /^slid:(19\d|2[0-2]\d)$/.test(slid) && /held/.test(r), `${slid} | ${r}`);

    // HTML5 drag-and-drop: Alpha onto the drop zone
    const dropFrom = await inPage("(()=>{const r=document.getElementById('a').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()");
    const dropTo = await inPage("(()=>{const r=document.getElementById('zone').getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()");
    r = await run('drag', { from_x: dropFrom[0] / ratio, from_y: dropFrom[1] / ratio, to_x: dropTo[0] / ratio, to_y: dropTo[1] / ratio });
    check('drag does an HTML5 drag-and-drop with its data', (await title()) === 'dropped:Alpha' && /drag-and-drop/.test(r), `${await title()} | ${r}`);

    // pinch: a synthesized trackpad pinch magnifies the page in place
    const before = await inPage('[visualViewport.scale, document.documentElement.clientWidth]');
    await app.evaluate(async () => {
      const wc = global.__agent.browser.activeTab().webContents;
      const dbg = wc.debugger;
      const mine = !dbg.isAttached();
      if (mine) dbg.attach('1.3');
      try { await dbg.sendCommand('Input.synthesizePinchGesture', { x: 150, y: 150, scaleFactor: 2, gestureSourceType: 'touch' }); } finally { if (mine) dbg.detach(); }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await inPage('[visualViewport.scale, document.documentElement.clientWidth]');
    check('a pinch magnifies the page (visual zoom), the layout width stays', after[0] > 1.2 && after[1] === before[1], JSON.stringify([before, after]));
    await run('navigate', { url: `${url}?again` });
    await app.evaluate(async () => {
      const wc = global.__agent.browser.activeTab().webContents;
      const dbg = wc.debugger; const mine = !dbg.isAttached(); if (mine) dbg.attach('1.3');
      try { await dbg.sendCommand('Input.synthesizePinchGesture', { x: 150, y: 150, scaleFactor: 2, gestureSourceType: 'touch' }); } finally { if (mine) dbg.detach(); }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const again = await inPage('visualViewport.scale');
    check('pinch still works after a navigation', again > 1.2, again);
  } finally {
    await app.close().catch(() => {});
    server.close();
  }
  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
