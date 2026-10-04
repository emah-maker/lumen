// More evaluation sessions for Organize (see organize-eval.js for the format): students, developers, shoppers, researchers,
// mixed languages, one site with many topics, near-duplicates, bare titles, and long sessions. Some tabs carry `text`, the
// short description a loaded page gives (<= 300 chars); scripts/eval-organize.js feeds it to the organizer only for these sessions.
const T = (title, url, group, text) => (text ? { title, url, group, text } : { title, url, group });

const student = {
  name: '[eval] student: finals week',
  names: { chem: /chem|organic/i, hist: /histor|essay|revolution|french/i, aid: /aid|fafsa|financ|tuition/i },
  tabs: [
    T('Organic Chemistry II - CHEM 2312 - Canvas', 'https://canvas.northeastern.edu/courses/2312', 'chem'),
    T('Organic chemistry reaction mechanisms cheat sheet - Master Organic Chemistry', 'https://www.masterorganicchemistry.com/reaction-guide/', 'chem'),
    T('SN1 vs SN2 reactions | Khan Academy', 'https://www.khanacademy.org/science/organic-chemistry/sn1-sn2', 'chem'),
    T('Grignard reagent practice problems - Quizlet', 'https://quizlet.com/512/grignard-practice-flash-cards/', 'chem'),
    T('Chem 2312 Final Exam Study Guide.pdf', 'https://canvas.northeastern.edu/files/881/download', 'chem'),
    T('Causes of the French Revolution - Essay draft - Google Docs', 'https://docs.google.com/document/d/1fr/edit', 'hist'),
    T('French Revolution | Causes, Facts, & Summary | Britannica', 'https://www.britannica.com/event/French-Revolution', 'hist'),
    T('The Third Estate and the Revolution - JSTOR', 'https://www.jstor.org/stable/2171923', 'hist'),
    T('How to cite a book in Chicago style - Purdue OWL', 'https://owl.purdue.edu/owl/research_and_citation/chicago_manual_17th_edition/', 'hist'),
    T('Financial Aid Office - Northeastern University', 'https://finaid.northeastern.edu/', 'aid'),
    T('FAFSA Application Status - Federal Student Aid', 'https://studentaid.gov/fafsa-apply/status', 'aid'),
    T('Spring 2027 tuition and fees - Student Hub', 'https://studentfinance.northeastern.edu/tuition', 'aid'),
    T('Gmail', 'https://mail.google.com/mail/u/0/#inbox', null),
    T('Netflix', 'https://www.netflix.com/browse', null),
    T('Untitled', 'https://www.google.com/', null),
  ],
};

const developer = {
  name: '[eval] developer: Postgres migration + React app',
  names: { pg: /postgres|database|migration|sql/i, react: /react|query|frontend/i, docker: /docker|container/i },
  tabs: [
    T('PostgreSQL: Documentation: 16: ALTER TABLE', 'https://www.postgresql.org/docs/16/sql-altertable.html', 'pg'),
    T('Zero-downtime Postgres migrations - Fly.io Blog', 'https://fly.io/blog/zero-downtime-postgres-migrations/', 'pg'),
    T('postgresql - Add a NOT NULL column to a huge table without locking - Stack Overflow', 'https://stackoverflow.com/questions/5521/add-not-null-column-without-locking', 'pg'),
    T('pgloader: migrate to PostgreSQL in a single command', 'https://pgloader.readthedocs.io/en/latest/', 'pg'),
    T('EXPLAIN ANALYZE cheat sheet - pganalyze', 'https://pganalyze.com/docs/explain', 'pg'),
    T('Quick Start | TanStack Query React Docs', 'https://tanstack.com/query/latest/docs/framework/react/quick-start', 'react'),
    T('useEffect - React', 'https://react.dev/reference/react/useEffect', 'react'),
    T('react-hook-form: Performant, flexible and extensible forms', 'https://react-hook-form.com/', 'react'),
    T('typescript - React useState with generic type - Stack Overflow', 'https://stackoverflow.com/questions/6032/react-usestate-generic-type', 'react'),
    T('Multi-stage builds | Docker Docs', 'https://docs.docker.com/build/building/multi-stage/', 'docker'),
    T('docker compose healthcheck depends_on - Stack Overflow', 'https://stackoverflow.com/questions/7120/docker-compose-healthcheck-depends-on', 'docker'),
    T('Dockerfile best practices - Docker Docs', 'https://docs.docker.com/build/building/best-practices/', 'docker'),
    T('Pull requests - acme/billing-service', 'https://github.com/acme/billing-service/pulls', null),
    T('Slack | #eng-general | Acme', 'https://app.slack.com/client/T01/C09', null),
    T('localhost:5173', 'http://localhost:5173/', null),
  ],
};

