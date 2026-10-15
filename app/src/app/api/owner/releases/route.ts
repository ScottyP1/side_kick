import fs from "node:fs";
import path from "node:path";
import { handle, readJson } from "@/lib/api";
import { HttpError } from "@/lib/auth";
import { MODELS } from "@/lib/claude";
import { all, now, run } from "@/lib/db";
import { FLAGS, flagEnabled, platformLog, requireOwner, type FlagKey } from "@/lib/owner";

// Reads the running build's version from package.json and the git checkout (if present).
function buildInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
  let branch: string | null = null;
  let commit: string | null = null;
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
  return {
    version: pkg.version,
    branch,
    commit,
    next: pkg.dependencies.next,
    sdk: pkg.dependencies["@anthropic-ai/sdk"],
    node: process.version,
    environment: process.env.NODE_ENV,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  };
}

export const GET = handle(async () => {
  await requireOwner();
  return {
    build: buildInfo(),
    models: MODELS,
    flags: (Object.keys(FLAGS) as FlagKey[]).map((k) => ({ key: k, ...FLAGS[k], enabled: flagEnabled(k) })),
    log: all("SELECT id, actor, action, created_at FROM platform_log ORDER BY id DESC LIMIT 50"),
  };
});

// Flip a kill switch for every client at once.
export const POST = handle(async (req: Request) => {
  const owner = await requireOwner();
  const { key, enabled } = await readJson<{ key?: string; enabled?: boolean }>(req);
  if (!key || !(key in FLAGS)) throw new HttpError(400, "Unknown switch.");
  run(
    "INSERT INTO platform_flags (key, enabled, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    key, enabled ? 1 : 0, owner.name, now(),
  );
  platformLog(owner.name, `${enabled ? "Turned on" : "Paused"} ${FLAGS[key as FlagKey].label} for all clients`);
  return { ok: true };
});
