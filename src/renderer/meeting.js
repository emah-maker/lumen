// The sidebar's Meeting Helper panel (renderer/meeting.js).
// Provides live prompting (Mod+Enter), context management (resume, agenda, notes),
// active screen awareness, live audio transcript capture, stealth mode (setContentProtection),
// and post-meeting summarization saved to the chat store.

(() => {
  const api = window.assistant?.meeting;
  if (!api) return;

  const byId = (id) => document.getElementById(id);
  const button = byId('meeting-btn');
  const badge = byId('meeting-badge');
  const panel = byId('meeting-panel');
  if (!button || !panel) return;

  let state = {
    live: false,
    stealth: false,
    context: { agenda: '', resume: '', notes: '' },
    transcript: [],
    recentPrompt: '',
    recentAnswer: '',
  };

  let activeTab = 'qa'; // 'qa' | 'context' | 'transcript' | 'summary'
  let recognition = null;

  const h = (tag, props = {}, ...kids) => {
    const node = Object.assign(document.createElement(tag), props);
    for (const kid of kids.flat()) {
      if (kid !== null && kid !== undefined && kid !== false) {
        node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
      }
    }
    return node;
  };

  const SHIELD = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor"><path d="M8 2.5 13 4v4.5c0 3.2-2.3 5.3-5 6-2.7-.7-5-2.8-5-6V4l5-1.5z"/></svg>';
  const CLOSE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  // Build the panel DOM structure once
  panel.innerHTML = `
    <div class="mt-header">
      <div class="mt-top">
        <div class="mt-title">
          <span data-i18n="meeting.title">Meeting helper</span>
        </div>
        <div style="display: flex; gap: 6px; align-items: center;">
          <button type="button" class="mt-stealth-pill" id="mt-stealth-btn" title="Toggle invisible overlay mode (hidden from screen share)">
            ${SHIELD} <span id="mt-stealth-label">Stealth</span>
          </button>
          <button type="button" class="mt-live-pill" id="mt-live-btn" title="Toggle live audio listener">
            <span class="mt-pulse-dot"></span> <span id="mt-live-label">Listen</span>
          </button>
          <button type="button" class="icon-btn" id="mt-close-btn" title="Close meeting helper" style="width: 24px; height: 24px;">
            ${CLOSE}
          </button>
        </div>
      </div>
      <div class="mt-tabs" role="tablist">
        <button type="button" class="mt-tab active" data-tab="qa" role="tab">Live Q&A</button>
        <button type="button" class="mt-tab" data-tab="context" role="tab">Context</button>
        <button type="button" class="mt-tab" data-tab="transcript" role="tab">Transcript</button>
        <button type="button" class="mt-tab" data-tab="summary" role="tab">Summary</button>
      </div>
    </div>
    <div class="mt-body">
      <!-- Q&A View -->
      <div class="mt-view" id="mt-view-qa">
        <div class="mt-prompt-box">
          <div class="mt-prompt-input-row">
            <input type="text" class="mt-prompt-input" id="mt-prompt-input" placeholder="Type what was just asked (Mod+Enter)..." autocomplete="off" />
            <button type="button" class="btn" id="mt-prompt-send" style="padding: 0 12px; font-size: 12px;">Ask</button>
          </div>
          <div class="mt-prompt-opts">
            <label class="mt-checkbox-label">
              <input type="checkbox" id="mt-screen-check" />
              <span>Include active tab (slides/chat)</span>
            </label>
            <span id="mt-prompt-status"></span>
          </div>
        </div>
        <div id="mt-answers-container" style="display: flex; flex-direction: column; gap: 8px;"></div>
      </div>

      <!-- Context View -->
      <div class="mt-view" id="mt-view-context" hidden>
        <div class="mt-context-field">
          <label class="mt-context-label">Meeting Agenda & Goals</label>
          <span class="mt-context-desc">Topics to cover, goals, or anticipated questions.</span>
          <textarea class="mt-context-textarea" id="mt-ctx-agenda" rows="3" placeholder="e.g. Q4 system design review, migration timeline..."></textarea>
        </div>
        <div class="mt-context-field">
          <label class="mt-context-label">Resume & Background</label>
          <span class="mt-context-desc">Your background, past projects, key metrics to draw from.</span>
          <textarea class="mt-context-textarea" id="mt-ctx-resume" rows="3" placeholder="e.g. 8 years distributed systems, led Kafka migration..."></textarea>
        </div>
        <div class="mt-context-field">
          <label class="mt-context-label">Notes & Scratchpad</label>
          <span class="mt-context-desc">Scratchpad notes updated during the meeting.</span>
          <textarea class="mt-context-textarea" id="mt-ctx-notes" rows="3" placeholder="e.g. Mention 99.99% uptime target..."></textarea>
        </div>
        <div class="mt-save-status" id="mt-ctx-save-status"></div>
      </div>

      <!-- Transcript View -->
      <div class="mt-view" id="mt-view-transcript" hidden>
        <div class="mt-transcript-bar">
          <span class="mt-transcript-count" id="mt-transcript-count">0 items</span>
          <div style="display: flex; gap: 6px;">
            <input type="file" id="mt-transcript-file" accept=".txt,.vtt,.srt,.json" style="display: none;" />
            <button type="button" class="btn" id="mt-transcript-import" style="font-size: 11px; padding: 2px 8px;">Import</button>
            <button type="button" class="btn" id="mt-transcript-copy" style="font-size: 11px; padding: 2px 8px;">Copy</button>
            <button type="button" class="btn" id="mt-transcript-clear" style="font-size: 11px; padding: 2px 8px;">Clear</button>
          </div>
        </div>
        <ul class="mt-transcript-list" id="mt-transcript-list"></ul>
      </div>

      <!-- Summary View -->
      <div class="mt-view" id="mt-view-summary" hidden>
        <div class="mt-summary-actions" style="flex-direction: column; gap: 6px;">
          <textarea class="mt-context-textarea" id="mt-summary-custom" rows="2" placeholder="Optional: paste transcript or notes here (or leave blank to summarize captured session)..." style="font-size: 12px;"></textarea>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="btn" id="mt-summarize-btn" style="flex: 1; font-size: 12px;">Summarize Meeting</button>
            <button type="button" class="btn" id="mt-save-chat-btn" style="flex: 1; font-size: 12px;" disabled>Save as Chat</button>
          </div>
        </div>
        <div id="mt-summary-content" class="mt-summary-body" style="min-height: 120px;">Click 'Summarize Meeting' to generate executive summary and action items.</div>
      </div>
    </div>
  `;

  // Element handles
  const stealthBtn = byId('mt-stealth-btn');
  const stealthLabel = byId('mt-stealth-label');
  const liveBtn = byId('mt-live-btn');
  const liveLabel = byId('mt-live-label');
  const closeBtn = byId('mt-close-btn');
  const promptInput = byId('mt-prompt-input');
  const promptSend = byId('mt-prompt-send');
  const screenCheck = byId('mt-screen-check');
  const promptStatus = byId('mt-prompt-status');
  const answersContainer = byId('mt-answers-container');
  const ctxAgenda = byId('mt-ctx-agenda');
  const ctxResume = byId('mt-ctx-resume');
  const ctxNotes = byId('mt-ctx-notes');
  const ctxSaveStatus = byId('mt-ctx-save-status');
  const transcriptCount = byId('mt-transcript-count');
  const transcriptImport = byId('mt-transcript-import');
  const transcriptFileInput = byId('mt-transcript-file');
  const transcriptCopy = byId('mt-transcript-copy');
  const transcriptClear = byId('mt-transcript-clear');
  const transcriptList = byId('mt-transcript-list');
  const summaryCustom = byId('mt-summary-custom');
  const summarizeBtn = byId('mt-summarize-btn');
  const saveChatBtn = byId('mt-save-chat-btn');
  const summaryContent = byId('mt-summary-content');

  let currentSummary = '';

  // Tab switching
  panel.querySelectorAll('.mt-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      panel.querySelectorAll('.mt-tab').forEach((b) => b.classList.remove('active'));
      tabBtn.classList.add('active');
      activeTab = tabBtn.dataset.tab;
      ['qa', 'context', 'transcript', 'summary'].forEach((tabKey) => {
        const v = byId(`mt-view-${tabKey}`);
        if (v) v.hidden = tabKey !== activeTab;
      });
      if (activeTab === 'qa') promptInput?.focus();
      if (activeTab === 'transcript') renderTranscript();
    });
  });

  // Stealth toggle
  async function toggleStealth() {
    const next = !state.stealth;
    const res = await api.setStealth(next);
    if (res?.ok) {
      state.stealth = res.stealth;
      updateHeader();
    }
  }
  stealthBtn.onclick = toggleStealth;

  // Live listener toggle (Audio Capture & Speech Recognition)
  function initSpeechRecognition() {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) return null;
    const rec = new SpeechRec();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = 'en-US';
    rec.onresult = (evt) => {
      for (let i = evt.resultIndex; i < evt.results.length; ++i) {
        if (evt.results[i].isFinal) {
          const text = evt.results[i][0].transcript.trim();
          if (text) {
            api.sendTranscript(text, 'Participant');
          }
        }
      }
    };
    rec.onerror = (err) => {
      console.warn('[meeting] speech recognition error:', err.error);
    };
    rec.onend = () => {
      if (state.live) {
        try { rec.start(); } catch {}
      }
    };
    return rec;
  }

  async function toggleLive() {
    const next = !state.live;
    if (next) {
      if (!recognition) recognition = initSpeechRecognition();
      try {
        if (recognition) recognition.start();
      } catch (err) {
        console.warn('[meeting] could not start speech recognition:', err.message);
      }
      const res = await api.startLive();
      if (res?.ok) state.live = true;
    } else {
      try {
        if (recognition) recognition.stop();
      } catch {}
      const res = await api.stopLive();
      if (res?.ok) state.live = false;
    }
    updateHeader();
  }
  liveBtn.onclick = toggleLive;

  function updateHeader() {
    if (state.stealth) {
      stealthBtn.classList.add('active');
      stealthLabel.textContent = 'Stealth: ON';
    } else {
      stealthBtn.classList.remove('active');
      stealthLabel.textContent = 'Stealth';
    }

    if (state.live) {
      liveBtn.classList.add('active');
      liveLabel.textContent = 'Listening';
      if (badge) { badge.hidden = false; badge.textContent = '●'; }
    } else {
      liveBtn.classList.remove('active');
      liveLabel.textContent = 'Listen';
      if (badge) badge.hidden = true;
    }
  }

  // Ask prompt
  async function submitPrompt() {
    const text = promptInput.value.trim();
    if (!text) return;
    promptInput.value = '';
    promptStatus.textContent = 'Thinking...';
    promptSend.disabled = true;

    const includeScreen = Boolean(screenCheck.checked);
    const res = await api.prompt(text, { includeScreen });
    promptStatus.textContent = '';
    promptSend.disabled = false;

    if (res?.ok) {
      renderAnswerCard(text, res.answer, res.talkingPoints || []);
    } else {
      promptStatus.textContent = res?.error || 'Failed';
    }
  }
  promptSend.onclick = submitPrompt;
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitPrompt();
    }
  });

  function renderAnswerCard(question, answer, talkingPoints) {
    const card = h('div', { className: 'mt-answer-card' },
      h('div', { className: 'mt-answer-q', textContent: `Q: ${question}` }),
      h('div', { className: 'mt-answer-text', textContent: answer })
    );

    if (Array.isArray(talkingPoints) && talkingPoints.length > 0) {
      const tpRow = h('div', { className: 'mt-talking-points' });
      talkingPoints.forEach((tp) => {
        tpRow.append(h('span', { className: 'mt-tp-chip', textContent: tp }));
      });
      card.append(tpRow);
    }

    answersContainer.prepend(card);
  }

  // Context auto-save
  let saveTimer = null;
  function triggerSaveContext() {
    if (saveTimer) clearTimeout(saveTimer);
    ctxSaveStatus.textContent = 'Saving...';
    saveTimer = setTimeout(async () => {
      const patch = {
        agenda: ctxAgenda.value,
        resume: ctxResume.value,
        notes: ctxNotes.value,
      };
      await api.saveContext(patch);
      ctxSaveStatus.textContent = 'Saved';
      setTimeout(() => { ctxSaveStatus.textContent = ''; }, 2000);
    }, 400);
  }
  [ctxAgenda, ctxResume, ctxNotes].forEach((ta) => {
    ta.addEventListener('input', triggerSaveContext);
  });

  // Transcript view
  function renderTranscript() {
    transcriptCount.textContent = `${state.transcript.length} items`;
    transcriptList.innerHTML = '';
    state.transcript.forEach((chunk) => {
      const timeStr = new Date(chunk.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const li = h('li', { className: 'mt-transcript-item' },
        h('div', { className: 'mt-transcript-meta' },
          h('span', { textContent: chunk.speaker || 'Speaker' }),
          h('span', { textContent: timeStr })
        ),
        h('div', { className: 'mt-transcript-text', textContent: chunk.text })
      );
      transcriptList.append(li);
    });
    transcriptList.scrollTop = transcriptList.scrollHeight;
  }

  transcriptImport.onclick = () => transcriptFileInput?.click();
  transcriptFileInput.onchange = async () => {
    const file = transcriptFileInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/^(WEBVTT|[0-9]+$|[0-9]{2}:[0-9]{2})/.test(line)) continue;
        if (/-->/.test(line)) continue;
        let speaker = 'Participant';
        let content = line;
        const m = line.match(/^([^:]{1,30}):\s*(.+)$/);
        if (m) {
          speaker = m[1].trim();
          content = m[2].trim();
        }
        if (content) {
          await api.sendTranscript(content, speaker);
        }
      }
      const st = await api.getState();
      if (st) state = st;
      renderTranscript();
    } catch (err) {
      console.warn('[meeting] failed to import transcript file:', err.message);
    } finally {
      transcriptFileInput.value = '';
    }
  };

  transcriptCopy.onclick = () => {
    const text = state.transcript.map((t) => `${t.speaker}: ${t.text}`).join('\n');
    navigator.clipboard.writeText(text);
    transcriptCount.textContent = 'Copied!';
    setTimeout(renderTranscript, 1500);
  };

  transcriptClear.onclick = async () => {
    state.transcript = [];
    renderTranscript();
  };

  // Summary & Save to Chat
  summarizeBtn.onclick = async () => {
    summarizeBtn.disabled = true;
    summaryContent.textContent = 'Summarizing meeting transcript and notes...';
    const custom = summaryCustom?.value?.trim() || '';
    const res = await api.summarize(custom);
    summarizeBtn.disabled = false;
    if (res?.ok) {
      currentSummary = res.summary;
      summaryContent.textContent = currentSummary;
      saveChatBtn.disabled = false;
    } else {
      summaryContent.textContent = res?.error || 'Failed to summarize.';
    }
  };

  saveChatBtn.onclick = async () => {
    if (!currentSummary) return;
    saveChatBtn.disabled = true;
    const res = await api.saveToChat({
      summary: currentSummary,
    });
    if (res?.ok) {
      saveChatBtn.textContent = 'Saved to Chats!';
      setTimeout(() => { saveChatBtn.textContent = 'Save as Chat'; }, 2000);
    }
  };

  // Open / Close Panel
  function showSidebar() {
    if (document.body.classList.contains('sidebar-hidden')) {
      (window.showSidebarFor || (() => byId('toggle-sidebar')?.click()))();
    }
  }

  async function openPanel() {
    showSidebar();
    const cur = await api.getState();
    if (cur) {
      state = cur;
      ctxAgenda.value = state.context.agenda || '';
      ctxResume.value = state.context.resume || '';
      ctxNotes.value = state.context.notes || '';
      updateHeader();
      renderTranscript();
    }
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    button.classList.add('active');
    promptInput?.focus();
  }

  function closePanel(refocus) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    button.classList.remove('active');
    if (refocus) (button.offsetParent ? button : byId('more-actions') || button).focus();
  }

  button.onclick = () => (panel.hidden ? openPanel() : closePanel(true));
  closeBtn.onclick = () => closePanel(true);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel(true);
    }
  });

  // Event dispatch from main
  api.onToggle?.(() => {
    if (panel.hidden) openPanel();
    else closePanel(true);
  });

  api.onEvent?.((evt) => {
    if (!evt) return;
    if (evt.type === 'transcript' && evt.chunk) {
      state.transcript.push(evt.chunk);
      if (!panel.hidden && activeTab === 'transcript') renderTranscript();
    } else if (evt.type === 'stealth') {
      state.stealth = evt.value;
      updateHeader();
    } else if (evt.type === 'live') {
      state.live = evt.value;
      updateHeader();
    }
  });

  window.meetingUi = { open: openPanel, close: closePanel };
})();
