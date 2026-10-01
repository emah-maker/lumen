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
  france: 'paris lyon marseille bordeaux nice provence louvre versailles toulouse strasbourg',
  italy: 'rome venice florence milan naples tuscany amalfi sicily verona bologna roma venezia firenze milano napoli torino',
  spain: 'madrid barcelona seville sevilla valencia granada mallorca ibiza malaga bilbao',
  portugal: 'lisbon lisboa porto algarve',
  england: 'london manchester liverpool',
  scotland: 'edinburgh glasgow',
  ireland: 'dublin galway',
  germany: 'berlin munich münchen munchen muenchen hamburg frankfurt cologne köln düsseldorf stuttgart dresden leipzig nürnberg bayern bavaria',
  netherlands: 'amsterdam rotterdam',
  greece: 'athens santorini mykonos crete',
  turkey: 'istanbul cappadocia',
  egypt: 'cairo luxor',
  thailand: 'bangkok phuket chiang',
  vietnam: 'hanoi saigon',
  korea: 'seoul busan jeju',
  china: 'beijing shanghai shenzhen',
  singapore: 'singapore',
  india: 'delhi mumbai bangalore goa kerala chennai kolkata hyderabad pune jaipur agra',
  emirates: 'dubai abu',
  australia: 'sydney melbourne brisbane perth',
  zealand: 'auckland queenstown wellington',
  canada: 'toronto vancouver montreal ottawa quebec banff',
  mexico: 'cancun tulum oaxaca',
  brazil: 'rio paulo',
  peru: 'lima cusco',
  iceland: 'reykjavik',
  switzerland: 'zurich zürich geneva zermatt',
  austria: 'vienna wien salzburg',
  czech: 'prague praha',
  poland: 'warsaw warszawa krakow kraków gdansk',
  argentina: 'buenos mendoza bariloche',
  hungary: 'budapest',
  denmark: 'copenhagen',
  sweden: 'stockholm',
  norway: 'oslo bergen',
};

