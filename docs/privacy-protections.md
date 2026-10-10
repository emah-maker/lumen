# Privacy protections

What Lumen keeps websites from learning about you, beyond blocking ads and trackers. Every protection here is **on by default** and has its own switch in **Settings → Privacy and security** (`lumen://settings/privacy`). A change applies to pages loaded after it: reload a tab that was already open.

| Switch | Setting key | What a site can no longer do |
|---|---|---|
| Hide when you leave the tab | `hideTabActivity` | Tell that you switched tabs or apps, put the window in split screen, or moved the pointer off the page |
| Hide your window size | `hideWindowSize` | Tell a split-screen or small window from a full-screen one, or use your screen size to recognize you |
| Protect against fingerprinting | `fingerprintProtection` | Recognize your computer from site to site by how it draws pictures, renders 3D and processes sound |
| Hide your IP address from WebRTC | `webrtcIpProtection` | Read your local network address, or your real address behind a VPN that doesn't cover all traffic |
| Remove tracking from links | `stripTrackingParams` | Learn where you clicked a link (`utm_` tags, `fbclid`, `gclid`, share ids) |
| Block tracking pings | `blockTrackingPings` | Send background reports when you click a link or leave a page |
| Send Global Privacy Control | `sendGpc` | Claim you didn't opt out of the sale or sharing of your data |

The built-in ad and tracker blocker (uBlock Origin–compatible lists, including EasyPrivacy) still does most of the work. These protections cover what a block list can't.

## Hide when you leave the tab

Every page reads as the visible tab, in a focused window:

- `document.hidden` is `false`, `document.visibilityState` is `"visible"`, and `document.hasFocus()` is `true`.
- The events that report you leaving never reach the page: `visibilitychange`, the window's `blur` and `focus` (and the element `blur`/`focus` that come with them), and the pointer leaving the window (`mouseleave`/`mouseout` with nowhere it went). "Exit intent" pop-ups and proctoring scripts watch for that last one.

Side effects: a video or game that pauses when you switch away keeps playing, and a site that saves your work only when you leave the tab saves it at its other moments instead.

## Hide your window size

`screen.width`, `screen.height`, `screen.availWidth` and `screen.availHeight` match the window's outer size, and `screenX`, `screenY`, `screen.availLeft` and `screen.availTop` are 0, so the window always looks like it fills the screen. The page still sees the window's real size (`innerWidth`, resize events, CSS media queries), so layouts fit as usual.

## Protect against fingerprinting

Sites that can't use cookies draw a hidden picture or play a silent sound, then hash the result. The hash comes out slightly different on every computer, so it works like an ID. With this on:

- **Canvas** (`toDataURL`, `toBlob`, `getImageData`, also on `OffscreenCanvas`): the lowest bit of one color in up to 12 pixels changes. Blank canvases and fully transparent pixels are left alone, so "is this canvas empty?" checks still work. The page's own canvas is never changed: the export comes from a copy.
- **WebGL** (`readPixels`): the same small change.
- **Audio** (`AudioBuffer.getChannelData` and `copyFromChannel`, `AnalyserNode.getFloatFrequencyData`): a few samples move by about a millionth. The two buffer reads always agree with each other.
- **Battery:** if the Battery API is present, it reads as a desktop's (charging, full). Electron currently has no Battery API at all.

The change is the **same every time on one site**, so a site sees a stable result, and **different on every other site**, so the result can't follow you around. "The site" means the top page's domain, so a tracker loaded inside two different sites reads two different values. The values also change each time Lumen starts.

Bot checks (Cloudflare challenges, reCAPTCHA, hCaptcha, Arkose) get the real readings: a changed value there earns a harder puzzle or a block, and those checks don't follow you between sites with it. Google's sign-in pages are never touched.

Already absent in Lumen, and checked by a test: Chrome's Privacy Sandbox ad features (Topics, ad-auction interest groups, shared storage, attribution reporting).

## Hide your IP address from WebRTC

Pages can use WebRTC, the technology behind video calls, to collect your network addresses. With this on, every tab uses Chromium's `default_public_interface_only` policy: WebRTC offers only the public address of your default network route. Video calls still connect, through that route or a relay server.

## Remove tracking from links

When a page opens, Lumen takes tracking parameters off its address and loads the clean one instead, so the site never receives them:

- **Everywhere:** `utm_*`, `mtm_*`, `pk_campaign` and the like, `fbclid`, `gclid`, `gclsrc`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `yclid`, `ttclid`, `twclid`, `li_fat_id`, `igshid`, Mailchimp (`mc_cid`, `mc_eid`), HubSpot (`_hsenc`, `_hsmi`, `__hs*`), Marketo (`mkt_tok`), `srsltid` and a few more.
- **Only on their own sites:** share ids on YouTube (`si`, `pp`, `feature`), Spotify (`si`), Instagram, X/Twitter, TikTok, Amazon and LinkedIn.

The rest of the address is kept exactly as it was. Sign-in and payment pages (Google, Microsoft and Apple sign-in, PayPal, Stripe) are never changed, because their parameters are signed. This covers pages you open (top-level GET navigations), not requests a page makes afterwards. The full list is in `src/features/tracking-params.js`.

## Block tracking pings

`<a ping="…">` link auditing and `navigator.sendBeacon()` reports are cancelled. Sites use these to log clicks and page exits in the background. This needs the ad blocker on, because the ad blocker is what sees those requests.

## Send Global Privacy Control

Every request carries `Sec-GPC: 1`, and pages that check in script see `navigator.globalPrivacyControl === true`. In some places, such as California and Colorado, sites must treat this as an opt-out of the sale or sharing of your data.

## What these don't do

- **Third-party cookies** are still sent unless you turn on **Block third-party cookies**. That switch stays off by default because it can break sign-in inside other sites (for example "Sign in with Google").
- **Do Not Track** stays off. Most sites ignore it, and turning it on makes your browser a little more unusual.
- Sites still see your IP address, your time zone and language, and the fonts and graphics card your system reports. Use a VPN to hide your IP address.
- Pages you loaded before changing a switch keep the old behavior until you reload them.

## How it works (for developers)

- The page-side code is `install()` in `src/preload/activity-preload.js`. It reaches each page two ways: as a session `frame` preload, and as a DevTools document-start script (`Page.addScriptToEvaluateOnNewDocument`) added next to the Chrome-identity script in `applyChromeIdentity` (`src/main.js`). The second way is needed because session preloads don't run in cross-origin iframes. `src/features/hide-activity.js` passes the settings to both and replaces the DevTools script when a setting changes.
- Patched functions are registered with Lumen's shared `lumen.nativeTexts` toString wrapper, so they read as `[native code]`. Getters are replaced on the prototype, never added to the object itself.
- Links and pings are handled in the ad blocker's `onBeforeRequest` (`src/features/adblock.js`). WebRTC is `webrtcPolicy()` in `src/settings/settings-backend.js`.
- Tests: `test/hide-activity-units.js`, `test/hide-activity.js` and `test/tracking-links.js`.
