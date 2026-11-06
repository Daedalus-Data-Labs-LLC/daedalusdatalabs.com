import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import worker, { format, displayName } from "../src/index.js";

const SECRET = "test-secret";
const env = { GITHUB_WEBHOOK_SECRET: SECRET, DISCORD_WEBHOOK_URL: "https://discord.test/hook" };
const repository = { name: "daedalusdatalabs.com", html_url: "https://github.com/o/r" };
const sender = { login: "octo_cat" };

function sign(body) {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

async function send(event, payload, signature) {
  const body = JSON.stringify(payload);
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(null, { status: 204 });
  };
  const res = await worker.fetch(
    new Request("https://relay.test/", {
      method: "POST",
      headers: { "x-github-event": event, "x-hub-signature-256": signature ?? sign(body) },
      body,
    }),
    env,
  );
  return { res, sent };
}

const pr = {
  number: 12, title: "Fix nav spacing on mobile", draft: false, merged: true,
  head: { ref: "fix/nav_spacing" }, base: { ref: "main" },
  commits: 3, additions: 42, deletions: 17, changed_files: 4,
  html_url: "https://github.com/o/r/pull/12",
};

test("rejects a bad signature", async () => {
  const { res, sent } = await send("push", { repository, sender }, "sha256=00");
  assert.equal(res.status, 401);
  assert.equal(sent.length, 0);
});

test("merged PR: summary line plus spoilered details", async () => {
  const { res, sent } = await send("pull_request", { action: "closed", pull_request: pr, repository, sender });
  assert.equal(res.status, 200);
  const { content, flags, allowed_mentions } = sent[0].body;
  const [summary, details] = content.split("\n");
  assert.equal(summary, "🔀 **octo\\_cat** merged PR #12 into `main` · *daedalusdatalabs.com*");
  assert.match(details, /^\|\|\*\*Fix nav spacing on mobile\*\* · `fix\/nav_spacing` → `main` · 3 commits · \+42 \/ −17 · 4 files · \[View PR\]\(.+\)\|\|$/);
  assert.equal(flags, 4);
  assert.deepEqual(allowed_mentions, { parse: [] });
});

test("push lists commits behind a spoiler", () => {
  const out = format("push", {
    ref: "refs/heads/feature", compare: "https://github.com/o/r/compare/a...b",
    commits: [{ id: "abcdef1234", message: "Add hero\n\nlong body" }, { id: "1234567abc", message: "Tweak copy" }],
    head_commit: { message: "Tweak copy", committer: { username: "warren" } },
    repository, sender,
  });
  assert.equal(out, "📌 **octo\\_cat** pushed 2 commits to `feature` · *daedalusdatalabs.com*\n" +
    "||`abcdef1` Add hero\n`1234567` Tweak copy\n[Compare](https://github.com/o/r/compare/a...b)||");
});

test("skips the push that a UI merge produces", () => {
  const out = format("push", {
    ref: "refs/heads/main", commits: [{ id: "a", message: "x" }],
    head_commit: { message: "Fix nav spacing (#12)", committer: { username: "web-flow" } },
    repository, sender,
  });
  assert.equal(out, null);
});

test("skips branch-deletion pushes and pings", () => {
  assert.equal(format("push", { deleted: true, repository, sender }), null);
  assert.equal(format("ping", { repository, sender }), null);
});

test("user text cannot escape the spoiler or ping anyone", () => {
  const out = format("issues", {
    action: "opened", issue: { number: 3, title: "|| @everyone **x**", html_url: "u" }, repository, sender,
  });
  const details = out.split("\n")[1];
  assert.equal(details.match(/\|\|/g).length, 2);
  assert.ok(!details.includes("@everyone"));
});

test("branch creation is a single line", () => {
  assert.equal(format("create", { ref: "claude/x", ref_type: "branch", repository, sender }),
    "🌱 **octo\\_cat** created branch `claude/x` · *daedalusdatalabs.com*");
});

const kv = (map) => ({ get: async (k) => map[k] ?? null });

test("mapped GitHub login shows as a Discord mention that never pings", async () => {
  env.PEOPLE = kv({ octo_cat: "123456789012345678 Octo (design)" });
  const { sent } = await send("create", { ref: "x", ref_type: "branch", repository, sender: { login: "Octo_Cat" } });
  delete env.PEOPLE;
  assert.equal(sent[0].body.content, "🌱 <@123456789012345678> created branch `x` · *daedalusdatalabs.com*");
  assert.deepEqual(sent[0].body.allowed_mentions, { parse: [] });
});

test("unmapped or invalid entries fall back to the GitHub login", async () => {
  assert.equal(await displayName(kv({}), "octo_cat"), "**octo\\_cat**");
  assert.equal(await displayName(kv({ octo_cat: "not-an-id" }), "octo_cat"), "**octo\\_cat**");
  assert.equal(await displayName(undefined, "octo_cat"), "**octo\\_cat**");
});