// concept -> words (lower case; matched after stemming, so plurals and -ing forms count). Travel and housing also carry the same errands in
// German, Spanish, Portuguese, French and Italian, and Japanese and Korean as the two-character pieces tab-groups reads those scripts in.
const CONCEPTS = {
  travel: 'amtrak flixbus megabus greyhound ryanair easyjet jet2 flight airline airfare airport hotel hostel resort itinerary airbnb vacation trip travel tourist tour visa passport luggage cruise ryokan sightseeing destination layover attractions honeymoon hilton marriott hyatt sheraton wyndham hampton ihg museum museums flug flüge flughafen bahn zug reise reisen urlaub unterkunft ferienwohnung vuelo vuelos billete billetes alojamiento viaje viajes pasaje pasajes passagem passagens voo voos viagem viagens vol vols billet sncf voyage volo voli treno albergo viaggio 旅行 航空 ホテ 항공 숙소 여행 호텔',
  education: 'bsn dnp fnp tuition anatomy physiology flashcards flashcard lecture homework syllabus assignment textbook exam midterm semester professor course quiz lab tutor gradebook teacher teachers teaching rubric rubrics curriculum classroom turnitin kahoot',
  shopping: 'price buy deal discount coupon cart checkout shipping warranty unboxing',
  entertainment: 'movie movies film films cinema trailer trailers imdb letterboxd goodreads rotten tomatoes tomato book books novel novels author series season episode episodes tv sitcom documentary actor director',
  baking: 'sourdough bread loaf dough starter flour yeast crumb bake baking knead proofing levain baguette pastry dutch oven hydration scoring banneton cake cookie cookies',
  cooking: 'борщ пирог пирожки блины котлеты суп салат плов recipe receita receitas receta recetas rezept rezepte recette recettes ricetta ricette ingredient cook cooking dinner lunch breakfast meal mealprep grocery marinade roast chicken burrito pasta soup stew casserole skillet 카페 맛집 레시 시피 요리',
  jobs: 'job career resume interview salary hiring recruiter internship applicant offer negotiate negotiation leetcode cscareerquestions grad',
  // A baby's first year, woodworking, crypto and a real-estate agent's paperwork (the phrases that say them beside these words are PHRASE_CONCEPTS).
  baby: 'wipes newborn newborns baby babies infant infants swaddle swaddles breastfeeding breastfeed diaper diapers postpartum pediatrician pediatricians babylist huckleberry crib cribs stroller strollers daycare childcare bassinet bassinets nursery onesie onesies pacifier pacifiers lactation colic toddler toddlers maternity paternity swaddling babycenter thebump',
  woodworking: 'woodworking woodworker woodworkers woodshop dovetail dovetails chisel chisels workbench walnut lumber jig jigs joinery rockler woodcraft sawdust titebond kreg plywood hardwood hardwoods roubo benchcrafted lumberjocks',
  crypto: 'crypto cryptocurrency bitcoin ethereum uniswap ledger etherscan defillama koinly coinbase kraken metamask wallet wallets defi staking dex dao daos nft nfts solana altcoin altcoins blockchain web3 btcusd ethusd ethfinance bankless lido tvl stablecoin stablecoins',
  realestate: 'docusign dotloop mls escrow',
  // ("lease", "moving" and "relocation" are not here: a car lease and a job relocation are not housing. A tab with one of them and no other housing word is not housing; with "apartment", "rent" or "tenant" it is, by those words.)
  housing: 'apartment apartments rent rental landlord realtor tenant renter renters movers uhaul wohnung wohnungen mieten miete mietvertrag zimmer vermieter nebenkosten alquiler alquilar piso pisos inquilino loyer logement affitto appartamento aluguel apartamento rightmove zoopla tenancy lettings flat flats accommodation homebuyer homebuyers homebuying preapproval 賃貸 不動 월세 전세 부동',
  sports: 'messi soccer football basketball baseball hudl ncaa teamworks cleats hamstring uswnt midfielder midfielders nba nfl mlb nhl playoff finals championship coach quarterback fussball fußball bundesliga spielplan laliga futebol cricket ipl bcci cricbuzz espncricinfo kohli dhoni rcb csk wicket innings premier league fixtures standings arsenal chelsea tottenham epl kbo 손흥 흥민 축구 야구 리그',
  health: 'symptom diagnosis medication doctor clinic therapy nutrition workout prescription prescriptions pharmacy cardiology cardiologist patient mychart physician hospital dentist pediatrician',
  finance: 'stock invest investing investor bond dividend portfolio inflation savings loan mortgage mortgages yield yields roth ira 401k 403b rollover retirement retire brokerage dividends index etf etfs fund funds equity equities crypto bitcoin fidelity vanguard schwab robinhood etrade coinbase zerodha groww hdfc icici phonepe paytm nifty sensex upstox nubank itaú itau bradesco bovespa ibovespa sparkasse volksbank commerzbank revolut monzo n26 degiro trading212 etoro barclays hsbc santander bbva',
  dining: 'cafe cafes 카페 맛집',
  tax: 'tax taxes irs turbotax hrblock comptroller legalzoom llc incorporation bookkeeping quickbooks',
  ecommerce: 'shopify etsy squareup shipstation pirateship usps fedex ups seller sellers storefront listings dropshipping',
  ml: 'machine neural reinforcement rlhf gradient backpropagation pytorch tensorflow keras llm llms gpt transformer transformers attention embedding embeddings huggingface arxiv kaggle tensor deeplearning cuda gpu gpus vram nanogpt lora oom finetune finetuning tuning tokenizer diffusion classifier backprop supervised unsupervised convolutional rnn lstm gan autoencoder overfitting regularization hyperparameter dataset pretraining inference mlp bert langchain',
  fitness: 'fitness gym cardio run running runner runners marathon jog jogging c25k couch strava garmin peloton pegasus parkrun triathlon yoga pilates crossfit deadlift squat hiit hypertrophy macros macro protein lifting weightlifting powerlifting barbell dumbbell creatine bench',
  plants: 'plant plants monstera fiddle pothos philodendron fern ferns moss succulent succulents orchid orchids bonsai garden gardening seedling houseplant houseplants cactus cacti repot repotting prune pruning compost fertilizer perennial soil seeds heirloom mulch blight',
  programming: 'golang goroutine goroutines python pandas numpy scipy matplotlib seaborn jupyter django flask fastapi pytest pip asyncio dataclasses typescript javascript react redux vue svelte angular nextjs node nodejs npm webpack vite rust cargo golang java kotlin sql postgres postgresql mysql sqlite mongodb redis git docker electron css html regex linux bash compiler programming coding developer sdk',
  devops: 'kubernetes k8s kubectl helm docker dockerfile container containers terraform ansible aws azure gcp cloud lambda ec2 s3 nginx cicd jenkins devops pod pods deployment microservice microservices serverless prometheus ec2 s3 cloudformation route53 iam rds eks ecs fargate gcloud',
  music: 'chord lyric guitar piano song album playlist',
  // Team tools, monitoring and research tools: sites whose pages say little ("Sprint 42 board", "Incidents", "Zotero").
  worktools: 'jira confluence atlassian linear asana notion slack trello sprint backlog kanban',
  observability: 'datadog pagerduty sentry grafana newrelic cloudwatch observability incident incidents alerting oncall tracing apm opsgenie splunk',
  research: 'overleaf zotero scholar semanticscholar mendeley latex bibtex citation citations bibliography thesis preprint addgene benchling neb gibson lipofectamine transfection crispr cas9 grna plasmid plasmids pcr qpcr blot deseq2 seurat bioconductor ggplot2 rstudio pubmed biorxiv genome genomics sequencing rnaseq bioinformatics',
  birding: 'birding birder birders birdwatching birdwatcher bird birds ebird audubon merlin binoculars swarovski ornithology warbler warblers',
  games: 'crossword crosswords wordle sudoku chess lichess puzzle puzzles minesweeper solitaire',
  // A trucker's errands (the phrases that say it beside these words are PHRASE_CONCEPTS: truck stops, weigh stations, load boards, I-80 road conditions).
  trucking: 'trucker truckers trucking truckstop truckstops cdl fmcsa drivewyze diesel freight flatbed reefer',
  // Design tools and portfolios, and fonts and type (a fonts page is design too): "Dribbble", "Behance", "Figma", "Canva", "Adobe Fonts", "kerning".
  design: 'dribbble behance figma canva photoshop illustrator indesign procreate wireframe wireframes mockup mockups pantone coolors font fonts typeface typefaces kerning typography myfonts',
  // Self-employment paperwork and tools: invoices, timers, contracts, gigs.
  // Parties and celebrations: the errands of a birthday, a wedding, a fundraiser.
  events: 'party parties birthday balloons invitations rsvp catering decorations wedding weddings bridal bridesmaid',
  freelance: 'freelance freelancer freelancers freelancing invoice invoices invoicing upwork fiverr freshbooks toggl',
  // A nurse's errands: exams and certifications (NCLEX, ACLS, BLS, PALS, CEUs), the charting and scheduling systems, the references, travel-nurse agencies.
  // (Phrases that say it beside these words are PHRASE_CONCEPTS and BRAND_PHRASES: travel nursing, shift differential, compression socks, Epic.)
  nursing: 'nursing nurse nurses enfermería enfermeria enfermera enfermero nclex acls bls pals ceu ceus kronos cerner medscape uptodate scrubs stethoscope nurseslabs',
  // A game developer's tools and craft: engines, pixel and audio tools, devlogs, the stores' developer pages.
  gamedev: 'lospec fmod wwise freesound gdc godot unreal aseprite sprite sprites devlog devlogs steamworks gamedev gamedeveloper playtest playtesting tilemap tilemaps cinemachine metroidvania unity3d shader shaders',
};
// Words that say a second concept besides the one they are listed under (tab-groups.js CONCEPTS_OF): buying a home is housing and a loan is finance.
const CONCEPT_ALSO = { mortgage: 'housing', mortgages: 'housing', pediatrician: 'baby', pediatricians: 'baby' };
// Phrases that say a concept where their words alone would not ("closing costs", "Western blot"), and the ones that must not be read as the words they
// are made of. [pattern, concept]; the concept is added to the tab as if one of its words were in the title.
const PHRASE_CONCEPTS = [
  [/\b(wake windows?|feeding schedules?|what to expect( when)?|baby (formula|monitors?|tracker)|infant formula|formula feeding|sleep regressions?|tummy time|(vaccine|immunization) schedules?|(new|first-?time) parents?|parental leave|birth announcements?|breast pumps?|bottle[- ]feeding|feed(ing)? logs?)\b/i, 'baby'],
  [/\b(hand planes?|(block|jack|smoothing|jointer|low[- ]angle) planes?|router tables?|wood glue|fine woodworking|table saw|band saw|pocket[- ]holes?|glue-?ups?|wood ?(finish|finishing|stain)|hand (cut|tools?)|sharpening (chisels?|stones?|plane)|lie-?nielsen)\b/i, 'woodworking'],
  [/\b(buyer'?s? (representation|agency) agreements?|listing agreements?|open houses?|mls (listings?|numbers?|search|data|id)|(home|house) staging|staging (a )?(home|house|listing)|(sales |market )?comps|comparable sales|zillow (premier )?agent|follow up boss|(negotiat\w+|agent|realtor|buyer'?s?|seller'?s?|listing) commissions?|nar settlement|real estate (agents?|license|continuing education|ce)|(home|house)s? (that )?sell|staging tips)\b/i, 'realestate'],
  [/\b(pre-?approval|closing costs?|down payments?|first-?time home ?buyers?|mortgage rates?|home ?owner(ship)?)\b/i, 'housing'],
  [/\b(social security|required minimum distributions?|rmd)\b/i, 'finance'],
  [/\b(western blots?|gibson assembly|prime editing|base editing|cell culture|flow cytometry|gel electrophoresis|protocols\.io)\b/i, 'research'],
  [/\b(spelling bee|nyt games|nyt connections|steam (deck|store|sale|library)|chess\.com)\b/i, 'games'],
  [/\b(\d{1,2}x\d{2}|vortex (diamondback|viper|razor))\b/i, 'birding'], // binocular sizes: "8x42"
  [/\b(truck stops?|weigh stations?|load boards?|trucker path|hours of service|flying j|love'?s travel( stops?| centers?)?|ta (travel )?centers?|petro stopping|dot (medical|physical|exam|number|inspection|compliance|regulations?)|i-\d{2,3}(?= (road|traffic|conditions|closures?|weather|construction)))\b/i, 'trucking'],
  [/\b(graphic design|logo ?design|ui design|ux design|web design|brand(ing)? (kit|identity|guidelines|projects?)|colou?r palettes?|design inspiration)\b/i, 'design'],
  [/\b(o que fazer|qu[eé] hacer|que faire|cosa vedere|where to (eat|stay))\b/i, 'travel'], // what to do in a city, in the languages the rest of the table covers
  [/\bboarding (pass|passes|gate)\b/i, 'travel'], // ("board" alone is a load board and a message board)
  [/\b(lesson plans?|unit plans?|curriculum( frameworks?)?|rubrics?)\b/i, 'education'],
  [/\b(study guides?|practice (exams?|tests?|problems?)|flash ?cards?)\b/i, 'education'],
  // A nurse's errands and a student athlete's: "practice", "shift" and "recovery" alone are ordinary words, the phrases are not.
  [/\b(shift differentials?|compression socks|nursing shoes|medical[- ]surgical|med[- ]surg|aya healthcare|amn healthcare|vivian (health|pay|jobs?)|epic (hyperspace|haiku|systems)|nurse\.org)\b/i, 'nursing'],
  [/\b(practice schedules?|film reviews?|game film|ice baths?|sports medicine|team portal|team travel|transfer portal|nil deals?)\b/i, 'sports'],
  [/\b(ice baths?|injury recovery|recovery (timeline|protocol)|sports nutrition|interval training)\b/i, 'fitness'],
  [/\b(pixel ?art|itch\.io|game ?dev(elop(er|ment))?|indie ?(game|dev)|game design|level design|unity (manual|discussions?|learn|[23]d|engine|hub|assets?|tutorials?|docs?|editor|scripting))\b/i, 'gamedev'],
];
// Brand and place names made of everyday words ("Hilton Garden Inn" is not gardening, "Home Depot" is not a home, "Best Buy" is not a best-of list). The
// phrase is taken out of the title before its words are read, so none of them counts as a topic word or names a group; the concept (if any) is what
// the brand is. [pattern, concept or ''].
const BRAND_PHRASES = [
  [/\b(hilton garden inn|garden inn|holiday inn( express)?|hampton inn|courtyard by marriott|residence inn|fairfield inn|comfort inn|sleep inn|best western|red roof inn|days inn|motel 6|la quinta|four seasons|super 8)\b/i, 'travel'],
  [/\b(olive garden|chick-?fil-?a|taco bell|burger king|panda express|pizza hut|texas roadhouse|red lobster|golden corral|blue bottle( coffee)?|dunkin'?( donuts)?|five guys|shake shack|in-?n-?out)\b/i, 'dining'],
  [/\b(whole foods( market)?|trader joe'?s|harris teeter|stop (&|and) shop|piggly wiggly)\b/i, 'cooking'],
  [/\b(home depot|best buy|bath (&|and) body works|ace hardware|bed bath (&|and) beyond|barnes (&|and) noble|dick'?s sporting goods|dollar (general|tree)|big lots|old navy|rite aid|victoria'?s secret|sports authority)\b/i, 'shopping'],
  [/\bplanet fitness\b/i, 'fitness'],
  [/\btravel nurs(e|es|ing)\b/i, 'jobs nursing'], // a travel nurse job is a job, not a trip
  [/\b(capitol hill|silicon valley|green bay|palm beach|long island|rhode island|salt lake)\b/i, ''],
];
// Pages whose address says what they are, whatever the site: [pattern on "host/path", category]. A news site's puzzle pages are games, not news.
const URL_CATEGORIES = [
  [/(^|\.)nytimes\.com\/(games|crosswords?|puzzles?|spelling-bee|wordle|connections|strands)\b/i, 'games'],
  [/(^|\.)linkedin\.com\/learning\b/i, 'education'], // LinkedIn Learning is a course site, not a social one
  [/(^|\.)(chess\.com|lichess\.org|sudoku\.com|steampowered\.com|steamcommunity\.com)\//i, 'games'],
];
// Capitalised words that are only ordinary words at the start of a title or in a Title Case one: they never count as a name (tab-groups.js tabWords,
// `distinct`). A shared name beside them ("ASGCT", "Medicare", "Lipofectamine") is a topic by itself.
const COMMON_CAPS = `about above across after again against almost along also always among another answer around article articles available back basic basics beautiful because become before behind being below best better between beyond black blue book books both build building business call came can cannot center centre change check choose classic clean clear close cloud color colour come coming common company complete compare control cool could country course create current daily dark data date days deal deals design details different direct does doing done down during each early easy either else email enjoy enter even event events ever every example examples explore family fast feature featured feel field file files final find fine first fish five fix food form found four free fresh friday friends from front full game games general get getting give global going gold good great green group grow guide guides hand happy hard have health help here high history home hour hours house how however human idea ideas image images important include inside instead into issue issues item items join just keep kind know large last late latest learn less let life light like line link list little live local long look looking lost love made main make making many market match material matter maybe mean media meet member message might mind model modern monday money month months more most move much music name national natural need needs never next nice night none north note notes nothing notice number offer office often once online only open option options order other outside over page pages paper part party past people perfect person personal phone photo photos picture piece place places plan plans play please plus point popular post power price prices private problem product products program project public quick quickly quote rate read ready real really recent recipe recipes record red related report research resource resources result results review reviews right room rules same saturday save school search season second section see seen select send series service services set several share shop short should show side sign simple since site size small social some something sometimes soon sorry south special start started state stay step still stop store story strategy street student students study style subject success such summer sunday support sure take team tech tell test text than thank thanks that their them then there these they thing things think this those though thought three through thursday time times tips today together tonight tool tools top topic total town track training travel tuesday turn under until update updates upon use used user users using value version video view visit want watch water ways wednesday week weekend weeks welcome well went were west what when where whether which while white whole whose why will wind winter with within without women wonder word words work working works world would write year years yesterday yet york young your`;

// Places a word stands for: airport codes, theme parks and landmarks name their city ("Flights to MCO" and "Disney World tickets" are an
// Orlando trip). [pattern, city]; the city is added to the tab as if its title said it.
const PLACE_ALIASES = [
  [/\b(mco|epcot|disney ?world|magic kingdom|universal orlando|universal studios florida|seaworld orlando)\b/i, 'orlando'],
  [/\b(nrt|hnd|shinjuku gyoen|senso-?ji)\b/i, 'tokyo'], [/\b(kix|itm|fushimi inari)\b/i, 'osaka'], [/\b(lhr|lgw|heathrow|gatwick)\b/i, 'london'],
  [/\b(cdg|ory|eiffel)\b/i, 'paris'], [/\b(fco|ciampino|colosseum)\b/i, 'rome'], [/\b(bcn|sagrada familia)\b/i, 'barcelona'], [/\b(lax|disneyland)\b/i, 'angeles'],
  [/\b(jfk|lga|ewr)\b/i, 'york'], [/\b(sfo|golden gate)\b/i, 'francisco'], [/\b(bos)\b/i, 'boston'], [/\b(las vegas strip|harry reid)\b/i, 'vegas'],
  [/\bDC\b/, 'washington'], [/\b(washington,? d\.?c\.?|national mall|smithsonian|lincoln memorial|reagan national|dca)\b/i, 'washington'],
  [/\b(chianti|siena|lucca|pisa|montepulciano)\b/i, 'tuscany'],
  // Regions of a country that a trip is to as one place: the third item says the region's towns are that place, not the country's ("Flights to
  // Naples" and "Hotels in Positano" are one Amalfi Coast trip, not an Italy one).
  [/\b(amalfi( coast)?|positano|sorrento|capri|ravello|naples|napoli)\b/i, 'amalfi coast', true],
  [/\b(lake como|lago di como|bellagio|varenna)\b/i, 'lake como', true],
  [/\b(swiss alps|zermatt|interlaken|grindelwald|jungfrau|matterhorn)\b/i, 'swiss alps', true],
  [/\b(napa( valley)?|sonoma)\b/i, 'napa valley', true],
  [/\b(hawaii|maui|oahu|kauai|honolulu|waikiki)\b/i, 'hawaii', true],
  [/\b(acadia( national park)?|mount desert( island)?|mdi|bar harbor|cadillac mountain|jordan pond|schoodic)\b/i, 'acadia', true],
];
// Hosts that are a place by themselves: [host suffix, city].
const SITE_PLACES = [['disneyworld.disney.go.com', 'orlando'], ['universalorlando.com', 'orlando'], ['seaworld.com', 'orlando']];
// Cities beyond PLACES (no country is added for them): a city word alone is no topic (tab-groups.js cosine), it only counts beside a
// travel or housing word.
const CITIES = 'boston cambridge somerville brooklyn manhattan queens nyc chicago seattle austin denver miami atlanta dallas houston portland philadelphia pittsburgh oakland diego vegas orlando nashville detroit baltimore minneapolis phoenix charlotte raleigh richmond tampa cleveland columbus cincinnati sacramento honolulu anchorage washington cheyenne casper laramie boise spokane tacoma eugene salem reno tucson albuquerque omaha tulsa wichita memphis louisville lexington knoxville chattanooga savannah charleston birmingham montgomery providence hartford albany rochester syracuse worcester springfield milwaukee indianapolis fargo bismarck billings missoula bozeman fairbanks juneau fresno bakersfield berkeley pasadena irvine boulder aspen provo ogden calgary edmonton winnipeg halifax leeds sheffield bristol cardiff belfast oxford nottingham leicester';

// Sites that are many things under one name (a portal): the name says nothing about a page ('Naver Maps' and 'Naver Sports' are not one topic).
// domain label -> the name in other scripts.
const PORTAL_BRANDS = { naver: '네이버', yahoo: 'ヤフー', rakuten: '楽天', kakao: '카카오', daum: '다음', baidu: '百度', coupang: '쿠팡', tistory: '티스토리' };

// Concepts whose tabs form a group of their own (tab-groups.js conceptGroups) when three or more loose tabs carry them and nothing
// else took those tabs: "Roth IRA", "Vanguard funds" and "401k rollover" share no word, but are one errand. concept -> group name.
// Only concepts that name one topic; "shopping" words turn up in tabs about anything, and the broad ones (programming, travel) are held to
// stricter terms (CONCEPT_LOOSE_ONLY). Cooking is left out: a window of a baker's and a meal-prepper's tabs is two topics.
const CONCEPT_GROUPS = { crypto: 'Crypto', finance: 'Finance', baby: 'Baby', woodworking: 'Woodworking', realestate: 'Real estate', jobs: 'Job search', tax: 'Taxes & legal', ecommerce: 'Store', dining: 'Cafes & restaurants', ml: 'Machine learning', fitness: 'Fitness', plants: 'Plants', baking: 'Baking', programming: 'Programming', devops: 'Cloud & DevOps', worktools: 'Work tools', observability: 'Observability', research: 'Research', health: 'Health', birding: 'Birding', games: 'Games', entertainment: 'Movies & books', travel: 'Travel', housing: 'Housing', sports: 'Sports', trucking: 'Trucking', design: 'Design', freelance: 'Freelance', events: 'Events', nursing: 'Nursing', gamedev: 'Game dev' };
// Concepts too broad to merge groups: they only draw LOOSE tabs together, from different sites, and want this many (the docs of every
// project are "programming": three of them beside a project's own tabs are that project's; two groups that formed on their own words are two projects).
const CONCEPT_LOOSE_ONLY = { programming: 4, travel: 4, devops: 3 };
// ...of which these may take several tabs of one site: a cloud console's pages (EC2, CloudWatch) are the topic, not one docs site's own group.
const CONCEPT_SAME_SITE_OK = { devops: true, observability: true, worktools: true };
// A concept group named for what most of its tabs are about when that is narrower ("Python" for a pandas, NumPy and Django window):
// concept -> [name, words]; the first name more than half the tabs carry a word of takes the group.
const CONCEPT_SUBNAMES = {
  programming: [
    ['Python', 'python pandas numpy scipy matplotlib seaborn jupyter django flask fastapi pytest pip pypi asyncio dataclasses'],
    ['JavaScript', 'javascript typescript react redux vue svelte angular nextjs node nodejs npm webpack vite electron'],
    ['CSS', 'css html flexbox'],
    ['Rust', 'rust cargo'],
    ['Go', 'golang goroutine goroutines'],
    ['SQL', 'sql postgres postgresql mysql sqlite mongodb redis'],
  ],
  design: [
    ['Fonts', 'font fonts typeface typefaces kerning typography myfonts'],
  ],
  research: [
    ['Lab & bioinformatics', 'addgene benchling neb gibson lipofectamine transfection crispr cas9 grna plasmid plasmids pcr qpcr blot deseq2 seurat bioconductor ggplot2 rstudio pubmed biorxiv genome genomics sequencing rnaseq bioinformatics'],
  ],
};
// Concepts whose site category is strong enough that two loose tabs make a group (tab-groups.js conceptGroups): two monitoring tools, or the
// tax office and the state comptroller, are one errand whatever their titles say.
const CONCEPT_PAIR_SITE = { observability: true, ecommerce: true, tax: true, housing: true, sports: true, trucking: true, design: true, nursing: true, gamedev: true };
// Words that say what KIND of page or errand a tab is, never what it is about ("Student visa", "Student accommodation" and "Part-time jobs for
// students" are three errands, not one topic; "Sales" is a column of a dashboard and a tax). They never link tabs and never name a group
// (tab-groups.js vectorize drops them from every tab's vector): a pair needs a word that says something, a concept, or a site.
const GENERIC_WORDS = `student students part parttime post posts calendar calendars sale sales business businesses application applications applicant apply plan plans
planning planner table tables guide guides tip tips near nearby buy schedule schedules template templates form forms order orders report reports data tool
tools service services info information center centre team rate rates price prices cost costs quote quotes ticket tickets support update updates class classes
work works working search account accounts manager management project projects notes note list lists checklist resource resources member members status
download downloads get getting open view portal booking bookings deal deals daily weekly monthly annual annually
renewal renewals online free new best top official page pages details detail summary overview setup login signin signup register registration`;

// Words that may still link two tabs (a job search is "job" this and "job" that) but are no evidence of a topic by themselves and never name a group.
const WEAK_WORDS = `job jobs offer offers dashboard start started request requests api january february april june july august september october november december`;
// Concepts whose tabs may JOIN such a group but never start one: the tax office beside a Roth IRA and a 401k is money, three pages of
// an agency are government ("Government" takes them, tab-groups.js FALLBACK_CATEGORIES).
// A concept whose own group (three or more tabs) keeps its tabs out of the broader one: crypto is not Finance once it has a group of its own.
const CONCEPT_EXCLUDES = { finance: ['crypto'] };
const CONCEPT_JOINS = { finance: ['tax'], realestate: ['housing'] };

// registrable domain (or full host) -> category. Same category names as CONCEPTS where they overlap.
const SITE_CATEGORIES = {
  travel: 'amtrak.com flixbus.com bahn.de thetrainline.com lner.co.uk nationalrail.co.uk ryanair.com easyjet.com jet2.com hostelworld.com visitscotland.com visitbritain.com skyscanner.net kayak.co.uk sncf-connect.com trenitalia.com renfe.com italotreno.it omio.com rome2rio.com disneyworld.disney.go.com universalorlando.com booking.com kayak.com tripadvisor.com tripadvisor.com.br tripadvisor.es tripadvisor.de tripadvisor.fr tripadvisor.it tripadvisor.co.uk airbnb.com expedia.com skyscanner.com lonelyplanet.com klook.com hotels.com vrbo.com agoda.com viator.com getyourguide.com nomadicmatt.com japan-guide.com travel.state.gov flights.google.com cntraveler.com hilton.com marriott.com hyatt.com ihg.com wyndhamhotels.com nps.gov si.edu recreation.gov reserveamerica.com',
  education: 'turnitin.com kahoot.com kahoot.it teacherspayteachers.com readwritethink.org edutopia.org udemy.com skillshare.com pluralsight.com codecademy.com datacamp.com masterclass.com canvas.northeastern.edu instructure.com blackboard.com zybooks.com khanacademy.org coursera.org edx.org chegg.com quizlet.com piazza.com gradescope.com brightspace.com coursehero.com ocw.mit.edu',
  shopping: 'amazon.com bestbuy.com walmart.com target.com ebay.com etsy.com newegg.com rtings.com wirecutter.com camelcamelcamel.com costco.com homedepot.com lowes.com',
  baking: 'kingarthurbaking.com bobsredmill.com theclevercarrot.com',
  cooking: 'seriouseats.com minimalistbaker.com allrecipes.com budgetbytes.com epicurious.com bonappetit.com instacart.com eatingwell.com foodnetwork.com cooking.nytimes.com',
  jobs: 'indeed.com glassdoor.com levels.fyi lever.co greenhouse.io ziprecruiter.com handshake.com zety.com leetcode.com hackerrank.com vivian.com ayahealthcare.com amnhealthcare.com',
  housing: 'zillow.com apartments.com redfin.com streeteasy.com trulia.com realtor.com rightmove.co.uk zoopla.co.uk spareroom.co.uk onthemarket.com unitestudents.com',
  dev: 'github.com gitlab.com dev.to',
  // Language and library docs, Q&A and package registries: programming itself, as opposed to a code host (a repo's pages are that project's).
  programming: 'stackoverflow.com stackexchange.com developer.mozilla.org npmjs.com pypi.org docs.python.org readthedocs.io nextjs.org typescriptlang.org react.dev electronjs.org nodejs.org rust-lang.org go.dev pkg.go.dev docs.rs numpy.org pandas.pydata.org matplotlib.org scipy.org djangoproject.com docs.djangoproject.com flask.palletsprojects.com realpython.com w3schools.com css-tricks.com',
  devops: 'kubernetes.io docs.docker.com hub.docker.com docker.com aws.amazon.com docs.aws.amazon.com terraform.io registry.terraform.io developer.hashicorp.com helm.sh nginx.org nginx.com docs.ansible.com ansible.com cloud.google.com azure.microsoft.com jenkins.io prometheus.io grafana.com',
  entertainment: 'imdb.com rottentomatoes.com letterboxd.com goodreads.com metacritic.com themoviedb.org',
  sports: 'espn.com sports.naver.com skysports.com theathletic.com basketball-reference.com nba.com nfl.com mlb.com cricbuzz.com espncricinfo.com iplt20.com bcci.tv ge.globo.com lance.com.br bundesliga.com kicker.de sportschau.de hudl.com ncaa.org teamworks.com coerver.com',
  finance: 'reuters.com bloomberg.com cnbc.com wsj.com marketwatch.com federalreserve.gov fidelity.com vanguard.com schwab.com robinhood.com etrade.com nerdwallet.com investopedia.com coinbase.com zerodha.com groww.in hdfcbank.com icicibank.com phonepe.com paytm.com upstox.com nubank.com.br itau.com.br bradesco.com.br xpi.com.br b3.com.br n26.com revolut.com monzo.com degiro.com trading212.com',
  tax: 'irs.gov qbo.intuit.com quickbooks.intuit.com turbotax.intuit.com hrblock.com legalzoom.com comptroller.texas.gov taxes.ny.gov ftb.ca.gov',
  ecommerce: 'shopify.com admin.shopify.com myshopify.com squareup.com square.site dashboard.stripe.com stripe.com usps.com cns.usps.com ups.com fedex.com shipstation.com pirateship.com ship.pirateship.com shippo.com sellercentral.amazon.com',
  ml: 'arxiv.org wandb.ai huggingface.co distill.pub 3blue1brown.com paperswithcode.com pytorch.org tensorflow.org kaggle.com fast.ai deeplearning.ai',
  fitness: 'strava.com runnersworld.com myfitnesspal.com bodybuilding.com garmin.com parkrun.com',
  worktools: 'atlassian.net atlassian.com jira.com linear.app asana.com notion.so notion.site slack.com app.slack.com trello.com monday.com clickup.com',
  observability: 'datadoghq.com datadoghq.eu pagerduty.com sentry.io grafana.com grafana.net newrelic.com one.newrelic.com splunk.com opsgenie.com honeycomb.io',
  research: 'overleaf.com zotero.org scholar.google.com semanticscholar.org mendeley.com arxiv.org researchgate.net jstor.org pubmed.ncbi.nlm.nih.gov dblp.org openreview.net paperswithcode.com addgene.org benchling.com neb.com biorxiv.org medrxiv.org bioconductor.org protocols.io posit.cloud rstudio.com thermofisher.com',
  birding: 'ebird.org audubon.org allaboutbirds.org merlin.allaboutbirds.org',
  games: 'chess.com lichess.org sudoku.com steampowered.com store.steampowered.com steamcommunity.com',
  plants: 'burpee.com gardeners.com almanac.com',
  trucking: 'truckerpath.com drivewyze.com fmcsa.dot.gov dat.com pilotflyingj.com loves.com tatravelcenters.com petrotruckstops.com truckstop.com',
  design: 'dribbble.com behance.net figma.com canva.com adobe.com fonts.adobe.com fonts.google.com myfonts.com fontshare.com dafont.com coolors.co pantone.com unsplash.com',
  freelance: 'upwork.com fiverr.com freshbooks.com toggl.com track.toggl.com and.co bonsai.co',
  nursing: 'nurseslabs.com nursingcenter.com nurse.org medscape.com uptodate.com ayahealthcare.com vivian.com amnhealthcare.com kronos.net nursing.uworld.com',
  baby: 'babylist.com whattoexpect.com huckleberrycare.com babycenter.com thebump.com',
  woodworking: 'rockler.com woodcraft.com finewoodworking.com woodmagazine.com lumberjocks.com popularwoodworking.com lie-nielsen.com benchcrafted.com woodworkerssource.com ana-white.com randomlengths.com',
  crypto: 'uniswap.org app.uniswap.org ledger.com etherscan.io defillama.com koinly.io coinbase.com kraken.com metamask.io coingecko.com coinmarketcap.com stake.lido.fi lido.fi messari.io farside.co.uk bankless.com',
  realestate: 'docusign.com docusign.net dotloop.com mlslistings.com followupboss.com app.followupboss.com inman.com homelight.com texasrealestate.com trec.texas.gov kapre.com',
  gamedev: 'lospec.com itch.io gamedeveloper.com freesound.org fmod.com audiokinetic.com godotengine.org unity.com unity3d.com docs.unity3d.com discussions.unity.com unrealengine.com aseprite.org gdcvault.com gdconf.com partner.steamgames.com howtomarketagame.com',
};
// Ordinary English words (beside COMMON_CAPS): tab-groups.js sharedEvidence never lets two of these alone link tabs.
const ORDINARY_WORDS = `practice shift shifts sheet sheets night nights study studies exam exams question questions answer answers trick idea thing story chapter lesson unit topic term result basic basics easy simple quick fast tutorial tutorials course class school college university work care health body home house family kids baby child children game play player coach season match weekend today tomorrow summer winter spring fall level levels table chart charts review reviews timeline video videos music song songs film films meal meals prep list lists bag bags gear kit kits pack packs shoe shoes sock socks`;
// Shops (and so the kind of page "Target: Back to school" is, whatever its title says): see tab-groups.js cosine.
const RETAIL_HOSTS = 'amazon.com ebay.com etsy.com bestbuy.com walmart.com target.com newegg.com costco.com homedepot.com lowes.com ikea.com macys.com nordstrom.com kohls.com wayfair.com oldnavy.gap.com gap.com walgreens.com cvs.com staples.com';
// SaaS hosts where every page of one registrable domain belongs to one workspace (acme.atlassian.net: Jira, Confluence ...): two loose tabs
// of one such domain are a group without sharing a word. domain -> name of the group.
const SAAS_DOMAINS = { 'atlassian.net': 'Atlassian', 'atlassian.com': 'Atlassian', 'slack.com': 'Slack', 'notion.so': 'Notion', 'linear.app': 'Linear', 'asana.com': 'Asana', 'trello.com': 'Trello', 'datadoghq.com': 'Datadog', 'pagerduty.com': 'PagerDuty', 'sentry.io': 'Sentry', 'grafana.net': 'Grafana', 'newrelic.com': 'New Relic', 'lightning.force.com': 'Salesforce', 'zendesk.com': 'Zendesk', 'myworkday.com': 'Workday', 'overleaf.com': 'Overleaf', 'monday.com': 'Monday', 'hubspot.com': 'HubSpot' };
// Hosts whose name is an organisation's single sign-on or mail, not a topic: sharing one says nothing about the pages (Outlook, a university's Canvas...).
// Hosts that belong to a kind of site whatever their domain: a suffix -> category (every AWS console page is cloud, whichever service it shows).
const SUFFIX_CATEGORIES = { devops: 'aws.amazon.com' };
const SSO_HOSTS = 'outlook.office.com outlook.live.com outlook.office365.com login.microsoftonline.com mail.google.com accounts.google.com';

// hint (a group name, as shown) -> sites that nearly always mean it. Loose tabs of one hint form a
// group named for it, and a loose tab of a hint joins the group most of whose tabs have that hint
// (tab-groups.js); a model organizing tabs is told the hint beside each tab (main.js, organize-ai.js).
// Only sites where the hint is right almost every time: Google Docs, Notion, YouTube or Reddit could
// be anything, so they have none. Three ways to write a site:
//   instructure.com     that domain and every subdomain (school.instructure.com)
//   canvas.*            a host whose first label is that ("canvas.northeastern.edu", self-hosted LMSs)
//   linkedin.com/jobs   only that path (and below it) on that domain: the rest of LinkedIn is not a job search
const SITE_HINTS = {
  School: 'instructure.com canvas.* blackboard.com blackboard.* moodle.* brightspace.com d2l.* gradescope.com piazza.com edstem.org zybooks.com quizlet.com chegg.com coursehero.com khanacademy.org coursera.org edx.org classroom.google.com turnitin.com kahoot.it kahoot.com teacherspayteachers.com schoology.com powerschool.com',
  'Job search': 'linkedin.com/jobs indeed.com greenhouse.io lever.co joinhandshake.com glassdoor.com ziprecruiter.com wellfound.com vivian.com ayahealthcare.com amnhealthcare.com',
  Code: 'github.com gitlab.com stackoverflow.com npmjs.com pypi.org developer.mozilla.org',
  Travel: 'airbnb.com booking.com expedia.com kayak.com skyscanner.com hotels.com vrbo.com google.com/travel flights.google.com',
  Shopping: 'amazon.com ebay.com etsy.com target.com',
};

// The hints a model may give a site the table above doesn't know ("Organize with AI" asks it about
// those hosts, features/organize-ai.js; the answers are kept in the profile, features/organize-learn.js).
// "none": the site is used for many things, or the model doesn't know it.
// Hosts under a hinted domain that are not that hint (AWS's docs live on amazon.com, which is a shop).
const HINT_EXCEPTIONS = 'aws.amazon.com docs.aws.amazon.com console.aws.amazon.com developer.amazon.com';

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
//   kind   the category is a KIND of site (mail, dev docs, video, news): its tabs are a group because of the site, with nothing else shared. The
//          others (a school, an agency, a trip) are topics: their tabs must also share a word or concept (tab-groups.js cohere)
//   join   the category is one topic, so its tabs may join a cluster of the same category (a trip, a course);
//          the others are kinds of site, which form their own group beside a topic's ("Dev docs" is not "Lumen")
// Host tests for what a list of domains can't say: a school is any .edu / .ac.xx / .edu.xx / k12 host, an agency any
// .gov / .mil / .gov.xx / .gouv.xx host. Kept apart: a tax office is no school.
const EDU_HOST = /\.(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$|(^|\.)k12\.|\.k12\.[a-z]{2}\.us$/;
// A state's education department (doe.mass.edu, dese.mo.gov, doe.virginia.gov: first label doe or dese, at least three labels; doe.gov is the Energy Department) and a school district (k12): school work.
const STATE_EDU_HOST = /^(doe|dese)\.[a-z0-9-]+\.[a-z.]+$|(^|\.)k12\./;
const SCHOOL_HOST = new RegExp(`${EDU_HOST.source}|${STATE_EDU_HOST.source}`);
const GOV_HOST = /\.(gov|mil)$|\.(gov|gouv)\.[a-z]{2}$|(^|\.)gov\.uk$/;
// Hosts under those suffixes that are not a school or an agency for the tab's purposes: a university's extension service answers gardening and home
// questions, a museum is a day out, a national park is a trip. They fall to their topic (a plants group, a trip) instead.
const NOT_SCHOOL_OR_GOV = /^extension\.|(^|\.)(smithsonian[a-z]*\.(org|edu|gov)|si\.edu|nps\.gov)$|(^|\.)(museum|museums)\./;
// What a title must carry, beside a deal word, to be about shopping: a price/buy/cart word, or something that is bought. "Best" and "deals" alone
// ("Best novels 2026") are not shopping.
const SHOP_TITLE = /\b(price|prices|pricing|buy|buying|cart|checkout|coupons?|discounts?|sale|shipping|laptops?|phones?|iphones?|headphones?|earbuds|airpods|monitors?|keyboards?|mouse|tvs?|televisions?|cameras?|tablets?|ipads?|speakers?|shoes|sneakers|chairs?|desks?|mattress(es)?|vacuums?|blenders?|watch(es)?|smartwatch|backpacks?|jackets?|appliances?|gadgets?)\b|通販|купить|скидк|할인|优惠/i;
// What an agency's pages are for: a Government group needs two tabs that say the same one (an agency's host alone never makes a group).
const GOV_SERVICE = /\b(dmv|licen[sc]es?|renewals?|tax(?:es)?|benefits?|passports?|permits?|medicare|medicaid|social security)\b/gi;
const MARKETPLACE_URL = /(^|\.)facebook\.com\/marketplace\b/i;
const FALLBACK_CATEGORIES = [
  { name: 'Mail & notes', kind: true, hosts: 'mail.google.com gmail.com calendar.google.com drive.google.com docs.google.com sheets.google.com slides.google.com keep.google.com outlook.live.com outlook.office.com outlook.office365.com mail.yahoo.com proton.me notion.so evernote.com todoist.com trello.com asana.com slack.com airtable.com mail.*', title: /\b(inbox|(?<!(?:district|academic|school|holiday) )calendar|to-?do|agenda)\b|受信トレイ|メール|почта|входящие|письм|받은편지함|收件箱/i },
  { name: 'Recipes', join: true, hosts: 'allrecipes.com seriouseats.com kingarthurbaking.com budgetbytes.com epicurious.com bonappetit.com foodnetwork.com cooking.nytimes.com eatingwell.com', title: /\b(recipes?|cookies?|bak(e|ing)(?! sale)|sourdough|dough|dinner ideas|meal prep|ingredients?)\b|レシピ|рецепт|레시피|食谱/i },
  // Self-paced courses (Udemy, Coursera, Khan Academy, LinkedIn Learning ...) are learning, not a school's work and not a social site's.
  { name: 'Learning', join: true, joinsAlso: 'School', hosts: 'udemy.com skillshare.com pluralsight.com codecademy.com datacamp.com masterclass.com coursera.org khanacademy.org edx.org', urlRe: /(^|\.)linkedin\.com\/learning\b/i, title: /\bonline courses?\b/i },
  { name: 'School', join: true, hosts: 'instructure.com canvas.* blackboard.com moodle.* brightspace.com gradescope.com piazza.com edstem.org zybooks.com quizlet.com chegg.com classroom.google.com schoology.com turnitin.com kahoot.it kahoot.com teacherspayteachers.com', hostRe: SCHOOL_HOST, title: /\b(lectures?|homework|syllabus|assignments?|exams?|midterm|calculus|linear algebra|matri(x|ces)|eigen\w*|theorems?|physics|chemistry|biology|statistics|cs ?\d{3,4})\b|講義|宿題|試験|授業|лекци|домашн|экзамен|семестр|강의|숙제|课程|作业/i },
  // Government: agencies are not schools. Hosts by suffix (hostRe) and a few by name; the title words are the ones that say it alone.
  { name: 'Government', hosts: 'europa.eu canada.ca gc.ca usa.gov', hostRe: GOV_HOST, service: GOV_SERVICE, title: /\b(tax returns?|dmv|passport renewal|social security|voter registration|driver'?s licen[sc]e)\b|確定申告|налог|госуслуги/i },
  { name: 'Dev docs', kind: true, hosts: 'aws.amazon.com cloud.google.com kubernetes.io docs.docker.com terraform.io developer.mozilla.org stackoverflow.com stackexchange.com github.com gitlab.com npmjs.com pypi.org dev.to react.dev reactjs.org electronjs.org nodejs.org typescriptlang.org python.org rust-lang.org go.dev docs.rs vuejs.org angular.dev nextjs.org tailwindcss.com devdocs.io w3schools.com docs.*', title: /\b(api reference|documentation|docs|handbook|sdk|stack overflow|javascript|typescript|node\.?js|pull request|commit)\b/i },
  { name: 'Travel', join: true, hosts: 'alltrails.com recreation.gov reserveamerica.com booking.com kayak.com tripadvisor.com tripadvisor.com.br tripadvisor.es tripadvisor.de tripadvisor.fr tripadvisor.it tripadvisor.co.uk airbnb.com expedia.com skyscanner.com hotels.com vrbo.com agoda.com lonelyplanet.com flights.google.com hilton.com marriott.com hyatt.com ihg.com nps.gov amtrak.com flixbus.com megabus.com greyhound.com disneyworld.disney.go.com universalorlando.com', title: /\b(flights?|hotels?|itinerary|airbnb|vacation|trip|things to do|visa|airport)\b|ホテル|観光|旅行|航空券|旅館|отел|авиабилет|путешеств|достопримечательн|호텔|여행|관광|酒店|旅游|景点/i },
  { name: 'Shopping', kind: true, join: true, urlRe: MARKETPLACE_URL, hosts: 'amazon.com ebay.com etsy.com bestbuy.com walmart.com target.com newegg.com rtings.com wirecutter.com costco.com homedepot.com lowes.com ikea.com', title: /\b(deals?|discount|coupon|price|buy|cart|best [\w ]{2,30}20\d\d)\b|口コミ|通販|купить|отзыв|скидк|후기|할인|优惠|评测/i },
  // Puzzles and games: a news site's games pages are these, not news.
  { name: 'Games', hosts: 'chess.com lichess.org sudoku.com steampowered.com store.steampowered.com steamcommunity.com', urlRe: URL_CATEGORIES[0][0], title: /\b(crosswords?|wordle|sudoku|spelling bee|chess)\b/i },
  { name: 'Video & music', kind: true, hosts: 'youtube.com youtu.be vimeo.com twitch.tv netflix.com hulu.com disneyplus.com spotify.com soundcloud.com music.apple.com', title: /\b(official video|trailer|playlist|lofi|podcast)\b|動画|予告編|клип|трейлер|плейлист|동영상|视频/i },
  { name: 'News & social', kind: true, weak: true, hosts: 'news.ycombinator.com reddit.com twitter.com x.com facebook.com instagram.com linkedin.com bsky.app threads.net nytimes.com washingtonpost.com bbc.com bbc.co.uk cnn.com theguardian.com reuters.com apnews.com theverge.com techcrunch.com arstechnica.com wired.com npr.org bloomberg.com weather.com news.google.com', title: /\b(breaking|headlines|news|weather forecast)\b|ニュース|天気予報|новости|прогноз погоды|뉴스|新闻|天气/i },
];

module.exports = { CONCEPT_EXCLUDES, ORDINARY_WORDS, STATE_EDU_HOST, CONCEPT_ALSO, PHRASE_CONCEPTS, BRAND_PHRASES, URL_CATEGORIES, COMMON_CAPS, NOT_SCHOOL_OR_GOV, GENERIC_WORDS, WEAK_WORDS, CONCEPT_PAIR_SITE, PORTAL_BRANDS, SUFFIX_CATEGORIES, PLACE_ALIASES, SITE_PLACES, CITIES, RETAIL_HOSTS, SAAS_DOMAINS, SSO_HOSTS, CONCEPT_SAME_SITE_OK, SHOP_TITLE, HINT_EXCEPTIONS, FALLBACK_CATEGORIES, EDU_HOST, GOV_HOST, PLACES, CONCEPTS, CONCEPT_GROUPS, CONCEPT_JOINS, CONCEPT_LOOSE_ONLY, CONCEPT_SUBNAMES, SITE_CATEGORIES, SITE_HINTS, AI_HINTS, BROAD_HINTS };
