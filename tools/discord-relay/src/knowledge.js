// The knowledge index: searchable copies of the org's code and docs, plus the
// team's saved decisions, in Cloudflare Vectorize (binding KB).
//
// Files are split into chunks, turned into embeddings with the small
// bge-small model (about 0.002 Neurons per token), and stored with the text
// and a link back to GitHub. Pushes to a repo's default branch re-index only
// the files that changed; /reindex rebuilds everything. All indexing runs as
// jobs inside the Brain.
//
// Answers search the index first, so the AI starts from the right excerpts
// instead of making several GitHub calls.

import { aiRun, estimateNeurons, estimateTokens } from "./budget.js";
import { redact } from "./github-tools.js";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5";
const CHUNK_CHARS = 1200;
const OVERLAP_LINES = 2;
const MAX_FILE_BYTES = 100_000;
const EMBED_BATCH = 50;
const MIN_SCORE = 0.55;
const UA = "daedalus-discord-relay";

const TEXT_FILE = /\.(md|mdx|txt|rst|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|cs|php|swift|html|css|scss|toml|ya?ml|sql|sh|json)$|(^|\/)(README|LICENSE|Dockerfile|Makefile|CLAUDE)(\.\w+)?$/i;
const SKIP = /(^|\/)(node_modules|dist|build|vendor|coverage|\.git|\.wrangler|\.next)\/|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.min\.(js|css)$|\.map$/i;

export const indexable = (path, size = 0) => TEXT_FILE.test(path) && !SKIP.test(path) && size <= MAX_FILE_BYTES;

// ---------- chunking ----------

// Splits on line boundaries into ~1,200-character chunks that overlap by two
// lines, so a function cut in half still has context on both sides.
export function chunk(text) {
  const lines = text.split("\n");
  const chunks = [];
  let start = 0;
  while (start < lines.length) {
    let end = start;
    let size = 0;
    while (end < lines.length && (size === 0 || size + lines[end].length + 1 <= CHUNK_CHARS)) size += lines[end++].length + 1;
    const body = lines.slice(start, end).join("\n");
    if (body.trim()) chunks.push({ text: body.slice(0, CHUNK_CHARS * 2), from: start + 1, to: end });
    if (end >= lines.length) break;
    start = Math.max(end - OVERLAP_LINES, start + 1);
  }
  return chunks;
}

export async function vectorId(key) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(hash)].slice(0, 20).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function embed(env, texts, record) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const out = record
      ? await env.AI.run(EMBED_MODEL, { text: batch, pooling: "cls" }).then((o) => {
          record(estimateNeurons(EMBED_MODEL, estimateTokens(batch.join(" "))));
          return o;
        })
      : await aiRun(env, EMBED_MODEL, { text: batch, pooling: "cls" }, { kind: "embed" });
    vectors.push(...out.data);
  }
  return vectors;
}

// ---------- jobs (run inside the Brain) ----------

// Returns "deferred" when today's indexing budget is used up.
export async function runJob(env, { kind, payload }, api) {
  if (!env.KB || !env.AI) return "done";
  switch (kind) {
    case "index_file":
      return indexFile(env, payload, api);
    case "delete_file":
      await deleteFile(env, payload, api);
      return "done";
    case "reindex_repo":
      await reindexRepo(env, payload, api);
      return "done";
    case "reindex_all":
      await reindexAll(env, api);
      return "done";
    default:
      return "done";
  }
}

function github(env) {
  return async (path, raw = false) => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
        "user-agent": UA,
        ...(env.GITHUB_TOKEN && { authorization: `Bearer ${env.GITHUB_TOKEN}` }),
      },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return raw ? res.text() : res.json();
  };
}

const org = (env) => env.GITHUB_ORG || "Daedalus-Data-Labs-LLC";
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

async function indexFile(env, { repo, path, sha }, api) {
  const known = api.getFile(repo, path);
  if (sha && known?.sha === sha) return "done"; // unchanged

  const gh = github(env);
  const meta = await gh(`/repos/${org(env)}/${repo}/contents/${encodePath(path)}`);
  if (!meta || meta.type !== "file" || !indexable(path, meta.size)) {
    await deleteFile(env, { repo, path }, api);
    return "done";
  }
  if (known?.sha === meta.sha) return "done";
  if (!api.allow("index")) return "deferred";

  const text = await gh(`/repos/${org(env)}/${repo}/contents/${encodePath(path)}`, true);
  if (text == null || text.includes("\u0000")) {
    await deleteFile(env, { repo, path }, api);
    return "done";
  }

  const chunks = chunk(redact(text));
  const vectors = await embed(env, chunks.map((c) => `${repo}/${path}\n${c.text}`), (n) => api.record("index", n));
  const records = await Promise.all(
    chunks.map(async (c, i) => ({
      id: await vectorId(`code:${repo}/${path}#${i}`),
      values: vectors[i],
      metadata: {
        kind: "code",
        repo,
        path,
        lines: `${c.from}-${c.to}`,
        url: `${meta.html_url}#L${c.from}-L${c.to}`,
        text: c.text.slice(0, 2000),
      },
    })),
  );
  for (let i = 0; i < records.length; i += 100) await env.KB.upsert(records.slice(i, i + 100));

  // Remove chunks left over from a longer previous version.
  const stale = [];
  for (let i = chunks.length; i < (known?.chunks ?? 0); i++) stale.push(await vectorId(`code:${repo}/${path}#${i}`));
  if (stale.length) await env.KB.deleteByIds(stale);

  api.setFile(repo, path, meta.sha, chunks.length);
  return "done";
}

