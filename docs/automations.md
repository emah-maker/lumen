# Automations

An automation repeats one job on a list of pages: "apply to these co-op postings", "fill in this sign-up form on each of these sites". Lumen opens each page in a tab of its own, fills the form from your saved profile, and stops at the Submit button so you can look before anything is sent.

Open it from the ⋯ menu (**AI and tasks → Automations**) or type `lumen://automations` in the address bar.

## Making one

- **Describe it.** Type what it should do, for example "Apply to new mechanical co-op postings on https://jobs.example.com/search that match “mechanical”, every weekday at 9am", and press **Make it**. Lumen drafts the automation: the pages (or a search page and the words a posting must have), a schedule if you named one, and any clicks needed to reach the form ("Apply now"). It only uses addresses you wrote; one a model makes up is dropped. Without a connected model, Lumen reads the addresses, the quoted words and the schedule from your sentence itself.
- **Record it.** Press **Record it**, do the job once in a tab, up to the Submit button (don't submit), then come back and press **Stop recording**. The clicks you made before the form become the automation's steps, the button you would have pressed becomes its Submit button, and what you typed is offered as answers for your profile. Passwords, one-time codes and card numbers are never recorded.
- **Start blank** and fill in the editor yourself.

The editor has:

| | |
|---|---|
| **Run it on** | **These pages** (one address per line) or **The links on a search page**: its address, the words a link must have, and how many new ones a run takes (up to 50). Links to other sites are left out. |
| **Skip pages already submitted** | On by default: a page the tracker has as submitted is not done again (tracking parameters like `utm_source` don't make it a new page). |
| **Steps to reach the form** | Clicks, waits and keys run on each page before the form is read. Most forms need none. |
| **Profile** | Which saved profile fills the forms. |
| **Project** | The project it belongs to, if any. |
| **Schedule** | Only when you run it, every day or every weekday at a time, or every few hours. |
| **Submit without asking when Lumen is in Bypass permissions** | Off by default. See below. |

## Your profile

**Profile** keeps what automations fill in: your name, email, phone, address, links (LinkedIn, GitHub, website), school, degree, major, graduation date, GPA, work authorization, sponsorship and start date; your résumé file and a cover letter file for file uploads; a cover letter text for text boxes, where `{{company}}`, `{{role}}`, `{{name}}` and `{{date}}` are filled in for each posting; and answers to common questions ("How did you hear about us?").

A form question gets an answer when its label asks for one of those boxes (its autocomplete hint counts too) or is close in wording to one of your saved questions. A list or a set of choices is answered only when one of its choices says your answer. Questions about gender, race, ethnicity, veteran or disability status, pronouns, date of birth, salary or criminal history are answered only from an answer you saved for that question. Password and payment fields are never filled.

You can keep up to 10 profiles. The résumé is only ever put into a page's file field: Lumen doesn't copy or change it.

## A run

**Run now** (or the schedule) starts a run. The pages are worked on one at a time, each in a background tab, in a tab group named after the automation. For each one:

1. The page opens and the automation's steps run. If the form is a job board's page inside the company's page (Greenhouse, Lever, Ashby, Workday…), that page is opened instead.
2. Lumen reads the form and fills in every field it has an answer for, the way typing would.
3. The item waits at **Ready to submit**, with a list of what was filled. **Submit** clicks the page's Submit button; **Open tab** shows the page so you can change something first; **Skip** leaves it.
4. After Submit, Lumen reads the page again. A thank-you or a new page is **Submitted**. Fields marked wrong or an error message bring the item back to **Needs you** with what the page said. If Lumen can't tell, it asks you to look.

An item **Needs you** when the page wants you to sign in, shows a CAPTCHA, has required questions your profile can't answer (they are listed), needs a file your profile doesn't have, or has no form or Submit button Lumen can find. Nothing is guessed. Do what it needs in its tab, then press **Continue** (Lumen reads the form again and fills what it can), **Mark as done** if you submitted it yourself, or **Skip**.

While items wait for you the run goes on with the next pages. It stops starting new ones while 10 wait, and goes on when you answer them. **Pause** holds the queue after the page being worked on; **Stop** ends the run and stops every page not done yet. **Try again** puts a failed, skipped or stopped page back in the queue while the run is going.

A page's tab closes when it is submitted or skipped, unless **Keep automation tabs open** is on (Settings → AI). A page that failed keeps its tab. Lumen sends a notification when a run starts waiting for you and when it finishes, if Lumen isn't the window in front.

### Submit without asking

With **Submit without asking when Lumen is in Bypass permissions** on, forms are submitted without stopping for review, but only while you have **Bypass permissions** picked in the sidebar (the permission mode Settings → AI describes). In Ask and Auto-allow the item still stops at Submit. Sign-ins, CAPTCHAs and unanswered questions wait for you in every mode.

### Schedules

A scheduled automation starts by itself at its times while Lumen is open. A time missed while Lumen was closed or the computer was asleep runs once, when Lumen next starts (about 20 seconds after). With a search page and **Skip pages already submitted**, a scheduled run only opens new postings.

## The tracker

**Tracker** lists every page an automation finished (up to 2,000): the date, company, role and status, with what was filled. **Export CSV** saves it as a spreadsheet file (Date, Automation, Company, Role, Status, Submitted, Address, Filled, Note). The company and role are read from the page's title and heading, best effort. **Clear** empties the tracker; exported files are kept.

## What is kept, and where

Automations, profiles, the last 20 runs and the tracker are kept in one file in Lumen's profile folder (`automations.json`), encrypted with your system keychain. If your system has no keychain it is plain JSON. Nothing is sent to Lumen's makers. A form's answers go only to the site whose form it is, when you press Submit (or, with Submit without asking in Bypass permissions, when the form is ready). When you use **Make it**, your sentence goes to the AI model you use, like a chat message. See [PRIVACY.md](../PRIVACY.md).

## Limits

- One page at a time per run, and one run per automation at a time.
- Forms in a page's own frames from another site are reached only for the job boards listed above.
- Multi-page application forms (Next, Next, Submit): fill the first page, then use **Open tab** and finish it yourself, or record the clicks that move between pages as steps.
