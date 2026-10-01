# Windows code signing with SignPath

Lumen's Windows builds are unsigned, so SmartScreen warns and Smart App Control blocks the Setup exe. This sets up Authenticode signing through [SignPath](https://signpath.io), either with the free [SignPath Foundation](https://signpath.org) program for open source or with a SignPath subscription of your own.

It is opt-in by secret, like [macOS signing](mac-signing.md). Without the secrets below, releases are built exactly as before (one electron-builder pass, the untouched Electron `Lumen.exe`). Nothing secret is stored in the repository; the workflow only references secrets by name and never prints one.

Status: **not set up yet.** The workflow and tooling are in the repository; the steps under "What you do" need your accounts.

## What you do

### 1. Check eligibility (SignPath Foundation only)

SignPath Foundation's [conditions](https://signpath.org/terms) against Lumen today:

| Condition | Lumen |
|---|---|
| Public repository | Yes: github.com/emah-maker/lumen |
| OSI-approved license, no commercial dual licensing | GPL-3.0-or-later. `LICENSE` is now the unmodified GPL text, so GitHub detects it (it said "Other" while Lumen's own header sat above the license) |
| Already released in the form to be signed | Yes: v0.4.4 and earlier, unsigned |
| Maintained, functionality documented on the download page | Yes: README and the Releases page |
| Built from the repository in CI | Yes: `.github/workflows/release.yml` on a `v*` tag |
| A "Code signing policy" on the home page with the SignPath attribution, team roles and a privacy link | Added to the README as **pending**. Edit it if the roles change |
| Team roles: authors, reviewers, approvers | One person (emah-maker) holds all three. SignPath accepts that only if you say so in the application |
| Multi-factor authentication on GitHub and SignPath for every team member | **You:** turn it on for GitHub (Settings, Password and authentication) and, when the account exists, for SignPath |
| Verifiable reputation of the project for executables | **Risk.** Foundation approval is discretionary and the project is new. Expect questions about stars, history and users |
| "Sign your own binaries only" | **Risk.** `Lumen.exe` is castlabs' Electron build renamed. Foundation allows unsigned upstream binaries inside your package, but not signing them, unless your project visibly forks the upstream project. Say so in the application. If they refuse, set `SIGNPATH_SIGN_APP` to `false` (below): only the Setup exe is signed, which Foundation will accept, and the installed `Lumen.exe` stays the stock Electron binary Smart App Control already recognises |
| No proprietary components | The Widevine CDM is not in the repository or the installer: Chrome's component updater downloads it on the user's machine (PRIVACY.md says so). Mention it in the application |
| No features that exploit security vulnerabilities | Lumen is a browser with an AI agent and a CDP port that is off by default; explain it if asked |

To buy SignPath instead of applying: a paid SignPath subscription has no Foundation conditions, but you supply the code signing certificate (an OV or EV certificate from a public CA, with the key on SignPath's HSM or a hardware token SignPath supports). Everything below stays the same except that the release-signing policy uses your certificate and the metadata restrictions in the artifact configurations are optional. See signpath.io/pricing.

### 2. Apply to SignPath Foundation

Apply at **https://signpath.org/apply**. The form asks for the project's name, repository URL, download page, license, a description, and contacts; have these ready:

- Project: Lumen, https://github.com/emah-maker/lumen, releases at https://github.com/emah-maker/lumen/releases.
- License: GPL-3.0-or-later (`LICENSE`).
- Code signing policy page: the **Code signing policy** section of the README (anchor `#code-signing-policy`), with team roles and the privacy link (PRIVACY.md).
- Team: you, as author, reviewer and approver; MFA on.
- Build: GitHub Actions, `.github/workflows/release.yml`, public logs, Windows built on `windows-latest`.
- What is signed: `Lumen.exe` and `Lumen-Setup-<version>.exe`, nothing else.
- The upstream point from the table above (castlabs Electron, Widevine downloaded at runtime).

Approval arrives by email with a SignPath organization. Until then, nothing in the README claims signing; once approved, edit the README's status line.

### 3. Create the project in SignPath

1. Note the **Organization ID** (the GUID in the URL after `app.signpath.io/Web/`, also under Organization settings).
2. Install the **SignPath GitHub App** on `emah-maker/lumen` (the link is in the SignPath docs under [Trusted Build Systems, GitHub](https://docs.signpath.io/trusted-build-systems/github)). It lets SignPath read the workflow's audit log.
3. In the organization, open **Trusted Build Systems** and make sure **GitHub.com** is there; then create a **project** with slug `lumen` (any slug works; it goes in `SIGNPATH_PROJECT_SLUG`). Set the repository URL to `https://github.com/emah-maker/lumen` and link the GitHub.com trusted build system to the project.
4. **Artifact configurations:** add two, pasting the XML from this repository (SignPath does not read the files from the repository):
   - slug `lumen-app`: [`.signpath/artifact-configuration-app.xml`](../.signpath/artifact-configuration-app.xml)
   - slug `lumen-installer`: [`.signpath/artifact-configuration-installer.xml`](../.signpath/artifact-configuration-installer.xml)

   If you pick other slugs, set `SIGNPATH_APP_CONFIG_SLUG` / `SIGNPATH_INSTALLER_CONFIG_SLUG`.
5. **Signing policies:**
   - `test-signing` (create it first): the test certificate SignPath offers, no approval, trusted build system verification on. Its signatures verify as "untrusted root" on Windows; that is expected.
   - `release-signing` (after Foundation approval): the SignPath Foundation certificate, **approval process on** with you as approver, **trusted build system verification** and **origin verification** on (Foundation requires them). If you restrict allowed branch names, check that tag builds of `main` pass origin verification (see "Unverified").
   - Submitters of both policies: the CI user from the next step.
6. **CI user and token:** Users, add a **CI user** (for example `lumen-github`), give it the **Submitter** role on the project's two policies, and create its **API token**. Copy it once; it is the value of `SIGNPATH_API_TOKEN`.

### 4. Add the GitHub secrets and variables

Repository Settings, Secrets and variables, Actions.

| Kind | Name | Value | Needed |
|---|---|---|---|
| Secret | `SIGNPATH_API_TOKEN` | the CI user's API token | yes |
| Secret | `SIGNPATH_ORGANIZATION_ID` | the Organization ID | yes |
| Variable | `SIGNPATH_PROJECT_SLUG` | the project slug (`lumen`) | yes |
| Variable | `SIGNPATH_SIGNING_POLICY_SLUG` | `test-signing` or `release-signing` | no: a `v*` tag uses `release-signing`, a manual run `test-signing` |
| Variable | `SIGNPATH_APP_CONFIG_SLUG` | slug of the Lumen.exe configuration | no, default `lumen-app` |
| Variable | `SIGNPATH_INSTALLER_CONFIG_SLUG` | slug of the Setup exe configuration | no, default `lumen-installer` |
| Variable | `SIGNPATH_SIGN_APP` | `false` to sign only the Setup exe | no, default signs both |

All three required values must be set to switch signing on; a partial set is reported as a workflow warning and the build stays unsigned. Slugs may only contain letters, digits, `.`, `_` and `-`. The existing `EVS_ACCOUNT_NAME` / `EVS_PASSWD` secrets (Widevine VMP signing) keep working and are used after signing.

### 5. Run a test-signed build

1. Actions, **Release**, **Run workflow** on the branch you want (not a tag). With the secrets set, the policy defaults to `test-signing`.
2. The workflow pauses twice while SignPath processes a signing request (first `Lumen.exe`, then the Setup exe); a test policy without approval returns at once. The SignPath action prints a link to each request.
3. The step **Verify the Windows signatures** passes when both files carry a signature (status `UnknownError` with a signer is expected for test-signing).
4. Download the `lumen-win` artifact and check it yourself (below).

### 6. Release for real

1. Wait for Foundation approval and create `release-signing`.
2. Push the version tag (`v0.x.y`, matching package.json), or run the workflow with `SIGNPATH_SIGNING_POLICY_SLUG` set to `release-signing`.
3. **Approve both requests** in SignPath (one for `Lumen.exe`, one for the Setup exe; each emails the approvers). The workflow waits up to an hour for each.
4. The workflow verifies the signatures (status `Valid`, plus `signtool verify /pa /v`) before it publishes; the release then carries the signed Setup exe and zip.
5. Update the README's Windows notes (it says the builds are unsigned) and the status line of the Code signing policy.

## What the build does

Order in `.github/workflows/release.yml` for a signed Windows build:

1. `node scripts/build.js --win dir --signpath-app`: electron-builder packs `dist/win-unpacked` only. `Lumen.exe` keeps its icon and version info (ProductName `Lumen`, which SignPath's metadata restriction checks) and electron-builder does no signing of its own. `after-pack` removes `default_app.asar` and **skips Widevine VMP signing** (`LUMEN_DEFER_VMP=1`).
2. **SignPath request 1:** only `Lumen.exe` (about 246 MB) goes up, as a GitHub artifact of this run, with the `lumen-app` configuration; the signed file comes back and replaces it in `win-unpacked`. The other executables in the folder are Chromium's and Electron's and are not signed.
3. **Widevine VMP signing** (`node scripts/vmp-sign.js --require dist/win-unpacked`), now that `Lumen.exe` has its final bytes. castlabs: "On Windows the VMP-signing needs to take place AFTER the code-signing, or things will break." (On macOS it is the other way round, which is why `after-pack` still signs there.) Without the EVS secrets this step only warns.
4. `node scripts/build.js --win nsis zip --prepackaged dist/win-unpacked`: the installer and the zip are built from that signed directory, so the installed app and the update zip hold the signed, VMP-signed `Lumen.exe`. `after-pack` does not run in this pass.
5. **SignPath request 2:** the Setup exe, with the `lumen-installer` configuration.
6. `scripts/refresh-latest.js` recomputes `latest.yml` (sha512 and size of the Setup exe) and the Setup exe's `.blockmap` from the signed file, `scripts/add-zip-to-latest.js` lists the zip as before, and `refresh-latest.js --check` fails the build if anything disagrees. electron-builder had written both for the unsigned file.
7. Signatures are verified, then the usual artifacts are uploaded and the tag publishes them.

`SIGNPATH_SIGN_APP=false` skips steps 2 and 3: the stock Electron `Lumen.exe` stays (VMP-signed by `after-pack` as today) and only the Setup exe is signed, with one request.

Why not sign inside electron-builder (a custom `win.sign`): SignPath's trusted build system check needs the file to be an uploaded artifact of the same workflow run, which a hook running inside electron-builder cannot do, and it would mean one SignPath request per file.

### What stays unsigned

- **The uninstaller.** electron-builder builds it inside the NSIS build and embeds it in the Setup exe before any request can sign it. The Setup exe's signature covers it; the copy the installer writes to the install folder is not signed on its own. It is not downloaded, so it carries no mark of the web, and SmartScreen does not check it.
- Chromium's and Electron's DLLs and `vk_swiftshader` etc. in the app folder.
- The zip itself (zips are not signed); the `Lumen.exe` inside it is.

### Auto-update

Lumen's Windows updater downloads the release zip, checks its sha512 against `latest.yml`, and swaps the folder (`src/features/updates.js`, `zip-update.js`, `swap-helper.js`). The swap only renames folders and never touches a signature. The zip is built from the signed directory and listed in `latest.yml` after signing, so its hash is of the file that is published. Installed copies that cannot swap are sent to the Setup exe, whose `latest.yml` entry is also recomputed after signing. electron-updater is not given a `publisherName`, so it does not compare the update's signer.

## Verify a signed build

```powershell
Get-AuthenticodeSignature .\Lumen-Setup-0.4.5.exe | Format-List Status, SignerCertificate
signtool verify /pa /v .\Lumen-Setup-0.4.5.exe
```

Do the same for `Lumen.exe` from the zip. Release signatures show `Valid`, with the signer `SignPath Foundation`. In Explorer, Properties, Digital Signatures shows the same. `Lumen.exe.sig` next to it is the Widevine VMP signature; the castlabs [VMP lab](https://castlabs.github.io/wv-vmp-lab/) reports `PLATFORM_*_VERIFIED` when it is intact.

The point is that Smart App Control no longer blocks the Setup exe, and SmartScreen builds reputation for the SignPath Foundation signature (it can still warn for the first downloads of a new certificate's files).

## Unverified until SignPath is set up

Everything up to the SignPath requests was run locally (the two electron-builder passes, version info, the update info refresh and the unit tests). These need a real SignPath organization:

- That SignPath accepts a ~246 MB upload and the artifact configurations as written (the metadata restriction compares `ProductName` and `ProductVersion` to what electron-builder wrote: `Lumen` and `0.4.4.0` for the exe, `0.4.4` for the installer; the workflow passes the value it read from the file).
- That origin verification passes for tag builds on `release-signing`, and what allowed branch names should be.
- That castlabs VMP signing and the VMP lab accept the Authenticode-signed `Lumen.exe` (castlabs documents the order; it was not exercised with a SignPath-signed binary).
- That Smart App Control and SmartScreen accept the SignPath Foundation signature on the exe and the Setup exe.
- Foundation's decision on signing `Lumen.exe`, a renamed upstream binary.
