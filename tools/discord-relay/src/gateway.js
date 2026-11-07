// Always-on Discord connection, so the bot can see "@Daedalus" mentions.
//
// Discord only delivers ordinary messages over its Gateway (a WebSocket the
// bot keeps open), not to the Worker's HTTP endpoint. A single Durable Object
// ("main") holds that socket. Heartbeats run on Durable Object alarms, which
// also bring the connection back if Cloudflare restarts the object.
//
// Free-plan budget: one object kept awake around the clock uses about 10,800
// of the 13,000 GB-seconds Cloudflare allows per day.

import { handleMessage } from "./ask.js";

const GATEWAY = "https://gateway.discord.gg/?v=10&encoding=json";
// GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT (privileged: turn it on in the Developer Portal)
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, ACK: 11 };
const RETRY_MS = 5_000;

export class GatewayBot {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.ws = null;
    this.acked = true;
    this.interval = 41_250;
  }

  // Called by the Worker (cron and every interaction) to make sure we're connected.
  async fetch(request) {
    if (new URL(request.url).pathname === "/status") {
      const s = (await this.ctx.storage.get("session")) ?? {};
      return Response.json({ connected: !!this.ws, user: s.user ?? null });
    }
    await this.ensure();
    return new Response("ok");
  }

  async alarm() {
    if (!this.ws) return this.connect();
    if (!this.acked) return this.reconnect("no heartbeat ack"); // zombie connection
    this.acked = false;
    this.send({ op: OP.HEARTBEAT, d: (await this.ctx.storage.get("seq")) ?? null });
    await this.ctx.storage.setAlarm(Date.now() + this.interval);
  }

  async ensure() {
    if (this.ws) return;
    if (!this.env.DISCORD_BOT_TOKEN) return;
    await this.connect();
  }

  async connect() {
    if (this.connecting) return;
    this.connecting = true;
    try {
      const session = (await this.ctx.storage.get("session")) ?? {};
      const base = session.resumeUrl ? `${session.resumeUrl}/?v=10&encoding=json` : GATEWAY;
      const res = await fetch(base.replace(/^wss:/, "https:"), { headers: { Upgrade: "websocket" } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`Gateway refused the connection (${res.status})`);
      ws.accept();
      this.ws = ws;
      this.acked = true;
      ws.addEventListener("message", (e) => this.onMessage(e.data).catch((err) => console.error("gateway:", err)));
      ws.addEventListener("close", (e) => this.onClose(e.code));
      ws.addEventListener("error", () => this.onClose(0));
    } catch (err) {
      console.error("gateway connect failed:", err);
      this.ws = null;
      await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
    } finally {
      this.connecting = false;
    }
  }

  async reconnect(why) {
    console.log("gateway reconnect:", why);
    try {
      this.ws?.close(4000, why);
    } catch {}
    this.ws = null;
    await this.ctx.storage.setAlarm(Date.now() + 1_000);
  }

  async onClose(code) {
    this.ws = null;
    // 4004 bad token, 4013/4014 invalid or disallowed intents: retrying won't help.
    if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) {
      console.error(`gateway closed with ${code}; not reconnecting until the next cron check`);
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // 4007 bad sequence, 4009 session timed out: start a fresh session.
    if ([4007, 4009].includes(code)) await this.ctx.storage.delete("session");
    await this.ctx.storage.setAlarm(Date.now() + RETRY_MS);
  }

  send(payload) {
    try {
      this.ws?.send(JSON.stringify(payload));
    } catch (err) {
      console.error("gateway send failed:", err);
    }
  }

  async onMessage(raw) {
    const msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    if (msg.s != null) await this.ctx.storage.put("seq", msg.s);

    switch (msg.op) {
      case OP.HELLO: {
        this.interval = msg.d.heartbeat_interval;
        const session = (await this.ctx.storage.get("session")) ?? {};
        const seq = await this.ctx.storage.get("seq");
        if (session.id && seq != null) {
          this.send({ op: OP.RESUME, d: { token: this.env.DISCORD_BOT_TOKEN, session_id: session.id, seq } });
        } else {
          this.send({
            op: OP.IDENTIFY,
            d: { token: this.env.DISCORD_BOT_TOKEN, intents: INTENTS, properties: { os: "cloudflare", browser: "daedalus", device: "daedalus" } },
          });
        }
        // First heartbeat at a random point in the interval, as Discord asks.
        await this.ctx.storage.setAlarm(Date.now() + Math.floor(this.interval * Math.random()));
        return;
      }
      case OP.ACK:
        this.acked = true;
        return;
      case OP.HEARTBEAT:
        this.send({ op: OP.HEARTBEAT, d: (await this.ctx.storage.get("seq")) ?? null });
        return;
      case OP.RECONNECT:
        return this.reconnect("Discord asked us to reconnect");
      case OP.INVALID_SESSION:
        if (!msg.d) await this.ctx.storage.delete(["session", "seq"]);
        return this.reconnect("invalid session");
      case OP.DISPATCH:
        return this.onEvent(msg.t, msg.d);
    }
  }

  async onEvent(type, d) {
    if (type === "READY") {
      await this.ctx.storage.put("session", { id: d.session_id, resumeUrl: d.resume_gateway_url, user: { id: d.user.id, name: d.user.username } });
      return;
    }
    if (type === "MESSAGE_CREATE") {
      const session = (await this.ctx.storage.get("session")) ?? {};
      if (!session.user) return;
      // Don't hold up the socket: answering can take a while.
      handleMessage(d, { env: this.env, storage: this.ctx.storage, botId: session.user.id }).catch((err) =>
        console.error("ask failed:", err),
      );
    }
  }
}

// From the Worker: wake the gateway object (it connects if it isn't already).
export function ensureGateway(env) {
  if (!env.GATEWAY || !env.DISCORD_BOT_TOKEN) return Promise.resolve();
  const stub = env.GATEWAY.get(env.GATEWAY.idFromName("main"));
  return stub.fetch("https://gateway/ensure").catch((err) => console.error("ensureGateway:", err));
}
