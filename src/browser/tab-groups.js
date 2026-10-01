// Tab groups: the model, automatic grouping rules, and site names. main.js owns the tabs; this
// module works on the same array through the accessors passed to createTabGroups().
const { getDomain } = require('tldts-experimental');
const knowledge = require('../features/topic-knowledge');

const GROUP_COLORS = ['blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'gray'];
// The order new groups are coloured in, and the colours that read as one another at a glance (red and pink, blue and purple ...): two groups side by side
// never share a colour, and take a look-alike only when the strip has no other left (spreadColors).
const COLOR_CYCLE = ['blue', 'orange', 'green', 'pink', 'purple', 'yellow', 'red', 'gray'];
const LOOKALIKE = { red: ['pink', 'orange'], pink: ['red', 'purple'], orange: ['red', 'yellow'], yellow: ['orange'], blue: ['purple'], purple: ['blue', 'pink'], green: [], gray: [] };

const KNOWN_SITES = {
  youtube: 'YouTube', github: 'GitHub', wikipedia: 'Wikipedia', google: 'Google', reddit: 'Reddit',
  amazon: 'Amazon', stackoverflow: 'Stack Overflow', stackexchange: 'Stack Exchange', twitter: 'X', x: 'X',
  linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', nytimes: 'NYT', bbc: 'BBC',
  medium: 'Medium', notion: 'Notion', figma: 'Figma', netflix: 'Netflix', spotify: 'Spotify',
  duckduckgo: 'DuckDuckGo', bing: 'Bing', apple: 'Apple', microsoft: 'Microsoft', mozilla: 'Mozilla',
  ycombinator: 'Hacker News', npmjs: 'npm', anthropic: 'Anthropic', openai: 'OpenAI', claude: 'Claude',
  theverge: 'The Verge', techcrunch: 'TechCrunch', arstechnica: 'Ars Technica', wired: 'Wired', engadget: 'Engadget', theguardian: 'The Guardian',
  washingtonpost: 'Washington Post', wsj: 'WSJ', cnn: 'CNN', npr: 'NPR', espn: 'ESPN', imdb: 'IMDb', ebay: 'eBay', paypal: 'PayPal',
  tiktok: 'TikTok', whatsapp: 'WhatsApp', gitlab: 'GitLab', dropbox: 'Dropbox', zoom: 'Zoom', slack: 'Slack', discord: 'Discord', twitch: 'Twitch',
  'gov.uk': 'GOV.UK', 'usa.gov': 'USA.gov', irs: 'IRS', ssa: 'SSA', nasa: 'NASA', nih: 'NIH', cdc: 'CDC', fda: 'FDA', mit: 'MIT', arxiv: 'arXiv',
};

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

// "en.wikipedia.org" -> "wikipedia.org", "news.bbc.co.uk" -> "bbc.co.uk", IPs stay as they are.
// From the Public Suffix List, private section included: every "*.github.io", "*.vercel.app" or
// "*.netlify.app" site is someone else's, so "a.github.io" and "b.github.io" are two sites.
function registrableDomain(url) {
  const host = hostname(url);
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return host;
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

// Apps that share one company domain but are different things to the user: Gmail and Docs are
// both google.com, and grouping them together as "Google" helped no one.
const PRODUCT_SITES = {
  'mail.google.com': 'Gmail', 'docs.google.com': 'Google Docs', 'drive.google.com': 'Google Drive',
  'calendar.google.com': 'Google Calendar', 'meet.google.com': 'Google Meet', 'maps.google.com': 'Google Maps',
  'photos.google.com': 'Google Photos', 'keep.google.com': 'Google Keep', 'news.google.com': 'Google News',
  'translate.google.com': 'Google Translate', 'scholar.google.com': 'Google Scholar', 'classroom.google.com': 'Classroom',
  'music.youtube.com': 'YouTube Music', 'studio.youtube.com': 'YouTube Studio',
  'outlook.live.com': 'Outlook', 'outlook.office.com': 'Outlook', 'teams.microsoft.com': 'Teams', 'onedrive.live.com': 'OneDrive',
};

// What "the same site" means when grouping by site: the registrable domain, except that each app
// above counts as a site of its own.
// Loopback and IP hosts (127.0.0.1, localhost, [::1], 0.0.0.0, a LAN address) are not a "site" in the topic sense: each port is a
// different dev server. Topic stages never join tabs on them (see isLocalHost users); "By site" keys them by host:port.
function isLocalHost(url) {
  const host = hostname(url);
  return Boolean(host) && (host === 'localhost' || host.endsWith('.localhost') || /^\d+(\.\d+){3}$/.test(host) || host.includes(':'));
}
function hostPort(url) {
  try { return new URL(url).host.toLowerCase(); } catch { return ''; }
}
function siteKey(url) {
  const host = hostname(url);
  if (isLocalHost(url)) return hostPort(url);
  return PRODUCT_SITES[host] ? host : registrableDomain(url);
}

// A short human name for a site: known names first, then a page-title suffix that matches the
// domain ("Title - Wikipedia"), then the capitalised domain label.
function siteName(url, title = '') {
  if (isLocalHost(url)) return hostPort(url);
  const product = PRODUCT_SITES[hostname(url)];
  if (product) return product;
  const domain = registrableDomain(url);
  const label = domain.split('.')[0] || domain;
  const bare = hostname(url).replace(/^www\./, '');
  if (KNOWN_SITES[bare]) return KNOWN_SITES[bare]; // "gov.uk" is a public suffix, so it has no registrable domain: the whole host names it
  if (KNOWN_SITES[label]) return KNOWN_SITES[label];
  const suffix = String(title).split(/\s+[-|–—·:]\s+/).pop()?.trim();
  if (suffix && suffix !== title && suffix.length <= 24 && suffix.split(/\s+/).length <= 3) {
    const compact = suffix.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (compact && (compact.includes(label) || label.includes(compact))) return suffix;
  }
  if (/^[\d.]+$/.test(label)) return domain;
  if (label.length <= 3 && !/[aeiouy]/.test(label)) return label.toUpperCase(); // initials: "gov", "nhs"
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Search engines' own pages never form a group.
const SEARCH_DOMAINS = new Set(['google.com', 'duckduckgo.com', 'bing.com', 'search.brave.com', 'brave.com', 'ecosia.org', 'startpage.com', 'yahoo.com', 'baidu.com', 'yandex.com', 'yandex.ru']);
// A search engine's page or one of the well-known apps (Gmail, Drive ...): never worth asking a model about.
const isAppOrSearch = (url) => Boolean(PRODUCT_SITES[hostname(url)]) || SEARCH_DOMAINS.has(registrableDomain(url));

// ---------- topics: local, private clustering of tabs by title, site and address ----------
//
// TF-IDF over each tab's words (title, site name, address path, search query) with cosine
// similarity and average-linkage clustering. Words only one tab has can't link two tabs, and
// words most tabs share say nothing, so both are dropped before comparing; unrelated tabs stay
// loose.

// The list also holds the generic title words ("explained", "basics", "tutorial", "overview", "beginners" ...): they say what kind of page it
// is, never what it is about, so two tabs sharing only one of them are not one topic ("Bond yields explained", "Transformer attention explained").
const STOPWORDS = new Set(`a an and are as at be by for from has have how i in is it its of on or our that the this to was what when where which who why will with you your
about after all also any best can com could do does get go guide home live into just like login more most new news no not now official one only other out over page
said see sign site so some than them then there these they top up us use using via vs was way we web welcome were what www html htm php aspx index amp http https
gov gouv edu official free online app video videos watch search results result edit view log docs doc wiki org net io co uk en de fr es de
help helps works time times visit deal deals thing things day days week weeks year years review reviews reviewed rated tips ideas
library libraries open source powerful comprehensive community resources ecosystem platform
// Words of everyday errands that say nothing about a topic ("near me", "buy", "8 year olds", "schedule"): a group named "Near" or "Olds" helps no one.
near nearby me my buy buying buys bought schedule schedules old olds kid kids ideas idea vs cheap local today tonight list lists check find compare calculator calculators
explain explained explains explaining explainer intuition intuitive basics basic beginner beginners introduction intro tutorial tutorials overview ultimate complete
learn lesson lessons easy simple quick fast essential essentials fundamentals everything need know understanding primer walkthrough cheatsheet cheat examples example
step steps full detailed definitive comparison compared versus faq reviewing
// Function words of the languages most tab titles come in besides English (French, Spanish, German, Portuguese):
// without them "7 jours" and "3 jours" link a weather page to a Paris itinerary.
le la les des du un une et en pour que qui dans sur avec voir jour jours par au aux pas plus est sont ce cette
el los las del una por para con como que mas dias dia paso donde libre gratis
der die das und ein eine mit von zu für auf ist im den dem
de da do dos das os um uma com para por mais
как что это для при все или его ещё тоже так уже они чем про над под без`.split(/\s+/));
const TOPIC_THRESHOLD = 0.34;
const TOPIC_HOSTS = 4; // a word that every tab says is a topic, not noise, when this many sites use it (vectorize)
const COMMON_WORD_SHARE = Number(process.env.CW || 0.9); // a word this share of the tabs carry says nothing about which group
// Small pools (2-3 loose tabs) need stronger evidence than a full cluster does before forming a
// group: fewer members corroborating the same words makes an incidental overlap more likely.
const LOOSE_PAIR_THRESHOLD = 0.5;
// After the first pass, merge already-pure sub-clusters whose pooled vocabulary (centroid) is
// close: the cross-site topic signal (esp. from page text) often only shows up once each side's
// words are pooled, even when no single pair of tabs was similar enough on its own.
const CENTROID_MERGE_THRESHOLD = 0.3;
// A word nearly every tab of ONE site has (a nav label, "flights"/"hotel deals" boilerplate) is
// that site's template, not a topic - it shouldn't count when linking two tabs of that same site.
const SITE_TEMPLATE_RATIO = 0.7;
const SITE_TEMPLATE_PENALTY = 0.15;
const SITE_DOMINANT = 0.8; // this share of a group on one site: it is named for the site
const MAX_GROUP = 40; // a bigger cluster is split again, more strictly
const TEXT_WEIGHT = 0.7; // page text (meta description/h1): more deliberate than a URL path, less than the title
const BIGRAM_VEC_WEIGHT = 0.5; // a 2-word combination is more specific than either word alone

// Brand names (site labels) are never a topic on their own: "youtube"/"reddit" etc.
const BRAND_WORDS = new Set(Object.entries(KNOWN_SITES).flatMap(([k, v]) => [k, v.toLowerCase().replace(/[^a-z0-9]/g, '')]));

// "JapanTravel" -> "Japan Travel" (subreddit and repository names are written as one word).
const camelWords = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ');

// Light Porter-style stemming: plurals, then -ing/-ed/-er with a doubled-consonant collapse
// ("running" -> "runn" -> "run"). Approximate on purpose - only used as a matching key, never shown.
function stem(w) {
  if (/^careers?$/.test(w)) return 'career'; // not "care" ("Houseplant care" is no job search)
  if (/^programm(ing|ers?)$/.test(w)) return 'programming'; // not "program" (a degree program, a TV program, a loyalty program is no coding)
  if (w === 'canvas') return w; // the school site, never "Canva" (the design tool): stems match exactly, no prefix or edit-distance links
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  let s = w;
  if (s.length > 5 && s.endsWith('ing') && /[aeiou]/.test(s.slice(0, -3))) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed') && /[aeiou]/.test(s.slice(0, -2))) s = s.slice(0, -2);
  else if (s.length > 5 && s.endsWith('er') && /[aeiou]/.test(s.slice(0, -2))) s = s.slice(0, -2);
  if (s.length > 3 && /(.)\1$/.test(s) && !/(ss|ll|ff|zz)$/.test(s)) s = s.slice(0, -1);
  if (s.length > 3 && /[^s]s$/.test(s)) s = s.slice(0, -1);
  return s;
}

// Words of a site's chrome rather than of a page's subject, and site names: never exempt from the too-common cutoff (vectorize).
const NAV_WORDS = new Set('dashboard overview settings account accounts pricing profile menu contact support cart inbox feed explore browse catalog store shop products product category categories directory archive portal'.split(' ').map(stem));
const BRAND_KEYS = new Set([...BRAND_WORDS].map(stem));
// Words of a KIND of errand or page ("student", "sales", "calendar", "post", "plan"): they never link two tabs and never name a group, so they are
// left out of every tab's vector (vectorize). A concept the word belongs to still counts (a "jobs" tab is still a jobs tab).
const GENERIC_KEYS = new Set(knowledge.GENERIC_WORDS.split(/\s+/).filter(Boolean).map(stem));
// ...and a few that may still link ("job" in a job search) but are no evidence of a topic on their own, and never name a group.
const WEAK_KEYS = new Set(knowledge.WEAK_WORDS.split(/\s+/).filter(Boolean).map(stem));
// Words that name several things (mars, mercury, bank, cell, python ...): never a link or a name on their own (knowledge.AMBIGUOUS_WORDS).
const AMBIGUOUS_KEYS = new Set(knowledge.AMBIGUOUS_WORDS.split(/\s+/).filter(Boolean).map(stem));
const VAGUE_NAME_KEYS = new Set('sierra trail trails album preorder order orders access info list lists plan plans guide guides review reviews'.split(' ').map(stem));
const CODE_AMBIGUOUS_KEYS = new Set(knowledge.CODE_AMBIGUOUS.split(/\s+/).filter(Boolean).map(stem));
// All-caps names of three letters (PCT, SAT) that are no names: a country, a file kind, a job title, a shouted word.
const GENERIC_ACRONYMS = new Set('usa faq pdf new the and for you not all any can how why who but now top diy tip vip ceo cto cfo api url css html gpu cpu app web sms gif jpg png mp3 mp4 faq pro max one two ten men fun hot sex xxx faq uk eu us'.split(' '));
const isGenericKey = (k) => GENERIC_KEYS.has(k) || WEAK_KEYS.has(k);

// Endings of Russian (and Ukrainian) nouns and adjectives: "Берлин", "Берлина", "в Берлине" are one word.
const CYRILLIC_ENDING = /(?:ами|ями|ого|его|ому|ему|ыми|ими|ией|ии|ах|ях|ов|ев|ей|ой|ом|ем|ую|юю|ая|яя|ое|ее|ые|ие|ых|их|ам|ям|ым|им|ый|ий|ию|ия|ью|а|я|ь|у|ю|ы|и|е|о)$/;
// Built-in knowledge (features/topic-knowledge.js) keyed by stem: city -> country, word -> concept,
// domain -> category.
const PLACE_OF = new Map();
for (const [country, cities] of Object.entries(knowledge.PLACES)) for (const city of cities.split(/\s+/)) PLACE_OF.set(stem(city), country);
const CONCEPT_OF = new Map();
for (const [concept, words] of Object.entries(knowledge.CONCEPTS)) for (const w of words.split(/\s+/)) CONCEPT_OF.set(stemWord(w), concept); // (stemWord: a Russian dish is one key in every case)
// A word may say a second concept besides its own (knowledge.CONCEPT_ALSO: "mortgage" is finance and housing).
const CONCEPTS_OF = new Map([...CONCEPT_OF].map(([k, c]) => [k, [c]]));
for (const [w, concept] of Object.entries(knowledge.CONCEPT_ALSO)) { const k = stem(w); CONCEPTS_OF.set(k, [...new Set([...(CONCEPTS_OF.get(k) || []), concept])]); }
// A site may be in several categories (arxiv.org: machine learning and research): host -> [category].
const CATEGORY_OF_SITE = new Map();
for (const [category, sites] of Object.entries(knowledge.SITE_CATEGORIES)) for (const site of sites.split(/\s+/)) CATEGORY_OF_SITE.set(site, [...(CATEGORY_OF_SITE.get(site) || []), category]);
const categoriesOfSite = (url) => {
  const host = hostname(url);
  const own = CATEGORY_OF_SITE.get(host) || CATEGORY_OF_SITE.get(registrableDomain(url)) || [];
  const extra = Object.entries(knowledge.SUFFIX_CATEGORIES).filter(([, sites]) => ownedByHost(host, sites)).map(([c]) => c);
  return extra.length ? [...new Set([...own, ...extra])] : own;
};
const CITY_KEYS = new Set(knowledge.CITIES.split(/\s+/).map(stem));
// A city no country is known for (Boston): a word that says where, never what. Cities PLACES knows (Tokyo) name their country too, which is a topic.
// A place a pattern stands for (an airport code, a landmark, a region: knowledge.PLACE_ALIASES) is a place too, whichever words say it.
const ALIAS_KEYS = new Set(knowledge.PLACE_ALIASES.map(([, city]) => stem(city)));
const isCityKey = (k) => (CITY_KEYS.has(k) || ALIAS_KEYS.has(k)) && !PLACE_OF.has(k);
const isPlaceKey = (k) => CITY_KEYS.has(k) || ALIAS_KEYS.has(k) || PLACE_OF.has(k) || COUNTRY_KEYS.has(k);
const ownedByHost = (host, list) => list.split(/\s+/).some((s) => host === s || host.endsWith(`.${s}`));
// Site hints (knowledge.SITE_HINTS): "Canvas is school work". Each written site becomes a rule: a
// domain (and its subdomains), a first label ("canvas.*"), or a domain plus a path prefix.
const HINT_RULES = Object.entries(knowledge.SITE_HINTS).flatMap(([hint, sites]) => sites.split(/\s+/).filter(Boolean).map((site) => {
  const [host, ...rest] = site.split('/');
  return { hint, label: host.endsWith('.*') ? host.slice(0, -2) : null, domain: host.endsWith('.*') ? null : host, path: rest.length ? `/${rest.join('/')}` : null };
}));
// The hint of a tab's site ("School", "Job search" ...), or ''. From the host and path only, never the page.
function siteHint(url) {
  const host = hostname(url).replace(/^www\./, '');
  if (!host || knowledge.HINT_EXCEPTIONS.split(' ').some((x) => host === x || host.endsWith(`.${x}`))) return '';
  if (knowledge.STATE_EDU_HOST.test(host)) return 'School'; // a state's education department (doe.mass.edu, dese.mo.gov) and a school district's site
  let pathname = '/';
  try { ({ pathname } = new URL(url)); } catch {}
  for (const r of HINT_RULES) {
    if (r.label ? !(host.startsWith(`${r.label}.`) && host.split('.').length >= 3) : !(host === r.domain || host.endsWith(`.${r.domain}`))) continue;
    if (r.path && !(pathname === r.path || pathname.startsWith(`${r.path}/`))) continue;
    return r.hint;
  }
  return '';
}
// The host a model is asked to hint about, and a learned hint is kept under: the registrable domain,
// with the first subdomain label when it says something ("canvas.northeastern.edu", but "wikipedia.org"
// for "en.m.wikipedia.org"). '' for an address, IP or single-label host that is nobody's site.
const PLAIN_LABEL = /^(www\d*|m|mobile|web|app|apps|home|secure|login|auth|account|accounts|[a-z]{2})$/;
function hintHost(url) {
  const host = hostname(url).replace(/^www\./, '');
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /\.(local|localhost|test|internal)$/.test(host)) return '';
  const domain = registrableDomain(url);
  if (!domain || host === domain) return domain || '';
  const first = host.slice(0, -(domain.length + 1)).split('.')[0];
  return PLAIN_LABEL.test(first) ? domain : `${first}.${domain}`;
}
const COUNTRY_KEYS = new Set(Object.keys(knowledge.PLACES).map(stem));
const INSTITUTION = /\.(edu|gov|mil)$|\.(ac|gov|edu)\.[a-z]{2}$/;
const PLACE_WEIGHT = 0.8; // a city names its country: nearly as good as the country written out
const CONCEPT_WEIGHT = 0.35; // "flight" and "hotel" are both travel: a nudge, never a link on its own
// Similarity-only keys (never a name): trigrams #, vector bigrams ~, repositories @, a site's own name ^, concepts %.
const isRealKey = (k) => !/^[#~@^%]/.test(k);

// A title that says nothing about the page: it is still loading, behind a bot check, or a login wall.
// Its address words describe the tab instead, so it can still join the tabs it leads to.
const TRANSIENT_TITLE = /^\s*(loading|please wait|just a moment|one moment|redirecting|attention required|access denied|checking your browser|untitled|about:blank|new tab|connecting|sign[ -]?in|log[ -]?in|sign[ -]?up|login|register|authenticating|verifying)(?![\p{L}\p{N}])/iu;
function isTransientTitle(title) {
  const t = String(title || '').trim();
  return !t || TRANSIENT_TITLE.test(t) || /^https?:\/\//i.test(t);
}

// Strip a leading/trailing " - YouTube" / " | Reddit" / " — Stack Overflow" style segment that
// just names the site: it's brand noise, not topic, and left in it clusters same-site tabs together.
function stripSiteSegment(title, url) {
  const parts = String(title).split(/\s+[-|–—·:]\s+/);
  if (parts.length < 2) return title;
  const label = registrableDomain(url).split('.')[0].replace(/[^a-z0-9]/g, '');
  const matches = (seg) => {
    const compact = seg.toLowerCase().replace(/[^a-z0-9]/g, '');
    // "The New York Times" on nytimes.com, "Wall Street Journal" on wsj.com: the initials are in the domain.
    const initials = seg.toLowerCase().replace(/^the\s+/, '').split(/\s+/).map((w) => w[0]).join('').replace(/[^a-z0-9]/g, '');
    return compact.length > 1 && (compact === label || BRAND_WORDS.has(compact) || (label && (compact.includes(label) || label.includes(compact))) || (initials.length >= 3 && seg.trim().split(/\s+/).length >= 3 && label.startsWith(initials)));
  };
  if (matches(parts[parts.length - 1])) return parts.slice(0, -1).join(' - ');
  if (matches(parts[0])) return parts.slice(1).join(' - ');
  return title;
}

// A search box's own query ("q=", "search=", ...): strong topic signal, e.g. google.com/search?q=...
function queryText(url) {
  try {
    const { searchParams } = new URL(url);
    for (const k of ['q', 'query', 'search', 'text', 'p']) { const v = searchParams.get(k); if (v) return v; }
  } catch {}
  return '';
}

// Character trigrams of a short title: titles too short to share whole words (e.g. "iPhone 15" vs
// "iPhone 16 Review") can still overlap on substrings. Only used to help sparse documents.
function charTrigrams(text) {
  const grams = [];
  for (const word of text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')) {
    if (word.length < 4 || /^\d+$/.test(word) || STOPWORDS.has(word)) continue; // no year/number noise
    for (let i = 0; i <= word.length - 3; i++) grams.push(`#${word.slice(i, i + 3)}`);
  }
  return grams;
}

// Informative tokens of a text, in order, with stem key + original surface (for naming/bigrams).
// Scripts written without spaces (or with words too short for the 3-letter floor): a run of Han, Hiragana, Katakana or Hangul
// is read as character bigrams ("東京のホテル" -> 東京, ホテ, テル), the usual stand-in for word segmentation.
const CJK = /\p{scx=Han}|\p{scx=Hiragana}|\p{scx=Katakana}|\p{scx=Hangul}/u;
const CJK_RUNS = /\p{scx=Han}+|\p{scx=Hiragana}+|\p{scx=Katakana}+|\p{scx=Hangul}+|[^\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]+/gu;
// Function words that are not topics: "如何", "これは", "おすすめ" would link tabs about nothing in common ("如何学习Python" /
// "如何做红烧肉"). A filler cuts a run in two instead of being read as bigrams, so its letters never pair with a neighbour's ("のお").
const CJK_FILLER_WORDS = [
  // Japanese
  'おすすめ', 'オススメ', 'お勧め', 'について', 'に関して', 'として', 'から', 'まで', 'より', 'ので', 'のに', 'です', 'ます', 'でした', 'ました', 'ません', 'でしょう', 'ください', 'これは', 'それは', 'あれは', 'これ', 'それ', 'あれ', 'ここ', 'そこ', 'この', 'その', 'あの', 'とは', 'では', 'には', 'など', 'まとめ', 'ランキング', 'する', 'した', 'して', 'ある', 'いる', 'なる', 'できる', 'ない',
  // Chinese
  '如何', '怎么样', '怎么', '怎样', '为什么', '是什么', '什么', '哪些', '哪个', '可以', '一个', '我们', '你们', '他们', '这个', '那个', '这些', '那些', '以及', '关于', '对于', '因为', '所以', '如果', '但是', '或者', '还是', '已经', '没有', '不是', '就是', '最新', '推荐', '大全', '官网', '首页',
  // Korean
  '추천', '방법', '하는', '하기', '무엇', '어떻게', '대한', '위한', '에서', '입니다', '합니다', '있는', '없는', '그리고', '하지만', '에게', '으로', '까지', '부터', '보다',
].sort((x, y) => y.length - x.length);
const CJK_FILLER_RE = new RegExp(CJK_FILLER_WORDS.join('|'), 'g');
const HAN_FUNCTION_CHARS = /[的了是吗呢吧也就很把被让给]/u; // Chinese grammar characters: they cut a Han run too
const KANA_PARTICLES = new Set([...'のはがをにでともやか']);
// Two letters or more left once filler and particles are taken out: something that can name a group.
const isFillerRun = (run) => [...run.replace(CJK_FILLER_RE, '')].filter((c) => !KANA_PARTICLES.has(c) && !HAN_FUNCTION_CHARS.test(c)).length < 2;
const CJK_STOP_BIGRAMS = new Set(['のお', 'おす', 'すめ', 'めの', 'れは', 'これ', 'それ', 'です', 'ます', 'ので', 'から', 'まで', 'こと', 'もの', 'ため', 'よう', '入る', '하는', '입니', '니다']);
function cjkTokens(chunk) {
  const out = [];
  for (const [run] of chunk.matchAll(CJK_RUNS)) {
    if (!CJK.test(run)) { out.push(...tokens(run)); continue; }
    const kana = /^\p{scx=Hiragana}+$/u.test(run);
    for (const piece of run.split(CJK_FILLER_RE)) {
      for (const part of /\p{scx=Han}/u.test(piece) ? piece.split(new RegExp(HAN_FUNCTION_CHARS.source, 'u')) : [piece]) {
        const chars = [...part];
        if (chars.length < 2 || (kana && chars.length < 3)) continue; // a lone character or a particle ("の", "です")
        for (let i = 0; i < chars.length - 1; i++) {
          const g = chars[i] + chars[i + 1];
          if (!CJK_STOP_BIGRAMS.has(g)) out.push({ key: g, surface: g, piece: part }); // `piece`: the whole run it was cut from (see runCompatible)
        }
      }
    }
  }
  return out;
}
// Is `cand` a whole run in `text`, as cjkTokens reads it: starting and ending where a run of one script, a filler word or a grammar
// character does, not the middle or tail of a longer word ("ース" in "ニュース")?
function wholeRunIn(text, cand) {
  const edges = new Set([0, text.length]);
  const edge = (re) => { for (const m of text.matchAll(re)) { edges.add(m.index); edges.add(m.index + m[0].length); } };
  edge(CJK_RUNS);
  edge(CJK_FILLER_RE);
  edge(new RegExp(HAN_FUNCTION_CHARS.source, 'gu'));
  for (let at = text.indexOf(cand); at >= 0; at = text.indexOf(cand, at + 1)) if (edges.has(at) && edges.has(at + cand.length)) return true;
  return false;
}
// The longest run of letters that `need` of a group's titles share ("파이썬 기초 강의" + "파이썬 기초 배우기" -> 파이썬), to name a
// CJK group whole instead of pasting two bigrams together ("파이 이썬"). '' when that run is only filler.
function sharedRun(titles, need) {
  const texts = titles.map((t) => String(t).slice(0, 80));
  const first = [...texts[0]];
  const letter = (c) => /[\p{L}\p{N}]/u.test(c);
  let best = '';
  for (let i = 0; i < first.length; i++) {
    if (!letter(first[i])) continue;
    for (let j = i + 2; j <= first.length && letter(first[j - 1]); j++) {
      const cand = first.slice(i, j).join('');
      // Named from whole runs only: "ース" is the tail of ニュース and タイガース, not a word that either title says.
      if (cand.length > best.length && !isFillerRun(cand) && texts.filter((t) => t.includes(cand)).length >= need && texts.some((t) => wholeRunIn(t, cand))) best = cand;
    }
  }
  const script = '\\p{scx=Han}\\p{scx=Hiragana}\\p{scx=Katakana}\\p{scx=Hangul}';
  return best.replace(new RegExp(`([A-Za-z0-9])(?=[${script}])|([${script}])(?=[A-Za-z0-9])`, 'gu'), (m) => `${m} `); // "Python編程" -> "Python 編程"
}
// Words that say what kind of page it is, not what it is about ("Рецепт борща", "Купить iPhone", "Погода в Москве"): the Russian
// counterpart of CJK_FILLER_WORDS. Written in any case (compared by stemWord's key), so one form of each is enough.
const RU_FILLER = new Set(`рецепт купить покупка цена погода новости лучший отзыв отзывы скачать смотреть онлайн бесплатно сегодня
вкусный простой классический быстрый домашний сайт официальный интернет заказать доставка характеристики инструкция совет способ
обзор сравнение рейтинг список вопросы такое можно нужно очень какой какие сколько почему где когда`.split(/\s+/).map((w) => stemWord(w)));
function stemWord(w) {
  if (/[Ѐ-ӿ]/.test(w)) { const base = w.length > 3 ? w.replace(CYRILLIC_ENDING, '') : w; return base.length >= 3 ? base : w; } // "борща" and "борщ" meet; never under 3 letters
  return stem(w);
}
function tokens(text) {
  const out = [];
  for (const raw of String(text).split(/[^\p{L}\p{N}]+/u)) {
    if (CJK.test(raw)) { out.push(...cjkTokens(raw)); continue; }
    const w = raw.toLowerCase();
    if (w.length < 3 || /^\d+$/.test(w) || STOPWORDS.has(w)) continue;
    const key = stemWord(w);
    if (RU_FILLER.has(key)) continue;
    out.push({ key, surface: raw });
  }
  return out;
}

// Words of one tab: stem -> { weight, surface (first seen, for naming) }. Also carries
// `.bigrams`: adjacent word pairs from the title/query, for naming a cluster "Machine Learning"
// rather than two unrelated top words.
// Code hosts: "owner/repo" identifies a project, so its issues, PRs, discussions and code pages
// belong together, and (with the repo name as a word) with the docs and questions about it.
const REPO_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
const NOT_AN_OWNER = new Set(['orgs', 'settings', 'marketplace', 'topics', 'search', 'notifications', 'pulls', 'issues', 'explore', 'sponsors', 'features', 'login', 'new', 'about', 'pricing', 'collections', 'trending', 'users', 'apps']);
function repoOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!REPO_HOSTS.has(host)) return null;
    const [owner, repo] = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
    if (!owner || !repo || NOT_AN_OWNER.has(owner)) return null;
    return { key: `@${host}/${owner}/${repo}`, name: repo, owner };
  } catch { return null; }
}

