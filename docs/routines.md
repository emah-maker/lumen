# Routines

A routine is a request the AI repeats on a schedule: "every weekday at 8:00, give me a news brief", "every day, tell me what changed on this page", "on Mondays, summarize what's new on this site". It runs in the background like any [background task](architecture.md), and its result comes back as a notification and in the routine's run history.

## Making one

- **Tasks panel → Routines → New routine.** Give it a name, say what it should do, optionally a start page, and pick when it runs. The editor shows the next three run times as you change the schedule. Three templates (Morning news brief, Check a page for changes, Weekly summary of a site) fill the form for you.
- **`/routine` in the message box.** Type `/routine every weekday at 8am: summarize the news` and press Enter: the editor opens with the schedule and the request filled in. Understood in front of the request: `every day at 9`, `daily at 9:30pm`, `every weekday at 7am`, `every monday and friday 7:15`, `weekly`, `every 4 hours`, `every hour`, `every morning`.
- **Settings → AI and agents → Routines** lists every routine with a switch, its schedule, next and last run and a run history, and has **New routine** and one-click templates (Morning email check, Canvas: what's due today, Daily news brief, Weekly calendar preview). A template is added switched off, and says whether the app it needs is connected. **Quiet hours** there keep routines from starting overnight: a routine due then waits and runs once when they end, marked as ran late. Edit opens the editor in the sidebar.
- **On the full-page chat (`lumen://chat`)** the same three ways work with a compact **Schedule this** dialog (name, request, and when in words, with the next runs shown): the clock button beside Copy, `/routine`, and a **Make this a routine?** offer above the message box while you type a message that starts with a schedule. The routine is saved switched on; edit it in the sidebar or Settings.
- **Save as routine** (the clock button beside Copy on a reply) turns the request that led to that reply into a routine.
- **Repeat on a schedule instead…** in the "Run in the background?" card does the same for a background task.

Schedules: **Once** (a date and time), **Every day**, **Weekdays**, **On chosen days** (any days of the week), **Every few hours** (1 to 24, counted from when you saved it), or **Advanced (cron)**: five fields, `minute hour day month weekday`, with `*`, lists, ranges and `/steps` (`30 8 * * 1-5` is 8:30 on weekdays). A routine runs at most every 5 minutes.

Times are in your computer's time zone and follow daylight saving: 8:00 stays 8:00 in summer and winter. A time that doesn't exist on the day clocks spring forward (2:30) runs when the clocks reach it (3:30); a time that happens twice when they fall back runs once.

## When it runs

- **Only while Lumen is running.** On a Mac, closing the window keeps Lumen running if *Keep Lumen running when its window is closed* is on (Settings → General → Behavior, on by default).
- **Missed runs run once.** If Lumen was closed or the computer asleep at a routine's time, it runs once when Lumen starts or the computer wakes, however many times were missed. Its history says "ran late" and when it was due. Turning a routine back on, or changing its schedule, does not run the times before.
- **Quiet hours.** In the Routines tab (and Settings → Routines) you can set a daily window, for example 22:00 to 07:00, in which no routine starts on its own. A run due then waits and runs once when the window ends, marked "ran late". Run now ignores quiet hours.
- **Time zones and daylight saving.** Times are wall-clock in the computer's time zone, so 8:00 stays 8:00 when clocks change or you travel; "every N hours" counts real hours.
- **Approvals still apply.** A scheduled run never sends, posts, buys or deletes silently: those steps, and sites outside the routine's list, pause the run and ask (a notification says so, and the home card and Settings show "Needs your OK").
- **Templates are off until you turn them on.** One click adds Morning email check (Gmail), Canvas: what's due today (Canvas), Daily news brief and Weekly calendar preview (Google Calendar). The connector ones read the services you connected in Settings → AI and agents → Connectors (read only, no passwords); without the connector the routine says how to connect it.
- **Never two at once.** If a routine's time comes while its previous run is still going (or still waiting for a free slot), that time is skipped and the history says so.
- **The concurrency cap applies.** A due routine waits in line with the other background tasks (Tasks → Settings → Tasks at the same time, and one at a time in Performance mode).
- **Offline, it waits.** A routine that comes due without a connection starts when the connection is back.
- Turning off background tasks (Tasks → Settings) stops routines too.

Under the hood there is one timer for all routines, set for the earliest next run (and never longer than an hour, so a changed clock is noticed). Nothing polls while Lumen is idle.

## Results

When a run finishes, Lumen shows a banner in the sidebar, or a system notification if Lumen isn't the window in front (Tasks → Settings has the switches). Clicking it opens the routine: its latest result, the pages it visited, its steps and its **run history**, the last 20 runs with their results (each kept up to 6,000 characters). Routines are listed with the background tasks too. A failed run says why, in the notification and in the history.

## Safety

A scheduled run has exactly the power of a background task, no more:

- It works in its own hidden tab, never in your tabs, and never in a private window. Private windows can't create, see or change routines.
- It may use the sites it lists (from its request, its start page and what you typed) without asking. Any other site, and any purchase, message, post or form submission, asks every time: the run pauses, the notification says it needs your OK, and the card waits in the Tasks panel. A card nobody answers is refused after the time set in Tasks → Settings.
- Sites where you turned AI off stay off: a routine whose start page is one of them fails without loading it.
- Without *Use my sign-ins*, it browses without your cookies.
- Routines are stored with the background tasks, encrypted with the system keychain.

The code: `src/features/routines.js` (schedules, next-run math, the scheduler's plan, history), `src/features/background-runner.js` (the timer and runs), `src/renderer/routines.js` (the Routines tab, editor, `/routine`). Tests: `test/routines-units.js` and `test/routines.js`.
