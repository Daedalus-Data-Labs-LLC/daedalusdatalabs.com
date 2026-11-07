// GitHub webhook → short Discord messages.
//
// One summary line per event, with the technical details on a second line
// behind a Discord spoiler so viewers click to reveal them.

import { hmacHex, timingSafeEqual, postToDiscord } from "./util.js";
import { resolvePeople, rosterId, wants } from "./people.js";

const MAX_COMMITS = 5;

export async function handleGitHub(request, env) {
  const body = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";
  if (!(await verify(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
    return new Response("Bad signature", { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const event = request.headers.get("x-github-event");
  const targets = pingTargets(event, payload);
  const people = await resolvePeople(env.PEOPLE, [payload.sender?.login, ...involvedLogins(payload), ...targets.map((t) => t.login)]);
  const message = format(event, payload, nameResolver(people, !!env.PEOPLE));
  if (!message) return new Response("Ignored", { status: 202 });

  const { content, ping } = addPings(message, targets, people, payload.sender?.login);
  const res = await postToDiscord(env.DISCORD_WEBHOOK_URL, content, ping);
  if (!res.ok) return new Response(`Discord error ${res.status}`, { status: 502 });
  return new Response("Sent");
}

// ---------- signature ----------

export async function verify(secret, body, header) {
  if (!secret || !header.startsWith("sha256=")) return false;
  return timingSafeEqual("sha256=" + (await hmacHex(secret, body)), header);
}

// ---------- formatting ----------

// Text from GitHub goes inside spoilers and bold markers, so strip anything
// that would break them out or ping someone.
export function clean(text, max = 100) {
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

// A Discord mention renders as the person's current server name. Only the
// people chosen in addPings are actually pinged; every other mention is shown
// without a notification. People not in the roster are flagged "(unlinked)"
// so they get nudged to verify.
export function nameResolver(people, hasRoster) {
  return (login, type = "User") => {
    const person = login && people.get(login.toLowerCase());
    if (person) return `<@${person.id}>`;
    const plain = `**${clean(login)}**`;
    return hasRoster && type !== "Bot" ? `${plain} *(unlinked)*` : plain;
  };
}

export async function displayName(people, login, type = "User") {
  return nameResolver(await resolvePeople(people, [login]), !!people)(login, type);
}

export { rosterId };

// ---------- pings ----------

// Who should be pinged for this event, and which of their settings allows it.
export function pingTargets(event, p) {
  const t = [];
  const add = (login, pref) => login && t.push({ login, pref });
  const mentions = (text) => mentionedLogins(text).forEach((l) => add(l, "mentions"));

  switch (event) {
    case "pull_request":
      if (p.action === "review_requested") add(p.requested_reviewer?.login, "review_requests");
      if (p.action === "assigned") add(p.assignee?.login, "assignments");
      if (p.action === "closed") add(p.pull_request.user?.login, "my_work");
      if (p.action === "opened") mentions(p.pull_request.body);
      break;
    case "pull_request_review":
      if (p.action === "submitted") {
        add(p.pull_request.user?.login, "my_work");
        mentions(p.review.body);
      }
      break;
    case "issues":
      if (p.action === "assigned") add(p.assignee?.login, "assignments");
      if (p.action === "closed") add(p.issue.user?.login, "my_work");
      if (p.action === "opened") mentions(p.issue.body);
      break;
    case "issue_comment":
      if (p.action === "created") {
        add(p.issue.user?.login, "my_work");
        mentions(p.comment.body);
      }
      break;
  }
  return t;
}

// Other people named in the message itself.
function involvedLogins(p) {
  return [p.requested_reviewer?.login, p.assignee?.login];
}

// GitHub @mentions in free text. Skips emails (a@b.com) and team mentions (@org/team).
export function mentionedLogins(text) {
  const found = new Set();
  const re = /(?:^|[^\w`@./-])@([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38})(?![\w/-])/gi;
  for (const m of String(text ?? "").matchAll(re)) found.add(m[1]);
  return [...found].slice(0, 10);
}

// Picks who to ping (linked, setting on, not the person who did it) and makes
// sure each of them is mentioned on the summary line, since Discord only
// notifies people whose mention appears in the message.
export function addPings(message, targets, people, senderLogin) {
  const sender = senderLogin?.toLowerCase();
  const ping = [];
  for (const { login, pref } of targets) {
    const person = people.get(login.toLowerCase());
    if (!person || login.toLowerCase() === sender || ping.includes(person.id)) continue;
    if (wants(person, pref)) ping.push(person.id);
  }
  const missing = ping.filter((id) => !message.includes(`<@${id}>`));
  if (!missing.length) return { content: message, ping };
  const [head, ...rest] = message.split("\n");
  const bell = ` · 🔔 ${missing.map((id) => `<@${id}>`).join(" ")}`;
  return { content: [head + bell, ...rest].join("\n"), ping };
}

// `name` turns a GitHub login into how it's shown (a Discord mention or bold text).
export function format(event, p, name = (login) => `**${clean(login)}**`) {
  const repo = p.repository?.name ?? "";
  const who = name(p.sender?.login, p.sender?.type);

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
        case "review_requested": {
          const reviewer = p.requested_reviewer
            ? name(p.requested_reviewer.login, p.requested_reviewer.type)
            : `team ${code(p.requested_team?.name ?? "?")}`;
          return msg("🙋", `${who} requested a review from ${reviewer} on ${num}`, repo, details);
        }
        case "assigned":
          return msg("📋", `${who} assigned ${num} to ${assigneeName(p, name)}`, repo, details);
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
      if (p.action === "assigned") {
        return msg("📋", `${who} assigned issue #${i.number} to ${assigneeName(p, name)}`, repo,
          `**${clean(i.title)}** · ${link("View issue", i.html_url)}`);
      }
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

function assigneeName(p, name) {
  return p.assignee?.login === p.sender?.login ? "themselves" : name(p.assignee?.login, p.assignee?.type);
}

// A merge from GitHub's UI (merge, squash or rebase) shows up as a push by
// "web-flow" right after the PR merged event. Skip it to avoid duplicates.
function isMergeCommit(p) {
  const c = p.head_commit;
  if (!c || c.committer?.username !== "web-flow") return false;
  return /^Merge pull request #\d+/.test(c.message) || /\(#\d+\)\s*$/.test(c.message.split("\n")[0]);
}

