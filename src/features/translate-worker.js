// The on-device translator, running in its own process (an Electron utility process, or a plain Node
// child in the unit tests) so the wasm never blocks the UI or the main process. It runs Mozilla's
// Bergamot (src/vendor/bergamot) with a model set from translate-models.js.
//
// Protocol (messages from translate-local.js):
//   { type: 'translate', id, steps: [{ from, to, version, files: { model, lex, vocab | srcvocab + trgvocab } }], texts: [string] }
//       -> { type: 'result', id, texts: [string], loadMs, inferMs }   or   { type: 'error', id, message }
//   { type: 'cancel', id }   a queued request that has not started is answered with { type: 'cancelled', id }
//   { type: 'warm', id }     start the wasm now (answered with { type: 'ready', id, ms })
// One or two steps: two means a pivot through English (Bergamot's translateViaPivoting).
// Text only: every message is plain text in, plain text out; no HTML mode.
'use strict';
const fs = require('fs');
const path = require('path');

const link = process.parentPort
  ? { send: (m) => process.parentPort.postMessage(m), on: (cb) => process.parentPort.on('message', (e) => cb(e.data)) }
  : { send: (m) => process.send(m), on: (cb) => process.on('message', cb) };

const VENDOR = path.join(__dirname, '..', 'vendor', 'bergamot');
const ALIGNMENT = { model: 256, lex: 64, vocab: 64, srcvocab: 64, trgvocab: 64 };
const SOFT_HYPHEN = /­/g;
// The sentence splitter mishandles an opening curly quote right after full-width punctuation (Firefox's
// fix: a space between them). Only for the languages that use it.
const FULL_WIDTH_QUOTE = /([。！？])“/g;
const FULL_WIDTH_LANGS = new Set(['ja', 'ko', 'zh-Hans', 'zh-Hant']);

let bergamot = null;
let service = null;
let starting = null;
const models = new Map(); // `${from}>${to}@${version}` -> TranslationModel
const cancelled = new Set();
const queue = [];
let busy = false;

function startEngine() {
  if (starting) return starting;
  starting = new Promise((resolve, reject) => {
    const began = performance.now();
    try {
      const source = fs.readFileSync(path.join(VENDOR, 'bergamot-translator.js'), 'utf8');
      const loadBergamot = new Function(`${source}\nreturn loadBergamot;`)();
      const wasmBinary = fs.readFileSync(path.join(VENDOR, 'bergamot-translator.wasm'));
      const instance = loadBergamot({
        INITIAL_MEMORY: 41943040, // 40 MiB, then it grows: Firefox measured this uses less than guessing high
        print: () => {},
        printErr: () => {},
        onAbort() { reject(new Error('The translation engine could not start.')); },
        onRuntimeInitialized: async () => {
          await Promise.resolve(); // so `instance` is assigned
          bergamot = instance;
          service = new bergamot.BlockingService({ cacheSize: 0 });
          resolve(performance.now() - began);
        },
        wasmBinary,
      });
    } catch (err) { reject(err); }
  });
  starting.catch(() => { starting = null; });
  return starting;
}

const configText = (config) => {
  const indent = '            ';
  return `\n${Object.entries(config).map(([k, v]) => `${indent}${k}: ${v}\n`).join('')}${indent}`;
};

function loadModel(step) {
  const key = `${step.from}>${step.to}@${step.version}`;
  const known = models.get(key);
  if (known) return known;
  const memory = {};
  for (const type of Object.keys(ALIGNMENT)) {
    const file = step.files?.[type];
    if (!file) continue;
    const bytes = fs.readFileSync(file);
    const aligned = new bergamot.AlignedMemory(bytes.byteLength, ALIGNMENT[type]);
    aligned.getByteArrayView().set(bytes);
    memory[type] = aligned;
  }
  if (!memory.model || !memory.lex) throw new Error(`Incomplete model for ${step.from} to ${step.to}.`);
  const vocabs = new bergamot.AlignedMemoryList();
  if (memory.vocab) vocabs.push_back(memory.vocab);
  else if (memory.srcvocab && memory.trgvocab) { vocabs.push_back(memory.srcvocab); vocabs.push_back(memory.trgvocab); } else throw new Error(`No vocabulary for ${step.from} to ${step.to}.`);
  const config = configText({
    'beam-size': '1',
    normalize: '1.0',
    'word-penalty': '0',
    'max-length-break': '128',
    'mini-batch-words': '1024',
    workspace: '128',
    'max-length-factor': '2.0',
    'skip-cost': 'true', // no quality model
    'cpu-threads': '0',
    quiet: 'true',
    'quiet-translation': 'true',
    'gemm-precision': path.basename(step.files.model).endsWith('intgemm8.bin') ? 'int8shiftAll' : 'int8shiftAlphaAll',
    alignment: 'soft',
  });
  const model = new bergamot.TranslationModel(step.from, step.to, config, memory.model, memory.lex, vocabs, null);
  models.set(key, model);
  return model;
}

// One text node's text, as the engine wants it: whitespace runs collapse to one space (HTML does that
// when it draws them), soft hyphens go (they break tokenizing).
function clean(text, from) {
  let out = String(text).replace(SOFT_HYPHEN, '').replace(/\s+/g, ' ').trim();
  if (FULL_WIDTH_LANGS.has(from)) out = out.replace(FULL_WIDTH_QUOTE, '$1 “');
  return out;
}

async function translate({ steps, texts }) {
  const t0 = performance.now();
  if (!bergamot) await startEngine();
  const loaded = steps.map(loadModel);
  const loadMs = performance.now() - t0;
  const cleaned = texts.map((t) => clean(t, steps[0].from));
  const slots = [];
  const messages = new bergamot.VectorString();
  const options = new bergamot.VectorResponseOptions();
  const out = new Array(texts.length).fill('');
  try {
    cleaned.forEach((text, i) => {
      if (!text) return;
      slots.push(i);
      messages.push_back(text);
      options.push_back({ qualityScores: false, alignment: false, html: false });
    });
    if (slots.length) {
      const t1 = performance.now();
      const responses = loaded.length === 2
        ? service.translateViaPivoting(loaded[0], loaded[1], messages, options)
        : service.translate(loaded[0], messages, options);
      for (let k = 0; k < slots.length; k++) {
        const r = responses.get(k);
        out[slots[k]] = r.getTranslatedText();
        r.delete?.();
      }
      responses.delete?.();
      return { texts: out, loadMs, inferMs: performance.now() - t1 };
    }
    return { texts: out, loadMs, inferMs: 0 };
  } finally {
    messages.delete();
    options.delete();
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await new Promise((resolve) => setImmediate(resolve)); // let a pending 'cancel' message in first
      if (cancelled.delete(job.id)) { link.send({ type: 'cancelled', id: job.id }); continue; }
      try {
        if (job.type === 'warm') {
          const ms = bergamot ? 0 : await startEngine();
          link.send({ type: 'ready', id: job.id, ms });
        } else {
          const res = await translate(job);
          link.send({ type: 'result', id: job.id, ...res });
        }
      } catch (err) {
        link.send({ type: 'error', id: job.id, message: String(err?.message || err).slice(0, 300) });
      }
    }
  } finally { busy = false; }
}

link.on((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'cancel') { if (queue.some((j) => j.id === msg.id)) cancelled.add(msg.id); return; }
  if (msg.type === 'translate' || msg.type === 'warm') {
    queue.push(msg);
    pump();
  }
});
link.send({ type: 'hello' });
