// Meeting helper unit tests, pure Node (no Electron, no window, no real network).
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createMeetingHelper } = require('../../src/features/meeting');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`);
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-meeting-test-'));

(async () => {
  // ---- 1. default state & context
  {
    const helper = createMeetingHelper({ userDataDir: tmpDir });
    const state = helper.getState();
    check('default state: not live', state.live === false);
    check('default state: not stealth', state.stealth === false);
    check('default state: empty transcript', Array.isArray(state.transcript) && state.transcript.length === 0);
    check('default state: default context', state.context.agenda === '' && state.context.resume === '' && state.context.notes === '');
  }

  // ---- 2. context saving & persistence
  {
    const helper = createMeetingHelper({ userDataDir: tmpDir });
    helper.saveContext({
      agenda: 'Discuss Q4 roadmap and OKRs',
      resume: 'Senior Staff Engineer with 10 years distributed systems experience',
      notes: 'Remember to mention memory optimizations',
    });

    const ctx = helper.loadContext();
    check('context: agenda saved', ctx.agenda === 'Discuss Q4 roadmap and OKRs');
    check('context: resume saved', ctx.resume.includes('Senior Staff Engineer'));
    check('context: notes saved', ctx.notes.includes('memory optimizations'));

    // Verify persisted on disk
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'meeting-context.json'), 'utf8'));
    check('disk persistence: file matches', onDisk.agenda === 'Discuss Q4 roadmap and OKRs');

    // Partial update
    helper.saveContext({ notes: 'Updated notes' });
    const updated = helper.loadContext();
    check('context: partial update keeps other fields', updated.agenda === 'Discuss Q4 roadmap and OKRs' && updated.notes === 'Updated notes');
  }

  // ---- 3. stealth mode (content protection)
  {
    let protectedCalled = null;
    const fakeWin = {
      isDestroyed: () => false,
      setContentProtection: (val) => { protectedCalled = val; },
    };
    const events = [];
    const helper = createMeetingHelper({
      userDataDir: tmpDir,
      getWindow: () => fakeWin,
      broadcast: (ch, evt) => events.push({ ch, evt }),
    });

    helper.setStealth(true);
    check('stealth: sets content protection on window', protectedCalled === true);
    check('stealth: state updated', helper.getState().stealth === true);
    check('stealth: broadcasted event', events.some((e) => e.evt.type === 'stealth' && e.evt.value === true));

    helper.setStealth(false);
    check('stealth: disables content protection', protectedCalled === false);
  }

  // ---- 4. live listener & transcript management
  {
    const events = [];
    const helper = createMeetingHelper({
      userDataDir: tmpDir,
      broadcast: (ch, evt) => events.push({ ch, evt }),
    });

    helper.setLive(true);
    check('live: toggles live state', helper.getState().live === true);
    check('live: broadcasts live state', events.some((e) => e.evt.type === 'live' && e.evt.value === true));

    helper.addTranscriptChunk('Can you explain our SLA targets for this quarter?', 'Interviewer');
    helper.addTranscriptChunk('Sure, our SLA target is 99.99% uptime with p99 latency under 50ms.', 'Candidate');

    const state = helper.getState();
    check('transcript: 2 chunks recorded', state.transcript.length === 2);
    check('transcript: speaker recorded', state.transcript[0].speaker === 'Interviewer');
    check('transcript: text recorded', state.transcript[0].text.includes('SLA targets'));

    helper.clearTranscript();
    check('transcript: clear removes chunks', helper.getState().transcript.length === 0);
  }

  // ---- 5. buildPromptContent
  {
    const helper = createMeetingHelper({ userDataDir: tmpDir });
    helper.saveContext({
      agenda: 'System Design Interview',
      resume: '10 years backend experience',
      notes: 'Focus on scalability',
    });
    helper.addTranscriptChunk('How would you scale Redis?', 'Interviewer');

    const content = helper.buildPromptContent({
      question: 'Give me key architecture points',
      includeScreen: true,
      screenText: 'Shared Slide: Distributed Caching Architecture',
    });

    check('prompt: includes agenda', content.includes('<meeting_agenda>\nSystem Design Interview\n</meeting_agenda>'));
    check('prompt: includes resume', content.includes('<user_background>\n10 years backend experience\n</user_background>'));
    check('prompt: includes notes', content.includes('<meeting_notes>\nFocus on scalability\n</meeting_notes>'));
    check('prompt: includes recent transcript', content.includes('<recent_transcript>\nInterviewer: How would you scale Redis?\n</recent_transcript>'));
    check('prompt: includes screen context', content.includes('<active_screen_or_slides>\nShared Slide: Distributed Caching Architecture\n</active_screen_or_slides>'));
    check('prompt: includes question', content.includes('Question or prompt: Give me key architecture points'));
  }

  // ---- 6. prompt execution with mock AI
  {
    let receivedPayload = null;
    const fakeComplete = async ({ system, user, schema }) => {
      receivedPayload = { system, user, schema };
      return {
        answer: 'Partition using consistent hashing and add read replicas.',
        talking_points: ['Consistent hashing', 'Replication lag monitoring'],
      };
    };

    const helper = createMeetingHelper({
      userDataDir: tmpDir,
      complete: fakeComplete,
    });

    const res = await helper.prompt('How to partition cache?');
    check('prompt: calls complete', receivedPayload !== null);
    check('prompt: returns answer', res.ok && res.answer.includes('consistent hashing'));
    check('prompt: returns talking points', res.talkingPoints.length === 2);
    check('prompt: updates recent answer in state', helper.getState().recentAnswer.includes('consistent hashing'));
  }

  // ---- 7. summarize & post-meeting chat saving
  {
    let summarizedPrompt = null;
    const fakeComplete = async ({ system, user }) => {
      summarizedPrompt = user;
      return {
        summary: '### Executive Summary\nThe team agreed to use consistent hashing.\n\n### Action Items\n- Implement hashing ring',
        action_items: ['Implement hashing ring'],
        key_decisions: ['Use consistent hashing'],
      };
    };

    const savedChats = new Map();
    const fakeChatStore = {
      save: (id, data) => { savedChats.set(id, data); },
    };

    const helper = createMeetingHelper({
      userDataDir: tmpDir,
      complete: fakeComplete,
      getChatStore: () => fakeChatStore,
    });

    helper.addTranscriptChunk('We need to partition cache nodes.', 'Alice');
    helper.addTranscriptChunk('Agreed, let us use consistent hashing.', 'Bob');

    const sumRes = await helper.summarize();
    check('summarize: success', sumRes.ok && sumRes.summary.includes('consistent hashing'));
    check('summarize: passes transcript to prompt', summarizedPrompt.includes('consistent hashing'));

    const saveRes = helper.saveToChat({
      title: 'Q4 Cache Architecture Review',
      summary: sumRes.summary,
      transcriptText: 'Alice: We need to partition...\nBob: Agreed.',
    });

    check('saveToChat: returns ok and chatId', saveRes.ok && typeof saveRes.chatId === 'string');
    check('saveToChat: saved in chat store', savedChats.has(saveRes.chatId));
    const saved = savedChats.get(saveRes.chatId);
    check('saveToChat: has user and assistant messages', saved.messages.length === 2);
    check('saveToChat: assistant contains summary and transcript', saved.messages[1].content[0].text.includes('Full Meeting Transcript'));
  }

  // Cleanup tmp
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  // features/meeting.js loads on first use, so main.js names its IPC channels itself: the two lists must match.
  {
    const mainSrc = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'main.js'), 'utf8');
    const missing = require('../../src/features/meeting').CHANNELS.filter((c) => !mainSrc.includes(`'${c}'`));
    if (missing.length) { failures++; console.log(`FAIL  main.js allows every meeting channel  -> missing ${missing.join(', ')}`); }
    else console.log('PASS  main.js allows every meeting channel');
  }

  console.log(`\nmeeting-units: ${failures ? `${failures} failed` : 'all passed'}`);
  process.exit(failures ? 1 : 0);
})();
