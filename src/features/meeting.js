// ---------- Meeting Helper (Cluely-style meeting co-pilot) ----------
// Helps during and after web meetings with real-time live prompting, on-device context
// (agenda, resume, notes), active tab screen awareness, live audio transcript capture,
// stealth screen-sharing protection (setContentProtection), and post-meeting summarization
// saved to the sidebar chat store.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHANNELS = [
  'meeting:state',
  'meeting:context-get',
  'meeting:context-save',
  'meeting:prompt',
  'meeting:live-start',
  'meeting:live-stop',
  'meeting:transcript-chunk',
  'meeting:stealth',
  'meeting:summarize',
  'meeting:save-chat',
];

const DEFAULT_CONTEXT = {
  agenda: '',
  resume: '',
  notes: '',
};

const SYSTEM_PROMPT = `You are an executive meeting assistant and real-time conversation co-pilot.
Your goal is to help the user succeed during an active call by providing concise, high-value answers and talking points.
- Be direct, succinct, and factual. Use bullet points where appropriate.
- Never include filler, meta-announcements, or generic apologies.
- Tailor answers using the provided meeting agenda, the user's resume/background, and current conversation context.
- If what was asked is ambiguous, provide the most relevant concrete answer based on the context.`;

const SUMMARIZE_PROMPT = `You are an expert executive scribe. Summarize the following meeting transcript into clean, structured Markdown:
1. Executive Summary (2-3 concise sentences)
2. Key Discussion Topics & Decisions
3. Action Items & Next Steps (with owners if mentioned)
4. Open Questions & Follow-ups`;

