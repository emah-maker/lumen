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

// The local organizer's last resort (tab-groups.js categoryOf): a tab no cluster took is filed by a broad category
// read from its host, then its title. No model, no page text: a plain, deterministic table. In the order tried.
//   hosts  domains (and subdomains), or "docs.*" (first label); strong: the host alone decides
//   title  words of the title that decide when the host doesn't
//   weak   the host says little (a news site can carry a review): a title match wins over it
//   join   the category is one topic, so its tabs may join a cluster of the same category (a trip, a course);
//          the others are kinds of site, which form their own group beside a topic's ("Dev docs" is not "Lumen")
// Host tests for what a list of domains can't say: a school is any .edu / .ac.xx / .edu.xx / k12 host, an agency any
// .gov / .mil / .gov.xx / .gouv.xx host. Kept apart: a tax office is no school.
const EDU_HOST = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$|(^|\.)k12\.|\.k12\.[a-z]{2}\.us$/;
const GOV_HOST = /\.(gov|mil)$|\.(gov|gouv)\.[a-z]{2}$|(^|\.)gov\.uk$/;
const FALLBACK_CATEGORIES = [
  { name: 'Mail & notes', hosts: 'mail.google.com gmail.com calendar.google.com drive.google.com docs.google.com sheets.google.com slides.google.com keep.google.com outlook.live.com outlook.office.com outlook.office365.com mail.yahoo.com proton.me notion.so evernote.com todoist.com trello.com asana.com slack.com airtable.com mail.*', title: /\b(inbox|calendar|to-?do|agenda)\b|受信トレイ|メール|почта|входящие|письм|받은편지함|收件箱/i },
  { name: 'Recipes', join: true, hosts: 'allrecipes.com seriouseats.com kingarthurbaking.com budgetbytes.com epicurious.com bonappetit.com foodnetwork.com cooking.nytimes.com eatingwell.com', title: /\b(recipes?|cookies?|bak(e|ing)|sourdough|dough|dinner ideas|meal prep|ingredients?)\b|レシピ|рецепт|레시피|食谱/i },
  { name: 'School', join: true, hosts: 'instructure.com canvas.* blackboard.com moodle.* brightspace.com gradescope.com piazza.com edstem.org zybooks.com quizlet.com chegg.com khanacademy.org coursera.org edx.org classroom.google.com schoology.com', hostRe: EDU_HOST, title: /\b(lectures?|homework|syllabus|assignments?|exams?|midterm|calculus|linear algebra|matri(x|ces)|eigen\w*|theorems?|physics|chemistry|biology|statistics|cs ?\d{3,4})\b|講義|宿題|試験|授業|лекци|домашн|экзамен|семестр|강의|숙제|课程|作业/i },
  // Government: agencies are not schools. Hosts by suffix (hostRe) and a few by name; the title words are the ones that say it alone.
  { name: 'Government', hosts: 'europa.eu canada.ca gc.ca usa.gov', hostRe: GOV_HOST, title: /\b(tax returns?|dmv|passport renewal|social security|voter registration|driver'?s licen[sc]e)\b|確定申告|налог|госуслуги/i },
  { name: 'Dev docs', hosts: 'developer.mozilla.org stackoverflow.com stackexchange.com github.com gitlab.com npmjs.com pypi.org dev.to react.dev reactjs.org electronjs.org nodejs.org typescriptlang.org python.org rust-lang.org go.dev docs.rs vuejs.org angular.dev nextjs.org tailwindcss.com devdocs.io w3schools.com docs.*', title: /\b(api reference|documentation|docs|handbook|sdk|stack overflow|javascript|typescript|node\.?js|pull request|commit)\b/i },
  { name: 'Travel', join: true, hosts: 'booking.com kayak.com tripadvisor.com airbnb.com expedia.com skyscanner.com hotels.com vrbo.com agoda.com lonelyplanet.com flights.google.com', title: /\b(flights?|hotels?|itinerary|airbnb|vacation|trip|things to do|visa|airport)\b|ホテル|観光|旅行|航空券|旅館|отел|авиабилет|путешеств|достопримечательн|호텔|여행|관광|酒店|旅游|景点/i },
  { name: 'Shopping', join: true, hosts: 'amazon.com ebay.com etsy.com bestbuy.com walmart.com target.com newegg.com rtings.com wirecutter.com costco.com homedepot.com lowes.com ikea.com', title: /\b(reviews?|deals?|discount|coupon|price|buy|cart|best [\w ]{2,30}20\d\d)\b|口コミ|通販|купить|отзыв|скидк|후기|할인|优惠|评测/i },
  { name: 'Video & music', hosts: 'youtube.com youtu.be vimeo.com twitch.tv netflix.com hulu.com disneyplus.com spotify.com soundcloud.com music.apple.com', title: /\b(official video|trailer|playlist|lofi|podcast)\b|動画|予告編|клип|трейлер|плейлист|동영상|视频/i },
  { name: 'News & social', weak: true, hosts: 'news.ycombinator.com reddit.com twitter.com x.com facebook.com instagram.com linkedin.com bsky.app threads.net nytimes.com washingtonpost.com bbc.com bbc.co.uk cnn.com theguardian.com reuters.com apnews.com theverge.com techcrunch.com arstechnica.com wired.com npr.org bloomberg.com weather.com news.google.com', title: /\b(breaking|headlines|news|weather forecast)\b|ニュース|天気予報|новости|прогноз погоды|뉴스|新闻|天气/i },
];

module.exports = { FALLBACK_CATEGORIES, EDU_HOST, GOV_HOST, PLACES, CONCEPTS, SITE_CATEGORIES, SITE_HINTS, AI_HINTS, BROAD_HINTS };
