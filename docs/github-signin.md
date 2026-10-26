# Sign in with GitHub

The GitHub card on the new-tab page and the GitHub connector (the AI's `github` tool) share one sign-in. Press **Sign in with GitHub** on the card (or in Settings → Apps and connections → GitHub) and both are set up. No token to create or paste.

## The three ways in

1. **Sign in with GitHub** (the device flow). Lumen asks GitHub for a one-time code, shows it on the card, and opens `github.com/login/device` in a Lumen tab. Enter the code, approve, and the card fills in by itself. Lumen polls GitHub at the interval GitHub gives (and five seconds slower each time GitHub says `slow_down`) and stops when the code runs out (15 minutes at most).
2. **Use GitHub CLI sign-in.** Offered only when `gh` is installed and already signed in. One click: Lumen runs `gh auth token --hostname github.com` (hidden, no terminal window) and keeps that token.
3. **Paste a token** (Settings → Apps and connections → GitHub → Advanced). The older way; a fine-grained personal access token still works.

Settings also has **Switch account** (GitHub signs in the account that is signed in on github.com; sign out there first to pick another) and **Sign out**. Sign out removes only Lumen's copy of the token; to revoke a token from the one-time-code sign-in, remove Lumen under [github.com/settings/applications](https://github.com/settings/applications) (a gh CLI token belongs to the CLI: `gh auth logout`). If the GitHub connector was connected with its own pasted token, signing in or out on the card leaves it alone. A token GitHub stops accepting (revoked, expired) turns the card into **Sign in again**, and the AI tool says the same instead of showing a raw error.

## Permissions

The device flow asks for `read:user` and `notifications`. That shows who you are and the unread count; review requests and assigned items on public repositories need no scope. Private repositories need GitHub's `repo` scope, which GitHub offers only as read and write (OAuth apps have no read-only version), so Lumen asks for it only when you turn on **Include private repositories**. The card only reads. The AI's GitHub connector can also comment on an issue or pull request and open an issue, each only after you allow its card; that needs `repo` (Include private repositories, or the gh CLI) or a pasted token with Issues and Pull requests "Read and write". Without it the connector says the sign-in can only read and how to allow writing. The gh CLI's own token carries `repo`, `read:org` and `gist` (more than the card needs; Lumen uses it only for the card and the connector), so it covers private repositories and the connector's writes. A token with none of the useful scopes is refused, and one without notifications is accepted with a note.

## Where the token lives

One encrypted string, the widget secret `github` (the system keyring through Electron `safeStorage`, in `settings.json`'s `keys`). The connector reads it from there at each request: `connectors.json` holds only the account name and `"shared": true`, never a copy. The token goes only to `api.github.com` (and the sign-in calls to `github.com`), from the main process. The new-tab page and Settings get who you are, how you signed in and which permissions, never the token. Nothing logs tokens or codes.

## One-time maintainer step: register the OAuth App

Until this is done the "Sign in with GitHub" button is hidden and the card offers the GitHub CLI and pasted-token ways; nothing else is broken.

1. On github.com, signed in as the account or organisation that should own the app: **Settings → Developer settings → OAuth Apps → New OAuth App** (for an organisation: Organization settings → Developer settings → OAuth Apps).
2. Application name `Lumen`; Homepage URL `https://github.com/emah-maker/lumen`; Authorization callback URL `https://github.com/emah-maker/lumen` (the device flow never uses it, but the form requires one).
3. Press **Register application**.
4. On the app's page tick **Enable Device Flow** and **Update application**. (Without this GitHub answers `device_flow_disabled` and Lumen says GitHub sign-in isn't set up.)
5. Copy the **Client ID** (starts with `Ov23` or `Iv1.`). It is public. Do **not** generate a client secret; the device flow doesn't use one and nothing in Lumen reads it.
6. Paste the Client ID into `CLIENT_ID` in `src/features/github-auth.js` and ship. (To try an app before committing, start Lumen with `LUMEN_GITHUB_CLIENT_ID` set to it.)
7. Optional: upload the Lumen icon as the app logo, so the approval page looks right.

If your organisation uses OAuth app restrictions, approve the app under Organization settings → Third-party access, or people in that organisation will not see its private repositories.

## Tests

`test/units/github-signin-units.js` (runs in `test/units/units.js`) covers the module and the whole flow against stand-ins for `github.com` and `api.github.com` on 127.0.0.1: sign in and the card filling in, the pending and `slow_down` sequence, expired and denied codes, the gh CLI (a stub `gh` first on a temp `PATH`), sign out, the token shared with the connector, and a revoked token. `test/units/github-units.js` covers the card's lists.
