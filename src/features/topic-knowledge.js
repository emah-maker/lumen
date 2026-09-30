// A little built-in world knowledge for topic grouping (tab-groups.js). Everything is local and
// tiny on purpose:
//  - places: a city or region names its country, so "Kyoto ryokan" and "Japan Rail Pass" meet;
//  - concepts: everyday words that point at the same kind of task ("flight", "hotel", "itinerary"
//    are all travel), so a flights page and a hotels page of one trip share something;
//  - site categories: what kind of page a well-known domain serves (Booking is travel, Zillow is
//    housing), for the sites whose titles say little.
// A concept or category is only ever a weak extra signal; it never groups tabs on its own.
//  - site hints: the few sites that nearly always mean one task whatever the page says (Canvas is
//    school work, Indeed is a job search). Unlike a category, a hint IS enough to put a tab with
//    others of that hint, so the list is short and conservative on purpose.

// city / region -> country. Lower case, single words (titles are tokenised into words).
const PLACES = {
  japan: 'tokyo kyoto osaka hiroshima nara sapporo yokohama shinjuku shibuya harajuku akihabara hokkaido okinawa fukuoka nagoya kobe nikko hakone kamakura',
  france: 'paris lyon marseille bordeaux nice provence louvre versailles',
  italy: 'rome venice florence milan naples tuscany amalfi sicily verona bologna',
  spain: 'madrid barcelona seville valencia granada mallorca ibiza',
  portugal: 'lisbon porto algarve',
  england: 'london manchester liverpool',
  scotland: 'edinburgh glasgow',
  ireland: 'dublin galway',
  germany: 'berlin munich hamburg frankfurt cologne',
  netherlands: 'amsterdam rotterdam',
  greece: 'athens santorini mykonos crete',
  turkey: 'istanbul cappadocia',
  egypt: 'cairo luxor',
  thailand: 'bangkok phuket chiang',
  vietnam: 'hanoi saigon',
  korea: 'seoul busan jeju',
  china: 'beijing shanghai shenzhen',
  singapore: 'singapore',
  india: 'delhi mumbai bangalore goa kerala',
  emirates: 'dubai abu',
  australia: 'sydney melbourne brisbane perth',
  zealand: 'auckland queenstown wellington',
  canada: 'toronto vancouver montreal ottawa quebec banff',
  mexico: 'cancun tulum oaxaca',
  brazil: 'rio paulo',
  peru: 'lima cusco',
  iceland: 'reykjavik',
  switzerland: 'zurich geneva zermatt',
  austria: 'vienna salzburg',
  czech: 'prague',
  hungary: 'budapest',
  denmark: 'copenhagen',
  sweden: 'stockholm',
  norway: 'oslo bergen',
};

// concept -> words (lower case; matched after stemming, so plurals and -ing forms count).
const CONCEPTS = {
  travel: 'flight airline airfare airport hotel hostel resort itinerary airbnb vacation trip travel tourist tour visa passport luggage cruise ryokan sightseeing destination layover boarding',
  education: 'lecture homework syllabus assignment textbook exam midterm semester professor course quiz lab tutor gradebook',
  shopping: 'price buy deal discount coupon cart checkout shipping warranty unboxing',
  baking: 'sourdough bread loaf dough starter flour yeast crumb bake baking knead proofing levain baguette pastry dutch',
  cooking: 'recipe ingredient cook cooking dinner lunch breakfast meal mealprep grocery marinade roast sheet chicken protein burrito',
  jobs: 'job career resume interview salary hiring recruiter internship applicant offer negotiate negotiation leetcode cscareerquestions grad',
  housing: 'apartment rent rental lease landlord mortgage realtor tenant',
  sports: 'nba nfl mlb nhl playoff finals championship coach quarterback',
  health: 'symptom diagnosis medication doctor clinic therapy nutrition workout',
  finance: 'stock invest investing bond dividend portfolio inflation savings loan',
  music: 'chord lyric guitar piano song album playlist',
};

