import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker from "../src/index.js";
import { mentionedLogins } from "../src/relay.js";
import { classify, explainGitHubError, postDigest } from "../src/digest.js";

const WARREN = "100000000000000001";
const SAM = "100000000000000002";
const ALEX = "100000000000000003";
const repository = { name: "site" };

function fakeKv(entries) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    getWithMetadata: async (k) => ({ value: store.get(k)?.value ?? null, metadata: store.get(k)?.metadata ?? null }),
    get: async (k) => store.get(k)?.value ?? null,
    put: async (k, value, opts = {}) => store.set(k, { value, metadata: opts.metadata }),
    list: async () => ({ keys: [...store].map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true }),
  };
}

const roster = (samNotify) =>
  fakeKv({
    warren: { value: `${WARREN} Warren`, metadata: { discord: WARREN } },
    sam: { value: `${SAM} Sam`, metadata: { discord: SAM, ...(samNotify && { notify: samNotify }) } },
    alex: { value: `${ALEX} Alex` }, // added by hand: no metadata, all pings on
  });

async function relay(event, payload, people = roster()) {
  const env = { GITHUB_WEBHOOK_SECRET: "s", DISCORD_WEBHOOK_URL: "https://discord.test/hook", PEOPLE: people };
  const body = JSON.stringify({ repository, ...payload });
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  };
  const res = await worker.fetch(
    new Request("https://relay.test/", {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": "sha256=" + createHmac("sha256", "s").update(body).digest("hex") },
      body,
    }),
    env,
  );
  return { status: res.status, sent };
}

const pr = (over = {}) => ({
  number: 14, title: "Fix nav", user: { login: "Warren" }, head: { ref: "fix" }, base: { ref: "main" },
  html_url: "https://github.com/o/site/pull/14", ...over,
});

// ---------- pings ----------

test("review request pings the reviewer by name", async () => {
  const { sent } = await relay("pull_request", {
    action: "review_requested", pull_request: pr(), sender: { login: "warren" }, requested_reviewer: { login: "sam" },
  });
  assert.match(sent.content, new RegExp(`^🙋 <@${WARREN}> requested a review from <@${SAM}> on PR #14`));
  assert.deepEqual(sent.allowed_mentions.users, [SAM]);
});

test("a review pings the PR author, never the reviewer", async () => {
  const { sent } = await relay("pull_request_review", {
    action: "submitted", pull_request: pr(), sender: { login: "sam" },
    review: { state: "approved", body: "", html_url: "u" },
  });
  const [head] = sent.content.split("\n");
  assert.match(head, new RegExp(`^✅ <@${SAM}> approved PR #14 · \\*site\\* · 🔔 <@${WARREN}>$`));
  assert.deepEqual(sent.allowed_mentions.users, [WARREN]);
});

test("@mentions in a comment ping linked people, skipping the commenter and unknowns", async () => {
  const { sent } = await relay("issue_comment", {
    action: "created", sender: { login: "alex" },
    issue: { number: 3, title: "Bug", user: { login: "alex" }, html_url: "u" },
    comment: { body: "@sam can you look? cc @alex @nobody, mail me@sam.com, ping @org/team", html_url: "u" },
  });
  assert.deepEqual(sent.allowed_mentions.users, [SAM]);
  assert.match(sent.content.split("\n")[0], new RegExp(`🔔 <@${SAM}>$`));
});

test("turned-off settings are respected per event type", async () => {
  const people = roster({ review_requests: false });
  const { sent } = await relay("pull_request", {
    action: "review_requested", pull_request: pr(), sender: { login: "warren" }, requested_reviewer: { login: "sam" },
  }, people);
  assert.deepEqual(sent.allowed_mentions.users, []);
  assert.match(sent.content, new RegExp(`<@${SAM}>`), "still shown by name");

  const { sent: mention } = await relay("issue_comment", {
    action: "created", sender: { login: "warren" },
    issue: { number: 3, title: "Bug", user: { login: "warren" }, html_url: "u" },
    comment: { body: "thanks @sam", html_url: "u" },
  }, people);
  assert.deepEqual(mention.allowed_mentions.users, [SAM], "mentions are still on");
});

