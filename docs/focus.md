# Focus mode

Focus mode is for a homework session. While it is on, the sites that pull you away (video, social and streaming sites by default) are blocked, and the tab shows a calm page with the time left instead. Nothing is blocked until you start it, and nothing about it leaves your computer.

## Starting it

- **The toolbar button** (a circle with a dot, left of the Downloads button): click it and pick how long (25 minutes, 45 minutes, 1 hour, 90 minutes, 2 hours or 3 hours).
- **In the chat**: type `focus for 90 minutes` (also `start focus mode for 2 hours`, `focus 45 min`, `focus for an hour`) and press Enter. The message starts focus mode and is not sent to the AI. The message has to be only that request: `focus on my essay for 2 hours` goes to the AI as usual.
- **`/focus`** in the message box: `/focus 90 minutes`, or `/focus` and Enter for 45 minutes.
- **Settings → General → Focus mode**: choose a length and press **Start**.
- **A schedule** (below).

While it is on, the toolbar button shows the time left (`1:12:03`). Click it for the time left, **Add 15 minutes** and **End focus…**.

## What happens to a blocked site

A page of a listed site (and its subdomains: `m.youtube.com` is `youtube.com`) is stopped before it loads, so the site never sees the visit. The tab shows the focus page: the site's name, the time left, and three things you can do.

- **Go back.**
- **I need this for school.** That one site opens for 10 minutes. It is a single use: when the 10 minutes are over, the site is blocked again (a tab still on it moves to the focus page), and you press the button again if you need more. Each use is noted in the focus log.
- **Hold to end focus.** Press and hold the button for 10 seconds. Letting go early starts over. Lumen counts the ten seconds itself, so the page can't skip the wait. Ending a schedule's window early keeps it off until that window is over.

Tabs already on a listed site when focus starts move to the focus page. The AI's own background reading tabs are not blocked, and private windows follow the same list.

## The list of sites

Settings → General → Focus mode → **Blocked sites**. The default list is `youtube.com`, `youtu.be`, `reddit.com`, `tiktok.com`, `instagram.com`, `x.com`, `twitter.com`, `facebook.com`, `twitch.tv` and `netflix.com`. Add a site by its name or paste an address (`https://www.example.com/page` becomes `example.com`); **Restore the default list** puts the defaults back. An empty list blocks nothing.

While focus mode is on, the list and the schedules can't be changed: editing them would be a way around the ten-second hold. Change them when it ends.

## Schedules

Settings → General → Focus mode → **Schedules**: focus mode starts by itself at the times you give and ends when they do, even if Lumen was closed in between (it starts when you open it, if the time is on). Type one in words, or pick the days and times:

- `weekdays 7-9 pm`, `weekends 10 am-12 pm`, `daily 19:00-21:00`
- `mon, wed and fri 4:30 pm-6 pm`, `every sunday 3-5 pm`

A missing am or pm is taken from the other end (`7-9 pm` is 7 to 9 in the evening, `11-1 pm` is 11 am to 1 pm); with neither, the clock is 24-hour. A window can cross midnight (`daily 10 pm to 1 am`). Each schedule has a switch. The times use the same calendar rules as [routines](routines.md), in your local time.

## The focus log

Settings → General → Focus mode → **Focus log** lists when focus mode started and ended (finished, or ended early after how many minutes) and each use of **I need this for school**, with the site's name (never the page's address). It is kept in `focus-log.json` in your profile, newest 200 entries, and is never sent anywhere.

## Where it lives

Settings: `focusSites` and `focusSchedules` (see the [Settings reference](settings.md)). A session that is running is kept in `focus-session.json` in your profile, so quitting Lumen doesn't end it; the file is removed when the session ends. The code is `src/features/focus.js`; the block page is `src/renderer/focus-block.html`. Pages are stopped in the same place Safe Browsing stops them (the main-frame check in `main.js`), so redirects and links count, not just typed addresses. Tests: `test/units/focus-units.js` (matching, schedules, phrases, the hold) and `test/e2e/focus.js` (a real window against local pages).
