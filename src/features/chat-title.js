// A short title for the history list, made with no model call (a paid call per chat would need its own setting).
// The first thing the user really asked, without the browser state, page text or handed-over history Lumen adds to each message,
// and without the throat-clearing around it:
//  - a greeting or thanks on its own ("hi") is skipped for the next message, so two chats that both began "hi" differ;
//  - "Hey, can you please summarize https://example.com/a/very/long/path?x=1" becomes "Summarize example.com/a/very...";
//  - a request about "this page" and nothing else names the page ("Summarize this page · Lumen docs"), since every starter chip
//    would otherwise give the same title.
// Used by features/chat-store.js autoTitle; test/sidebar-ux2-units.js.

const TITLE_CHARS = 60;
const TRIVIAL = /^(?:hi+|hello|hey|heya|yo|sup|hola|howdy|thanks?|thank you|thx|ok(?:ay)?|test(?:ing)?|[.?]+)(?:\s+(?:there|again|claude|lumen))?[\s!.?,]*$/i;
const LEAD_IN = /^(?:(?:hey|hi|hello|yo)\b[,!.]?\s+|(?:please|pls|kindly)\b,?\s+|(?:can|could|would|will) you(?: please| kindly)?,?\s+|i (?:want|need|would like|'d like|wanna) (?:you )?to\s+|help me(?: to)?\s+|let's\s+)+/i;
const PAGE_REF = /\b(?:this|the|current) (?:page|tab|site|website|article|video|doc|document|paper|thread|post|pdf)\b/i;

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 && u.pathname.length < 18 ? u.pathname.replace(/\/$/, '') : '');
  } catch { return url; }
}

// A message as a title: no markup, a long address as its host, no slash-command word, no lead-in or sign-off, capitalised.
function tidy(raw) {
  let text = String(raw).replace(/https?:\/\/[^\s)]+/gi, (url) => (url.length > 28 ? shortUrl(url) : url)).replace(/[*`#>]+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, '').replace(/\s+/g, ' ').trim();
  const cmd = /^\/(?:think|deep|fast|btw)\b\s*([\s\S]*)$/i.exec(text); // a Lumen slash command is not part of the topic
  let trimmed = false;
  if (cmd && cmd[1]) { text = cmd[1]; trimmed = true; }
  const lead = text.replace(LEAD_IN, '');
  if (lead && lead !== text) { text = lead; trimmed = true; } // (a message that is nothing but "please" keeps its words)
  text = text.replace(/[\s,]*\b(?:please|pls|thanks|thank you|thx)\s*[.!]*$/i, '').replace(/[.,;:!\s]+$/, '').trim();
  return trimmed && text ? text.charAt(0).toUpperCase() + text.slice(1) : text; // a cut-off start reads better capitalised; an untouched message stays as typed
}

// At most `max` characters, cut at a word when one is near the end, with an ellipsis.
function cut(text, max) {
  if (text.length <= max) return text;
  const room = text.slice(0, max - 1);
  const space = room.lastIndexOf(' ');
  return `${(space > max - 22 ? room.slice(0, space) : room).trimEnd().replace(/[.,;:!\s]+$/, '')}…`;
}

// The user-visible text of one message's content blocks: Lumen's additions removed.
function userText(blocks) {
  return blocks.filter((b) => b.type === 'text').map((b) => String(b.text)
    .replace(/<browser_state>[\s\S]*?<\/browser_state>\s*/g, '')
    .replace(/<untrusted_page_content[\s\S]*?<\/untrusted_page_content>\s*/g, '')
    .replace(/<attached_files>[\s\S]*?<\/attached_files>\s*/g, '') // [uploads] the names and refs of attached files
    .replace(/<earlier_conversation>[\s\S]*?<\/earlier_conversation>\s*/g, '')
    .replace(/<screen_capture\b[^>]*>[\s\S]*?<\/screen_capture>\s*/g, '') // a screenshot or page text sent along
    .replace(/\[screenshot removed by the user\]/g, '')
    // Any other block Lumen adds (its tags are lower_case_with_underscores), closed or cut off, is never a title.
    .replace(/<(?!skill_request\b)([a-z]+_[a-z_]*)\b[^>]*>[\s\S]*?<\/\1>\s*/g, '')
    .replace(/<(?!skill_request\b)[a-z]+_[a-z_]*\b[^>]*(?:>[\s\S]*)?$/g, '')
    // A skill's message (features/skills.js) is titled by the skill and what was typed after it, not its prompt.
    .replace(/<skill_request name="[^"]*" title="([^"]*)" input="([^"]*)">[\s\S]*?<\/skill_request>\s*/g, (_m, title, input) => `${title}${input ? `: ${input}` : ''} `)).join(' ').replace(/\s+/g, ' ').trim();
}

function autoTitle(snapshot) {
  let first = null; // the first message that had words, if only greetings follow
  let screen = false; // a message that was only a screen capture
  for (const m of snapshot?.messages || []) {
    if (m.role !== 'user') continue;
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    const text = userText(blocks);
    if (text && text !== 'The user attached the image(s) above without a message.' && text !== 'The user attached the file(s) listed below without a message.') {
      const title = tidy(text) || cut(text, TITLE_CHARS);
      first ??= title;
      if (TRIVIAL.test(text)) continue; // "hi": the next message says what the chat is about
      const all = blocks.filter((b) => b.type === 'text').map((b) => String(b.text)).join(' ');
      const page = String((/<browser_state>[\s\S]*?\nTitle: ([^\n]+)\n/.exec(all) || [])[1] || '').replace(/\s+/g, ' ').trim();
      if (page && title.split(' ').length <= 6 && PAGE_REF.test(title)) {
        const head = cut(title, 34);
        return cut(`${head} · ${page}`, TITLE_CHARS);
      }
      return cut(title, TITLE_CHARS);
    }
    if (blocks.some((b) => b.type === 'text' && /<screen_capture\b/.test(String(b.text)))) screen = true;
    if (blocks.some((b) => b.type === 'image')) return 'Image';
    if (blocks.some((b) => b.type === 'text' && /<attached_files>/.test(String(b.text)))) return 'File';
  }
  return first ? cut(first, TITLE_CHARS) : screen ? 'Screen capture' : 'New chat';
}

// A title saved earlier, shown now: markup that leaked into it (a cut-off "<screen_capture id=...") is removed. '' when nothing real is left.
const DIRTY = /<\/?[a-z]+_[a-z_]*|\[screenshot removed/;
function cleanSaved(title) {
  const t = String(title ?? '');
  if (!DIRTY.test(t)) return t;
  return t.replace(/<[a-z]+_[a-z_]*\b[^>]*(?:>[\s\S]*)?$/, '').replace(/<\/?[a-z]+_[a-z_]*>/g, '').replace(/\[screenshot removed by the user\]/g, '').replace(/\s+/g, ' ').trim();
}

module.exports = { autoTitle, tidy, cut, cleanSaved, TITLE_CHARS };
