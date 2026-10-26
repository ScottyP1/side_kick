// Shared by the answer accuracy check (scripts/answer-eval.mjs, real Claude, not in CI) and its fake-Claude test in
// tests/api.test.mjs (CI): loads a test set from samples/eval/<name>.json, fills a group with its documents,
// meetings and firm library through the API, asks every question, and scores each answer.
//
// Scoring, one point each (see the "about" line in the set file):
// - found: answered when an answer is expected, "I don't know" when `found` is false (null: either is fine);
// - facts: each fact group needs one of its alternatives in the answer (case-insensitive, plain text);
// - sources: each pattern must match the title of a cited source;
// - absent: each pattern must not match the answer or any cited title (walls: guests, internal-only);
// - conflict: the answer says its sources disagree; firm: a firm library source is cited;
// - followUp: asked in the same conversation, it must be recognised as a follow-up and have its facts.
import fs from "node:fs";
import path from "node:path";

export const SAMPLES = path.resolve(import.meta.dirname, "../../samples");

/** Reads samples/eval/<name>.json. */
export function loadSet(name = "contoso") {
  return JSON.parse(fs.readFileSync(path.join(SAMPLES, "eval", `${name}.json`), "utf8"));
}

const has = (text, alt) => text.toLowerCase().includes(String(alt).toLowerCase());
const titlesOf = (a) => (a.sources ?? []).map((s) => s.title);

/** Scores one answer against its case. Returns { points, max, misses: [reason] }. */
export function scoreAnswer(spec, answer, followUp) {
  const misses = [];
  let points = 0;
  let max = 0;
  const check = (ok, why) => {
    max++;
    if (ok) points++;
    else misses.push(why);
  };
  const text = answer.answer ?? "";
  const titles = titlesOf(answer);
  if (spec.found === false) check(!answer.found, "should say it doesn't know");
  else if (spec.found !== null) check(answer.found === true, "no answer found"); // null: either is fine
  for (const alts of spec.facts ?? []) check(alts.some((a) => has(text, a)), `missing fact: ${alts[0]}`);
  for (const p of spec.sources ?? []) check(titles.some((t) => new RegExp(p, "i").test(t)), `no cited source matching /${p}/`);
  for (const p of spec.absent ?? []) check(!new RegExp(p, "i").test(`${text}\n${titles.join("\n")}`), `must not mention /${p}/`);
  if (spec.conflict) check(answer.conflict === true, "didn't flag the conflict");
  if (spec.firm) check((answer.sources ?? []).some((s) => s.origin === "firm"), "no firm library source cited");
  if (spec.followUp && followUp) {
    check(Boolean(followUp.followUp), "follow-up not recognised");
    for (const alts of spec.followUp.facts ?? []) check(alts.some((a) => has(followUp.answer ?? "", a)), `follow-up missing fact: ${alts[0]}`);
  }
  return { points, max, misses };
}

/**
 * Fills group `ws` with the set's documents and meetings, and the org's firm library, through the API as `call`
 * (an admin client: call(method, url, body, { form })). Throws on the first failure, naming the file.
 */
export async function loadSetup(call, set, ws) {
  const ok = (r, what) => {
    if (r.status !== 200 || r.body?.results?.some((x) => !x.ok)) throw new Error(`${what}: ${JSON.stringify(r.body).slice(0, 300)}`);
    return r;
  };
  for (const d of set.setup.documents ?? []) {
    const form = new FormData();
    form.append("ws", ws);
    form.append("audience", d.audience);
    form.append("files", new File([fs.readFileSync(path.join(SAMPLES, d.path))], path.basename(d.path)));
    ok(await call("POST", "/api/docs", undefined, { form }), d.path);
  }
  const firmIds = new Map();
  for (const f of set.setup.firm ?? []) {
    const form = new FormData();
    form.append("title", f.title);
    form.append("audience", f.audience);
    if (f.effective_on) form.append("effective_on", f.effective_on);
    if (f.replaces) form.append("replaces", firmIds.get(f.replaces));
    form.append("files", new File([fs.readFileSync(path.join(SAMPLES, f.path))], path.basename(f.path)));
    const r = ok(await call("POST", "/api/firm", undefined, { form }), f.path);
    firmIds.set(f.title, r.body.results[0].id);
  }
  for (const m of set.setup.meetings ?? []) {
    const form = new FormData();
    form.append("ws", ws);
    form.append("title", path.basename(m.path).replace(/\.[a-z]+$/i, "").replace(/^\d{4}-\d{2}-\d{2} /, ""));
    form.append("held_at", m.held_at);
    if (m.guests) form.append("external", "true");
    form.append("file", new File([fs.readFileSync(path.join(SAMPLES, m.path))], path.basename(m.path)));
    ok(await call("POST", "/api/meetings", undefined, { form }), m.path);
  }
  return { firmIds };
}

/**
 * Asks every question of the set in group `ws` (each in a new conversation; a `followUp` in the same one) and
 * scores it. Returns [{ id, q, answer, followUp, score }] and calls `onResult` after each, for live printing.
 */
export async function askAll(call, set, ws, onResult = () => {}) {
  const out = [];
  for (const spec of set.questions) {
    const r = await call("POST", "/api/ask", { ws, question: spec.q, guests: Boolean(spec.guests), newQuestion: true });
    if (r.status !== 200) throw new Error(`Asking "${spec.q}" failed: ${JSON.stringify(r.body).slice(0, 300)}`);
    let followUp = null;
    if (spec.followUp) {
      const f = await call("POST", "/api/ask", { ws, question: spec.followUp.q, guests: Boolean(spec.guests), conversation: r.body.conversation });
      if (f.status !== 200) throw new Error(`Follow-up "${spec.followUp.q}" failed: ${JSON.stringify(f.body).slice(0, 300)}`);
      followUp = f.body;
    }
    const result = { id: spec.id, q: spec.q, answer: r.body, followUp, score: scoreAnswer(spec, r.body, followUp) };
    out.push(result);
    onResult(result);
  }
  return out;
}
