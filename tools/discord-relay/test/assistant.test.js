import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GatewayBot } from "../src/gateway.js";
import { handleMessage, split, takeQuota } from "../src/ask.js";
import { runAgent } from "../src/agent.js";
import { redact, runTool } from "../src/github-tools.js";

const BOT = "900000000000000001";
const ALICE = "900000000000000002";
const GUILD = "1";
const VERIFIED = "900000000000000009";

function fakeStorage() {
  const map = new Map();
  return {
    map,
    alarm: null,
    get: async (k) => map.get(k),
    put: async (k, v) => map.set(k, v),
    delete: async (k) => (Array.isArray(k) ? k.forEach((x) => map.delete(x)) : map.delete(k)),
    setAlarm: async function (t) { this.alarm = t; },
    deleteAlarm: async function () { this.alarm = null; },
  };
}

// fetch mock: routes by URL prefix and records calls.
let calls;
function mockFetch(routes) {
  calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init.body ?? (typeof input === "object" && input.body ? await input.text() : undefined);
    calls.push({ url, init, body: body ? JSON.parse(body) : undefined });
    for (const [prefix, handler] of Object.entries(routes)) if (url.startsWith(prefix)) return handler(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
}
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

// ---------- gateway ----------

function gatewayBot() {
  const storage = fakeStorage();
  const bot = new GatewayBot({ storage }, { DISCORD_BOT_TOKEN: "tok" });
  const sent = [];
  bot.ws = { send: (s) => sent.push(JSON.parse(s)), close: () => {} };
  return { bot, storage, sent };
}

test("gateway: identifies with the message intents, then heartbeats on alarms", async () => {
  const { bot, storage, sent } = gatewayBot();
  await bot.onMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 40000 } }));
  assert.equal(sent[0].op, 2);
  assert.equal(sent[0].d.intents, (1 << 0) | (1 << 9) | (1 << 15));
  assert.ok(storage.alarm > 0);

  await bot.onMessage(JSON.stringify({ op: 0, t: "READY", s: 1, d: { session_id: "s1", resume_gateway_url: "wss://resume.discord.gg", user: { id: BOT, username: "Daedalus" } } }));
  assert.deepEqual(storage.map.get("session"), { id: "s1", resumeUrl: "wss://resume.discord.gg", user: { id: BOT, name: "Daedalus" } });

  await bot.alarm();
  assert.deepEqual(sent.at(-1), { op: 1, d: 1 });
  assert.equal(bot.acked, false);
  await bot.onMessage(JSON.stringify({ op: 11 }));
  assert.equal(bot.acked, true);
});

test("gateway: a missed heartbeat ack reconnects, and a known session resumes", async () => {
  const { bot, storage, sent } = gatewayBot();
  storage.map.set("session", { id: "s1" });
  storage.map.set("seq", 42);
  bot.acked = false;
  await bot.alarm();
  assert.equal(bot.ws, null, "zombie connection dropped");

  bot.ws = { send: (s) => sent.push(JSON.parse(s)), close: () => {} };
  await bot.onMessage(JSON.stringify({ op: 10, d: { heartbeat_interval: 40000 } }));
  assert.deepEqual(sent.at(-1), { op: 6, d: { token: "tok", session_id: "s1", seq: 42 } });
});

test("gateway: bad token stops retrying; an invalid session starts fresh", async () => {
  const { bot, storage } = gatewayBot();
  storage.alarm = 123;
  await bot.onClose(4004);
  assert.equal(storage.alarm, null);

  storage.map.set("session", { id: "s1" });
  bot.ws = { send: () => {}, close: () => {} };
  await bot.onMessage(JSON.stringify({ op: 9, d: false }));
  assert.equal(storage.map.has("session"), false);
});

// ---------- conversations ----------

function message(over = {}) {
  return {
    id: "700", channel_id: "600", guild_id: GUILD, content: `<@${BOT}> what changed this week?`,
    author: { id: ALICE, username: "alice", global_name: "Alice" },
    member: { roles: [VERIFIED] }, mentions: [{ id: BOT }], ...over,
  };
}

let env;
let aiCalls;
beforeEach(() => {
  aiCalls = [];
  env = {
    DISCORD_GUILD_ID: GUILD, DISCORD_VERIFIED_ROLE_ID: VERIFIED, DISCORD_BOT_TOKEN: "tok",
    AI: { run: async (model, input) => { aiCalls.push({ model, input }); return { choices: [{ message: { content: "Here's what changed." } }] }; } },
  };
});

