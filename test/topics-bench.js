// Benchmark for "By topic" auto-grouping (tab-groups.js): scores the current code (with and
// without the optional page-text field main.js now supplies) against hand-labelled scenarios,
// plus 3 held-out scenarios written before this round's tuning (not used to pick thresholds).
// Pure Node - no windows, no Electron, no Playwright.
//   node test/topics-bench.js
const final = require('../tab-groups');
const baseline = require('./_baseline-tab-groups');

// ---------- harness: drive createTabGroups() with plain arrays, no accessors touching the DOM ----------

function harness(mod, { aiTopics = false, withText = true } = {}) {
  let tabs = [];
  let nextId = 1;
  const tg = mod.createTabGroups({
    getTabs: () => tabs,
    setTabs: (list) => { tabs = list; },
    urlOf: (t) => t.url,
    titleOf: (t) => t.title,
    textOf: (t) => (withText ? t.text || '' : ''),
    isWeb: () => true,
    mode: () => 'topic',
    aiTopics: () => aiTopics,
    onChange: () => {},
  });
  return {
    tg,
    tabs: () => tabs,
    addTab: (t) => { const tab = { id: nextId++, title: t.title, url: t.url, text: t.text || '', groupId: null, userRemoved: false, userMoved: false }; tabs.push(tab); return tab; },
  };
}

// ---------- scoring: pairwise precision/recall/F1 + wrongly-grouped-loose count ----------

function score(tabs, truthOf) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let wronglyGroupedLoose = 0;
  for (const t of tabs) if (truthOf(t.id) == null && t.groupId != null) wronglyGroupedLoose++;
  for (let i = 0; i < tabs.length; i++) {
    for (let j = i + 1; j < tabs.length; j++) {
      const a = tabs[i];
      const b = tabs[j];
      const truthSame = truthOf(a.id) != null && truthOf(a.id) === truthOf(b.id);
      const predSame = a.groupId != null && a.groupId === b.groupId;
      if (truthSame && predSame) tp++;
      else if (predSame) fp++;
      else if (truthSame) fn++;
    }
  }
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, wronglyGroupedLoose };
}

const fmt = (x) => (typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(2) : String(x));
const pad = (s, n) => String(s).padEnd(n);

function runBatch(mod, scenario, opts) {
  const h = harness(mod, opts);
  const added = scenario.tabs.map((t) => h.addTab(t));
  h.tg.groupLoose();
  const truthOf = (id) => scenario.tabs[added.findIndex((t) => t.id === id)].group;
  return score(h.tabs(), truthOf);
}

// ---------- scenarios: [{ title, url, group, text }], group === null means "should stay loose" ----------
// text = a realistic meta description/og:description + first <h1>, as main.js now supplies (<=300 chars).

