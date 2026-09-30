// View Source (features/page-tools.js): the main process calls lumenRender once with the page's
// source. It's shown as text only (textContent), one line per row, with line numbers.
const wrap = document.getElementById('wrap');
wrap.addEventListener('change', () => document.body.classList.toggle('wrap', wrap.checked));

window.lumenRender = (data) => {
  document.title = `Source of ${data.url}`;
  document.getElementById('where').textContent = data.url;
  const note = document.getElementById('note');
  if (data.error) { note.textContent = `Couldn't load the source: ${data.error}`; return; }
  const notes = [];
  if (data.status >= 400) notes.push(`The server answered ${data.status}.`);
  if (data.truncated) notes.push('This page is large; only the first 5 MB are shown.');
  note.textContent = notes.join(' ');
  const code = document.getElementById('code');
  const fragment = document.createDocumentFragment();
  for (const line of String(data.text || '').split(/\r\n|\r|\n/)) {
    const row = document.createElement('span');
    row.textContent = line;
    fragment.appendChild(row);
  }
  code.replaceChildren(fragment);
  document.body.dataset.ready = 'true';
};
