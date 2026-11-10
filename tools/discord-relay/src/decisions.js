// The team's decisions log: things people explicitly chose to save.
//
// Ways in:  react 📌 to a message · "@Daedalus remember: ..." · the
//           "Save to decisions" button under a thread summary
// Ways out: answers search it automatically · /decisions lists it · /forget removes one
//
// Nothing is saved unless someone asks, so the bot never reads the rest of the server.

import { brainCall } from "./budget.js";
import { discordApi } from "./util.js";
import { indexDecision, removeDecision } from "./knowledge.js";

export const PIN = "📌";

export async function saveDecision(env, d) {
  const { id, created } = await brainCall(env, "decisions.add", d);
  if (created) {
    try {
      await indexDecision(env, { ...d, id });
    } catch (err) {
      console.error("indexDecision failed:", err); // still saved; just not searchable yet
    }
  }
  return { id, created };
}

export async function forgetDecision(env, id) {
  const d = await brainCall(env, "decisions.get", { id });
  if (!d) return null;
  await brainCall(env, "decisions.delete", { id });
  await removeDecision(env, id).catch((err) => console.error("removeDecision failed:", err));
  return d;
}

export const messageUrl = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

// A 📌 reaction from a Verified member saves that message.
export async function onPinReaction(env, r) {
  if (r.emoji?.name !== PIN || r.guild_id !== env.DISCORD_GUILD_ID) return;
  if (env.DISCORD_VERIFIED_ROLE_ID && !r.member?.roles?.includes(env.DISCORD_VERIFIED_ROLE_ID)) return;

  const res = await discordApi(env, `/channels/${r.channel_id}/messages/${r.message_id}`).catch(() => null);
  if (!res?.ok) return;
  const m = await res.json();
  const text = m.content?.trim();
  if (!text) return;

  const { created } = await saveDecision(env, {
    text,
    authorId: m.author?.id,
    authorName: m.member?.nick || m.author?.global_name || m.author?.username,
    savedBy: r.member?.user?.global_name || r.member?.user?.username || r.user_id,
    sourceUrl: messageUrl(r.guild_id, r.channel_id, r.message_id),
    messageId: r.message_id,
  });
  if (created) {
    // ✅ on the message confirms it was saved.
    await discordApi(env, `/channels/${r.channel_id}/messages/${r.message_id}/reactions/${encodeURIComponent("✅")}/@me`, { method: "PUT" }).catch(() => {});
  }
}

export function formatDecisions(rows) {
  if (!rows.length) return "No decisions saved yet. React 📌 to a message, or say *@Daedalus remember: ...*";
  return rows
    .map((d) => {
      const date = new Date(d.created_at).toISOString().slice(0, 10);
      const text = d.text.replace(/\s+/g, " ").slice(0, 110);
      return `**#${d.id}** · ${date} · ${text}${d.text.length > 110 ? "…" : ""}${d.author_name ? ` · ${d.author_name}` : ""}${d.source_url ? ` · [link](${d.source_url})` : ""}`;
    })
    .join("\n");
}
