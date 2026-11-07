// Shared helpers: signing, Discord posting, small HTML pages.

const enc = new TextEncoder();
const MAX_LEN = 2000; // Discord message limit
const SUPPRESS_EMBEDS = 1 << 2; // no link previews
export const EPHEMERAL = 1 << 6; // only the person who clicked sees the reply

export async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return toHex(new Uint8Array(mac));
}

export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
export const fromHex = (hex) => new Uint8Array((hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));

// ---------- signed, expiring state for the verify link ----------

const b64url = (s) => btoa(String.fromCharCode(...enc.encode(s))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// Signed with a key derived from the webhook secret, so a verify link can't be
// forged, edited, or used after it expires.
export async function signState(secret, data) {
  const payload = b64url(JSON.stringify(data));
  return `${payload}.${await hmacHex("verify-state:" + secret, payload)}`;
}

export async function readState(secret, token, now = Date.now()) {
  if (!secret || typeof token !== "string") return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  if (!timingSafeEqual(await hmacHex("verify-state:" + secret, payload), sig)) return null;
  try {
    const data = JSON.parse(unb64url(payload));
    return typeof data.e === "number" && data.e > now ? data : null;
  } catch {
    return null;
  }
}

// ---------- Discord ----------

// Only the Discord user IDs in `ping` get notified. Every other mention in
// the message shows as a name, and @everyone/@here never work.
export function postToDiscord(webhookUrl, content, ping = []) {
  return fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: content.slice(0, MAX_LEN),
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: { parse: [], users: ping.slice(0, 100) },
    }),
  });
}

export function discordApi(env, path, init = {}) {
  return fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

// Admin alerts go to a private channel's webhook. Failures are swallowed so
// an alert problem never breaks verification.
export async function alertAdmins(env, content) {
  if (!env.DISCORD_ADMIN_WEBHOOK_URL) return;
  try {
    await postToDiscord(env.DISCORD_ADMIN_WEBHOOK_URL, content);
  } catch {
    // ignore
  }
}

// ---------- pages ----------

export const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// `body` must already be escaped HTML.
export function page(title, body, status = 200) {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(title)} · Daedalus</title>
<style>
:root{--ink:#0B1526;--ground:#F4F3EF;--muted:#5b6475}
@media (prefers-color-scheme:dark){:root{--ink:#F4F3EF;--ground:#0B1526;--muted:#a9b0bd}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--ground);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
main{max-width:30rem;padding:2rem 1rem}h1{font-size:1.4rem;margin:0 0 .75rem}p{margin:0 0 1rem}.muted{color:var(--muted);font-size:.9rem}
a.button{display:inline-block;padding:.7rem 1.2rem;border-radius:.5rem;background:var(--ink);color:var(--ground);text-decoration:none;font-weight:600}
</style></head><body><main><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
}