async function deleteFile(env, { repo, path }, api) {
  const known = api.getFile(repo, path);
  if (!known) return;
  const ids = [];
  for (let i = 0; i < known.chunks; i++) ids.push(await vectorId(`code:${repo}/${path}#${i}`));
  if (ids.length) await env.KB.deleteByIds(ids);
  api.deleteFile(repo, path);
}

async function reindexRepo(env, { repo }, api) {
  const gh = github(env);
  const info = await gh(`/repos/${org(env)}/${repo}`);
  if (!info || info.archived) return;
  const tree = await gh(`/repos/${org(env)}/${repo}/git/trees/${encodeURIComponent(info.default_branch)}?recursive=1`);
  const files = (tree?.tree ?? []).filter((e) => e.type === "blob" && indexable(e.path, e.size));
  const present = new Set(files.map((f) => f.path));

  const jobs = files.map((f) => ({ kind: "index_file", payload: { repo, path: f.path, sha: f.sha }, dedupe: `file:${repo}/${f.path}` }));
  for (const old of api.filesIn(repo)) {
    if (!present.has(old.path)) jobs.push({ kind: "delete_file", payload: { repo, path: old.path }, dedupe: `file:${repo}/${old.path}` });
  }
  await api.enqueue(jobs);
}

async function reindexAll(env, api) {
  const repos = await github(env)(`/orgs/${org(env)}/repos?per_page=100&type=all`);
  await api.enqueue((repos ?? []).filter((r) => !r.archived).map((r) => ({ kind: "reindex_repo", payload: { repo: r.name }, dedupe: `repo:${r.name}` })));
}

// From a push webhook: index changed files on the default branch, drop removed ones.
export function jobsForPush(payload) {
  if (payload.ref !== `refs/heads/${payload.repository?.default_branch}`) return [];
  const repo = payload.repository.name;
  const latest = new Map(); // path -> "index" | "delete", last change wins
  for (const c of payload.commits ?? []) {
    for (const p of [...(c.added ?? []), ...(c.modified ?? [])]) latest.set(p, "index");
    for (const p of c.removed ?? []) latest.set(p, "delete");
  }
  return [...latest]
    .filter(([path, action]) => action === "delete" || indexable(path))
    .map(([path, action]) => ({ kind: action === "index" ? "index_file" : "delete_file", payload: { repo, path }, dedupe: `file:${repo}/${path}` }));
}

// ---------- decisions ----------

export async function indexDecision(env, d) {
  if (!env.KB || !env.AI) return;
  const [values] = await embed(env, [d.text]);
  await env.KB.upsert([
    {
      id: await vectorId(`decision:${d.id}`),
      values,
      metadata: {
        kind: "decision",
        decision: d.id,
        text: String(d.text).slice(0, 2000),
        author: d.authorName ?? "",
        date: new Date(d.createdAt ?? Date.now()).toISOString().slice(0, 10),
        url: d.sourceUrl ?? "",
      },
    },
  ]);
}

export async function removeDecision(env, id) {
  if (env.KB) await env.KB.deleteByIds([await vectorId(`decision:${id}`)]);
}

// ---------- search ----------

export async function retrieve(env, query, { k = 5, decisionsOnly = false } = {}) {
  if (!env.KB || !env.AI || !String(query).trim()) return [];
  const [vector] = await embed(env, [String(query).slice(0, 2000)]);
  const res = await env.KB.query(vector, { topK: k, returnMetadata: "all", ...(decisionsOnly && { filter: { kind: "decision" } }) });
  return (res.matches ?? []).filter((m) => m.score >= MIN_SCORE && m.metadata).map((m) => ({ ...m.metadata, score: m.score }));
}

export function formatHits(hits) {
  if (!hits.length) return "Nothing relevant found in the knowledge index.";
  return hits
    .map((h) =>
      h.kind === "decision"
        ? `📌 Team decision (${h.date}${h.author ? `, ${h.author}` : ""})${h.url ? ` ${h.url}` : ""}:\n${h.text}`
        : `📄 ${h.repo}/${h.path} lines ${h.lines} · ${h.url}\n${h.text}`,
    )
    .join("\n\n---\n\n");
}
