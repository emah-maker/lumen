// [project templates] Find jobs, in a Job applications project's dashboard (renderer/chat-job-board.js) and as the applications tool's
// `search` action. It uses a job skill the user already has (a Lumen skill or, with Settings → Skills → "Use my Claude Code skills", a
// Claude Code one) when there is one: Find jobs then starts a chat in the project with that skill. With none, the dashboard offers to
// install Job search (JobSpy): JobSpy (github.com/speedyapply/JobSpy, MIT, the most-starred job scraper on GitHub) in a Python
// environment of Lumen's own (<userData>/job-search/venv, made with the user's Python 3.10 to 3.13, a pinned version from PyPI), and a
// Lumen skill that tells the AI to use it. Installing asks first, on the dashboard; nothing is installed on its own.
// A search runs JobSpy on this computer: the job boards (LinkedIn, Indeed, Google Jobs, ZipRecruiter, Glassdoor) are asked directly,
// as a browser would; nothing goes through anyone else. Listings come back unverified; the user saves the ones they want to the tracker
// (stage Saved), and from there to the linked sheet (job-sync.js).
// The pure part (the skill, finding one, the arguments, reading the results) is unit-tested in test/units/job-search-units.js; main.js
// runs the processes.
'use strict';

const JOBSPY_PACKAGE = 'python-jobspy==1.1.82';
const SITES = ['linkedin', 'indeed', 'google', 'zip_recruiter', 'glassdoor'];
const SITE_NAMES = { linkedin: 'LinkedIn', indeed: 'Indeed', google: 'Google Jobs', zip_recruiter: 'ZipRecruiter', glassdoor: 'Glassdoor' };
const JOB_TYPES = ['internship', 'fulltime', 'parttime', 'contract'];
const MAX_RESULTS = 50;

const CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const clean = (v, max) => String(v ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// The skill Lumen installs (features/skills.js keeps it like any other; the user can edit or delete it).
const JOBSPY_SKILL = {
  name: 'job-search',
  title: 'Job search (JobSpy)',
  description: 'Search LinkedIn, Indeed, Google Jobs and ZipRecruiter for job, internship and co-op postings, and save the good ones to the project\'s tracker.',
  icon: '🔎',
  mode: 'agent', // (a nudge to use tools: features/skills.js MODES)
  autoUse: true,
  inputRequired: true,
  source: 'user',
  prompt: [
    'Find job postings for: {{input}}',
    '',
    'Use the applications tool with action "search" (it runs JobSpy on this computer). Give it the role as query, a location if the request names one, and job_type "internship" for internships and co-ops. Search again with other words if the first search finds little.',
    'Then show the best matches as a short list: company, role, location, how long ago it was posted, and the link. Leave out postings that clearly don\'t fit (a senior role, the wrong field, a place the user didn\'t ask for), and ones the tracker already has (applications tool, action "check").',
    'Listings come straight from the job boards and aren\'t checked: say so, and open a posting before calling it open.',
    'Save the ones the user wants with the applications tool, action "add", stage "saved" (company, role, url).',
  ].join('\n'),
};

// Is this a job search skill? Its name, title or description is about jobs (job, internship, co-op, career) and about finding them.
function isJobSkill(s) {
  const text = `${s?.name || ''} ${s?.title || ''} ${s?.description || ''}`.toLowerCase();
  return /\bjobs?\b|intern(ship)?s?\b|co-?ops?\b|career|hiring|vacanc|openings?\b|postings?\b/.test(text) && /search|scrap|find|listing|board|hunt|look|discover|fetch/.test(text);
}
// The skill Find jobs uses: the JobSpy one Lumen installed, else the first job skill the user has. -> the skill or null
function pickSkill(skills) {
  const list = (skills || []).filter((s) => s && s.name);
  return list.find((s) => s.name === JOBSPY_SKILL.name) || list.find(isJobSkill) || null;
}

// A search's arguments, checked (what the page or the AI sent). -> { ok, args } | { ok: false, error }
function searchArgs(input) {
  const search = clean(input?.query ?? input?.search, 120);
  if (!search) return { ok: false, error: 'Say what to search for (a role, like "mechanical engineering co-op").' };
  const sites = (Array.isArray(input?.sites) ? input.sites : ['linkedin', 'indeed', 'google']).filter((s) => SITES.includes(s));
  const jobType = JOB_TYPES.includes(input?.job_type ?? input?.jobType) ? (input.job_type ?? input.jobType) : '';
  const hours = Math.round(Number(input?.hours_old ?? input?.hoursOld));
  const results = Math.round(Number(input?.results));
  return {
    ok: true,
    args: {
      search,
      location: clean(input?.location, 80),
      sites: sites.length ? [...new Set(sites)] : ['linkedin', 'indeed', 'google'],
      job_type: jobType,
      hours_old: Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 60) : 24 * 14,
      results: Number.isFinite(results) && results > 0 ? Math.min(results, MAX_RESULTS) : 20,
      country: /^[A-Za-z ]{2,30}$/.test(String(input?.country || '')) ? String(input.country) : 'USA',
    },
  };
}

