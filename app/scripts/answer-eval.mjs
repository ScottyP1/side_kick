// Answer accuracy check against the REAL Claude: a fixed set of questions per sample engagement (samples/eval/*.json)
// with the facts and sources a good answer must have. Prints each answer, a score and what the run cost.
// NOT run in CI or by `npm test` (it costs money: about $1-2 for the Contoso set, mostly the meeting notes);
// the plumbing is tested with fake Claude in tests/api.test.mjs.
//
// Usage (needs ANTHROPIC_API_KEY in app/.env.local; nothing else is touched):
//   npm --prefix app run eval:answers                 → the Contoso set
//   npm --prefix app run eval:answers -- contoso 3350 → a set name and a port
//
// It starts its own throwaway copy of the app (temp SQLite data folder, its own build folder, Azure search,
// Teams and Microsoft sign-in switched off so no real index or chat is touched), runs first-run setup with a
// random password it never prints, loads the set's documents, meetings and firm library, asks every question,
// prints the results, then stops the copy and deletes its data. Run it before and after changing the answer
// prompt, ranking (lib/rank.ts) or the ask model, and compare the scores.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { askAll, loadSet, loadSetup } from "./answer-eval-lib.mjs";

const APP = path.resolve(import.meta.dirname, "..");
const setName = process.argv[2] || "contoso";
const PORT = Number(process.argv[3]) || 3350;
const BASE = `http://localhost:${PORT}`;

const envFile = path.join(APP, ".env.local");
if (!fs.existsSync(envFile) || !/^ANTHROPIC_API_KEY=\S+/m.test(fs.readFileSync(envFile, "utf8"))) {
  console.error("✖ No ANTHROPIC_API_KEY in app/.env.local. This check needs the real Claude.");
  process.exit(1);
}
const set = loadSet(setName);

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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-eval-"));
const saved = ["tsconfig.json", "next-env.d.ts"].map((f) => [path.join(APP, f), fs.existsSync(path.join(APP, f)) ? fs.readFileSync(path.join(APP, f), "utf8") : null]);
const server = spawn(path.join(APP, "node_modules/.bin/next"), ["dev", "--port", String(PORT)], {
  cwd: APP,
  stdio: ["ignore", "ignore", "pipe"],
  env: {
    ...process.env, NODE_ENV: "development", NEXT_DIST_DIR: ".next-eval", SIDEKICK_DATA_DIR: dataDir, DATABASE_URL: "",
    SIDEKICK_FAKE_CLAUDE: "", AZURE_SEARCH_ENDPOINT: "", AZURE_SEARCH_API_KEY: "", AZURE_OPENAI_ENDPOINT: "", AZURE_OPENAI_API_KEY: "",
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
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(path.join(APP, ".next-eval"), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  for (const [file, text] of saved) if (text !== null) fs.writeFileSync(file, text); // next dev edits these
}

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    up = await fetch(`${BASE}/api/auth/setup`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!up) throw new Error(`The app didn't start.\n${errors}`);
  const admin = client();
  const setup = await admin("POST", "/api/auth/setup", { org: "Eval Org", name: "Eval Admin", email: "eval@example.test", password: crypto.randomBytes(18).toString("base64url") });
  if (setup.status !== 200) throw new Error(`Setup failed: ${JSON.stringify(setup.body)}`);
  const ws = (await admin("POST", "/api/workspaces", { name: set.engagement.slice(0, 100) })).body.id;
  console.log(`Loading the "${set.name}" set (documents, firm library, ${set.setup.meetings?.length ?? 0} meetings: Claude writes their notes)…`);
  await loadSetup(admin, set, ws);
  console.log(`Asking ${set.questions.length} questions…`);
  const results = await askAll(admin, set, ws, (r) => {
    console.log(`\n[${r.id}] ${r.q}\n  A: ${r.answer.answer}\n  cited: ${r.answer.sources.map((s) => `${s.origin === "firm" ? "Firm policy · " : ""}${s.title}`).join(" | ") || "none"}${r.answer.conflict ? "  (conflict flagged)" : ""}`);
    if (r.followUp) console.log(`  follow-up → ${r.followUp.answer}  (following up on: ${r.followUp.followUp ?? "—"})`);
    console.log(`  ${r.score.points}/${r.score.max}${r.score.misses.length ? `  ✖ ${r.score.misses.join("; ")}` : "  ✔"}`);
  });
  const points = results.reduce((n, r) => n + r.score.points, 0);
  const max = results.reduce((n, r) => n + r.score.max, 0);
  const usage = (await admin("GET", "/api/usage")).body;
  console.log(`\nScore: ${points}/${max} (${Math.round((points / max) * 100)}%)`);
  console.log(`Cost of this run: $${Number(usage.totals?.cost ?? 0).toFixed(3)} (${(usage.byFeature ?? []).map((f) => `${f.feature} $${Number(f.cost).toFixed(3)}`).join(", ")})`);
  await stop();
  process.exit(points === max ? 0 : 1);
} catch (e) {
  console.error(`✖ ${e instanceof Error ? e.message : e}`);
  await stop();
  process.exit(1);
}