const WEAK_REPO_NAMES = new Set('api app web www site server client backend frontend core lib docs website utils tools cli sdk examples demo main test tests service services platform'.split(' '));
// "issues", "pull", "discussions" ... -> what kind of page a repo tab is (for naming "Lumen PRs").
function repoPageKind(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean)[2] || '';
    if (/^pulls?$/.test(seg)) return 'PRs';
    if (seg === 'issues') return 'issues';
    if (seg === 'discussions') return 'discussions';
  } catch {}
  return '';
}

// "ME 2380", "ENGW-1111", "cs3500a" -> "me2380", "engw1111", "cs3500a" (2-5 letters, 3-4 digits).
function courseCodes(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/(?<![\p{L}\p{N}])([A-Za-z]{2,5})[\s-]?(\d{3,4}[A-Za-z]?)(?![\p{L}\p{N}])/gu)) {
    if (/^(?:iso|rfc|http|utf|ipv|win|gpt|top|mp|usb|ram)$/i.test(m[1]) || /^(?:19|20)\d\d$/.test(m[2])) continue;
    out.add(`${m[1]}${m[2]}`.toLowerCase());
  }
  return out;
}

// A title (or address words) with its brand phrases taken out -> { text, concepts }: see knowledge.BRAND_PHRASES.
const COMMON_CAPS = new Set(knowledge.COMMON_CAPS.split(/\s+/).filter(Boolean));
// Ordinary English words ("practice", "shift", "sheet", "night"): two of them shared by two tabs are a coincidence, so a pair of shared words is only
// evidence when one of them is more than that (see sharedEvidence).
const ORDINARY_KEYS = new Set(`${knowledge.COMMON_CAPS} ${knowledge.ORDINARY_WORDS}`.split(/\s+/).filter(Boolean).map(stem));
function maskBrands(text) {
  const concepts = new Set();
  let out = String(text || '');
  for (const [re, concept] of knowledge.BRAND_PHRASES) {
    if (!re.test(out)) continue;
    for (const c of String(concept).split(' ')) if (c) concepts.add(c); // a phrase may say more than one concept ("jobs nursing")
    out = out.replace(new RegExp(re.source, 'gi'), ' ');
  }
  return { text: out, concepts };
}
function tabWords({ title = '', url = '', text = '', hint = '' }) {
  const words = new Map();
  words.pieces = new Map(); // CJK bigram -> the whole runs it came from
  const bigrams = [];
  const add = (list, weight, { naming = false, vector = false } = {}) => {
    for (let i = 0; i < list.length; i++) {
      const { key, surface, piece } = list[i];
      if (piece) { if (!words.pieces.has(key)) words.pieces.set(key, new Set()); words.pieces.get(key).add(piece); }
      const entry = words.get(key) || { weight: 0, surface };
      entry.weight = Math.max(entry.weight, weight);
      words.set(key, entry);
      // Naming bigrams are for a display name ("Machine Learning"): only from natural-language
      // text (title, search query), never the URL path - "docs/framework/react" isn't a phrase.
      if (naming && i > 0) bigrams.push({ key: `${list[i - 1].key}|${key}`, surface: `${list[i - 1].surface} ${surface}` });
      // Vector bigrams are a similarity feature, not shown: a specific 2-word combination
      // ("noise cancelling") is a stronger topic signal than either word counted alone, and
      // helps page text where adjacency survives stopword-stripping less cleanly than in titles.
      if (vector && i > 0) {
        const bkey = `~${list[i - 1].key}|${key}`;
        const bentry = words.get(bkey) || { weight: 0, surface: bkey };
        bentry.weight = Math.max(bentry.weight, BIGRAM_VEC_WEIGHT);
        words.set(bkey, bentry);
      }
    }
  };
  let pathname = '';
  try { ({ pathname } = new URL(url)); } catch {}
  const domain = registrableDomain(url);
  const label = domain.split('.')[0] || domain;
  // Reddit: the subreddit is the topic ("r/JapanTravel" = Japan Travel), whatever the thread says.
  let shownTitle = title;
  let subText = ''; // the subreddit's words ("graphic design"): they say a concept the way a title's phrase does
  if (domain === 'reddit.com') {
    const sub = /^\/r\/([^/]+)/i.exec(pathname)?.[1] || /^r\/(\w+)/i.exec(String(title))?.[1];
    if (sub) {
      subText = camelWords(sub);
      add(tokens(camelWords(sub)), 0.9);
      shownTitle = String(title).replace(/^r\/\w+\s*[-:·|]?\s*/i, '');
    }
  }
  const repo = repoOf(url);
  // "acme/billing-api" in a title: the owner is not a topic (two repos of one owner are two topics).
  if (repo) shownTitle = String(shownTitle).split(/\s+/).map((w) => (w.toLowerCase().startsWith(`${repo.owner}/`) ? w.slice(repo.owner.length + 1) : w)).join(' ');
  // An address in a title ("Inbox - mah.e@northeastern.edu - Outlook") names a mailbox, not a topic: its domain must not link the page to a university's.
  const plainTitle = isTransientTitle(title) ? '' : stripSiteSegment(shownTitle, url).replace(/\S+@\S+\.\S+/g, ' ');
  // Brand names made of everyday words ("Hilton Garden Inn", "Home Depot") are taken out before any word is read: none of them is a topic word, and the
  // brand says its own concept (a hotel chain is travel). See knowledge.BRAND_PHRASES.
  const brands = maskBrands(plainTitle);
  const cleanTitle = brands.text;
  // A site's own name is no topic. A title that is only the site's name ("Times of India", "Aaj Tak Live") says nothing about the page, and
  // a portal's name ("Naver", "Yahoo", "楽天") links its maps to its sports: those words never link two tabs.
  const hostLabels = hostname(url).split('.').filter((l) => l.length >= 4);
  const compactTitle = cleanTitle.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const nameOnly = compactTitle.length >= 4 && hostLabels.some((l) => compactTitle === l.replace(/[^a-z0-9]/g, '') || (compactTitle.includes(l) && compactTitle.length - l.length <= 4));
  const portalKeys = new Set(knowledge.PORTAL_BRANDS[label] ? [stemWord(label), ...tokens(knowledge.PORTAL_BRANDS[label]).map((t) => t.key)] : []);
  const titleTokens = nameOnly ? [] : tokens(cleanTitle).filter((t) => !portalKeys.has(t.key));
  // Words written with a capital ("Москве", "iPhone in Boston"): names of places and things. `proper` ones are capitalised in
  // the middle of a sentence-case title, where only a name is. A Title Case title capitalises everything, so says nothing.
  words.proper = new Set();
  words.capital = new Set();
  words.mixed = /\p{scx=Cyrillic}/u.test(cleanTitle) && /[A-Za-z]{3}/.test(cleanTitle); // a Russian title naming a product or brand in Latin letters
  const written = cleanTitle.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  const capitalised = written.slice(1).filter((w) => /^\p{Lu}/u.test(w) && !CJK.test(w));
  if (capitalised.length <= Math.max(1, (written.length - 1) / 2)) {
    for (const w of capitalised) for (const t of tokens(w)) { words.proper.add(t.key); words.capital.add(t.key); }
    if (written[0] && /^\p{Lu}/u.test(written[0])) for (const t of tokens(written[0])) words.capital.add(t.key);
  }
  add(titleTokens, 1, { naming: true, vector: true });
  // A university's or agency's own name in the title of its own page ("Northeastern Library") is that site's name, not a topic another page can share.
  if (INSTITUTION.test(domain)) for (const { key } of tokens(label)) { const e = words.get(key); if (e && e.weight > 0.5) e.weight = 0.5; }
  // The words of the title's first segment ("Weather in Moscow 3 - Forecastly": the part before the separator): where a topic sits, as against a site's
  // nav label or tagline, which trail. See vectorize's `exempt`.
  words.lead = new Set(tokens(cleanTitle.split(/\s+[-|–—·:]\s+/)[0]).map((t) => t.key));
  // Course and part numbers: "ME 2380", "ENGW-1111", "CS3500" are one word, and the best name a course's tabs have.
  for (const code of courseCodes(`${cleanTitle} ${text}`)) words.set(code, { weight: 1, surface: code.toUpperCase() });
  // Down-weighted, and a key of its own (^): same-site tabs shouldn't cluster on the brand alone, and
  // "canvas.northeastern.edu" must not link to a page whose title merely says "Northeastern".
  if (label && label.length >= 3 && !SEARCH_DOMAINS.has(domain)) for (const { key, surface } of tokens(label)) words.set(`^${key}`, { weight: 0.3, surface });
  add(tokens(maskBrands(decodeURIComponent(pathname).replace(/[-_]/g, ' ')).text), 0.5);
  const q = maskBrands(queryText(url)).text;
  if (q) add(tokens(decodeURIComponent(q.replace(/\+/g, ' '))), 1, { naming: true, vector: true });
  if (text) add(tokens(String(text).slice(0, 500)), TEXT_WEIGHT, { vector: true }); // optional page text (see main.js note)
  // The search a tab was opened from (main.js passes the opener's query): the page is what that search led to.
  if (hint) add(tokens(String(hint).slice(0, 200)), 0.8, { vector: true });
  if (repo) {
    words.set(repo.key, { weight: 1.2, surface: repo.name });
    add(tokens(repo.name.replace(/[-_.]/g, ' ')), 0.8);
  }
  // Airport codes, theme parks, landmarks and regions name their city, and so do a few hosts. A region's towns (Naples, Positano: the Amalfi Coast) are
  // that place and not their country's: `region` maps each word to it.
  const placed = new Set();
  const region = new Map();
  const aliasText = `${cleanTitle} ${q}`;
  for (const [re, city, own] of knowledge.PLACE_ALIASES) {
    if (!re.test(aliasText)) continue;
    placed.add(city);
    if (own) for (const m of aliasText.matchAll(new RegExp(re.source, 'gi'))) for (const t of tokens(m[0])) region.set(t.key, stem(city));
  }
  words.regional = region;
  // Places name their country, everyday words name a kind of task, well-known sites a category.
  const addConcept = (concept) => { if (!words.has(`%${concept}`)) words.set(`%${concept}`, { weight: CONCEPT_WEIGHT, surface: concept }); };
  for (const [key, { weight }] of [...words]) {
    if (weight < 0.7 || !isRealKey(key)) continue;
    const country = PLACE_OF.get(key);
    if (country && !region.has(key) && !words.has(stem(country))) words.set(stem(country), { weight: PLACE_WEIGHT, surface: country.charAt(0).toUpperCase() + country.slice(1) });
    // "chicken coop", "river bank": the word alone says no concept; "chicken thighs", "chicken soup recipe" do (food beside it)
    if (AMBIGUOUS_KEYS.has(key) && !CODE_AMBIGUOUS_KEYS.has(key) && !(key === 'chicken' && /\b(recipes?|cook\w*|bak(e|ed|ing)|roast\w*|grill\w*|fried|dinners?|lunch|meals?|thighs?|breasts?|wings?|soup|salad|sheet pan|marinade|burritos?|prep|crispy|slow cooker|instant pot)\b/i.test(`${plainTitle} ${q}`))) continue;
    for (const concept of CONCEPTS_OF.get(key) || []) {
      // "Python", "Java" and "Swift" are programming only with code beside them (a tutorial, an API, a docs site): not a ball python, coffee or a singer.
      if (concept === 'programming' && CODE_AMBIGUOUS_KEYS.has(key) && !(knowledge.CODE_CONTEXT.test(`${plainTitle} ${q}`) || categoriesOfSite(url).includes('programming'))) continue;
      addConcept(concept);
    }
  }
  for (const category of categoriesOfSite(url)) addConcept(category);
  // A coin is money too: with fewer than three crypto tabs in the window they are Finance's (conceptGroups takes Crypto first, and apart only with three).
  if (words.has('%crypto')) addConcept('finance');
  // Phrases that say a concept ("closing costs"), and what a brand is ("Hilton Garden Inn": travel), and pages whose address says what they are.
  for (const [re, concept] of knowledge.PHRASE_CONCEPTS) if (re.test(`${plainTitle} ${q} ${subText} ${isTransientTitle(title) ? '' : title}`)) addConcept(concept); // (the whole title too: a site's own name before the dash says "Toast POS", "College Board")
  for (const concept of brands.concepts) addConcept(concept);
  // A nurse's job, degree or loan is a job, a degree or a loan before it is nursing: it joins those tabs, not the clinical ones ("Nurse salary" is not
  // beside NCLEX prep). Only the tabs about the work itself keep the concept.
  if (words.has('%nursing') && ['jobs', 'education', 'finance'].some((c) => words.has(`%${c}`))) words.delete('%nursing');
  const host = hostname(url);
  for (const [re, concept] of knowledge.URL_CATEGORIES) if (re.test(`${host.replace(/^www\./, '')}${pathname}`)) addConcept(concept);
  for (const [site, city] of knowledge.SITE_PLACES) if (host === site || host.endsWith(`.${site}`)) placed.add(city);
  for (const city of placed) if ((words.get(stem(city))?.weight ?? 0) < 0.9) words.set(stem(city), { weight: 0.9, surface: city.replace(/(^|\s)\S/g, (c) => c.toUpperCase()) });
  words.retail = ownedByHost(host.replace(/^www\./, ''), knowledge.RETAIL_HOSTS);
  words.brand = label && label.length >= 4 && !BRAND_WORDS.has(label) && !SEARCH_DOMAINS.has(domain) ? label : '';
  if (titleTokens.length <= 2) for (const g of charTrigrams(cleanTitle)) if (!words.has(g)) words.set(g, { weight: 0.4, surface: g });
  words.bigrams = bigrams;
  // Distinctive names: an acronym (ASGCT, CRISPR) or a capitalised word that is not an ordinary one (Medicare, Lipofectamine) is a topic by itself when
  // another tab says it too (see distinctGroups). A shouted title or a Title Case one says nothing by its capitals.
  words.distinct = new Set();
  words.solid = new Set(); // ...of which these are no mere sentence-initial capital ("Sheet pan chicken"): acronyms, camel-case brands, names written mid-sentence
  {
    const letters = cleanTitle.replace(/[^\p{L}]/gu, '');
    const shouting = letters.length >= 8 && letters.replace(/[^\p{Lu}]/gu, '').length > letters.length * 0.6;
    // An acronym inside a longer first or last segment ("ASGCT 2026 annual meeting - Seattle") is a topic, whatever stripSiteSegment made of the segment
    // for being a site's name: it stays a word of the tab.
    const segments = maskBrands(String(shownTitle).replace(/\S+@\S+\.\S+/g, ' ')).text.split(/\s+[-|–—·:]\s+/);
    const restored = segments.filter((seg) => seg.trim().split(/[^\p{L}\p{N}]+/u).filter(Boolean).length >= 2).join(' ');
    for (const raw of `${cleanTitle} ${restored}`.split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length < 3 || !/^\p{L}+$/u.test(raw) || CJK.test(raw)) continue;
      const lower = raw.toLowerCase();
      const key = stemWord(lower);
      const acronym = !shouting && /^\p{Lu}+$/u.test(raw);
      if (raw.length === 3 && (!acronym || GENERIC_ACRONYMS.has(lower))) continue; // PCT, SAT: three letters, all capitals, and only where three titles say it (vectorize)
      // (a capital that only opens the title says nothing, and an adjective or a verb opening it least: "Affordable laptops", "Cooking for two")
      const name = /^\p{Lu}\p{Ll}+$/u.test(raw) && words.capital.has(key) && !COMMON_CAPS.has(lower) && (words.proper.has(key) || !NOT_A_NOUN.test(lower));
      // A brand written with a capital inside (GitHub, iPhone, PyTorch, OpenAI) is a rare proper noun too.
      const camel = /^\p{Lu}\p{Ll}+(\p{Lu}\p{Ll}*)+$|^\p{Ll}+\p{Lu}\p{L}*$/u.test(raw) && !shouting;
      if (!acronym && !name && !camel) continue;
      // (a page's own site's name is no name another page can share, unless it is an acronym: ASGCT's own pages say it)
      if (STOPWORDS.has(lower) || AMBIGUOUS_KEYS.has(key) || isGenericKey(key) || NAV_WORDS.has(key) || (BRAND_KEYS.has(key) && !camel) || isPlaceKey(key) || (!acronym && hostLabels.some((l) => l.replace(/[^a-z0-9]/g, '') === lower))) continue;
      if (acronym && !words.has(key)) words.set(key, { weight: 1, surface: raw });
      if ((words.get(key)?.weight ?? 0) >= 0.8) { words.distinct.add(key); if (acronym || camel || words.proper.has(key)) words.solid.add(key); }
    }
  }
  return words;
}

// Two CJK tabs are only linked by a character pair when they share a whole run of at least two characters: one tab's run is the other's
// ("ニュース" and "ニュース"; "제주도" in "제주도를"), not just the tail they happen to have in common ("ース" of ニュース and タイガース).
const runCompatible = (p, q) => [...p].some((a) => [...q].some((b) => a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))));
function dropFragmentLinks(docs) {
  const byKey = new Map();
  for (const d of docs) for (const k of d.words.pieces.keys()) { if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(d); }
  for (const [k, list] of byKey) {
    if (list.length < 2) continue;
    for (const d of list) {
      const partners = list.filter((o) => o !== d && runCompatible(d.words.pieces.get(k), o.words.pieces.get(k))).length;
      if (partners >= 1 && partners * 2 >= list.length - 1) continue;
      d.words.delete(k);
      for (const w of [...d.words.keys()]) if (w[0] === '~' && w.slice(1).split('|').includes(k)) d.words.delete(w);
    }
  }
}

