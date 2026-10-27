// [auto-delete chats] Settings → AI → Chat box and voice → "Delete chats not in a project after": a saved chat that is in no project and
// hasn't been used for that many days is deleted (chatAutoDeleteDays; 0, the default, is never). Archived chats count like any other.
// Pure: main.js passes the history list and what must be kept, and deletes what this returns through the same path as the chat's
// Delete (its pictures, uploads and engine homes go with it). Loaded on the first sweep, not at start-up (the module budget).
//
// Never picked: a chat in a project (one whose project still exists), a pinned chat, a chat that is open in a tab or the sidebar,
// one that is running or waiting to run, one another Lumen on the same profile added, and one whose file can't be read right now.
// "Used" is the list entry's `updated`: the last message sent or saved, so an old chat you came back to yesterday counts from yesterday.

const DAY_MS = 24 * 3600 * 1000;
const CHOICES = [0, 1, 7, 14, 30, 60, 90, 180, 365]; // the Settings menu, in days (0: Never)
const MAX_PER_SWEEP = 25; // at most this many in one sweep (each delete writes the index); the rest go in the next one

const cleanDays = (value) => ((typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) && CHOICES.includes(Number(value)) ? Number(value) : null); // (not true -> 1 or null -> 0)

// chats: the store's list() ([{ id, updated, pinned, project, missing }]); projectIds: the ids of the projects that exist;
// keep: chat ids that must stay (open, running, pending); foreign(id): true for a chat another writer added.
// Returns the ids to delete, the longest unused first, at most `max`.
function expiredChats({ chats = [], days = 0, now = Date.now(), projectIds = new Set(), keep = new Set(), foreign = () => false, max = MAX_PER_SWEEP } = {}) {
  const d = cleanDays(days);
  if (!d) return [];
  const cutoff = now - d * DAY_MS;
  return chats
    .filter((c) => c && typeof c.id === 'string'
      && !c.pinned && !c.trashed && !c.missing
      && !(c.project && projectIds.has(c.project))
      && !keep.has(c.id) && !foreign(c.id)
      && Number.isFinite(c.updated) && c.updated > 0 && c.updated < cutoff)
    .sort((a, b) => a.updated - b.updated)
    .slice(0, Math.max(0, max))
    .map((c) => c.id);
}

module.exports = { CHOICES, DAY_MS, MAX_PER_SWEEP, cleanDays, expiredChats };
