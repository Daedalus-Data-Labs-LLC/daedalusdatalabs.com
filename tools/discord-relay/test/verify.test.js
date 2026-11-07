import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { signState, toHex } from "../src/util.js";
import { sweep } from "../src/sweep.js";

const GUILD = "111111111111111111";
const ALICE = "222222222222222222";
const BOB = "333333333333333333";

// ---------- fakes ----------

function fakeKv(initial = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? { value: v } : v]));
  return {
    store,
    get: async (k) => store.get(k)?.value ?? null,
    getWithMetadata: async (k) => ({ value: store.get(k)?.value ?? null, metadata: store.get(k)?.metadata ?? null }),
    put: async (k, value, opts = {}) => store.set(k, { value, metadata: opts.metadata }),
    delete: async (k) => store.delete(k),
    list: async () => ({ keys: [...store].map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true }),
  };
}

// Routes fetch() by URL prefix; records every call.
let calls;
let routes;
function mockFetch(r) {
  calls = [];
  routes = r;
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const match = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!match) throw new Error(`unexpected fetch ${url}`);
    return routes[match](url, init);
  };
}
const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const adminPosts = () => calls.filter((c) => c.url === "https://discord.test/admin").map((c) => c.body.content);

let keys;
let env;
beforeEach(async () => {
  keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  env = {
    GITHUB_WEBHOOK_SECRET: "s3cret",
    DISCORD_PUBLIC_KEY: toHex(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: GUILD,
    DISCORD_VERIFIED_ROLE_ID: "444444444444444444",
    DISCORD_ADMIN_WEBHOOK_URL: "https://discord.test/admin",
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    PEOPLE: fakeKv(),
  };
});

async function interact(payload, { tamper = false } = {}) {
  const body = JSON.stringify(payload);
  const timestamp = "1700000000";
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(timestamp + body)));
  if (tamper) sig[0] ^= 1;
  return worker.fetch(
    new Request("https://relay.test/discord", {
      method: "POST",
      headers: { "x-signature-ed25519": toHex(sig), "x-signature-timestamp": timestamp },
      body,
    }),
    env,
  );
}

const verifyClick = (guild = GUILD) => ({
  type: 3,
  guild_id: guild,
  data: { custom_id: "verify" },
  member: { user: { id: ALICE, username: "alice", global_name: "Alice" } },
});

// ---------- Discord interactions ----------

test("answers Discord's PING and rejects bad signatures", async () => {
  assert.deepEqual(await (await interact({ type: 1 })).json(), { type: 1 });
  assert.equal((await interact({ type: 1 }, { tamper: true })).status, 401);
});

test("Verify button replies privately with a personal sign-in link", async () => {
  const data = (await (await interact(verifyClick())).json()).data;
  assert.equal(data.flags, 64);
  assert.match(data.content, /github\.com\/signup/);
  const url = new URL(data.components[0].components[0].url);
  assert.equal(url.origin + url.pathname, "https://relay.test/auth/start");
  assert.ok(url.searchParams.get("state"));
});

test("Verify outside the Daedalus server is refused", async () => {
  const data = (await (await interact(verifyClick("999999999999999999"))).json()).data;
  assert.equal(data.components.length, 0);
  assert.match(data.content, /inside the Daedalus Discord server/);
});

// ---------- sign-in pages ----------

const goodState = (over = {}) => signState(env.GITHUB_WEBHOOK_SECRET, { d: ALICE, n: "Alice <b>", e: Date.now() + 60_000, ...over });
const get = (path) => worker.fetch(new Request(`https://relay.test${path}`), env, { waitUntil() {} });

test("start page names the Discord account (escaped) and links to GitHub sign-in", async () => {
  const res = await get(`/auth/start?state=${encodeURIComponent(await goodState())}`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Alice &lt;b&gt;/);
  assert.match(html, /https:\/\/github\.com\/login\/oauth\/authorize\?client_id=client-id/);
});

test("expired or forged links are rejected", async () => {
  const expired = await goodState({ e: Date.now() - 1 });
  assert.equal((await get(`/auth/start?state=${encodeURIComponent(expired)}`)).status, 400);
  const good = await goodState();
  const forged = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0"); // always differs
  assert.equal((await get(`/auth/start?state=${encodeURIComponent(forged)}`)).status, 400);
});

function signInRoutes({ login = "Alice-GH", roleStatus = 204 } = {}) {
  mockFetch({
    "https://github.com/login/oauth/access_token": () => jsonRes({ access_token: "gho_x" }),
    "https://api.github.com/user": () => jsonRes({ login }),
    "https://api.github.com/applications/": () => new Response(null, { status: 204 }),
    "https://discord.com/api/v10/guilds/": () => new Response(null, { status: roleStatus }),
    "https://discord.test/admin": () => new Response(null, { status: 204 }),
  });
}