// TF-IDF vectors for a set of entries, idf computed over just this set ("current tabs").
function vectorize(entries, { allowCommon = false } = {}) {
  const docs = entries.map((e) => ({ ...e, words: tabWords(e), site: isLocalHost(e.url) ? hostPort(e.url) : registrableDomain(e.url), siteKey: isLocalHost(e.url) ? '' : siteKey(e.url), siteHint: siteHint(e.url) || e.aiHint || '' }));
  const n = docs.length;
  dropFragmentLinks(docs);
  // A site's own name ("nextjs.org", "zod.dev") is brand noise between two of its own pages, but
  // it IS the topic when a page of ANOTHER site names it (Stack Overflow "Next.js ...", a GitHub
  // repo called next.js): then the site's tabs get that word at full strength, so the docs join.
  for (const d of docs) {
    const b = d.words.brand;
    if (!b || INSTITUTION.test(d.site) || ownedByHost(hostname(d.url), knowledge.SSO_HOSTS)) continue; // a university or agency's name, or a mail host's (outlook.office.com: "office"), is not a topic another page can be about
    for (const variant of new Set([b, b.replace(/(js|hq|io|py|css|ui|dev|lang|cli)$/, '')])) {
      if (variant.length < 3) continue;
      const key = stem(variant);
      const namers = docs.filter((o) => o.site !== d.site && (o.words.get(key)?.weight ?? 0) >= 0.8);
      if (namers.length) {
        d.words.set(key, { weight: 1, surface: d.words.get(key)?.surface || variant.charAt(0).toUpperCase() + variant.slice(1) });
        // A site called Zod, and pages of other sites that name it: a rare proper noun, a topic by itself for every tab that says it (see sharedEvidence).
        if (!COMMON_CAPS.has(key) && !ORDINARY_KEYS.has(key) && !isGenericKey(key)) for (const t of [d, ...namers]) { t.words.distinct.add(key); t.words.solid.add(key); }
      }
    }
  }
  // A three-letter name (a site called Zod) is too short for tabWords' `distinct`, but it is one when a page of another site writes it as a name.
  for (const d of docs) {
    const label = (d.site || '').split('.')[0];
    const key = label.length === 3 && /^[a-z]+$/.test(label) ? stem(label) : '';
    if (!key || STOPWORDS.has(label) || COMMON_CAPS.has(label) || ORDINARY_KEYS.has(key) || isGenericKey(key) || BRAND_KEYS.has(key)) continue;
    const namers = docs.filter((o) => o.site !== d.site && o.words.capital.has(key) && (o.words.get(key)?.weight ?? 0) >= 0.8);
    if (!namers.length) continue;
    if (!d.words.has(key)) d.words.set(key, { weight: 1, surface: label.charAt(0).toUpperCase() + label.slice(1) });
    for (const t of [d, ...namers]) { t.words.distinct.add(key); t.words.solid.add(key); }
  }
  const df = new Map();
  for (const d of docs) for (const key of d.words.keys()) df.set(key, (df.get(key) || 0) + 1);
  // A word nearly every tab carries is usually noise, but in a window that is all about one thing it IS the topic ("Kitten food",
  // "Kitten toys", ... on four sites). Kept (allowCommon: topicClusters asks once nothing else grouped) when it is written in the
  // titles, is no nav word or brand, and either four sites use it or it opens every title (same-site nav labels and taglines trail it).
  const exempt = new Set();
  if (n >= 4) {
    for (const [k, c] of df) {
      if (c / n <= COMMON_WORD_SHARE || !isRealKey(k) || NAV_WORDS.has(k) || BRAND_KEYS.has(k)) continue;
      const titled = docs.filter((d) => (d.words.get(k)?.weight ?? 0) >= 0.8);
      if (titled.length < 4 || titled.length < c * 0.75) continue;
      if (new Set(titled.map((d) => d.siteKey || d.url)).size >= TOPIC_HOSTS || titled.every((d) => d.words.lead.has(k))) exempt.add(k);
    }
  }
  docs.hasCommon = exempt.size > 0;
  if (!allowCommon) exempt.clear();
  const informative = (key) => df.get(key) >= 2 && (n < 4 || df.get(key) / n <= COMMON_WORD_SHARE || exempt.has(key));
  const idf = (key) => Math.log((n + 1) / (df.get(key) + 1)) + 1;
  for (const d of docs) {
    d.vec = new Map();
    d.common = new Set(); // words several tabs carry but too many to tell groups apart: still shared evidence within one group (see evidenceOf)
    for (const [key, { weight }] of d.words) {
      if (informative(key) && !GENERIC_KEYS.has(key)) d.vec.set(key, weight * idf(key));
      else if (df.get(key) >= 2 && !GENERIC_KEYS.has(key)) d.common.add(key);
    }
    // A single shared dimension makes cosine similarity exactly 1 no matter how small its weight
    // is - two tabs whose only overlap is the low-weight site label (a "youtube"/"github" that
    // was the ONLY thing they had in common) would look like a perfect match. A solo word from
    // the title or a search query (weight 1) is a real, deliberate signal ("recipe", "tokyo") and
    // can stand alone; a solo word that only made it in at a lower weight (site label, URL path,
    // page text) can't - require a second dimension to corroborate it first.
    const [soleKey] = d.vec.keys();
    const soleOk = d.vec.size === 1 && d.words.get(soleKey).weight >= 1;
    d.norm = d.vec.size >= 2 || soleOk ? Math.hypot(...d.vec.values()) : 0;
  }
  // Same-site template words: a word nearly every sampled tab of ONE site has (nav labels,
  // "flights to X" / "hotel deals" boilerplate that just happens to repeat across the couple of
  // pages we grabbed from that site) isn't topic evidence - it shouldn't help two tabs of that
  // same site look alike. But a word that's ALSO informative outside that site (it showed up on
  // at least one other site too) is exactly the cross-site topic signal we want, even if by
  // chance every one of that site's own sampled tabs happens to share it too (e.g. two docs
  // pages from the same library's own site, both mentioning the library's name) - only penalize
  // a word that is exclusively confined to this one site in the current pool.
  const bySite = new Map();
  docs.forEach((d, i) => { if (!d.site) return; if (!bySite.has(d.site)) bySite.set(d.site, []); bySite.get(d.site).push(i); });
  for (const d of docs) d.template = new Set();
  for (const idxs of bySite.values()) {
    if (idxs.length < 2) continue;
    const count = new Map();
    for (const i of idxs) for (const k of docs[i].vec.keys()) count.set(k, (count.get(k) || 0) + 1);
    for (const [k, c] of count) if (!k.startsWith('@') && !exempt.has(k) && c / idxs.length >= SITE_TEMPLATE_RATIO && df.get(k) === c) for (const i of idxs) docs[i].template.add(k);
  }
  // Words named in a title, a search or a subreddit (not only in a description) by 2+ tabs: the topic words.
  const named = new Map();
  for (const d of docs) for (const [k, { weight }] of d.words) if (weight >= 0.8 && isRealKey(k)) named.set(k, (named.get(k) || 0) + 1);
  for (const d of docs) { d.named = named; d.exempt = exempt; }
  docs.df = df;
  docs.n = n;
  for (const d of docs) d.nameKey = siteNameKey(d);
  // A three-letter acronym is a name only when three titles say it.
  {
    const short = new Map();
    for (const d of docs) for (const k of d.words.distinct) if (k.length === 3) short.set(k, (short.get(k) || 0) + 1);
    for (const d of docs) for (const k of [...d.words.distinct]) if (k.length === 3 && short.get(k) < 3) { d.words.distinct.delete(k); d.words.solid.delete(k); }
  }
  docs.distinct = new Map(); // distinctive name -> the tabs (doc indices) that say it in their title
  docs.forEach((d, i) => { for (const k of d.words.distinct || []) { if (!docs.distinct.has(k)) docs.distinct.set(k, []); docs.distinct.get(k).push(i); } });
  return docs;
}

// ---------- anchors: a topic word many tabs of two groups share ----------
//
// Cosine over whole tabs dilutes a shared topic under everything else a page says (a flights page
// and a hotels page of one trip have little else in common than "Tokyo"). So besides similarity,
// two groups are one topic when they share a specific word (title, search, description or
// subreddit; not the address path or a site's name) that at least ANCHOR_COVER of each group's tabs
// carry, and a lone tab joins a group whose tabs mostly carry a word it has too.
const ANCHOR_COVER = 0.25;
const ANCHOR_OWN_NAMED = 4; // ...and it is named in 4+ titles (a word two tabs happen to share doesn't characterise anything)
const ANCHOR_OWN = 0.6;
const ANCHOR_OWN_OTHER = 0.3; // ...and only when the other group has something of its own too // a word this share of a group's tabs carry characterises it
const ANCHOR_MAX_DF = 0.92; // a word nearly every tab carries says nothing about which group
function strongSet(d) {
  if (!d.strong) {
    d.strong = new Set();
    for (const k of d.vec.keys()) {
      const weight = d.words.get(k)?.weight ?? 0;
      if (isRealKey(k) && (weight >= 0.8 || (weight >= 0.7 && (d.named.get(k) || 0) >= 2))) d.strong.add(k);
    }
  }
  return d.strong;
}
const strongCounts = (list) => {
  const m = new Map();
  for (const d of list) for (const k of strongSet(d)) m.set(k, (m.get(k) || 0) + 1);
  return m;
};
// -> { key, score } for the best shared word, or null. ca/cb: precomputed strongCounts (optional).
function anchorLink(A, B, df, n, ca = strongCounts(A), cb = strongCounts(B)) {
  const cands = []; // the shared words that pass every test below: one of them is never enough (see sharedEvidence), so they are weighed together at the end
  // No word in common, no link (and no need to work out what either group is characterised by).
  if (!(ca.size <= cb.size ? [...ca.keys()].some((k) => cb.has(k)) : [...cb.keys()].some((k) => ca.has(k)))) return null;
  // A group (3+ tabs) characterised by a word the other never has (a kitchen renovation, a Tokyo
  // trip) is not the other's topic just because they share a common word (budget, itinerary). A
  // shared word only overrides that when it characterises the group as much as its own word does
  // (every Tokyo tab says Tokyo, whatever else it says), or is a country (Tokyo and Kyoto: Japan).
  const ownMax = (counts, size, other, named) => (size >= 3 ? Math.max(0, ...[...counts].filter(([k]) => !other.has(k) && !CONCEPT_OF.has(k) && (named.get(k) || 0) >= ANCHOR_OWN_NAMED).map(([, c]) => c / size)) : 0);
  const named = A[0].named;
  const ownA = ownMax(ca, A.length, cb, named);
  const ownB = ownMax(cb, B.length, ca, named);
  for (const [k, a] of ca) {
    const b = cb.get(k);
    if (!b || (n >= 8 && df.get(k) / n > ANCHOR_MAX_DF && !A[0].exempt.has(k))) continue;
    // A place is one topic's anchor only for tabs that are about travel or housing (a bus to Boston and a Boston flat are not the ramen in Boston).
    if (isPlaceKey(k) && !['travel', 'housing'].some((c) => A.filter((d) => d.words.has(`%${c}`)).length * 2 > A.length && B.filter((d) => d.words.has(`%${c}`)).length * 2 > B.length)) continue;
    // A lone tab that names a product or brand and only shares a place with the group ("Купить iPhone в Москве" among
    // Moscow weather and news) is not of that topic: same rule as cosine()'s.
    const lone = A.length === 1 ? A[0] : B.length === 1 ? B[0] : null;
    if (lone?.words.mixed && lone.words.capital.has(k) && lone.words.proper.has(k) && ownWords(lone) >= 2) continue;
    const fa = a / A.length;
    const fb = b / B.length;
    const strict = a >= Math.min(2, A.length) && b >= Math.min(2, B.length) && fa >= ANCHOR_COVER && fb >= ANCHOR_COVER;
    // A small group (a pull-request list, two docs pages) joins a big one that mostly carries the word, even on one tab.
    const core = (big, count, frac, other, ofrac) => big >= 4 && count >= 3 && frac >= 0.5 && other >= 1 && ofrac >= ANCHOR_COVER;
    if (!strict && !core(A.length, a, fa, b, fb) && !core(B.length, b, fb, a, fa)) continue;
    if (!COUNTRY_KEYS.has(k) && ((ownA >= ANCHOR_OWN && fa < ownA - 1e-9 && ownB >= ANCHOR_OWN_OTHER) || (ownB >= ANCHOR_OWN && fb < ownB - 1e-9 && ownA >= ANCHOR_OWN_OTHER))) {
      if (process.env.DBG_ANCHOR) console.error(`VETO [${A.map((d) => d.title.slice(0, 14)).join(' / ')}] + [${B.map((d) => d.title.slice(0, 14)).join(' / ')}] via ${k} fa=${fa.toFixed(2)} fb=${fb.toFixed(2)} own=${ownA.toFixed(2)},${ownB.toFixed(2)} cos=${cosine(centroidOf(A), centroidOf(B)).toFixed(2)}`);
      continue;
    }
    cands.push({ key: k, score: Math.min(fa, fb) * (Math.log((n + 1) / (df.get(k) + 1)) + 1) });
  }
  // A place beside travel or housing words on both sides (checked above) and a distinctive name (an acronym, a rare proper noun) link alone; any other word
  // needs a second one, one of them no ordinary English word.
  const distinct = (k) => [...A, ...B].some((d) => d.words.solid?.has(k)) || ([...A, ...B].filter((d) => holdsName(d, k)).length >= 2 && [...A, ...B].some((d) => d.words.distinct?.has(k)));
  const alone = cands.filter((c) => isPlaceKey(c.key) || distinct(c.key));
  const plain = cands.filter((c) => !alone.includes(c) && !NAV_WORDS.has(c.key) && !BRAND_KEYS.has(c.key) && !isGenericKey(c.key));
  const pooled = plain.length >= 2 && plain.some((c) => !ORDINARY_KEYS.has(c.key)) ? plain : [];
  let best = null;
  for (const c of [...alone, ...pooled]) if (!best || c.score > best.score) best = c;
  return best;
}

// ---------- the one rule: what two tabs (or a tab and a group, or two groups) must share before they are linked ----------
//
// A SINGLE shared word is never enough, anywhere ("sheet" in a cheat sheet and a sheet-pan recipe, "practice", "shift", "study"): twelve rounds of
// patching one word at a time never converged. Two things link only with one of
//   1. a shared concept (knowledge.CONCEPTS: nursing, travel, finance ...) that most of each side carries;
//   2. the same site (the existing same-site rules decide how much it is worth: siteJoin, SAME_SITE_LINK);
//   3. two shared topic words, exact stems (no prefix or edit-distance matches: "Canva" is not "Canvas"), at least one of them no ordinary English word;
//   4. a shared run of CJK characters (dropFragmentLinks keeps only whole runs);
//   5. a distinctive name (an acronym or a rare proper noun: tabWords `distinct`) one of them says and the other has too, or a shared repository.
// A place is never one of these words: it links tabs only beside travel or housing words, which are a concept (1). Every path that links tabs asks
// this one function: cosine (and so the clustering, the centroid merge, the absorb, the pulls and the mega-group split), anchorLink, pairShares and
// the cohesion check (supportsOf) - so nothing a stage lets through can stay a group on one coincidental word.
// Does this tab (or group) hold the distinctive name k: its title says it, or it is on the site called that (ASGCT's own pages)?
const holdsName = (x, k) => Boolean(x.words?.distinct?.has(k) || x.nameKey === k || x.words?.nameKeys?.has(k));
// A distinctive name is shared by two tabs: one of them writes it as a name (an acronym, a camel-case brand, a capital mid-sentence) and the other has the word;
// or both hold it (a capital at the start of a title is a name only when another title or a site of that name says it too: "Sheet pan chicken" is no "Sheet").
const sharesName = (a, b, k) => Boolean(a.words?.solid?.has(k) || b.words?.solid?.has(k)) || (holdsName(a, k) && holdsName(b, k) && Boolean(a.words?.distinct?.has(k) || b.words?.distinct?.has(k)));
const SHARE_WORD = 0.25; // a group's word counts as shared when this share of its tabs carry it
const SHARE_CONCEPT = 0.5; // ...and its concept when most of them do
function sharedEvidence(a, b) {
  if (a.siteKey && a.siteKey === b.siteKey && siteGroupable(a)) return true;
  let words = 0;
  let uncommon = false;
  let travel = false; // travel is a broad concept: a trip needs a place both name (below)
  let place = false;
  for (const k of a.vec.keys()) {
    if (!b.vec.has(k)) continue;
    const lead = k[0];
    if (lead === '#' || lead === '^' || lead === '~') continue; // letter fragments, a site's own name and word pairs are never words of their own
    const [sa, sb] = [a.share ? a.share.get(k) || 0 : 1, b.share ? b.share.get(k) || 0 : 1]; // a group: the share of its tabs that carry it
    if (lead === '%') { if (k !== '%shopping' && sa >= SHARE_CONCEPT && sb >= SHARE_CONCEPT) { if (k === '%travel' && Math.max(a.n || 1, b.n || 1) < 3) travel = true; else return true; } continue; }
    if (lead === '@') return true; // a repository both name
    if (CJK.test(k)) return true;
    if (isRealKey(k) && isPlaceKey(k)) { place = true; continue; }
    if (!isRealKey(k) || NAV_WORDS.has(k) || isGenericKey(k) || Math.min(sa, sb) < SHARE_WORD) continue;
    if (sharesName(a, b, k)) return true; // a distinctive name (a brand too, GitHub, when a page that is not its own names it)
    if (a.exempt?.has(k)) return true; // the window's own topic: a word that every tab carries and several sites write in their titles (vectorize keeps it only then)
    if (BRAND_KEYS.has(k)) continue;
    words++;
    if (!ORDINARY_KEYS.has(k)) uncommon = true;
  }
  // A place counts as one of the two words, beside a topic word that is no ordinary one ("Kyoto temples"); never twice (Tokyo and Japan), never alone.
  return (uncommon && (words >= 2 || place)) || (travel && place) || joinsBigTrip(a, b) || joinsBigTrip(b, a);
}
// A big trip (a Japan trip of SPLIT_PLACE_TOPIC+ tabs, most of them its place) takes in a tab that names that place and nothing else of its own - a
// map pin, a restaurant list ("Tokyo - Google Maps") - the one case where a place alone links. Never a tab that is about something else: a job, a flat.
function joinsBigTrip(group, tab) {
  if (!group.share || group.n < SPLIT_PLACE_TOPIC || tab.n >= SPLIT_PLACE_TOPIC || (group.share.get('%travel') || 0) < SHARE_CONCEPT) return false;
  for (const k of tab.vec.keys()) if (k[0] === '%' && k !== '%shopping') return false;
  for (const k of tab.vec.keys()) if (isRealKey(k) && isPlaceKey(k) && (group.share.get(k) || 0) >= 0.6) return true;
  return false;
}

function cosine(a, b, gated = true) {
  if (!a.norm || !b.norm) return 0;
  const sameSite = Boolean(a.site) && a.site === b.site;
  let dot = 0;
  let sharedReal = 0; // shared dimensions NOT already discounted as same-site template noise
  let soleKey = null;
  let trigrams = 0;
  let cities = 0; // shared city words, and whether anything beside places and the like is shared (see below)
  let beyondPlaces = false;
  for (const [k, v] of a.vec) if (b.vec.has(k)) {
    const templated = sameSite && a.template?.has(k);
    dot += v * b.vec.get(k) * (templated ? SITE_TEMPLATE_PENALTY : 1);
    if (!templated && k[0] !== '^') { sharedReal++; soleKey = k; } // a shared site name never counts as a second word
    if (k[0] === '#') trigrams++;
    else if (!templated && k[0] !== '^') {
      if ((k[0] === '%' && k !== '%shopping') || (k[0] !== '%' && !isPlaceKey(k))) beyondPlaces = true; // a city links tabs only beside a topic word or a (non-shopping) concept they share
      else if (k[0] !== '%' && isCityKey(k)) cities++;
      else if (k[0] !== '%' && !(a.title !== undefined && b.title !== undefined)) beyondPlaces = true; // a country shared by a group's pooled words (Japan) is a topic; a city with no country (Boston) is not
    }
  }
  // Two pages that share a city and nothing else ("Best ramen in Boston", "Boston rent prices", "Boston to NYC bus tickets") are not one topic:
  // a city only counts beside a travel or housing word. A group's pooled words (a centroid) count a shared country too, so a Tokyo weather page can still join a Japan trip.
  // (A country or a city PLACES knows can link two tabs, but a group it bridges between different topics is split afterwards: splitPlaceBridges.)
  if (cities && !beyondPlaces) return 0;
  // Three letter fragments alone ("documentation" / "compilation") are a coincidence unless there are many.
  if (trigrams === sharedReal && trigrams < 5) return 0;
  if (gated && !sharedEvidence(a, b)) return 0; // one word, or letter fragments, or a place: no link (see sharedEvidence)
  // Two otherwise-unrelated tabs whose only REAL overlap is one word: trust it only if that word
  // was strong (title/query weight) in both, same reasoning as the solo-dimension case above. A
  // template-discounted word doesn't count towards "real" overlap, so it can't pad the count and
  // sneak a second, coincidental word (two different senses of "machine", say) past this gate.
  if (sharedReal <= 1 && !((a.words?.get(soleKey)?.weight ?? 1) >= 1 && (b.words?.get(soleKey)?.weight ?? 1) >= 1)) return 0;
  // A place both titles mention and nothing else, where one title also names a product or brand ("Погода в Москве" /
  // "Купить iPhone в Москве"): a shared city doesn't make them one topic. Words only one tab has can't link, but they
  // still show what else the tab is about.
  // A shop's page and another site's page that share one word ("Target: Back to school", "School district calendar"): the shop is for
  // buying, not for what the word is about.
  if (sharedReal <= 1 && Boolean(a.words?.retail) !== Boolean(b.words?.retail) && CONCEPT_OF.get(soleKey) !== 'shopping') return 0;
  if (sharedReal === 1 && (a.words?.mixed || b.words?.mixed) && a.words?.capital?.has(soleKey) && b.words?.capital?.has(soleKey) && (a.words.proper.has(soleKey) || b.words.proper.has(soleKey))) return (dot / (a.norm * b.norm)) / (1 + NAME_ONLY_PENALTY * (ownWords(a) + ownWords(b)));
  return dot / (a.norm * b.norm);
}
const NAME_ONLY_PENALTY = 1;
// Title/search words of a tab that no other tab shares (dropped from its vector as uninformative).
function ownWords(d) {
  if (d.own === undefined) { d.own = 0; for (const [k, { weight }] of d.words || []) if (weight >= 0.8 && isRealKey(k) && !d.vec.has(k)) d.own += d.words.mixed && /^[a-z0-9]+$/.test(k) ? 3 : 1; } // a brand written in Latin letters among Russian words says a lot
  return d.own;
}

// A group's centroid: the average of its members' vectors, comparable to a loose tab's vector.
function centroidOf(docs) {
  const vec = new Map();
  // A member's own same-site-template words get discounted here too, the same as in cosine():
  // without this, comparing a straggler tab to this pooled centroid loses the sameSite check
  // (a centroid isn't "on" any one site), and boilerplate the straggler shares with just ONE
  // member's site could leak it into the wrong cluster.
  for (const d of docs) for (const [k, v] of d.vec) {
    const scaled = (d.template?.has(k) ? SITE_TEMPLATE_PENALTY : 1) * v;
    vec.set(k, (vec.get(k) || 0) + scaled / docs.length);
  }
  // The strongest weight any member gave each word, so the one-shared-word rule in cosine() applies to a group too.
  const words = new Map();
  for (const d of docs) for (const [k, { weight }] of d.words || []) if (vec.has(k) && weight > (words.get(k)?.weight ?? 0)) words.set(k, { weight });
  // A name all over the group (every member that has the word writes it capitalised), and what else its members say, for cosine()'s name-only rule.
  words.mixed = docs.some((d) => d.words?.mixed);
  words.retail = docs.filter((d) => d.words?.retail).length * 2 > docs.length;
  words.capital = new Set([...vec.keys()].filter((k) => docs.every((d) => !d.vec.has(k) || d.words?.capital?.has(k))));
  words.proper = new Set([...words.capital].filter((k) => docs.some((d) => d.words?.proper?.has(k))));
  words.distinct = new Set([...vec.keys()].filter((k) => docs.some((d) => d.words?.distinct?.has(k))));
  words.nameKeys = new Set(docs.map((d) => d.nameKey).filter(Boolean)); // the sites' own names (see holdsName)
  words.solid = new Set([...vec.keys()].filter((k) => docs.some((d) => d.words?.solid?.has(k))));
  const share = new Map(); // how many of the group's tabs carry each word (sharedEvidence: a word one tab of twenty has is not the group's)
  for (const d of docs) for (const k of d.vec.keys()) share.set(k, (share.get(k) || 0) + 1 / docs.length);
  return { vec, norm: Math.hypot(...vec.values()), words, share, n: docs.length, exempt: docs[0]?.exempt, own: docs.reduce((n, d) => n + ownWords(d), 0) / docs.length };
}