const shopper = {
  name: '[eval] shopper: headphones, standing desk, running shoes',
  names: { headphones: /headphone|earbud|sony|bose/i, desk: /desk|standing/i, shoes: /shoe|running|sneaker|brooks/i },
  tabs: [
    T('Sony WH-1000XM5 Wireless Noise Canceling Headphones - Amazon.com', 'https://www.amazon.com/dp/B09XS7JWHH', 'headphones'),
    T('Bose QuietComfort Ultra Headphones - Bose', 'https://www.bose.com/p/headphones/quietcomfort-ultra-headphones', 'headphones'),
    T('Best noise cancelling headphones - Wirecutter', 'https://www.nytimes.com/wirecutter/reviews/best-noise-canceling-headphones/', 'headphones'),
    T('Sony WH-1000XM5 vs Bose QC Ultra - RTINGS.com', 'https://www.rtings.com/headphones/tools/compare/sony-wh-1000xm5-vs-bose-qc-ultra', 'headphones'),
    T('r/headphones - XM5 or QC Ultra for flights?', 'https://www.reddit.com/r/headphones/comments/x5/xm5_or_qc_ultra', 'headphones'),
    T('FlexiSpot E7 Pro Standing Desk - FlexiSpot', 'https://www.flexispot.com/standing-desks/e7-pro', 'desk'),
    T('Uplift V2 Standing Desk - UPLIFT Desk', 'https://www.upliftdesk.com/uplift-v2-standing-desk', 'desk'),
    T('Best standing desks of 2026 - Wirecutter', 'https://www.nytimes.com/wirecutter/reviews/best-standing-desks/', 'desk'),
    T('Standing desk converter vs full desk : r/StandingDesk', 'https://www.reddit.com/r/StandingDesk/comments/c9/converter_vs_full', 'desk'),
    T('Brooks Ghost 16 Men\'s Running Shoes - Brooks Running', 'https://www.brooksrunning.com/en_us/ghost-16-mens-road-running-shoe/', 'shoes'),
    T('Hoka Clifton 9 Review - Runner\'s World', 'https://www.runnersworld.com/gear/a45/hoka-clifton-9-review/', 'shoes'),
    T('Best running shoes 2026 - RunRepeat', 'https://runrepeat.com/catalog/running-shoes', 'shoes'),
    T('Brooks Ghost 16 vs Hoka Clifton 9 : r/RunningShoeGeeks', 'https://www.reddit.com/r/RunningShoeGeeks/comments/h9/ghost_vs_clifton', 'shoes'),
    T('Your Orders - Amazon.com', 'https://www.amazon.com/gp/css/order-history', null),
    T('Chase Online Banking', 'https://secure.chase.com/web/auth/dashboard', null),
  ],
};

