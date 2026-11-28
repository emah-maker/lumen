// [ask options] ask_user: when the AI needs an answer it cannot find (the profile, the page, memory), it asks with a card of clickable
// answers instead of a numbered list in prose. One to four questions, each with 2-6 short options, an "Other" box, and optionally
// several picks. The card (renderer/ask-card.js) sends the picks back as the tool's result, so the run goes on without a new message;
// a card whose run has ended (stopped, or the wait ran out) sends them as the user's next message instead.
// Pure and shared: agent.js validates the input and words the result with it; main.js keeps a reply's cards with it (merge, saved);
// the renderer (a plain script, no require) draws and checks answers with it.
{
  const LIMITS = { questions: 4, minOptions: 2, maxOptions: 6, question: 300, option: 80, detail: 160, header: 40, other: 500 };
  // How long a card holds the run: past it the tool returns "no answer yet" and the card stays clickable (its pick becomes the next
  // message). Under Codex's 600 s MCP tool timeout, so a CLI engine never sees the call fail.
  const WAIT_MS = 8 * 60 * 1000;

  const ASK_TOOL = {
    name: 'ask_user',
    description: 'Ask the user something you cannot find yourself (not on the page, in their profile, memory or files): they get a card with clickable answers and an Other box, and their pick comes back as this tool\'s result. Use it instead of writing questions as a list in your reply. Give 2-6 short, likely options per question, built from what you know (e.g. graduation months from the profile\'s school dates); put the likeliest first. Up to 4 questions in one call.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: LIMITS.questions,
          description: 'The questions, 1 to 4.',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The question, one short sentence.' },
              header: { type: 'string', description: 'Optional: a 1-3 word label for the question, e.g. "Graduation".' },
              options: {
                type: 'array',
                minItems: LIMITS.minOptions,
                maxItems: LIMITS.maxOptions,
                description: '2-6 answers to click, each a few words. The card adds an Other box itself.',
                items: { type: 'string' },
              },
              multi_select: { type: 'boolean', description: 'true when more than one answer can apply.' },
            },
            required: ['question', 'options'],
          },
        },
      },
      required: ['questions'],
    },
  };

  const clean = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

  // An ask_user input -> { questions: [{ question, header, options: [{ label, description }], multi }] } or { error } (written for the model).
  function validateAsk(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'ask_user takes { questions: [{ question, options }] }.' };
    let list = input.questions;
    if (!Array.isArray(list) && typeof input.question === 'string') list = [input]; // (a model that sent one question flat)
    if (!Array.isArray(list) || !list.length) return { error: 'questions must be a list of 1 to 4 questions.' };
    if (list.length > LIMITS.questions) return { error: `Ask at most ${LIMITS.questions} questions at once; ask the most important first.` };
    const questions = [];
    for (const [i, q] of list.entries()) {
      if (!q || typeof q !== 'object') return { error: `questions[${i}] must be an object with question and options.` };
      const question = clean(q.question, LIMITS.question);
      if (!question) return { error: `questions[${i}] has no question text.` };
      const raw = Array.isArray(q.options) ? q.options : [];
      const options = [];
      for (const o of raw) {
        const label = clean(typeof o === 'string' ? o : o?.label, LIMITS.option);
        if (!label || options.some((x) => x.label.toLowerCase() === label.toLowerCase())) continue;
        if (/^other\b/i.test(label) && label.length < 12) continue; // (the card has its own Other box)
        const description = typeof o === 'object' ? clean(o?.description, LIMITS.detail) : '';
        options.push({ label, ...(description ? { description } : {}) });
      }
      if (options.length < LIMITS.minOptions) return { error: `questions[${i}] needs at least ${LIMITS.minOptions} different options (the card adds Other itself).` };
      if (options.length > LIMITS.maxOptions) return { error: `questions[${i}] has more than ${LIMITS.maxOptions} options; keep the likeliest.` };
      const header = clean(q.header, LIMITS.header);
      questions.push({ question, ...(header ? { header } : {}), options, multi: q.multi_select === true || q.multiSelect === true });
    }
    return { questions };
  }

  // The card's answers, checked against its questions: [[label, ...] per question] (an Other text is a label of its own). null when
  // a question has no answer.
  function checkAnswers(questions, answers) {
    if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) return null;
    const out = [];
    for (const [i, q] of questions.entries()) {
      const picked = (Array.isArray(answers[i]) ? answers[i] : [answers[i]]).map((a) => clean(a, LIMITS.other)).filter(Boolean);
      const unique = [...new Set(picked)];
      if (!unique.length || (!q.multi && unique.length > 1)) return null;
      out.push(unique.slice(0, LIMITS.maxOptions + 1));
    }
    return out;
  }

  // What the model reads back (and, for a card whose run has ended, what the user's message says).
  function answerText(questions, answers, { message = false } = {}) {
    const lines = questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.question} → ${(answers[i] || []).join(', ')}`);
    return message ? lines.join('\n') : `The user answered:\n${lines.join('\n')}\nGo on with the task using these answers.`;
  }

  // A reply's cards, kept with it ({ id, questions, answers? }) and read back from a saved chat: only known fields, bounded.
  function savedAsks(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const a of raw.slice(0, 8)) {
      if (!a || typeof a !== 'object') continue;
      const v = validateAsk({ questions: a.questions?.map((q) => ({ ...q, multi_select: q?.multi === true || q?.multi_select === true })) });
      if (!v.questions) continue;
      const answers = a.answers ? checkAnswers(v.questions, a.answers) : null;
      out.push({ id: clean(String(a.id ?? ''), 40) || String(out.length + 1), questions: v.questions, ...(answers ? { answers } : {}) });
    }
    return out.length ? out : null;
  }

  // One 'ask' / 'ask_done' event into a reply's list of cards (main.js trackRunDetails).
  function merge(list, event) {
    const asks = Array.isArray(list) ? list : [];
    if (event?.type === 'ask' && Array.isArray(event.questions) && asks.length < 8 && !asks.some((a) => a.id === event.askId)) asks.push({ id: event.askId, questions: event.questions });
    if (event?.type === 'ask_done' && Array.isArray(event.answers)) { const a = asks.find((x) => x.id === event.askId); if (a) a.answers = event.answers; }
    return asks;
  }

  const askApi = { LIMITS, WAIT_MS, ASK_TOOL, validateAsk, checkAnswers, answerText, savedAsks, merge };
  if (typeof module !== 'undefined' && module.exports) module.exports = askApi;
  else globalThis.askUser = askApi; // (the renderer: globalThis is the window)
}