// A cluster's centroid, remembered per cluster array: a cluster that has not grown is not pooled again (the merge loops compare every
// pair of clusters every round, and rebuilding both centroids each time made organizing a few hundred tabs freeze the window).
const centroidCache = new WeakMap();
function clusterCentroid(c, docs) {
  const hit = centroidCache.get(c);
  if (hit && hit.n === c.length && hit.docs === docs) return hit.value;
  const value = centroidOf(c.map((k) => docs[k]));
  centroidCache.set(c, { n: c.length, docs, value });
  return value;
}

// A library or product whose own site is in the cluster and whose name most of the cluster's tabs carry
// (its docs, a Stack Overflow question, its repo): the cluster is named for it, as its site writes it
// ("Tailwind CSS", "Zod"), rather than for the most frequent word or phrase.
const brandVariants = (b) => new Set([b, b.replace(/(js|hq|io|py|css|ui|dev|lang|cli)$/, '')]);
function libraryName(members, majority) {
  for (const d of members) {
    const b = (d.site || '').split('.')[0];
    if (!b || b.length < 3 || BRAND_WORDS.has(b) || SEARCH_DOMAINS.has(d.site)) continue;
    for (const variant of brandVariants(b)) {
      if (variant.length < 3) continue;
      const key = stem(variant);
      if (members.filter((m) => m.vec.has(key)).length >= majority && members.filter((m) => m.site === d.site).length >= 2) return siteName(d.url, d.title);
    }
  }
  return '';
}

// One place word must not bridge several topics: a group whose tabs are linked by a city or country (Berlin, India) but that holds tabs
// of two or more specific topics (a trip, a flat, a football club) keeps the topic most of its tabs carry; a tab of another topic goes
// loose, and so does a tab that carries no topic of its own and shares nothing with the rest but the place ("Gewerbeanmeldung Berlin" among
// trains and flights, the Times of India among Goa hotels). A group that is all one topic, or one topic and tabs of no topic that say more
// than the place, is left whole when it is big (a Japan trip with its subway pass and restaurant pages); a small one keeps only the tabs that do.
const SPLIT_MIN_GROUP = 3;
const SPLIT_PLACE_TOPIC = 6;
function splitPlaceBridges(clusters, docs) {
  const loose = [];
  const out = clusters.map((c) => {
    if (c.length < SPLIT_MIN_GROUP) return c;
    const conceptsOf = (i) => [...docs[i].words.keys()].filter((k) => k[0] === '%' && docs[i].vec.has(k));
    const placeCount = new Map();
    for (const i of c) for (const k of docs[i].vec.keys()) if (isRealKey(k) && isPlaceKey(k)) placeCount.set(k, (placeCount.get(k) || 0) + 1);
    if (![...placeCount.values()].some((n) => n >= 2)) return c;
    const count = new Map();
    for (const i of c) for (const k of conceptsOf(i)) count.set(k, (count.get(k) || 0) + 1);
    const ranked = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return c;
    const main = ranked[0][0];
    const others = c.filter((i) => { const k = conceptsOf(i); return k.length && !k.includes(main); });
    if (!others.length && c.length >= SPLIT_PLACE_TOPIC) return c; // a big group of one topic, its place in most of it (a Japan trip with its subway pass and restaurant pages)
    const counts = strongCounts(c.map((i) => docs[i]));
    const keep = c.filter((i) => {
      const k = conceptsOf(i);
      if (k.includes(main)) return true;
      if (k.length) return false;
      // No topic of its own: stays only with a word, beyond the place, that another member says too.
      return [...strongSet(docs[i])].some((w) => !isPlaceKey(w) && (counts.get(w) || 0) >= 2);
    });
    if (keep.length < 2) return c;
    const stay = new Set(keep);
    for (const i of c) if (!stay.has(i)) { loose.push([i]); (docs.apart ||= new Map()).set(i, stay); } // anchorMerge must not take them back on the same place word
    return keep;
  });
  return out.concat(loose);
}

// A tab in a group of 6+ that shares no topic word with a fair part of the group (a weather page that
// only says "Boston" among flights to Tokyo) and is not close to the group's centre is let go.
const PRUNE_MIN_GROUP = 6;
function pruneWeak(clusters, docs) {
  const loose = [];
  const out = clusters.map((c) => {
    if (c.length < PRUNE_MIN_GROUP) return c;
    const counts = strongCounts(c.map((i) => docs[i]));
    const need = Math.max(2, Math.ceil(0.2 * c.length));
    const keep = c.filter((i) => {
      const d = docs[i];
      if ([...strongSet(d)].some((k) => (counts.get(k) || 0) - 1 >= need)) return true;
      const rest = c.filter((j) => j !== i).map((j) => docs[j]);
      return cosine(d, centroidOf(rest)) >= PRUNE_KEEP_COSINE;
    });
    for (const i of c) if (!keep.includes(i)) loose.push([i]);
    return keep;
  });
  return out.concat(loose);
}
const PRUNE_KEEP_COSINE = 0.25;

// clusters: arrays of doc indices. Merges the pair with the best shared anchor until none is left.
function anchorMerge(clusters, docs) {
  const out = clusters.map((c) => [...c]);
  const counts = out.map((c) => strongCounts(c.map((i) => docs[i])));
  const apart = (X, Y) => X.some((a) => docs.apart?.has(a) && Y.some((b) => docs.apart.get(a).has(b)));
  // A pair's link is kept until one of its clusters changes (the arrays are replaced when merged).
  const linkOf = new Map();
  const linkBetween = (i, j) => {
    let row = linkOf.get(out[i]);
    if (!row) linkOf.set(out[i], (row = new Map()));
    if (!row.has(out[j])) row.set(out[j], anchorLink(out[i].map((k) => docs[k]), out[j].map((k) => docs[k]), docs.df, docs.n, counts[i], counts[j]));
    return row.get(out[j]);
  };
  for (;;) {
    let best = null;
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (out[i].length < 2 && out[j].length < 2) continue; // two lone tabs: pass one already compared them
        let link = linkBetween(i, j);
        if (link && isPlaceKey(link.key) && docs.apart && (apart(out[i], out[j]) || apart(out[j], out[i]))) link = null; // split off from that group for bridging topics with this very word
        if (link && (!best || link.score > best.score)) best = { i, j, score: link.score, key: link.key };
      }
    }
    if (!best) return out;
    if (process.env.DBG_ANCHOR) console.error(`MERGE [${out[best.i].map((k) => docs[k].title.slice(0, 18)).join(' / ')}] + [${out[best.j].map((k) => docs[k].title.slice(0, 18)).join(' / ')}] via ${best.key} ${best.score.toFixed(2)}`);
    out[best.i] = out[best.i].concat(out[best.j]);
    counts[best.i] = strongCounts(out[best.i].map((k) => docs[k]));
    out.splice(best.j, 1);
    counts.splice(best.j, 1);
  }
}

// Fourth stage: a small group (or a lone tab) that shares a specific concept with a bigger group
// joins it ("Dutch Oven" bread tabs into "Sourdough", an offer-negotiation pair into a job search).
// Only when most of both sides carry that concept, the big side has 4+ tabs, and their pooled words
// are not unrelated; the best-fitting big group wins.
const ABSORB_MAX = 3;
const ABSORB_MIN_COS = 0.04;
function conceptAbsorb(clusters, docs) {
  const out = clusters.map((c) => [...c]);
  const conceptsOf = (c) => {
    const m = new Map();
    for (const i of c) for (const k of docs[i].vec.keys()) if (k[0] === '%') m.set(k, (m.get(k) || 0) + 1);
    return new Set([...m].filter(([, n]) => n / c.length > 0.5).map(([k]) => k));
  };
  for (let changed = true; changed;) {
    changed = false;
    const sets = out.map(conceptsOf);
    for (let s = 0; s < out.length; s++) {
      if (out[s].length > ABSORB_MAX || !sets[s].size || ofRepoCluster(out[s], docs)) continue; // a project's own pages stay its own
      let best = null;
      for (let b = 0; b < out.length; b++) {
        if (b === s || out[b].length < 4 || out[b].length <= out[s].length || ofRepoCluster(out[b], docs)) continue;
        if (![...sets[s]].some((k) => sets[b].has(k))) continue;
        const cos = cosine(clusterCentroid(out[s], docs), clusterCentroid(out[b], docs));
        if (cos >= ABSORB_MIN_COS && (!best || cos > best.cos)) best = { b, cos };
      }
      if (!best) continue;
      out[best.b] = out[best.b].concat(out[s]);
      out.splice(s, 1);
      changed = true;
      break;
    }
  }
  return out;
}

// Fifth stage: the tabs still loose after every word-based stage, placed by their site alone.
//  - A tab of a hinted site (Canvas: "School") joins the group most of whose tabs have that hint, even
//    with no word in common ("Dashboard" on Canvas goes with the course's other Canvas tabs); with two
//    such groups (two courses), the one its words fit best.
//  - A tab of any other site joins the group most of whose tabs are that same site, when it shares at
//    least a little with them (SAME_SITE_MIN_COS): the site is strong evidence, not enough on its own,
//    since two YouTube videos are rarely one topic.
//  - What is still loose then forms groups: 2+ tabs of one hint (named for it), and tabs of one site
//    that share a few words (SAME_SITE_LINK, well under the 0.34 / 0.5 two tabs of different sites
//    need). Same-site tabs with nothing in common (a tyre video and a stock-market video) stay loose:
//    grouping by site alone is what the "By site" mode is for. Groups already formed on words are
//    never merged here, so two courses on Canvas stay two groups.
// Search engines and the well-known apps (Gmail, Drive ...) are never a site group. Returns the new
// clusters and, for the ones a hint formed, that hint (by cluster, for naming).
const SAME_SITE_MIN_COS = 0.05;
const SAME_SITE_LINK = 0.15;
const siteGroupable = (d) => Boolean(d.siteKey) && !isAppOrSearch(d.url);
function siteJoin(clusters, docs) {
  const out = clusters.map((c) => [...c]);
  const hinted = new Map(); // cluster (array) -> hint it was formed on
  const majority = (c, pred) => c.filter((i) => pred(docs[i])).length * 2 > c.length;
  // minCos: what the tab must share with the group's words. With one such group it may be 0 (the
  // hint alone decides); with several (two repos on GitHub, two courses) the site can't tell which,
  // so only a tab that shares words with one of them (SAME_SITE_MIN_COS) joins it.
  const joinBest = (i, pred, minCos) => {
    const d = docs[i];
    const fits = out.filter((c) => c.length >= 2 && majority(c, pred)).map((c) => ({ c, cos: cosine(d, clusterCentroid(c, docs)) }));
    const need = fits.length > 1 ? Math.max(minCos, SAME_SITE_MIN_COS) : minCos;
    const best = fits.filter((f) => f.cos >= need).sort((a, b) => b.cos - a.cos || b.c.length - a.c.length)[0];
    if (best) best.c.push(i);
    return Boolean(best);
  };
  const loose = [];
  for (const c of out) if (c.length === 1) loose.push(c[0]);
  const linking = (d) => (d.siteHint && !knowledge.BROAD_HINTS.has(d.siteHint) ? d.siteHint : ''); // "Code" never links
  const still = loose.filter((i) => {
    const d = docs[i];
    if (linking(d) && joinBest(i, (o) => o.siteHint === d.siteHint, 0)) return false;
    if (siteGroupable(d) && joinBest(i, (o) => o.siteKey === d.siteKey, SAME_SITE_MIN_COS)) return false;
    return true;
  });
  const fresh = [];
  const byHint = new Map();
  for (const i of still) if (linking(docs[i])) { if (!byHint.has(docs[i].siteHint)) byHint.set(docs[i].siteHint, []); byHint.get(docs[i].siteHint).push(i); }
  const taken = new Set();
  for (const [hint, list] of byHint) if (list.length >= 2) { fresh.push(list); hinted.set(list, hint); list.forEach((i) => taken.add(i)); }
  const bySite = new Map();
  for (const i of still) if (!taken.has(i) && siteGroupable(docs[i])) { if (!bySite.has(docs[i].siteKey)) bySite.set(docs[i].siteKey, []); bySite.get(docs[i].siteKey).push(i); }
  // Average linkage again, among one site's loose tabs only, at the lower same-site bar. The site's
  // template words stay discounted (cosine() does that): "Web APIs | MDN" on two MDN pages, or two
  // repos' shared description words, are the site's style, not a topic the two tabs share.
  for (const list of bySite.values()) {
    if (list.length < 2) continue;
    // A workspace's pages on one SaaS domain (acme.atlassian.net: a Jira board, a Confluence page) are one group whatever their titles say.
    if (knowledge.SAAS_DOMAINS[docs[list[0]].siteKey]) { fresh.push(list); list.forEach((i) => taken.add(i)); continue; }
    const parts = list.map((i) => [i]);
    for (;;) {
      let best = null;
      for (let a = 0; a < parts.length; a++) for (let b = a + 1; b < parts.length; b++) {
        let s = 0;
        for (const x of parts[a]) for (const y of parts[b]) s += cosine(docs[x], docs[y]);
        s /= parts[a].length * parts[b].length;
        if (s >= SAME_SITE_LINK && (!best || s > best.s)) best = { a, b, s };
      }
      if (!best) break;
      parts[best.a] = parts[best.a].concat(parts[best.b]);
      parts.splice(best.b, 1);
    }
    for (const p of parts) if (p.length >= 2) { fresh.push(p); p.forEach((i) => taken.add(i)); }
  }
  const joined = new Set(loose.filter((i) => !still.includes(i)));
  const kept = out.filter((c) => !(c.length === 1 && (joined.has(c[0]) || taken.has(c[0]))));
  return { clusters: kept.concat(fresh), hinted };
}

// Sixth stage: a concept that names one topic (knowledge.CONCEPT_GROUPS: finance, machine learning, fitness, plants) draws together
// the tabs still loose or in small groups that mostly carry it, though they share no word ("Roth IRA", "Vanguard funds", "401k
// rollover"; Coursera, arXiv and Distill): three tabs or more make a group named for the concept. A big group that mostly carries it
// takes them in instead, and a tab that carries it in a group that mostly doesn't ("PyTorch tutorials" among Python pages) moves to it.
// Returns the new clusters and the ones that were drawn together (by cluster, for naming).
const CONCEPT_SMALL = 3;
const CONCEPT_PULL_MAX_COS = 0.6; // a tab this close to the rest of its group stays there
// Also: in a small window (CONCEPT_SMALL_WINDOW tabs or fewer) every group that mostly carries the concept is one group ("Sourdough" and
// "Bread" in a window of five bakers' tabs); two loose tabs that both carry it strongly (CONCEPT_PAIR_HITS words each) make a pair; and a
// pair of two tabs that carry different concepts ("Bond yields explained", "Transformer attention explained") is no pair at all.
const CONCEPT_SMALL_WINDOW = 12;
const CONCEPT_PAIR_HITS = 2;
// A project's own pages (a repo's code, issues and PRs) are that project's, whatever they are about: more than half of the cluster, or half, are one repo's.
function ofRepoCluster(c, docs) {
  const n = new Map();
  for (const i of c) { const r = repoOf(docs[i].url); if (r) n.set(r.name, (n.get(r.name) || 0) + 1); }
  return c.length >= 2 && Math.max(0, ...n.values()) * 2 >= c.length;
}
const SUBNAMES = Object.fromEntries(Object.entries(knowledge.CONCEPT_SUBNAMES || {}).map(([concept, list]) => [concept, list.map(([name, words]) => [name, new Set(words.split(/\s+/).map(stem))])]));
// The narrower name for a concept group (Python for a pandas, NumPy and Django window): the first (language) name that more than half
// of the tabs carry a word of, and no tab of another one does. A window of Python, JavaScript and CSS is "Programming".
function subName(concept, c, docs) {
  const subs = SUBNAMES[concept] || [];
  const carries = (i, words) => [...words].some((k) => docs[i].words.has(k));
  const hit = subs.find(([, words]) => c.filter((i) => carries(i, words)).length * 2 > c.length);
  if (!hit || subs.some((o) => o !== hit && c.some((i) => carries(i, o[1])))) return '';
  return hit[0];
}
// Families of a concept a cluster spans (how many of the narrower names have a tab).
const spans = (concept, c, docs) => (SUBNAMES[concept] || []).filter(([, words]) => c.some((i) => [...words].some((k) => docs[i].words.has(k)))).length;
function conceptGroups(clusters, docs) {
  let out = clusters.map((c) => [...c]);
  const small = docs.length <= CONCEPT_SMALL_WINDOW;
  const formed = new Map(); // cluster (array) -> the concept name
  const concepts = new Map(); // ... and the concept itself
  // How many of a tab's own words (and, if asked, its site's category) say the concept: a site's name alone is not strong evidence.
  const hitsOf = (i, concept, site = true) => {
    let n = site && categoriesOfSite(docs[i].url).includes(concept) ? 1 : 0;
    for (const [k, v] of docs[i].words) if (v.weight >= 0.7 && CONCEPTS_OF.get(k)?.includes(concept)) n++;
    return n;
  };
  const groupConcepts = Object.keys(knowledge.CONCEPT_GROUPS);
  const conceptsOfTab = (i) => new Set(groupConcepts.filter((k) => hitsOf(i, k) > 0));
  // Two tabs of different concepts, clustered on a loose word: not concept-coherent, so each goes back to being loose.
  out = out.flatMap((c) => {
    if (c.length !== 2) return [c];
    const [a, b] = c.map(conceptsOfTab);
    return a.size && b.size && ![...a].some((k) => b.has(k)) ? [[c[0]], [c[1]]] : [c];
  });
  const ofRepo = (c) => ofRepoCluster(c, docs);
  // The only page of a repo among a topic's tabs ("GitHub - python/cpython" beside Python tutorials) is not that topic's: it goes back to being loose
  // (the last stage files it under its site or category, with the other repos).
  out = out.flatMap((c) => {
    if (c.length < 3 || ofRepo(c)) return [c];
    const repoTabs = c.filter((i) => repoOf(docs[i].url));
    if (!repoTabs.length || repoTabs.length * 2 >= c.length) return [c];
    const pages = new Map(); // pages of each repo in the whole window: a repo with others elsewhere keeps its tab by its words
    for (const d of docs) { const r = repoOf(d.url); if (r) pages.set(r.key, (pages.get(r.key) || 0) + 1); }
    // ...unless the others are about the repo by name (pandas-dev/pandas beside pandas tutorials).
    const named = (i) => tokens(repoOf(docs[i].url).name.replace(/[-_.]/g, ' ')).some(({ key }) => c.some((j) => j !== i && (docs[j].words.get(key)?.weight ?? 0) >= 0.7));
    const single = repoTabs.filter((i) => pages.get(repoOf(docs[i].url).key) === 1 && !named(i));
    const rest = c.filter((i) => !single.includes(i));
    return single.length && rest.length >= 2 ? [rest, ...single.map((i) => [i])] : [c];
  });
  for (const [concept, label] of Object.entries(knowledge.CONCEPT_GROUPS)) {
    const key = `%${concept}`;
    const has = (i) => docs[i].words.has(key);
    // A concept that has its own group in the window (knowledge.CONCEPT_EXCLUDES: crypto, once three tabs say it) leaves those groups to it.
    const apart = ((knowledge.CONCEPT_EXCLUDES || {})[concept] || []).filter((k) => docs.filter((d) => d.words.has(`%${k}`)).length >= 3);
    const isApart = (c) => apart.some((k) => c.filter((i) => docs[i].words.has(`%${k}`)).length * 2 > c.length);
    const mostly = (c) => c.filter(has).length * 2 > c.length && !isApart(c) && !ofRepo(c) && !(c.length === 1 && repoOf(docs[c[0]].url) && !(has(c[0]) && !(knowledge.CONCEPT_LOOSE_ONLY || {})[concept])); // a lone repo page stays with the repos, unless its name says a narrow topic (nanoGPT: machine learning)
    // A broad concept (programming, travel) only draws loose tabs together: a group that already formed on its words stays as it is.
    const looseMin = (knowledge.CONCEPT_LOOSE_ONLY || {})[concept]; // ...and needs this many of them
    const looseOnly = looseMin > 0;
    const big = looseOnly ? undefined : out.filter((c) => c.length > CONCEPT_SMALL && mostly(c)).sort((a, b) => b.length - a.length)[0];
    // Parts: the small groups and loose tabs that carry it (any size in a small window, or while the home stays under MAX_GROUP). A broad concept takes only loose tabs and pairs, of different sites (two pages of one docs site are that
    // site's own group, categoryOf's).
    const joinMax = looseOnly ? 3 : small ? Infinity : big ? MAX_GROUP - big.length : CONCEPT_SMALL;
    let parts = out.filter((c) => c !== big && c.length <= joinMax && mostly(c));
    if (looseOnly && !(knowledge.CONCEPT_SAME_SITE_OK || {})[concept]) {
      const perSite = new Map();
      for (const c of parts) for (const i of c) perSite.set(docs[i].siteKey, (perSite.get(docs[i].siteKey) || 0) + 1);
      parts = parts.filter((c) => c.every((i) => perSite.get(docs[i].siteKey) < 2));
    }
    let home = big;
    // A group that already spans several languages ("Python" and "JavaScript" tabs) is the programming group: loose docs of other sites join it.
    if (!home && looseOnly && SUBNAMES[concept]) {
      const host = out.filter((c) => c.length >= 3 && mostly(c) && spans(concept, c, docs) >= 2).sort((a, b) => b.length - a.length)[0];
      if (host && parts.some((c) => c !== host)) { home = host; formed.set(home, label); parts = parts.filter((c) => c !== host); }
    }
    if (!home && parts.reduce((n, c) => n + c.length, 0) >= (looseMin || 3) && parts.length >= 2) {
      home = parts[0];
      formed.set(home, label);
    }
    // Two loose tabs that both say the concept strongly (or, for a concept of tools and agencies, sit on its sites), with nowhere better to go.
    const pairBySite = Boolean((knowledge.CONCEPT_PAIR_SITE || {})[concept]);
    if (!home && parts.length === 2 && parts.every((c) => c.length === 1 && (hitsOf(c[0], concept, false) >= CONCEPT_PAIR_HITS || (pairBySite && categoriesOfSite(docs[c[0]].url).includes(concept))))) {
      home = parts[0];
      formed.set(home, label);
    }
    if (!home) continue;
    if (formed.get(home) === label) concepts.set(home, concept);
    if (big || formed.get(home) === label) {
      for (const c of parts) if (c !== home) { home.push(...c); out.splice(out.indexOf(c), 1); }
    }
    // Tabs of a concept that may only join (the tax office beside retirement accounts).
    const joins = (knowledge.CONCEPT_JOINS[concept] || []).map((j) => `%${j}`);
    for (const c of out.filter((o) => o !== home && o.length <= CONCEPT_SMALL && o.filter((i) => joins.some((j) => docs[i].words.has(j))).length * 2 > o.length)) {
      home.push(...c);
      out.splice(out.indexOf(c), 1);
    }
    // A member that carries the concept where the group mostly doesn't, and is not close to the rest of it.
    for (const c of [...out]) {
      if (c === home || c.length < 3 || mostly(c) || isApart(c) || ofRepo(c)) continue;
      // ...unless it also carries the concept its own group is about (an arXiv paper is research, but among machine learning tabs it is machine learning).
      const own = groupConcepts.filter((k) => k !== concept && c.filter((j) => docs[j].words.has(`%${k}`)).length * 2 > c.length);
      for (const i of c.filter(has)) {
        if (own.some((k) => docs[i].words.has(`%${k}`))) continue;
        const rest = c.filter((j) => j !== i).map((j) => docs[j]);
        if (cosine(docs[i], centroidOf(rest)) >= CONCEPT_PULL_MAX_COS) continue;
        c.splice(c.indexOf(i), 1);
        home.push(i);
      }
    }
  }
  // A group named for the narrower thing most of its tabs are about ("Python" for pandas, NumPy and Django).
  for (const [c, label] of formed) {
    formed.set(c, subName(concepts.get(c), c, docs) || label);
  }
  return { clusters: out, formed };
}

