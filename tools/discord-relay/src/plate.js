// "What's on my plate?": one person's open GitHub work, in one message.
// Plain GitHub lookups, no AI, so it's free and instant.

import { classify } from "./digest.js";
import { clean } from "./relay.js";

const UA = "daedalus-discord-relay";
const MAX_MINE = 10;

export async function plate(env, login) {
  const org = env.GITHUB_ORG || "Daedalus-Data-Labs-LLC";
  const gh = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": UA, ...(env.GITHUB_TOKEN && { authorization: `Bearer ${env.GITHUB_TOKEN}` }) },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    return res.json();
  };
  const search = (q) => gh(`/search/issues?q=${encodeURIComponent(`org:${org} ${q}`)}&per_page=20&sort=updated`).then((r) => r.items ?? []);

  const [toReview, mine, issues] = await Promise.all([
    search(`is:pr is:open review-requested:${login}`),
    search(`is:pr is:open author:${login}`),
    search(`is:issue is:open assignee:${login}`),
  ]);

  // Sort my open PRs by what they're waiting on.
  const groups = { changes: [], ready: [], waiting: [], draft: [] };
  for (const item of mine.slice(0, MAX_MINE)) {
    const repo = item.repository_url.split("/").slice(-2).join("/");
    try {
      const [pr, reviews] = await Promise.all([gh(`/repos/${repo}/pulls/${item.number}`), gh(`/repos/${repo}/pulls/${item.number}/reviews?per_page=100`)]);
      const { status } = classify(pr, reviews);
      (groups[status === "review" || status === "unassigned" ? "waiting" : status] ?? groups.waiting).push(item);
    } catch {
      groups.waiting.push(item);
    }
  }

  const line = (i) => `• [${i.repository_url.split("/").pop()}#${i.number}](${i.html_url}) ${clean(i.title, 70)}`;
  const section = (title, items) => (items.length ? [`**${title}**`, ...items.map(line)] : []);
  const lines = [
    ...section("👀 Waiting on your review", toReview),
    ...section("✏️ Changes requested on your PRs", groups.changes),
    ...section("✅ Your PRs approved, ready to merge", groups.ready),
    ...section("⏳ Your PRs waiting on others", groups.waiting),
    ...section("📝 Your drafts", groups.draft),
    ...section("📋 Issues assigned to you", issues),
  ];
  if (!lines.length) return `✨ Nothing on your plate in GitHub right now, **${clean(login)}**.`;
  return `**On your plate** (GitHub: ${clean(login)})\n${lines.join("\n")}`.slice(0, 1990);
}
