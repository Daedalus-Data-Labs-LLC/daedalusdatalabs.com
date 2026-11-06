// Scheduled check (every 15 minutes): alert admins when a linked member has
// left or been removed from the Discord server. It changes nothing on GitHub;
// an admin decides whether to remove the person from the org.

import { alertAdmins, discordApi } from "./util.js";
import { clean, rosterId } from "./relay.js";
import { listRoster } from "./auth.js";

export async function sweep(env) {
  if (!env.PEOPLE || !env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) return;

  const members = await guildMemberIds(env);
  if (!members || members.size === 0) return; // Discord unavailable: never alert on bad data

  const linked = [];
  for (const entry of await listRoster(env.PEOPLE)) {
    const value = await env.PEOPLE.get(entry.name);
    const id = entry.metadata?.discord ?? rosterId(value);
    if (id) linked.push({ login: entry.name, id, value, metadata: entry.metadata ?? {} });
  }

  // People marked as gone who are back: clear the mark so a later departure alerts again.
  for (const p of linked.filter((p) => p.metadata.left && members.has(p.id))) {
    const { left, ...rest } = p.metadata;
    await env.PEOPLE.put(p.login, p.value, { metadata: rest });
  }

  const gone = linked.filter((p) => !p.metadata.left && !members.has(p.id));
  if (gone.length === 0) return;

  // Many departures at once usually means the bot lost access, not a real exodus.
  if (gone.length > Math.max(3, linked.length / 2)) {
    await alertAdmins(
      env,
      `⚠️ ${gone.length} of ${linked.length} linked members look like they've left the server at once. ` +
        "Nothing was changed. Check that the bot is still in the server and has the Server Members Intent.",
    );
    return;
  }

  const org = env.GITHUB_ORG || "Daedalus-Data-Labs-LLC";
  for (const p of gone) {
    const name = clean(p.metadata.name ?? p.value?.split(/\s+/).slice(1).join(" ") ?? "");
    await alertAdmins(
      env,
      `🚪 <@${p.id}>${name ? ` (${name})` : ""} left the Discord server. ` +
        `Their GitHub account **${clean(p.login)}** may still have access. ` +
        `[Review in GitHub](https://github.com/orgs/${org}/people?query=${encodeURIComponent(p.login)})`,
    );
    await env.PEOPLE.put(p.login, p.value, { metadata: { ...p.metadata, left: new Date().toISOString() } });
  }
}

// Every member ID in the server, or null if Discord couldn't be read.
async function guildMemberIds(env) {
  const ids = new Set();
  let after = "0";
  for (;;) {
    const res = await discordApi(env, `/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${after}`).catch(() => null);
    if (!res?.ok) return null;
    const batch = await res.json();
    for (const m of batch) ids.add(m.user.id);
    if (batch.length < 1000) return ids;
    after = batch[batch.length - 1].user.id;
  }
}
