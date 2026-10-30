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
    "--data-dir", dataDir, "--port", String(PORT), "--tools-port", String(PORT + 1), "--secrets", secrets,
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
  for (const [role, n] of [["Org Owner", 1], ["Org Admin", 4], ["Billing Admin", 0], ["Team Lead", 10]]) {
    assert.equal(count(`SELECT COUNT(*) FROM users WHERE org_id = ${northwind} AND role = ?`, role), n, role);
  }
  assert.ok(count(`SELECT COUNT(*) FROM users WHERE org_id = ${northwind} AND role = 'Viewer'`) >= 15);
  assert.equal(count(`SELECT COUNT(*) FROM workspaces WHERE org_id = ${northwind}`), 11, "10 engagements and a new bid team with no Team Lead yet");
  assert.equal(count("SELECT COUNT(*) FROM meetings WHERE status != 'Ready'"), 0, "every meeting imported");
  assert.ok(count("SELECT COUNT(*) FROM meetings") >= 50);
  assert.equal(count("SELECT COUNT(*) FROM meetings WHERE summary LIKE 'Test summary%'"), 0, "realistic notes, not fake Claude's");
  assert.equal(count("SELECT COUNT(*) FROM documents WHERE status != 'Ready'"), 1, "every document indexed but the held one");
  // Upload guard: a Litware file held in Contoso (not indexed), a firm standard for two groups, a client checklist held in the firm library.
  assert.equal(count("SELECT COUNT(*) FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE d.status = 'Held' AND w.name LIKE 'Contoso%' AND d.guard_json LIKE '%Litware%'"), 1);
  assert.equal(count("SELECT COUNT(*) FROM passages WHERE source_id IN (SELECT id FROM documents WHERE status = 'Held')"), 0, "held documents aren't searchable");
  assert.equal(count("SELECT COUNT(*) FROM firm_doc_groups g JOIN firm_docs f ON f.id = g.firm_doc_id WHERE f.applies_to = 'some'"), 2, "a firm standard for two groups");
  assert.equal(count("SELECT COUNT(*) FROM firm_docs WHERE status = 'Held' AND guard_json LIKE '%Contoso%'"), 1, "a client checklist held in the firm library");
  assert.ok(count("SELECT COUNT(*) FROM chat_messages") >= 100, "tracked Teams chat messages");
  assert.ok(count("SELECT COUNT(*) FROM teams_conversations WHERE guests = 1") >= 1, "a chat with client guests");
  assert.ok(count("SELECT COUNT(*) FROM firm_docs WHERE superseded_by IS NOT NULL") >= 1, "a superseded firm policy");
  assert.equal(count("SELECT COUNT(*) FROM rolloffs WHERE scope = 'group' AND status = 'scheduled'"), 1, "one group Ending");
  assert.ok(count("SELECT COUNT(*) FROM action_items WHERE owner IS NULL AND status != 'Done'") >= 5, "unowned action items");
  assert.ok(count("SELECT COUNT(*) FROM action_items WHERE status != 'Done' AND due_on < '2026-10-22'") >= 5, "overdue action items");
  assert.ok(count("SELECT COUNT(*) FROM answer_feedback WHERE vote < 0") >= 1 && count("SELECT COUNT(*) FROM answer_feedback WHERE vote > 0") >= 10, "👍 and 👎");
  assert.equal(count("SELECT COUNT(*) FROM connectors WHERE status = 'connected'"), 5, "Contoso's Azure DevOps, Jira, Confluence and Microsoft 365, and Litware's own Azure DevOps");
  assert.equal(count("SELECT COUNT(*) FROM connector_links WHERE last_ok_at IS NOT NULL"), 5, "five linked projects, spaces and folders, synced");
  assert.ok(count("SELECT COUNT(*) FROM passages WHERE source_type = 'page' AND title LIKE 'SharePoint file:%'") >= 5, "the SharePoint folder's files are searchable like documents");
  assert.equal(count("SELECT COUNT(*) FROM connector_items WHERE state = 'Skipped'"), 1, "one file too large to read, kept as a note");
  assert.equal(count("SELECT COUNT(*) FROM connector_links WHERE last_error IS NOT NULL"), 0, "every connection syncs cleanly (no broken tools in the demo)");
  assert.equal(count("SELECT COUNT(*) FROM connector_health WHERE status = 'broken'"), 0);
  assert.ok(count("SELECT COUNT(*) FROM passages WHERE source_type = 'workitem'") >= 10, "their work items are searchable");
  assert.ok(count("SELECT COUNT(*) FROM passages WHERE source_type = 'page'") >= 3, "the Confluence space's pages are searchable like documents");
  assert.ok(count("SELECT COUNT(*) FROM support_tickets") >= 5 && count("SELECT COUNT(*) FROM support_messages WHERE author_kind = 'staff'") >= 3, "tickets with replies");
  assert.ok(count("SELECT COUNT(*) FROM insights") >= 10, "knowledge maps");
  assert.ok(count("SELECT COUNT(*) FROM passages WHERE source_type = 'notes'") >= 50, "the rewritten notes are searchable again");
  assert.ok(count("SELECT COUNT(*) FROM org_flags WHERE enabled = 0") >= 1, "a feature restricted for one client");
  assert.ok(count("SELECT COUNT(*) FROM guard_custom_rules WHERE workspace_id IS NOT NULL") >= 1, "a stricter group");
  assert.ok(count("SELECT COUNT(*) FROM usage_events WHERE created_at < ?", new Date(Date.now() - 20 * 86400_000).toISOString()) > 100, "usage history");
  assert.equal(count("SELECT COUNT(*) FROM subscriptions WHERE status = 'past_due'"), 1);
  assert.equal(count("SELECT COUNT(*) FROM platform_admins"), 1, "the Owner Console account");
  // Capture-ready: AI credit under the 80% banner (only `--credit-banner` goes over), Teams posting to the fake Teams
  // with no failed Teams step in the last hour (Home's health line), and the Team Lead's own waiting chat.
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
  assert.ok(count(`SELECT COALESCE(SUM(cost_usd), 0) FROM usage_events WHERE org_id = ${northwind} AND created_at >= ?`, monthStart) < 800 * 0.8, "Northwind under 80% of its AI credit");
  assert.equal(count("SELECT COUNT(*) FROM teams_conversations WHERE service_url NOT LIKE ?", `http://127.0.0.1:${PORT + 1}/teams`), 0, "every chat posts to the fake Teams");
  assert.equal(count("SELECT COUNT(*) FROM trace_spans s JOIN traces t ON t.id = s.trace_id WHERE s.kind = 'teams' AND s.status = 'error' AND t.started_at >= ?", new Date(Date.now() - 3600_000).toISOString()), 0, "no failed Teams step in the last hour");
  assert.equal(count("SELECT COUNT(*) FROM teams_post_failures"), 0, "no failed Teams posts in the demo");
  assert.equal(count(`SELECT COUNT(*) FROM teams_conversations c JOIN users u ON u.entra_oid = c.added_by_oid WHERE c.name = 'Bid war room' AND c.workspace_id IS NULL AND u.email = 'priya.raman@northwind.example' AND u.role = 'Team Lead'`), 1, "the Team Lead can assign the chat she added");
  // The watchers ran once on the job queue and found something of every kind at Northwind.
  for (const kind of ["unanswered", "chat_waiting", "chat_removed", "overdue_items", "unowned_items", "stale_doc", "no_lead", "no_notes_chat", "connector_request", "misfiled_doc"]) {
    assert.ok(count(`SELECT COUNT(*) FROM findings WHERE org_id = ${northwind} AND kind = ? AND status = 'open'`, kind) >= 1, `a "${kind}" finding`);
  }
  for (const kind of ["failed_replies", "broken_connector"]) {
    assert.equal(count(`SELECT COUNT(*) FROM findings WHERE kind = ? AND status = 'open'`, kind), 0, `no "${kind}" finding: the demo shows working Teams and tools`);
  }
  assert.equal(count("SELECT COUNT(*) FROM jobs WHERE status = 'dead'"), 0, "no job gave up");
  // "Meeting notes go to": Contoso's two chats, notes to the internal one only; Litware's two chats, no choice yet.
  assert.equal(count("SELECT COUNT(*) FROM workspaces w JOIN notes_chats n ON n.workspace_id = w.id JOIN teams_conversations c ON c.id = n.conversation_id WHERE w.name LIKE 'Contoso%' AND w.notes_choice = 'chosen' AND c.guests = 0"), 1);
  assert.equal(count("SELECT COUNT(*) FROM notes_chats n JOIN workspaces w ON w.id = n.workspace_id WHERE w.name LIKE 'Contoso%'"), 1, "only one of Contoso's chats");
  assert.equal(count(`SELECT COUNT(*) FROM findings f JOIN workspaces w ON w.id = f.workspace_id WHERE f.org_id = ${northwind} AND f.kind = 'no_notes_chat' AND f.status = 'open' AND w.name LIKE 'Litware%' AND f.title LIKE 'Pick which chat%'`), 1, "Litware's Team Lead is asked to pick");
  // Allow → connect per group → request: four tool types allowed (Microsoft 365 through a request), connections per
  // group (Azure DevOps in Contoso and, separately, Litware), GitHub not allowed with one request declined (with a
  // note) and one waiting for the Org Owner.
  assert.equal(count(`SELECT COUNT(*) FROM connector_kinds WHERE org_id = ${northwind}`), 4);
  assert.equal(count(`SELECT COUNT(*) FROM connectors WHERE org_id = ${northwind} AND kind = 'ado'`), 2, "two groups, two Azure DevOps connections");
  assert.equal(count(`SELECT COUNT(*) FROM connector_links l JOIN connectors c ON c.id = l.connector_id WHERE l.workspace_id <> c.workspace_id`), 0, "every link is read through its own group's connection");
  assert.equal(count(`SELECT COUNT(*) FROM connector_kinds WHERE org_id = ${northwind} AND kind = 'github'`), 0, "GitHub isn't allowed");
  for (const [kind, status] of [["m365", "approved"], ["github", "declined"], ["github", "pending"]]) {
    assert.equal(count(`SELECT COUNT(*) FROM connector_requests WHERE org_id = ${northwind} AND kind = ? AND status = ?`, kind, status), 1, `${kind} ${status}`);
  }
  assert.equal(count(`SELECT COUNT(*) FROM connector_requests WHERE status = 'declined' AND note IS NOT NULL`), 1, "the decline has a note");
  // Automatic notes: meetings captured from Teams, one waiting for a group, one skipped, decisions saved to knowledge.
  assert.ok(count("SELECT COUNT(*) FROM meetings WHERE source = 'teams'") >= 4, "meetings captured from Teams");
  assert.equal(count(`SELECT COUNT(*) FROM auto_meetings WHERE org_id = ${northwind} AND enabled = 1`), 1);
  assert.equal(count("SELECT COUNT(*) FROM graph_meetings WHERE status = 'waiting'"), 1);
  assert.equal(count("SELECT COUNT(*) FROM graph_meetings WHERE status = 'skipped'"), 1);
  assert.equal(count("SELECT COUNT(*) FROM items WHERE pinned = 1 AND saved_by IS NOT NULL"), 2, "two decisions saved to knowledge");
  assert.ok(count("SELECT COUNT(*) FROM passages WHERE source_id LIKE 'saved:%'") >= 2, "and searchable");
  assert.match(out, /findings for Northwind's Org Owner \(10 kinds/);
  // Starter is 15 people: Tailspin sits one below.
  assert.equal(count("SELECT COUNT(*) FROM users WHERE org_id = (SELECT id FROM orgs WHERE name = 'Tailspin Partners')"), 14);
  // The private files exist, are only readable by this user, and hold every login.
  const saved = JSON.parse(fs.readFileSync(secrets, "utf8"));
  for (const k of ["operator", "orgOwner", "orgAdmin", "teamLead", "member", "viewer", "tailspinOwner"]) assert.ok(saved.passwords[k]?.length >= 12, k);
  assert.equal(fs.statSync(secrets).mode & 0o077, 0, "secrets file is private");
  const guide = fs.readFileSync(secrets.replace(/\.json$/, ".md"), "utf8");
  assert.match(guide, /LOCAL ONLY/);
  assert.ok(guide.includes(saved.passwords.orgOwner));
  assert.ok(!/Billing Admin/.test(guide), "the logins guide has no Billing Admin section (the role was retired)");
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
