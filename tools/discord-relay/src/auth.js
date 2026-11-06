// "Sign in with GitHub" for Discord verification.
//
// /auth/start     confirms which Discord account is being linked, then sends
//                 the member to GitHub's own sign-in page.
// /auth/callback  GitHub sends them back here. We read their GitHub username,
//                 save it in the roster, give them the Verified role, and tell
//                 admins. We never see their password, and we revoke the
//                 GitHub authorization straight away, so nothing is kept.

import { alertAdmins, discordApi, escapeHtml, page, readState } from "./util.js";
import { clean, rosterId } from "./relay.js";

const UA = "daedalus-discord-relay";

export async function authStart(request, env) {
  const token = new URL(request.url).searchParams.get("state");
  const state = await readState(env.GITHUB_WEBHOOK_SECRET, token);
  if (!state) return expired();

  const github = new URL("https://github.com/login/oauth/authorize");
  github.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  github.searchParams.set("redirect_uri", `${new URL(request.url).origin}/auth/callback`);
  github.searchParams.set("state", token);
  github.searchParams.set("allow_signup", "true");

  // Showing the Discord name stops someone from passing their own link to a
  // teammate and getting the teammate's GitHub account linked to them.
  return page(
    "Link your GitHub account",
    `<p>You're linking the Discord account <strong>${escapeHtml(state.n)}</strong> to your GitHub account.</p>
<p><a class="button" href="${escapeHtml(github.toString())}">Continue to GitHub</a></p>
<p class="muted">You'll sign in on GitHub's own page. Daedalus only receives your GitHub username, never your password.</p>
<p class="muted">Not your Discord account? Close this page.</p>`,
  );
}

export async function authCallback(request, env, ctx) {
  const url = new URL(request.url);
  const state = await readState(env.GITHUB_WEBHOOK_SECRET, url.searchParams.get("state"));
  if (!state) return expired();
  const code = url.searchParams.get("code");
  if (!code) {
    return page("Verification cancelled", "<p>No problem. Go back to Discord and click <strong>Verify GitHub</strong> when you're ready.</p>", 400);
  }

  // 1. Exchange the one-time code for a short-lived token, then read the username.
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${url.origin}/auth/callback`,
    }),
  });
  const { access_token: accessToken } = await tokenRes.json().catch(() => ({}));
  if (!accessToken) return failed("GitHub didn't confirm the sign-in.");

  const userRes = await fetch("https://api.github.com/user", {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.github+json", "user-agent": UA },
  });
  const login = userRes.ok ? (await userRes.json()).login : null;
  ctx?.waitUntil?.(revokeGrant(env, accessToken));
  if (!login) return failed("We couldn't read your GitHub username.");

  // 2. Update the roster: drop any older GitHub link for this Discord user,
  //    and note if this GitHub account was linked to someone else before.
  const key = login.toLowerCase();
  const previousOwner = rosterId(await env.PEOPLE.get(key));
  const dropped = [];
  for (const entry of await listRoster(env.PEOPLE)) {
    if (entry.name !== key && entry.metadata?.discord === state.d) {
      await env.PEOPLE.delete(entry.name);
      dropped.push(entry.name);
    }
  }
  await env.PEOPLE.put(key, `${state.d} ${state.n}`, {
    metadata: { discord: state.d, name: state.n, verified: new Date().toISOString() },
  });

  // 3. Give them the Verified role.
  const roleRes = await discordApi(
    env,
    `/guilds/${env.DISCORD_GUILD_ID}/members/${state.d}/roles/${env.DISCORD_VERIFIED_ROLE_ID}`,
    { method: "PUT", headers: { "x-audit-log-reason": `Verified as GitHub ${login}` } },
  ).catch(() => null);
  const roleOk = roleRes?.ok ?? false;

  // 4. Tell admins.
  const notes = [];
  if (previousOwner && previousOwner !== state.d) notes.push(`⚠️ this GitHub account was linked to <@${previousOwner}> before`);
  if (dropped.length) notes.push(`replaces their old link to ${dropped.map((d) => `\`${d}\``).join(", ")}`);
  if (!roleOk) notes.push(`❗ couldn't give the Verified role (Discord said ${roleRes?.status ?? "nothing"}); please add it by hand`);
  await alertAdmins(env, `✅ <@${state.d}> verified as GitHub **${clean(login)}**${notes.length ? `\n${notes.join("\n")}` : ""}`);

  return page(
    "You're verified",
    `<p>Your Discord account is now linked to GitHub <strong>${escapeHtml(login)}</strong>.</p>
${roleOk ? "<p>You now have access to the rest of the server. You can close this tab.</p>" : "<p>We couldn't unlock your channels automatically. An admin has been told and will sort it out shortly.</p>"}`,
  );
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

// Remove the app's authorization so no token outlives the sign-in. It also
// means GitHub asks the member to approve again if they ever re-verify.
function revokeGrant(env, accessToken) {
  return fetch(`https://api.github.com/applications/${env.GITHUB_CLIENT_ID}/grant`, {
    method: "DELETE",
    headers: {
      authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      accept: "application/vnd.github+json",
      "user-agent": UA,
      "content-type": "application/json",
    },
    body: JSON.stringify({ access_token: accessToken }),
  }).catch(() => {});
}

const expired = () =>
  page("This link has expired", "<p>Verify links last 10 minutes. Go back to Discord and click <strong>Verify GitHub</strong> again.</p>", 400);

const failed = (why) =>
  page("Verification didn't finish", `<p>${escapeHtml(why)} Go back to Discord and click <strong>Verify GitHub</strong> to try again.</p>`, 502);
