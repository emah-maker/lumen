// Settings for automation tools over CDP (Playwright, Playwright MCP). See automation.js.
(() => {
  const toggle = document.getElementById('automation-enabled');
  const details = document.getElementById('automation-details');
  const portInput = document.getElementById('automation-port');
  const status = document.getElementById('automation-status');
  if (!toggle || !window.assistant?.automationInfo) return;
  let running = null;

  function describe(enabled, port) {
    const endpoint = `http://127.0.0.1:${port}`;
    if (!enabled) status.textContent = running ? 'Turned off. The port is closed.' : '';
    else if (running?.error) status.textContent = running.error;
    else if (running?.listening && running.port === port) status.textContent = `Listening on ${endpoint}. Playwright: chromium.connectOverCDP('${endpoint}')`;
    else status.textContent = `Restart Lumen to open ${endpoint}.`;
  }

  async function render() {
    const info = await window.assistant.automationInfo();
    running = info.running;
    toggle.checked = info.enabled;
    portInput.value = String(info.port);
    details.hidden = !info.enabled;
    describe(info.enabled, info.port);
  }

  async function save() {
    const port = Number(portInput.value) || 9222;
    await window.assistant.setAutomation({ enabled: toggle.checked, port });
    details.hidden = !toggle.checked;
    describe(toggle.checked, port);
    if (!toggle.checked) running = null;
  }

  toggle.addEventListener('change', save);
  portInput.addEventListener('change', save);
  document.getElementById('mcp-section')?.addEventListener('toggle', render);
  render();
})();
