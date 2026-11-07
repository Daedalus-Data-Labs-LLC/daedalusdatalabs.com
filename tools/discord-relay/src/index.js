// Daedalus GitHub ↔ Discord Worker.
//
//   POST /                GitHub org webhook → short Discord messages (relay.js)
//   POST /discord         Discord interactions: the Verify GitHub button (discord.js)
//   GET  /auth/start      Verify: confirm, then hand off to GitHub sign-in (auth.js)
//   GET  /auth/callback   Verify: save the link and give the Verified role (auth.js)
//   every 15 minutes      Alert admins when a linked member leaves (sweep.js)
//   weekdays (see wrangler.toml)  Daily PR digest (digest.js)
//   GatewayBot Durable Object     Always-on Discord connection for @Daedalus questions (gateway.js, ask.js, agent.js)
//
// See README.md for the secrets each part needs.

import { handleGitHub } from "./relay.js";
import { handleInteraction } from "./discord.js";
import { authCallback, authStart } from "./auth.js";
import { sweep } from "./sweep.js";
import { postDigest } from "./digest.js";
import { ensureGateway } from "./gateway.js";

export { GatewayBot } from "./gateway.js";

const SWEEP_CRON = "*/15 * * * *";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === "POST" && (pathname === "/" || pathname === "/github")) return handleGitHub(request, env);
    if (method === "POST" && pathname === "/discord") {
      if (env.GATEWAY) ctx?.waitUntil?.(ensureGateway(env)); // any interaction also wakes the @Daedalus connection
      return handleInteraction(request, env, ctx);
    }
    if (method === "GET" && pathname === "/auth/start") return authStart(request, env);
    if (method === "GET" && pathname === "/auth/callback") return authCallback(request, env, ctx);
    return new Response("OK");
  },

  // Any cron other than the 15-minute sweep is the digest. The sweep also
  // checks that the @Daedalus connection is up, and restarts it if not.
  async scheduled(event, env, ctx) {
    if (event.cron === SWEEP_CRON) {
      ctx.waitUntil(sweep(env));
      ctx.waitUntil(ensureGateway(env));
    } else {
      ctx.waitUntil(postDigest(env));
    }
  },
};

export { format, verify, displayName } from "./relay.js";
