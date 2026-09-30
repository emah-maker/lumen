// The MCP bridge's stable address. Agents are set up to run `<Lumen> <app>/mcp.js` in Node mode (the
// README, Settings → You and AI → Copy command), and those saved configs must keep working across
// updates, so this file stays at the app's root while the bridge itself lives in src/automation/mcp.js.
require('./src/automation/mcp').relay();
