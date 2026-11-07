// Turns Discord messages into @Daedalus conversations.
//
//   "@Daedalus <question>" in a channel  -> start a thread on that message and answer there
//   any message in a thread it started   -> follow-up; the thread so far is the context
//   "@Daedalus" anywhere else (e.g. someone else's thread) -> answer in place
//
// Only Verified members can ask, and each person gets AI_DAILY_LIMIT questions
// per day (UTC), so one person can't use up the free AI allowance.

import { discordApi } from "./util.js";
import { AgentError, runAgent } from "./agent.js";
import { findByDiscord } from "./people.js";

const SUPPRESS_EMBEDS = 1 << 2;
const MAX_MESSAGE = 2000;
const HISTORY = 20;

export async function handleMessage(m, { env, storage, botId }) {
  if (m.author?.bot || m.webhook_id || m.guild_id !== env.DISCORD_GUILD_ID) return;

  const mentioned = m.mentions?.some((u) => u.id === botId);
  const thread = await storage.get(`thread:${m.channel_id}`);
  if (!mentioned && !thread) return;

  const question = m.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim();

  if (env.DISCORD_VERIFIED_ROLE_ID && !m.member?.roles?.includes(env.DISCORD_VERIFIED_ROLE_ID)) {
    return send(env, m.channel_id, "Please verify your GitHub account in #verify first, then ask me again.", m.id);
  }
  if (!question) {
    return send(env, m.channel_id, "Hi! Ask me anything about Daedalus's GitHub projects, for example: *what changed in the site this week?*", m.id);
  }

  const limit = Number(env.AI_DAILY_LIMIT ?? 20);
  if (!(await takeQuota(storage, m.author.id, limit))) {
    return send(env, m.channel_id, `You've used your ${limit} questions for today. They reset at 00:00 UTC.`, m.id);
  }

  // Where the answer goes, and what the conversation so far is.
  let channel = m.channel_id;
  let replyTo = m.id;
  let history = [{ role: "user", content: question }];
  if (thread) {
    history = await threadHistory(env, m.channel_id, botId, thread.starter);
    replyTo = null;
  } else {
    const created = await startThread(env, m, question);
    if (created) {
      channel = created;
      replyTo = null;
      await storage.put(`thread:${created}`, { starter: `${name(m)}: ${question}`, at: Date.now() });
      history = [{ role: "user", content: `${name(m)}: ${question}` }];
    }
  }

  const typing = keepTyping(env, channel);
  let answer;
  try {
    const me = env.PEOPLE ? await findByDiscord(env.PEOPLE, m.author.id).catch(() => null) : null;
    answer = await runAgent(env, history, { asker: name(m), githubLogin: me?.login });
  } catch (err) {
    answer = err instanceof AgentError ? err.message : "Something went wrong on my end. Try again in a moment.";
    if (!(err instanceof AgentError)) console.error("agent:", err);
  } finally {
    typing.stop();
  }

  const parts = split(answer);
  for (let i = 0; i < parts.length; i++) await send(env, channel, parts[i], i === 0 ? replyTo : null);
}

// ---------- helpers ----------

const name = (m) => m.member?.nick || m.author.global_name || m.author.username;

export async function takeQuota(storage, userId, limit, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const key = `quota:${userId}`;
  const q = (await storage.get(key)) ?? {};
  const used = q.day === day ? q.used : 0;
  if (used >= limit) return false;
  await storage.put(key, { day, used: used + 1 });
  return true;
}

async function startThread(env, m, question) {
  const title = question.replace(/\s+/g, " ").slice(0, 90) || "Question";
  const res = await discordApi(env, `/channels/${m.channel_id}/messages/${m.id}/threads`, {
    method: "POST",
    body: JSON.stringify({ name: title, auto_archive_duration: 1440 }),
  }).catch(() => null);
  if (!res?.ok) return null; // e.g. already inside a thread: answer in place instead
  return (await res.json()).id;
}

// The thread's messages as a conversation, oldest first. Bot messages are the
// assistant; everyone else's are the user, labelled with their name.
export async function threadHistory(env, channelId, botId, starter) {
  const res = await discordApi(env, `/channels/${channelId}/messages?limit=${HISTORY}`).catch(() => null);
  const msgs = res?.ok ? (await res.json()).reverse() : [];
  const turns = [{ role: "user", content: starter }];
  for (const msg of msgs) {
    if (!msg.content) continue;
    const role = msg.author.id === botId ? "assistant" : "user";
    const text = role === "user" ? `${msg.member?.nick || msg.author.global_name || msg.author.username}: ${msg.content.replace(new RegExp(`<@!?${botId}>`, "g"), "").trim()}` : msg.content;
    const prev = turns[turns.length - 1];
    if (prev.role === role) prev.content += `\n\n${text}`; // keep turns alternating
    else turns.push({ role, content: text });
  }
  if (turns[turns.length - 1].role !== "user") turns.push({ role: "user", content: "(continue)" });
  return turns;
}

function keepTyping(env, channel) {
  const ping = () => discordApi(env, `/channels/${channel}/typing`, { method: "POST" }).catch(() => {});
  ping();
  const timer = setInterval(ping, 8_000);
  return { stop: () => clearInterval(timer) };
}

function send(env, channel, content, replyTo) {
  return discordApi(env, `/channels/${channel}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: { parse: [], replied_user: false },
      ...(replyTo && { message_reference: { message_id: replyTo, fail_if_not_exists: false } }),
    }),
  }).catch((err) => console.error("send failed:", err));
}

// Split long answers on paragraph or line breaks to fit Discord's 2,000-character limit.
export function split(text, max = MAX_MESSAGE) {
  const parts = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
