import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Brain } from "../src/brain.js";
import { EMBED_MODEL, chunk, indexable, jobsForPush, retrieve, vectorId } from "../src/knowledge.js";
import { estimateNeurons } from "../src/budget.js";
import { handleMessage } from "../src/ask.js";
import { handleButton, handleCommand } from "../src/commands.js";
import { onPinReaction } from "../src/decisions.js";
import { runAgent } from "../src/agent.js";

// ---------- fakes ----------

// A Durable Object context backed by real SQLite, so the Brain's SQL really runs.
function fakeCtx() {
  const db = new DatabaseSync(":memory:");
  const state = { alarm: null };
  const sql = {
    exec(query, ...args) {
      const st = db.prepare(query);
      if (/^\s*SELECT/i.test(query)) {
        const rows = st.all(...args);
        return { toArray: () => rows, rowsWritten: 0 };
      }
      const r = st.run(...args);
      return { toArray: () => [], rowsWritten: Number(r.changes) };
    },
  };
  return { state, storage: { sql, setAlarm: async (t) => (state.alarm = t), deleteAlarm: async () => (state.alarm = null) } };
}

function fakeKB() {
  const store = new Map();
  return {
    store,
    upsert: async (vs) => vs.forEach((v) => store.set(v.id, v)),
    deleteByIds: async (ids) => ids.forEach((id) => store.delete(id)),
    query: async (_vec, { topK, filter }) => ({
      matches: [...store.values()].filter((v) => !filter || v.metadata.kind === filter.kind).slice(0, topK).map((v) => ({ id: v.id, score: 0.8, metadata: v.metadata })),
    }),
  };
}

let calls;
let chat; // replies for the chat model, in order
function fakeAI() {
  return {
    run: async (model, input) => {
      calls.push({ ai: model, input });
      if (model === EMBED_MODEL) return { data: input.text.map(() => [0.1, 0.2, 0.3]) };
      return chat.shift() ?? { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    },
  };
}

const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
let routes;
function mockFetch(r) {
  routes = r;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init, body: init.body ? safeJson(init.body) : undefined });
    for (const [prefix, h] of Object.entries(routes)) if (url.startsWith(prefix)) return h(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
}
const safeJson = (b) => {
  try {
    return JSON.parse(b);
  } catch {
    return b;
  }
};

const GUILD = "1";
const VERIFIED = "900000000000000009";
const BOT = "900000000000000001";
const ALICE = "900000000000000002";

let env;
let brain;
let ctx;
beforeEach(() => {
  calls = [];
  chat = [];
  ctx = fakeCtx();
  env = {
    DISCORD_GUILD_ID: GUILD, DISCORD_VERIFIED_ROLE_ID: VERIFIED, DISCORD_BOT_TOKEN: "tok", DISCORD_ADMIN_WEBHOOK_URL: "https://discord.test/admin",
    GITHUB_ORG: "org", DEFAULT_TIMEZONE: "America/New_York", AI_DAILY_NEURONS: "1000",
    AI: fakeAI(), KB: fakeKB(),
  };
  brain = new Brain(ctx, env);
  env.BRAIN = { idFromName: (n) => n, get: () => ({ fetch: (url, init) => brain.fetch(new Request(url, init)) }) };
  mockFetch({
    "https://discord.com/api/v10/": () => json({}),
    "https://discord.test/": () => new Response(null, { status: 204 }),
  });
});

const rpc = (method, args) => env.BRAIN.get().fetch("https://brain/rpc", { method: "POST", body: JSON.stringify({ method, args }) }).then((r) => r.json());

// ---------- budget ----------

test("budget: priorities stop background work first, and usage adds up per day", async () => {
  assert.ok(Math.abs(estimateNeurons("@cf/zai-org/glm-4.7-flash", 1_000_000, 0) - 5500) < 1);
  await rpc("usage.record", { kind: "answer", neurons: 650 });
  assert.equal((await rpc("budget.allow", { priority: "index" })).result.ok, false, "index stops at 60%");
  assert.equal((await rpc("budget.allow", { priority: "summary" })).result.ok, true);
  assert.equal((await rpc("budget.allow", { priority: "answer" })).result.ok, true);
  await rpc("usage.record", { kind: "answer", neurons: 300 });
  const today = (await rpc("usage.today")).result;
  assert.equal(today.total, 950);
  assert.equal(today.byKind.answer.calls, 2);
  assert.equal((await rpc("budget.allow", { priority: "summary" })).result.ok, false, "summaries stop at 90%");
});

