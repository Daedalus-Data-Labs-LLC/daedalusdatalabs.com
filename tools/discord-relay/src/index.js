// Daedalus GitHub ↔ Discord Worker.
//
//   POST /                GitHub org webhook → short Discord messages (relay.js)
//   POST /discord         Discord interactions: the Verify GitHub button (discord.js)
//   GET  /auth/start      Verify: confirm, then hand off to GitHub sign-in (auth.js)
//   GET  /auth/callback   Verify: save the link and give the Verified role (auth.js)
//   every 15 minutes      Alert admins when a linked member leaves (sweep.js)
//
// See README.md for the secrets each part needs.

import { handleGitHub } from "./relay.js";
import { handleInteraction } from "./discord.js";
import { authCallback, authStart } from "./auth.js";
import { sweep } from "./sweep.js";

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const { method } = request;

    if (method === "POST" && (pathname === "/" || pathname === "/github")) return handleGitHub(request, env);
    if (method === "POST" && pathname === "/discord") return handleInteraction(request, env);
    if (method === "GET" && pathname === "/auth/start") return authStart(request, env);
    if (method === "GET" && pathname === "/auth/callback") return authCallback(request, env, ctx);
    return new Response("OK");
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweep(env));
  },
};

export { format, verify, displayName } from "./relay.js";