// Seventh stage: a distinctive name (an acronym or a proper noun: ASGCT, Medicare; see tabWords `distinct`) that two or more loose tabs say is a topic by
// itself, however little else their titles share: "ASGCT 2026 annual meeting" and "Abstract submission - ASGCT". A tab on the named site counts as saying it
// when another tab's title does. Only loose tabs; the group is named for the name, and goes through the cohesion check like every other.
// A tab's site's own name as a key ("asgct" for asgct.org), '' when it is no name another tab can be about: a university's ("Northeastern dining" is not Canvas's
// topic) or a mail host's.
const siteNameKey = (d) => (d.words.brand && !knowledge.EDU_HOST.test(hostname(d.url)) && !ownedByHost(hostname(d.url), knowledge.SSO_HOSTS) ? stemWord(d.words.brand) : '');
const DISTINCT_MAX = 6; // a name more tabs than this say is a site or a window-wide word, not a pair's
function distinctGroups(clusters, docs) {
  const out = clusters.map((c) => [...c]);
  const formed = new Map();
  const loose = new Set(out.filter((c) => c.length === 1).map((c) => c[0]));
  const taken = new Set();
  const byLabel = new Map(); // a site's own name -> its tabs
  docs.forEach((d, i) => { const k = siteNameKey(d); if (k) { if (!byLabel.has(k)) byLabel.set(k, []); byLabel.get(k).push(i); } });
  const found = [];
  for (const [k, titled] of docs.distinct) {
    const list = [...new Set([...titled, ...(byLabel.get(k) || [])])].filter((i) => loose.has(i));
    if (docs.length >= 4 && titled.length > docs.length * COMMON_WORD_SHARE) continue; // a word the whole window says is the window's topic (topicClusters asks again with it kept)
    if (list.length >= 2 && list.length <= DISTINCT_MAX && titled.some((i) => list.includes(i))) found.push([k, list, titled]);
  }
  found.sort((a, b) => b[1].length - a[1].length);
  for (const [k, list, titled] of found) {
    const free = list.filter((i) => !taken.has(i));
    if (free.length < 2) continue;
    free.forEach((i) => taken.add(i));
    const said = free.find((i) => titled.includes(i));
    formed.set(free, docs[said].words.get(k).surface);
  }
  const kept = out.filter((c) => !(c.length === 1 && taken.has(c[0])));
  return { clusters: kept.concat([...formed.keys()]), formed };
}

// Eighth stage: the word most of a window's loose tabs share. A topical noun that no ordinary English list knows ("newborn", "dovetail", "sourdough",
// "monitor") in the TITLES of three or more loose tabs (of two sites or more) is what those tabs are about. One word still never links a pair: it takes
// three, and never a word of a kind of page ("guide", "best", "review", "plan", "list", "tips", "near", a year), a verb or an adjective (by its ending,
// unless a concept's own vocabulary has it), a place, a brand or a nav label. The tabs may not split into two concepts of their own (a "monitor" that is
// a baby's, a server's and a heart's). The group is named for the word; supportsOf takes the same word as evidence (docs.tokenKeys) so that cohesion keeps it.
const TOKEN_MIN = 3;
const TOKEN_MAX_SHARE = 0.4; // a word this share of the window carries is the window's, not a group's
const NOT_A_NOUN = /(?:ly|ed|ing|ive|ous|ful|able|ible|less|ish|ward|wise)$/;
function tokenGroups(clusters, docs) {
  const out = clusters.map((c) => [...c]);
  const formed = new Map();
  const loose = new Set(out.filter((c) => c.length === 1).map((c) => c[0]));
  if (loose.size < TOKEN_MIN) return { clusters: out, formed };
  const byWord = new Map();
  for (const i of loose) {
    for (const [k, e] of docs[i].words) {
      if (!isRealKey(k) || e.weight < 0.8 || CJK.test(k)) continue;
      const surface = String(e.surface || k);
      if (surface.length < (docs.distinct.has(k) ? 3 : 4) || !/^\p{L}+$/u.test(surface) || surface.length > 18) continue;
      if (!byWord.has(k)) byWord.set(k, []);
      byWord.get(k).push(i);
    }
  }
  const conceptsOf = (i) => [...docs[i].words.keys()].filter((k) => k[0] === '%' && k !== '%shopping');
  const cands = [];
  for (const [k, list] of byWord) {
    if (list.length < TOKEN_MIN || list.length > docs.length * TOKEN_MAX_SHARE) continue;
    const surface = String(docs[list[0]].words.get(k).surface).toLowerCase();
    const inConcept = CONCEPT_OF.has(k);
    const shown = String(docs[list[0]].words.get(k).surface);
    const acronym = docs.distinct.has(k) && shown === shown.toUpperCase() && shown.length <= 6; // PCT, SAT: capitals in three titles, an identity of its own
    // (an ambiguous word is a group's only when every tab that says it carries one concept: "chicken" in three cooking tabs, not beside a coop)
    if (AMBIGUOUS_KEYS.has(k) && !conceptsOf(list[0]).some((x) => list.every((i) => conceptsOf(i).includes(x)))) continue;
    if (STOPWORDS.has(surface) || ORDINARY_KEYS.has(k) || isGenericKey(k) || NAV_WORDS.has(k) || BRAND_KEYS.has(k) || isPlaceKey(k) || GENERIC_PAIR_STEMS.has(k)) continue;
    if (!inConcept && NOT_A_NOUN.test(surface)) continue;
    if (new Set(list.map((i) => docs[i].siteKey || docs[i].url)).size < 2) continue; // one site's template word
    // The word is what every tab is about: it is no word of a site's own name or address (a brand's tabs say it on every page).
    // No two members of different concepts (the word means something else in one of them), and a second thing the tabs share: another content word, a
    // concept or a site hint, or the word is a topic word of a concept's own vocabulary ("newborn"), or an acronym.
    const sets = list.map((i) => conceptsOf(i)).filter((x) => x.length);
    if (!acronym && sets.some((a, x) => sets.some((b, y) => y > x && !a.some((c) => b.includes(c))))) continue;
    if (!inConcept && !acronym) {
      const held = new Map();
      for (const i of list) {
        const e = evidenceOf(docs[i]);
        for (const w of new Set([...e.words, ...e.concepts, ...(e.hint ? [`hint:${e.hint}`] : [])])) if (w !== k && !ORDINARY_KEYS.has(w) && !AMBIGUOUS_KEYS.has(w)) held.set(w, (held.get(w) || 0) + 1);
      }
      if (![...held.values()].some((n) => n >= 2)) continue;
    }
    cands.push([k, list]);
  }
  cands.sort((a, b) => b[1].length - a[1].length || (a[0] < b[0] ? -1 : 1));
  const taken = new Set();
  docs.tokenKeys = new Set();
  for (const [k, list] of cands) {
    const free = list.filter((i) => !taken.has(i));
    if (free.length < TOKEN_MIN) continue;
    free.forEach((i) => taken.add(i));
    docs.tokenKeys.add(k);
    formed.set(free, docs[free[0]].words.get(k).surface);
  }
  const kept = out.filter((c) => !(c.length === 1 && taken.has(c[0])));
  return { clusters: kept.concat([...formed.keys()]), formed };
}

// ---------- cohesion: what a group has to show before it is a group ----------
//
// Precision over recall: a wrong group costs the user more than a loose tab. Whatever stage put tabs together (a shared word, an anchor,
// a site, a concept), every group is checked once more, here, against evidence that does not depend on how it formed. Tabs of a group are
// kept when they share, with other tabs of the group, at least one of:
//   - a concept (knowledge.CONCEPTS: finance, travel, housing ...), a hint of their site, or the same registrable site (a third of the group, or two tabs);
//   - two or more topic words (not generic ones, not a place, not a site's name), one of them no ordinary English word;
//   - a distinctive name (an acronym or a rare proper noun) two of them say;
//   - for Chinese, Japanese and Korean, a shared run of two characters or more (those are words of their own: see tokens()).
// A place alone, a brand alone and a generic word ("student", "sales", "calendar", "post") are never evidence. A tab that shares nothing with
// any other tab of its group is let go (and so is a pair that shares nothing): it stays loose rather than sit in a group it does not belong to.
const placeId = (k) => (PLACE_OF.has(k) ? stem(PLACE_OF.get(k)) : k);
// -> { words, concepts, places, site, hint }: what a tab can show another tab (cached on the doc).
function evidenceOf(d) {
  if (d.evidence) return d.evidence;
  const words = new Set();
  const concepts = new Set();
  const places = new Set();
  const ambiguous = [];
  for (const [k, e] of d.words) {
    if (k[0] === '%') { if (k !== '%shopping') concepts.add(k); continue; }
    if (!isRealKey(k) || e.weight < 0.7) continue;
    if (d.words.regional?.has(k)) { places.add(d.words.regional.get(k)); continue; } // Naples beside Positano: the Amalfi Coast, not Italy
    if (isPlaceKey(k)) { places.add(placeId(k)); continue; }
    if (!(d.vec.has(k) || d.common.has(k)) || isGenericKey(k) || NAV_WORDS.has(k) || BRAND_KEYS.has(k)) continue;
    if (AMBIGUOUS_KEYS.has(k)) { ambiguous.push(k); continue; }
    words.add(k);
  }
  // A word that names several things (chicken, bank) is the same word in two tabs only when they are about the same kind of thing: it is shown with each concept the tab carries.
  for (const k of ambiguous) for (const c of concepts) words.add(`${k}${c}`);
  // The tax office is money among retirement accounts (CONCEPT_JOINS): it shows the concept it may join.
  for (const [concept, joins] of Object.entries(knowledge.CONCEPT_JOINS)) if (joins.some((j) => concepts.has(`%${j}`))) concepts.add(`%${concept}`);
  const site = siteGroupable(d) && d.site ? d.site : '';
  const hint = d.siteHint && !knowledge.BROAD_HINTS.has(d.siteHint) ? d.siteHint : '';
  return (d.evidence = { words, concepts, places, site, hint });
}
const CJK_KEY = /[^\u0000-ɏ]/;
// Every way two or more of the tabs c (doc indices) hold something in common: [{ holders: [doc index] }].
function supportsOf(c, docs) {
  const ev = c.map((i) => evidenceOf(docs[i]));
  const out = [];
  const need = Math.max(2, Math.ceil(c.length / 3)); // a concept or site has to be a third of the group's (two tabs of a small one)
  const holdBy = (pick) => {
    const m = new Map();
    c.forEach((i, x) => { for (const k of pick(ev[x])) { if (!m.has(k)) m.set(k, []); m.get(k).push(i); } });
    return [...m].filter(([, h]) => h.length >= need);
  };
  const hold = (pick) => holdBy(pick).map(([, h]) => h);
  // Travel is a broad concept: two tabs that are both "travel" are a trip only when they name one place (below); three or more of a group are a Travel group.
  const evOf = new Map(c.map((i, x) => [i, ev[x]]));
  const onePlace = (h) => h.some((i) => [...evOf.get(i).places].some((p) => h.filter((j) => evOf.get(j).places.has(p)).length >= 2));
  // Crypto with a group of its own (three tabs) is not Finance (CONCEPT_EXCLUDES): the money in a coin binds no retirement account to it.
  const coins = c.filter((i) => docs[i].words.has('%crypto')).length >= 3;
  for (const [k, h] of holdBy((e) => (coins && e.concepts.has('%crypto') ? [...e.concepts].filter((x) => x !== '%finance') : e.concepts))) if (k !== '%travel' || h.length >= 3 || onePlace(h)) out.push({ holders: h });
  // Two tabs of one place that are both about getting there or being there are a trip (see tripGroups), whatever else their words say.
  {
    const byPlace = new Map();
    c.forEach((i, x) => { if (tripEvidence(docs[i])) for (const p of ev[x].places) { if (!byPlace.has(p)) byPlace.set(p, []); byPlace.get(p).push(i); } });
    for (const h of byPlace.values()) if (h.length >= 2) out.push({ holders: h });
  }
  // A big group of one place (a Japan trip with its subway pass and restaurant pages): the place is in most of it and a third of it is about
  // getting there or living there. A small one needs more than a place (a city beside nothing is no topic).
  if (c.length >= SPLIT_PLACE_TOPIC) {
    const trips = c.filter((i) => docs[i].words.has('%travel') || docs[i].words.has('%housing')).length;
    if (trips * 3 >= c.length) for (const h of hold((e) => e.places)) { const held = h.filter((i) => !jobLike(docs[i])); if (held.length * 5 >= c.length * 3) out.push({ holders: held }); } // (a job or a nursing tab never joins a trip on a shared city)
  }
  for (const h of hold((e) => (e.site ? [e.site] : []))) out.push({ holders: h });
  for (const h of hold((e) => (e.hint ? [e.hint] : []))) out.push({ holders: h });
  // A distinctive name (ASGCT, Medicare: tabWords `distinct`) that one tab's title says and another says too, or is its site's own name.
  if (docs.distinct) {
    const named = new Map();
    for (const i of c) {
      for (const k of docs[i].words.distinct || []) { if (!named.has(k)) named.set(k, { titled: 0, all: new Set() }); named.get(k).titled++; named.get(k).all.add(i); }
      const label = siteNameKey(docs[i]);
      if (label && docs.distinct.has(label)) { if (!named.has(label)) named.set(label, { titled: 0, all: new Set() }); named.get(label).all.add(i); }
    }
    for (const { titled, all } of named.values()) if (titled >= 1 && all.size >= 2) out.push({ holders: [...all] });
  }
  // A word three loose tabs say in their titles (tokenGroups): the group formed on it keeps the tabs that say it.
  for (const k of docs.tokenKeys || []) {
    const h = c.filter((i) => evidenceOf(docs[i]).words.has(k));
    if (h.length >= TOKEN_MIN) out.push({ holders: h });
  }
  // Words held by 2+ tabs: one word is never evidence (sharedEvidence). Two tabs that hold two of them, one of which is no ordinary English word, are bound.
  const byWord = new Map();
  c.forEach((i, x) => { for (const k of ev[x].words) { if (!byWord.has(k)) byWord.set(k, []); byWord.get(k).push(i); } });
  const shared = [...byWord].filter(([, h]) => h.length >= 2);
  for (const [k, h] of shared) if (CJK.test(k)) out.push({ holders: h }); // a run of CJK characters is a word of its own (dropFragmentLinks kept only whole runs)
  for (let a = 0; a < shared.length; a++) {
    for (let b = a + 1; b < shared.length; b++) {
      if (ORDINARY_KEYS.has(shared[a][0]) && ORDINARY_KEYS.has(shared[b][0])) continue;
      const both = shared[a][1].filter((i) => shared[b][1].includes(i));
      if (both.length >= 2) out.push({ holders: both });
    }
  }
  // A place counts as one of the two words, beside a topic word that is no ordinary one ("Kyoto temples", "Kyoto temple guide").
  const byPlace = new Map();
  c.forEach((i, x) => { for (const p of ev[x].places) { if (!byPlace.has(p)) byPlace.set(p, []); byPlace.get(p).push(i); } });
  for (const [k, h] of shared) {
    if (ORDINARY_KEYS.has(k)) continue;
    for (const holders of byPlace.values()) { const both = h.filter((i) => holders.includes(i)); if (both.length >= 2) out.push({ holders: both }); }
  }
  return out;
}
// A cluster -> the clusters it holds: [c] when its tabs are all bound together, by what they share (two tabs that share something are bound,
// and so are the tabs of a chain of such pairs). Tabs bound to no one are single tabs; two bundles of tabs bound only by a place or a generic
// word ("Edinburgh" over a student's flat and the trains home) are two groups.
function cohere(c, docs) {
  if (c.length < 2) return [c];
  const parent = new Map(c.map((i) => [i, i]));
  const find = (i) => (parent.get(i) === i ? i : (parent.set(i, find(parent.get(i))), parent.get(i)));
  const bound = new Set();
  for (const { holders } of supportsOf(c, docs)) for (const h of holders) { bound.add(h); parent.set(find(h), find(holders[0])); }
  const parts = new Map();
  for (const i of c) if (bound.has(i)) { const r = find(i); parts.set(r, [...(parts.get(r) || []), i]); }
  // Food context wins: a dinner or a restaurant among a language's or a band's tabs ("Korean BBQ near me" beside Korean lessons) shares only a word with
  // them, however many times they say it, and no other tab of the group is about food.
  const FOOD = ['%cooking', '%dining', '%baking'];
  const foodOf = (i) => FOOD.filter((k) => docs[i].words.has(k));
  const released = new Set();
  const out = [...parts.values()].map((p) => {
    if (p.length < 4) return p;
    const otherConcept = (i) => [...docs[i].words.keys()].some((k) => k[0] === '%' && !FOOD.includes(k) && k !== '%shopping' && p.some((j) => j !== i && docs[j].words.has(k)));
    const strays = p.filter((i) => foodOf(i).length && !otherConcept(i) && !p.some((j) => j !== i && foodOf(j).length));
    strays.forEach((i) => released.add(i));
    return p.filter((i) => !strays.includes(i));
  });
  if (out.length === 1 && out[0].length === c.length) return [c];
  return [...out, ...c.filter((i) => !bound.has(i) || released.has(i)).map((i) => [i])];
}

// ---------- trips ----------
//
// Tabs that share a place and are about getting there or being there (a hotel, a hostel, flights, things to do, tickets, trains, an itinerary,
// the sights, a tour) are one trip, named for the place, whatever else their words say: "Edinburgh hotels", "Things to do in Edinburgh" and
// "Edinburgh Fringe tickets" share one word and a bit of travel. "Train" is a travel word only here, beside a place: elsewhere it is a machine
// learning verb ("train a model").
const TRIP_TITLE = /\b(things to do|what to (?:see|do|eat)|where to (?:eat|stay|go)|o que fazer|qu[eé] hacer|que faire|cosa vedere|tickets?|trains?|rail|subway|ferry|sights?|sightseeing|tours?|itinerary|attractions?|hostels?|hotels?|flights?|airport|visit|visa|hik(?:e|es|ing)|trails?|camping|campsites?)\b/i;
// A tab about a job or a nursing career is never a trip tab, whatever city it names ("Travel nurse jobs Denver" beside flights to Maui).
const jobLike = (d) => d.words.has('%jobs') || d.words.has('%nursing');
// The travel words themselves (not only the site's category): a trip's tab says it is about getting there or being there.
const travelWord = (d) => TRIP_TITLE.test(String(d.title || '')) || [...d.words].some(([k, e]) => e.weight >= 0.7 && isRealKey(k) && CONCEPTS_OF.get(k)?.includes('travel'));
const tripEvidence = (d) => travelWord(d) && !jobLike(d);
function placesOf(d) {
  const e = evidenceOf(d);
  return e.places;
}
// A trip's name: the city its tabs name most, else the country.
function placeLabel(id, members) {
  const count = new Map();
  for (const d of members) for (const [k, e] of d.words) if (isRealKey(k) && e.weight >= 0.7 && isPlaceKey(k) && placeId(k) === id && !COUNTRY_KEYS.has(k)) count.set(e.surface, (count.get(e.surface) || 0) + 1);
  const city = [...count].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0];
  if (city && count.size === 1) return city[0];
  if (city && [...count.values()].filter((n) => n === city[1]).length === 1) return city[0];
  const country = members.map((d) => d.words.get(id)?.surface).find(Boolean);
  return country || city?.[0] || id.charAt(0).toUpperCase() + id.slice(1);
}
// clusters: arrays of doc indices (changed in place; rekey(c, change) renames one that is changed; nameOf(c) is the concept name a cluster has).
// -> [[cluster, label]] the trips it made, or the generic "Travel" groups it names for their place.
function tripGroups(clusters, docs, rekey, nameOf) {
  const trip = docs.map(tripEvidence);
  const places = docs.map(placesOf);
  const byPlace = new Map();
  docs.forEach((d, i) => { if (trip[i]) for (const p of places[i]) { if (!byPlace.has(p)) byPlace.set(p, []); byPlace.get(p).push(i); } });
  const used = new Set();
  const made = [];
  const homeOf = (i) => clusters.find((c) => c.includes(i));
  for (;;) {
    let best = null;
    for (const [p, list] of byPlace) {
      const free = list.filter((i) => !used.has(i));
      if (free.length < 2) continue;
      // Tabs that name another place with trips of its own go there first; the ones only this place has decide it.
      const only = free.filter((i) => [...places[i]].every((q) => q === p || (byPlace.get(q) || []).filter((j) => !used.has(j)).length < 2)).length;
      if (!best || free.length > best.free.length || (free.length === best.free.length && only > best.only)) best = { p, free, only };
    }
    if (!best) break;
    const tabs = [...best.free];
    tabs.forEach((i) => used.add(i));
    // The tab a trip tab was paired with (the Genie tips beside the Disney World page) goes with it, when what bound them is more than the place.
    for (const i of best.free) {
      const from = homeOf(i);
      const partner = from && from.length === 2 ? from.find((j) => j !== i) : null;
      if (partner != null && !tabs.includes(partner) && supportsOf([i, partner], docs).length) tabs.push(partner);
    }
    // A cluster that already holds most of them and is about travel takes the others; one that is about something else is left to the cohesion check.
    const hosts = clusters.filter((c) => c.filter((i) => tabs.includes(i)).length >= 2).sort((a, b) => b.filter((i) => tabs.includes(i)).length - a.filter((i) => tabs.includes(i)).length);
    const host = hosts[0];
    const own = host ? host.filter((i) => tabs.includes(i)).length : 0;
    if (host && host.filter((i) => trip[i]).length * 2 <= host.length) continue; // it is about something else
    // This place's trip when it is big (a Japan trip with its restaurants: the place is in most of it) or most of it is this place's trips; a group that is
    // neither (Edinburgh's flights and trains beside Dublin's hostel, joined by the travel concept) is two trips' tabs together: they are taken out and make a trip
    // of their own.
    const placeShare = host ? host.filter((i) => places[i].has(best.p)).length / host.length : 0;
    if (host && ((host.length >= SPLIT_PLACE_TOPIC && placeShare >= 0.6) || own * 2 > host.length)) {
      if (host.length < SPLIT_PLACE_TOPIC) { // a small trip holds only this place's tabs (the visa of a student beside a Dublin hostel is not Dublin's)
        for (const i of host.filter((j) => !tabs.includes(j) && !places[j].has(best.p))) { rekey(host, () => host.splice(host.indexOf(i), 1)); clusters.push([i]); }
      }
      for (const i of tabs) {
        if (host.includes(i) || host.length >= MAX_GROUP) continue;
        const from = homeOf(i);
        if (from) rekey(from, () => from.splice(from.indexOf(i), 1));
        rekey(host, () => host.push(i));
      }
      if (nameOf(host) === 'Travel') made.push([host, placeLabel(best.p, host.map((i) => docs[i]))]); // "Travel" says less than the place
      continue;
    }
    for (const i of tabs) { const from = homeOf(i); if (from) rekey(from, () => from.splice(from.indexOf(i), 1)); }
    const fresh = [...tabs];
    clusters.push(fresh);
    made.push([fresh, placeLabel(best.p, tabs.map((i) => docs[i]))]);
  }
  for (let x = clusters.length - 1; x >= 0; x--) if (!clusters[x].length) clusters.splice(x, 1);
  return made;
}

// The broad category of a tab (knowledge.FALLBACK_CATEGORIES) from its host, then its title: a category object or null.
// Strong host first, then the title words, then a weak host (a news site that also carries a review).
const hostMatches = (host, sites) => sites.split(/\s+/).some((s) => (s.endsWith('.*') ? host.startsWith(`${s.slice(0, -2)}.`) && host.split('.').length >= 3 : host === s || host.endsWith(`.${s}`)));
function categoryOf({ url, title }) {
  // A dev server's tabs share one app name after the page title ("alpha - Docs"): that is the app's template, not what the page is about.
  if (isLocalHost(url)) title = String(title || '').split(/\s+[-|–—·:]\s+/).slice(0, -1).join(' - ') || title;
  const host = hostname(url).replace(/^www\./, '');
  const cats = knowledge.FALLBACK_CATEGORIES;
  const fullUrl = `${host}${(() => { try { return new URL(url).pathname; } catch { return ''; } })()}`;
  const strong = cats.find((c) => !c.weak && host && (hostMatches(host, c.hosts) || (c.hostRe && c.hostRe.test(host) && !knowledge.NOT_SCHOOL_OR_GOV.test(host)) || (c.urlRe && c.urlRe.test(fullUrl))));
  if (strong) return strong;
  // "Best novels 2026" and "Laptop deals" are not one shopping trip: a title says Shopping only with a product, or a price/buy/cart word.
  const byTitle = cats.find((c) => c.title.test(String(title || '')) && (c.name !== 'Shopping' || knowledge.SHOP_TITLE.test(String(title || ''))));
  if (byTitle) return byTitle;
  return cats.find((c) => c.weak && host && hostMatches(host, c.hosts)) || null;
}