test("brain: unknown methods and bad input return errors instead of throwing", async () => {
  assert.match((await rpc("nope")).error, /Unknown Brain method/);
});

// ---------- knowledge ----------

test("chunking keeps line ranges, overlaps, and never drops text", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const chunks = chunk(text);
  assert.ok(chunks.length > 3);
  assert.equal(chunks[0].from, 1);
  assert.equal(chunks.at(-1).to, 200);
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].from <= chunks[i - 1].to, "chunks overlap");
  assert.ok(chunks.every((c) => c.text.length <= 2400));
});

test("only text files outside build folders are indexed", () => {
  assert.ok(indexable("src/index.js", 500));
  assert.ok(indexable("README", 10));
  assert.ok(!indexable("node_modules/x/index.js"));
  assert.ok(!indexable("package-lock.json"));
  assert.ok(!indexable("assets/logo.png"));
  assert.ok(!indexable("big.js", 200_000));
});

test("a push re-indexes changed files on the default branch only; the last change wins", () => {
  const repository = { name: "site", default_branch: "main" };
  const jobs = jobsForPush({
    ref: "refs/heads/main", repository,
    commits: [{ added: ["a.js"], modified: ["b.md"], removed: [] }, { added: [], modified: [], removed: ["a.js", "logo.png"] }],
  });
  assert.deepEqual(jobs.map((j) => [j.kind, j.payload.path]), [["delete_file", "a.js"], ["index_file", "b.md"], ["delete_file", "logo.png"]]);
  assert.deepEqual(jobsForPush({ ref: "refs/heads/feature", repository, commits: [{ added: ["a.js"] }] }), []);
});

function githubRoutes(files) {
  return {
    "https://api.github.com/repos/org/site/contents/": (url, init) => {
      const path = decodeURIComponent(url.split("/contents/")[1]);
      const f = files[path];
      if (!f) return new Response("", { status: 404 });
      if (String(init.headers?.accept).includes("raw")) return new Response(f.text);
      return json({ type: "file", size: f.text.length, sha: f.sha, html_url: `https://github.com/org/site/blob/main/${path}` });
    },
  };
}

test("indexing a file embeds its chunks, and re-indexing a shorter version removes stale chunks", async () => {
  const files = { "src/a.js": { sha: "s1", text: Array.from({ length: 120 }, (_, i) => `const v${i} = ${i}; // ${"y".repeat(20)}`).join("\n") } };
  mockFetch({ ...githubRoutes(files), "https://discord.test/": () => new Response(null, { status: 204 }) });

  await rpc("jobs.enqueue", { jobs: [{ kind: "index_file", payload: { repo: "site", path: "src/a.js" }, dedupe: "file:site/src/a.js" }] });
  assert.ok(ctx.state.alarm, "an alarm is set to run the job");
  await brain.alarm();

  const first = (await rpc("stats")).result;
  assert.equal(first.files, 1);
  assert.equal(env.KB.store.size, first.chunks);
  const meta = [...env.KB.store.values()][0].metadata;
  assert.equal(meta.kind, "code");
  assert.match(meta.url, /^https:\/\/github\.com\/org\/site\/blob\/main\/src\/a\.js#L1-L\d+$/);
  assert.ok((await rpc("usage.today")).result.byKind.index.neurons > 0, "embedding cost recorded as index work");

  files["src/a.js"] = { sha: "s2", text: "const short = 1;" };
  await rpc("jobs.enqueue", { jobs: [{ kind: "index_file", payload: { repo: "site", path: "src/a.js" } }] });
  await brain.alarm();
  assert.equal(env.KB.store.size, 1, "stale chunks deleted");
  assert.equal(ctx.state.alarm, null, "nothing left to do");
});

test("indexing waits for tomorrow once the index budget is used", async () => {
  await rpc("usage.record", { kind: "answer", neurons: 700 });
  mockFetch(githubRoutes({ "a.md": { sha: "1", text: "hello" } }));
  await rpc("jobs.enqueue", { jobs: [{ kind: "index_file", payload: { repo: "site", path: "a.md" } }] });
  await brain.alarm();
  assert.equal(env.KB.store.size, 0);
  assert.equal((await rpc("stats")).result.jobs, 1, "job kept");
  assert.ok(ctx.state.alarm > Date.now() + 60_000, "rescheduled after midnight UTC");
});

test("retrieval returns decisions and code with their links; decisions_only filters", async () => {
  await env.KB.upsert([
    { id: await vectorId("decision:1"), values: [0], metadata: { kind: "decision", text: "Deploy from main only", date: "2026-11-01", author: "Alice", url: "u1" } },
    { id: await vectorId("code:x#0"), values: [0], metadata: { kind: "code", repo: "site", path: "x.js", lines: "1-5", url: "u2", text: "code" } },
  ]);
  assert.equal((await retrieve(env, "deploy")).length, 2);
  const only = await retrieve(env, "deploy", { decisionsOnly: true });
  assert.deepEqual(only.map((h) => h.kind), ["decision"]);
});

// ---------- decisions ----------

const verifiedMember = { roles: [VERIFIED], user: { id: ALICE, global_name: "Alice" } };

test("📌 from a Verified member saves the message once, confirms with ✅, and makes it searchable", async () => {
  mockFetch({
    "https://discord.com/api/v10/channels/600/messages/700/reactions/": () => new Response(null, { status: 204 }),
    "https://discord.com/api/v10/channels/600/messages/700": () => json({ id: "700", content: "We ship on Fridays.", author: { id: "5", username: "sam", global_name: "Sam" } }),
  });
  const reaction = { emoji: { name: "📌" }, guild_id: GUILD, channel_id: "600", message_id: "700", user_id: ALICE, member: verifiedMember };
  await onPinReaction(env, reaction);
  await onPinReaction(env, reaction); // second pin is ignored

  const list = (await rpc("decisions.list", {})).result;
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "We ship on Fridays.");
  assert.equal(list[0].author_name, "Sam");
  assert.equal(calls.filter((c) => c.url?.includes("/reactions/") && c.init.method === "PUT").length, 1);
  assert.equal([...env.KB.store.values()][0].metadata.kind, "decision");

  await onPinReaction(env, { ...reaction, message_id: "701", member: { roles: [] } });
  assert.equal((await rpc("decisions.list", {})).result.length, 1, "unverified pins ignored");
});