test("assignment pings the assignee; self-assignment pings nobody", async () => {
  const issue = { number: 5, title: "Docs", user: { login: "alex" }, html_url: "u" };
  const { sent } = await relay("issues", { action: "assigned", issue, sender: { login: "warren" }, assignee: { login: "alex" } });
  assert.match(sent.content, new RegExp(`assigned issue #5 to <@${ALEX}>`));
  assert.deepEqual(sent.allowed_mentions.users, [ALEX]);

  const { sent: self } = await relay("issues", { action: "assigned", issue, sender: { login: "alex" }, assignee: { login: "alex" } });
  assert.match(self.content, /assigned issue #5 to themselves/);
  assert.deepEqual(self.allowed_mentions.users, []);
});

test("mention parsing ignores emails, teams and code-ish text", () => {
  assert.deepEqual(mentionedLogins("hi @Sam and @a-b, not x@y.com or @org/team or `@code`"), ["Sam", "a-b"]);
});

// ---------- /notify ----------

import { toHex } from "../src/util.js";

async function slash(name, options, people, member = { user: { id: SAM }, permissions: "0" }) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const env = {
    DISCORD_PUBLIC_KEY: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
    DISCORD_GUILD_ID: "1", PEOPLE: people, DISCORD_WEBHOOK_URL: "https://discord.test/hook",
  };
  const body = JSON.stringify({ type: 2, guild_id: "1", member, data: { name, options } });
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode("1" + body)));
  const waits = [];
  const res = await worker.fetch(
    new Request("https://relay.test/discord", { method: "POST", headers: { "x-signature-ed25519": toHex(sig), "x-signature-timestamp": "1" }, body }),
    env,
    { waitUntil: (p) => waits.push(p) },
  );
  return { data: (await res.json()).data, waits };
}

