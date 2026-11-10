// The Brain: one Durable Object ("brain") with a built-in SQLite database.
//
// It stores the team's data (decisions log, reminders, settings, AI usage, the
// knowledge-index bookkeeping) and does the slow work on its own alarms:
// sending reminders and indexing files. Durable Objects get 30 seconds of CPU
// per request or alarm even on the free plan, unlike plain Worker requests
// (10 ms), and it's only awake for the seconds that work takes.
//
// Everything else talks to it with brainCall(env, "method", args) (budget.js).

import { PRIORITY_SHARE, dailyBudget, utcDay } from "./budget.js";
import { alertAdmins, discordApi } from "./util.js";
import { runJob } from "./knowledge.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (day TEXT NOT NULL, kind TEXT NOT NULL, neurons REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind));
CREATE TABLE IF NOT EXISTS decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, author_id TEXT, author_name TEXT, saved_by TEXT, source_url TEXT, message_id TEXT UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, channel_id TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL, source_url TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due_at);
CREATE TABLE IF NOT EXISTS settings (user_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS kb_files (repo TEXT NOT NULL, path TEXT NOT NULL, sha TEXT, chunks INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER, PRIMARY KEY (repo, path));
CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, payload TEXT NOT NULL, dedupe TEXT UNIQUE, attempts INTEGER NOT NULL DEFAULT 0, run_after INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

const JOBS_PER_ALARM = 8;
const ALARM_WORK_MS = 20_000;
const RETRY_MS = 60_000;

export class Brain {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) this.sql.exec(stmt);
  }

  // ---------- RPC ----------

  async fetch(request) {
    let method;
    try {
      const body = await request.json();
      method = body.method;
      const fn = this.methods()[method];
      if (!fn) return Response.json({ error: `Unknown Brain method: ${method}` });
      return Response.json({ result: (await fn(body.args ?? {})) ?? null });
    } catch (err) {
      console.error(`brain ${method}:`, err);
      return Response.json({ error: err.message || "Brain error" });
    }
  }

  methods() {
    return {
      "usage.record": ({ kind, neurons }) => this.recordUsage(kind, neurons),
      "usage.today": () => this.usageToday(),
      "budget.allow": ({ priority }) => this.allow(priority),

      "decisions.add": (d) => this.addDecision(d),
      "decisions.list": ({ limit = 15 }) => this.rows("SELECT * FROM decisions ORDER BY id DESC LIMIT ?", limit),
      "decisions.get": ({ id }) => this.rows("SELECT * FROM decisions WHERE id = ?", id)[0] ?? null,
      "decisions.delete": ({ id }) => this.sql.exec("DELETE FROM decisions WHERE id = ?", id).rowsWritten > 0,

      "reminders.add": (r) => this.addReminder(r),
      "reminders.list": ({ userId }) => this.rows("SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at LIMIT 25", userId),
      "reminders.cancel": ({ id, userId }) => this.sql.exec("DELETE FROM reminders WHERE id = ? AND user_id = ?", id, userId).rowsWritten > 0,

      "settings.get": ({ userId, key }) => this.rows("SELECT value FROM settings WHERE user_id = ? AND key = ?", userId, key)[0]?.value ?? null,
      "settings.set": ({ userId, key, value }) => {
        this.sql.exec("INSERT INTO settings (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value", userId, key, value);
        return true;
      },

      "jobs.enqueue": ({ jobs, reindex }) => this.enqueue(jobs, { reindex }),
      "stats": () => this.stats(),
    };
  }

  // ---------- usage and budget ----------

  recordUsage(kind, neurons) {
    this.sql.exec(
      "INSERT INTO usage (day, kind, neurons, calls) VALUES (?, ?, ?, 1) ON CONFLICT (day, kind) DO UPDATE SET neurons = neurons + excluded.neurons, calls = calls + 1",
      utcDay(),
      kind,
      Number(neurons) || 0,
    );
    return true;
  }

  usageToday() {
    const byKind = Object.fromEntries(this.rows("SELECT kind, neurons, calls FROM usage WHERE day = ?", utcDay()).map((r) => [r.kind, { neurons: r.neurons, calls: r.calls }]));
    const total = Object.values(byKind).reduce((s, k) => s + k.neurons, 0);
    return { day: utcDay(), total, budget: dailyBudget(this.env), byKind };
  }

  allow(priority) {
    const { total, budget } = this.usageToday();
    const share = PRIORITY_SHARE[priority] ?? 0.5;
    return { ok: total < budget * share, used: total, limit: budget * share };
  }

  // ---------- decisions ----------

  addDecision({ text, authorId, authorName, savedBy, sourceUrl, messageId }) {
    if (messageId) {
      const existing = this.rows("SELECT id FROM decisions WHERE message_id = ?", messageId)[0];
      if (existing) return { id: existing.id, created: false };
    }
    this.sql.exec(
      "INSERT INTO decisions (text, author_id, author_name, saved_by, source_url, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      String(text).slice(0, 4000), authorId ?? null, authorName ?? null, savedBy ?? null, sourceUrl ?? null, messageId ?? null, Date.now(),
    );
    return { id: this.rows("SELECT last_insert_rowid() AS id")[0].id, created: true };
  }

  // ---------- reminders ----------

  async addReminder({ userId, channelId, text, dueAt, sourceUrl }) {
    this.sql.exec(
      "INSERT INTO reminders (user_id, channel_id, text, due_at, source_url, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      userId, channelId, String(text).slice(0, 1000), dueAt, sourceUrl ?? null, Date.now(),
    );
    const id = this.rows("SELECT last_insert_rowid() AS id")[0].id;
    await this.schedule();
    return id;
  }

  // ---------- jobs ----------

  // Jobs with the same dedupe key replace each other, so a file pushed five
  // times before it's indexed is indexed once.
  async enqueue(jobs = [], { reindex = false } = {}) {
    const now = Date.now();
    for (const job of jobs) {
      const dedupe = job.dedupe ?? null;
      if (dedupe) this.sql.exec("DELETE FROM jobs WHERE dedupe = ?", dedupe);
      this.sql.exec("INSERT INTO jobs (kind, payload, dedupe, created_at) VALUES (?, ?, ?, ?)", job.kind, JSON.stringify(job.payload ?? {}), dedupe, now);
    }
    if (reindex) this.sql.exec("INSERT INTO meta (key, value) VALUES ('reindex', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(now));
    await this.schedule();
    return jobs.length;
  }

  stats() {
    const one = (q, ...a) => this.rows(q, ...a)[0];
    return {
      files: one("SELECT COUNT(*) AS n FROM kb_files WHERE chunks > 0").n,
      chunks: one("SELECT COALESCE(SUM(chunks), 0) AS n FROM kb_files").n,
      decisions: one("SELECT COUNT(*) AS n FROM decisions").n,
      reminders: one("SELECT COUNT(*) AS n FROM reminders").n,
      jobs: one("SELECT COUNT(*) AS n FROM jobs").n,
      usage: this.usageToday(),
    };
  }

  // Helpers the knowledge jobs use (they run inside this object).
  api() {
    return {
      record: (kind, neurons) => this.recordUsage(kind, neurons),
      allow: (priority) => this.allow(priority).ok,
      enqueue: (jobs) => this.enqueue(jobs),
      getFile: (repo, path) => this.rows("SELECT * FROM kb_files WHERE repo = ? AND path = ?", repo, path)[0] ?? null,
      setFile: (repo, path, sha, chunks) =>
        this.sql.exec(
          "INSERT INTO kb_files (repo, path, sha, chunks, indexed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (repo, path) DO UPDATE SET sha = excluded.sha, chunks = excluded.chunks, indexed_at = excluded.indexed_at",
          repo, path, sha, chunks, Date.now(),
        ),
      deleteFile: (repo, path) => this.sql.exec("DELETE FROM kb_files WHERE repo = ? AND path = ?", repo, path),
      filesIn: (repo) => this.rows("SELECT path, sha, chunks FROM kb_files WHERE repo = ?", repo),
    };
  }

  // ---------- alarm: reminders, then jobs ----------

  async alarm() {
    const started = Date.now();
    await this.sendDueReminders(started);

    let ran = 0;
    while (ran < JOBS_PER_ALARM && Date.now() - started < ALARM_WORK_MS) {
      const job = this.rows("SELECT * FROM jobs WHERE run_after <= ? ORDER BY id LIMIT 1", Date.now())[0];
      if (!job) break;
      ran++;
      try {
        const result = await runJob(this.env, { kind: job.kind, payload: JSON.parse(job.payload) }, this.api());
        if (result === "deferred") {
          // Over today's indexing budget: everything waits for tomorrow (UTC).
          this.sql.exec("UPDATE jobs SET run_after = ? WHERE run_after <= ?", nextUtcDay(), Date.now());
          break;
        }
        this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id);
      } catch (err) {
        console.error(`job ${job.kind} failed:`, err);
        if (job.attempts >= 2) this.sql.exec("DELETE FROM jobs WHERE id = ?", job.id);
        else this.sql.exec("UPDATE jobs SET attempts = attempts + 1, run_after = ? WHERE id = ?", Date.now() + RETRY_MS * (job.attempts + 1), job.id);
      }
    }

    await this.reportReindexDone();
    await this.schedule();
  }

  async sendDueReminders(now) {
    for (const r of this.rows("SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at LIMIT 20", now)) {
      const res = await discordApi(this.env, `/channels/${r.channel_id}/messages`, {
        method: "POST",
        body: JSON.stringify({
          content: `⏰ <@${r.user_id}> ${r.text}${r.source_url ? `\n-# [Where you asked](${r.source_url})` : ""}`,
          allowed_mentions: { parse: [], users: [r.user_id] },
          flags: 1 << 2,
        }),
      }).catch(() => null);
      // Retry later on network or Discord errors; drop it if the channel is gone.
      if (!res || res.status >= 500 || res.status === 429) {
        this.sql.exec("UPDATE reminders SET due_at = ? WHERE id = ?", now + RETRY_MS, r.id);
      } else {
        this.sql.exec("DELETE FROM reminders WHERE id = ?", r.id);
      }
    }
  }

  async reportReindexDone() {
    const started = this.rows("SELECT value FROM meta WHERE key = 'reindex'")[0];
    if (!started || this.rows("SELECT COUNT(*) AS n FROM jobs")[0].n > 0) return;
    this.sql.exec("DELETE FROM meta WHERE key = 'reindex'");
    const s = this.stats();
    await alertAdmins(this.env, `📚 Knowledge index is up to date: ${s.files} files in ${s.chunks} chunks, plus ${s.decisions} saved decisions.`);
  }

  async schedule() {
    const nextReminder = this.rows("SELECT MIN(due_at) AS t FROM reminders")[0].t;
    const nextJob = this.rows("SELECT MIN(run_after) AS t FROM jobs")[0].t;
    const times = [nextReminder, nextJob].filter((t) => t != null).map((t) => Math.max(t, Date.now() + 1_000));
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times));
    else await this.ctx.storage.deleteAlarm();
  }

  rows(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }
}

function nextUtcDay(now = Date.now()) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 5);
}
