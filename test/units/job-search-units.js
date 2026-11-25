// [project templates] features/job-search.js: Find jobs in a Job applications project. A job skill the user already has is found (and
// one that isn't about finding jobs isn't), the installed JobSpy skill is a valid Lumen skill and wins, a search's arguments are bounded,
// JobSpy's rows are read into listings (web addresses only, one per posting, pay and dates), the Python versions JobSpy can use, and the
// runner only imports JobSpy and the standard library. Plain Node: no Python is run here.
require('../helpers/_tmp-cleanup');
const S = require('../../src/features/job-search');
const auto = require('../../src/features/automations');
const skills = require('../../src/features/skills');

let failures = 0;
const check = (label, ok, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  -> ${String(detail).slice(0, 400)}`}`); };
const J = JSON.stringify;

// ---- finding a job skill
{
  const mine = { name: 'job-scraper', title: 'job-scraper', description: 'Run the user\'s local job scraper. Use when the user asks to find, scrape, search, or refresh job/internship/co-op listings.' };
  const other = [{ name: 'summarize', description: 'Summarize the page' }, { name: 'cover-letter', description: 'Draft a cover letter for a job posting' }, { name: 'explain', description: 'Explain the selection' }];
  check('skill: the user\'s job scraper skill is a job skill', S.isJobSkill(mine));
  check('skill: a skill that writes cover letters isn\'t a job search skill, nor a summary one', other.every((s) => !S.isJobSkill(s)), J(other.filter(S.isJobSkill)));
  check('skill: Find jobs uses the user\'s own when there is one', S.pickSkill([...other, mine])?.name === 'job-scraper');
  check('skill: none when there is none (Find jobs then offers to install one)', S.pickSkill(other) === null && S.pickSkill([]) === null);
  check('skill: the JobSpy one Lumen installed wins over another', S.pickSkill([mine, S.JOBSPY_SKILL])?.name === 'job-search');
  const n = skills.normalizeSkill ? skills.normalizeSkill(S.JOBSPY_SKILL) : null;
  check('skill: the installed one is a valid Lumen skill: tools on, the AI may use it, it takes what to search for', !n || (n.ok && n.skill.name === 'job-search' && n.skill.mode === 'agent' && n.skill.autoUse === true && n.skill.inputRequired === true && /\{\{input\}\}/.test(n.skill.prompt)), J(n));
  check('skill: it tells the AI to search with the tracker tool, skip what is tracked, say listings are unverified, save as saved', /action "search"/.test(S.JOBSPY_SKILL.prompt) && /action "check"/.test(S.JOBSPY_SKILL.prompt) && /aren't checked/.test(S.JOBSPY_SKILL.prompt) && /stage "saved"/.test(S.JOBSPY_SKILL.prompt));
  check('skill: JobSpy is pinned to one version', /^python-jobspy==\d+\.\d+\.\d+$/.test(S.JOBSPY_PACKAGE));
}

// ---- a search's arguments
{
  check('args: nothing to search for is refused', !S.searchArgs({}).ok && !S.searchArgs({ query: '   ' }).ok);
  const a = S.searchArgs({ query: 'mechanical engineering co-op', location: 'Boston, MA', job_type: 'internship', hours_old: 24 * 7, results: 30, sites: ['linkedin', 'indeed', 'evil.com'] }).args;
  check('args: what was asked, an unknown site dropped', a.search === 'mechanical engineering co-op' && a.location === 'Boston, MA' && a.job_type === 'internship' && a.hours_old === 168 && a.results === 30 && J(a.sites) === J(['linkedin', 'indeed']), J(a));
  const d = S.searchArgs({ query: 'x', results: 10000, hours_old: -5, job_type: 'rm -rf', country: 'USA; drop' }).args;
  check('args: bounded (at most 50 results, two weeks by default, an unknown type or country ignored)', d.results === 50 && d.hours_old === 336 && d.job_type === '' && d.country === 'USA' && J(d.sites) === J(['linkedin', 'indeed', 'google']), J(d));
  check('args: control characters and length cut', S.searchArgs({ query: `a‮b\n${'x'.repeat(500)}` }).args.search.length === 120 && !/[‮\n]/.test(S.searchArgs({ query: 'a‮b\nc' }).args.search));
}

// ---- JobSpy's rows
{
  const rows = [
    { site: 'indeed', title: 'Platform Mechanical Engineer Co-Op', company: 'Boston Dynamics', location: 'Waltham, MA, US', job_url: 'https://www.indeed.com/viewjob?jk=1', job_url_direct: 'https://bostondynamics.wd1.myworkdayjobs.com/job/1', date_posted: '2026-11-23', min_amount: '20.0', max_amount: '27.0', interval: 'hourly', is_remote: 'False' },
    { site: 'linkedin', title: 'Platform Mechanical Engineer Co-Op', company: 'Boston Dynamics', location: 'Waltham, MA', job_url: 'https://www.linkedin.com/jobs/view/2' },
    { site: 'linkedin', title: 'Co-op, R&D Mechanical', company: 'Insulet', location: 'Acton, MA', job_url: 'https://www.linkedin.com/jobs/view/4467129173', is_remote: 'True', min_amount: '60000', interval: 'yearly' },
    { site: 'google', title: 'Bad link', company: 'X', job_url: 'javascript:alert(1)' },
    { site: 'indeed', title: '', company: 'No title', job_url: 'https://a.example/1' },
  ];
  const r = S.readResults(JSON.stringify(rows), auto);
  check('results: read, the same posting on two boards once, bad links and empty titles dropped', r.ok && r.listings.length === 2, J(r));
  const bd = r.listings[0];
  check('results: the company\'s own address first, the board named, dated, pay shown', bd.url === 'https://bostondynamics.wd1.myworkdayjobs.com/job/1' && bd.site === 'Indeed' && new Date(bd.posted).getUTCDate() === 23 && bd.pay === '$20–$27/hr', J(bd));
  check('results: remote and a yearly salary', r.listings[1].remote === true && r.listings[1].pay === '$60k/yr', J(r.listings[1]));
  check('results: something unreadable says so', !S.readResults('not json', auto).ok && !S.readResults('{"a":1}', auto).ok && S.readResults('', auto).listings.length === 0);
  check('results: for the AI, one line each, marked unverified', /unverified/.test(S.describe(r.listings)) && S.describe(r.listings).split('\n').length === 3 && /Try other words/.test(S.describe([])));
}

// ---- Python
{
  check('python: 3.10 to 3.13 (JobSpy\'s numpy and pandas have wheels for them)', S.pythonOk('Python 3.12.13') && S.pythonOk('Python 3.10.0') && S.pythonOk('Python 3.13.1') && !S.pythonOk('Python 3.14.6') && !S.pythonOk('Python 3.9.18') && !S.pythonOk('Python was not found; run without arguments to install from the Microsoft Store'));
  check('python: on Windows the launcher\'s versions come first', process.platform !== 'win32' || J(S.PYTHONS[0]) === J(['py', ['-3.12']]));
  const imports = [...S.RUNNER.matchAll(/^\s*(?:from (\S+) import .+|import (.+))$/gm)].flatMap((m) => (m[1] ? [m[1]] : m[2].split(',').map((x) => x.trim())));
  check('runner: imports JobSpy and the standard library only, reads stdin, writes stdout, no files', J(imports.sort()) === J(['jobspy', 'json', 'math', 'sys']) && !/open\(|subprocess|os\.|eval|exec/.test(S.RUNNER), J(imports));
}

console.log(failures ? `\n${failures} failed` : '\nAll job search checks passed.');
process.exit(failures ? 1 : 0);
