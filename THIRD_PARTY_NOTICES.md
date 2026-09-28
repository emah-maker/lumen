# Third-party notices

Lumen is licensed under the GNU General Public License v3.0 or later (see `LICENSE`). It ships with,
or downloads at runtime, the third-party software and data below. Each keeps its own license; the
full license texts are in the linked projects and, for npm packages, in each package's folder under
`resources/app/node_modules/` in the installed app.

## Runtime

| Component | License | Source |
|---|---|---|
| Electron for Content Security (castlabs build of Electron, with Widevine support) | MIT (Electron); Chromium's licenses are in `LICENSES.chromium.html` next to the app | https://github.com/castlabs/electron-releases |
| Widevine CDM | Proprietary (Google). Not bundled: Chromium's component updater downloads it on first use, under Google's terms | https://www.widevine.com |

## npm packages shipped in the app

| Package | License | Source |
|---|---|---|
| electron-chrome-extensions | GPL-3.0 | https://github.com/samuelmaddock/electron-browser-shell |
| electron-chrome-web-store | MIT | https://github.com/samuelmaddock/electron-browser-shell |
| @ghostery/adblocker, adblocker-electron, adblocker-electron-preload, adblocker-content, adblocker-extended-selectors, url-parser | MPL-2.0 | https://github.com/ghostery/adblocker |
| @remusao/guess-url-type, small, smaz, smaz-compress, smaz-decompress, trie | MPL-2.0 | https://github.com/remusao/mono |
| @anthropic-ai/sdk | MIT | https://github.com/anthropics/anthropic-sdk-typescript |
| electron-updater, builder-util-runtime (electron-builder's updater and its runtime) | MIT | https://github.com/electron-userland/electron-builder |
| openai | Apache-2.0 | https://github.com/openai/openai-node |
| tldts-experimental (includes data from the Public Suffix List, MPL-2.0) | MIT | https://github.com/remusao/tldts |
| @mozilla/readability 0.6.0 (Readability.js and Readability-readerable.js, copied unmodified into `vendor/readability/` with its license) | Apache-2.0 | https://github.com/mozilla/readability |
| Other transitive dependencies | MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Unlicense | run `npx license-checker --production` for the full list |

MPL-2.0 source for the packages above is available at the linked repositories; Lumen does not modify them.

## Data

| Data | License | Source |
|---|---|---|
| Ad and tracker filter lists (the Ghostery prebuilt "full" engine: EasyList, EasyPrivacy, uBlock Origin filters, Peter Lowe's list and others). Downloaded at runtime and cached in the user's profile, not bundled | Per list: EasyList and EasyPrivacy are dual GPL-3.0 / CC BY-SA 3.0; uBlock Origin filters are GPL-3.0; other lists carry their own terms | https://github.com/ghostery/adblocker, https://easylist.to, https://github.com/uBlockOrigin/uAssets |
| Top-level domain list in `tlds.js` | Published by IANA | https://data.iana.org/TLD/tlds-alpha-by-domain.txt |
