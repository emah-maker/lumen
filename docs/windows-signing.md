# Windows code signing with Azure Artifact Signing

Lumen's Windows builds are unsigned, so SmartScreen warns on the Setup exe and Smart App Control (SAC) can refuse it. This sets up Authenticode signing with **Azure Artifact Signing** (Microsoft's service, previously called *Trusted Signing*), which electron-builder supports directly through `win.azureSignOptions`.

It is opt-in by configuration, like [macOS signing](mac-signing.md). Until every value below exists, releases are built exactly as before (the untouched Electron `Lumen.exe`, no signing step). Nothing secret is stored in the repository; the workflow only references secrets by name and never prints one. Nothing in this repository creates or touches an Azure account.

## What only you can do

Azure account creation, **identity validation** (Microsoft checks a government ID for an individual, or business documents for an organization, and this can take days) and the role assignment all need you, signed in as yourself. They cannot be done for you or scripted from this repository. Plan for the identity validation to be the slow part.

## Steps in the Azure portal (one time)

1. **Azure subscription.** Sign in at portal.azure.com with an account that has (or can get) a subscription (a pay-as-you-go one is enough). Register the resource provider: Subscriptions, your subscription, Resource providers, search `Microsoft.CodeSigning`, Register.
2. **Create the signing account.** Search for **Artifact Signing Accounts** (shown as *Trusted Signing Accounts* in older portals), Create. Choose a resource group, a name (this is `AZURE_SIGNING_ACCOUNT`, 3 to 24 letters, digits and hyphens), a region and the **Basic** pricing tier. Note the region: it decides the endpoint in step 6.
3. **Identity validation.** In the account, Identity validations, New identity. Pick **Individual** or **Public Trust organization**, fill in the legal name (and, for an organization, the registered business details) and complete Microsoft's verification (it uses a third-party identity check for individuals). Wait until the status is **Completed**. The validated name becomes the certificate subject, and is your `AZURE_SIGNING_PUBLISHER`. Availability by country and entity type changes; the portal shows what is open to you.
4. **Create a certificate profile.** In the account, Certificate profiles, Create, type **Public Trust**, pick the completed identity validation. The profile name is `AZURE_SIGNING_PROFILE`.
5. **Create a service principal for GitHub.** Microsoft Entra ID, App registrations, New registration (any name, e.g. `lumen-release-signing`, single tenant). On its page note the **Application (client) ID** and **Directory (tenant) ID**. Then Certificates & secrets, New client secret, and copy the **value** immediately (it is shown once; pick an expiry you will remember to renew).
6. **Give it the signer role.** Open the signing account (or just the certificate profile), Access control (IAM), Add role assignment, role **Artifact Signing Certificate Profile Signer** (named *Trusted Signing Certificate Profile Signer* in older portals), assign to the app registration from step 5. Do not give it a broader role. Then copy the account's **Endpoint** from its Overview page (it looks like `https://eus.codesigning.azure.net`, one of `eus`, `wus`, `wus2`, `wus3`, `neu`, `weu`, depending on region).

## What to add in GitHub

Repository, Settings, Secrets and variables, Actions.

**Secrets** (New repository secret):

| Secret | Value |
|---|---|
| `AZURE_TENANT_ID` | Directory (tenant) ID from step 5 |
| `AZURE_CLIENT_ID` | Application (client) ID from step 5 |
| `AZURE_CLIENT_SECRET` | the client secret value from step 5 |

**Variables** (the Variables tab, New repository variable; these are not secret):

