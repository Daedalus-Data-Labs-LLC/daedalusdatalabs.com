// Discord interactions. Every reply is private (only the person sees it).
//
//   Verify GitHub button, /verify   a personal sign-in link (expires in 10 minutes)
//   /notify                         show or change your ping settings
//   /digest                         admins: post the PR digest now

import { EPHEMERAL, fromHex, signState } from "./util.js";
import { PREFS, findByDiscord } from "./people.js";
import { postDigest } from "./digest.js";

const LINK_TTL_MS = 10 * 60 * 1000;
const PING = 1;
const COMMAND = 2;
const COMPONENT = 3;
const PONG = 1;
const REPLY = 4;

export async function handleInteraction(request, env, ctx) {
  const body = await request.text();
  const ok = await verifyDiscord(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("x-signature-ed25519"),
    request.headers.get("x-signature-timestamp"),
    body,
  );
  if (!ok) return new Response("Bad signature", { status: 401 });

  const i = JSON.parse(body);
  if (i.type === PING) return json({ type: PONG });

  if (i.guild_id !== env.DISCORD_GUILD_ID) {
    return reply("Run this inside the Daedalus Discord server.");
  }
  if (i.type === COMMAND && i.data?.name === "notify") return notify(i, env);
  if (i.type === COMMAND && i.data?.name === "digest") return digest(i, env, ctx);

  const wantsVerify =
    (i.type === COMMAND && i.data?.name === "verify") ||
    (i.type === COMPONENT && i.data?.custom_id === "verify");
  if (!wantsVerify) return reply("Sorry, I don't know that one.");

  if (!env.PEOPLE || !env.GITHUB_CLIENT_ID) {
    return reply("Verification isn't set up yet. Please let an admin know.");
  }

  const user = i.member?.user ?? i.user;
  const state = await signState(env.GITHUB_WEBHOOK_SECRET, {
    d: user.id,
    n: user.global_name || user.username,
    e: Date.now() + LINK_TTL_MS,
  });
  const url = `${new URL(request.url).origin}/auth/start?state=${encodeURIComponent(state)}`;

  return reply(
    "**Verify your GitHub account**\n" +
      "Click below and sign in to GitHub. This link is only for you and expires in 10 minutes.\n" +
      "No GitHub account yet? [Create one](https://github.com/signup), then click **Verify GitHub** again.",
    [{ type: 1, components: [{ type: 2, style: 5, label: "Sign in with GitHub", url }] }],
  );
}

// /notify with no options shows your settings; each option turns one on or off.
// "all" sets every one at once, and individual options still win over it.
async function notify(i, env) {
  if (!env.PEOPLE) return reply("Pings aren't set up yet. Please let an admin know.");
  const user = i.member?.user ?? i.user;
  const me = await findByDiscord(env.PEOPLE, user.id);
  if (!me) {
    return reply("Your GitHub account isn't linked yet. Click **Verify GitHub** in #verify first, then try again.");
  }

  const options = Object.fromEntries((i.data.options ?? []).map((o) => [o.name, o.value]));
  const settings = { ...me.metadata.notify };
  if (typeof options.all === "boolean") for (const key of Object.keys(PREFS)) settings[key] = options.all;
  for (const key of Object.keys(PREFS)) if (typeof options[key] === "boolean") settings[key] = options[key];

  const changed = Object.keys(options).length > 0;
  if (changed) await env.PEOPLE.put(me.login, me.value, { metadata: { ...me.metadata, notify: settings } });

  const rows = Object.entries(PREFS).map(([key, label]) => `${settings[key] === false ? "🔕" : "🔔"} ${label} · \`${key}\``);
  return reply(
    `${changed ? "**Saved.** " : ""}Pings for GitHub **${me.login}**:\n${rows.join("\n")}\n\n` +
      "Change one with, for example, `/notify mentions:False`, or all at once with `/notify all:False`.",
  );
}

// Admins only. Discord also hides the command from everyone without Manage Server.
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

function digest(i, env, ctx) {
  const perms = BigInt(i.member?.permissions ?? "0");
  if (!(perms & (MANAGE_GUILD | ADMINISTRATOR))) return reply("Only admins can post the digest.");
  ctx?.waitUntil?.(postDigest(env));
  return reply("Posting the PR digest in the GitHub channel now. If there are no open PRs, nothing is posted.");
}

async function verifyDiscord(publicKeyHex, signatureHex, timestamp, body) {
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey("raw", fromHex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, fromHex(signatureHex), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

const json = (data) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });

const reply = (content, components = []) =>
  json({ type: REPLY, data: { content, components, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
