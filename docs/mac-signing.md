# macOS signing and notarization

Lumen's Mac builds are ad-hoc signed (or signed with a self-made certificate), so macOS asks for **Open Anyway** on first launch. With an Apple Developer ID the release workflow signs, notarizes and staples the app instead, and Gatekeeper opens it with no prompt.

It is opt-in by secret. Without the secrets below, releases are built exactly as before. Nothing is ever stored in the repository; the workflow only references secrets by name.

## What you do (one time, about an hour plus Apple's approval)

1. **Enroll in the Apple Developer Program** (developer.apple.com/programs, US$99 a year). Note your **Team ID** (Membership details).
2. **Create a "Developer ID Application" certificate.** In Xcode: Settings, Accounts, Manage Certificates, +, Developer ID Application. Or at developer.apple.com, Certificates, Identifiers & Profiles, Certificates, +, Developer ID Application (needs a CSR from Keychain Access).
3. **Export it as a .p12.** In Keychain Access, My Certificates, right-click "Developer ID Application: ...", Export, format .p12, set a password.
4. **Base64 it** and copy the result: `base64 -i DeveloperID.p12 | pbcopy` (macOS), or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("DeveloperID.p12")) | Set-Clipboard` (PowerShell).
5. **Create an App Store Connect API key** (appstoreconnect.apple.com, Users and Access, Integrations, App Store Connect API, Team Keys, +, access **Developer**). Note the **Issuer ID** (top of the page) and the **Key ID**, and download the `AuthKey_<KeyID>.p8` file. Apple lets you download it once.
6. **Add GitHub secrets** (repository Settings, Secrets and variables, Actions, New repository secret):

   | Secret | Value |
   |---|---|
   | `CSC_LINK` | the base64 text of the .p12 (step 4) |
   | `CSC_KEY_PASSWORD` | the .p12 password |
   | `APPLE_API_KEY` | the **text** of the `.p8` file, including the BEGIN/END lines |
   | `APPLE_API_KEY_ID` | the Key ID |
   | `APPLE_API_ISSUER` | the Issuer ID |

   Both `CSC_LINK` and `CSC_KEY_PASSWORD` are needed to switch signing on; without the three `APPLE_API_*` secrets the app is signed but not notarized (the workflow warns, and Gatekeeper still blocks it).

   **Instead of the API key** you can use your Apple ID: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (appleid.apple.com, Sign-In and Security, App-Specific Passwords) and `APPLE_TEAM_ID`. If both sets exist, the API key is used.
7. **Optional, for Netflix, Disney+ and other production DRM:** create a free castlabs EVS account (`python -m pip install castlabs-evs`, then `python -m castlabs_evs.account signup`) and add `EVS_ACCOUNT_NAME` and `EVS_PASSWD`. This is separate from Apple signing and works with or without it.
8. Push a version tag (`v0.4.4`, matching package.json) or run the Release workflow by hand.

## What the build does

Order on macOS (`scripts/after-pack.js`, then electron-builder, configured by `scripts/signing.js`):

1. **Widevine VMP sign** (afterPack, only if EVS credentials exist). castlabs requires this **before** Apple codesign on macOS; the signature files then become part of the bundle Apple seals.
2. **Apple codesign** with the Developer ID certificate, hardened runtime on, entitlements from `build/entitlements.mac.plist` (main) and `build/entitlements.mac.inherit.plist` (helpers). Each entitlement is explained in the files.
3. **Notarize** (electron-builder's `@electron/notarize`, `notarytool`) and **staple** the ticket to the app.
4. `scripts/after-sign.js` does nothing for a Developer ID build (re-signing would void the notarization).
5. The zip and dmg are made from the stapled app.

Which path a build takes is decided by `scripts/signing.js`: `node scripts/signing.js` prints it from the environment without showing any value.

The first release signed this way asks once more for access to the "Lumen Safe Storage" Keychain item (the signing identity changed); after that the answer sticks across updates. In-app updates keep working: the update swaps whole bundles and never touches the signature, and a new bundle signed by the same team is accepted.

## Verify a release

The workflow already fails the build if the checks below fail (step "Verify Developer ID signature and notarization"). By hand, on a Mac, with the downloaded zip:

```
ditto -x -k Lumen-<version>-mac-arm64.zip /tmp/lumen-check
codesign --verify --deep --strict --verbose=2 /tmp/lumen-check/Lumen.app
codesign -dv --verbose=4 /tmp/lumen-check/Lumen.app 2>&1 | grep -E 'Authority|TeamIdentifier|flags'   # Developer ID Application, flags include runtime
xcrun stapler validate /tmp/lumen-check/Lumen.app                                                      # "The validate action worked!"
spctl -a -vvv -t exec /tmp/lumen-check/Lumen.app                                                       # "accepted, source=Notarized Developer ID"
```

For a real first-launch test, download the dmg in a browser (so it is quarantined), drag Lumen to Applications and open it: there should be no prompt beyond the standard "downloaded from the internet" confirmation.

## After the first notarized release

Done in 0.4.4: the Mac paragraph of README.md's Install section, the Mac note in `site/index.html` and `site/site.js` say no Open Anyway step is needed for 0.4.4 and later, and keep a short note for older versions. Because the signing identity changed, the first launch after updating from an earlier version asks once for Keychain access; the release notes say so.
