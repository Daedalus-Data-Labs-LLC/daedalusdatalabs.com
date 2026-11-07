// Discord interactions: the "Verify GitHub" button and the /verify command.
//
// Both reply privately (only the clicker sees it) with a personal sign-in
// link that expires after 10 minutes.

import { EPHEMERAL, fromHex, signState } from "./util.js";

const LINK_TTL_MS = 10 * 60 * 1000;
const PING = 1;
const COMMAND = 2;
const COMPONENT = 3;
const PONG = 1;
const REPLY = 4;

export async function handleInteraction(request, env) {
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

  const wantsVerify =
    (i.type === COMMAND && i.data?.name === "verify") ||
    (i.type === COMPONENT && i.data?.custom_id === "verify");
  if (!wantsVerify) return reply("Sorry, I don't know that one.");

  if (!env.PEOPLE || !env.GITHUB_CLIENT_ID) {
    return reply("Verification isn't set up yet. Please let an admin know.");
  }
  if (i.guild_id !== env.DISCORD_GUILD_ID) {
    return reply("Run this inside the Daedalus Discord server.");
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