// ---------- messages: free intents ----------

function msg(content, over = {}) {
  return {
    id: "700", channel_id: "600", guild_id: GUILD, content: `<@${BOT}> ${content}`,
    author: { id: ALICE, username: "alice", global_name: "Alice" }, member: { roles: [VERIFIED] }, mentions: [{ id: BOT }], ...over,
  };
}
const fakeStorage = () => {
  const m = new Map();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v) };
};
const posted = () => calls.filter((c) => c.url?.endsWith("/messages") && c.init.method === "POST").map((c) => c.body);

test("'remember:' saves a decision without AI and without starting a thread", async () => {
  await handleMessage(msg("remember: the API token rotates every 90 days"), { env, storage: fakeStorage(), botId: BOT });
  assert.equal((await rpc("decisions.list", {})).result[0].text, "the API token rotates every 90 days");
  assert.match(posted()[0].content, /Saved to decisions as \*\*#1\*\*/);
  assert.equal(calls.filter((c) => c.ai && c.ai !== EMBED_MODEL).length, 0, "no chat-model call");
  assert.ok(!calls.some((c) => c.url?.includes("/threads")));
});

test("'remind me' stores a reminder in the person's timezone, and the alarm delivers it with a ping", async () => {
  await rpc("settings.set", { userId: ALICE, key: "tz", value: "Europe/London" });
  await handleMessage(msg("remind me in 2 hours to review PR #24"), { env, storage: fakeStorage(), botId: BOT });
  const [r] = (await rpc("reminders.list", { userId: ALICE })).result;
  assert.equal(r.text, "review PR #24");
  assert.ok(Math.abs(r.due_at - (Date.now() + 7_200_000)) < 5_000);
  assert.match(posted()[0].content, /⏰ Got it\. I'll remind you <t:\d+:F>.*Europe\/London/s);

  // Fast-forward: make it due, then run the alarm.
  ctx.storage.sql.exec("UPDATE reminders SET due_at = ?", Date.now() - 1);
  calls = [];
  await brain.alarm();
  const [delivered] = posted();
  assert.match(delivered.content, new RegExp(`^⏰ <@${ALICE}> review PR #24`));
  assert.deepEqual(delivered.allowed_mentions, { parse: [], users: [ALICE] });
  assert.equal((await rpc("reminders.list", { userId: ALICE })).result.length, 0);
});

test("'summarize' posts a summary with a save button; the button saves it once", async () => {
  mockFetch({
    "https://discord.com/api/v10/channels/600/messages?limit": () => json([
      { author: { id: "5", global_name: "Sam" }, content: "Let's move the launch to Friday." },
      { author: { id: ALICE, global_name: "Alice" }, content: "Agreed, Friday it is." },
    ]),
    "https://discord.com/api/v10/": () => json({}),
  });
  chat.push({ choices: [{ message: { content: "<think>hm</think>• Launch moved to Friday (Sam, Alice agreed)." } }] });
  await handleMessage(msg("summarize this thread"), { env, storage: fakeStorage(), botId: BOT });
  const [summary] = posted();
  assert.match(summary.content, /^📝 \*\*Summary of the last 2 messages\*\*\n• Launch moved to Friday/);
  assert.equal(summary.components[0].components[0].custom_id, "save_summary");
  assert.ok((await rpc("usage.today")).result.byKind.summary, "counted as summary work");

  const click = { type: 3, guild_id: GUILD, channel_id: "600", member: verifiedMember, data: { custom_id: "save_summary" }, message: { id: "900", content: summary.content } };
  const res = await (await handleButton(click, env)).json();
  assert.equal(res.type, 7);
  assert.deepEqual(res.data.components, []);
  assert.match(res.data.content, /Saved as decision #1 by Alice/);
  assert.equal((await rpc("decisions.get", { id: 1 })).result.text, "• Launch moved to Friday (Sam, Alice agreed).");
});

// ---------- slash commands ----------

const command = (name, options = [], member = verifiedMember) => ({ type: 2, guild_id: GUILD, channel_id: "600", member, data: { name, options } });
const run = async (i) => (await (await handleCommand(i, env, { waitUntil() {} })).json()).data;

test("/timezone validates, /remind uses it, /reminders lists with Cancel buttons that work", async () => {
  assert.match((await run(command("timezone", [{ name: "zone", value: "Mars/Olympus" }]))).content, /don't know the timezone/);
  assert.match((await run(command("timezone", [{ name: "zone", value: "Asia/Tokyo" }]))).content, /now \*\*Asia\/Tokyo\*\*/);
  assert.match((await run(command("remind", [{ name: "when", value: "tomorrow 9am" }, { name: "what", value: "standup" }]))).content, /Asia\/Tokyo/);

  const list = await run(command("reminders"));
  assert.match(list.content, /\*\*#1\*\* · <t:\d+:f> · standup/);
  assert.equal(list.components[0].components[0].custom_id, "rem_cancel:1");

  const cancel = await (await handleButton({ type: 3, guild_id: GUILD, member: verifiedMember, data: { custom_id: "rem_cancel:1" } }, env)).json();
  assert.match(cancel.data.content, /cancelled/);
  assert.equal((await rpc("reminders.list", { userId: ALICE })).result.length, 0);
});

test("/forget is limited to the decision's author or an admin; /usage and /reindex are admin-only", async () => {
  await rpc("decisions.add", { text: "x", authorId: "someone-else" });
  assert.match((await run(command("forget", [{ name: "id", value: 1 }]))).content, /Only the person who wrote it/);
  const admin = { ...verifiedMember, permissions: String(1 << 5) };
  assert.match((await run(command("forget", [{ name: "id", value: 1 }], admin))).content, /Removed decision #1/);

  assert.match((await run(command("usage"))).content, /Only admins/);
  assert.match((await run(command("usage", [], admin))).content, /AI today.*of 1000 Neurons/s);

  assert.match((await run(command("reindex"))).content, /Only admins/);
  assert.match((await run(command("reindex", [], admin))).content, /Rebuilding the knowledge index/);
  assert.equal((await rpc("stats")).result.jobs, 1);
});

// ---------- agent ----------

test("answers start from knowledge-index excerpts, and stop politely when the budget is spent", async () => {
  await env.KB.upsert([{ id: "d1", values: [0], metadata: { kind: "decision", text: "We deploy the site from main only.", date: "2026-11-01", author: "Alice", url: "https://discord.com/x" } }]);
  chat.push({ choices: [{ message: { content: "From main only (decision #1)." } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } });
  const answer = await runAgent(env, [{ role: "user", content: "Alice: where do we deploy from?" }], { asker: "Alice" });
  assert.equal(answer, "From main only (decision #1).");
  const chatCall = calls.find((c) => c.ai === "@cf/zai-org/glm-4.7-flash");
  assert.match(chatCall.input.messages[0].content, /Knowledge-index excerpts[\s\S]*📌 Team decision \(2026-11-01, Alice\)[\s\S]*deploy the site from main only/);
  assert.equal(chatCall.input.tools[0].function.name, "search_knowledge");
  assert.ok((await rpc("usage.today")).result.byKind.answer.neurons > 10, "answer cost recorded from real token counts");

  await rpc("usage.record", { kind: "answer", neurons: 5000 });
  await assert.rejects(runAgent(env, [{ role: "user", content: "hi" }], { asker: "Alice" }), /today's free AI allowance/);
});
