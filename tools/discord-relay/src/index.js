// GitHub → Discord relay (Cloudflare Worker).
//
// Receives the org-level GitHub webhook, verifies its signature, and posts a
// one-line summary to Discord. The technical details sit on a second line
// behind a Discord spoiler, so viewers click to reveal them.
//
// Secrets (set with `wrangler secret put`):
//   GITHUB_WEBHOOK_SECRET  the secret entered on the GitHub webhook
//   DISCORD_WEBHOOK_URL    the Discord channel webhook URL (without /github)
//
// Optional KV binding PEOPLE maps GitHub logins (lowercase keys) to Discord
// user IDs, so messages show people's Discord names. Unmapped people show
// their GitHub login.

const MAX_COMMITS = 5;
const MAX_LEN = 2000; // Discord message limit
const SUPPRESS_EMBEDS = 1 << 2; // stops GitHub link previews from bloating messages

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return new Response("OK");

    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256") || "";
    if (!(await verify(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
      return new Response("Bad signature", { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Bad JSON", { status: 400 });
    }

    const who = await displayName(env.PEOPLE, payload.sender?.login);
    const message = format(event, payload, who);
    if (!message) return new Response("Ignored", { status: 202 });

    const res = await fetch(env.DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: message.slice(0, MAX_LEN),
        flags: SUPPRESS_EMBEDS,
        allowed_mentions: { parse: [] }, // never ping @everyone or users
      }),
    });
    if (!res.ok) {
      return new Response(`Discord error ${res.status}`, { status: 502 });
    }
    return new Response("Sent");
  },
};

// ---------- signature ----------

