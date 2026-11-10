// Slash commands and buttons for the team-brain features. Replies are private
// (only the person who used the command sees them) unless noted.
//
//   /plate                     your open GitHub work
//   /remind when what          set a reminder · /reminders lists yours, with Cancel buttons
//   /timezone zone             your timezone for reminders
//   /decisions                 the latest saved decisions · /forget id removes one
//   /usage                     admins: today's AI use and what's stored
//   /reindex                   admins: rebuild the knowledge index
//   "Save to decisions" button under a thread summary

import { EPHEMERAL } from "./util.js";
import { brainCall, dailyBudget } from "./budget.js";
import { findByDiscord } from "./people.js";
import { plate } from "./plate.js";
import { parseReminder, validTimeZone } from "./when.js";
import { formatDecisions, forgetDecision, messageUrl, saveDecision } from "./decisions.js";

const REPLY = 4;
const DEFERRED = 5;
const UPDATE = 7;
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

export const COMMANDS = ["plate", "remind", "reminders", "timezone", "decisions", "forget", "usage", "reindex"];

const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
const reply = (content, components = []) => json({ type: REPLY, data: { content, components, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
const isAdmin = (i) => Boolean(BigInt(i.member?.permissions ?? "0") & (MANAGE_GUILD | ADMINISTRATOR));
const userOf = (i) => i.member?.user ?? i.user;
const optionsOf = (i) => Object.fromEntries((i.data.options ?? []).map((o) => [o.name, o.value]));

export async function handleCommand(i, env, ctx) {
  if (!env.BRAIN) return reply("This isn't set up yet. Please let an admin know.");
  const user = userOf(i);
  const o = optionsOf(i);

  switch (i.data.name) {
    case "plate": {
      const me = env.PEOPLE ? await findByDiscord(env.PEOPLE, user.id).catch(() => null) : null;
      if (!me) return reply("I don't know your GitHub account yet. Click **Verify GitHub** in #verify first.");
      // GitHub can take a few seconds: answer "thinking…" now, fill it in after.
      ctx?.waitUntil?.(
        plate(env, me.login)
          .catch(() => "I couldn't reach GitHub just now. Try again in a moment.")
          .then((content) => followUp(i, content)),
      );
      return json({ type: DEFERRED, data: { flags: EPHEMERAL } });
    }

    case "remind": {
      const tz = await timezoneOf(env, user.id);
      const r = parseReminder(`${o.what} ${o.when}`, tz);
      if (r.error) return reply(r.error);
      await brainCall(env, "reminders.add", { userId: user.id, channelId: i.channel_id ?? i.channel?.id, text: r.what, dueAt: r.dueAt });
      const t = Math.floor(r.dueAt / 1000);
      return reply(`⏰ I'll remind you <t:${t}:F> (<t:${t}:R>): ${r.what}\n-# In this channel. Your timezone: ${tz}.`);
    }

    case "reminders": {
      const list = await brainCall(env, "reminders.list", { userId: user.id });
      if (!list.length) return reply("You have no reminders set. Try *@Daedalus remind me tomorrow 9am to …* or `/remind`.");
      const lines = list.map((r) => `**#${r.id}** · <t:${Math.floor(r.due_at / 1000)}:f> · ${r.text}`);
      const buttons = list.slice(0, 5).map((r) => ({ type: 2, style: 4, label: `Cancel #${r.id}`, custom_id: `rem_cancel:${r.id}` }));
      return reply(`**Your reminders**\n${lines.join("\n")}`, [{ type: 1, components: buttons }]);
    }

    case "timezone": {
      if (!o.zone) return reply(`Your timezone is **${await timezoneOf(env, user.id)}**. Change it with \`/timezone zone:America/Chicago\` (any name from the IANA list).`);
      if (!validTimeZone(o.zone)) return reply(`I don't know the timezone **${o.zone}**. Use a name like \`America/New_York\`, \`Europe/London\` or \`Asia/Tokyo\`.`);
      await brainCall(env, "settings.set", { userId: user.id, key: "tz", value: o.zone });
      return reply(`🕒 Your timezone is now **${o.zone}**. Reminders will use it.`);
    }

    case "decisions":
      return reply(`**Saved decisions** (newest first)\n${formatDecisions(await brainCall(env, "decisions.list", { limit: 15 }))}`.slice(0, 1990));

    case "forget": {
      const d = await brainCall(env, "decisions.get", { id: o.id });
      if (!d) return reply(`There's no decision #${o.id}.`);
      if (d.author_id !== user.id && !isAdmin(i)) return reply("Only the person who wrote it, or an admin, can remove that decision.");
      await forgetDecision(env, o.id);
      return reply(`🗑️ Removed decision #${o.id}.`);
    }

    case "usage": {
      if (!isAdmin(i)) return reply("Only admins can see usage.");
      const s = await brainCall(env, "stats");
      const u = s.usage;
      const pct = Math.round((u.total / dailyBudget(env)) * 100);
      const kinds = Object.entries(u.byKind).map(([k, v]) => `• ${k}: ${Math.round(v.neurons)} Neurons in ${v.calls} calls`);
      return reply(
        [
          `**AI today** (${u.day}, UTC): about **${Math.round(u.total)}** of ${dailyBudget(env)} Neurons (${pct}%)`,
          ...(kinds.length ? kinds : ["• nothing yet"]),
          "",
          `**Knowledge index:** ${s.files} files in ${s.chunks} chunks · ${s.decisions} decisions`,
          `**Pending:** ${s.reminders} reminders · ${s.jobs} indexing jobs`,
          "-# Estimates from Cloudflare's per-token prices. Cloudflare's dashboard has the exact count.",
        ].join("\n"),
      );
    }

    case "reindex": {
      if (!isAdmin(i)) return reply("Only admins can rebuild the index.");
      if (!env.KB) return reply("The knowledge index isn't set up yet (no `KB` binding). See the README.");
      await brainCall(env, "jobs.enqueue", { jobs: [{ kind: "reindex_all", payload: {}, dedupe: "reindex_all" }], reindex: true });
      return reply("📚 Rebuilding the knowledge index from every repo. Unchanged files are skipped. I'll post in the admin channel when it's done.");
    }
  }
  return reply("Sorry, I don't know that one.");
}

export async function handleButton(i, env) {
  const id = i.data.custom_id;
  const user = userOf(i);

  if (id === "save_summary") {
    const text = String(i.message?.content ?? "").replace(/^📝 \*\*Summary[^\n]*\n/, "").trim();
    if (!text || !env.BRAIN) return reply("There's nothing to save.");
    const { id: decisionId } = await saveDecision(env, {
      text,
      authorId: user.id,
      authorName: user.global_name || user.username,
      savedBy: user.global_name || user.username,
      sourceUrl: messageUrl(i.guild_id, i.channel_id ?? i.channel?.id, i.message.id),
      messageId: i.message.id,
    });
    // Replace the button with a note, so it can't be saved twice.
    return json({ type: UPDATE, data: { content: `${i.message.content}\n-# 📌 Saved as decision #${decisionId} by ${user.global_name || user.username}`.slice(0, 2000), components: [] } });
  }

  if (id.startsWith("rem_cancel:")) {
    const ok = await brainCall(env, "reminders.cancel", { id: Number(id.split(":")[1]), userId: user.id });
    return reply(ok ? "🗑️ Reminder cancelled." : "That reminder is already gone.");
  }
  return reply("Sorry, I don't know that one.");
}

async function timezoneOf(env, userId) {
  return (await brainCall(env, "settings.get", { userId, key: "tz" })) || env.DEFAULT_TIMEZONE || "UTC";
}

// Completes a deferred reply.
function followUp(i, content) {
  return fetch(`https://discord.com/api/v10/webhooks/${i.application_id}/${i.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  }).catch((err) => console.error("followUp failed:", err));
}
