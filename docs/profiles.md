# Profiles

A profile is a separate Lumen: its own cookies and sign-ins, history, bookmarks, saved passwords, chats and projects, settings,
API keys and extensions. Use one for work and one for home, or one per client, and nothing from one shows up in the other.

## Using profiles

- **Open the profile menu**: ⋯ menu → **Profiles**, or the round profile button at the right of the toolbar (it shows once
  you have more than one profile). The menu lists every profile with its colour and avatar; the one this window belongs to
  has a check.
- **Switch**: pick a profile. It opens in its own window (if it is already open, that window comes to the front). Windows of
  different profiles can be open side by side.
- **Add profile…**: give it a name, a colour and an avatar. It opens in a new window, empty, with Lumen's first-run setup.
- **Edit this profile…**: change the name, colour or avatar of the profile this window belongs to.
- **Delete profile…**: pick a profile other than this window's one; Lumen asks you to confirm, then moves its folder to the
  Recycle Bin (Trash on macOS). Close that profile's windows first. The Default profile can't be deleted.

The data you had before profiles is the **Default** profile. It stays exactly where it was: Lumen doesn't move, copy or rewrite
its folder. You can rename it and give it a colour and an avatar like any other profile.

## What is and isn't separate

Everything Lumen keeps in its profile folder is separate per profile: cookies and site data, history, bookmarks, the reading
list, passwords and passkeys, chats, projects and their memory, settings, API keys, connected accounts, extensions, downloads
list, open tabs and windows.

These belong to your computer, not to a profile, so every profile shares them: the sign-ins of command-line AI tools
(Claude Code, Codex, Grok Build, Antigravity) and their own settings, the folders you open in Files, and Lumen's updates.
Outside apps that connect to Lumen (`Lumen --mcp`) talk to the Default profile.

## How it works

Each profile runs as its own Lumen process with its own Electron `userData` folder. That is the same boundary that keeps a
test run away from your real data (`src/features/profile-guard.js`), so every store that reads `app.getPath('userData')`
(and there are dozens: settings, chats, history, the keychain-encrypted secrets, Chromium's own cookie and storage databases,
extensions) is separate without any store knowing about profiles. Electron's single-instance lock and Lumen's instance pipe
are keyed on `userData` too, so each profile has its own "one running copy", and opening a profile that is already running
just brings its window forward.

- **Where profiles live**: the Default profile is the folder Lumen always used (`%APPDATA%\Lumen` on Windows). Other
  profiles are folders inside a sibling folder, `%APPDATA%\Lumen Profiles\<id>`, next to it, never inside it. The list of
  profiles (name, colour, avatar, folder) is `Lumen Profiles\profiles.json`. Nothing is written into the Default folder.
- **Starting a profile**: `Lumen --lumen-profile=<id>`. `src/features/profiles.js` reads the switch first thing in
  `main.js`, right after `profile-guard`, and points `userData` at that profile's folder before anything reads it. An id
  that isn't in the list (a deleted profile) starts the Default profile. Restarts (`app.relaunch`, updates, the automation
  launcher) keep the switch, so a profile stays a profile across a restart.
- **Test and development runs** get the same layout around their own throwaway folder (`<test profile> Profiles`), and
  `profile-guard` treats `Lumen Profiles` as part of the real profile, so a test can never point at it.
- **Deleting** checks that the profile isn't running (its Chromium lock file is held), then moves the folder to the
  Recycle Bin, so a mistaken delete can be undone from there.

### Why one process per profile, not one session partition per profile

Electron can give each window its own `session.fromPartition('persist:<profile>')`, which is how account tabs and private
windows work. That covers cookies and site storage only. Everything else Lumen keeps (settings, chats, history, passwords,
API keys, extensions, the encrypted secret box) is a file under `userData` read through `app.getPath('userData')` or
`session.defaultSession` in well over a hundred places. Partitioning would mean threading a profile through each of them, and
one missed store leaks data between profiles. A process per profile gets complete separation from one switch, and a crash
in one profile doesn't take down the others.

The cost is memory: each open profile is a full browser process tree, like Chrome's profiles in separate windows.

## Tests

`test/e2e/profiles.js` (hidden windows, temp folders) makes a second profile, runs both, and checks that cookies, history and
chats in one never show up in the other, that the Default profile's folder is untouched by the other profile, that a
deleted profile's folder goes and a bad `--lumen-profile` falls back to Default. `test/units/profiles-units.js` covers the
list file, the switch and the folder rules.