const researcher = {
  name: '[eval] researcher: CRISPR + climate, with page text',
  names: { crispr: /crispr|cas9|gene|editing|bio|lab/i, climate: /climate|sea level|ice|warming/i },
  tabs: [
    T('CRISPR-Cas9 off-target effects: a review - Nature Reviews Genetics', 'https://www.nature.com/articles/s41576-023-00001', 'crispr', 'Genome editing with CRISPR-Cas9 can cut unintended sites; this review covers detection and mitigation strategies.'),
    T('Base editing and prime editing explained - Broad Institute', 'https://www.broadinstitute.org/what-broad/areas-focus/project-spotlight/base-editing', 'crispr', 'How base editors and prime editors change DNA without double-strand breaks.'),
    T('Guide RNA design tool - Benchling', 'https://www.benchling.com/crispr', 'crispr'),
    T('arXiv:2401.01234 Deep learning for sgRNA efficiency prediction', 'https://arxiv.org/abs/2401.01234', 'crispr', 'We train a model to predict the on-target activity of single guide RNAs for Cas9.'),
    T('Why a Single Letter Change Can Rewrite Medicine - Quanta Magazine', 'https://www.quantamagazine.org/why-a-single-letter-change-can-rewrite-medicine-20240101/', 'crispr', 'Researchers using gene editors to correct point mutations are treating inherited blood disorders such as sickle cell disease.'),
    T('Antarctic ice sheet mass loss accelerating - NASA Climate', 'https://climate.nasa.gov/news/antarctic-ice-loss/', 'climate'),
    T('Global sea level rise projections to 2100 - IPCC AR6', 'https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-9/', 'climate'),
    T('Global temperature anomaly - NOAA', 'https://www.ncei.noaa.gov/access/monitoring/global-temperature-anomalies', 'climate'),
    T('The Coastlines We Are About to Lose - The Atlantic', 'https://www.theatlantic.com/science/archive/2024/01/coasts/', 'climate', 'As oceans warm and ice melts, communities from Miami to Jakarta face rising water within decades.'),
    T('Inbox (2) - Gmail', 'https://mail.google.com/mail/u/0/#inbox', null),
    T('Spotify - Web Player', 'https://open.spotify.com/', null),
  ],
};

const multilingual = {
  name: '[eval] mixed languages (es, de, fr, en)',
  names: { receta: /receta|cocina|paella|tortilla|recip/i, reise: /berlin|reise|zug|bahn|train/i, news: /macron|france|politi|élection|elections|législatives/i },
  tabs: [
    T('Receta de paella valenciana auténtica - Directo al Paladar', 'https://www.directoalpaladar.com/recetas-de-arroces/paella-valenciana', 'receta'),
    T('Tortilla de patatas: la receta perfecta - Cocina Fácil', 'https://www.cocinafacil.com/tortilla-de-patatas', 'receta'),
    T('Cómo hacer sofrito casero - Recetas Gratis', 'https://www.recetasgratis.net/sofrito', 'receta'),
    T('Gazpacho andaluz receta tradicional - Pequerecetas', 'https://www.pequerecetas.com/receta/gazpacho-andaluz/', 'receta'),
    T('Zugverbindung Berlin Hbf nach München - Deutsche Bahn', 'https://int.bahn.de/de/buchung/start', 'reise'),
    T('Hostel in Berlin Mitte günstig buchen - Hostelworld', 'https://www.hostelworld.com/st/hostels/europe/germany/berlin/', 'reise'),
    T('Berlin Sehenswürdigkeiten: die Top 10 - Reisen Magazin', 'https://www.reisen-magazin.de/berlin-sehenswuerdigkeiten', 'reise'),
    T('Deutschland-Ticket: Alle Infos - Verbraucherzentrale', 'https://www.verbraucherzentrale.de/deutschlandticket', 'reise'),
    T('Élections législatives : ce que disent les sondages - Le Monde', 'https://www.lemonde.fr/politique/article/elections-sondages.html', 'news'),
    T('Macron dissout l\'Assemblée nationale - Le Figaro', 'https://www.lefigaro.fr/politique/macron-dissout', 'news'),
    T('Législatives : les résultats du premier tour - France 24', 'https://www.france24.com/fr/france/legislatives-resultats', 'news'),
    T('Mi bandeja de entrada - Gmail', 'https://mail.google.com/mail/u/0/#inbox', null),
    T('Wetter Berlin - wetter.com', 'https://www.wetter.com/deutschland/berlin/', 'reise'),
  ],
};

