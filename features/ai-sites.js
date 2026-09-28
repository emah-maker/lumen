// "Turn off AI on this site": sites where neither the sidebar's AI nor an outside agent (MCP) may
// read or act. A site is the registrable domain (mail.example.com and www.example.com are both
// example.com), so one switch covers a whole bank or email provider.
// agent.js enforces it (see Agent.aiOffCheck): before every tool call, after one (the tab may have
// moved there), for the page attached to a message, and in list_tabs. main.js keeps those tabs out
// of "Organize Tabs with AI". Stored as settings.json aiOffSites.
const { registrableDomain } = require('../tab-groups');

// The site of a web address, or '' for anything that isn't http(s).
function siteOf(url) {
  let parsed;
  try { parsed = new URL(String(url)); } catch { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return registrableDomain(parsed.href) || parsed.hostname.toLowerCase();
}

// "example.com", "https://mail.example.com/inbox" -> "example.com".
function siteFromInput(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return siteOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}/`);
}

function createAiSites({ readSettings, writeSettings, onChange = () => {} }) {
  const list = () => {
    const saved = readSettings().aiOffSites;
    return Array.isArray(saved) ? saved.filter((s) => typeof s === 'string' && s) : [];
  };
  const isOff = (url) => {
    const site = siteOf(url);
    return Boolean(site) && list().includes(site);
  };
  function set(value, off) {
    const site = siteFromInput(value);
    if (!site) return list();
    const next = list().filter((s) => s !== site);
    if (off) next.push(site);
    next.sort();
    writeSettings({ ...readSettings(), aiOffSites: next });
    onChange(site, Boolean(off));
    return next;
  }
  // settings:* channels answer the browser UI and the Settings tab only (main.js IPC gate); page
  // content and the AI's tools have no way to reach them.
  function register(ipcMain) {
    ipcMain.handle('settings:ai-sites', () => list());
    ipcMain.handle('settings:ai-site-state', (_e, url) => ({ site: siteOf(url), off: isOff(url) }));
    ipcMain.handle('settings:set-ai-site', (_e, value, off) => set(value, Boolean(off)));
  }
  return { list, isOff, set, register };
}

module.exports = { createAiSites, siteOf, siteFromInput };