// Two tabs make a group only when they share something: a word or concept both carry (not a letter-triple, nor a site's name), a site
// hint, or a category. Whatever stage paired them ("Houseplant care tips" and "Resume template" on a stray word fragment), the pair
// of two unrelated tabs stays loose.
// Words that link tabs but never name a group ("Tickets" for a bus, a train and a flat: the group is Travel).
const NAME_GENERIC = new Set(['ticket', 'price', 'cost', 'quote'].map(stem));
const GENERIC_PAIR_STEMS = new Set(['price', 'cost', 'plan', 'tool', 'service', 'info', 'data', 'report', 'center', 'team', 'rate', 'tip', 'review', 'rental', 'rent', 'brand', 'branding', 'design', 'color', 'colour', 'logo', 'creative', 'style', 'inspiration', 'portfolio'].map(stem).concat('%shopping'));
function pairShares(c, docs, drawn) {
  if (drawn) return true;
  const [a, b] = c.map((i) => docs[i]);
  if (a.siteKey && a.siteKey === b.siteKey && knowledge.SAAS_DOMAINS[a.siteKey]) return true; // two pages of one SaaS workspace
  // A pair is a group when it shares what sharedEvidence asks of every link: a concept (not "shopping"), a repository, a site, or a site hint, or a
  // distinctive name, or two topic words one of which is no ordinary English word - never one word. Not generic ones ("price", "plan", "design") and no place.
  const shared = [...a.vec.keys()].filter((k) => k[0] !== '#' && k[0] !== '^' && k[0] !== '~' && b.vec.has(k));
  const place = shared.some((k) => isRealKey(k) && isPlaceKey(k));
  if (shared.some((k) => (k[0] === '%' || k[0] === '@') && !GENERIC_PAIR_STEMS.has(k) && (k !== '%travel' || place))) return true; // (two "travel" tabs are a trip only beside a place both name)
  const words = shared.filter((k) => /^[\p{L}\p{N}]/u.test(k) && !GENERIC_PAIR_STEMS.has(k) && !isPlaceKey(k) && !BRAND_KEYS.has(k));
  if (words.some((k) => CJK.test(k))) return true; // a whole run of CJK characters is a word of its own
  if (words.some((k) => !ORDINARY_KEYS.has(k)) && (words.length >= 2 || place)) return true; // (a place is one of the two words, beside a topic word)
  if (shared.some((k) => isRealKey(k) && !NAV_WORDS.has(k) && !isGenericKey(k) && sharesName(a, b, k))) return true;
  if (a.siteKey && a.siteKey === b.siteKey && siteGroupable(a)) return true;
  return Boolean(a.siteHint && a.siteHint === b.siteHint && !knowledge.BROAD_HINTS.has(a.siteHint));
}
// The tabs of `part` (doc indices) that say the same service word as another tab of it (`service`: a global RegExp, group 1 the word), as
// the groups they form: two tabs that share "renewal" or "Medicare" are one, a tab that shares none with any other is let go.
function serviceParts(part, service, docs) {
  const said = new Map(part.map((i) => [i, new Set([...String(docs[i].title || '').toLowerCase().matchAll(service)].map((m) => stem(m[1])))]));
  const root = new Map(part.map((i) => [i, i]));
  const find = (i) => (root.get(i) === i ? i : (root.set(i, find(root.get(i))), root.get(i)));
  const byWord = new Map();
  for (const [i, words] of said) for (const w of words) byWord.set(w, [...(byWord.get(w) || []), i]);
  for (const holders of byWord.values()) if (holders.length >= 2) holders.forEach((j) => root.set(find(j), find(holders[0])));
  const by = new Map();
  for (const i of part) if ([...said.get(i)].some((w) => byWord.get(w).length >= 2)) by.set(find(i), [...(by.get(find(i)) || []), i]);
  return [...by.values()].filter((p) => p.length >= 2);
}
// The category (School, Travel ...) most of a cluster's tabs are filed under, or ''.
function categoryLabel(members) {
  const n = new Map();
  for (const d of members) { const k = categoryOf(d); if (k) n.set(k.name, (n.get(k.name) || 0) + 1); }
  const top = [...n].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] * 2 > members.length ? top[0] : '';
}
// The concept most of a cluster's tabs carry, named as a concept group is ("Programming", "Python" when most are Python), or ''.
function conceptLabel(c, docs) {
  for (const [concept, label] of Object.entries(knowledge.CONCEPT_GROUPS)) {
    if (c.filter((i) => docs[i].words.has(`%${concept}`)).length * 2 <= c.length) continue;
    return subName(concept, c, docs) || label;
  }
  return '';
}

// ---------- group names: one normalization ----------
//
// The same set of tabs always gets the same name, however it was found: a name made of title words is singular ("Program", not "Programs"), and a name
// that is only an ordinary word or says the same as the group's concept or category ("Recipe" beside "Recipes", "Study", "Shift", "Practice") is the concept's or
// the category's name instead: concept names beat title words. `label`: the concept, category or hint name the group has, or ''.
const KEEP_PLURAL = new Set(['news', 'series', 'species', 'canvas', 'atlas', 'bias', 'gas', 'plus', 'bonus', 'campus', 'focus', 'status', 'virus', 'lens', 'physics', 'mathematics', 'economics', 'politics', 'analytics', 'ethics', 'electronics', 'logistics', 'statistics', 'chess', 'ios', 'kubernetes', 'jenkins', 'docs', 'diabetes', 'mass']);
function singularWord(w) {
  const lower = w.toLowerCase();
  if (lower.length <= 3 || KEEP_PLURAL.has(lower) || /[^a-z]/.test(lower) || /[A-Z]/.test(w.slice(1)) || !/s$/.test(lower) || /(ss|us|is|ous)$/.test(lower) || CONCEPT_OF.has(stemWord(lower))) return w; // acronyms (PRs), brands (iPhones), "glass", "campus", "analysis"
  if (/ies$/.test(lower) && lower.length > 4) return w.slice(0, -3) + (w.slice(-3, -2) === 'I' ? 'Y' : 'y');
  if (/(ches|shes|sses|xes|zes)$/.test(lower)) return w.slice(0, -2);
  return w.slice(0, -1);
}
// `forms`: the (lower case) words the group's titles are written with. A word is made singular only when that gives a word the titles say or an ordinary
// English one: "Programs" -> "Program", but "Oposiciones" stays.
function normalizeName(name, labels = [], forms = new Set()) {
  const words = String(name).split(/\s+/).filter(Boolean);
  if (!words.length) return name;
  const one = singularWord(words[words.length - 1]);
  if (one !== words[words.length - 1] && (forms.has(one.toLowerCase()) || ORDINARY_KEYS.has(stem(one.toLowerCase())) || CONCEPT_OF.has(stem(one.toLowerCase())))) words[words.length - 1] = one;
  const out = words.join(' ');
  const key = nameTokens(out).join(' ');
  const known = labels.filter(Boolean);
  const same = known.find((l) => nameTokens(l).join(' ') === key); // "Recipe" is the category's "Recipes": one name whichever way the group was found
  if (same) return same;
  if (words.length === 1 && known.length && nameTokens(out).every((w) => ORDINARY_KEYS.has(w) && !CONCEPT_OF.has(w))) return known[0]; // (a concept's own word, "Recipe" or "Finals", is already a concept name)
  return out;
}