const oneSiteWikipedia = {
  name: '[eval] one site (Wikipedia) many topics + Reddit',
  names: { rome: /rome|roman|empire/i, f1: /formula|f1|racing|verstappen|motorsport/i, photo: /photosynth|plant|chloro|biolog/i },
  tabs: [
    T('Roman Empire - Wikipedia', 'https://en.wikipedia.org/wiki/Roman_Empire', 'rome'),
    T('Fall of the Western Roman Empire - Wikipedia', 'https://en.wikipedia.org/wiki/Fall_of_the_Western_Roman_Empire', 'rome'),
    T('Julius Caesar - Wikipedia', 'https://en.wikipedia.org/wiki/Julius_Caesar', 'rome'),
    T('Augustus - Wikipedia', 'https://en.wikipedia.org/wiki/Augustus', 'rome'),
    T('Why did Rome fall? : r/AskHistorians', 'https://www.reddit.com/r/AskHistorians/comments/r1/why_did_rome_fall', 'rome'),
    T('Formula One - Wikipedia', 'https://en.wikipedia.org/wiki/Formula_One', 'f1'),
    T('Max Verstappen - Wikipedia', 'https://en.wikipedia.org/wiki/Max_Verstappen', 'f1'),
    T('2026 Formula One World Championship - Wikipedia', 'https://en.wikipedia.org/wiki/2026_Formula_One_World_Championship', 'f1'),
    T('Race Discussion : r/formula1', 'https://www.reddit.com/r/formula1/comments/f1/race_discussion', 'f1'),
    T('Photosynthesis - Wikipedia', 'https://en.wikipedia.org/wiki/Photosynthesis', 'photo'),
    T('Chloroplast - Wikipedia', 'https://en.wikipedia.org/wiki/Chloroplast', 'photo'),
    T('Calvin cycle - Wikipedia', 'https://en.wikipedia.org/wiki/Calvin_cycle', 'photo'),
    T('Wikipedia, the free encyclopedia', 'https://en.wikipedia.org/wiki/Main_Page', null),
    T('Reddit - Dive into anything', 'https://www.reddit.com/', null),
  ],
};

const duplicates = {
  name: '[eval] near-duplicate tabs',
  names: { flights: /flight|lisbon|portugal|trip/i, mortgage: /mortgage|rate|refinanc/i },
  tabs: [
    T('Flights from Boston to Lisbon - Google Flights', 'https://www.google.com/travel/flights?q=BOS-LIS', 'flights'),
    T('Flights from Boston to Lisbon - Google Flights', 'https://www.google.com/travel/flights?q=BOS-LIS&d=2026-11-02', 'flights'),
    T('Flights from Boston to Lisbon - Google Flights', 'https://www.google.com/travel/flights?q=BOS-LIS&d=2026-11-03', 'flights'),
    T('Cheap flights to Lisbon (LIS) - Skyscanner', 'https://www.skyscanner.com/routes/bos/lis/boston-logan-to-lisbon.html', 'flights'),
    T('Hotels in Lisbon - Booking.com', 'https://www.booking.com/city/pt/lisbon.html', 'flights'),
    T('Hotels in Lisbon - Booking.com', 'https://www.booking.com/city/pt/lisbon.html?checkin=2026-11-02', 'flights'),
    T('Current mortgage rates today - Bankrate', 'https://www.bankrate.com/mortgages/mortgage-rates/', 'mortgage'),
    T('Current mortgage rates today - Bankrate', 'https://www.bankrate.com/mortgages/mortgage-rates/?ic_id=1', 'mortgage'),
    T('Mortgage refinance calculator - NerdWallet', 'https://www.nerdwallet.com/mortgages/refinance-calculator', 'mortgage'),
    T('Mortgage rates today - Zillow', 'https://www.zillow.com/mortgage-rates/', 'mortgage'),
    T('New Tab', 'https://newtab.example/', null),
    T('New Tab', 'https://newtab.example/?2', null),
  ],
};

const bare = {
  name: '[eval] bare and generic titles',
  names: { paris: /paris|france|trip|travel/i, iceland: /iceland|reykjav|trip|travel/i, dash: /dashboard|admin|acme|app|local/i },
  tabs: [
    T('Paris', 'https://www.google.com/travel/explore?q=paris', 'paris'),
    T('Paris Travel Guide | Rick Steves', 'https://www.ricksteves.com/europe/france/paris', 'paris'),
    T('Louvre Museum tickets - Official site', 'https://www.louvre.fr/en/visit/tickets', 'paris'),
    T('Hotels', 'https://www.booking.com/searchresults.html?ss=Paris', 'paris'),
    T('Metro map - Paris', 'https://www.ratp.fr/en/plans', 'paris'),
    T('Iceland Ring Road 8 day itinerary - Lonely Planet', 'https://www.lonelyplanet.com/articles/iceland-ring-road', 'iceland'),
    T('Reykjavik hotels - Booking.com', 'https://www.booking.com/city/is/reykjavik.html', 'iceland'),
    T('Iceland', 'https://www.google.com/travel/explore?q=iceland', 'iceland'),
    T('Iceland', 'https://guidetoiceland.is/', 'iceland'),
    T('Dashboard', 'http://localhost:4000/dashboard', 'dash'),
    T('Users - Admin', 'http://localhost:4000/admin/users', 'dash'),
    T('Dashboard', 'http://localhost:4000/dashboard/billing', 'dash'),
    T('Home', 'https://www.example.com/', null),
    T('Document', 'https://docs.google.com/document/d/1xx/edit', null),
    T('Untitled', 'https://www.figma.com/file/aa/Untitled', null),
    T('Search', 'https://www.google.com/', null),
  ],
};

