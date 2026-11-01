/**
 * Tests for infra/azure/meetbot-budget.sh (step 7 of meetbot-setup.sh), run by app/tests/run.mjs against a fake `az`
 * on PATH that records its calls and answers the budget GET. Covers: a new budget starts on the first of this month;
 * an existing budget keeps its own start date (Azure refuses to change it: "Start date of budgets cannot be updated",
 * the second-run failure found Nov 1 2026) while the amount and emails are updated.
 *
 *   node --test infra/azure/meetbot-budget.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "meetbot-budget.sh");

/** Runs the script with a fake `az`: `existing` is the start date the GET returns (null = no budget, a 404). */
function runWith(existing) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meetbot-budget-"));
  const log = path.join(dir, "calls.jsonl");
  fs.writeFileSync(path.join(dir, "az"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const body = args.includes("--body") ? fs.readFileSync(args[args.indexOf("--body") + 1].replace(/^@/, ""), "utf8") : null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body }) + "\\n");
if (args.includes("get")) {
  if (${JSON.stringify(existing)} === null) { console.error("(NotFound) Budget not found"); process.exit(1); }
  console.log(${JSON.stringify(existing)});
}
`, { mode: 0o755 });
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SUB: "sub-test", RG: "sidekick-rg", BUDGET_USD: "75", BUDGET_EMAIL: "owner@example.test" },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { r, calls };
}

test("a new budget starts on the first of this month (UTC)", () => {
  const { r, calls } = runWith(null);
  assert.equal(r.status, 0, r.stderr);
  const put = calls.find((c) => c.args.includes("put"));
  const body = JSON.parse(put.body);
  assert.equal(body.properties.timePeriod.startDate, `${new Date().toISOString().slice(0, 7)}-01T00:00:00Z`);
  assert.equal(body.properties.amount, 75);
  assert.deepEqual(body.properties.notifications.actual80.contactEmails, ["owner@example.test"]);
  assert.match(put.args[put.args.indexOf("--url") + 1], /\/subscriptions\/sub-test\/resourceGroups\/sidekick-rg\/providers\/Microsoft\.Consumption\/budgets\/sidekick-meetbot-monthly\?/);
});

test("an existing budget keeps its start date on a run in a later month; amount and emails are updated", () => {
  const { r, calls } = runWith("2025-10-01T00:00:00Z");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /keeping its start date/);
  const body = JSON.parse(calls.find((c) => c.args.includes("put")).body);
  assert.equal(body.properties.timePeriod.startDate, "2025-10-01T00:00:00Z", "never changed: Azure refuses that");
  assert.equal(body.properties.amount, 75);
});