// entries: [{ id, title, url }] -> [{ name, ids, key }] with 2+ tabs each (loose tabs left out).
// categories: the local organizer's last resort for what the words left loose (see the stage after the split below).
function topicClusters(entries, opts = {}) {
  const first = clusterPass(entries, opts, false);
  // A quarter of the tabs or more left loose and a word every tab carries: the window is about that word (four sites of kitten pages,
  // or Moscow's weather, hotels and sights beside a lone "Купить ... в Москве"). Ask again with it kept; the better answer wins.
  if (first.hasCommon && first.reduce((k, c) => k + c.ids.length, 0) * 4 < entries.length * 3) {
    const again = clusterPass(entries, opts, true);
    if (again.reduce((k, c) => k + c.ids.length, 0) > first.reduce((k, c) => k + c.ids.length, 0)) return again;
  }
  return first;
}
function clusterPass(entries, { threshold = TOPIC_THRESHOLD, categories = false } = {}, allowCommon = false) {
  const docs = vectorize(entries, { allowCommon });
  const n = docs.length;
  if (n < 2) return Object.assign([], { hasCommon: false });
  const sim = docs.map((a) => docs.map((b) => cosine(a, b)));
  // Average-linkage agglomerative clustering, merging the closest pair while above the threshold.
  const link = (x, y) => { let s = 0; for (const i of x) for (const j of y) s += sim[i][j]; return s / (x.length * y.length); };
  const agglomerate = (indices, at) => {
    const out = indices.map((i) => [i]);
    for (;;) {
      let best = null;
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          const s = link(out[i], out[j]);
          if (s >= at && (!best || s > best.s)) best = { i, j, s };
        }
      }
      if (!best) return out;
      out[best.i] = out[best.i].concat(out[best.j]);
      out.splice(best.j, 1);
    }
  };
  let clusters = agglomerate(docs.map((_d, i) => i), threshold);
  // Second stage: merge sub-clusters (or fold in a leftover single tab) whose pooled vocabulary
  // (centroid) is close. A centroid is a cleaner signal than any single member's vector, so a
  // cross-site topic (esp. carried by page text) that wasn't quite enough to link two individual
  // sparse tabs often clears the bar once each side's words are pooled. Two bare singletons never
  // merge here, though - that pairwise comparison is identical to pass one's and already had its
  // shot there; this stage is only for absorbing a straggler into (or joining) real evidence.
  let merged = clusters.map((c) => [...c]);
  // Each pair's score is kept until one of its clusters changes, so a round only scores the merged cluster against the rest.
  const pairScore = new Map();
  const scoreOfPair = (x, y) => {
    let row = pairScore.get(x);
    if (!row) pairScore.set(x, (row = new Map()));
    if (!row.has(y)) row.set(y, cosine(clusterCentroid(x, docs), clusterCentroid(y, docs)));
    return row.get(y);
  };
  for (;;) {
    let best = null;
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        if (merged[i].length < 2 && merged[j].length < 2) continue;
        const s = scoreOfPair(merged[i], merged[j]);
        if (s >= CENTROID_MERGE_THRESHOLD && (!best || s > best.s)) best = { i, j, s };
      }
    }
    if (!best) break;
    pairScore.delete(merged[best.i]);
    pairScore.delete(merged[best.j]);
    merged[best.i] = merged[best.i].concat(merged[best.j]);
    merged.splice(best.j, 1);
  }
  // Third stage: groups (and lone tabs) that share an anchor word are one topic.
  if (!process.env.NOANCHOR) merged = anchorMerge((process.env.NOSPLIT ? (x) => x : splitPlaceBridges)(pruneWeak(anchorMerge(merged, docs), docs), docs), docs);
  if (!process.env.NOABSORB) merged = conceptAbsorb(merged, docs);
  // A tab that only a loose word bridged to a group ("API" in a latency dashboard beside a repo's pages) is let go before the stages that place the loose tabs, so
  // that they get their chance with it (a monitoring tool and its pair); the cohesion check runs again at the end.
  merged = merged.flatMap((c) => cohere(c, docs));
  // Fifth stage: loose tabs by their site and its hint.
  const hintOf = new Map(); // sorted member indices -> the hint a cluster was formed on
  const conceptOf = new Map(); // ... and the concept that drew a cluster together (names it before anything else)
  const idsKey = (c) => [...c].sort((x, y) => x - y).join(',');
  if (!process.env.NOSITEJOIN) {
    const joined = siteJoin(merged, docs);
    merged = joined.clusters;
    for (const [c, hint] of joined.hinted) hintOf.set(idsKey(c), hint);
  }
  {
    const drawn = conceptGroups(merged, docs);
    merged = drawn.clusters;
    for (const [c, label] of drawn.formed) conceptOf.set(idsKey(c), label);
  }
  {
    const named = distinctGroups(merged, docs);
    merged = named.clusters;
    for (const c of named.formed.keys()) conceptOf.set(idsKey(c), ''); // drawn together by a name, and named the usual way (the name's own spelling is not always the best: Москве, Москва)
  }
  if (!process.env.NOTOKEN) {
    const worded = tokenGroups(merged, docs);
    merged = worded.clusters;
    for (const c of worded.formed.keys()) conceptOf.set(idsKey(c), ''); // a word three tabs share: named the usual way too
  }
  // Cohesion: whatever formed a group, most of its tabs must share something that says something (see cohere); then the trips.
  const rekey = (c, change) => { // change a cluster's tabs, keeping the name its old tabs earned it
    const was = idsKey(c);
    const [concept, hint] = [conceptOf.get(was), hintOf.get(was)];
    const [hasConcept, hasHint] = [conceptOf.has(was), hintOf.has(was)];
    change();
    if (hasConcept || hasHint) {
      conceptOf.delete(was);
      hintOf.delete(was);
      if (hasConcept) conceptOf.set(idsKey(c), concept);
      if (hasHint) hintOf.set(idsKey(c), hint);
    }
  };
  // Every group is cohered: its tabs are split into the parts that share something, and a tab sharing nothing is let go. Run before the trips (a trip
  // is made of tabs that already hold together) and again at the very end, so that no stage after the first run (trips, categories) can leave a group that
  // has not passed it. `skip(c)`: groups a KIND of site names (kindOf) are not one topic and are not held to it.
  const cohereAll = (list, skip = () => false) => list.flatMap((c) => {
    if (skip(c)) return [c];
    const parts = cohere(c, docs);
    if (parts.length === 1 && parts[0].length === c.length) return [c];
    const was = idsKey(c);
    const [concept, hint] = [conceptOf.get(was), hintOf.get(was)];
    const [hasConcept, hasHint] = [conceptOf.has(was), hintOf.has(was)];
    conceptOf.delete(was);
    hintOf.delete(was);
    const main = parts.filter((p) => p.length >= 2).sort((x, y) => y.length - x.length)[0];
    if (main && hasConcept) conceptOf.set(idsKey(main), concept);
    if (main && hasHint) hintOf.set(idsKey(main), hint);
    return parts;
  });
  {
    merged = cohereAll(merged);
    for (const [c, label] of tripGroups(merged, docs, rekey, (c) => conceptOf.get(idsKey(c)))) conceptOf.set(idsKey(c), label);
  }
  // No mega-groups: a cluster past MAX_GROUP is re-split at a stricter threshold (a few times); tabs
  // that no longer belong with anyone stay loose rather than being forced into a group.
  const split = (c, at, depth) => (c.length <= MAX_GROUP || depth >= 4 ? [c] : agglomerate(c, at).flatMap((part) => (part.length < 2 ? [] : split(part, at + 0.1, depth + 1))));
  clusters = merged.flatMap((c) => split(c, threshold + 0.1, 0));
  // Last resort (no model, or it said nothing): a tab no cluster took is filed by a broad category read from its host
  // and title (mail, dev docs, news ...): a lone tab of a one-topic category (a trip, a course, recipes) joins a
  // cluster of that category, the rest of a category form a group of their own named for it; small clusters of a
  // one-topic category fold into the biggest of it. Deterministic, never one "Other", and no group past MAX_GROUP.
  const byCategory = new Set(); // the clusters the category stage made or grew: it holds them to its own, stricter rule (below)
  if (categories) {
    const cat = docs.map(categoryOf);
    const majorCat = (c) => { const n = new Map(); for (const i of c) if (cat[i]) n.set(cat[i], (n.get(cat[i]) || 0) + 1); const top = [...n].sort((a, b) => b[1] - a[1])[0]; return top && top[1] * 2 > c.length ? top[0] : null; };
    const grow = (c, list) => { // a cluster keeps the name its hint (or its sites' shared hint: "School") gave it
      const was = idsKey(c);
      const name = hintOf.get(was) || (docs[c[0]].siteHint && c.every((i) => docs[i].siteHint === docs[c[0]].siteHint) ? docs[c[0]].siteHint : '');
      c.push(...list);
      byCategory.add(c);
      hintOf.delete(was);
      if (name) hintOf.set(idsKey(c), name);
    };
    let groupsNow = clusters.filter((c) => c.length >= 2);
    const lone = clusters.filter((c) => c.length < 2).map((c) => c[0]);
    const rest = [];
    const byCat = new Map();
    // A host (a .edu, a .gov) or a title word is no more than a hint at a category: a tab joins a group of it, and tabs make a group of it, only when
    // they share something besides (see cohere). The four kinds of site (mail, dev docs, video, news) are the exception: their group IS the kind.
    // A tab whose TITLE says the category ("syllabus", "linear algebra": School) is a tab of it by its words; one that is only on the category's hosts ("a
    // .edu") has the host alone, which is the hint that needs more.
    const byTitle = (i) => Boolean(cat[i] && cat[i].title.test(String(docs[i].title || '')));
    const holds = (home, list) => { // every host-only tab of `list` is bound to a tab of `home` (or, with no home, to another of the list)
      const need = list.filter((i) => !byTitle(i) && !cat[i].kind);
      if (!need.length) return true;
      const parts = cohere([...home, ...list], docs);
      return need.every((i) => { const part = parts.find((p) => p.includes(i)); return part && part.length >= 2 && part.some((j) => (home.length ? home : list).includes(j) && j !== i); });
    };
    for (const i of lone) {
      if (!cat[i]) { rest.push(i); continue; }
      // (a course site's tab, Coursera, may also join a School group: `joinsAlso`)
      const home = cat[i].join ? groupsNow.filter((c) => (majorCat(c) === cat[i] || (cat[i].joinsAlso && majorCat(c)?.name === cat[i].joinsAlso)) && c.length < MAX_GROUP && holds(c, [i])).sort((a, b) => b.length - a.length)[0] : null;
      if (home) grow(home, [i]);
      else byCat.set(cat[i], [...(byCat.get(cat[i]) || []), i]);
    }
    for (const [c, list] of byCat) {
      if (list.length < 2) { rest.push(...list); continue; }
      let parts = [list];
      if (!c.kind) { // a topic's tabs: those its title words name are one group, and a host-only tab is in it only when it is bound to a tab of it (or to another host-only one)
        const root = new Map(list.map((i) => [i, i]));
        const find = (i) => (root.get(i) === i ? i : (root.set(i, find(root.get(i))), root.get(i)));
        const joinAll = (members) => members.forEach((j) => root.set(find(j), find(members[0])));
        joinAll(list.filter(byTitle));
        for (const p of cohere(list, docs)) if (p.length >= 2) joinAll(p);
        const by = new Map();
        for (const i of list) by.set(find(i), [...(by.get(find(i)) || []), i]);
        parts = [...by.values()].filter((p) => p.length >= 2);
        // A host or one word of its own never makes an agency's group (an .gov host, a "DMV" title and a "Social Security" title are three errands): its
        // tabs must say the same service ("renewal", "tax", "Medicare"). See knowledge.FALLBACK_CATEGORIES `service`.
        if (c.service) parts = parts.flatMap((part) => serviceParts(part, c.service, docs));
      }
      for (const part of parts) {
        hintOf.set(idsKey(part), c.name === 'Dev docs' && part.every((i) => docs[i].siteKey === docs[part[0]].siteKey) ? siteName(docs[part[0]].url, docs[part[0]].title) : c.name); // two GitHub pages: "GitHub"
        groupsNow.push(part);
        byCategory.add(part);
      }
      rest.push(...list.filter((i) => !parts.some((p) => p.includes(i))));
    }
    for (const small of groupsNow.filter((c) => c.length <= 2)) {
      const c = majorCat(small);
      const into = c && c.join ? groupsNow.filter((o) => o !== small && o.length > 2 && majorCat(o) === c && o.length + small.length <= MAX_GROUP && holds(o, small)).sort((a, b) => b.length - a.length)[0] : null;
      if (into) { grow(into, small); groupsNow = groupsNow.filter((o) => o !== small); }
    }
    clusters = groupsNow.concat(rest.map((i) => [i]));
  }
  // Whatever the stages after the first cohesion pass did (trips, the mega-group split, categories), no group leaves without having passed it.
  clusters = cohereAll(clusters, (c) => byCategory.has(c));
  // Deterministic order: tabs in the order given, groups by their first tab.
  clusters = clusters.map((c) => [...c].sort((x, y) => x - y)).sort((x, y) => x[0] - y[0]);
  const titleCase = (w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  const titleCasePhrase = (s) => s.split(/\s+/).map(titleCase).join(' ');
  const clip = (s) => (s.length <= 24 ? s : (s.slice(0, 24).replace(/\s+\S*$/, '') || s.slice(0, 24)));
  const named = clusters.filter((c) => c.length > 2 || (c.length === 2 && pairShares(c, docs, conceptOf.has(idsKey(c)) || hintOf.has(idsKey(c))))).map((c) => {
    const members = c.map((i) => docs[i]);
    let pairSum = 0;
    for (let x = 0; x < c.length; x++) for (let y = x + 1; y < c.length; y++) pairSum += sim[c[x]][c[y]];
    const cohesion = pairSum / ((c.length * (c.length - 1)) / 2); // mean similarity of member pairs: how tight the group is
    const isReal = isRealKey; // trigram/vector-bigram/repo/site/concept keys are similarity-only, never names
    // A word (or bigram) has to be a strict majority, not just "at least half": for a 2-member
    // cluster, "half" (ceil(2/2) = 1) would let a word only ONE member has name the pair.
    const majority = Math.floor(members.length / 2) + 1;
    // Single-word candidates: the strongest word most members actually share.
    const score = new Map();
    for (const d of members) for (const [k, v] of d.vec) if (isReal(k)) score.set(k, (score.get(k) || 0) + v);
    const ranked = [...score].filter(([k]) => !NAME_GENERIC.has(k) && members.filter((d) => d.vec.has(k)).length >= majority).sort((a, b) => b[1] - a[1]);
    const surface = (k) => members.find((d) => d.words.has(k)).words.get(k).surface;
    // A Russian word is written in whatever case the title needs ("в Москве", "Москвы"): the group is named for the
    // dictionary form among those its tabs use (no ending, then -а/-я), else the form most of them use.
    const isDictionary = (w) => /(?:ый|ий|ь)$/i.test(w) || !CYRILLIC_ENDING.test(w.toLowerCase()); // "борщ", "красный", "отель"
    const formRank = (w) => (isDictionary(w) ? 0 : /[ая]$/i.test(w) ? 1 : 2);
    const bestSurface = (k) => {
      if (!/[Ѐ-ӿ]/.test(k)) return surface(k);
      const count = new Map();
      for (const d of members) if (d.words.has(k)) { const w = d.words.get(k).surface; count.set(w, (count.get(w) || 0) + 1); }
      const forms = [...count.keys()];
      // Only -ов/-ом/-ем forms, no bare one ("пирога", "пирогов"): a masculine noun, whose dictionary form is the bare stem.
      if (!forms.some(isDictionary) && forms.some((w) => /(?:ов|ев|ом|ем)$/i.test(w))) return k.charAt(0).toUpperCase() + k.slice(1);
      return [...count].sort((x, y) => formRank(x[0]) - formRank(y[0]) || y[1] - x[1] || x[0].length - y[0].length)[0][0];
    };
    const words2 = (e) => (/[Ѐ-ӿ]/.test(e.key) ? e.key.split('|').map(bestSurface).join(' ') : e.surface);
    // Bigram candidates: an adjacent pair (from the title or a search query) both members' words
    // consider informative, seen in most members - "Machine Learning" beats picking two
    // unrelated top words.
    const bigramScore = new Map();
    for (const d of members) {
      const seen = new Set();
      for (const { key, surface: bsurface } of d.words.bigrams || []) {
        if (seen.has(key)) continue;
        seen.add(key);
        const [k1, k2] = key.split('|');
        const v1 = d.vec.get(k1), v2 = d.vec.get(k2);
        if (!v1 || !v2 || isGenericKey(k1) || isGenericKey(k2)) continue; // a name is never made of "jobs" or "dashboard"
        const e = bigramScore.get(key) || { score: 0, count: 0, surface: bsurface, key };
        e.score += v1 + v2;
        e.count++;
        bigramScore.set(key, e);
      }
    }
    const bigramRanked = [...bigramScore.values()].filter((e) => e.count >= majority).sort((a, b) => b.score - a.score);
    const top = ranked[0];
    const nameTop = ranked.find(([k]) => !isGenericKey(k)); // "job" may link tabs, and keys the group, but never names it
    const siteOnly = top && members.every((d) => registrableDomain(d.url) === registrableDomain(members[0].url)) && registrableDomain(members[0].url).startsWith(top[0]) && members.every((d) => d.site === members[0].site);
    // A project's tabs: named for the repo ("Lumen PRs", "Lumen issues"), whatever else is in the group.
    const repoCount = new Map();
    for (const d of members) { const r = repoOf(d.url); if (r) repoCount.set(r.name, (repoCount.get(r.name) || 0) + 1); }
    const [topRepo, topRepoCount] = [...repoCount].sort((a, b) => b[1] - a[1])[0] || [];
    // Every tab on a site of one hint: the hint names the group when nothing better does (the site's
    // own name - "Northeastern" for its Canvas - says less), and always when the hint formed it.
    const sharedHint = members[0].siteHint && members.every((d) => d.siteHint === members[0].siteHint) ? members[0].siteHint : '';
    // Nearly every tab one site's (12 GitHub repos, a dozen Wikipedia pages): the group is that site's, not a category ("Dev docs").
    const siteCount = new Map();
    for (const d of members) siteCount.set(d.siteKey, (siteCount.get(d.siteKey) || 0) + 1);
    const [topSite, topSiteCount] = [...siteCount].sort((x, y) => y[1] - x[1])[0] || [];
    const oneSite = members.length >= 3 && topSite && topSiteCount / members.length >= SITE_DOMINANT && !SEARCH_DOMAINS.has(topSite);
    const kindOfSite = (n) => knowledge.BROAD_HINTS.has(n) || knowledge.FALLBACK_CATEGORIES.some((k) => k.name === n); // a name that says a KIND of site
    // The name of last resort: the site's, when every tab is on one site; else what the tabs share (a concept). Tabs of different
    // sites with nothing to be named for are not a group ("Alpha" for a houseplant page and a resume template).
    const oneSiteAll = members.every((d) => d.siteKey === members[0].siteKey && d.site === members[0].site); // (dev servers on different ports are one siteKey, '': not one site)
    const fallbackName = () => {
      if (oneSiteAll) return siteName(members[0].url, members[0].title);
      const label = conceptLabel(c, docs) || categoryLabel(members);
      if (label || members.length < 3) return label; // a pair of two sites with nothing to be named for is no group
      if (topSiteCount < 3) return ''; // three or more: the site three of them are on, else they are not a group (a name no tab says is worse than none)
      const lead = members.find((d) => d.siteKey === topSite) || members[0];
      return siteName(lead.url, lead.title);
    };
    let name;
    let wordNamed = false; // named for words its titles say (not for a site, a repo, a concept or a hint): see normalizeName
    if (conceptOf.get(idsKey(c))) name = conceptOf.get(idsKey(c));
    else if (oneSite && !(topRepo && topRepoCount >= 2 && topRepoCount >= members.length / 2) && (!top || kindOfSite(hintOf.get(idsKey(c)) || sharedHint))) {
      const lead = members.find((d) => d.siteKey === topSite);
      name = siteName(lead.url, lead.title);
    } else if (hintOf.has(idsKey(c))) name = hintOf.get(idsKey(c));
    else if (topRepo && topRepoCount >= 2 && topRepoCount >= members.length / 2) {
      const kinds = new Set(members.filter((d) => repoOf(d.url)?.name === topRepo).map((d) => repoPageKind(d.url)));
      const kind = kinds.size === 1 ? [...kinds][0] : '';
      const owner = members.map((d) => repoOf(d.url)).find((r) => r && r.name === topRepo)?.owner;
      // "api", "web", "docs": a repo name that names nothing alone is shown with its owner ("acme/api"), not as "Api"
      name = WEAK_REPO_NAMES.has(topRepo) && owner ? `${owner}/${topRepo}${kind ? ` ${kind}` : ''}` : `${titleCasePhrase(topRepo.replace(/[-_]+/g, ' '))}${kind ? ` ${kind}` : ''}`;
    } else if (siteOnly) name = sharedHint || siteName(members[0].url, members[0].title);
    else if (nameTop && isPlaceKey(nameTop[0]) && conceptLabel(c, docs) === 'Housing') name = `${bestSurface(nameTop[0])} housing`; // flats in Edinburgh are not the Edinburgh trip
    else if (libraryName(members, majority)) name = libraryName(members, majority);
    else if (bigramRanked.length) { name = titleCasePhrase(words2(bigramRanked[0])); wordNamed = true; }
    else if (nameTop) { name = titleCase(bestSurface(nameTop[0])); wordNamed = true; }
    else name = sharedHint || fallbackName();
    // CJK words are bigrams, so two of them pasted together name a group badly ("파이 이썬"): use the longest run the
    // titles share, or the site's (category's) name when that run is only filler.
    // A bare place ("Texas", "Austin") names a trip and nothing else: a group of tabs that only share where they are is named for what they are about
    // (the next word they say, else their concept or category), and only a trip (tripGroups) or a place's own housing keeps the place.
    if (wordNamed && !/\s/.test(name) && isPlaceKey(stem(name.toLowerCase())) && members.filter(tripEvidence).length * 2 < members.length && !['Travel', 'Housing'].includes(conceptLabel(c, docs))) {
      const other = ranked.find(([k]) => !isGenericKey(k) && !isPlaceKey(k));
      const label = conceptLabel(c, docs) || categoryLabel(members);
      if (other) name = titleCase(bestSurface(other[0]));
      else if (label) { name = label; wordNamed = false; }
    }
    // A vague word ("Permit", "Stray", "Sierra", "Mars") never names a group: the concept's name does, else the two tabs stay loose (a pair that only a
    // vague word holds is inside a larger topic, or no topic at all); a proper two-word name the titles write ("Stray Kids") beats its first word.
    if (wordNamed && !/\s/.test(name)) {
      const key = stemWord(name.toLowerCase());
      const oneConcept = [...docs[c[0]].words.keys()].some((x) => x[0] === '%' && x !== '%shopping' && c.every((i) => docs[i].words.has(x))); // "Chicken" over three cooking tabs
      if ((AMBIGUOUS_KEYS.has(key) && !oneConcept) || VAGUE_NAME_KEYS.has(key)) {
        const phrase = new RegExp(`\\b${name}\\s+(\\p{Lu}[\\p{Ll}]+)`, 'u');
        const full = members.map((d) => phrase.exec(String(d.title))?.[1]).filter(Boolean);
        const top = [...full.reduce((m, w) => m.set(w, (m.get(w) || 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0];
        const label = conceptLabel(c, docs) || categoryLabel(members);
        if (top && top[1] * 2 > members.length) name = `${name} ${top[0]}`;
        else if (label) { name = label; wordNamed = false; } else if (members.length <= 2) return null;
      }
    }
    if (wordNamed) name = normalizeName(name, [conceptLabel(c, docs), categoryLabel(members), sharedHint], new Set(members.flatMap((d) => [...d.words].map(([, e]) => String(e.surface || '').toLowerCase()))));
    if (CJK.test(name)) name = sharedRun(members.map((d) => d.title), members.length) || sharedRun(members.map((d) => d.title), majority) || sharedHint || fallbackName();
    // One site's tabs named by a piece of the site's own name ("Hacker" from "Hacker News"): the whole name.
    if (members.every((d) => d.siteKey === members[0].siteKey) && !oneSite) {
      const site = siteName(members[0].url, members[0].title);
      if (site.length > name.length && site.toLowerCase().split(/\s+/).includes(name.toLowerCase())) name = site;
    }
    // "Next" from "Next.js" titles: keep the suffix a library name is written with.
    const dotted = /^[A-Za-z]+$/.test(name) && members.find((d) => new RegExp(`\\b${name}\\.(js|ts|py|io)\\b`, 'i').test(d.title));
    if (dotted) name = `${name}${String(dotted.title).match(new RegExp(`\\b${name}(\\.(?:js|ts|py|io))\\b`, 'i'))[1]}`;
    if (!name) return null;
    return { name: clip(name), ids: members.map((d) => d.id), key: top?.[0] || null, cohesion };
  }).filter(Boolean);
  return Object.assign(named, { hasCommon: docs.hasCommon });
}

// ---------- incremental placement: where does ONE tab belong among the groups that already exist? ----------
//
// A tab that just loaded (or changed title or site) is scored against each group's pooled words,
// with the same signal as "Organize by topic". It joins the best group only above TOPIC_THRESHOLD,
// and a tab that is already in a group only moves to another one that fits clearly better (MOVE_MARGIN).
// Pure: no tab objects, just entries ({ id, title, url, text, hint }).
const MAX_AUTO_MOVES = 3; // automatic placements/moves per tab, so a tab whose title keeps changing settles
const MOVE_MARGIN = 0.15;
const SAME_SITE_BONUS = 0.12; // a group already holding pages of this site: the site itself is weak evidence
const SITE_HINT_BONUS = 0.2; // a group of this tab's site hint ("School"): strong evidence, see scoreOf

// items: [{ entry, current }] (current: the group id the tab is in now, or null).
// groupList: [{ id, domain, members: [entry] }]. background: other loose entries, only for idf.
// Returns an array parallel to items: the group id to put each tab in, or null to leave it as it is.
function placeTabs(items, groupList, { background = [], threshold = TOPIC_THRESHOLD, margin = MOVE_MARGIN, bonus = null } = {}) {
  if (!items.length || !groupList.length) return items.map(() => null);
  const byId = new Map();
  for (const e of [...items.map((i) => i.entry), ...groupList.flatMap((g) => g.members), ...background]) if (!byId.has(e.id)) byId.set(e.id, e);
  const list = [...byId.values()];
  const docs = vectorize(list);
  const doc = new Map(list.map((e, i) => [e.id, docs[i]]));
  const pooled = new Map();
  const centroidFor = (g, exceptId) => {
    const key = `${g.id}|${g.members.some((m) => m.id === exceptId) ? exceptId : ''}`;
    if (!pooled.has(key)) {
      const rest = g.members.filter((m) => m.id !== exceptId);
      pooled.set(key, rest.length ? { members: rest, centroid: centroidOf(rest.map((m) => doc.get(m.id))) } : null);
    }
    return pooled.get(key);
  };
  // A group most of whose tabs have a site hint ("School"): a tab with that hint belongs there as in
  // topicClusters' fifth stage - on the hint alone when it is the only such group, and with a few
  // words in common when there are several (two courses).
  const hintMajor = (g) => { const n = new Map(); for (const m of g.members) { const h = doc.get(m.id).siteHint; if (h) n.set(h, (n.get(h) || 0) + 1); } return [...n].find(([, c]) => c * 2 > g.members.length)?.[0] || ''; };
  const hintOfGroup = new Map(groupList.map((g) => [g.id, g.domain ? '' : hintMajor(g)]));
  const scoreOf = (entry, g) => {
    const d = doc.get(entry.id);
    const pool = centroidFor(g, entry.id);
    if (!pool) return 0;
    if (g.domain && siteKey(entry.url) === g.domain) return 1; // a by-site group: its own site's tabs belong
    const s = cosine(d, pool.centroid);
    const sameSite = Boolean(d.site) && pool.members.some((m) => doc.get(m.id).site === d.site);
    // What the user taught (bonus): only tips a tab that already has SOME words in common with the group.
    const taught = bonus && s >= 0.05 ? bonus(entry, g) : 0;
    const score = s + (sameSite && s >= threshold * 0.6 ? SAME_SITE_BONUS : 0) + taught;
    const hint = d.siteHint && !knowledge.BROAD_HINTS.has(d.siteHint) ? d.siteHint : '';
    if (hint && hintOfGroup.get(g.id) === hint) {
      const rivals = groupList.filter((o) => o.id !== g.id && hintOfGroup.get(o.id) === hint).length;
      if (!rivals || s >= SAME_SITE_MIN_COS) return Math.max(score + SITE_HINT_BONUS, threshold);
    }
    return score;
  };
  return items.map(({ entry, current }) => {
    let best = null;
    let cur = 0;
    for (const g of groupList) {
      const s = scoreOf(entry, g);
      if (g.id === current) cur = s;
      else if (s >= threshold && (!best || s > best.s || (s === best.s && g.id < best.id))) best = { id: g.id, s };
    }
    if (current != null && groupList.some((g) => g.id === current)) {
      if (!best || best.s < cur + margin) return null;
      return best.id;
    }
    return best ? best.id : null;
  });
}

// ---------- a model's proposal, made safe ----------

const MAX_AI_GROUPS = 8;
function cleanGroupName(name) {
  return String(name || '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f<>"]/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join(' ').slice(0, 30);
}

// [{ name, tab_ids }] from a model -> [{ name, ids }] using only ids in validIds, each in one group,
// 2+ tabs per group, at most MAX_AI_GROUPS groups (the biggest). Anything else (not an array, no
// usable group, one group swallowing almost every tab) is null: the caller uses the local organizer.
function sanitizeProposal(proposal, validIds) {
  if (!Array.isArray(proposal)) return null;
  const valid = validIds instanceof Set ? validIds : new Set(validIds);
  const used = new Set();
  const out = [];
  for (const g of proposal) {
    if (!g || typeof g !== 'object') continue;
    const name = cleanGroupName(g.name);
    const ids = [];
    for (const raw of Array.isArray(g.tab_ids) ? g.tab_ids : []) {
      const id = Number(raw);
      if (Number.isInteger(id) && valid.has(id) && !used.has(id) && !ids.includes(id)) ids.push(id);
    }
    if (!name || ids.length < 2) continue;
    ids.forEach((id) => used.add(id));
    out.push({ name, ids });
  }
  if (!out.length) return null;
  const kept = out.length > MAX_AI_GROUPS ? [...out].sort((a, b) => b.ids.length - a.ids.length).slice(0, MAX_AI_GROUPS).sort((a, b) => out.indexOf(a) - out.indexOf(b)) : out;
  if (valid.size >= 6 && kept.some((g) => g.ids.length > valid.size * 0.8)) return null;
  return kept;
}

// The words of a tab's address path worth telling a model: "docs/react/hooks" -> "docs react hooks".
// Never the query string or fragment, and nothing that looks like an id, hash or token.
function pathWords(url, max = 6) {
  let pathname = '';
  try { ({ pathname } = new URL(url)); } catch { return ''; }
  const words = [];
  for (const seg of pathname.split('/')) {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch {}
    for (const w of s.split(/[^\p{L}]+/u)) {
      if (w.length >= 3 && w.length <= 20 && !/^[a-f]+$/i.test(w) && !STOPWORDS.has(w.toLowerCase())) words.push(w.toLowerCase());
    }
  }
  return [...new Set(words)].slice(0, max).join(' ');
}

// ---------- merging groups with similar names ----------

const NAME_FILLER = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'and', 'in', 'on', 'with', 'tabs', 'tab', 'pages', 'page', 'links', 'stuff', 'misc', 'other', 'things']);
// A word that says WHAT KIND of thing the tabs are ("Lumen PRs" vs "Lumen"): a qualifier that keeps two
// groups apart on names alone.
const NAME_KIND = new Set(['pr', 'prs', 'issue', 'doc', 'discussion', 'video', 'review', 'pull', 'request', 'news', 'tutorial']);

function nameTokens(name) {
  return String(name).replace(/\(\d+\)\s*$/, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !NAME_FILLER.has(w)).map(stem);
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_v, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// How alike two group names are: 'exact' (same words after case, punctuation, plural and "(2)"),
// 'contain' (one is the other plus plain words: "Flights" / "Flights to Tokyo"), 'close' (a typo apart),
// 'weak' (they share a real word), or null. "Java" and "JavaScript" are none of these.
function nameSimilarity(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return null;
  if ([...ta].sort().join(' ') === [...tb].sort().join(' ')) return 'exact';
  const [small, big] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (small.length < big.length && small.every((w) => big.includes(w)) && small.some((w) => w.length >= 4) && big.filter((w) => !small.includes(w)).every((w) => !NAME_KIND.has(w))) return 'contain';
  const ja = ta.join('');
  const jb = tb.join('');
  const len = Math.min(ja.length, jb.length);
  if (len >= 5 && ja[0] === jb[0] && levenshtein(ja, jb) <= Math.max(1, Math.floor(len / 8))) return 'close';
  if (ta.some((w) => w.length >= 4 && tb.includes(w))) return 'weak';
  return null;
}

// groups: [{ id, name, color, auto, userNamed, domain, members: [entry] }] (the window's own groups).
// Groups formed at different times that are one topic: most of both carry the same country
// (a Tokyo group and a Japan group), or a small one shares a specific concept with a big one.
function sameTopicLater(A, B) {
  const major = (D, pred) => { const m = new Map(); for (const d of D) for (const k of d.vec.keys()) if (pred(k)) m.set(k, (m.get(k) || 0) + 1); return new Set([...m].filter(([, n]) => n / D.length > 0.5).map(([k]) => k)); };
  const ca = major(A, (k) => COUNTRY_KEYS.has(k));
  // A shared country is only a trip when most of both groups are about travel or housing (a place alone links nothing: see sharedEvidence).
  const trips = (D) => ['%travel', '%housing'].some((c) => major(D, (k) => k === c).size);
  if (trips(A) && trips(B) && [...major(B, (k) => COUNTRY_KEYS.has(k))].some((k) => ca.has(k))) return true;
  const [small, big] = A.length <= B.length ? [A, B] : [B, A];
  if (small.length > ABSORB_MAX || big.length < 4) return false;
  const cs = major(small, (k) => k[0] === '%');
  if (![...major(big, (k) => k[0] === '%')].some((k) => cs.has(k))) return false;
  return cosine(centroidOf(small), centroidOf(big)) >= ABSORB_MIN_COS;
}

// Returns the merges to make: [{ into, from: [ids], name, color, auto, userNamed }]. Deterministic: oldest
// group first, one pass (a merged group is not compared again), so merging can't ping-pong. By-site
// groups are left alone. Groups the user made or named only merge with an exact twin, and then the
// user's name and colour survive; otherwise the more specific name and the oldest group's colour do.
function mergeSimilarGroups(groups) {
  const list = groups.filter((g) => !g.domain && g.members.length).sort((a, b) => a.id - b.id);
  if (list.length < 2) return [];
  const docs = vectorize(list.flatMap((g) => g.members));
  const doc = new Map(docs.map((d) => [d.id, d]));
  const centroid = new Map(list.map((g) => [g.id, centroidOf(g.members.map((m) => doc.get(m.id)))]));
  const owned = (g) => !g.auto || g.userNamed;
  const clusters = [];
  const docsOf = (g) => g.members.map((m) => doc.get(m.id));
  const place = new Map(docs.map((d, i) => [d.id, i]));
  const bound = (c, g) => {
    const A = c.flatMap((o) => o.members.map((m) => place.get(m.id)));
    const B = g.members.map((m) => place.get(m.id));
    return supportsOf([...A, ...B], docs).some((s) => s.holders.some((h) => A.includes(h)) && s.holders.some((h) => B.includes(h)));
  };
  for (const g of list) {
    const home = clusters.find((c) => {
      const root = c[0];
      const kind = nameSimilarity(root.name, g.name);
      if (kind === 'exact') return c.some(owned) || owned(g) || bound(c, g); // a trip pair and a housing pair that both say "Edinburgh" are two groups
      if (c.some(owned) || owned(g)) return false;
      // Two groups are one only when tabs of both share something that says something (see cohere): a place or a generic word is not enough.
      if (!bound(c, g)) return false;
      if (!kind) return Boolean(anchorLink(c.flatMap(docsOf), docsOf(g), docs.df, docs.n)) || sameTopicLater(c.flatMap(docsOf), docsOf(g)); // groups formed at different times, one topic
      const sim = cosine(centroid.get(root.id), centroid.get(g.id), false); // (bound above by the same evidence rule: no second gate)
      return kind === 'weak' ? sim >= CENTROID_MERGE_THRESHOLD : sim >= 0.1;
    });
    if (home) home.push(g); else clusters.push([g]);
  }
  return clusters.filter((c) => c.length > 1).map((c) => {
    const named = c.find((g) => g.userNamed);
    const specific = [...c].sort((a, b) => nameTokens(b.name).length - nameTokens(a.name).length || b.name.length - a.name.length || a.id - b.id)[0];
    const base = named || specific;
    return {
      into: c[0].id,
      from: c.slice(1).map((g) => g.id),
      name: base.name.replace(/\s*\(\d+\)\s*$/, '') || base.name,
      color: named ? named.color : c[0].color,
      auto: c.every((g) => g.auto),
      userNamed: c.some((g) => g.userNamed),
    };
  });
}

// mode(): 'off' | 'site' | 'topic' (automatic grouping).
function createTabGroups({ getTabs, setTabs, urlOf, titleOf, textOf, isWeb, mode, aiTopics, onChange, learned = null }) {
  const groups = new Map(); // id -> { id, name, color, collapsed, domain, topic, auto }
  const isAuto = () => mode() !== 'off';
  let undoState = null; // the tabs and groups from before the last "Organize"
  let autoUndo = null; // the tabs the last automatic by-topic placement moved, and where they were
  let undoSeq = 0;
  let nextId = 1;
  let colorIndex = 0;

  const tabById = (id) => getTabs().find((t) => t.id === id);
  const members = (groupId) => getTabs().filter((t) => t.groupId === groupId);

  // Grouped tabs stay together, at the position of the group's first tab.
  function arrange() {
    const out = [];
    const placed = new Set();
    for (const tab of getTabs()) {
      if (!tab.groupId) out.push(tab);
      else if (!placed.has(tab.groupId)) {
        placed.add(tab.groupId);
        out.push(...members(tab.groupId));
      }
    }
    setTabs(out);
  }

  function cleanup() {
    for (const id of groups.keys()) if (!members(id).length) groups.delete(id);
  }

  // "Docs" twice becomes "Docs" and "Docs (2)"
  function uniqueName(name, exceptId = null) {
    const taken = new Set([...groups.values()].filter((g) => g.id !== exceptId).map((g) => g.name.toLowerCase()));
    if (!taken.has(String(name).toLowerCase())) return name;
    for (let n = 2; ; n++) if (!taken.has(`${name} (${n})`.toLowerCase())) return `${name} (${n})`;
  }

  // One merge pass over this window's groups (see mergeSimilarGroups). `moves`: an automatic pass's
  // record of where tabs were, so undoAuto can put them back. Returns how many groups went away and
  // the groups as they were before.
  function mergeSimilar(moves = null) {
    const plan = mergeSimilarGroups([...groups.values()].map((g) => ({ ...g, members: members(g.id).filter((t) => !pinned(t)).map(entry) })));
    const touched = [];
    let gone = 0;
    for (const { into, from, name, color, auto, userNamed } of plan) {
      const keep = groups.get(into);
      touched.push({ ...keep }, ...from.map((id) => ({ ...groups.get(id) })));
      for (const id of from) {
        for (const tab of members(id)) {
          if (pinned(tab)) continue;
          if (moves && !moves.has(tab.id)) moves.set(tab.id, id);
          tab.groupId = into;
        }
        groups.delete(id);
        gone++;
      }
      keep.name = uniqueName(name, keep.id).slice(0, 40);
      keep.color = color;
      keep.auto = auto;
      keep.userNamed = userNamed;
    }
    if (gone) { arrange(); cleanup(); }
    return { gone, touched };
  }

  const pinned = (t) => Boolean(t.pinned);
  // aiHint: what a model once said this tab's site is for (features/organize-learn.js aiHint); the fixed
  // table (siteHint) always wins over it, and a site the user filed under a group of their own has none.
  const entry = (t) => { const url = urlOf(t); return { id: t.id, title: titleOf(t), url, text: textOf ? textOf(t) : '', hint: t.openerQuery || '', aiHint: learned?.aiHint?.(url) || '' }; };
  const keyOf = (t) => { const e = entry(t); return `${e.title}|${e.url}|${e.text.length}`; };

  function create(name, tabIds, { domain = null, color, topic = null, auto = false, cohesion } = {}) {
    const group = {
      id: nextId++,
      name: String(name || 'Group').slice(0, 40),
      color: GROUP_COLORS.includes(color) ? color : COLOR_CYCLE[colorIndex++ % COLOR_CYCLE.length],
      collapsed: false,
      domain,
      topic, // the shared word a topic group was formed on; later tabs with it join
      auto, // made by automatic grouping (can be re-organized); groups the user made never are
      ...(cohesion == null ? {} : { cohesion }), // how tight the cluster was when formed (0-1)
    };
    groups.set(group.id, group);
    for (const id of tabIds) {
      const tab = tabById(id);
      if (!tab) continue;
      tab.groupId = group.id;
      tab.userRemoved = false;
      if (auto) tab.autoKey = keyOf(tab);
      else tab.userPlaced = true; // put there by the user (or an agent asked by them): never moved automatically
    }
    cleanup();
    arrange();
    return group;
  }

  // `auto`: an automatic placement (an opener's group), not a choice the user made.
  function add(tabId, groupId, { auto = false } = {}) {
    const tab = tabById(tabId);
    if (!tab || !groups.has(groupId)) return false;
    tab.groupId = groupId;
    tab.userRemoved = false;
    if (!auto) tab.userPlaced = true;
    arrange();
    cleanup();
    return true;
  }

  // Leaving a group puts the tab right after the group; `byUser` stops auto-grouping from pulling it back.
  function remove(tabId, { byUser = false } = {}) {
    const tab = tabById(tabId);
    if (!tab || !tab.groupId) return false;
    const groupId = tab.groupId;
    tab.groupId = null;
    if (byUser) tab.userRemoved = true;
    const list = getTabs().filter((t) => t !== tab);
    const lastIndex = list.map((t) => t.groupId).lastIndexOf(groupId);
    list.splice(lastIndex + 1, 0, tab);
    setTabs(list);
    cleanup();
    return true;
  }

  function ungroupAll(groupId) {
    for (const tab of members(groupId)) tab.groupId = null;
    groups.delete(groupId);
  }

  // A tab opened from another tab joins the opener's group (a new one if the opener has none).
  function joinOpener(tab, opener) {
    if (!isAuto() || !opener) return;
    // A tab opened from a search results page carries that search's words: it is what the search led to.
    const from = urlOf(opener);
    if (SEARCH_DOMAINS.has(registrableDomain(from))) tab.openerQuery = queryText(from).slice(0, 200);
    // Opened tabs sit right after the opener (or its group), like Safari and Chrome.
    const list = getTabs().filter((t) => t !== tab);
    const at = opener.groupId ? list.map((t) => t.groupId).lastIndexOf(opener.groupId) : list.indexOf(opener);
    list.splice(at + 1, 0, tab);
    setTabs(list);
    // One link opened in a new tab is not a topic: it only joins a group the opener is already in
    // (and is looked at again once it has a title: see autoGroupTopics).
    if (!pinned(tab) && opener.groupId && groups.has(opener.groupId)) {
      add(tab.id, opener.groupId, { auto: true });
      tab.autoMoves = 1;
    }
  }

  // Tabs automatic grouping may move: ungrouped web tabs the user hasn't taken out of a group,
  // dragged into place or put into a group themselves. Pinned tabs never.
  const movable = (t) => !pinned(t) && !t.userRemoved && !t.userMoved && !t.userPlaced && isWeb(urlOf(t));
  const loose = () => getTabs().filter((t) => !t.groupId && movable(t));
  // What an explicit Organize regroups: every loose web tab (a hand-drag, a restored session or a pin toggle only
  // stop AUTOMATIC grouping, not a request to organize) and every tab in an automatic group, hand-added ones too
  // (the user asked to organize: they are regrouped by topic, and Undo puts them back). Never pinned tabs, closing
  // tabs, or tabs in a group the user made or named.
  const organizable = (t) => !pinned(t) && !t.closing && isWeb(urlOf(t))
    && (!t.groupId || (Boolean(groups.get(t.groupId)?.auto) && !groups.get(t.groupId).userNamed));
  // Why there may be nothing to organize: { web, pinned, kept } (web tabs overall, pinned ones, ones in the user's own groups).
  const organizeCounts = () => {
    const all = getTabs().filter((t) => !t.closing && isWeb(urlOf(t)));
    return { web: all.length, pinned: all.filter(pinned).length, kept: all.filter((t) => !pinned(t) && !organizable(t)).length };
  };

  // By topic, continuously: each tab whose title, address or page text changed (or that has no group)
  // is scored against every automatic group - topic groups and by-site groups alike - and joins, or
  // moves to, the best one it clearly fits. Tabs still loose that are related to each other then form
  // new groups of their own (2+; 4+ loose tabs at the normal threshold, 2-3 need stronger evidence).
  // Every batch is one step for undoOrganize. Returns whether anything changed.
  function autoGroupTopics({ cluster = true } = {}) {
    const groupsBefore = [...groups.keys()];
    const autoGroups = [...groups.values()].filter((g) => g.auto);
    const moves = new Map(); // tab id -> the group it was in before (null: none)
    const record = (tab) => { if (!moves.has(tab.id)) moves.set(tab.id, tab.groupId || null); };
    const candidates = getTabs().filter((t) => movable(t) && (t.autoMoves || 0) < MAX_AUTO_MOVES
      && (t.groupId ? groups.get(t.groupId)?.auto && t.autoKey !== keyOf(t) : true));
    if (autoGroups.length && candidates.length) {
      const groupList = autoGroups.map((g) => ({ id: g.id, name: g.name, domain: g.domain, members: members(g.id).map(entry) }));
      const candidateIds = new Set(candidates.map((t) => t.id));
      const background = loose().filter((t) => !candidateIds.has(t.id)).map(entry);
      const result = placeTabs(candidates.map((t) => ({ entry: entry(t), current: t.groupId || null })), groupList, { background, bonus: learned ? (e, g) => learned.affinity(e, g.name) : null });
      candidates.forEach((tab, i) => {
        tab.autoKey = keyOf(tab);
        if (result[i] == null) return;
        record(tab);
        tab.groupId = result[i];
        tab.autoMoves = (tab.autoMoves || 0) + 1;
      });
    }
    const rest = loose();
    if (cluster && rest.length >= 2) {
      const threshold = rest.length >= 4 ? TOPIC_THRESHOLD : LOOSE_PAIR_THRESHOLD;
      for (const c of topicClusters(rest.map(entry), { threshold })) {
        const ids = c.ids.filter((id) => !tabById(id)?.groupId);
        if (ids.length < 2) continue;
        for (const id of ids) record(tabById(id));
        create(uniqueName(c.name), ids, { topic: c.key, auto: true });
        for (const id of ids) tabById(id).autoMoves = 1;
      }
    }
    const merged = groups.size > groupsBefore.length || moves.size ? mergeSimilar(moves) : { touched: [] };
    if (!moves.size) return false;
    autoUndo = { seq: ++undoSeq, moves, groups: merged.touched };
    arrange();
    cleanup();
    return true;
  }

  // Three or more ungrouped tabs from one site form a group; later tabs of that site join it.
  function autoGroup() {
    if (!isAuto()) return false;
    if (mode() === 'topic') return autoGroupTopics({ cluster: !aiTopics?.() }); // with AI naming on, main clusters through the model
    let changed = false;
    const bySite = new Map();
    for (const tab of getTabs()) {
      if (tab.groupId || pinned(tab) || tab.userRemoved || tab.userMoved || tab.userPlaced || !isWeb(urlOf(tab))) continue;
      const domain = siteKey(urlOf(tab));
      if (!domain || SEARCH_DOMAINS.has(domain)) continue; // result pages from a search engine aren't a topic
      if (!bySite.has(domain)) bySite.set(domain, []);
      bySite.get(domain).push(tab);
    }
    for (const [domain, list] of bySite) {
      const existing = [...groups.values()].find((g) => g.domain === domain);
      if (existing) {
        for (const tab of list) tab.groupId = existing.id;
        changed = true;
      } else if (list.length >= 3) {
        create(uniqueName(siteName(urlOf(list[0]), titleOf(list[0]))), list.map((t) => t.id), { domain, auto: true });
        changed = true;
      }
    }
    if (changed) { arrange(); cleanup(); }
    return changed;
  }

  function saveUndo() {
    undoState = {
      seq: ++undoSeq,
      order: getTabs().map((t) => t.id),
      tabs: new Map(getTabs().map((t) => [t.id, t.groupId || null])),
      flags: new Map(getTabs().map((t) => [t.id, { userRemoved: Boolean(t.userRemoved), userPlaced: Boolean(t.userPlaced), userMoved: Boolean(t.userMoved), autoMoves: t.autoMoves || 0 }])),
      groups: snapshot(),
    };
    autoUndo = null; // this step includes everything the automatic ones did
  }

  // "Organize Tabs by Topic" / "Organize with AI": loose tabs and tabs in automatic groups are regrouped,
  // from the local clusters or a proposal ([{ name, tab_ids }] from an AI model; anything unusable in it
  // falls back to the local clusters). Groups the user made, and tabs the user took out of groups,
  // dragged, or pinned, stay as they are. A new group that mostly matches an old automatic one keeps
  // its colour (and, for local clusters, its name) so the tab strip doesn't reshuffle. One step of undo.
  // What the strip shows of grouping: each group's name with its tabs, and the loose tabs. Ids of groups are left out, so regrouping into the
  // same groups gives the same signature (organize-ai: "Already organized"). `groups`: how many there are.
  function layoutSignature() {
    const names = new Map();
    for (const g of groups.values()) names.set(g.id, g.name);
    const byGroup = new Map();
    const loose_ = [];
    for (const t of getTabs()) {
      if (t.groupId && names.has(t.groupId)) { if (!byGroup.has(t.groupId)) byGroup.set(t.groupId, []); byGroup.get(t.groupId).push(t.id); } else loose_.push(t.id);
    }
    const parts = [...byGroup].map(([id, ids]) => `${names.get(id)}\u0001${ids.sort((a, b) => String(a).localeCompare(String(b))).join(',')}`).sort();
    return { key: `${parts.join('|')}#${loose_.sort((a, b) => String(a).localeCompare(String(b))).join(',')}`, groups: byGroup.size };
  }
  function organizeByTopic(proposal = null) {
    const prev = { undoState, autoUndo, undoSeq };
    saveUndo();
    // An explicit Organize is a request to regroup: userRemoved (set on every loose tab of a restored session, or by a
    // hand-ungroup) must not hide tabs from it. saveUndo() just kept the flags, so Undo brings them back.
    // Only the tabs Organize takes are cleared (loose ones dragged by hand, and hand-added members of automatic groups
    // count too; Undo restores the marks): pinned tabs and tabs in the user's own groups keep theirs.
    for (const t of getTabs()) if (organizable(t)) { t.userMoved = false; t.userPlaced = false; t.userRemoved = false; }
    const prior = [...groups.values()].filter((g) => g.auto).map((g) => ({ ...g, ids: new Set(members(g.id).map((t) => t.id)) }));
    for (const g of prior) ungroupAll(g.id);
    for (const t of getTabs()) { t.autoMoves = 0; t.autoKey = null; }
    const before = new Set(groups.keys());
    const count = groupLoose(proposal, { prior, categories: true });
    // Nothing grouped: the automatic groups just dissolved are put back (and the marks), so "left as they are" is true.
    if (!count) { undoOrganize(); ({ undoState, autoUndo, undoSeq } = prev); return 0; }
    orderGroupsByRecency();
    spreadColors(new Set([...groups.keys()].filter((id) => !before.has(id))));
    return count;
  }

  // The groups Organize made sit in the strip by how recently their tabs were used, most recent first.
  // Only the places those groups already held are reshuffled: loose, pinned and user-made groups stay put.
  const usedAt = (t) => Math.max(t.lastActiveAt || 0, t.viewedAt || 0);
  function orderGroupsByRecency() {
    const blocks = [];
    const seen = new Set();
    for (const t of getTabs()) {
      if (!t.groupId) blocks.push({ tabs: [t] });
      else if (!seen.has(t.groupId)) { seen.add(t.groupId); blocks.push({ gid: t.groupId, tabs: members(t.groupId) }); }
    }
    const mine = (b) => { const g = b.gid && groups.get(b.gid); return Boolean(g) && g.auto && !g.userNamed && !g.domain; };
    const slots = blocks.map((b, i) => (mine(b) ? i : -1)).filter((i) => i >= 0);
    if (slots.length < 2) return;
    const recent = (b) => Math.max(...b.tabs.map(usedAt));
    const sorted = slots.map((i) => blocks[i]).map((b, k) => ({ b, k })).sort((x, y) => recent(y.b) - recent(x.b) || x.k - y.k).map((x) => x.b);
    slots.forEach((slot, i) => { blocks[slot] = sorted[i]; });
    setTabs(blocks.flatMap((b) => b.tabs));
  }

  // New groups never share a colour with the group beside them (the colour of a group that already
  // existed, or one the user picked, is never changed).
  function spreadColors(newIds) {
    if (!newIds.size) return;
    const order = [];
    for (const t of getTabs()) if (t.groupId && !order.includes(t.groupId)) order.push(t.groupId);
    const used = new Map(GROUP_COLORS.map((c) => [c, 0]));
    for (const id of order) { const g = groups.get(id); if (g) used.set(g.color, (used.get(g.color) || 0) + 1); }
    order.forEach((id, i) => {
      const g = groups.get(id);
      if (!g || !newIds.has(id) || g.colorLocked) return;
      const near = [order[i - 1], order[i + 1]].map((n) => groups.get(n)?.color).filter(Boolean);
      const clash = (c) => near.includes(c) || near.some((n) => (LOOKALIKE[n] || []).includes(c));
      if (!clash(g.color)) return;
      const rank = (c) => (used.get(c) || 0) * 10 + COLOR_CYCLE.indexOf(c) / 10; // the least used first, then the cycle's order: deterministic
      const pick = COLOR_CYCLE.filter((c) => !clash(c)).sort((a, b) => rank(a) - rank(b))[0] || COLOR_CYCLE.filter((c) => !near.includes(c)).sort((a, b) => rank(a) - rank(b))[0];
      if (pick && pick !== g.color) { used.set(g.color, used.get(g.color) - 1); used.set(pick, (used.get(pick) || 0) + 1); g.color = pick; }
    });
  }
  const applyProposal = organizeByTopic; // the older name: "Organize with AI"

  // Groups loose tabs only: from a proposal ([{ name, tab_ids }]) or the local clusters.
  function groupLoose(proposal = null, { prior = [], categories = false } = {}) {
    const pool = loose();
    const poolIds = new Set(pool.map((t) => t.id));
    const proposed = proposal ? sanitizeProposal(proposal, poolIds) : null;
    const clusters = proposed ? proposed.map((g) => ({ name: g.name, ids: g.ids, key: null, ai: true })) : topicClusters(pool.map(entry), { categories });
    const used = new Set();
    const claimed = new Set();
    let count = 0;
    for (const c of clusters) {
      const ids = c.ids.filter((id) => !used.has(id));
      if (ids.length < 2 || !c.name) continue;
      ids.forEach((id) => used.add(id));
      // The old automatic group these tabs mostly came from (stable colour and name).
      const old = prior.filter((p) => !claimed.has(p.id)).map((p) => ({ p, n: ids.filter((id) => p.ids.has(id)).length }))
        .filter(({ p, n }) => n >= 2 && n >= Math.min(ids.length, p.ids.size) / 2).sort((a, b) => b.n - a.n)[0]?.p;
      // A model's group named like a group that exists: the tabs join it rather than a twin.
      const twin = c.ai && [...groups.values()].find((g) => g.name.toLowerCase() === c.name.toLowerCase());
      if (twin) {
        for (const id of ids) add(id, twin.id, { auto: true });
        count++;
        continue;
      }
      if (old) claimed.add(old.id);
      // A name the user gave this kind of group before (renamed it, or filed such tabs under it) wins over the automatic one.
      const taught = !c.ai && !old && learned ? learned.nameFor(ids.map((id) => entry(tabById(id))), c.name) : c.name;
      create(uniqueName(old && !c.ai ? old.name : taught), ids, { topic: c.key, auto: true, color: old?.color, cohesion: c.cohesion });
      count++;
    }
    arrange();
    cleanup();
    return count > 0 ? Math.max(count - mergeSimilar().gone, 1) : 0;
  }

  // The topic groups "Organize" made (automatic ones the user hasn't named) with their tabs, and the tabs
  // still loose: what a model is asked to refine. Read only.
  // explicit: for an Organize the user asked for (organize-ai.js): the marks that only stop AUTOMATIC grouping
  // (userRemoved on every tab of a restored session, a hand-ungroup, a hand-drag) hide nothing, as in organizeByTopic.
  // organizeByTopic rolls back when it grouped nothing, which puts those marks back: the model must still see the tabs.
  function organizeView({ explicit = false } = {}) {
    const isCandidate = explicit ? organizable : (t) => !pinned(t) && !t.userRemoved && !t.userMoved && !t.userPlaced && isWeb(urlOf(t));
    const list = [];
    for (const g of groups.values()) {
      if (!g.auto || g.userNamed || g.domain) continue;
      const entries = members(g.id).filter(isCandidate).map(entry);
      if (entries.length) list.push({ id: g.id, name: g.name, cohesion: g.cohesion, entries });
    }
    return { groups: list, leftovers: (explicit ? getTabs().filter((t) => !t.groupId && organizable(t)) : loose()).map(entry) };
  }

  // Phase two of "Organize with AI" (see features/organize-ai.js planApply): rename groups in place, put
  // loose tabs into groups, form new groups from loose tabs, merge groups. It changes nothing the user
  // changed meanwhile, and adds no step of undo: it belongs to the organize step `seq` names, and does
  // nothing at all once that step was undone or another one was made.
  // fresh: there was no local organize step to belong to (nothing grouped locally): it starts one step of
  // undo of its own, and drops it again when nothing was grouped.
  function applyRefinement({ renames = [], places = [], groups: created = [], merges = [] } = {}, { seq = null, fresh = false, explicit = false } = {}) {
    const out = { renamed: 0, placed: 0, created: 0, merged: 0 };
    if (fresh) {
      const prev = { undoState, autoUndo, undoSeq };
      const before = new Set(groups.keys());
      saveUndo(); // keeps the marks (userRemoved ...) as they are: Undo brings them back
      const res = applyRefinement({ renames, places, groups: created, merges }, { seq: undoState.seq, explicit: true });
      if (!res.created && !res.renamed && !res.placed && !res.merged) { ({ undoState, autoUndo, undoSeq } = prev); return res; }
      spreadColors(new Set([...groups.keys()].filter((id) => !before.has(id))));
      return res;
    }
    if (seq != null && undoState?.seq !== seq) return out;
    const mine = (g) => g && g.auto && !g.userNamed;
    for (const { into, from } of merges) {
      const keep = groups.get(into);
      const gone = groups.get(from);
      if (!mine(keep) || !mine(gone)) continue;
      for (const tab of members(from)) if (!pinned(tab)) tab.groupId = into;
      groups.delete(from);
      out.merged++;
    }
    for (const { id, name } of renames) {
      const g = groups.get(id);
      const clean = cleanGroupName(name);
      if (!mine(g) || !clean) continue;
      // Renamed like another automatic group: the two are one group ("Finance" and "Finance (2)" help no one).
      const twin = [...groups.values()].find((o) => o.id !== id && mine(o) && !o.domain && o.name.toLowerCase() === clean.toLowerCase());
      if (twin) {
        const [keep, gone] = twin.id < id ? [twin, g] : [g, twin];
        for (const tab of members(gone.id)) if (!pinned(tab)) tab.groupId = keep.id;
        groups.delete(gone.id);
        keep.name = clean.slice(0, 40);
        out.merged++;
        continue;
      }
      g.name = uniqueName(clean, id).slice(0, 40);
      out.renamed++;
    }
    // An explicit run takes any organizable loose tab and clears the marks of the ones it groups.
    const takes = (t) => t && !t.groupId && (explicit ? organizable(t) : movable(t));
    const claim = (t) => { if (explicit) { t.userRemoved = false; t.userMoved = false; t.userPlaced = false; } };
    for (const { tab: tabId, group } of places) {
      const tab = tabById(tabId);
      if (!takes(tab) || !groups.get(group)) continue;
      claim(tab);
      tab.groupId = group;
      tab.autoKey = keyOf(tab);
      out.placed++;
    }
    for (const { name, ids } of created) {
      const free = ids.filter((id) => takes(tabById(id)));
      if (free.length < 2) continue;
      free.forEach((id) => claim(tabById(id)));
      // A group named like an automatic one that exists: the tabs join it rather than make a twin.
      const clean = cleanGroupName(name);
      const twin = [...groups.values()].find((o) => mine(o) && !o.domain && o.name.toLowerCase() === clean.toLowerCase());
      if (twin) { for (const id of free) { tabById(id).groupId = twin.id; tabById(id).autoKey = keyOf(tabById(id)); } out.placed += free.length; continue; }
      create(uniqueName(clean), free, { auto: true });
      out.created++;
    }
    if (out.merged || out.renamed || out.placed || out.created) { arrange(); cleanup(); }
    return out;
  }

  // The idle rule's organizer: only the loose tabs are grouped (local clusters), automatic groups stay as they
  // are. One step of undo, and nothing recorded when nothing was grouped. Returns how many groups were made.
  function organizeLoose() {
    const prev = { undoState, autoUndo, undoSeq };
    saveUndo();
    const before = new Set(groups.keys());
    const count = groupLoose();
    if (!count) { ({ undoState, autoUndo, undoSeq } = prev); return 0; }
    spreadColors(new Set([...groups.keys()].filter((id) => !before.has(id))));
    return count;
  }

  // "Merge Similar Groups": one step of undo, nothing recorded when there was nothing to merge.
  function mergeGroups() {
    const prev = { undoState, autoUndo, undoSeq };
    saveUndo();
    const { gone } = mergeSimilar();
    if (!gone) ({ undoState, autoUndo, undoSeq } = prev);
    return gone;
  }

  // Undoes the most recent thing: an organize, or the last automatic by-topic placement.
  function undoOrganize() {
    if (autoUndo && (!undoState || autoUndo.seq > undoState.seq)) return undoAuto();
    if (!undoState) return false;
    const { order, tabs: saved, groups: savedGroups, flags } = undoState;
    undoState = null;
    groups.clear();
    restore(savedGroups);
    const byId = new Map(getTabs().map((t) => [t.id, t]));
    const list = order.filter((id) => byId.has(id)).map((id) => byId.get(id));
    for (const t of getTabs()) if (!list.includes(t)) list.push(t); // opened since
    for (const t of list) {
      if (!saved.has(t.id)) continue;
      t.groupId = groups.has(saved.get(t.id)) ? saved.get(t.id) : null;
      Object.assign(t, flags.get(t.id));
    }
    setTabs(list);
    arrange();
    cleanup();
    return true;
  }

  // Puts the tabs the last automatic pass moved back where they were. They are then left alone, so
  // the same pass doesn't just move them again.
  function undoAuto() {
    const { moves, groups: touched } = autoUndo;
    autoUndo = null;
    for (const g of touched || []) groups.set(g.id, { ...g }); // groups a merge changed or removed
    for (const [id, from] of moves) {
      const tab = tabById(id);
      if (!tab) continue;
      tab.groupId = from && groups.has(from) ? from : null;
      tab.userRemoved = true;
    }
    arrange();
    cleanup();
    return true;
  }

  const state = () => {
    const order = [];
    for (const tab of getTabs()) if (tab.groupId && !order.includes(tab.groupId)) order.push(tab.groupId);
    return order.map((id) => groups.get(id)).filter(Boolean).map(({ id, name, color, collapsed }) => ({ id, name, color, collapsed }));
  };

  const snapshot = () => [...groups.values()].map(({ id, name, color, collapsed, domain, topic, auto, userNamed, colorLocked }) => ({ id, name, color, collapsed, domain, topic, auto, userNamed: Boolean(userNamed), colorLocked: Boolean(colorLocked) }));

  function restore(saved) {
    for (const g of saved || []) {
      groups.set(g.id, { id: g.id, name: g.name, color: GROUP_COLORS.includes(g.color) ? g.color : 'gray', collapsed: Boolean(g.collapsed), domain: g.domain || null, topic: g.topic || null, auto: g.auto ?? Boolean(g.domain), userNamed: Boolean(g.userNamed), colorLocked: Boolean(g.colorLocked) });
      nextId = Math.max(nextId, g.id + 1);
    }
    colorIndex = groups.size;
  }

  return {
    groups, GROUP_COLORS, create, add, remove, ungroupAll, joinOpener, autoGroup, applyProposal, organizeByTopic, groupLoose, organizeLoose, mergeGroups, entryFor: (id) => { const t = tabById(id); return t ? entry(t) : null; }, groupEntries: (id) => members(id).map(entry), organizeView, applyRefinement, organizeSeq: () => (undoState ? undoState.seq : null), undoOrganize, canUndo: () => Boolean(undoState || autoUndo), loose: () => loose().map(entry),
    // What "Organize by topic" regroups: loose tabs and tabs in automatic groups.
    layoutSignature, candidates: () => getTabs().filter(organizable).map(entry), organizableCount: () => getTabs().filter(organizable).length, organizeCounts, arrange, cleanup, state, snapshot, restore, members,
    changed: onChange,
  };
}

module.exports = { _vectorize: vectorize, _cohere: cohere, _cosine: cosine, createTabGroups, isTransientTitle, isAppOrSearch, tokens, stripSiteSegment, cleanGroupName, siteName, registrableDomain, siteKey, topicClusters, mergeSimilarGroups, nameSimilarity, placeTabs, sanitizeProposal, pathWords, siteHint, hintHost, GROUP_COLORS, MAX_AUTO_MOVES };