// registrable domain (or full host) -> category. Same category names as CONCEPTS where they overlap.
const SITE_CATEGORIES = {
  travel: 'booking.com kayak.com tripadvisor.com airbnb.com expedia.com skyscanner.com lonelyplanet.com klook.com hotels.com vrbo.com agoda.com viator.com getyourguide.com nomadicmatt.com japan-guide.com travel.state.gov flights.google.com',
  education: 'canvas.northeastern.edu instructure.com blackboard.com zybooks.com khanacademy.org coursera.org edx.org chegg.com quizlet.com piazza.com gradescope.com brightspace.com coursehero.com ocw.mit.edu',
  shopping: 'amazon.com bestbuy.com walmart.com target.com ebay.com etsy.com newegg.com rtings.com wirecutter.com camelcamelcamel.com costco.com homedepot.com lowes.com',
  baking: 'kingarthurbaking.com bobsredmill.com theclevercarrot.com',
  cooking: 'seriouseats.com allrecipes.com budgetbytes.com epicurious.com bonappetit.com instacart.com eatingwell.com foodnetwork.com cooking.nytimes.com',
  jobs: 'indeed.com glassdoor.com levels.fyi lever.co greenhouse.io ziprecruiter.com handshake.com zety.com leetcode.com hackerrank.com',
  housing: 'zillow.com apartments.com redfin.com streeteasy.com trulia.com realtor.com',
  dev: 'github.com gitlab.com stackoverflow.com stackexchange.com developer.mozilla.org npmjs.com pypi.org docs.docker.com hub.docker.com dev.to',
  sports: 'espn.com basketball-reference.com nba.com nfl.com mlb.com',
  finance: 'reuters.com bloomberg.com cnbc.com wsj.com marketwatch.com federalreserve.gov',
};

// hint (a group name, as shown) -> sites that nearly always mean it. Loose tabs of one hint form a
// group named for it, and a loose tab of a hint joins the group most of whose tabs have that hint
// (tab-groups.js); a model organizing tabs is told the hint beside each tab (main.js, organize-ai.js).
// Only sites where the hint is right almost every time: Google Docs, Notion, YouTube or Reddit could
// be anything, so they have none. Three ways to write a site:
//   instructure.com     that domain and every subdomain (school.instructure.com)
//   canvas.*            a host whose first label is that ("canvas.northeastern.edu", self-hosted LMSs)
//   linkedin.com/jobs   only that path (and below it) on that domain: the rest of LinkedIn is not a job search
const SITE_HINTS = {
  School: 'instructure.com canvas.* blackboard.com blackboard.* moodle.* brightspace.com d2l.* gradescope.com piazza.com edstem.org zybooks.com quizlet.com chegg.com coursehero.com khanacademy.org coursera.org edx.org classroom.google.com',
  'Job search': 'linkedin.com/jobs indeed.com greenhouse.io lever.co joinhandshake.com glassdoor.com ziprecruiter.com wellfound.com',
  Code: 'github.com gitlab.com stackoverflow.com npmjs.com pypi.org developer.mozilla.org',
  Travel: 'airbnb.com booking.com expedia.com kayak.com skyscanner.com hotels.com vrbo.com google.com/travel flights.google.com',
  Shopping: 'amazon.com ebay.com etsy.com',
};

// The hints a model may give a site the table above doesn't know ("Organize with AI" asks it about
// those hosts, features/organize-ai.js; the answers are kept in the profile, features/organize-learn.js).
// "none": the site is used for many things, or the model doesn't know it.
const AI_HINTS = ['School', 'Job search', 'Code', 'Travel', 'Shopping', 'News', 'Finance', 'Health', 'Social', 'Entertainment', 'Work', 'Reference'];

// Hints that name a KIND of site rather than one task: every project of every person lives on GitHub,
// and two news articles or two videos are rarely one topic for being on such a site. A model is still
// told them, and a group whose tabs all have one is still named for it when nothing better is left, but
// they never link tabs locally.
const BROAD_HINTS = new Set(['Code', 'News', 'Social', 'Entertainment', 'Work', 'Reference']);

module.exports = { PLACES, CONCEPTS, SITE_CATEGORIES, SITE_HINTS, AI_HINTS, BROAD_HINTS };
