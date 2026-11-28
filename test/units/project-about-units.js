// [about you] features/project-about.js: the block a project's chats get from its profile, the AI's saves (fields and saved answers, never the
// sensitive questions), the project page's edits, the view, and the Word tool's guard on the base résumé and cover letter; plus the profile
// keeping its new parts (preferred locations, highlights, a Drive résumé) in features/automations.js. Plain Node.
const path = require('path');
const A = require('../../src/features/project-about');
const auto = require('../../src/features/automations');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 500)}`}`); };
const J = JSON.stringify;
const base = path.resolve('/Users/sam/Documents/Resume.docx');
const cover = path.resolve('/Users/sam/Documents/Cover letter.docx');
const profile = auto.normalizeProfile({
  name: 'Co-op', resumePath: base, coverLetterPath: cover,
  fields: { fullName: 'Sam Lee', school: 'Northeastern University', major: 'Mechanical Engineering', gradDate: 'May 2028', workAuth: 'Yes', locations: 'Boston, Bay Area', linkedin: 'https://linkedin.com/in/samlee' },
  highlights: 'SolidWorks, MATLAB; Formula SAE suspension lead.',
  answers: [{ question: 'Why this company?', answer: 'Because I build cars.' }],
  resumeDrive: { id: '1AbCdEfGhIjKlMnOpQrStUvWxYz', name: 'Résumé (Drive)' },
});

// ---- the profile keeps its new parts
{
  check('the profile keeps preferred locations, highlights and a Drive résumé', profile.fields.locations === 'Boston, Bay Area' && profile.highlights.startsWith('SolidWorks') && profile.resumeDrive?.id === '1AbCdEfGhIjKlMnOpQrStUvWxYz', J(profile));
  check('a bad Drive id is dropped', auto.normalizeProfile({ resumeDrive: { id: '../x' } }).resumeDrive === null);
  check('a form asking for preferred locations is answered from the profile', auto.answerFor({ label: 'Preferred work locations' }, profile)?.value === 'Boston, Bay Area');
}

// ---- the block every chat of the project gets
{
  const b = A.block(profile, { tailored: path.resolve('/p/Tailored résumés') });
  check('the block has the filled details with their labels', /<about_user>/.test(b) && /Graduation date: May 2028/.test(b) && /Major: Mechanical Engineering/.test(b) && /Preferred locations: Boston, Bay Area/.test(b), b);
  check('…the base files, marked never to change, and where copies go', b.includes(base) && /never edit, rename or overwrite/.test(b) && /Tailored copies go in/.test(b) && /connector drive read id 1AbCdEfGhIjKlMnOpQrStUvWxYz/.test(b), b);
  check('…the highlights and the saved answers', /Formula SAE/.test(b) && /Q: Why this company\?/.test(b) && /A: Because I build cars\./.test(b));
  check('…and tells the AI to use it instead of asking, and to save new facts', /instead of asking again/.test(b) && /action remember/.test(b));
  check('empty boxes are left out', !/GPA:/.test(b) && !/Phone:/.test(b));
  check('a profile with nothing in it: the short block that says so (and how to save), none without a profile', /Nothing is saved yet/.test(A.block(auto.normalizeProfile({}))) && /action remember/.test(A.block(auto.normalizeProfile({}))) && A.block(null) === '');
  const many = { ...profile, answers: Array.from({ length: 80 }, (_, i) => ({ question: `Question number ${i}?`, answer: 'x'.repeat(400) })) };
  const big = A.block(many, { max: 3000 });
  check('many answers: kept near the size, the rest counted', big.length < 3400 && /more saved answers/.test(big), big.length);
}

// ---- the AI's saves
{
  const f = A.remember(profile, { field: 'gradDate', value: 'December 2028' });
  check('remember a field: the patch and what it says (old → new)', f.ok && f.patch.fields.gradDate === 'December 2028' && f.patch.fields.major === 'Mechanical Engineering' && /May 2028 → December 2028/.test(f.said), J(f));
  check('remember an unknown field: refused with the field names', !A.remember(profile, { field: 'favoriteColor', value: 'red' }).ok);
  check('remember a field with no value: refused', !A.remember(profile, { field: 'gpa', value: '  ' }).ok);
  const q = A.remember(profile, { question: 'Why this company?', answer: 'Because they build rockets.' });
  check('remember an answer: replaces the one with the same question', q.ok && q.patch.answers.length === 1 && q.patch.answers[0].answer === 'Because they build rockets.', J(q));
  const q2 = A.remember(profile, { question: 'Describe a project', answer: 'The suspension.' });
  check('…a new question is added', q2.ok && q2.patch.answers.length === 2);
  const q3 = A.remember(profile, { field: 'Describe a project you led', value: 'The suspension.' });
  check('the tool\'s field as a question: saved as an answer', q3.ok && q3.patch.answers.some((a) => a.question === 'Describe a project you led' && a.answer === 'The suspension.'), J(q3));
  check('…a sensitive one as a field is refused too', !A.remember(profile, { field: 'What is your gender?', value: 'x' }).ok);
  // the tool's one line
  check('note "gradDate: May 2029" is the box', A.remember(profile, { note: 'gradDate: May 2029' }).patch?.fields?.gradDate === 'May 2029');
  const qn = A.remember(profile, { note: 'Why do you want this co-op? To build things.' });
  check('note "question? answer" is a saved answer', qn.ok && qn.patch.answers.some((a) => a.question === 'Why do you want this co-op?' && a.answer === 'To build things.'), J(qn));
  check('note "Earliest start: June" (not a key) is a question and answer', A.remember(profile, { note: 'Earliest start: June 2027' }).patch?.answers?.some((a) => a.question === 'Earliest start' && a.answer === 'June 2027'));
  check('a sensitive question in a note is refused', !A.remember(profile, { note: 'What is your race? x' }).ok);
  check('a note with no fact: refused', !A.remember(profile, { note: 'hello' }).ok);
  for (const sensitive of ['What is your gender?', 'Are you a veteran?', 'Desired salary', 'Date of birth', 'Password']) check(`never saves "${sensitive}"`, !A.remember(profile, { question: sensitive, answer: 'x' }).ok);
  check('remember with nothing: refused', !A.remember(profile, {}).ok);
  // a sensitive answer only in the user's own words; secrets never
  const said = 'Male, white, not a veteran, no disability';
  check('a demographic answer the user gave is saved', A.remember(profile, { note: 'What is your gender? Male' }, { userText: said }).ok);
  check('…"I am not a protected veteran" from "not a veteran"', A.remember(profile, { question: 'Are you a protected veteran?', answer: 'I am not a protected veteran' }, { userText: said }).ok);
  check('…one the user did not say is refused', !A.remember(profile, { note: 'What is your gender? Female' }, { userText: said }).ok);
  check('…a bare "Yes" with only a "no" from the user is refused', !A.remember(profile, { question: 'Do you have a disability?', answer: 'Yes' }, { userText: 'no' }).ok);
  check('a password or SSN is never saved, even when the user said it', !A.remember(profile, { question: 'Password', answer: 'hunter2' }, { userText: 'hunter2' }).ok && !A.remember(profile, { question: 'SSN', answer: '123' }, { userText: '123' }).ok);
  check('with "ask me", demographic answers are not saved', !A.remember({ ...profile, demographics: 'ask' }, { note: 'What is your gender? Male' }, { userText: said }).ok);
  check('note "demographics: decline" sets the choice; a bad one is refused', A.remember(profile, { note: 'demographics: decline' }).patch?.demographics === 'decline' && !A.remember(profile, { note: 'demographics: maybe' }).ok);
}

