// Daily PR digest: one message in the GitHub channel listing every open PR
// in the org, grouped by what it's waiting on. People who are holding a PR up
// get pinged (unless they turned off the "digest" setting with /notify).
//
// Posts nothing when there are no open PRs.

import { alertAdmins, postToDiscord } from "./util.js";
import { clean, nameResolver } from "./relay.js";
import { resolvePeople, wants } from "./people.js";

const MAX_PRS = 25;
const STALE_DAYS = 3;
const MAX_LEN = 1900;
const DAY = 24 * 60 * 60 * 1000;
const UA = "daedalus-discord-relay";

const SECTIONS = [
  ["review", "👀 **Waiting on review**"],
  ["changes", "✏️ **Changes requested** (waiting on the author)"],
  ["unassigned", "🙋 **Needs a reviewer**"],
  ["ready", "✅ **Approved, ready to merge**"],
];

export async function postDigest(env, now = Date.now()) {
  if (!env.DISCORD_WEBHOOK_URL) return;
  const org = env.GITHUB_ORG || "Daedalus-Data-Labs-LLC";
  const gh = (path) =>
    fetch(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": UA,
        ...(env.GITHUB_TOKEN && { authorization: `Bearer ${env.GITHUB_TOKEN}` }),
      },
    });

  const query = encodeURIComponent(`org:${org} is:pr is:open archived:false`);
  const search = await gh(`/search/issues?q=${query}&sort=created&order=asc&per_page=${MAX_PRS}`).catch(() => null);
  if (!search?.ok) {
    await alertAdmins(env, `⚠️ The daily PR digest was skipped: GitHub search failed. ${await explainGitHubError(search, !!env.GITHUB_TOKEN)}`);
    return;
  }
  const { items = [], total_count: total = 0 } = await search.json();
  if (items.length === 0) return;

  const prs = [];
  for (const item of items) {
    const repoPath = item.repository_url.replace("https://api.github.com/repos/", "");
    const [prRes, reviewsRes] = await Promise.all([
      gh(`/repos/${repoPath}/pulls/${item.number}`),
      gh(`/repos/${repoPath}/pulls/${item.number}/reviews?per_page=100`),
    ]).catch(() => []);
    if (!prRes?.ok || !reviewsRes?.ok) continue;
    const pr = await prRes.json();
    prs.push({ pr, repo: repoPath.split("/")[1], ...classify(pr, await reviewsRes.json()) });
  }
  if (prs.length === 0) return;

  const logins = prs.flatMap((p) => [p.pr.user?.login, ...p.waitingOn]);
  const people = await resolvePeople(env.PEOPLE, logins);
  const name = nameResolver(people, !!env.PEOPLE);

  const drafts = prs.filter((p) => p.status === "draft").length;
  const lines = [`☀️ **Daily PR digest** · ${total} open${total > items.length ? ` (showing the oldest ${items.length})` : ""}`];
  for (const [status, heading] of SECTIONS) {
    const group = prs.filter((p) => p.status === status);
    if (!group.length) continue;
    lines.push("", heading);
    for (const p of group) lines.push(line(p, name, now));
  }
  if (prs.every((p) => p.status === "draft")) lines.push("", "✨ Nothing is waiting on anyone right now.");

  const footer = [];
  if (drafts) footer.push(`📝 ${drafts} draft${drafts === 1 ? "" : "s"} not shown`);
  if (lines.some((l) => l.endsWith("⏰"))) footer.push(`⏰ no activity for ${STALE_DAYS}+ days`);
  if (footer.length) lines.push("", `-# ${footer.join(" · ")}`);

  // Ping whoever the PR is waiting on: requested reviewers, or the author
  // when changes were requested.
  const ping = [];
  for (const p of prs) {
    const owed = p.status === "changes" ? [p.pr.user?.login] : p.status === "review" ? p.waitingOn : [];
    for (const login of owed) {
      const person = login && people.get(login.toLowerCase());
      if (person && wants(person, "digest") && !ping.includes(person.id)) ping.push(person.id);
    }
  }

  await postToDiscord(env.DISCORD_WEBHOOK_URL, fit(lines), ping);
}

// Turn a failed GitHub response into a reason an admin can act on, quoting
// GitHub's own message so a 403 says *why* it was refused.
export async function explainGitHubError(res, hasToken) {
  if (!res) return "GitHub didn't answer. It's probably a temporary outage; the next digest will try again.";
  const body = await res.json().catch(() => ({}));
  const said = body?.message ? ` GitHub said: "${clean(body.message, 300)}"` : "";
  const status = `(${res.status})`;
  const rateLimited =
    res.status === 429 || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(body?.message ?? "");

  if (rateLimited && !hasToken) {
    return `${status} GitHub's rate limit for requests without a token was hit. Cloudflare Workers share IP addresses, so this happens often. Fix: set GITHUB_TOKEN (see the relay README, "Give the digest access to private repos").${said}`;
  }
  if (rateLimited) return `${status} GitHub's rate limit was hit. It resets within the hour; run /digest to try again.${said}`;
  if (res.status === 401) return `${status} GITHUB_TOKEN is invalid or has expired. Generate a new one and save it with \`npx wrangler secret put GITHUB_TOKEN\`.${said}`;
  if (res.status === 403) {
    return `${status} GitHub refused GITHUB_TOKEN. Usually the org blocks fine-grained tokens, the token's lifetime is longer than the org allows, or the token is still waiting for org approval (Org Settings → Personal access tokens).${said}`;
  }
  return `${status}${said}`;
}

// What an open PR is waiting on, from its requested reviewers and each
// reviewer's latest review.
export function classify(pr, reviews) {
  if (pr.draft) return { status: "draft", waitingOn: [] };

  const pending = (pr.requested_reviewers ?? []).map((u) => u.login);
  const latest = new Map();
  for (const r of reviews) {
    if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) latest.set(r.user?.login, r.state);
  }
  const blocking = [...latest].filter(([login, s]) => s === "CHANGES_REQUESTED" && !pending.includes(login));
  const approvals = [...latest.values()].filter((s) => s === "APPROVED").length;

  // A reviewer who was re-requested after asking for changes counts as pending.
  if (pending.length) return { status: "review", waitingOn: pending };
  if (blocking.length) return { status: "changes", waitingOn: [] };
  if (approvals) return { status: "ready", waitingOn: [] };
  if (pr.requested_teams?.length) return { status: "review", waitingOn: [] };
  return { status: "unassigned", waitingOn: [] };
}

function line(p, name, now) {
  const { pr } = p;
  const age = Math.max(0, Math.floor((now - Date.parse(pr.created_at)) / DAY));
  const stale = now - Date.parse(pr.updated_at) > STALE_DAYS * DAY ? " ⏰" : "";
  const waiting =
    p.status === "review" && p.waitingOn.length ? ` · waiting on ${p.waitingOn.map((l) => name(l)).join(", ")}` : "";
  return `• [PR #${pr.number}](${pr.html_url}) ${clean(pr.title, 60)} · *${clean(p.repo)}* · by ${name(pr.user?.login, pr.user?.type)}${waiting} · ${age}d${stale}`;
}

// Keep under Discord's message limit, dropping lines from the end.
function fit(lines) {
  let out = lines.join("\n");
  let dropped = 0;
  while (out.length > MAX_LEN && lines.length > 1) {
    lines.pop();
    dropped++;
    out = `${lines.join("\n")}\n…and ${dropped} more line${dropped === 1 ? "" : "s"}`;
  }
  return out;
}
