# Install and update Lumen

Every release on the [Releases page](https://github.com/emah-maker/lumen/releases) has the same set of files. You need one of them. The rest are for Lumen's own updater.

## Which file do I download?

| Your computer | Download | What it is |
|---|---|---|
| Windows 10 or 11 | `Lumen-Setup-<version>.exe` | The installer. Double-click it: no admin prompt, no wizard. It installs for you only and opens Lumen. |
| Windows, no installer wanted (or Smart App Control is on) | `Lumen-<version>-win-x64.zip` | The portable copy. Unzip it anywhere and run `Lumen.exe`. |
| Mac with Apple silicon (M1, M2, M3, M4 and later) | `Lumen-<version>-mac-arm64.dmg` | The disk image. Open it and drag Lumen onto Applications. |
| Mac with an Intel processor | `Lumen-<version>-mac-x64.dmg` | The same, built for Intel Macs. |

Not sure which Mac you have? Open the Apple menu → **About This Mac**. "Chip: Apple M…" means Apple silicon; "Processor: Intel" means Intel.

### The other files (you don't need these)

| File | What it is for |
|---|---|
| `Lumen-<version>-mac-arm64.zip`, `Lumen-<version>-mac-x64.zip` | The Mac app zipped. Lumen's updater downloads these. You can also unzip one and drag `Lumen.app` to Applications instead of using the disk image. |
| `latest.yml`, `latest-mac.yml` | The update manifests: the newest version and the SHA-512 hash of each download. Lumen reads them to find and check an update. |
| `*.blockmap` | A map of each download's blocks, so an update can fetch only the parts that changed. |

## Install on Windows

1. Download `Lumen-Setup-<version>.exe`.
2. Double-click it. Lumen installs into your user folder and opens.
3. If Windows says **"Windows protected your PC"**: choose **More info → Run anyway**. The Windows builds aren't code-signed, so SmartScreen doesn't know them yet.

**Smart App Control on?** It blocks the installer outright. Use the zip instead: unzip `Lumen-<version>-win-x64.zip` to a folder you keep (for example `Documents\Lumen`) and run `Lumen.exe`. Its `Lumen.exe` is the untouched Electron binary, which Windows recognises.

## Install on a Mac

1. Download the `.dmg` for your Mac (arm64 for Apple silicon, x64 for Intel).
2. Open it and drag **Lumen** onto **Applications**.
3. Open Lumen from Applications. It is signed with an Apple Developer ID and notarized, so it opens with no warning.

If you open Lumen straight from the disk image or Downloads, it offers to move itself to Applications.

Updating from a version before 0.4.4? macOS asks once, on the first launch, to let Lumen use its Keychain item.

## First launch

The sidebar opens on a short welcome: connect an AI, and bring your bookmarks and history from Chrome, Edge, Brave, Vivaldi, Opera or Firefox. Both can wait; **Start browsing** closes it. You can connect an AI any time from **Settings → AI and agents**.

## Updates

You only install Lumen once. After that it updates itself:

1. Shortly after it starts, and every few hours, Lumen checks the latest release.
2. It downloads the new version in the background ("Downloading Lumen v…") and checks it against the hash in `latest.yml` / `latest-mac.yml`.
3. The toolbar shows "Lumen v… is ready: installs when you quit" with **Restart to update**. Click it: Lumen restarts on the new version with your tabs. Your settings, chats and bookmarks are not touched. If you just quit instead, the update installs as Lumen closes (and Lumen is not reopened).

**Settings → Updates** shows the current version and has **Check for updates**. Turn off **Download updates automatically** there to be asked first.

A copy that can't replace itself (a per-machine install under Program Files, for example) shows **Lumen v… is available** with a **Download** button instead. Lumen 0.2.4 and earlier have no updater: download a newer version by hand once.

## If an update is interrupted

On Windows the update swaps the install folder (for example `Lumen`) for the new one in two quick steps. While it does, a small `Lumen.swap.journal` file sits next to the install folder, and it is deleted when the swap is done. If Windows ended the swap part-way (a logoff or shutdown right as you quit), the next time Lumen starts it reads that file and either finishes the update or puts the old version back, and Settings says so. You don't need to do anything.

If Lumen won't start at all and the install folder is gone, look in the folder that held it (by default `%LOCALAPPDATA%\Programs`):

- If `Lumen.update\files` holds `Lumen.exe`, rename that `files` folder to `Lumen` and move it next to `Lumen.update`. That is the new version.
- Otherwise rename `Lumen.old` to `Lumen`. That is the version you had.
- Delete `Lumen.swap.journal` afterwards. Your settings, chats and bookmarks live elsewhere and are never touched.

## Troubleshooting

- **Mac: "Lumen is damaged and can't be opened"** (older versions only). Run this in Terminal, then open Lumen again:

  ```
  xattr -dr com.apple.quarantine /Applications/Lumen.app
  ```

- **Mac, before 0.4.4: the first launch is blocked.** On macOS 15 Sequoia and later, open Lumen once, then go to **System Settings → Privacy & Security** and click **Open Anyway** next to Lumen. On older macOS, right-click Lumen in Applications and choose **Open**.
- **"Lumen is still closing from the last time you used it."** The previous Lumen hasn't finished quitting. Wait a few seconds and open it again. If it keeps happening, quit Lumen in Activity Monitor (Mac) or Task Manager (Windows).
- **The update doesn't show up.** Open **Settings → Updates** and press **Check for updates**; it says why if it can't update.
- **Something else?** [Report an issue](https://github.com/emah-maker/lumen/issues) with your Lumen version (Settings → Updates) and your OS.

Want to build Lumen yourself instead? See [Build from source](../README.md#build-from-source).