| Variable | Value |
|---|---|
| `AZURE_SIGNING_ENDPOINT` | the endpoint from step 6, `https://<region>.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | the signing account name (step 2) |
| `AZURE_SIGNING_PROFILE` | the certificate profile name (step 4) |
| `AZURE_SIGNING_PUBLISHER` | the validated subject name exactly as it appears on the certificate (step 3), e.g. `Jane Doe`; the workflow checks the signature against it |

All seven are needed. If only some are set, the build warns `Azure signing is only partly set up (missing: ...)` and stays unsigned.

## Test it before tagging a release

1. Actions, **Release**, Run workflow (branch `main`). A manual run only produces workflow artifacts; it never publishes a release.
2. In the Windows job, the log should say `Windows signing: Azure Artifact Signing` in the **Detect Windows signing** step, and **Verify Windows signature** should show `Valid` for `Lumen.exe`, the Setup exe and the `Lumen.exe` inside the zip (all with a timestamp and your publisher name).
3. Download the `lumen-win` artifact and check by hand: right-click the Setup exe, Properties, Digital Signatures; or in PowerShell `Get-AuthenticodeSignature .\Lumen-Setup-<version>.exe | Format-List`.
4. Then push a version tag as usual.

If signing was requested (all values present) and anything fails to sign, the build fails and nothing is published. If the values are absent, nothing changes and the verify step is skipped.

## What the build does

`scripts/signing.js` decides from the environment (`node scripts/signing.js --win` prints on/off, never a value). When on, `scripts/build.js` adds these electron-builder options for that build only:

- `win.azureSignOptions`: `endpoint`, `codeSigningAccountName`, `certificateProfileName`, `publisherName` from the variables above. electron-builder installs the `TrustedSigning` PowerShell module and calls `Invoke-TrustedSigning`; the module reads `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` from the environment. Signatures use SHA-256 and Microsoft's RFC 3161 timestamp server (`http://timestamp.acs.microsoft.com`), so they stay valid after the short-lived certificate expires.
- `win.signAndEditExecutable=true`: package.json keeps this `false` so the unsigned `Lumen.exe` is byte-identical to Electron's. When signing, electron-builder also applies Lumen's icon and version info to `Lumen.exe` and signs it, the Setup exe and the uninstaller.
- `forceCodeSigning=true`: a file that cannot be signed fails the build instead of shipping unsigned.
- **Widevine VMP signing moves after Authenticode** (`LUMEN_DEFER_VMP=1`): castlabs requires it in that order on Windows, and electron-builder signs after `scripts/after-pack.js`, so `scripts/after-sign.js` does it. It writes `.sig` files and does not modify the exe.
- The "Lumen.exe matches the stock Electron binary" check in `scripts/build.js` is skipped for a signed build (the signature is the point); the release workflow's **Verify Windows signature** step replaces it.

Local builds (`npm run dist`, `dist:win`) never have these values, so they are unchanged.

## What changes for users

- **SmartScreen.** Artifact Signing issues a public-trust certificate chained to Microsoft's own root, so Windows recognizes the publisher by name instead of showing "Unknown publisher". Microsoft states that this avoids the long reputation build-up that standard certificates need, but a brand-new publisher can still see a SmartScreen prompt on very early downloads; treat the first releases as the test.
- **Smart App Control.** SAC allows apps signed by a certificate from a Microsoft-trusted program. A signed Setup exe and `Lumen.exe` should no longer be blocked, which is the main reason to sign. Verify it on a machine with SAC on after the first signed release.
- **Installer and uninstaller** carry the same signature, so Windows shows the publisher name in the install and UAC prompts.

## What changes for the in-app updater

The updater design is unchanged (`src/features/updates.js`, `zip-update.js`, `swap-helper.js`):

- It downloads the release zip, checks its sha512 against `latest.yml`, and swaps whole folders. A copy of the **already signed** `Lumen.exe` runs the swap helper in Node mode (`ELECTRON_RUN_AS_NODE`). Copying a file byte for byte keeps its signature, so SAC and SmartScreen see the same trusted, signed binary as before: still no script host, no new executable, no installer run by Lumen.
- Signing happens during the build, before the zip is made, so the zip's `Lumen.exe` is the signed one (the workflow verifies this, including that the zip's exe has the same hash as the signed one in the unpacked folder).
- Updating from an unsigned version to the first signed one works the same as any update. The sha512 check remains the integrity check; the signature is additional protection for what Windows runs.
- `publisherName` is also written to the packaged `app-update.yml`. Lumen does not run installers through electron-updater, so it is not used to verify downloads, but keep `AZURE_SIGNING_PUBLISHER` equal to the certificate subject in case that ever changes.
- If you change the certificate (a different identity or publisher name), update `AZURE_SIGNING_PUBLISHER` at the same time.

## Cost

Pricing is per signing account per month and can change, so check the Azure pricing page for **Artifact Signing** before you start. At the time of writing, the **Basic** tier is about US$9.99 a month (up to 5,000 signatures) and **Premium** about US$99.99 a month (100,000 signatures); a Lumen release signs a handful of files. It is billed to your Azure subscription. Delete the signing account to stop charges.

## Renewing and rotating

- The client secret expires on the date you chose in step 5. Create a new one, replace the `AZURE_CLIENT_SECRET` secret, and delete the old one. A signing run with an expired secret fails the build (it does not fall back to unsigned).
- The certificate itself is short-lived and renewed by Azure automatically; nothing to do.
- To turn signing off, delete any one of the seven values (or the whole set): the next build is unsigned again.
