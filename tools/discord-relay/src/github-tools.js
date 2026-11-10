// Read-only GitHub tools for the @Daedalus assistant.
//
// Every tool is limited to repos in GITHUB_ORG and only reads. Results are
// trimmed so one answer can't flood the model's context, and anything that
// looks like a secret is masked before the model sees it.

const UA = "daedalus-discord-relay";
const MAX_FILE_CHARS = 12_000;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export const TOOLS = [
  {
    name: "list_repos",
    description: "List the organization's repositories, most recently updated first.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_code",
    description: "Search code across the organization's repositories. Returns matching file paths.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words or identifiers to look for" },
        repo: { type: "string", description: "Optional: limit to one repo name" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read a file from a repo, or list a directory's contents if the path is a folder. Use an empty path for the repo root.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name, without the organization" },
        path: { type: "string", description: "File or folder path, e.g. src/index.js" },
        ref: { type: "string", description: "Optional branch, tag or commit; defaults to the default branch" },
      },
      required: ["repo", "path"],
    },
  },
  {
    name: "search_issues",
    description: "Search issues and pull requests across the organization. Supports GitHub search syntax such as is:pr is:open author:name.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Search terms and filters" } },
      required: ["query"],
    },
  },
  {
    name: "get_issue_or_pr",
    description: "Get one issue or pull request with its description and recent comments. For PRs, also lists the changed files.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name" },
        number: { type: "integer", description: "Issue or PR number" },
      },
      required: ["repo", "number"],
    },
  },
  {
    name: "list_commits",
    description: "List recent commits in a repo, newest first.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "Repo name" },
        days: { type: "integer", description: "Optional: only commits from the last N days" },
        path: { type: "string", description: "Optional: only commits touching this path" },
      },
      required: ["repo"],
    },
  },
];

export async function runTool(env, name, args = {}) {
  const org = env.GITHUB_ORG || "Daedalus-Data-Labs-LLC";
  const gh = async (path, accept = "application/vnd.github+json") => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { accept, "user-agent": UA, ...(env.GITHUB_TOKEN && { authorization: `Bearer ${env.GITHUB_TOKEN}` }) },
    });
    if (res.status === 404) throw new ToolError("Not found (it may not exist, or the bot may not have access to it).");
    if (res.status === 401 || res.status === 403) throw new ToolError(`GitHub refused access (${res.status}). The bot's GITHUB_TOKEN may be missing or lack permission.`);
    if (!res.ok) throw new ToolError(`GitHub error ${res.status}.`);
    return accept.includes("raw") ? res.text() : res.json();
  };
  const repo = () => {
    if (!NAME.test(args.repo ?? "")) throw new ToolError("Give a repo name from this organization, e.g. from list_repos.");
    return `${org}/${args.repo}`;
  };
  const days = (n) => new Date(Date.now() - Math.min(Math.max(1, n), 365) * 86_400_000).toISOString();

  try {
    switch (name) {
      case "list_repos": {
        const list = await gh(`/orgs/${org}/repos?per_page=100&sort=pushed`);
        return list.map((r) => `${r.name}${r.private ? " (private)" : ""} · updated ${r.pushed_at?.slice(0, 10)} · ${r.description ?? ""}`).join("\n") || "No repos found.";
      }
      case "search_code": {
        const scope = args.repo ? `repo:${repo()}` : `org:${org}`;
        const q = encodeURIComponent(`${String(args.query ?? "").slice(0, 200)} ${scope}`);
        const r = await gh(`/search/code?q=${q}&per_page=10`);
        return r.items?.map((i) => `${i.repository.name}/${i.path} · ${i.html_url}`).join("\n") || "No matches.";
      }
      case "read_file": {
        const path = String(args.path ?? "").replace(/^\/+/, "");
        if (path.split("/").includes("..")) throw new ToolError("Paths can't contain '..'.");
        const encoded = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
        const ref = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
        const meta = await gh(`/repos/${repo()}/contents/${encoded}${ref}`);
        if (Array.isArray(meta)) return meta.map((e) => `${e.type === "dir" ? "📁" : "📄"} ${e.path}`).join("\n") || "Empty folder.";
        if (meta.type !== "file") return `${path} is a ${meta.type}, not a file.`;
        const text = await gh(`/repos/${repo()}/contents/${encoded}${ref}`, "application/vnd.github.raw+json");
        const cut = text.length > MAX_FILE_CHARS ? `\n\n[Truncated: showing ${MAX_FILE_CHARS} of ${text.length} characters]` : "";
        return `${meta.html_url}\n\n${text.slice(0, MAX_FILE_CHARS)}${cut}`;
      }
      case "search_issues": {
        const q = encodeURIComponent(`org:${org} ${String(args.query ?? "").slice(0, 200)}`);
        const r = await gh(`/search/issues?q=${q}&per_page=10&sort=updated`);
        return (
          r.items
            ?.map((i) => `${i.pull_request ? "PR" : "Issue"} ${i.repository_url.split("/").pop()}#${i.number} [${i.state}] ${i.title} · by ${i.user?.login} · updated ${i.updated_at.slice(0, 10)} · ${i.html_url}`)
            .join("\n") || "No matches."
        );
      }
      case "get_issue_or_pr": {
        const n = Number.parseInt(args.number, 10);
        if (!(n > 0)) throw new ToolError("Give an issue or PR number.");
        const i = await gh(`/repos/${repo()}/issues/${n}`);
        const comments = i.comments ? await gh(`/repos/${repo()}/issues/${n}/comments?per_page=100`) : [];
        const lines = [
          `${i.pull_request ? "PR" : "Issue"} #${n}: ${i.title} [${i.state}] · by ${i.user?.login} · ${i.html_url}`,
          `Labels: ${i.labels?.map((l) => l.name).join(", ") || "none"} · Assignees: ${i.assignees?.map((a) => a.login).join(", ") || "none"}`,
          "",
          (i.body ?? "(no description)").slice(0, 3000),
        ];
        if (i.pull_request) {
          const pr = await gh(`/repos/${repo()}/pulls/${n}`);
          const files = await gh(`/repos/${repo()}/pulls/${n}/files?per_page=50`);
          lines.push("", `Branch ${pr.head?.ref} → ${pr.base?.ref} · ${pr.merged ? "merged" : pr.draft ? "draft" : pr.state} · +${pr.additions}/−${pr.deletions}`);
          lines.push("Files:", ...files.map((f) => `- ${f.filename} (+${f.additions}/−${f.deletions})`));
        }
        if (comments.length) {
          lines.push("", "Recent comments:");
          for (const c of comments.slice(-10)) lines.push(`- ${c.user?.login}: ${c.body.slice(0, 500)}`);
        }
        return lines.join("\n");
      }
      case "list_commits": {
        const params = new URLSearchParams({ per_page: "20" });
        if (args.days) params.set("since", days(Number(args.days)));
        if (args.path) params.set("path", String(args.path));
        const list = await gh(`/repos/${repo()}/commits?${params}`);
        return list.map((c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]} · ${c.author?.login ?? c.commit.author?.name} · ${c.commit.author?.date?.slice(0, 10)} · ${c.html_url}`).join("\n") || "No commits found.";
      }
      default:
        throw new ToolError(`Unknown tool: ${name}`);
    }
  } catch (err) {
    if (err instanceof ToolError) return { error: err.message };
    return { error: "The GitHub request failed. Try again in a moment." };
  }
}

export class ToolError extends Error {}

// Mask anything that looks like a credential, in tool output and in answers.
const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,}/g, // Discord bot tokens
];

export function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}
