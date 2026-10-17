/**
 * `npm test`: runs every automated test, on both database engines.
 *   1. Database-layer tests (tests/db.test.mjs) on SQLite, then Postgres.
 *   2. End-to-end API tests (tests/api.test.mjs) on SQLite, then Postgres.
 *   3. Production build (`next build`), the same step the Docker image and the Azure deploy run. The tests
 *      above use `next dev`, which lets through some errors only a production build reports (for example a
 *      page that needs a <Suspense> boundary under cacheComponents), so this catches them before a deploy does.
 * Postgres tests use TEST_DATABASE_URL (default postgres:///sidekick_test, a database on this Mac that is
 * wiped first). If no Postgres is running, those are skipped with a warning; set REQUIRE_POSTGRES=1 to fail
 * instead (use that in CI). Nothing here touches app/data or any real service: the build uses its own
 * throwaway build folder (.next-test-build) and data folder, with every service key blanked, so it can run
 * while a dev server is up. Set SKIP_BUILD=1 to leave the build out when iterating on tests.
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
step("Database layer · SQLite", ["--conditions=react-server", "--import", "./tests/register-ts.mjs", "--test", "tests/db.test.mjs"], { SIDEKICK_DATA_DIR: tmp, DATABASE_URL: "" });
fs.rmSync(tmp, { recursive: true, force: true });

const pgOk = postgresAvailable();
if (pgOk) {
  fresh();
  step("Database layer · Postgres", ["--conditions=react-server", "--import", "./tests/register-ts.mjs", "--test", "tests/db.test.mjs"], { DATABASE_URL: PG_URL });
}

step("End-to-end API · SQLite", ["--test", "--test-timeout=300000", "tests/api.test.mjs"], { TEST_DB: "sqlite" });
if (pgOk) step("End-to-end API · Postgres", ["--test", "--test-timeout=300000", "tests/api.test.mjs"], { TEST_DB: "postgres", TEST_DATABASE_URL: PG_URL });

/**
 * Runs `next build` like the Docker image does, in a throwaway build folder (NEXT_DIST_DIR) so it never
 * clashes with a running dev server's .next, against an empty temp data folder with service keys blanked
 * (as in the image, where secrets only arrive at run time). Next rewrites tsconfig.json (adds its build
 * folder) and next-env.d.ts during a build; both are put back exactly as they were. On failure, prints the
 * end of the build output and a plain explanation, and the run fails.
 */
function productionBuild() {
  const name = "Production build (next build)";
  console.log(`\n▶ ${name}`);
  if (process.env.SKIP_BUILD === "1") {
    console.warn("⚠ SKIP_BUILD=1, so the production build is skipped. Run without it before committing.");
    return;
  }
  const distDir = ".next-test-build";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sidekick-buildtest-"));
  const saved = ["tsconfig.json", "next-env.d.ts"].map((f) => {
    const file = path.join(APP, f);
    return { file, text: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null };
  });
  const started = Date.now();
  let r;
  try {
    r = spawnSync(path.join(APP, "node_modules/.bin/next"), ["build"], {
      cwd: APP,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
      env: {
        ...process.env,
        NODE_ENV: "production",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_DIST_DIR: distDir,
        SIDEKICK_DATA_DIR: dataDir,
        DATABASE_URL: "",
        ANTHROPIC_API_KEY: "",
        AZURE_SEARCH_ENDPOINT: "",
        AZURE_SEARCH_API_KEY: "",
        AZURE_OPENAI_ENDPOINT: "",
        AZURE_OPENAI_API_KEY: "",
        CLIENT_ID: "",
        CLIENT_SECRET: "",
        TENANT_ID: "",
        ENTRA_CLIENT_ID: "",
        ENTRA_CLIENT_SECRET: "",
      },
    });
  } finally {
    for (const { file, text } of saved) {
      if (text === null) fs.rmSync(file, { force: true });
      else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text) fs.writeFileSync(file, text);
    }
    fs.rmSync(path.join(APP, distDir), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  const ok = r.status === 0;
  if (ok) {
    console.log(`✔ Production build succeeded in ${Math.round((Date.now() - started) / 1000)}s.`);
  } else {
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n");
    console.error(output.slice(-80).join("\n"));
    if (r.error) console.error(r.error.message);
    console.error(
      "\n✖ The production build (next build) failed, so the Docker image and the Azure deploy would fail too." +
        "\n  The tests above passed because they run next dev, which allows some things a production build refuses." +
        "\n  Read the error above (last 80 lines of the build output), fix it, and run `npm --prefix app test` again." +
        "\n  To see the full output: npm --prefix app run build",
    );
  }
  results.push({ name, ok });
}

productionBuild();

console.log("\nSummary");
for (const r of results) console.log(`  ${r.ok ? "✔" : "✖"} ${r.name}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
