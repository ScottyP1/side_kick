/**
 * @file What the running app knows about itself, for the Owner Console's infrastructure health (business
 * view) and Releases page: health facts, the build it runs, and the releases it has seen.
 *
 * Concepts
 * - **Health facts**: the same yes/no checks as the public `/api/health` (database reachable, AI key set,
 *   search mode, Teams set up). No Azure dashboard is needed: the console reads them from the app itself.
 * - **Release**: the deploy sets `SIDEKICK_COMMIT` (short git commit) and `SIDEKICK_RELEASED_AT` (ISO time)
 *   on the container (see docs/HOSTING.md → Automatic deploys). Without them (a laptop), the commit is read
 *   from the git checkout. Each copy of the app records the release it runs once (`app_releases`), so the
 *   console can list the last deploys it has seen.
 */
import "server-only";
import fs from "node:fs";
import path from "node:path";
import { DIALECT, get, now, run } from "./db";
import { claudeConfigured } from "./claude";
import { azureSearchConfigured, embeddingsConfigured } from "./azure-search";

/** The running build: version, commit (deploy setting or git), release time, runtime and start time. */
export function buildInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
  let branch: string | null = null;
  let commit: string | null = process.env.SIDEKICK_COMMIT?.slice(0, 12) || null;
  if (!commit) {
    try {
      const gitDir = path.join(process.cwd(), "..", ".git");
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (head.startsWith("ref: ")) {
        const ref = head.slice(5);
        branch = ref.replace("refs/heads/", "");
        const refFile = path.join(gitDir, ref);
        commit = fs.existsSync(refFile) ? fs.readFileSync(refFile, "utf8").trim().slice(0, 7) : null;
      } else commit = head.slice(0, 7);
    } catch {}
  }
  return {
    version: pkg.version,
    branch,
    commit,
    releasedAt: process.env.SIDEKICK_RELEASED_AT || null,
    next: pkg.dependencies.next,
    sdk: pkg.dependencies["@anthropic-ai/sdk"],
    node: process.version,
    environment: process.env.NODE_ENV,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

/**
 * The `/api/health` checks: database (engine, reachable), AI key set, search mode, Teams bot set up, and
 * `commit`: the short commit the deploy set (`SIDEKICK_COMMIT`, first 7 characters), or null on a laptop.
 * The deploy workflow waits until health answers with the new commit, so it knows the new version (not the
 * old one) is answering. Only the short commit is shown: no branch, version numbers or release time.
 */
export async function healthFacts() {
  let database = false;
  try {
    database = Boolean(await get("SELECT 1 AS ok"));
  } catch (e) {
    console.error("Health check: database unreachable", e);
  }
  return {
    ok: database,
    database: { engine: DIALECT, reachable: database },
    claude: claudeConfigured(),
    search: azureSearchConfigured() ? (embeddingsConfigured() ? "azure-hybrid" : "azure-keyword") : "local-keyword",
    teams: Boolean(process.env.CLIENT_ID && process.env.CLIENT_SECRET),
    commit: process.env.SIDEKICK_COMMIT?.trim().slice(0, 7) || null,
  };
}

let noted = false;
/** Records the release this copy runs, once per process (never throws: health checks must not fail on it). */
export async function noteRelease() {
  if (noted) return;
  noted = true;
  const b = buildInfo();
  try {
    await run(
      "INSERT INTO app_releases (release_key, commit_sha, released_at, first_seen_at) VALUES (?, ?, ?, ?) ON CONFLICT (release_key) DO NOTHING",
      `${b.commit ?? "unknown"}@${b.releasedAt ?? b.startedAt.slice(0, 10)}`, b.commit, b.releasedAt, now(),
    );
  } catch (e) {
    noted = false;
    console.error("Couldn't record the running release", e);
  }
}