const scenarios = [
  {
    name: 'mixed-sites (ML vs baking + noise)',
    tabs: [
      { title: 'Introduction to Machine Learning - YouTube', url: 'https://www.youtube.com/watch?v=ml101', group: 'ml', text: 'In this beginner-friendly tutorial we cover the basics of machine learning, from supervised learning to neural networks, with hands-on Python examples.' },
      { title: 'Machine learning models for beginners : r/MachineLearning - Reddit', url: 'https://www.reddit.com/r/MachineLearning/comments/abc123', group: 'ml', text: 'Discussion thread: what are the best machine learning models for someone just starting out? Recommendations for courses, textbooks, and datasets welcome.' },
      { title: 'Machine learning - Wikipedia', url: 'https://en.wikipedia.org/wiki/Machine_learning', group: 'ml', text: 'Machine learning is a field of study in artificial intelligence concerned with algorithms that can learn from and make predictions on data.' },
      { title: 'A Gentle Introduction to Machine Learning Algorithms | Towards Data Science', url: 'https://towardsdatascience.com/gentle-introduction-machine-learning-algorithms', group: 'ml', text: 'A gentle, beginner-friendly walkthrough of the most common machine learning algorithms, including linear regression, decision trees, and clustering.' },
      { title: 'Best machine learning courses in 2026', url: 'https://www.classcentral.com/report/best-machine-learning-courses/', group: 'ml', text: 'We reviewed dozens of online machine learning courses and ranked the best ones for beginners, covering Python, statistics, and deep learning.' },
      { title: 'Easy Sourdough Bread Recipe - YouTube', url: 'https://www.youtube.com/watch?v=bread1', group: 'baking', text: 'Learn how to make a crusty, delicious sourdough bread at home with just flour, water, salt, and a sourdough starter. Step by step video guide.' },
      { title: 'Sourdough starter tips : r/Baking - Reddit', url: 'https://www.reddit.com/r/Baking/comments/xyz987', group: 'baking', text: "My sourdough starter isn't rising like it used to - any tips for reviving a sluggish starter? Looking for advice from home bakers." },
      { title: 'Sourdough - Wikipedia', url: 'https://en.wikipedia.org/wiki/Sourdough', group: 'baking', text: 'Sourdough is a bread made by the fermentation of dough using naturally occurring lactobacilli and yeast, giving it a distinctive tangy flavor.' },
      { title: 'The Science of Sourdough Baking | King Arthur Baking', url: 'https://www.kingarthurbaking.com/blog/science-of-sourdough', group: 'baking', text: 'Understanding the science behind sourdough fermentation helps you troubleshoot common problems and bake a better loaf of bread every time.' },
      { title: 'Sourdough Bread Recipe for Beginners', url: 'https://www.seriouseats.com/sourdough-bread-recipe-beginners', group: 'baking', text: 'This foolproof sourdough bread recipe for beginners walks you through building a starter, mixing the dough, and baking a crusty loaf.' },
      { title: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox', group: null, text: '' },
      { title: 'National Weather Service Forecast', url: 'https://forecast.weather.gov/', group: null, text: '7-day forecast for your area including temperature, precipitation chance, and wind conditions updated hourly.' },
      { title: 'Online Banking Login', url: 'https://www.chase.com/login', group: null, text: 'Log in to your Chase account to check your balance, pay bills, and manage your accounts securely online.' },
      { title: 'Random Blog Post About Nothing In Particular', url: 'https://example.com/blog/random-post', group: null, text: 'Just some random musings and thoughts on nothing in particular, a personal blog post with no specific topic.' },
    ],
  },
  {
    name: 'same-site-diff-topics (YouTube+GitHub)',
    tabs: [
      { title: 'How to Change a Car Tire - YouTube', url: 'https://www.youtube.com/watch?v=tire1', group: null, text: 'Step by step instructions for safely changing a flat tire on your car, including how to use a jack and torque the lug nuts.' },
      { title: 'Beginner Guitar Chords Lesson 1 - YouTube', url: 'https://www.youtube.com/watch?v=guitar2', group: 'guitar', text: 'Learn your first guitar chords in this lesson for absolute beginners, covering G, C, D, and E minor with easy strumming patterns.' },
      { title: 'Stock Market Analysis This Week - YouTube', url: 'https://www.youtube.com/watch?v=stock1', group: null, text: "A breakdown of this week's stock market movements, covering major indices, earnings reports, and what analysts are watching next." },
      { title: 'Easy Guitar Chords For Songs - YouTube', url: 'https://www.youtube.com/watch?v=guitar3', group: 'guitar', text: 'Easy guitar chords for playing your favorite songs, perfect for beginners who want to strum along without complicated fingerpicking.' },
      { title: 'Learn Guitar Chords for Beginners - YouTube', url: 'https://www.youtube.com/watch?v=guitar1', group: 'guitar', text: "A beginner's guide to essential guitar chords, with tips on finger placement and switching between chords smoothly." },
      { title: 'facebook/react: A library for web UIs - GitHub', url: 'https://github.com/facebook/react', group: null, text: 'A declarative, efficient, and flexible JavaScript library for building user interfaces, maintained by Meta and the open source community.' },
      { title: 'tensorflow/tensorflow - GitHub', url: 'https://github.com/tensorflow/tensorflow', group: null, text: 'An end-to-end open source platform for machine learning, with a comprehensive ecosystem of tools, libraries, and community resources.' },
      { title: 'yourname/dotfiles - GitHub', url: 'https://github.com/yourname/dotfiles', group: null, text: 'My personal collection of shell, vim, and git configuration files for setting up a new development machine quickly.' },
      { title: 'Personal Notion Notes', url: 'https://www.notion.so/Personal-notes-abc123', group: null, text: 'Personal notes and to-do lists organized in Notion, a workspace for notes, tasks, wikis, and databases.' },
      { title: 'Netflix Home', url: 'https://www.netflix.com/browse', group: null, text: 'Watch TV shows and movies anytime, anywhere, with thousands of titles available to stream on Netflix.' },
    ],
  },
  {
    name: 'search-result-pages (2 queries + noise)',
    tabs: [
      { title: 'best noise cancelling headphones 2026 - Google Search', url: 'https://www.google.com/search?q=best+noise+cancelling+headphones+2026', group: 'headphones', text: '' },
      { title: 'Best Noise Cancelling Headphones of 2026 | Wirecutter', url: 'https://www.nytimes.com/wirecutter/reviews/best-noise-cancelling-headphones/', group: 'headphones', text: 'After testing dozens of pairs, these are the best noise cancelling headphones for travel, work, and everyday listening this year.' },
      { title: 'Top 10 Noise Cancelling Headphones — TechRadar', url: 'https://www.techradar.com/best/best-noise-cancelling-headphones', group: 'headphones', text: 'We rank the top noise cancelling headphones available right now, comparing sound quality, battery life, and comfort.' },
      { title: 'Sony WH-1000XM6 Review: Best Headphones Yet - The Verge', url: 'https://www.theverge.com/sony-wh1000xm6-review', group: 'headphones', text: 'The Sony WH-1000XM6 delivers class-leading noise cancellation and refined sound, cementing its place as the headphone to beat.' },
      { title: 'cheap flights to japan - Google Search', url: 'https://www.google.com/search?q=cheap+flights+to+japan', group: 'japan', text: '' },
      { title: 'Cheap Flights to Japan | Skyscanner', url: 'https://www.skyscanner.com/cheap-flights-to-japan', group: 'japan', text: 'Compare cheap flights to Japan from hundreds of airlines and travel sites to find the best deal on your next trip to Tokyo.' },
      { title: 'Tokyo Flight Deals - Kayak', url: 'https://www.kayak.com/tokyo-flight-deals', group: 'japan', text: 'Find the best flight deals to Tokyo, Japan with flexible dates and price alerts to help you save on airfare.' },
      { title: 'How to Find Cheap Flights to Japan - NerdWallet', url: 'https://www.nerdwallet.com/article/travel/cheap-flights-japan', group: 'japan', text: 'Practical tips for finding cheap flights to Japan, including the best time to book and flexible date searches.' },
      { title: 'Amazon Order History', url: 'https://www.amazon.com/gp/css/order-history', group: null, text: '' },
      { title: 'LinkedIn Feed', url: 'https://www.linkedin.com/feed/', group: null, text: "Stay up to date with your professional network's latest posts, job updates, and industry news." },
    ],
  },
  {
    name: 'trip-planning (Tokyo vs Lisbon + noise)',
    tabs: [
      { title: 'Tokyo - Wikipedia', url: 'https://en.wikipedia.org/wiki/Tokyo', group: 'tokyo', text: 'Tokyo is the capital and most populous prefecture of Japan, a major global city known for its skyscrapers, temples, and food scene.' },
      { title: 'Best Time to Visit Tokyo - Lonely Planet', url: 'https://www.lonelyplanet.com/japan/tokyo/best-time-to-visit', group: 'tokyo', text: "Tokyo dazzles with neon-lit streets, ancient temples, and world-class sushi. Here's the best time of year to plan your trip to Japan's capital." },
      { title: 'Tokyo Hotels Deals - Booking.com', url: 'https://www.booking.com/city/jp/tokyo.html', group: 'tokyo', text: 'Browse hotel deals in Tokyo, Japan, from budget capsule hotels to luxury rooms near Shibuya and Shinjuku, with free cancellation.' },
      { title: 'Flights to Tokyo - Kayak', url: 'https://www.kayak.com/flights-to-tokyo', group: 'tokyo', text: 'Find cheap flights to Tokyo, Japan. Compare prices from major airlines for your trip to Narita or Haneda airport.' },
      { title: 'Things To Do In Tokyo | TripAdvisor', url: 'https://www.tripadvisor.com/Attractions-tokyo', group: 'tokyo', text: "Discover the best things to do in Tokyo, Japan, from the Shibuya Crossing and Senso-ji Temple to the Tsukiji fish market." },
      { title: 'Tokyo Itinerary 7 Days - Nomadic Matt', url: 'https://www.nomadicmatt.com/travel-guides/tokyo-itinerary/', group: 'tokyo', text: "A detailed 7 day Tokyo itinerary covering Japan's capital, including neighborhoods to explore, food to try, and day trips nearby." },
      { title: 'Lisbon - Wikipedia', url: 'https://en.wikipedia.org/wiki/Lisbon', group: 'lisbon', text: 'Lisbon is the capital and largest city of Portugal, known for its hilly streets, colorful architecture, and views over the Tagus river.' },
      { title: 'Best Time to Visit Lisbon - Lonely Planet', url: 'https://www.lonelyplanet.com/portugal/lisbon/best-time-to-visit', group: 'lisbon', text: "Lisbon's pastel facades and rooftop miradouros make Portugal's capital a joy to explore. Here's the best time of year to visit." },
      { title: 'Lisbon Hotels Deals - Booking.com', url: 'https://www.booking.com/city/pt/lisbon.html', group: 'lisbon', text: 'Browse hotel deals in Lisbon, Portugal, from boutique guesthouses to riverside hotels in Alfama and Baixa, with free cancellation.' },
      { title: 'Flights to Lisbon - Kayak', url: 'https://www.kayak.com/flights-to-lisbon', group: 'lisbon', text: 'Find cheap flights to Lisbon, Portugal. Compare prices from major airlines for your trip to Humberto Delgado airport.' },
      { title: 'Things To Do In Lisbon | TripAdvisor', url: 'https://www.tripadvisor.com/Attractions-lisbon', group: 'lisbon', text: 'Discover the best things to do in Lisbon, Portugal, from the Belem Tower and Alfama district to a day trip to Sintra.' },
      { title: 'Lisbon Itinerary 5 Days - Nomadic Matt', url: 'https://www.nomadicmatt.com/travel-guides/lisbon-itinerary/', group: 'lisbon', text: "A detailed 5 day Lisbon itinerary covering Portugal's capital, including neighborhoods to explore, pastries to try, and day trips." },
      { title: 'Discover Weekly - Spotify', url: 'https://open.spotify.com/playlist/discover-weekly', group: null, text: "Stream millions of songs and discover new music every week with your personalized Discover Weekly playlist." },
      { title: 'torvalds/linux - GitHub', url: 'https://github.com/torvalds/linux', group: null, text: 'The Linux kernel source tree, the open source operating system kernel that powers servers, phones, and countless devices.' },
      { title: 'r/aww - Reddit', url: 'https://www.reddit.com/r/aww/', group: null, text: 'A place for cute and cuddly pictures and videos of animals - dogs, cats, and everything adorable in between.' },
      { title: 'BBC News Home', url: 'https://www.bbc.com/news', group: null, text: 'The latest breaking news, top stories, and in-depth coverage of world events, politics, and business from BBC News.' },
    ],
  },
  {
    name: 'coding-session (one library, many sites)',
    tabs: [
      { title: 'TanStack Query Overview | TanStack Query Docs', url: 'https://tanstack.com/query/latest/docs/framework/react/overview', group: 'lib', text: 'TanStack Query is a powerful asynchronous state management library for fetching, caching, and updating data in React, Vue, Solid, and Svelte apps.' },
      { title: 'useQuery | TanStack Query Docs', url: 'https://tanstack.com/query/latest/docs/framework/react/reference/useQuery', group: 'lib', text: 'The useQuery hook is the primary way to fetch data with TanStack Query, handling caching, background updates, and stale data automatically.' },
      { title: 'reactjs - How to use React Query with TypeScript? - Stack Overflow', url: 'https://stackoverflow.com/questions/12345/how-to-use-react-query-with-typescript', group: 'lib', text: 'Question about integrating React Query with TypeScript generics for typed query functions and typed query keys.' },
      { title: 'React Query stale time not working - Stack Overflow', url: 'https://stackoverflow.com/questions/54321/react-query-stale-time-not-working', group: 'lib', text: "Question about why the staleTime option in React Query isn't preventing refetches as expected when navigating pages." },
      { title: 'TanStack/query: Powerful data synchronization for React - GitHub', url: 'https://github.com/TanStack/query', group: 'lib', text: 'Powerful asynchronous state management for TanStack Query in React, Solid, Vue, Svelte, and Vanilla JS, with auto caching.' },
      { title: 'react-query - npm', url: 'https://www.npmjs.com/package/react-query', group: 'lib', text: 'Hooks for fetching, caching, and updating asynchronous data in React. Powers data fetching in thousands of production apps.' },
      { title: '@tanstack/react-query - npm', url: 'https://www.npmjs.com/package/@tanstack/react-query', group: 'lib', text: 'Hooks for fetching, caching, and updating asynchronous data in React using TanStack Query, the successor to react-query.' },
      { title: 'React Query Tutorial for Beginners - YouTube', url: 'https://www.youtube.com/watch?v=reactquery1', group: 'lib', text: 'A complete beginner tutorial on TanStack React Query, covering useQuery, caching, mutations, and fetching data in React.' },
      { title: 'Weather forecast Boston', url: 'https://weather.com/weather/today/l/boston', group: null, text: 'Current conditions and hourly forecast for Boston, Massachusetts, including temperature and precipitation chance.' },
      { title: 'Amazon Order History', url: 'https://www.amazon.com/gp/css/order-history', group: null, text: '' },
    ],
  },
  {
    name: 'shopping-comparison (headphones vs mattress)',
    tabs: [
      { title: 'Sony WH-1000XM6 Wireless Headphones - Amazon.com', url: 'https://www.amazon.com/dp/sonywh1000xm6', group: 'headphones', text: 'Industry-leading noise cancellation headphones with up to 30 hours of battery life and premium sound quality.' },
      { title: 'Bose QuietComfort Ultra Headphones - Amazon.com', url: 'https://www.amazon.com/dp/bosequietcomfort', group: 'headphones', text: 'Bose QuietComfort Ultra headphones deliver immersive sound and world-class noise cancellation for all-day comfort.' },
      { title: 'Sony WH-1000XM6 Headphones - Best Buy', url: 'https://www.bestbuy.com/site/sony-wh1000xm6', group: 'headphones', text: 'Shop the Sony WH-1000XM6 wireless noise cancelling headphones, in stock now with free delivery and expert setup.' },
      { title: 'Sony WH-1000XM6 Noise Cancelling Headphones | Sony', url: 'https://www.sony.com/electronics/headband-headphones/wh-1000xm6', group: 'headphones', text: "Discover the WH-1000XM6, Sony's flagship noise cancelling headphones with industry-leading sound quality and comfort." },
      { title: 'Bose vs Sony: Which Noise Cancelling Headphones Are Better? - RTINGS', url: 'https://www.rtings.com/headphones/reviews/bose-vs-sony', group: 'headphones', text: 'We compare the Bose QuietComfort Ultra and Sony WH-1000XM6 headphones across noise cancellation, sound, and battery life.' },
      { title: 'Best Noise Cancelling Headphones 2026 - CNET', url: 'https://www.cnet.com/tech/best-noise-cancelling-headphones/', group: 'headphones', text: 'Our picks for the best noise cancelling headphones you can buy right now, tested for sound quality and comfort.' },
      { title: 'Purple Mattress Original - Amazon.com', url: 'https://www.amazon.com/dp/purplemattress', group: 'mattress', text: 'The Purple mattress uses a unique gel grid design for pressure relief and cooling comfort, with a 100 night trial.' },
      { title: 'Saatva Classic Mattress - Amazon.com', url: 'https://www.amazon.com/dp/saatvamattress', group: 'mattress', text: 'The Saatva Classic is a luxury innerspring mattress with a dual coil system for support and a plush euro pillow top.' },
      { title: 'Saatva Classic Mattress | Saatva', url: 'https://www.saatva.com/mattresses/saatva-classic', group: 'mattress', text: 'Discover the Saatva Classic mattress, a luxury hybrid innerspring design with white glove delivery and a lifetime warranty.' },
      { title: 'Purple Mattress | Purple', url: 'https://www.purple.com/mattresses/purple-mattress', group: 'mattress', text: 'The original Purple mattress with GelFlex Grid technology for pressure relief, temperature neutrality, and support.' },
      { title: 'Purple vs Saatva: Which Mattress Is Better? - Sleep Foundation', url: 'https://www.sleepfoundation.org/mattress-reviews/purple-vs-saatva', group: 'mattress', text: 'We compare the Purple and Saatva mattresses across firmness, motion isolation, cooling, and price to help you choose.' },
      { title: 'Best Mattresses of 2026 | Wirecutter', url: 'https://www.nytimes.com/wirecutter/reviews/best-mattress/', group: 'mattress', text: 'After sleeping on dozens of mattresses, these are our top picks for side sleepers, back sleepers, and hot sleepers.' },
    ],
  },
  {
    name: 'news-event (Fed rate decision + noise)',
    tabs: [
      { title: 'Fed Holds Interest Rates Steady - The New York Times', url: 'https://www.nytimes.com/fed-holds-rates-steady', group: 'fed', text: 'The Federal Reserve held interest rates steady at its latest meeting, citing continued progress on inflation and a resilient labor market.' },
      { title: 'Federal Reserve Keeps Rates Unchanged - BBC', url: 'https://www.bbc.com/news/business/fed-rates-unchanged', group: 'fed', text: 'The US central bank kept interest rates unchanged, as policymakers weigh inflation risks against a cooling job market.' },
      { title: "What the Fed's Rate Decision Means for You - CNBC", url: 'https://www.cnbc.com/fed-rate-decision-means', group: 'fed', text: "Here's what the Federal Reserve's decision to hold interest rates steady means for mortgages, credit cards, and savings." },
      { title: 'r/economics - Fed rate decision megathread - Reddit', url: 'https://www.reddit.com/r/economics/comments/fedrate', group: 'fed', text: "Megathread for discussing today's Federal Reserve interest rate decision and what it means for markets and mortgages." },
      { title: 'Federal Reserve - Wikipedia', url: 'https://en.wikipedia.org/wiki/Federal_Reserve', group: 'fed', text: 'The Federal Reserve System is the central banking system of the United States, responsible for monetary policy and interest rates.' },
      { title: 'Local Team Wins Championship - ESPN', url: 'https://www.espn.com/local-team-wins-championship', group: null, text: 'The hometown team clinched the championship in a thrilling overtime finish, capping off a historic season for the fans.' },
      { title: 'New Movie Release This Weekend - Variety', url: 'https://variety.com/new-movie-release-this-weekend', group: null, text: "This weekend's box office is dominated by a highly anticipated new release, with critics praising its visual effects." },
      { title: 'Weather Alert: Storm Approaching - Weather.com', url: 'https://weather.com/storms/storm-approaching', group: null, text: 'A severe storm system is approaching the region with high winds and heavy rain expected, prompting weather alerts.' },
    ],
  },
  {
    name: 'noise-only (adversarial near-miss words)',
    tabs: [
      { title: 'Best Restaurants in Chicago - Eater', url: 'https://chicago.eater.com/best-restaurants-chicago', group: null, text: 'Our critics pick the best restaurants in Chicago right now, spanning deep dish pizza, fine dining, and hidden gems.' },
      { title: 'Top 10 Movies of 2026 - IGN', url: 'https://www.ign.com/articles/top-10-movies-of-2026', group: null, text: 'Our ranked list of the best movies released this year, spanning blockbusters, indie darlings, and award contenders.' },
      { title: 'Best Programming Languages to Learn in 2026 - freeCodeCamp', url: 'https://www.freecodecamp.org/news/best-programming-languages-2026/', group: null, text: 'A look at the most in-demand programming languages to learn this year for web development, data science, and mobile apps.' },
      { title: 'How to Fix a Leaky Faucet - wikiHow', url: 'https://www.wikihow.com/Fix-a-Leaky-Faucet', group: null, text: 'Step by step instructions for fixing a leaky faucet at home, including the tools you need and common causes of drips.' },
      { title: '2026 Tax Filing Deadline - IRS', url: 'https://www.irs.gov/2026-tax-filing-deadline', group: null, text: 'Important filing deadlines and deductions to know before submitting your tax return this year, plus how to file an extension.' },
      { title: 'Best Practices for Code Review - Google Engineering Blog', url: 'https://opensource.google/blog/best-practices-code-review', group: null, text: 'Effective code review practices that improve software quality, catch bugs early, and help engineering teams collaborate.' },
      { title: 'Top Rated Coffee Makers 2026 - Consumer Reports', url: 'https://www.consumerreports.org/coffee-makers/top-rated-2026', group: null, text: 'Our lab tested a dozen coffee makers to find the ones that brew the best cup with the least hassle and easiest cleanup.' },
      { title: 'Review of the Latest iPhone 17 - The Verge', url: 'https://www.theverge.com/iphone-17-review', group: null, text: 'Our full review of the latest iPhone, covering camera improvements, battery life, performance, and the upgrade decision.' },
    ],
  },
  {
    name: 'short-titles-and-stemming (GPUs vs running shoes + noise)',
    tabs: [
      { title: 'RTX 5090 Benchmarks', url: 'https://www.tomshardware.com/gpu/rtx-5090-benchmarks', group: 'gpu', text: 'Full benchmark results for the RTX 5090, testing performance across the latest games and content creation workloads at 4K.' },
      { title: 'Benchmarking the RTX 5080', url: 'https://www.anandtech.com/rtx-5080-benchmarking', group: 'gpu', text: 'We benchmark the RTX 5080 against its predecessor and rivals, measuring frame rates across popular games at multiple resolutions.' },
      { title: 'RTX 5070 Ti Review and Benchmarks', url: 'https://www.techpowerup.com/review/rtx-5070-ti-benchmarks', group: 'gpu', text: 'Our review and benchmarks of the RTX 5070 Ti, covering gaming performance, ray tracing, and value versus other GPUs.' },
      { title: 'Top Running Shoes for Marathon Training', url: 'https://www.runnersworld.com/top-running-shoes-marathon-training', group: 'shoes', text: 'Our picks for the best running shoes for marathon training, covering cushioning, durability, and support for long runs.' },
      { title: 'Running Shoe Reviews: Marathon Edition', url: 'https://www.roadrunnersports.com/running-shoe-reviews-marathon', group: 'shoes', text: 'We review the top running shoes for marathon runners, comparing weight, cushioning, and breathability for race day.' },
      { title: 'Marathon Runners Share Their Favorite Running Shoes', url: 'https://www.outsideonline.com/marathon-runners-favorite-running-shoes', group: 'shoes', text: 'Experienced marathon runners share their favorite running shoes for race day and training, from racers to max cushioned trainers.' },
      { title: 'Local Weather Radar', url: 'https://weather.com/radar/local', group: null, text: 'Live local weather radar showing current precipitation, storm tracking, and short term forecasts for your area.' },
      { title: 'Recipe Box Login', url: 'https://www.recipebox.example/login', group: null, text: 'Log in to your recipe box account to save, organize, and access your favorite recipes from anywhere.' },
      { title: 'Bank Statement PDF', url: 'https://www.chase.com/statements/latest.pdf', group: null, text: 'View and download your latest bank statement, including transaction history and account summary.' },
      { title: 'Company Holiday Schedule', url: 'https://intranet.example.com/holiday-schedule', group: null, text: 'The company holiday schedule for the year, listing observed holidays and office closure dates for employees.' },
    ],
  },
];

// ---------- held-out: written before this round's tuning, not used to pick thresholds ----------

const heldOut = [
  {
    name: '[held-out] home-renovation-vs-budgeting',
    tabs: [
      { title: 'Kitchen Renovation On A Budget - Before and After - YouTube', url: 'https://www.youtube.com/watch?v=kitchenreno1', group: 'reno', text: 'A full kitchen renovation on a tight budget, covering cabinet refacing, new countertops, and budget friendly lighting upgrades.' },
      { title: 'Kitchen remodel budget advice? - Reddit', url: 'https://www.reddit.com/r/HomeImprovement/comments/kitchenbudget', group: 'reno', text: 'Looking for advice on how to budget a kitchen remodel without overspending on cabinets, countertops, and appliances.' },
      { title: 'Home improvement - Wikipedia', url: 'https://en.wikipedia.org/wiki/Home_improvement', group: 'reno', text: 'Home improvement includes projects that renovate or improve a home, such as kitchen and bathroom remodeling and additions.' },
      { title: 'How to Plan a Kitchen Renovation Step by Step | The Spruce', url: 'https://www.thespruce.com/kitchen-renovation-planning', group: 'reno', text: 'A step by step guide to planning a kitchen renovation, from setting a budget to choosing cabinets, countertops, and a contractor.' },
      { title: 'Kitchen Cabinets & Countertops - The Home Depot', url: 'https://www.homedepot.com/kitchen-cabinets-countertops', group: 'reno', text: 'Shop kitchen cabinets, countertops, and renovation supplies with delivery and installation services available nationwide.' },
      { title: 'Budget Kitchen Renovation Ideas | HGTV', url: 'https://www.hgtv.com/budget-kitchen-renovation-ideas', group: 'reno', text: 'Affordable kitchen renovation ideas that make a big impact without a big budget, from paint to hardware swaps.' },
      { title: 'Personal Budgeting for Beginners - YouTube', url: 'https://www.youtube.com/watch?v=budgeting1', group: 'budget', text: "A beginner's guide to personal budgeting, covering how to track spending, build an emergency fund, and pay down debt." },
      { title: 'Best budgeting method for beginners? - Reddit', url: 'https://www.reddit.com/r/personalfinance/comments/budgetmethod', group: 'budget', text: 'What budgeting method works best for beginners trying to build savings and pay off debt for the first time.' },
      { title: 'Personal budget - Wikipedia', url: 'https://en.wikipedia.org/wiki/Personal_budget', group: 'budget', text: 'A personal budget is a finance plan that allocates future personal income towards expenses, savings, and debt repayment.' },
      { title: "How to Build a Budget You'll Actually Stick To | NerdWallet", url: 'https://www.nerdwallet.com/article/finance/budgeting', group: 'budget', text: "A practical guide to building a personal budget you'll actually stick to, including the 50/30/20 rule and tracking apps." },
      { title: 'The Beginner\'s Guide to Budgeting and Saving | The Simple Dollar', url: 'https://www.thesimpledollar.com/budgeting-saving-guide', group: 'budget', text: "A beginner's guide to budgeting and saving money, covering emergency funds, debt payoff strategies, and retirement savings." },
      { title: 'Budgeting Basics: How to Create a Budget | Investopedia', url: 'https://www.investopedia.com/budgeting-basics', group: 'budget', text: 'Learn the basics of creating a personal budget, including tracking income and expenses and setting realistic savings goals.' },
      { title: 'Discover Weekly - Spotify', url: 'https://open.spotify.com/playlist/discover-weekly-2', group: null, text: 'Stream millions of songs and discover new music every week with your personalized playlist.' },
      { title: 'torvalds/linux - GitHub', url: 'https://github.com/torvalds/linux', group: null, text: 'The Linux kernel source tree, the open source operating system kernel that powers servers and devices worldwide.' },
    ],
  },
  {
    name: '[held-out] second-library-debug (Zod)',
    tabs: [
      { title: 'Zod | TypeScript-first schema validation', url: 'https://zod.dev', group: 'lib', text: 'Zod is a TypeScript-first schema declaration and validation library with static type inference for parsing and validating data.' },
      { title: 'colinhacks/zod - GitHub', url: 'https://github.com/colinhacks/zod', group: 'lib', text: 'TypeScript-first schema validation with static type inference, zero dependencies, and a small bundle size for JavaScript apps.' },
      { title: 'zod - npm', url: 'https://www.npmjs.com/package/zod', group: 'lib', text: 'TypeScript-first schema validation with static type inference, used for parsing and validating data at runtime.' },
      { title: 'typescript - How to validate nested objects with Zod? - Stack Overflow', url: 'https://stackoverflow.com/questions/1111/zod-nested-objects', group: 'lib', text: 'Question about validating deeply nested objects and arrays using Zod schemas in a TypeScript application.' },
      { title: 'Zod optional vs nullable fields - Stack Overflow', url: 'https://stackoverflow.com/questions/2222/zod-optional-nullable', group: 'lib', text: 'Question about the difference between optional and nullable fields when defining a Zod schema for form validation.' },
      { title: 'Zod Crash Course - Schema Validation in TypeScript - YouTube', url: 'https://www.youtube.com/watch?v=zodcrash', group: 'lib', text: 'A crash course on Zod schema validation in TypeScript, covering objects, arrays, unions, and custom validation rules.' },
      { title: 'Why I Switched From Yup to Zod for Form Validation | Medium', url: 'https://medium.com/@dev/why-zod-over-yup', group: 'lib', text: "A comparison of Zod and Yup for form validation in React applications, and why Zod's type inference won me over." },
      { title: 'r/typescript - Zod vs io-ts for runtime validation - Reddit', url: 'https://www.reddit.com/r/typescript/comments/zodvsiots', group: 'lib', text: 'Discussion comparing Zod and io-ts for runtime type validation in TypeScript projects, covering ergonomics and performance.' },
      { title: 'Weather forecast Seattle', url: 'https://weather.com/weather/today/l/seattle', group: null, text: 'Current conditions and 7 day forecast for Seattle, Washington, including temperature and precipitation chance.' },
      { title: 'Amazon Order History', url: 'https://www.amazon.com/gp/css/order-history', group: null, text: '' },
    ],
  },
  {
    name: '[held-out] two-news-events (election vs championship)',
    tabs: [
      { title: 'Freedonia Holds Landmark Election Amid Record Turnout - The New York Times', url: 'https://www.nytimes.com/freedonia-election-turnout', group: 'election', text: 'Freedonia held a landmark national election with record voter turnout, as citizens cast ballots to choose a new prime minister.' },
      { title: 'Freedonia Election: What to Know - BBC', url: 'https://www.bbc.com/news/world/freedonia-election', group: 'election', text: "Voters in Freedonia went to the polls today in a closely watched election that could reshape the country's foreign policy." },
      { title: 'r/worldnews - Freedonia election results megathread - Reddit', url: 'https://www.reddit.com/r/worldnews/comments/freedoniaelection', group: 'election', text: "Megathread for discussing the results of today's national election in Freedonia and what it means for the region." },
      { title: 'Freedonia - Wikipedia', url: 'https://en.wikipedia.org/wiki/Freedonia', group: 'election', text: 'Freedonia is a country whose government recently held a national election to select a new prime minister and parliament.' },
      { title: 'Freedonia Election Results: Live Updates - Reuters', url: 'https://www.reuters.com/world/freedonia-election-results', group: 'election', text: "Live updates and results as votes are counted in Freedonia's national election, with the ruling party facing a tight race." },
      { title: 'Riverside Hawks Win Championship in Stunning Upset - The New York Times', url: 'https://www.nytimes.com/riverside-hawks-championship', group: 'championship', text: 'The Riverside Hawks won the national football championship in a stunning upset, capping off a historic underdog season.' },
      { title: 'Riverside Hawks Claim Championship Title - BBC', url: 'https://www.bbc.com/sport/riverside-hawks-championship', group: 'championship', text: 'The Riverside Hawks claimed the national football championship title after a dramatic overtime finish before a sellout crowd.' },
      { title: 'r/sports - Riverside Hawks win the championship! - Reddit', url: 'https://www.reddit.com/r/sports/comments/hawkschampionship', group: 'championship', text: "Discussion thread celebrating the Riverside Hawks' championship win after a hard fought season and a thrilling final game." },
      { title: 'Riverside Hawks - Wikipedia', url: 'https://en.wikipedia.org/wiki/Riverside_Hawks', group: 'championship', text: 'The Riverside Hawks are a professional football team that recently won the national championship for the first time.' },
      { title: 'Riverside Hawks Championship Parade Draws Thousands - Reuters', url: 'https://www.reuters.com/sports/riverside-hawks-parade', group: 'championship', text: "Thousands gathered downtown for a parade celebrating the Riverside Hawks' national football championship victory." },
      { title: 'Discover Weekly - Spotify', url: 'https://open.spotify.com/playlist/discover-weekly-3', group: null, text: 'Stream millions of songs and discover new music every week with your personalized playlist.' },
      { title: 'torvalds/linux - GitHub', url: 'https://github.com/torvalds/linux', group: null, text: 'The Linux kernel source tree, the open source operating system kernel that powers servers and devices worldwide.' },
      { title: 'Weather Alert: Storm Approaching - Weather.com', url: 'https://weather.com/storms/storm-approaching-2', group: null, text: 'A severe storm system is approaching the region with high winds and heavy rain expected, prompting weather alerts.' },
      { title: 'New Movie Release This Weekend - Variety', url: 'https://variety.com/new-movie-release-this-weekend-2', group: null, text: "This weekend's box office is dominated by a highly anticipated new release, with critics praising its visual effects." },
    ],
  },
];

// ---------- report ----------

function report(title, list) {
  console.log(`\n=== ${title} ===\n`);
  console.log(pad('scenario', 46) + pad('no-text P/R/F1', 18) + pad('with-text P/R/F1', 18) + 'wrongLoose (no/with)');
  const sum = { noText: { precision: 0, recall: 0, f1: 0 }, withText: { precision: 0, recall: 0, f1: 0 } };
  for (const scenario of list) {
    const noText = runBatch(final, scenario, { withText: false });
    const withText = runBatch(final, scenario, { withText: true });
    for (const k of ['precision', 'recall', 'f1']) { sum.noText[k] += noText[k]; sum.withText[k] += withText[k]; }
    const rn = `${fmt(noText.precision)}/${fmt(noText.recall)}/${fmt(noText.f1)}`;
    const rw = `${fmt(withText.precision)}/${fmt(withText.recall)}/${fmt(withText.f1)}`;
    console.log(pad(scenario.name, 46) + pad(rn, 18) + pad(rw, 18) + `${noText.wronglyGroupedLoose}/${withText.wronglyGroupedLoose}`);
  }
  const n = list.length;
  console.log('-'.repeat(100));
  console.log(pad('AVERAGE', 46) + pad(`${fmt(sum.noText.precision / n)}/${fmt(sum.noText.recall / n)}/${fmt(sum.noText.f1 / n)}`, 18) + pad(`${fmt(sum.withText.precision / n)}/${fmt(sum.withText.recall / n)}/${fmt(sum.withText.f1 / n)}`, 18));
}

function synthTabs(count) {
  const topics = ['machine learning', 'sourdough baking', 'tokyo travel', 'lisbon travel', 'react query', 'noise headphones', 'purple mattress', 'fed interest rates', 'rtx gpu benchmarks', 'marathon running shoes'];
  const sites = ['youtube.com/watch?v=', 'reddit.com/r/x/comments/', 'en.wikipedia.org/wiki/', 'medium.com/@a/', 'github.com/a/', 'stackoverflow.com/questions/'];
  const out = [];
  for (let i = 0; i < count; i++) {
    const topic = topics[i % topics.length];
    const site = sites[i % sites.length];
    out.push({ id: i + 1, title: `${topic} part ${i} - notes`, url: `https://${site}${i}`, text: `A detailed look at ${topic}, covering the basics and some advanced tips for part ${i} of this series.` });
  }
  return out;
}

// Exported so a throwaway grid-search/ablation script can reuse the scenarios and scoring against
// any tab-groups.js variant, without duplicating this data.
module.exports = { scenarios, heldOut, harness, runBatch, score, synthTabs };

if (require.main === module) {
  report('Main scenarios (baseline for comparison: run against test/_baseline-tab-groups.js separately)', scenarios);
  report("Held-out scenarios (written before this round's tuning)", heldOut);

  console.log('\n=== Baseline (pre-topic-work) reference, no-text only ===\n');
  for (const scenario of scenarios) {
    const b = runBatch(baseline, scenario, { withText: false });
    console.log(pad(scenario.name, 46) + `${fmt(b.precision)}/${fmt(b.recall)}/${fmt(b.f1)}`);
  }

  console.log('\n=== Performance: topicClusters() over 100 tabs (with text) ===\n');
  const hot = synthTabs(100);
  for (let i = 0; i < 3; i++) final.topicClusters(hot); // warm up
  const N = 20;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) final.topicClusters(hot);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6 / N;
  console.log(`100 tabs, ${N} runs averaged: ${ms.toFixed(2)}ms/run (budget: well under 50ms)`);
}