const jobHunt = {
  name: '[eval] life admin: job hunt, apartment, fitness',
  names: { job: /job|career|resume|interview|hiring/i, apt: /apartment|rent|housing|lease|flat/i, fit: /run|marathon|fitness|training|workout/i },
  tabs: [
    T('Software Engineer, New Grad - Stripe | Greenhouse', 'https://boards.greenhouse.io/stripe/jobs/123', 'job'),
    T('Backend Engineer - Datadog Careers', 'https://careers.datadoghq.com/detail/456', 'job'),
    T('Jobs for software engineer in Boston - Indeed', 'https://www.indeed.com/jobs?q=software+engineer&l=Boston', 'job'),
    T('How to negotiate a new grad salary offer - Levels.fyi', 'https://www.levels.fyi/blog/negotiating-new-grad-offer.html', 'job'),
    T('My Resume v7 - Google Docs', 'https://docs.google.com/document/d/1res/edit', 'job'),
    T('Apartments for rent in Somerville, MA - Zillow', 'https://www.zillow.com/somerville-ma/rentals/', 'apt'),
    T('2 bedroom apartment near Davis Square - Apartments.com', 'https://www.apartments.com/somerville-ma/2-bedrooms/', 'apt'),
    T('Tenant rights in Massachusetts - Mass.gov', 'https://www.mass.gov/info-details/tenant-rights', 'apt'),
    T('Sample lease agreement - Nolo', 'https://www.nolo.com/legal-encyclopedia/lease-agreement', 'apt'),
    T('Half marathon training plan for beginners - Hal Higdon', 'https://www.halhigdon.com/training/half-marathon-training/novice-1/', 'fit'),
    T('Strava | Run, Ride, Together', 'https://www.strava.com/dashboard', 'fit'),
    T('How to run your first 10K - Runner\'s World', 'https://www.runnersworld.com/training/a123/first-10k/', 'fit'),
    T('YouTube', 'https://www.youtube.com/', null),
    T('Google Calendar - Week of Oct 5', 'https://calendar.google.com/calendar/u/0/r/week', null),
  ],
};

const homeFinance = {
  name: '[eval] buying a home + taxes',
  names: { home: /home|house|mortgage|buy/i, tax: /tax|irs|return/i },
  tabs: [
    T('First-time homebuyer programs in Massachusetts - MassHousing', 'https://www.masshousing.com/en/homebuyers', 'home'),
    T('How much house can I afford? - NerdWallet', 'https://www.nerdwallet.com/mortgages/how-much-house-can-i-afford', 'home'),
    T('Pre-approval vs prequalification - Rocket Mortgage', 'https://www.rocketmortgage.com/learn/pre-approval-vs-prequalification', 'home'),
    T('Homes for sale in Arlington, MA - Redfin', 'https://www.redfin.com/city/arlington-ma', 'home'),
    T('Closing costs explained - Investopedia', 'https://www.investopedia.com/terms/c/closingcosts.asp', 'home'),
    T('About Form 1040 - Internal Revenue Service', 'https://www.irs.gov/forms-pubs/about-form-1040', 'tax'),
    T('Best tax software 2026 - Wirecutter', 'https://www.nytimes.com/wirecutter/money/best-tax-software/', 'tax'),
    T('TurboTax Deluxe - Intuit', 'https://turbotax.intuit.com/personal-taxes/online/deluxe.jsp', 'tax'),
    T('Standard deduction 2026 - Tax Foundation', 'https://taxfoundation.org/data/all/federal/2026-tax-brackets/', 'tax'),
    T('Wells Fargo - Sign On', 'https://connect.secure.wellsfargo.com/auth/login/present', null),
    T('Weather - Boston', 'https://weather.com/weather/today/l/boston', null),
  ],
};