test("callback links the accounts, gives the role, revokes the token and tells admins", async () => {
  env.PEOPLE = fakeKv({ "old-login": { value: `${ALICE} Alice`, metadata: { discord: ALICE } } });
  signInRoutes();
  const res = await get(`/auth/callback?code=abc&state=${encodeURIComponent(await goodState({ n: "Alice" }))}`);
  assert.equal(res.status, 200);

  const entry = env.PEOPLE.store.get("alice-gh");
  assert.equal(entry.value, `${ALICE} Alice`);
  assert.equal(entry.metadata.discord, ALICE);
  assert.ok(!env.PEOPLE.store.has("old-login"), "old link for the same Discord user is removed");

  const role = calls.find((c) => c.url.includes("/roles/"));
  assert.equal(role.url, `https://discord.com/api/v10/guilds/${GUILD}/members/${ALICE}/roles/444444444444444444`);
  assert.equal(role.init.method, "PUT");
  assert.ok(calls.some((c) => c.url === "https://api.github.com/applications/client-id/grant" && c.init.method === "DELETE"));

  const [alert] = adminPosts();
  assert.match(alert, new RegExp(`✅ <@${ALICE}> verified as GitHub \\*\\*Alice-GH\\*\\*`));
  assert.match(alert, /replaces their old link to `old-login`/);
});

test("admins are warned when a GitHub account moves to a different Discord user", async () => {
  env.PEOPLE = fakeKv({ "alice-gh": `${BOB} Bob` });
  signInRoutes();
  await get(`/auth/callback?code=abc&state=${encodeURIComponent(await goodState())}`);
  assert.match(adminPosts()[0], new RegExp(`linked to <@${BOB}> before`));
});

test("a failed role grant still saves the link and asks admins to fix it", async () => {
  signInRoutes({ roleStatus: 403 });
  const res = await get(`/auth/callback?code=abc&state=${encodeURIComponent(await goodState())}`);
  assert.match(await res.text(), /An admin has been told/);
  assert.ok(env.PEOPLE.store.has("alice-gh"));
  assert.match(adminPosts()[0], /couldn't give the Verified role \(Discord said 403\)/);
});

test("callback without a code (member clicked Cancel) changes nothing", async () => {
  mockFetch({});
  const res = await get(`/auth/callback?error=access_denied&state=${encodeURIComponent(await goodState())}`);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

// ---------- leave alerts ----------

function sweepRoutes(memberIds, ok = true) {
  mockFetch({
    "https://discord.com/api/v10/guilds/": () => (ok ? jsonRes(memberIds.map((id) => ({ user: { id } }))) : new Response(null, { status: 500 })),
    "https://discord.test/admin": () => new Response(null, { status: 204 }),
  });
}

test("alerts admins once when a linked member leaves, and again only after they return", async () => {
  env.PEOPLE = fakeKv({
    "alice-gh": { value: `${ALICE} Alice`, metadata: { discord: ALICE, name: "Alice" } },
    "bob-gh": `${BOB} Bob`, // added by hand, no metadata
    "carol-gh": "444444444444444445 Carol",
    "dave-gh": "444444444444444446 Dave",
  });
  const everyoneButAlice = [BOB, "444444444444444445", "444444444444444446"];

  sweepRoutes(everyoneButAlice);
  await sweep(env);
  const [alert] = adminPosts();
  assert.match(alert, new RegExp(`🚪 <@${ALICE}> \\(Alice\\) left the Discord server`));
  assert.match(alert, /\*\*alice-gh\*\*.*people\?query=alice-gh/);
  assert.ok(env.PEOPLE.store.get("alice-gh").metadata.left);

  sweepRoutes(everyoneButAlice);
  await sweep(env);
  assert.equal(adminPosts().length, 0, "no repeat alert");

  sweepRoutes([ALICE, ...everyoneButAlice]);
  await sweep(env);
  assert.equal(env.PEOPLE.store.get("alice-gh").metadata.left, undefined, "cleared on return");
});

test("does nothing when Discord can't be read or most members vanish at once", async () => {
  env.PEOPLE = fakeKv({ a: `${ALICE} A`, b: `${BOB} B`, c: "444444444444444445 C", d: "444444444444444446 D" });

  sweepRoutes([], false);
  await sweep(env);
  assert.equal(adminPosts().length, 0);

  sweepRoutes(["555555555555555555"]); // all four "gone"
  await sweep(env);
  const posts = adminPosts();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /Nothing was changed/);
  assert.ok([...env.PEOPLE.store.values()].every((e) => !e.metadata?.left));
});