function createMeetingHelper({
  userDataDir = '',
  getActiveTab = () => null,
  readPageContext = async () => '',
  complete = null,
  getChatStore = () => null,
  getWindow = () => null,
  broadcast = () => {},
  now = () => Date.now(),
} = {}) {
  const contextFile = userDataDir ? path.join(userDataDir, 'meeting-context.json') : '';

  let cachedContext = null;
  let isLive = false;
  let isStealth = false;
  const transcript = [];
  const MAX_TRANSCRIPT_ENTRIES = 500;
  let recentPrompt = '';
  let recentAnswer = '';

  function loadContext() {
    if (cachedContext) return cachedContext;
    if (!contextFile) return { ...DEFAULT_CONTEXT };
    try {
      if (fs.existsSync(contextFile)) {
        const raw = fs.readFileSync(contextFile, 'utf8');
        const parsed = JSON.parse(raw);
        cachedContext = {
          agenda: typeof parsed.agenda === 'string' ? parsed.agenda.slice(0, 50000) : '',
          resume: typeof parsed.resume === 'string' ? parsed.resume.slice(0, 50000) : '',
          notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 50000) : '',
        };
        return cachedContext;
      }
    } catch (err) {
      console.error('[meeting] failed to load meeting context:', err.message);
    }
    cachedContext = { ...DEFAULT_CONTEXT };
    return cachedContext;
  }

  function saveContext(patch = {}) {
    const current = loadContext();
    const updated = {
      agenda: typeof patch.agenda === 'string' ? patch.agenda.slice(0, 50000) : current.agenda,
      resume: typeof patch.resume === 'string' ? patch.resume.slice(0, 50000) : current.resume,
      notes: typeof patch.notes === 'string' ? patch.notes.slice(0, 50000) : current.notes,
    };
    cachedContext = updated;
    if (contextFile) {
      try {
        fs.mkdirSync(path.dirname(contextFile), { recursive: true });
        const tmp = `${contextFile}.tmp-${Date.now()}`;
        fs.writeFileSync(tmp, JSON.stringify(updated, null, 2), 'utf8');
        fs.renameSync(tmp, contextFile);
      } catch (err) {
        console.error('[meeting] failed to save meeting context:', err.message);
      }
    }
    broadcast('meeting:event', { type: 'context', context: updated });
    return updated;
  }

  function getState() {
    return {
      live: isLive,
      stealth: isStealth,
      context: loadContext(),
      transcript: transcript.slice(-100),
      recentPrompt,
      recentAnswer,
    };
  }

  function setStealth(enabled) {
    isStealth = Boolean(enabled);
    const win = getWindow();
    if (win && !win.isDestroyed()) {
      try {
        win.setContentProtection(isStealth);
      } catch (err) {
        console.error('[meeting] setContentProtection error:', err.message);
      }
    }
    broadcast('meeting:event', { type: 'stealth', value: isStealth });
    return { ok: true, stealth: isStealth };
  }

  function setLive(enabled) {
    isLive = Boolean(enabled);
    broadcast('meeting:event', { type: 'live', value: isLive });
    return { ok: true, live: isLive };
  }

  function addTranscriptChunk(text, speaker = 'Speaker') {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false };
    const chunk = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      speaker: String(speaker || 'Speaker').slice(0, 50),
      text: clean.slice(0, 2000),
      time: now(),
    };
    transcript.push(chunk);
    if (transcript.length > MAX_TRANSCRIPT_ENTRIES) {
      transcript.splice(0, transcript.length - MAX_TRANSCRIPT_ENTRIES);
    }
    broadcast('meeting:event', { type: 'transcript', chunk });
    return { ok: true, chunk };
  }

  function clearTranscript() {
    transcript.length = 0;
    broadcast('meeting:event', { type: 'transcript-cleared' });
    return { ok: true };
  }

  function buildPromptContent({ question, includeScreen = false, screenText = '' }) {
    const ctx = loadContext();
    const blocks = [];

    if (ctx.agenda.trim()) {
      blocks.push(`<meeting_agenda>\n${ctx.agenda.trim()}\n</meeting_agenda>`);
    }
    if (ctx.resume.trim()) {
      blocks.push(`<user_background>\n${ctx.resume.trim()}\n</user_background>`);
    }
    if (ctx.notes.trim()) {
      blocks.push(`<meeting_notes>\n${ctx.notes.trim()}\n</meeting_notes>`);
    }

    if (transcript.length > 0) {
      const recent = transcript.slice(-15).map((t) => `${t.speaker}: ${t.text}`).join('\n');
      blocks.push(`<recent_transcript>\n${recent}\n</recent_transcript>`);
    }

    if (includeScreen && screenText.trim()) {
      blocks.push(`<active_screen_or_slides>\n${screenText.trim().slice(0, 10000)}\n</active_screen_or_slides>`);
    }

    blocks.push(`Question or prompt: ${String(question || '').trim()}`);
    return blocks.join('\n\n');
  }

  async function prompt(question, { includeScreen = false } = {}) {
    const cleanQ = String(question || '').trim();
    if (!cleanQ) return { ok: false, error: 'empty question' };

    let screenText = '';
    if (includeScreen) {
      try {
        const tab = getActiveTab();
        if (tab) {
          screenText = await readPageContext(tab);
        }
      } catch (err) {
        console.error('[meeting] error reading screen context:', err.message);
      }
    }

    const userMessage = buildPromptContent({ question: cleanQ, includeScreen, screenText });

    if (typeof complete !== 'function') {
      return { ok: false, error: 'no AI engine configured' };
    }

    recentPrompt = cleanQ;
    try {
      const result = await complete({
        system: SYSTEM_PROMPT,
        user: userMessage,
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string', description: 'Concise, high-value response or talking points for the user' },
            talking_points: { type: 'array', items: { type: 'string' }, description: '2-4 quick bullet points to say or note' },
          },
          required: ['answer'],
        },
      });

      const answer = typeof result === 'string' ? result : (result.answer || JSON.stringify(result));
      recentAnswer = answer;
      broadcast('meeting:event', { type: 'prompt-result', prompt: cleanQ, answer });
      return { ok: true, answer, talkingPoints: result.talking_points || [] };
    } catch (err) {
      console.error('[meeting] prompt failure:', err.message);
      return { ok: false, error: err.message };
    }
  }

  async function summarize(customText = '') {
    const textToSummarize = String(customText || '').trim() ||
      transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n');

    if (!textToSummarize) {
      return { ok: false, error: 'No transcript or text to summarize.' };
    }

    if (typeof complete !== 'function') {
      return { ok: false, error: 'no AI engine configured' };
    }

    try {
      const result = await complete({
        system: SUMMARIZE_PROMPT,
        user: `Please summarize this meeting:\n\n${textToSummarize.slice(0, 60000)}`,
        schema: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Complete markdown summary of the meeting' },
            action_items: { type: 'array', items: { type: 'string' }, description: 'List of action items' },
            key_decisions: { type: 'array', items: { type: 'string' }, description: 'Key decisions made' },
          },
          required: ['summary'],
        },
      });

      const summary = typeof result === 'string' ? result : (result.summary || JSON.stringify(result));
      return { ok: true, summary, actionItems: result.action_items || [], decisions: result.key_decisions || [] };
    } catch (err) {
      console.error('[meeting] summarize failure:', err.message);
      return { ok: false, error: err.message };
    }
  }

  function saveToChat({ title = '', summary = '', transcriptText = '', agenda = '' } = {}) {
    const store = getChatStore();
    if (!store) return { ok: false, error: 'chat store not available' };

    const chatTitle = String(title || '').trim() || `Meeting: ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
    const fullTranscript = transcriptText.trim() || transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    const ctx = loadContext();
    const meetingAgenda = agenda || ctx.agenda;

    const userText = `Meeting Notes & Transcript: ${chatTitle}${meetingAgenda ? `\n\nAgenda:\n${meetingAgenda}` : ''}`;
    const assistantText = `${summary || 'Meeting completed.'}\n\n---\n### Full Meeting Transcript\n${fullTranscript || '(No transcript recorded)'}`;

    const id = crypto.randomBytes(8).toString('hex');
    const snapshot = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: userText }] },
        { role: 'assistant', content: [{ type: 'text', text: assistantText }] },
      ],
      settings: {
        title: chatTitle,
        renamed: true,
        model: 'meeting-helper',
      },
      updated: now(),
    };

    try {
      if (typeof store.save === 'function') {
        store.save(id, snapshot);
      } else if (typeof store.writeAtomic === 'function' && userDataDir) {
        // direct fallback
        const dir = path.join(userDataDir, 'chats');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(snapshot, null, 2));
      }
      return { ok: true, chatId: id, title: chatTitle };
    } catch (err) {
      console.error('[meeting] failed to save meeting to chat store:', err.message);
      return { ok: false, error: err.message };
    }
  }

  return {
    CHANNELS,
    getState,
    loadContext,
    saveContext,
    setStealth,
    setLive,
    addTranscriptChunk,
    clearTranscript,
    prompt,
    summarize,
    saveToChat,
    buildPromptContent,
  };
}

module.exports = {
  createMeetingHelper,
  CHANNELS,
  DEFAULT_CONTEXT,
  SYSTEM_PROMPT,
  SUMMARIZE_PROMPT,
};
