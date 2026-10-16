/**
 * `npm test`: runs every automated test, on both database engines.
 *   1. Database-layer tests (tests/db.test.mjs) on SQLite, then Postgres.
 *   2. End-to-end API tests (tests/api.test.mjs) on SQLite, then Postgres.
 * Postgres tests use TEST_DATABASE_URL (default postgres:///sidekick_test, a database on this Mac that is
 * wiped first). If no Postgres is running, those are skipped with a warning; set REQUIRE_POSTGRES=1 to fail
 * instead (use that in CI). Nothing here touches app/data or any real service.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const PG_URL = process.env.TEST_DATABASE_URL || "postgres:///sidekick_test";
const node = process.execPath;
const results = [];

function step(name, args, env) {
  console.log(`\n▶ ${name}`);
  const r = spawnSync(node, ["--no-warnings", ...args], { cwd: APP, env: { ...process.env, ...env }, stdio: "inherit" });
  results.push({ name, ok: r.status === 0 });
}

function postgresAvailable() {
  const r = spawnSync("pg_isready", [], { encoding: "utf8" });
  if (r.status === 0) return true;
  console.warn(`\n⚠ Postgres isn't running, so the Postgres tests are skipped. Start it (brew services start postgresql@17) and run again.`);
  if (process.env.REQUIRE_POSTGRES === "1") process.exit(1);
  return false;
}

const dbName = new URL(PG_URL.replace("postgres:///", "postgres://localhost/")).pathname.slice(1);
const fresh = () => {
  spawnSync("dropdb", ["--if-exists", dbName], { stdio: "inherit" });
  spawnSync("createdb", [dbName], { stdio: "inherit" });
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-dbtest-"));
step("Database layer · SQLite", ["--conditions=react-server", "--test", "tests/db.test.mjs"], { SIDEKICK_DATA_DIR: tmp, DATABASE_URL: "" });
fs.rmSync(tmp, { recursive: true, force: true });

const pgOk = postgresAvailable();
if (pgOk) {
  fresh();
  step("Database layer · Postgres", ["--conditions=react-server", "--test", "tests/db.test.mjs"], { DATABASE_URL: PG_URL });
}

step("End-to-end API · SQLite", ["--test", "--test-timeout=300000", "tests/api.test.mjs"], { TEST_DB: "sqlite" });
if (pgOk) step("End-to-end API · Postgres", ["--test", "--test-timeout=300000", "tests/api.test.mjs"], { TEST_DB: "postgres", TEST_DATABASE_URL: PG_URL });

console.log("\nSummary");
for (const r of results) console.log(`  ${r.ok ? "✔" : "✖"} ${r.name}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
