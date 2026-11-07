// Discord setup: registers the bot's slash commands (/verify, /notify, /digest)
// in your server, and optionally posts the "Verify GitHub" panel in #verify.
//
//   node scripts/setup-discord.mjs
//
// It asks for four values (see README.md, "Verify members with GitHub").
// Leave the #verify channel ID blank to update the commands without posting
// another panel. Nothing is saved; run it again whenever commands change.

import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (name, question) => process.env[name] || (await rl.question(`${question}: `)).trim();

const appId = await ask("DISCORD_APPLICATION_ID", "Discord Application ID");
const token = await ask("DISCORD_BOT_TOKEN", "Discord bot token");
const guildId = await ask("DISCORD_GUILD_ID", "Discord server ID");
const channelId = await ask("DISCORD_VERIFY_CHANNEL_ID", "#verify channel ID (leave blank to skip posting the panel)");
rl.close();

async function discord(method, path, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`\n✗ ${method} ${path} failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
}

const BOOL = 5;
const pref = (name, description) => ({ type: BOOL, name, description, required: false });

await discord("PUT", `/applications/${appId}/guilds/${guildId}/commands`, [
  { name: "verify", description: "Link your GitHub account to your Discord account", type: 1 },
  {
    name: "notify",
    description: "Show or change which GitHub events ping you",
    type: 1,
    options: [
      pref("all", "Turn every ping on or off"),
      pref("review_requests", "Someone asks you to review a PR"),
      pref("assignments", "You're assigned a PR or issue"),
      pref("my_work", "Activity on PRs and issues you opened"),
      pref("mentions", "You're @mentioned on GitHub"),
      pref("digest", "You're waiting on something in the daily digest"),
    ],
  },
  {
    name: "digest",
    description: "Post the open-PR digest now",
    type: 1,
    default_member_permissions: String(1 << 5), // Manage Server
  },
]);
console.log("✓ Registered /verify, /notify and /digest");

if (!channelId) {
  console.log("Skipped posting the Verify panel.");
  process.exit(0);
}

await discord("POST", `/channels/${channelId}/messages`, {
  content:
    "## Welcome to Daedalus Data Labs\n" +
    "To unlock the rest of the server, link your GitHub account:\n" +
    "1. Click **Verify GitHub** below.\n" +
    "2. Sign in to GitHub and click **Authorize**.\n\n" +
    "We only receive your GitHub username, never your password.\n" +
    "No GitHub account yet? Click **Create a GitHub account** first, then come back and click **Verify GitHub**.",
  components: [
    {
      type: 1,
      components: [
        { type: 2, style: 1, label: "Verify GitHub", custom_id: "verify" },
        { type: 2, style: 5, label: "Create a GitHub account", url: "https://github.com/signup" },
      ],
    },
  ],
  allowed_mentions: { parse: [] },
});
console.log("✓ Posted the Verify panel in #verify");