// What runs in Lumen's Python (python -I -c, the arguments as JSON on stdin, the listings as JSON on stdout). Only JobSpy and the
// standard library; it writes nothing.
const RUNNER = `
import json, sys, math
args = json.loads(sys.stdin.read())
from jobspy import scrape_jobs
kw = dict(site_name=args["sites"], search_term=args["search"], results_wanted=args["results"], hours_old=args["hours_old"], country_indeed=args["country"], verbose=0)
if args.get("location"): kw["location"] = args["location"]
if args.get("job_type"): kw["job_type"] = args["job_type"]
if "google" in args["sites"]: kw["google_search_term"] = (args["search"] + (" jobs near " + args["location"] if args.get("location") else " jobs") + " since " + str(max(1, args["hours_old"] // 24)) + " days ago")
df = scrape_jobs(**kw)
out = []
for r in df.to_dict(orient="records"):
    row = {}
    for k in ("site", "title", "company", "location", "job_url", "job_url_direct", "date_posted", "job_type", "is_remote", "min_amount", "max_amount", "interval", "currency"):
        v = r.get(k)
        if v is None or (isinstance(v, float) and math.isnan(v)): continue
        row[k] = str(v)
    out.append(row)
sys.stdout.write(json.dumps(out))
`.trim();

const money = (n) => { const v = Number(n); return Number.isFinite(v) && v > 0 ? (v >= 1000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`) : ''; };
// JobSpy's rows -> listings: { title, company, location, url, site, posted (ms or 0), pay, remote }, only web addresses, one per posting.
function readResults(text, { webUrl, urlKey }) {
  let rows;
  try { rows = JSON.parse(String(text || '').trim() || '[]'); } catch { return { ok: false, error: 'JobSpy sent something Lumen couldn’t read.' }; }
  if (!Array.isArray(rows)) return { ok: false, error: 'JobSpy sent something Lumen couldn’t read.' };
  const seen = new Set();
  const out = [];
  for (const r of rows.slice(0, 500)) {
    const url = webUrl(r?.job_url_direct) || webUrl(r?.job_url) || '';
    const title = clean(r?.title, 160);
    if (!url || !title) continue;
    const key = urlKey(url);
    const dupe = `${clean(r?.company, 120).toLowerCase()}|${title.toLowerCase()}`;
    if (seen.has(key) || seen.has(dupe)) continue;
    seen.add(key);
    seen.add(dupe);
    const posted = Date.parse(String(r?.date_posted || ''));
    const lo = money(r?.min_amount);
    const hi = money(r?.max_amount);
    out.push({
      title, company: clean(r?.company, 120), location: clean(r?.location, 120), url, site: SITE_NAMES[r?.site] || clean(r?.site, 30),
      posted: Number.isFinite(posted) ? posted : 0, pay: lo || hi ? `${lo}${lo && hi ? '–' : ''}${hi}${r?.interval ? `/${clean(r.interval, 10).replace('yearly', 'yr').replace('hourly', 'hr').replace('monthly', 'mo')}` : ''}` : '', remote: String(r?.is_remote) === 'True',
    });
  }
  return { ok: true, listings: out };
}

// For the AI (the applications tool's search): one line a listing.
function describe(listings, max = 25) {
  if (!listings.length) return 'No postings found. Try other words, a wider location, or more days.';
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  return `${listings.length} postings (unverified: straight from the job boards):\n${listings.slice(0, max).map((l, i) => `${i + 1}. ${l.company || '?'} — ${l.title} · ${l.location || 'location not given'}${l.remote ? ' (remote)' : ''} · ${l.site}${l.posted ? ` · ${day(l.posted)}` : ''}${l.pay ? ` · ${l.pay}` : ''} · ${l.url}`).join('\n')}`;
}

// Python candidates in the order tried: Windows' launcher with a version JobSpy's packages have wheels for, then the plain names.
const PYTHONS = process.platform === 'win32'
  ? [['py', ['-3.12']], ['py', ['-3.11']], ['py', ['-3.13']], ['py', ['-3.10']], ['python3', []], ['python', []]]
  : [['python3.12', []], ['python3.11', []], ['python3.13', []], ['python3.10', []], ['python3', []], ['python', []]];
// "Python 3.12.13" -> true when 3.10 to 3.13.
const pythonOk = (out) => { const m = /Python (\d+)\.(\d+)/.exec(String(out)); return Boolean(m) && +m[1] === 3 && +m[2] >= 10 && +m[2] <= 13; };

module.exports = { JOBSPY_PACKAGE, JOBSPY_SKILL, SITES, SITE_NAMES, JOB_TYPES, RUNNER, PYTHONS, isJobSkill, pickSkill, searchArgs, readResults, describe, pythonOk };