test("/notify shows settings, and changes only what's given", async () => {
  const people = roster();
  const shown = (await slash("notify", undefined, people)).data.content;
  assert.match(shown, /🔔 You're @mentioned on GitHub · `mentions`/);

  const saved = (await slash("notify", [{ name: "all", value: false }, { name: "mentions", value: true }], people)).data.content;
  assert.match(saved, /^\*\*Saved\.\*\*/);
  const notify = people.store.get("sam").metadata.notify;
  assert.equal(notify.mentions, true);
  assert.equal(notify.review_requests, false);
  assert.equal(people.store.get("sam").metadata.discord, SAM, "other metadata kept");
});

test("/notify asks unlinked people to verify first", async () => {
  const { data } = await slash("notify", undefined, roster(), { user: { id: "999999999999999999" } });
  assert.match(data.content, /isn't linked yet/);
});

test("/digest is admin-only", async () => {
  globalThis.fetch = async () => jsonRes({ items: [], total_count: 0 });
  assert.match((await slash("digest", undefined, roster())).data.content, /Only admins/);
  const { data, waits } = await slash("digest", undefined, roster(), { user: { id: SAM }, permissions: String(1 << 5) });
  assert.match(data.content, /Posting the PR digest/);
  assert.equal(waits.length, 1);
  await Promise.all(waits);
});

// ---------- digest ----------

const jsonRes = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
const NOW = Date.parse("2026-11-10T14:00:00Z");
const ago = (days) => new Date(NOW - days * 86400000).toISOString();

test("classify: re-requested reviewers count as pending; approvals mean ready", () => {
  const base = { draft: false, requested_reviewers: [], requested_teams: [] };
  const review = (login, state) => ({ user: { login }, state });
  assert.equal(classify({ ...base, draft: true }, []).status, "draft");
  assert.equal(classify(base, []).status, "unassigned");
  assert.equal(classify(base, [review("sam", "APPROVED"), review("sam", "COMMENTED")]).status, "ready");
  assert.equal(classify(base, [review("sam", "CHANGES_REQUESTED")]).status, "changes");
  assert.equal(classify(base, [review("sam", "CHANGES_REQUESTED"), review("sam", "DISMISSED")]).status, "unassigned");
  const rerequested = classify({ ...base, requested_reviewers: [{ login: "sam" }] }, [review("sam", "CHANGES_REQUESTED")]);
  assert.deepEqual(rerequested, { status: "review", waitingOn: ["sam"] });
});

function digestRoutes(prs, reviews = {}) {
  const posted = [];
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (url.startsWith("https://api.github.com/search/issues")) {
      return jsonRes({ total_count: prs.length, items: prs.map((p) => ({ number: p.number, repository_url: "https://api.github.com/repos/o/site" })) });
    }
    const m = url.match(/\/pulls\/(\d+)(\/reviews)?/);
    if (m) return jsonRes(m[2] ? reviews[m[1]] ?? [] : prs.find((p) => p.number === Number(m[1])));
    if (url === "https://discord.test/hook") {
      posted.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected ${url}`);
  };
  return posted;
}

const openPr = (number, over) => ({
  number, title: `PR ${number}`, html_url: `https://github.com/o/site/pull/${number}`, draft: false,
  user: { login: "warren" }, requested_reviewers: [], requested_teams: [], created_at: ago(2), updated_at: ago(1), ...over,
});

test("digest groups PRs and pings whoever each one waits on", async () => {
  const posted = digestRoutes(
    [
      openPr(1, { requested_reviewers: [{ login: "sam" }], updated_at: ago(5) }),
      openPr(2, { user: { login: "alex" } }),
      openPr(3),
      openPr(4, { draft: true }),
      openPr(5, { user: { login: "outsider" } }),
    ],
    { 2: [{ user: { login: "sam" }, state: "CHANGES_REQUESTED" }], 3: [{ user: { login: "sam" }, state: "APPROVED" }] },
  );
  await postDigest({ DISCORD_WEBHOOK_URL: "https://discord.test/hook", PEOPLE: roster() }, NOW);

  const { content, allowed_mentions } = posted[0];
  assert.match(content, /^☀️ \*\*Daily PR digest\*\* · 5 open/);
  assert.match(content, new RegExp(`👀 \\*\\*Waiting on review\\*\\*\\n• \\[PR #1\\].* · waiting on <@${SAM}> · 2d ⏰`));
  assert.match(content, new RegExp(`✏️ \\*\\*Changes requested\\*\\* \\(waiting on the author\\)\\n• \\[PR #2\\].* by <@${ALEX}>`));
  assert.match(content, /✅ \*\*Approved, ready to merge\*\*\n• \[PR #3\]/);
  assert.match(content, /🙋 \*\*Needs a reviewer\*\*\n• \[PR #5\].*by \*\*outsider\*\* \*\(unlinked\)\*/);
  assert.match(content, /-# 📝 1 draft not shown · ⏰ no activity for 3\+ days/);
  assert.ok(!content.includes("PR #4"));
  assert.deepEqual(allowed_mentions.users.sort(), [SAM, ALEX].sort());
});

test("digest respects the digest setting and stays silent with no open PRs", async () => {
  let posted = digestRoutes([openPr(1, { requested_reviewers: [{ login: "sam" }] })]);
  await postDigest({ DISCORD_WEBHOOK_URL: "https://discord.test/hook", PEOPLE: roster({ digest: false }) }, NOW);
  assert.deepEqual(posted[0].allowed_mentions.users, []);

  posted = digestRoutes([openPr(1, { draft: true }), openPr(2, { draft: true })]);
  await postDigest({ DISCORD_WEBHOOK_URL: "https://discord.test/hook", PEOPLE: roster() }, NOW);
  assert.match(posted[0].content, /· 2 open\n\n✨ Nothing is waiting on anyone right now\.\n\n-# 📝 2 drafts not shown$/);

  posted = digestRoutes([]);
  await postDigest({ DISCORD_WEBHOOK_URL: "https://discord.test/hook", PEOPLE: roster() }, NOW);
  assert.equal(posted.length, 0);
});

test("digest alerts admins instead of posting when GitHub search fails", async () => {
  const posted = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.github.com")) return new Response("{}", { status: 401 });
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  await postDigest({ DISCORD_WEBHOOK_URL: "https://discord.test/hook", DISCORD_ADMIN_WEBHOOK_URL: "https://discord.test/admin" }, NOW);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, "https://discord.test/admin");
  assert.match(posted[0].body.content, /digest was skipped.*401.*GITHUB_TOKEN/);
});

test("digest failure alerts say why GitHub refused", async () => {
  const res = (status, message, headers = {}) =>
    new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json", ...headers } });

  const anon = await explainGitHubError(res(403, "API rate limit exceeded for 1.2.3.4.", { "x-ratelimit-remaining": "0" }), false);
  assert.match(anon, /\(403\) .*without a token.*set GITHUB_TOKEN.*GitHub said: "API rate limit exceeded/);

  const policy = "The 'o' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days.";
  const forbidden = await explainGitHubError(res(403, policy), true);
  assert.match(forbidden, /\(403\) GitHub refused GITHUB_TOKEN.*lifetime.*GitHub said: "The 'o' organization forbids/);

  assert.match(await explainGitHubError(res(401, "Bad credentials"), true), /\(401\) GITHUB_TOKEN is invalid or has expired/);
  assert.match(await explainGitHubError(null, true), /didn't answer/);
});

test("the digest cron runs the digest; the 15-minute cron runs the leave check", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonRes({ items: [], total_count: 0 });
  };
  const env = { DISCORD_WEBHOOK_URL: "https://discord.test/hook" };
  const run = async (cron) => {
    const waits = [];
    await worker.scheduled({ cron }, env, { waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  await run("0 14 * * 1-5");
  assert.ok(calls.some((u) => u.startsWith("https://api.github.com/search/issues")));
  calls.length = 0;
  await run("*/15 * * * *");
  assert.equal(calls.length, 0, "sweep does nothing without Discord settings");
});
