// The roster (KV binding PEOPLE): lowercase GitHub login → Discord user.
//
// Value:    "<discord id> <optional note>"   (manual entries use only this)
// Metadata: { discord, name, verified, left?, notify? }   (set by verification)
//
// notify holds per-person ping settings. A missing setting means "on".

export const PREFS = {
  review_requests: "Someone asks you to review a PR",
  assignments: "You're assigned a PR or issue",
  my_work: "Activity on PRs and issues you opened",
  mentions: "You're @mentioned on GitHub",
  digest: "You're waiting on something in the daily digest",
};

// Roster value: the Discord user ID, optionally followed by a note (e.g. a name).
export function rosterId(value) {
  const id = value?.trim().split(/\s+/)[0];
  return id && /^\d{17,20}$/.test(id) ? id : null;
}

export const wants = (person, pref) => person?.metadata?.notify?.[pref] !== false;

// Looks up several GitHub logins at once. Returns Map(lowercase login → { id, value, metadata }).
// Unknown logins are simply absent; a KV failure returns an empty map.
export async function resolvePeople(people, logins) {
  const found = new Map();
  if (!people) return found;
  const unique = [...new Set(logins.filter(Boolean).map((l) => l.toLowerCase()))];
  try {
    await Promise.all(
      unique.map(async (login) => {
        const { value, metadata } = await people.getWithMetadata(login);
        const id = metadata?.discord ?? rosterId(value);
        if (id) found.set(login, { id, value, metadata: metadata ?? {} });
      }),
    );
  } catch {
    return new Map();
  }
  return found;
}

export async function listRoster(people) {
  const entries = [];
  let cursor;
  do {
    const page = await people.list({ cursor });
    entries.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

// The roster entry for a Discord user, or null if they aren't linked.
export async function findByDiscord(people, discordId) {
  for (const entry of await listRoster(people)) {
    const { value, metadata } = await people.getWithMetadata(entry.name);
    if ((metadata?.discord ?? rosterId(value)) === discordId) {
      return { login: entry.name, value, metadata: metadata ?? {} };
    }
  }
  return null;
}
