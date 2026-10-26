// Real-Claude accuracy run with a hard spending cap: asks the questions in a test set (default
// samples/eval/accuracy-2026-10.json, two groups) and runs its meeting transcripts through the meeting-notes step,
// recording each answer, its cited sources, latency, cost and an automatic check, then writes everything to a JSON
// file for a human verdict (the October 2026 write-up is docs/quality/2026-10-accuracy-run.md).
//
// It costs money, so it is never part of `npm test` or CI: it refuses to start without `--budget <dollars>`
// (at most $5), and refuses inside the test runner or CI. Spend is read from the app's own usage records
// (the cost column of usage_events in the copy's database) after every step; before each step it stops if the money
// already spent plus a reserve (1.5x the dearest step so far, or a first guess) would pass the budget.
//
// Usage (the Claude key is read from an env file and passed only to the throwaway copy; it is never printed):
//   node app/scripts/accuracy-run.mjs --budget 1.00
//   node app/scripts/accuracy-run.mjs --budget 0.30 --only cutover-date,natural-speech --out /tmp/run.json
// Options: --fake (free plumbing check with fake Claude, no budget needed), --set <name> (samples/eval/<name>.json), --port <n> (default 3360), --data-dir <folder> (default a new
// temp folder; must be empty or missing; kept afterwards so you can look at it), --env-file <file> (default
// app/.env.local), --out <file> (default <data dir>/accuracy-results.json), --only <ids> (comma-separated).
//
// Like scripts/answer-eval.mjs, it starts its own copy of the app (`next dev`, SQLite in the data folder, its own
// build folder, Azure search, Teams, Microsoft sign-in and the reminder timer switched off, default models from
// lib/claude.ts), runs first-run setup with a random password it never prints, creates the set's groups and loads
// their documents and the firm library (no AI cost), then runs the meetings and the questions.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SAMPLES, scoreAnswer } from "./answer-eval-lib.mjs";

const APP = path.resolve(import.meta.dirname, "..");

