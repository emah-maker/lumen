// "Always allow" for connector actions that only ADD something (a task, an event, a draft, a new page): the user may let one
// "<app>:<action>" skip its card for good. Pure and tiny so the rule can be checked without Electron.
//   - Only an action the registry marks `adds: true`, and never a send (Gmail send also has gated: true).
//   - Never in a chat that has read untrusted content (tainted): that one always asks, as MCP tools do.
//   - The list is settings.json connectorAlways: ["todoist:add_task", ...].
'use strict';

const KEY = /^[a-z0-9_]+:[a-z0-9_]+$/;

const keyOf = (app, action) => `${app}:${action}`;

// The registry's actions that only add things, as "<app>:<action>" keys.
function addsKeys(connectors) {
  const out = [];
  for (const def of connectors) for (const [name, a] of Object.entries(def.actions || {})) if (a.adds && a.write && !a.gated) out.push(keyOf(def.id, name));
  return out;
}

// What the card does for one write. `action` is the registry's action definition.
//   { offer }: show the Always button   { skip }: don't show a card at all
function alwaysDecision({ app, name, action, sending = false, tainted = false, list = [] }) {
  const eligible = Boolean(action?.adds && action.write && !action.gated) && !sending;
  return {
    offer: eligible && !tainted,
    skip: eligible && !tainted && Array.isArray(list) && list.includes(keyOf(app, name)),
  };
}

// settings.json value -> a clean list (plain "<app>:<action>" strings, no repeats, bounded).
const cleanList = (value) => (Array.isArray(value) ? [...new Set(value.filter((k) => typeof k === 'string' && k.length <= 100 && KEY.test(k)))].slice(0, 200) : null);

module.exports = { KEY, keyOf, addsKeys, alwaysDecision, cleanList };