function discordRoutes(extra = {}) {
  mockFetch({
    "https://discord.com/api/v10/channels/600/messages/700/threads": () => json({ id: "800" }),
    "https://discord.com/api/v10/channels/800/messages?": () => json(extra.threadMessages ?? []),
    "https://discord.com/api/v10/": () => json({}),
  });
}
const posts = () => calls.filter((c) => c.url.endsWith("/messages") && c.init.method === "POST");

test("@Daedalus in a channel starts a thread and answers there", async () => {
  discordRoutes();
  const storage = fakeStorage();
  await handleMessage(message(), { env, storage, botId: BOT });

  assert.equal(calls[0].body.name, "what changed this week?");
  assert.deepEqual(storage.map.get("thread:800").starter, "Alice: what changed this week?");
  assert.deepEqual(aiCalls[0].input.messages.at(-1), { role: "user", content: "Alice: what changed this week?" });
  const [post] = posts();
  assert.equal(post.url, "https://discord.com/api/v10/channels/800/messages");
  assert.equal(post.body.content, "Here's what changed.");
  assert.deepEqual(post.body.allowed_mentions, { parse: [], replied_user: false });
});

test("follow-ups in the bot's thread need no @ and carry the conversation", async () => {
  discordRoutes({
    threadMessages: [ // Discord returns newest first
      { author: { id: ALICE, global_name: "Alice" }, content: "and what about the relay?" },
      { author: { id: BOT }, content: "Here's what changed." },
      { author: { id: BOT }, content: "" }, // thread starter placeholder
    ],
  });
  const storage = fakeStorage();
  storage.map.set("thread:800", { starter: "Alice: what changed this week?" });
  await handleMessage(message({ channel_id: "800", content: "and what about the relay?", mentions: [] }), { env, storage, botId: BOT });

  const convo = aiCalls[0].input.messages.slice(1).map((m) => [m.role, m.content]);
  assert.deepEqual(convo, [
    ["user", "Alice: what changed this week?"],
    ["assistant", "Here's what changed."],
    ["user", "Alice: and what about the relay?"],
  ]);
  assert.equal(posts()[0].url, "https://discord.com/api/v10/channels/800/messages");
});

test("ignores bots, other servers, and messages that aren't for it", async () => {
  discordRoutes();
  const storage = fakeStorage();
  await handleMessage(message({ author: { id: "5", bot: true } }), { env, storage, botId: BOT });
  await handleMessage(message({ guild_id: "999" }), { env, storage, botId: BOT });
  await handleMessage(message({ mentions: [], content: "hello all" }), { env, storage, botId: BOT });
  assert.equal(calls.length, 0);
  assert.equal(aiCalls.length, 0);
});

test("unverified members are pointed to #verify; the daily limit is enforced", async () => {
  discordRoutes();
  await handleMessage(message({ member: { roles: [] } }), { env, storage: fakeStorage(), botId: BOT });
  assert.match(posts()[0].body.content, /verify your GitHub account/);
  assert.equal(aiCalls.length, 0);

  const storage = fakeStorage();
  const day = new Date("2026-11-07T10:00:00Z");
  assert.equal(await takeQuota(storage, ALICE, 2, day), true);
  assert.equal(await takeQuota(storage, ALICE, 2, day), true);
  assert.equal(await takeQuota(storage, ALICE, 2, day), false);
  assert.equal(await takeQuota(storage, ALICE, 2, new Date("2026-11-08T00:00:01Z")), true, "resets the next UTC day");
});

test("long answers are split under Discord's limit on line breaks", () => {
  const parts = split(`${"a".repeat(1500)}\n\n${"b".repeat(1500)}`);
  assert.deepEqual(parts.map((p) => p.length), [1500, 1500]);
  assert.ok(split("x".repeat(4500)).every((p) => p.length <= 2000));
});

// ---------- agent: Workers AI ----------

