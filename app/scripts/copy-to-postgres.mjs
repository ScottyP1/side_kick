// Copies everything from a Sidekick SQLite database into Postgres (for moving a laptop install to Azure).
//
// Usage (from app/):
//   DATABASE_URL=postgres://... npm run db:copy-to-postgres
//   (optional) SIDEKICK_DATA_DIR=<folder with sidekick.db>   default: app/data
//
// - The SQLite file is opened read-only: it is never changed.
// - The Postgres tables are created first if needed (same schema the app uses).
// - Rows that already exist in Postgres are skipped, so it's safe to run again.
// - Insertion order (rowid) is kept for meeting items, action items and passages.
// - At the end it prints a row count per table for both databases, so you can check nothing is missing.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const APP = path.resolve(import.meta.dirname, "..");
const SQLITE_PATH = path.join(process.env.SIDEKICK_DATA_DIR || path.join(APP, "data"), "sidekick.db");
const URL_ = process.env.DATABASE_URL;

if (!URL_) {
  console.error("✗ Set DATABASE_URL to the Postgres database to copy into.");
  process.exit(1);
}
if (!fs.existsSync(SQLITE_PATH)) {
  console.error(`✗ No SQLite database at ${SQLITE_PATH}`);
  process.exit(1);
}

// Parents before children, so foreign keys are satisfied.
const TABLES = [
  "orgs", "users", "sessions", "workspaces", "workspace_members", "documents", "meetings", "items", "action_items",
  "questions", "insights", "gap_status", "usage_events", "audit_log", "settings", "platform_admins", "owner_sessions",
  "platform_flags", "platform_log", "teams_conversations", "passages", "guard_rules", "guard_events",
];
// Tables where SQLite's hidden rowid carries meaning (order) and Postgres has an explicit rowid column.
const KEEP_ROWID = new Set(["items", "action_items", "passages"]);
// Columns Postgres computes itself.
const SKIP_COLUMNS = { passages: new Set(["tsv"]) };

const local = /^postgres(ql)?:\/\/\//.test(URL_) || /@(localhost|127\.0\.0\.1)[:/]/.test(URL_);
const pool = new pg.Pool({ connectionString: URL_, ssl: local ? undefined : { rejectUnauthorized: true }, allowExitOnIdle: true });
const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });

await pool.query(fs.readFileSync(path.join(APP, "db", "schema.postgres.sql"), "utf8"));

const pgColumns = async (table) =>
  (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = $1", [table])).rows.map((r) => r.column_name);

const report = [];
for (const table of TABLES) {
  const exists = sqlite.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(table);
  if (!exists) continue;
  const rows = sqlite.prepare(`SELECT ${KEEP_ROWID.has(table) ? "rowid, " : ""}* FROM ${table}`).all();
  const target = new Set(await pgColumns(table));
  let copied = 0;
  for (const row of rows) {
    const cols = Object.keys(row).filter((c) => target.has(c) && !SKIP_COLUMNS[table]?.has(c));
    const sql = `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`;
    const r = await pool.query(sql, cols.map((c) => row[c]));
    copied += r.rowCount ?? 0;
  }
  // Move id sequences past the copied values so new rows don't collide.
  for (const col of ["id", "rowid"].filter((c) => target.has(c))) {
    const seq = (await pool.query("SELECT pg_get_serial_sequence($1, $2) AS s", [table, col])).rows[0]?.s;
    if (seq) await pool.query(`SELECT setval($1, GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM ${table}), 1))`, [seq]);
  }
  const pgCount = Number((await pool.query(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0].n);
  report.push({ table, sqlite: rows.length, copied, postgres: pgCount });
}

console.table(report);
const missing = report.filter((r) => r.postgres < r.sqlite);
if (missing.length) {
  console.error(`✗ Some tables have fewer rows in Postgres: ${missing.map((r) => r.table).join(", ")}`);
  process.exit(1);
}
console.log("✓ Copy complete. Every table in Postgres has at least as many rows as SQLite.");