const gaming = {
  name: '[eval] hobbies: PC build, Factorio, sourdough',
  names: { pc: /pc|gpu|build|ryzen|rtx|graphics/i, factorio: /factorio/i, bread: /sourdough|bread|baking/i },
  tabs: [
    T('NVIDIA GeForce RTX 5070 Review - TechPowerUp', 'https://www.techpowerup.com/review/nvidia-geforce-rtx-5070/', 'pc'),
    T('AMD Ryzen 7 9700X Review - Tom\'s Hardware', 'https://www.tomshardware.com/pc-components/cpus/amd-ryzen-7-9700x-review', 'pc'),
    T('My PC build - PCPartPicker', 'https://pcpartpicker.com/list/abc123', 'pc'),
    T('Best graphics cards 2026 - GPU benchmark hierarchy', 'https://www.tomshardware.com/reviews/gpu-hierarchy,4388.html', 'pc'),
    T('Is 750W enough for a 5070? : r/buildapc', 'https://www.reddit.com/r/buildapc/comments/p7/is_750w_enough', 'pc'),
    T('Factorio Wiki - Rail signals', 'https://wiki.factorio.com/Rail_signals', 'factorio'),
    T('Factorio Friday Facts #421', 'https://factorio.com/blog/post/fff-421', 'factorio'),
    T('Nilaus - Factorio 2.0 mall tutorial - YouTube', 'https://www.youtube.com/watch?v=fa1', 'factorio'),
    T('Space Age blueprint book : r/factorio', 'https://www.reddit.com/r/factorio/comments/f2/space_age_blueprint_book', 'factorio'),
    T('Beginner Sourdough Bread - King Arthur Baking', 'https://www.kingarthurbaking.com/recipes/beginner-sourdough', 'bread'),
    T('Sourdough starter feeding schedule - The Perfect Loaf', 'https://www.theperfectloaf.com/sourdough-starter-feeding/', 'bread'),
    T('Why is my sourdough starter not rising? : r/Sourdough', 'https://www.reddit.com/r/Sourdough/comments/s3/starter_not_rising', 'bread'),
    T('Twitch', 'https://www.twitch.tv/', null),
  ],
};

// Long sessions are the short ones above stacked (with a little shared noise): a morning's reading across many sites.
const hostOf = (u) => new URL(u).hostname;
const long = (name, parts, noise) => {
  const tabs = [...parts.flatMap((p) => p.tabs.map((t) => ({ ...t, group: t.group ? `${p.name}/${t.group}` : null }))), ...noise];
  // One loose tab per site: two Gmail tabs among sixty are one errand, not noise.
  const seen = new Set();
  return { name, names: Object.assign({}, ...parts.map((p) => p.names)), tabs: tabs.filter((t) => t.group || !seen.has(hostOf(t.url)) && seen.add(hostOf(t.url))) };
};
const noise = [
  T('Inbox (23) - Gmail', 'https://mail.google.com/mail/u/0/#inbox', null),
  T('Google Calendar', 'https://calendar.google.com/calendar/u/0/r', null),
  T('Spotify - Web Player', 'https://open.spotify.com/', null),
  T('Slack | general', 'https://app.slack.com/client/T01/C01', null),
];
const prefixed = (parts) => parts.map((p) => ({ name: p.name, names: Object.fromEntries(Object.entries(p.names).map(([k, v]) => [`${p.name}/${k}`, v])), tabs: p.tabs }));
const long60 = long('[eval] long session (~60 tabs, 4 topics)', prefixed([shopper, developer, student, researcher]), noise);
const long100 = long('[eval] long session (~100 tabs, 8 topics)', prefixed([shopper, developer, student, researcher, jobHunt, gaming, homeFinance, oneSiteWikipedia]), noise);

module.exports = { sessions: [student, developer, shopper, researcher, multilingual, oneSiteWikipedia, duplicates, bare, jobHunt, homeFinance, gaming, long60, long100] };