// ---- the demographics choice on the page
{
  check('pageChange: the demographics choice', A.pageChange(profile, { demographics: 'ask' })?.demographics === 'ask' && A.pageChange(profile, { demographics: 'x' }) === null);
  check('view: the choice, "saved" by default', A.view(profile).demographics === 'saved' && A.view({ ...profile, demographics: 'decline' }).demographics === 'decline');
}

// ---- the page's edits
{
  const p1 = A.pageChange(profile, { fields: { phone: '617-555-0100', gradDate: '', bogus: 'x' } });
  check('fields: set and cleared; unknown keys ignored', p1.fields.phone === '617-555-0100' && p1.fields.gradDate === '' && !('bogus' in p1.fields), J(p1));
  const p2 = A.pageChange(profile, { answer: { question: 'Why us?', answer: 'Mission.', was: 'Why this company?' } });
  check('an answer edited in place (its question changed)', J(p2.answers) === J([{ question: 'Why us?', answer: 'Mission.' }]), J(p2));
  check('an answer removed', J(A.pageChange(profile, { removeAnswer: 'why this company' }).answers) === '[]');
  check('an empty answer: nothing saved', A.pageChange(profile, { answer: { question: 'Q', answer: '' } }) === null);
  check('a Drive résumé from a Docs link', A.pageChange(profile, { resumeDrive: { url: 'https://docs.google.com/document/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa/edit' } }).resumeDrive.id === '1ZyXwVuTsRqPoNmLkJiHgFeDcBa');
  check('a link that is not Drive: refused', A.pageChange(profile, { resumeDrive: { url: 'https://example.com/x' } }) === null);
  check('the Drive résumé taken off', A.pageChange(profile, { resumeDrive: null }).resumeDrive === null);
  check('highlights', A.pageChange(profile, { highlights: '  New  ' }).highlights === 'New');
  check('nothing to change: null', A.pageChange(profile, {}) === null);
}

// ---- the view
{
  const v = A.view(profile);
  check('the view: groups in order, filled count, file names', J(v.groups.map((g) => g.id)) === J(['you', 'school', 'work', 'links', 'address']) && v.filled === 7 && v.total === A.KEYS.length && v.resume.name === 'Resume.docx' && v.cover.name === 'Cover letter.docx', J(v).slice(0, 400));
  check('every profile box is on the page', auto.PROFILE_KEYS.every((k) => A.KEYS.includes(k)), auto.PROFILE_KEYS.filter((k) => !A.KEYS.includes(k)));
}

// ---- the Word tool never writes to a base file
{
  const files = [base, cover];
  check('reading the base résumé is fine', !A.touchesBase({ action: 'open', path: base }, files) && !A.touchesBase({ action: 'read', doc: 'Resume.docx' }, files));
  check('editing it is not (by path or by the open document\'s name)', A.touchesBase({ action: 'replace', doc: 'Resume.docx' }, files) && A.touchesBase({ action: 'insert', path: base }, files) && A.touchesBase({ action: 'save', doc: 'Cover letter.docx' }, files));
  check('save_as a new file (the tailored copy) is fine; save_as over the base is not', !A.touchesBase({ action: 'save_as', doc: 'Resume.docx', path: path.resolve('/p/Tailored résumés/Acme - Intern.docx') }, files) && A.touchesBase({ action: 'save_as', doc: 'Draft', path: base }, files));
  check('editing the copy is fine', !A.touchesBase({ action: 'replace', doc: 'Acme - Intern.docx' }, files));
  check('no base files: never refused', !A.touchesBase({ action: 'replace', doc: 'Resume.docx' }, []));
}

if (failures) { console.log(`\n${failures} about-you check(s) failed.`); process.exit(1); }
console.log('\nAll about-you checks passed.');
