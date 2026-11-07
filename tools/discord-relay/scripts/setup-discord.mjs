// One-time Discord setup: registers the /verify command in your server and
// posts the "Verify GitHub" panel in the #verify channel.
//
//   node scripts/setup-discord.mjs
//
// It asks for four values (see README.md, "Verify members with GitHub").
// Nothing is saved; run it again any time to re-post the panel.

import { createInterface } from "node:readline/promises";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (name, question) => process.env[name] || (await rl.question(`${question}: `)).trim();

const appId = await ask("DISCORD_APPLICATION_ID", "Discord Application ID");
const token = await ask("DISCORD_BOT_TOKEN", "Discord bot token");
const guildId = await ask("DISCORD_GUILD_ID", "Discord server ID");
const channelId = await ask("DISCORD_VERIFY_CHANNEL_ID", "#verify channel ID");
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

await discord("PUT", `/applications/${appId}/guilds/${guildId}/commands`, [
  { name: "verify", description: "Link your GitHub account to your Discord account", type: 1 },
]);
console.log("✓ Registered /verify");

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
