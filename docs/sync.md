# Sync through a folder

Lumen has no sync server and no account. If you use Lumen on more than one computer, **Sync through a folder** keeps your bookmarks, history, chats, home page widgets and settings the same on all of them. You choose a folder that your own cloud drive already syncs (OneDrive, Dropbox, Google Drive, iCloud Drive or any other); Lumen keeps its data in step through files in that folder. Nothing leaves your computer except into that folder, and everything in it is encrypted with a passphrase only you know, because a cloud drive is someone else's storage.

It is **off by default**. While it is off, Lumen doesn't even load the code for it.

## Set it up

1. On the first computer, open **Settings → General → Sync** and press **Set up…**.
2. **Choose folder…** and pick a folder your cloud drive syncs, for example `OneDrive\Lumen` or `Dropbox\Apps`. Lumen makes a folder called **Lumen Sync** inside it.
3. Type a **sync passphrase** (at least 8 characters; a few words work well). Choose what to sync. Press **Turn on sync**.
4. On each other computer, wait until the cloud drive has brought the folder over, then do the same with **the same passphrase**. A wrong passphrase is refused and nothing changes.

The passphrase is kept on each computer only, encrypted with the system's secure storage (the Keychain on macOS, data protection on Windows). It is never in `settings.json`, never in the folder, and never sent anywhere. **Lumen can't recover it.** If you forget it, turn sync off, delete the **Lumen Sync** folder, and set it up again. Without secure storage on the computer, sync can't be turned on.

## What syncs

| Data | What travels | Notes |
|---|---|---|
| Bookmarks | Each bookmark's address, title and folder | New ones are added at the end of the list; the order isn't synced. |
| History | Address, title, visit count and last visit | The 5,000 most recent pages. When two computers saw the same page, the later visit and the larger count win. |
| Chats | Each saved chat: its messages, title if you renamed it, pin, archive and dates | A chat that is open or running on a computer waits until you leave it. A chat over 24 MB stays out. Deleting a chat on one computer moves it to the deleted chats (the usual undo time) on the others. Projects aren't synced. |
| Home page widgets | Which cards are on the new tab page and where, their sizes and saved weather places | Anything in a card that looks like a sign-in, key or token never goes into the folder, and a card's own on this computer is kept. |
| Settings | Look and feel and everyday choices: theme, accent color, new-tab look, search engine, zoom, font size, spelling and language, ad block, privacy switches, "custom instructions" for the AI | A short fixed list (`SETTING_KEYS` in `src/features/sync-providers.js`). **Never** API keys, sign-ins, folders and paths, ports, the proxy, or anything about what the AI or other apps may do. |
| Saved passwords | Site, username and password | Only with **Also sync saved passwords**, which is off by default and needs Save passwords on. See below. |

Each kind has its own switch under **Sync is on**. Turn a kind off and this computer stops sending and receiving it; turn it on again and it catches up.

### Saved passwords

Passwords go into the folder only inside the same passphrase-encrypted files as everything else, and only if you turn on **Also sync saved passwords** (it is off, and can't be turned on while Save passwords is off). Anyone who has both your passphrase and your cloud drive could read them, so use a strong passphrase if you turn this on. A password changed on one computer replaces the one on the others; a login removed on one is removed on the others.

## How it works

- **A file per computer.** Each computer writes only its own files in `Lumen Sync/data/`, named `<kind>.<computer id>.lsync` (each chat is its own file). A cloud drive never has two computers writing one file, so you never get "conflicted copy" files. `Lumen Sync/sync.json` holds the format, the key-derivation salt and a check value that tells a wrong passphrase; `devices/` has one small encrypted file per computer (its name and when it last synced).
- **Encrypted.** Each file is compressed, then encrypted with AES-256-GCM using a key made from your passphrase with scrypt. The file's own name is bound into the encryption, so a file copied under another name is refused. The cloud drive and anyone who sees the folder learn only file names, sizes and times.
- **Last writer wins, per record.** A record is one bookmark, one chat, one setting, one widget card, one page in history. Every change is stamped with the time and the computer's id; the newest stamp wins on every computer, so they all end up the same. A deletion is a **tombstone** (a record that says "removed at this time"), so a deleted bookmark doesn't come back from a computer that still has it. If you add something again after deleting it, the newer record wins.
- **A new computer takes the folder's version.** When a computer joins a folder that already has data, anything that is only on it is added, and where both have a different version of the same thing, the folder's version wins.
- **When it runs.** A first pass a few seconds after Lumen starts (once the window is up), a pass a few seconds after something changes on this computer (30 seconds for history, which changes with every page), a pass shortly after a file in the folder changes (Lumen watches the folder; on Windows it looks at the file list every ten seconds instead, because a watched folder can't be renamed or moved), and one every five minutes as a safety net. **Sync now** runs a pass at once.
- **Quiet when nothing changed.** A pass that finds nothing new writes nothing.

## Things that go wrong, and what Lumen does

- **The folder isn't there** (the drive isn't running, the folder moved): Sync says so under **Sync is on**, and Lumen keeps working. It tries again by itself, and works again when the folder is back.
- **A file is damaged, cut short (a cloud drive still copying it) or made with another passphrase:** Lumen skips that file, counts it ("1 file couldn't be read") and syncs the rest. It reads the file again once it changes.
- **A file from a newer Lumen:** skipped until you update.
- **A store can't be read right now** (saved passwords or chats locked, history still loading): that kind is skipped for the pass. Lumen never turns "couldn't read it" into "everything was deleted".
- **Many chats or passwords vanish at once:** an automatic pass doesn't copy those deletions; it says so, and pressing **Sync now** takes it as meant.
- **Clocks:** the newest stamp wins, so computers with clocks that are far apart can let an older change win. Keep your computers' clocks on automatic time.
- **A computer away more than 180 days:** tombstones are kept for 180 days. Something you deleted can come back from a computer that was offline longer than that.

## Turn it off

**Turn off** (asks twice) stops sync on this computer, forgets the passphrase and what it had applied, and removes this computer from the list. Your data stays on every computer. The files stay in the folder, so the other computers keep syncing; delete the **Lumen Sync** folder yourself if you want them gone. To use a different folder or passphrase, turn it off and set it up again.

## For developers

- `src/features/sync-core.js`: the file format, the folder, the merge and the engine (no Electron).
- `src/features/sync-providers.js`: one provider per kind (bookmarks, settings, widgets, history, chats, passwords) over a store's accessors.
- `src/features/sync-folder.js`: the service main.js wires in (`syncService()`), loaded only while the setting is on. Setting: `syncFolder` (`{ on, path, kinds, passwords }`). Local files in the profile: `sync-secret.bin` (the passphrase, keychain-encrypted) and `sync-state.json` (what this computer has applied).
- `src/renderer/settings-sync.js`: the Settings section. IPC: `settings:sync-state`, `-pick`, `-enable`, `-set`, `-now`, `-off`.
- Tests: `test/units/sync-core-units.js` (format, folder, merge, conflicts, tombstones, corrupt files), `test/units/sync-folder-units.js` (two computers end to end, every kind, passwords, restart, the watcher), `test/e2e/sync-settings.js` (Settings in a real window).
