// Google Sheets through the shared Google sign-in (connectors/google-auth.js), with the Sheets API v4 at sheets.googleapis.com.
// Reads: a spreadsheet's tabs, and a range of cells. Writes (each asks the user on a card first): add rows to the end of a tab, and make
// a new spreadsheet. Rows are sent as plain text (valueInputOption RAW), never as formulas: a page or an email can't plant =IMAGE(...)
// or =IMPORTDATA(...) in the user's sheet through the AI.
'use strict';
const { flat, clip, ConnectorError } = require('../util');
const G = require('./_google');

const MAX_ROWS = 200;
const MAX_COLS = 50;
const MAX_CELL = 1000;
const DEFAULT_RANGE = 'A1:Z100';

// The id out of what the AI was given: the bare id, or a docs.google.com/spreadsheets/d/<id>/... address.
const idOf = (v) => (/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(String(v)) || /^([A-Za-z0-9_-]+)/.exec(String(v)) || [])[1] || '';
const path = (id) => `/spreadsheets/${encodeURIComponent(idOf(id))}`;

// "a | b | c" per line (or tab-separated) -> [['a','b','c']]. Throws a ConnectorError for the AI when it is too big or empty.
function parseRows(text) {
  const rows = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim() !== '').map((line) => (line.includes('\t') ? line.split('\t') : line.split('|')).map((c) => c.trim()));
  if (!rows.length) throw new ConnectorError('rows is empty: give one row per line, cells separated by |. Nothing was added.', 'args');
  if (rows.length > MAX_ROWS) throw new ConnectorError(`At most ${MAX_ROWS} rows at a time. Nothing was added.`, 'args');
  for (const r of rows) {
    if (r.length > MAX_COLS) throw new ConnectorError(`At most ${MAX_COLS} cells in a row. Nothing was added.`, 'args');
    if (r.some((c) => c.length > MAX_CELL)) throw new ConnectorError(`A cell is longer than ${MAX_CELL} characters. Nothing was added.`, 'args');
  }
  return rows;
}

async function verify(ctx) {
  return { status: 200, account: ctx.email }; // (the sign-in itself says who it is; Sheets has no request that asks nothing of any sheet)
}

const actions = {
  async tabs(ctx, { id }) {
    const b = G.json(ctx, await ctx.http(path(id), { query: { fields: 'properties.title,sheets.properties(title,gridProperties(rowCount,columnCount))' } }), { thing: 'that spreadsheet' });
    const tabs = (Array.isArray(b.sheets) ? b.sheets : []).map((s) => `- ${flat(s.properties?.title, 100)} (${Number(s.properties?.gridProperties?.rowCount) || 0} rows × ${Number(s.properties?.gridProperties?.columnCount) || 0} columns)`);
    return `${flat(b.properties?.title, 200)}\n${tabs.join('\n') || 'No tabs.'}`;
  },

  async read(ctx, { id, range = DEFAULT_RANGE }) {
    const b = G.json(ctx, await ctx.http(`${path(id)}/values/${encodeURIComponent(range)}`, { query: { majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' } }), { thing: 'that spreadsheet or range' });
    const rows = Array.isArray(b.values) ? b.values.slice(0, MAX_ROWS) : [];
    if (!rows.length) return `${flat(b.range, 120)}: no values.`;
    const more = Array.isArray(b.values) && b.values.length > MAX_ROWS ? `\n[… ${b.values.length - MAX_ROWS} more rows left out: read a smaller range]` : '';
    return `${flat(b.range, 120)}\n${clip(rows.map((r) => (Array.isArray(r) ? r : []).map((c) => flat(String(c), 200)).join('\t')).join('\n'), 12000)}${more}`;
  },

  async append(ctx, { id, rows, range = 'A1' }) {
    const values = parseRows(rows);
    let res;
    try { res = await ctx.http(`${path(id)}/values/${encodeURIComponent(range)}:append`, { method: 'POST', query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }, json: { majorDimension: 'ROWS', values } }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('rows', 'the sheet');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('rows', 'the sheet');
    const b = G.json(ctx, res, { thing: 'that spreadsheet or tab' });
    const n = Number(b.updates?.updatedRows) || values.length;
    return { text: `Added ${n} row${n === 1 ? '' : 's'} to ${flat(b.updates?.updatedRange, 120) || 'the sheet'}.`, link: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(idOf(id))}/edit`, done: `Added ${n} row${n === 1 ? '' : 's'}` };
  },

  async create(ctx, { title }) {
    let res;
    try { res = await ctx.http('/spreadsheets', { method: 'POST', json: { properties: { title: flat(title, 200) } } }); } catch (err) {
      if (err instanceof ConnectorError && err.kind === 'other' && !/Stopped\./.test(err.message)) throw G.maybe('spreadsheet', 'Drive');
      throw err;
    }
    if (res.status >= 500 || res.status === 408) throw G.maybe('spreadsheet', 'Drive');
    const b = G.json(ctx, res, { thing: 'Sheets' });
    const url = /^https:\/\/docs\.google\.com\//.test(String(b.spreadsheetUrl)) ? String(b.spreadsheetUrl) : '';
    return { text: `Made the spreadsheet “${flat(b.properties?.title, 200)}” (id ${flat(b.spreadsheetId, 100)}).`, link: url, done: `Made “${flat(b.properties?.title, 60)}”` };
  },
};

// A write that can't happen says so before any card (rows too big or empty).
async function beforeCard(ctx, action, args) {
  if (action === 'append') parseRows(args.rows);
}
async function cardNames(ctx, action, args) {
  if (action !== 'append') return {};
  const b = G.json(ctx, await ctx.http(path(args.id), { query: { fields: 'properties.title' } }), { thing: 'that spreadsheet' });
  return { sheet: flat(b.properties?.title, 120) };
}
function describeWhere(action, args, names = {}) {
  if (action === 'append') return `Adds the rows below after the last row of ${args.range ? `the tab “${args.range}” in ` : 'the first tab of '}${names.sheet ? `“${names.sheet}”` : `the spreadsheet ${idOf(args.id)}`} in your Google Sheets. They go in as plain text, not formulas.`;
  if (action === 'create') return 'Makes a new empty spreadsheet in your Google Drive.';
  return '';
}
function describeWrite(action, args, names = {}) {
  if (action === 'append') return `${describeWhere(action, args, names)}\n\n${args.rows}`;
  if (action === 'create') return `${describeWhere(action, args, names)}\n\nTitle: ${args.title}`;
  return '';
}

module.exports = { verify, actions, beforeCard, cardNames, describeWrite, describeWhere };
