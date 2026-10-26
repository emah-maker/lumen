// Canvas, read the way a person reads it: the site's normal pages in a tab, never its JSON API (/api/v1/...). The AI's Canvas
// actions (registry.js: courses, upcoming, announcements, announcement) each name the page that shows that; agent.js opens one
// background AI tab (the chat's step card is then a Browser card the user can click open), loads each page there and reads its
// text the way read_page does. Everything here is pure: the address of each page, the course ids on the course list, whether a
// page is the sign-in page. Read only, GET pages only: nothing is clicked or submitted.
'use strict';

const ID = /^\d{1,20}$/;
const MAX_COURSES = 6; // announcements with no course: this many courses' pages at most
const PAGE_CHARS = 12000; // what one answer carries of the pages' text, together

const err = (message) => Object.assign(new Error(message), { kind: 'args' });

// The page(s) an action reads. base: "https://school.instructure.com" (no trailing slash).
// -> { urls: [address], discover?: true, what } ; discover: announcements with no course, so the course list is read first and
// announcementPages(base, ids) gives the pages to read after it.
function plan(action, args, base) {
  const a = args && typeof args === 'object' ? args : {};
  const root = String(base || '').replace(/\/+$/, '');
  const course = a.course_id === undefined || a.course_id === null || a.course_id === '' ? '' : String(a.course_id);
  if (course && !ID.test(course)) throw err('course_id is the number from the course list.');
  switch (action) {
    case 'courses': return { urls: [`${root}/courses`], what: 'your courses' };
    case 'upcoming':
      return course ? { urls: [`${root}/courses/${course}/assignments`], what: `the assignments of course ${course}` } : { urls: [`${root}/calendar#view_name=agenda`], what: 'your upcoming assignments' };
    case 'announcements':
      return course ? { urls: [`${root}/courses/${course}/announcements`], what: `the announcements of course ${course}` } : { urls: [], discover: true, what: 'the announcements of your courses' };
    case 'announcement': {
      const id = String(a.id ?? '');
      if (!ID.test(course) || !ID.test(id)) throw err('course_id and id are the numbers shown by announcements.');
      return { urls: [`${root}/courses/${course}/discussion_topics/${id}`], what: `announcement ${id}` };
    }
    default: throw err(`Canvas has no action "${String(action).slice(0, 40)}".`);
  }
}

const announcementPages = (base, ids) => ids.slice(0, MAX_COURSES).map((id) => `${String(base).replace(/\/+$/, '')}/courses/${id}/announcements`);

// The ids of the courses a /courses page lists as current: its html (or the links' text). The "Past Enrollments" and "Future
// Enrollments" tables come after the current one and are left out. In the order the page lists them, once each.
function parseCourseIds(source, max = MAX_COURSES) {
  let text = String(source || '');
  const past = text.search(/past enrollments|future enrollments/i);
  if (past > 0) text = text.slice(0, past);
  const ids = [];
  const re = /\/courses\/(\d{1,20})(?=[/?#"'\s<>)]|$)/g;
  let m;
  while ((m = re.exec(text)) && ids.length < max) if (!ids.includes(m[1])) ids.push(m[1]);
  return ids;
}

// Is this address the school's sign-in (or its single sign-on page) instead of Canvas? Another site, or Canvas's own /login.
function isLoginPage(url, base) {
  let u;
  let b;
  try { u = new URL(String(url)); b = new URL(String(base)); } catch { return false; }
  if (u.origin !== b.origin) return true;
  return /^\/login(?:[/?]|$)/i.test(u.pathname);
}

// What read_page answered (<untrusted_page_content>{header json}\nPAGE TEXT:\n…</untrusted_page_content>) down to the page's text.
function pageText(answer) {
  let s = String(answer ?? '').replace(/^\s*<untrusted_page_content[^>]*>\s*/i, '').replace(/\s*<\/untrusted_page_content>\s*$/i, '');
  const at = s.indexOf('PAGE TEXT:');
  if (at >= 0) s = s.slice(at + 'PAGE TEXT:'.length);
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// The answer: every page's address first (so the AI can cite it), then its text, the whole kept under `chars`.
function assemble(source, pages, chars = PAGE_CHARS) {
  const list = pages.filter((p) => p && p.url);
  const each = Math.max(1500, Math.floor(chars / Math.max(1, list.length)));
  const body = list.map((p) => {
    const t = String(p.text || '');
    return `Page: ${p.url}\n${t.length > each ? `${t.slice(0, each)}\n[… cut]` : t || '(nothing on the page)'}`;
  }).join('\n\n---\n\n');
  return `<untrusted_page_content source="${source}">\n${body.replace(/<(\/?)untrusted_page_content/gi, '‹$1untrusted_page_content')}\n</untrusted_page_content>`;
}

// The code run in the course list's tab: the page's html (capped), for parseCourseIds.
const COURSE_LINKS_SCRIPT = '(() => { try { return String(document.documentElement.outerHTML || "").slice(0, 600000); } catch { return ""; } })()';

module.exports = { plan, announcementPages, parseCourseIds, isLoginPage, pageText, assemble, COURSE_LINKS_SCRIPT, MAX_COURSES, PAGE_CHARS };
