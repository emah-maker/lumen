// Realistic mixed sessions for the topic organizer benchmark (test/topics-bench.js): research,
// shopping, coding, school, video, and search-then-visit. Titles and URLs only (no page text), the
// worst case for the local organizer: text arrives only after a page has loaded.
// group: the label a person would give the tab (null = should stay loose); names: for each group,
// words a good group name should contain.
const sessions = [
  {
    name: '[session] coding (repo issues/PRs + docs + SO)',
    names: { lumen: /lumen/i, next: /next/i },
    tabs: [
      { title: 'Pull requests · emah-maker/lumen', url: 'https://github.com/emah-maker/lumen/pulls', group: 'lumen' },
      { title: 'Fix tab strip flicker by emah-maker · Pull Request #46 · emah-maker/lumen', url: 'https://github.com/emah-maker/lumen/pull/46', group: 'lumen' },
      { title: 'Sidebar is slow to open · Issue #41 · emah-maker/lumen', url: 'https://github.com/emah-maker/lumen/issues/41', group: 'lumen' },
      { title: 'emah-maker/lumen: An AI browser', url: 'https://github.com/emah-maker/lumen', group: 'lumen' },
      { title: 'Routing: Dynamic Routes | Next.js', url: 'https://nextjs.org/docs/app/building-your-application/routing/dynamic-routes', group: 'next' },
      { title: 'Data Fetching: Server Actions | Next.js', url: 'https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions', group: 'next' },
      { title: 'next.js - Server action redirect not working - Stack Overflow', url: 'https://stackoverflow.com/questions/771/next-js-server-action-redirect-not-working', group: 'next' },
      { title: 'vercel/next.js Discussions', url: 'https://github.com/vercel/next.js/discussions', group: 'next' },
      { title: 'Inbox (3) - mah.e@northeastern.edu', url: 'https://mail.google.com/mail/u/0/#inbox', group: null },
      { title: 'Spotify - Web Player', url: 'https://open.spotify.com/', group: null },
    ],
  },
  {
    name: '[session] shopping (two products, several stores)',
    names: { keyboard: /keyboard/i, monitor: /monitor/i },
    tabs: [
      { title: 'Keychron K2 Wireless Mechanical Keyboard - Amazon.com', url: 'https://www.amazon.com/dp/B0K2KEYCH', group: 'keyboard' },
      { title: 'Keychron K2 Pro Mechanical Keyboard | Keychron', url: 'https://www.keychron.com/products/keychron-k2-pro', group: 'keyboard' },
      { title: 'Best mechanical keyboards 2026 - RTINGS.com', url: 'https://www.rtings.com/keyboard/reviews/best/mechanical', group: 'keyboard' },
      { title: 'r/MechanicalKeyboards - K2 vs Q1 which one? - Reddit', url: 'https://www.reddit.com/r/MechanicalKeyboards/comments/k2q1', group: 'keyboard' },
      { title: 'Dell UltraSharp U2723QE 27 4K Monitor - Best Buy', url: 'https://www.bestbuy.com/site/dell-ultrasharp-u2723qe', group: 'monitor' },
      { title: 'Dell U2723QE Monitor Review - RTINGS.com', url: 'https://www.rtings.com/monitor/reviews/dell/u2723qe', group: 'monitor' },
      { title: 'Best 4K monitors for programming - Wirecutter', url: 'https://www.nytimes.com/wirecutter/reviews/best-4k-monitors/', group: 'monitor' },
      { title: 'Your Amazon.com order history', url: 'https://www.amazon.com/gp/css/order-history', group: null },
      { title: 'Chase Online Banking', url: 'https://secure.chase.com/web/auth/dashboard', group: null },
    ],
  },
  {
    name: '[session] school (one course, an essay, admin)',
    names: { bio: /mitosis|bio|cell/i, essay: /hamlet|essay/i },
    tabs: [
      { title: 'BIO 1101 Cell Biology: Mitosis and Meiosis - Canvas', url: 'https://canvas.northeastern.edu/courses/1101/modules/mitosis', group: 'bio' },
      { title: 'Mitosis - Wikipedia', url: 'https://en.wikipedia.org/wiki/Mitosis', group: 'bio' },
      { title: 'Mitosis vs Meiosis Flashcards | Quizlet', url: 'https://quizlet.com/mitosis-vs-meiosis-flashcards', group: 'bio' },
      { title: 'Stages of Mitosis - Khan Academy', url: 'https://www.khanacademy.org/science/biology/cell-division/mitosis', group: 'bio' },
      { title: 'Hamlet Essay Draft - Google Docs', url: 'https://docs.google.com/document/d/1abcHamlet/edit', group: 'essay' },
      { title: 'Hamlet: Themes of Madness - SparkNotes', url: 'https://www.sparknotes.com/shakespeare/hamlet/themes/', group: 'essay' },
      { title: 'Hamlet - Wikipedia', url: 'https://en.wikipedia.org/wiki/Hamlet', group: 'essay' },
      { title: 'How to Write a Literary Analysis Essay - Purdue OWL', url: 'https://owl.purdue.edu/owl/general_writing/literary-analysis-essay', group: 'essay' },
      { title: 'Student Hub - Registrar', url: 'https://registrar.northeastern.edu/', group: null },
    ],
  },
  {
    name: '[session] video (3 topics on one site)',
    names: { piano: /piano/i, f1: /f1|formula|monaco|grand/i },
    tabs: [
      { title: 'Learn Piano in 10 Minutes - YouTube', url: 'https://www.youtube.com/watch?v=pi1', group: 'piano' },
      { title: 'Piano Chords for Beginners - YouTube', url: 'https://www.youtube.com/watch?v=pi2', group: 'piano' },
      { title: 'Easy Piano Songs You Can Play Today - YouTube', url: 'https://www.youtube.com/watch?v=pi3', group: 'piano' },
      { title: 'Formula 1 2026 Monaco Grand Prix Highlights - YouTube', url: 'https://www.youtube.com/watch?v=f11', group: 'f1' },
      { title: 'Monaco Grand Prix Qualifying Recap - YouTube', url: 'https://www.youtube.com/watch?v=f12', group: 'f1' },
      { title: 'Formula 1 Onboard Lap Monaco - YouTube', url: 'https://www.youtube.com/watch?v=f13', group: 'f1' },
      { title: 'Lofi Hip Hop Radio - Beats to Study To - YouTube', url: 'https://www.youtube.com/watch?v=lo1', group: null },
      { title: 'Subscriptions - YouTube', url: 'https://www.youtube.com/feed/subscriptions', group: null },
    ],
  },
  {
    name: '[session] research (search pages lead to results)',
    names: { fusion: /fusion/i, sleep: /melatonin|sleep/i },
    tabs: [
      { title: 'nuclear fusion ignition breakthrough - Google Search', url: 'https://www.google.com/search?q=nuclear+fusion+ignition+breakthrough', group: 'fusion' },
      { title: 'National Ignition Facility achieves fusion ignition | LLNL', url: 'https://www.llnl.gov/news/national-ignition-facility-achieves-fusion-ignition', group: 'fusion' },
      { title: 'Nuclear fusion - Wikipedia', url: 'https://en.wikipedia.org/wiki/Nuclear_fusion', group: 'fusion' },
      { title: 'How fusion ignition works - Scientific American', url: 'https://www.scientificamerican.com/article/how-fusion-ignition-works/', group: 'fusion' },
      { title: 'does melatonin help you sleep - Google Search', url: 'https://www.google.com/search?q=does+melatonin+help+you+sleep', group: 'sleep' },
      { title: 'Melatonin: Can it help you sleep? - Mayo Clinic', url: 'https://www.mayoclinic.org/healthy-lifestyle/adult-health/expert-answers/melatonin/faq-20057874', group: 'sleep' },
      { title: 'Melatonin and Sleep - Sleep Foundation', url: 'https://www.sleepfoundation.org/melatonin', group: 'sleep' },
      { title: 'Weather - Boston', url: 'https://weather.com/weather/today/l/boston', group: null },
    ],
  },
];

module.exports = { sessions };