/* ---------------------------------------------------------------- options and guards */

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
if (process.env.NODE_TEST_CONTEXT || process.env.npm_lifecycle_event === "test" || process.env.CI) {
  console.error("✖ The accuracy run calls the real Claude and costs money; it never runs inside tests or CI.");
  process.exit(1);
}
// --fake: a free plumbing check with fake Claude (canned answers, no key, no cost; scores mean nothing).
const FAKE = args.includes("--fake");
const BUDGET = FAKE ? 1 : Number(opt("budget"));
if (!Number.isFinite(BUDGET) || BUDGET <= 0 || BUDGET > 5) {
  console.error("✖ Give a spending cap in dollars, e.g. --budget 1.00 (at most 5). This run uses the real Claude.");
  process.exit(1);
}
const set = JSON.parse(fs.readFileSync(path.join(SAMPLES, "eval", `${opt("set", "accuracy-2026-10")}.json`), "utf8"));
const only = opt("only") ? new Set(opt("only").split(",").map((s) => s.trim())) : null;
const PORT = Number(opt("port", 3360));
const BASE = `http://localhost:${PORT}`;
const dataDir = path.resolve(opt("data-dir", fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-accuracy-"))));
if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length) {
  console.error(`✖ ${dataDir} isn't empty. Use a new folder so no other data is touched.`);
  process.exit(1);
}
fs.mkdirSync(dataDir, { recursive: true });
const outFile = path.resolve(opt("out", path.join(dataDir, "accuracy-results.json")));

// Only the Claude key is taken from the env file; every other outside service stays blank.
const envFile = path.resolve(opt("env-file", path.join(APP, ".env.local")));
const key = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8").match(/^ANTHROPIC_API_KEY=(\S+)/m)?.[1]?.replace(/^["']|["']$/g, "") : null;
if (!key && !FAKE) {
  console.error(`✖ No ANTHROPIC_API_KEY in ${envFile}. This run needs the real Claude.`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the throwaway copy */

/** A tiny HTTP client with its own cookie jar (like the tests'). */
function client() {
  const jar = new Map();
  return async (method, url, body, { form } = {}) => {
    const headers = { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") };
    let payload = form;
    if (!form && body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers, body: payload, redirect: "manual" });
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [k, v] = c.split(";")[0].split("=");
      if (v) jar.set(k, v);
      else jar.delete(k);
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
}

const saved = ["tsconfig.json", "next-env.d.ts"].map((f) => [path.join(APP, f), fs.existsSync(path.join(APP, f)) ? fs.readFileSync(path.join(APP, f), "utf8") : null]);
const server = spawn(path.join(APP, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], {
  cwd: APP,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env, NODE_ENV: "development", NEXT_DIST_DIR: ".next-accuracy", SIDEKICK_DATA_DIR: dataDir, DATABASE_URL: "",
    ANTHROPIC_API_KEY: FAKE ? "" : key, SIDEKICK_FAKE_CLAUDE: FAKE ? "1" : "",
    AZURE_SEARCH_ENDPOINT: "", AZURE_SEARCH_API_KEY: "", AZURE_OPENAI_ENDPOINT: "", AZURE_OPENAI_API_KEY: "",
    CLIENT_ID: "", CLIENT_SECRET: "", TENANT_ID: "", ENTRA_CLIENT_ID: "", ENTRA_CLIENT_SECRET: "", SIDEKICK_SCHEDULER: "off", SIDEKICK_PUBLIC_URL: "",
  },
});
let errors = "";
server.stderr.on("data", (d) => (errors = (errors + d).slice(-4000)));

async function stop() {
  if (server.exitCode === null) {
    const exited = new Promise((r) => server.once("exit", r));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
  }
  fs.rmSync(path.join(APP, ".next-accuracy"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  for (const [file, text] of saved) if (text !== null) fs.writeFileSync(file, text); // next dev edits these
}

/* ---------------------------------------------------------------- checks */

const re = (p) => new RegExp(p, "i");
const has = (text, alts) => alts.some((a) => String(text ?? "").toLowerCase().includes(String(a).toLowerCase()));
/** "null" in an expected due date means no date; "a|b" means either. */
const dueOk = (want, got) => want.split("|").some((w) => (w === "null" ? !got : got === w));

/**
 * Checks one meeting's notes against what was said: expected decisions, things that must NOT be decisions or
 * actions (floated ideas), action items with owner and due date, open questions and risks.
 * Returns { points, max, misses } like scoreAnswer.
 */
function scoreNotes(spec, notes) {
  const misses = [];
  let points = 0;
  let max = 0;
  const check = (ok, why) => {
    max++;
    if (ok) points++;
    else misses.push(why);
  };
  const decisions = notes.items.filter((i) => i.kind === "decision").map((i) => i.text);
  const questions = notes.items.filter((i) => i.kind === "question" || i.kind === "pending").map((i) => i.text);
  const risks = notes.items.filter((i) => i.kind === "risk").map((i) => i.text);
  for (const alts of spec.decisions ?? []) check(decisions.some((d) => has(d, alts)), `missing decision: ${alts[0]}`);
  for (const p of spec.notDecisions ?? []) check(!decisions.some((d) => re(p).test(d)), `floated idea became a decision: /${p}/`);
  for (const p of spec.notActions ?? []) check(!notes.actions.some((a) => re(p).test(a.text)), `floated idea became an action: /${p}/`);
  for (const a of spec.actions ?? []) {
    const hit = notes.actions.find((x) => re(a.match).test(x.text));
    check(Boolean(hit), `missing action: /${a.match}/`);
    if (!hit) continue;
    check(String(hit.owner ?? "").toLowerCase().includes(a.owner.toLowerCase()), `action /${a.match}/ owner ${hit.owner ?? "none"}, expected ${a.owner}`);
    check(dueOk(a.due_on, hit.due_on), `action /${a.match}/ due ${hit.due_on ?? "none"}, expected ${a.due_on}`);
  }
  for (const alts of spec.openQuestions ?? []) check(questions.some((q) => has(q, alts)), `missing open question: ${alts[0]}`);
  for (const alts of spec.risks ?? []) check(risks.some((r) => has(r, alts)), `missing risk: ${alts[0]}`);
  return { points, max, misses };
}

/** scoreAnswer plus the guardrail case: `blocked` true (any rule) or a rule id the refusal must name. */
function scoreQuestion(spec, answer) {
  if (spec.blocked) {
    const ok = Boolean(answer.blocked) && (spec.blocked === true || answer.blocked === spec.blocked);
    return { points: ok ? 1 : 0, max: 1, misses: ok ? [] : [`expected a refusal (${spec.blocked}), got ${answer.blocked ?? "an answer"}`] };
  }
  return scoreAnswer(spec, answer, null);
}

/* ---------------------------------------------------------------- run */

const results = { set: set.name, budget: BUDGET, startedAt: new Date().toISOString(), meetings: [], questions: [], stoppedEarly: null };
const save = () => fs.writeFileSync(outFile, JSON.stringify(results, null, 2));

try {
  let up = false;
  for (let i = 0; i < 180 && !up; i++) {
    up = await fetch(`${BASE}/api/auth/setup`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) throw new Error(`The app didn't start.\n${errors}`);
  const admin = client();
  const setup = await admin("POST", "/api/auth/setup", { org: "Accuracy Run Org", name: "Accuracy Admin", email: "accuracy@example.test", password: crypto.randomBytes(18).toString("base64url") });
  if (setup.status !== 200) throw new Error(`Setup failed: ${JSON.stringify(setup.body)}`);
  const ok = (r, what) => {
    if (r.status !== 200 || r.body?.results?.some((x) => !x.ok) || r.body?.check) throw new Error(`${what}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r;
  };

  // Groups, their documents and the firm library: no AI cost.
  const ws = {};
  for (const g of set.groups) {
    ws[g.key] = ok(await admin("POST", "/api/workspaces", { name: g.name }), `group ${g.name}`).body.id;
    for (const d of g.documents) {
      const form = new FormData();
      form.append("ws", ws[g.key]);
      form.append("audience", d.audience);
      form.append("files", new File([fs.readFileSync(path.join(SAMPLES, d.path))], path.basename(d.path)));
      ok(await admin("POST", "/api/docs", undefined, { form }), d.path);
    }
  }
  for (const f of set.firm ?? []) {
    const form = new FormData();
    form.append("title", f.title);
    form.append("audience", f.audience);
    if (f.effective_on) form.append("effective_on", f.effective_on);
    form.append("files", new File([fs.readFileSync(path.join(SAMPLES, f.path))], path.basename(f.path)));
    ok(await admin("POST", "/api/firm", undefined, { form }), f.path);
  }

  // Spend from the copy's own usage records (the cost column of usage_events, read from its database: /api/usage
  // no longer shows dollars since firm usage went cost-free), and the budget guard.
  const spent = async () => {
    const db = new DatabaseSync(path.join(dataDir, "sidekick.db"), { readOnly: true, timeout: 10000 });
    try {
      return Number(db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage_events").get().c);
    } finally {
      db.close();
    }
  };
  let total = await spent();
  let dearest = 0;
  /** Runs one costed step if the budget allows; returns { value, cost, ms } or null when it stopped. */
  const step = async (label, guess, fn) => {
    const reserve = Math.max(dearest * 1.5, guess);
    if (total + reserve > BUDGET) {
      results.stoppedEarly = `Stopped before "${label}": $${total.toFixed(4)} spent, the next step could cost about $${reserve.toFixed(3)} and the cap is $${BUDGET.toFixed(2)}.`;
      console.log(`\n■ ${results.stoppedEarly}`);
      return null;
    }
    const t = Date.now();
    const value = await fn();
    const ms = Date.now() - t;
    const now = await spent();
    const cost = now - total;
    total = now;
    dearest = Math.max(dearest, cost);
    return { value, cost, ms };
  };

  console.log(`Loaded ${set.groups.length} groups. Budget $${BUDGET.toFixed(2)}.`);
  for (const m of set.meetings ?? []) {
    if (only && !only.has(m.id)) continue;
    const r = await step(`meeting ${m.id}`, 0.08, async () => {
      const form = new FormData();
      form.append("ws", ws[m.group]);
      form.append("title", path.basename(m.path).replace(/\.[a-z]+$/i, "").replace(/^\d{4}-\d{2}-\d{2} /, ""));
      form.append("held_at", m.held_at);
      form.append("file", new File([fs.readFileSync(path.join(SAMPLES, m.path))], path.basename(m.path)));
      const id = ok(await admin("POST", "/api/meetings", undefined, { form }), m.path).body.id;
      const notes = (await admin("GET", `/api/meetings/${id}`)).body;
      return { summary: notes.meeting.summary, items: notes.items.map(({ kind, text, who, answered }) => ({ kind, text, who, answered })), actions: notes.actions.map(({ text, owner, due, due_on }) => ({ text, owner, due, due_on })) };
    });
    if (!r) break;
    const score = scoreNotes(m, r.value);
    results.meetings.push({ id: m.id, kind: m.kind, held_at: m.held_at, notes: r.value, cost: r.cost, latencyMs: r.ms, score });
    save();
    console.log(`\n[meeting ${m.id}] ${r.value.items.length} items, ${r.value.actions.length} actions · ${(r.ms / 1000).toFixed(1)}s · $${r.cost.toFixed(4)}`);
    for (const a of r.value.actions) console.log(`  • ${a.text} — ${a.owner ?? "no owner"}, ${a.due_on ?? "no date"}`);
    for (const i of r.value.items) console.log(`  ${i.kind}: ${i.text}`);
    console.log(`  ${score.points}/${score.max}${score.misses.length ? `  ✖ ${score.misses.join("; ")}` : "  ✔"}`);
  }

  if (!results.stoppedEarly) {
    for (const q of set.questions) {
      if (only && !only.has(q.id)) continue;
      const r = await step(`question ${q.id}`, 0.06, async () => {
        const res = await admin("POST", "/api/ask", { ws: ws[q.group], question: q.q, guests: Boolean(q.guests), newQuestion: true });
        if (res.status !== 200) throw new Error(`Asking "${q.q}" failed: ${JSON.stringify(res.body).slice(0, 300)}`);
        return res.body;
      });
      if (!r) break;
      const a = r.value;
      const score = scoreQuestion(q, a);
      results.questions.push({
        id: q.id, group: q.group, kind: q.kind, q: q.q, guests: Boolean(q.guests), expect: q.expect,
        answer: a.answer, found: a.found, blocked: a.blocked, conflict: a.conflict, aiMode: a.aiMode,
        sources: (a.sources ?? []).map((s) => ({ id: s.id, title: s.title, loc: s.loc, origin: s.origin, outdated: s.outdated, excerpt: s.excerpt })),
        cost: r.cost, latencyMs: r.ms, score,
      });
      save();
      console.log(`\n[${q.id}] (${q.group}${q.guests ? ", guests" : ""}) ${q.q}\n  A: ${a.answer}\n  cited: ${(a.sources ?? []).map((s) => `${s.origin === "firm" ? "Firm · " : ""}${s.title}`).join(" | ") || "none"}${a.conflict ? "  (conflict flagged)" : ""}${a.blocked ? `  (refused: ${a.blocked})` : ""}`);
      console.log(`  ${(r.ms / 1000).toFixed(1)}s · $${r.cost.toFixed(4)} · ${score.points}/${score.max}${score.misses.length ? `  ✖ ${score.misses.join("; ")}` : "  ✔"}`);
    }
  }

  results.totalCost = total;
  results.byFeature = (await admin("GET", "/api/usage")).body?.byFeature ?? [];
  await stop();
  // Per-call detail (feature, model, tokens, cost, latency) straight from the copy's usage_events table.
  const db = new DatabaseSync(path.join(dataDir, "sidekick.db"), { readOnly: true });
  results.calls = db.prepare("SELECT feature, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, latency_ms, ok, error, created_at FROM usage_events ORDER BY created_at").all();
  db.close();
  save();
  const sum = (xs) => xs.reduce((n, x) => n + x.score.points, 0);
  const max = (xs) => xs.reduce((n, x) => n + x.score.max, 0);
  const all = [...results.meetings, ...results.questions];
  console.log(`\nAutomatic checks: questions ${sum(results.questions)}/${max(results.questions)}, meeting notes ${sum(results.meetings)}/${max(results.meetings)} (${Math.round((sum(all) / Math.max(1, max(all))) * 100)}%).`);
  console.log(`Spent $${total.toFixed(4)} of $${BUDGET.toFixed(2)} (${results.byFeature.map((f) => `${f.feature} $${Number(f.cost).toFixed(4)}`).join(", ")}).`);
  console.log(`Results: ${outFile}\nData folder (kept): ${dataDir}`);
  process.exit(0);
} catch (e) {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  save();
  await stop();
  process.exit(1);
}