test("Workers AI: runs GitHub tools, then returns the answer without inline reasoning", async () => {
  mockFetch({ "https://api.github.com/repos/Daedalus-Data-Labs-LLC/site/commits": () => json([{ sha: "abcdef123", commit: { message: "Fix nav\n\nbody", author: { date: "2026-11-06T00:00:00Z" } }, author: { login: "alice" }, html_url: "https://github.com/c/1" }]) });
  const replies = [
    { choices: [{ message: { content: "", tool_calls: [{ id: "t1", function: { name: "list_commits", arguments: '{"repo":"site","days":7}' } }] } }] },
    { choices: [{ message: { content: "<think>let me see</think>One commit: Fix nav. Token ghp_abcdefghijklmnopqrstuvwxyz123456" } }] },
  ];
  env.AI.run = async (model, input) => { aiCalls.push({ model, input }); return replies.shift(); };

  const answer = await runAgent(env, [{ role: "user", content: "Alice: what changed?" }], { asker: "Alice" });
  assert.equal(answer, "One commit: Fix nav. Token [redacted]");
  assert.equal(aiCalls[0].model, "@cf/zai-org/glm-4.7-flash");
  assert.equal(aiCalls[0].input.tools[0].type, "function");
  assert.match(calls[0].url, /commits\?per_page=20&since=/);
  const toolMsg = aiCalls[1].input.messages.at(-1);
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "t1");
  assert.match(toolMsg.content, /abcdef1 Fix nav · alice/);
});

test("Workers AI: running out of the free allowance gives a clear message", async () => {
  env.AI.run = async () => { throw new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"); };
  await assert.rejects(runAgent(env, [{ role: "user", content: "hi" }], { asker: "Alice" }), /free AI allowance.*00:00 UTC/);
});

// ---------- agent: Claude ----------

test("Claude: sends fallbacks and tools, loops on tool_use, keeps assistant content", async () => {
  env.ANTHROPIC_API_KEY = "sk-ant-test";
  env.ANTHROPIC_MODEL = "claude-opus-5-5";
  const replies = [
    { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "tool_use", usage: {},
      content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "tu1", name: "list_repos", input: {} }] },
    { id: "m2", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", usage: {},
      content: [{ type: "text", text: "You have one repo: site." }] },
  ];
  mockFetch({
    "https://api.anthropic.com/v1/messages": () => json(replies.shift()),
    "https://api.github.com/orgs/": () => json([{ name: "site", pushed_at: "2026-11-06T00:00:00Z", description: "Website" }]),
  });

  const answer = await runAgent(env, [{ role: "user", content: "Alice: what repos do we have?" }], { asker: "Alice" });
  assert.equal(answer, "You have one repo: site.");

  const claude = calls.filter((c) => c.url.startsWith("https://api.anthropic.com"));
  assert.equal(claude.length, 2);
  const first = claude[0];
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.equal(first.body.fallbacks, "default");
  assert.deepEqual(first.body.output_config, { effort: "medium" });
  assert.equal(first.body.tools[0].input_schema.type, "object");
  assert.match(String(new Headers(first.init.headers).get("anthropic-beta")), /server-side-fallback-2026-07-01/);

  const second = claude[1].body.messages;
  assert.equal(second[1].role, "assistant");
  assert.equal(second[1].content[0].type, "thinking", "thinking blocks passed back unchanged");
  assert.deepEqual(second[2].content[0].tool_use_id, "tu1");
  assert.match(second[2].content[0].content, /site · updated 2026-11-06 · Website/);
});

test("Claude: a refusal becomes a polite decline", async () => {
  env.ANTHROPIC_API_KEY = "sk-ant-test";
  mockFetch({ "https://api.anthropic.com/v1/messages": () => json({ id: "m", type: "message", role: "assistant", model: "x", stop_reason: "refusal", usage: {}, content: [] }) });
  await assert.rejects(runAgent(env, [{ role: "user", content: "x" }], { asker: "A" }), /can't help with that one/);
});

// ---------- tools ----------

test("tools stay inside the org, refuse path tricks, and mask secrets", async () => {
  mockFetch({});
  assert.match((await runTool({}, "read_file", { repo: "../other", path: "x" })).error, /repo name/);
  assert.match((await runTool({}, "read_file", { repo: "site", path: "a/../../etc" })).error, /'\.\.'/);
  assert.match((await runTool({}, "nope", {})).error, /Unknown tool/);
  assert.equal(calls.length, 0, "nothing was fetched");
  assert.equal(redact("key sk-ant-api03-abcdefghijklmnopqrstuv and AKIAABCDEFGHIJKLMNOP"), "key [redacted] and [redacted]");
});