async function verify(secret, body, header) {
  if (!secret || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = "sha256=" + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, header);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------- formatting ----------

// Text from GitHub goes inside spoilers and bold markers, so strip anything
// that would break them out or ping someone.
function clean(text, max = 100) {
  const line = String(text ?? "").split("\n")[0].trim();
  const safe = line.replace(/\|\|/g, "| |").replace(/[*_`~]/g, "\\$&").replace(/@/g, "@\u200b");
  return safe.length > max ? safe.slice(0, max - 1) + "…" : safe;
}

// Inline code: markdown escapes would show literally, so only drop what breaks out.
function code(text) {
  return "`" + String(text ?? "").replace(/`/g, "'").replace(/\|\|/g, "| |") + "`";
}

const link = (label, url) => `[${label}](${url})`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Summary line + spoilered details line.
function msg(icon, summary, repo, details) {
  const head = `${icon} ${summary} · *${clean(repo)}*`;
  return details ? `${head}\n||${details}||` : head;
}

// A Discord mention renders as the person's current server name. It never
// pings them, because every message sets allowed_mentions to none.
async function displayName(people, login) {
  if (people && login) {
    try {
      // Value is the Discord user ID, optionally followed by a note (e.g. a name).
      const id = (await people.get(login.toLowerCase()))?.trim().split(/\s+/)[0];
      if (id && /^\d{17,20}$/.test(id)) return `<@${id}>`;
    } catch {
      // KV unavailable: fall back to the GitHub login.
    }
  }
  return `**${clean(login)}**`;
}

function format(event, p, who = `**${clean(p.sender?.login)}**`) {
  const repo = p.repository?.name ?? "";

  switch (event) {
    case "push": {
      if (p.deleted) return null; // covered by the "delete" event
      if (p.created && !p.commits?.length) return null; // covered by "create"
      if (isMergeCommit(p)) return null; // covered by the "pull_request merged" event
      const branch = p.ref.replace(/^refs\/(heads|tags)\//, "");
      const commits = p.commits ?? [];
      const lines = commits
        .slice(-MAX_COMMITS)
        .map((c) => `\`${c.id.slice(0, 7)}\` ${clean(c.message, 80)}`);
      if (commits.length > MAX_COMMITS) lines.unshift(`…and ${commits.length - MAX_COMMITS} earlier`);
      lines.push(link("Compare", p.compare));
      const forced = p.forced ? " (force-push)" : "";
      return msg("📌", `${who} pushed ${plural(commits.length, "commit")} to ${code(branch)}${forced}`, repo, lines.join("\n"));
    }

    case "pull_request": {
      const pr = p.pull_request;
      const num = `PR #${pr.number}`;
      const details =
        `**${clean(pr.title)}** · ${code(pr.head.ref)} → ${code(pr.base.ref)} · ` +
        `${plural(pr.commits ?? 0, "commit")} · +${pr.additions ?? 0} / −${pr.deletions ?? 0} · ` +
        `${plural(pr.changed_files ?? 0, "file")} · ${link("View PR", pr.html_url)}`;
      switch (p.action) {
        case "opened":
          return msg("🆕", `${who} opened ${pr.draft ? "draft " : ""}${num}`, repo, details);
        case "ready_for_review":
          return msg("👀", `${who} marked ${num} ready for review`, repo, details);
        case "reopened":
          return msg("🔁", `${who} reopened ${num}`, repo, details);
        case "closed":
          return pr.merged
            ? msg("🔀", `${who} merged ${num} into ${code(pr.base.ref)}`, repo, details)
            : msg("🚫", `${who} closed ${num} without merging`, repo, details);
        default:
          return null;
      }
    }

    case "pull_request_review": {
      if (p.action !== "submitted") return null;
      const r = p.review;
      const verbs = { approved: ["✅", "approved"], changes_requested: ["✏️", "requested changes on"], commented: ["💬", "reviewed"] };
      const [icon, verb] = verbs[r.state] ?? ["💬", "reviewed"];
      const body = r.body ? `${clean(r.body, 200)} · ` : "";
      return msg(icon, `${who} ${verb} PR #${p.pull_request.number}`, repo,
        `**${clean(p.pull_request.title)}** · ${body}${link("View review", r.html_url)}`);
    }

    case "issues": {
      const i = p.issue;
      const actions = { opened: "🐛 opened", closed: "☑️ closed", reopened: "🔁 reopened" };
      if (!actions[p.action]) return null;
      const [icon, verb] = actions[p.action].split(" ");
      return msg(icon, `${who} ${verb} issue #${i.number}`, repo,
        `**${clean(i.title)}** · ${link("View issue", i.html_url)}`);
    }

    case "issue_comment": {
      if (p.action !== "created") return null;
      const kind = p.issue.pull_request ? "PR" : "issue";
      return msg("💬", `${who} commented on ${kind} #${p.issue.number}`, repo,
        `**${clean(p.issue.title)}** · ${clean(p.comment.body, 200)} · ${link("View comment", p.comment.html_url)}`);
    }

    case "create":
    case "delete": {
      const verb = event === "create" ? "created" : "deleted";
      const icon = event === "create" ? "🌱" : "🗑️";
      return msg(icon, `${who} ${verb} ${p.ref_type} ${code(p.ref)}`, repo, null);
    }

    case "release": {
      if (p.action !== "published") return null;
      const r = p.release;
      return msg("🚀", `${who} published release ${code(r.tag_name)}`, repo,
        `**${clean(r.name || r.tag_name)}** · ${link("View release", r.html_url)}`);
    }

    case "repository": {
      if (p.action !== "created") return null;
      return msg("📦", `${who} created repo`, repo, link("View repo", p.repository.html_url));
    }

    default:
      return null; // ping and anything unhandled
  }
}

// A merge from GitHub's UI (merge, squash or rebase) shows up as a push by
// "web-flow" right after the PR merged event. Skip it to avoid duplicates.
function isMergeCommit(p) {
  const c = p.head_commit;
  if (!c || c.committer?.username !== "web-flow") return false;
  return /^Merge pull request #\d+/.test(c.message) || /\(#\d+\)\s*$/.test(c.message.split("\n")[0]);
}

export { format, verify, displayName };
