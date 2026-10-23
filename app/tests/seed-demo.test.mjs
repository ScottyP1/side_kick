/**
 * Demo world seed test: runs `scripts/seed-demo.mjs` (what `npm --prefix app run seed:demo` runs) on a fresh, empty
 * SQLite data folder with fake Claude, checks the world it built, then runs it again on the same folder to check it
 * rebuilds the same world (idempotent) and keeps the same passwords. Nothing real is touched: its own temp data
 * folder, secrets file and port (TEST_SEED_PORT, default TEST_PORT + 20 or 3220), every outside service blanked by
 * the seed itself. Passwords are never printed; the test only checks they exist and stay the same.
 *
 * Run with `npm test`, or alone: node --test --test-timeout=600000 tests/seed-demo.test.mjs
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const APP = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env.TEST_SEED_PORT) || (Number(process.env.TEST_PORT) || 3200) + 20;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-seedtest-"));
const dataDir = path.join(tmp, "data");
const secrets = path.join(tmp, "logins.json");

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Runs the seed like `npm run seed:demo` does, into the temp folder. */
function seed() {
  const r = spawnSync(process.execPath, [
    "--no-warnings", "--conditions=react-server", "--import", "./tests/register-ts.mjs", "scripts/seed-demo.mjs",
    "--data-dir", dataDir, "--port", String(PORT), "--secrets", secrets,
  ], { cwd: APP, encoding: "utf8", timeout: 8 * 60_000, env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(r.status, 0, `seed failed:\n${(r.stdout ?? "").slice(-3000)}\n${(r.stderr ?? "").slice(-3000)}`);
  return r.stdout;
}

/** One number from the seeded database. */
function count(sql, ...params) {
  const db = new DatabaseSync(path.join(dataDir, "sidekick.db"), { readOnly: true });
  try {
    return Number(Object.values(db.prepare(sql).get(...params))[0]);
  } finally {
    db.close();
  }
}

test("the demo seed builds the whole world on a fresh SQLite copy", () => {
  const out = seed();
  assert.match(out, /Demo world ready/);
  const northwind = "(SELECT id FROM orgs WHERE name = 'Northwind Consulting')";
  assert.equal(count("SELECT COUNT(*) FROM orgs"), 4, "Northwind and three more client organizations");
  assert.ok(count(`SELECT COUNT(*) FROM users WHERE org_id = ${northwind}`) >= 110, "~115 people at Northwind");
  for (const [role, n] of [["Org Owner", 1], ["Org Admin", 3], ["Billing Admin", 1], ["Team Lead", 10]]) {
    assert.equal(count(`SELECT COUNT(*) FROM users WHERE org_id = ${northwind} AND role = ?`, role), n, role);
  }
  assert.ok(count(`SELECT COUNT(*) FROM users WHERE org_id = ${northwind} AND role = 'Viewer'`) >= 15);
  assert.equal(count(`SELECT COUNT(*) FROM workspaces WHERE org_id = ${northwind}`), 11, "10 engagements and a new bid team with no Team Lead yet");
  assert.equal(count("SELECT COUNT(*) FROM meetings WHERE status != 'Ready'"), 0, "every meeting imported");
  assert.ok(count("SELECT COUNT(*) FROM meetings") >= 50);
  assert.equal(count("SELECT COUNT(*) FROM meetings WHERE summary LIKE 'Test summary%'"), 0, "realistic notes, not fake Claude's");
  assert.equal(count("SELECT COUNT(*) FROM documents WHERE status != 'Ready'"), 0, "every document indexed");
  assert.ok(count("SELECT COUNT(*) FROM chat_messages") >= 100, "tracked Teams chat messages");
  assert.ok(count("SELECT COUNT(*) FROM teams_conversations WHERE guests = 1") >= 1, "a chat with client guests");
  assert.ok(count("SELECT COUNT(*) FROM firm_docs WHERE superseded_by IS NOT NULL") >= 1, "a superseded firm policy");
  assert.equal(count("SELECT COUNT(*) FROM rolloffs WHERE scope = 'group' AND status = 'scheduled'"), 1, "one group Ending");
  assert.ok(count("SELECT COUNT(*) FROM action_items WHERE owner IS NULL AND status != 'Done'") >= 5, "unowned action items");
  assert.ok(count("SELECT COUNT(*) FROM action_items WHERE status != 'Done' AND due_on < '2026-10-22'") >= 5, "overdue action items");
  assert.ok(count("SELECT COUNT(*) FROM answer_feedback WHERE vote < 0") >= 1 && count("SELECT COUNT(*) FROM answer_feedback WHERE vote > 0") >= 10, "👍 and 👎");
  assert.ok(count("SELECT COUNT(*) FROM support_tickets") >= 5 && count("SELECT COUNT(*) FROM support_messages WHERE author_kind = 'staff'") >= 3, "tickets with replies");
  assert.ok(count("SELECT COUNT(*) FROM insights") >= 10, "knowledge maps");
  assert.ok(count("SELECT COUNT(*) FROM passages WHERE source_type = 'notes'") >= 50, "the rewritten notes are searchable again");
  assert.ok(count("SELECT COUNT(*) FROM org_flags WHERE enabled = 0") >= 1, "a feature restricted for one client");
  assert.ok(count("SELECT COUNT(*) FROM guard_custom_rules WHERE workspace_id IS NOT NULL") >= 1, "a stricter group");
  assert.ok(count("SELECT COUNT(*) FROM usage_events WHERE created_at < ?", new Date(Date.now() - 20 * 86400_000).toISOString()) > 100, "usage history");
  assert.equal(count("SELECT COUNT(*) FROM subscriptions WHERE status = 'past_due'"), 1);
  assert.equal(count("SELECT COUNT(*) FROM platform_admins"), 1, "the Owner Console account");
  // The watchers ran once on the job queue and found something of every kind at Northwind.
  for (const kind of ["unanswered", "failed_replies", "chat_waiting", "chat_removed", "overdue_items", "unowned_items", "stale_doc", "no_lead", "no_notes_chat", "broken_connector"]) {
    assert.ok(count(`SELECT COUNT(*) FROM findings WHERE org_id = ${northwind} AND kind = ? AND status = 'open'`, kind) >= 1, `a "${kind}" finding`);
  }
  assert.equal(count("SELECT COUNT(*) FROM jobs WHERE status = 'dead'"), 0, "no job gave up");
  assert.match(out, /findings for Northwind's Org Owner \(10 kinds/);
  // Starter is 15 people: Tailspin sits one below.
  assert.equal(count("SELECT COUNT(*) FROM users WHERE org_id = (SELECT id FROM orgs WHERE name = 'Tailspin Partners')"), 14);
  // The private files exist, are only readable by this user, and hold every login.
  const saved = JSON.parse(fs.readFileSync(secrets, "utf8"));
  for (const k of ["operator", "orgOwner", "orgAdmin", "billingAdmin", "teamLead", "member", "viewer", "tailspinOwner"]) assert.ok(saved.passwords[k]?.length >= 12, k);
  assert.equal(fs.statSync(secrets).mode & 0o077, 0, "secrets file is private");
  const guide = fs.readFileSync(secrets.replace(/\.json$/, ".md"), "utf8");
  assert.match(guide, /LOCAL ONLY/);
  assert.ok(guide.includes(saved.passwords.orgOwner));
  assert.ok(!out.includes(saved.passwords.orgOwner), "passwords are never printed");
});

test("seeding again rebuilds the same world and keeps the passwords", () => {
  const before = JSON.parse(fs.readFileSync(secrets, "utf8")).passwords;
  const people = count("SELECT COUNT(*) FROM users");
  const meetings = count("SELECT COUNT(*) FROM meetings");
  seed();
  assert.deepEqual(JSON.parse(fs.readFileSync(secrets, "utf8")).passwords, before);
  assert.equal(count("SELECT COUNT(*) FROM users"), people);
  assert.equal(count("SELECT COUNT(*) FROM meetings"), meetings);
  assert.equal(count("SELECT COUNT(*) FROM orgs"), 4);
});
