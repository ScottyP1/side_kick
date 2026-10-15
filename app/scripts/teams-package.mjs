// Builds the Teams app package (manifest + icons) that you upload to Teams as a custom app.
// Usage: npm --prefix app run teams:package
// Reads CLIENT_ID (the Azure Bot's Microsoft App ID) and SIDEKICK_PUBLIC_URL (https address of the app,
// e.g. the dev tunnel) from the environment or app/.env.local. Output: teams/build/sidekick-teams.zip
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const src = path.join(root, "teams");
const out = path.join(src, "build");

// Only the two non-secret values are read from .env.local; nothing else in it is touched.
const env = { ...process.env };
const envFile = path.join(root, "app/.env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(CLIENT_ID|SIDEKICK_PUBLIC_URL)\s*=\s*"?([^"\s#]*)"?/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
}

const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const botId = env.CLIENT_ID ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(botId)) {
  fail("CLIENT_ID is missing or not a GUID. Put the Azure Bot's Microsoft App ID in app/.env.local as CLIENT_ID=...");
}
let publicUrl;
try {
  publicUrl = new URL(env.SIDEKICK_PUBLIC_URL ?? "");
} catch {
  fail("SIDEKICK_PUBLIC_URL is missing. Put the app's https address (your dev tunnel) in app/.env.local.");
}
if (publicUrl.protocol !== "https:") fail("SIDEKICK_PUBLIC_URL must start with https:// (Teams only accepts https).");

const manifest = fs
  .readFileSync(path.join(src, "manifest.template.json"), "utf8")
  .replaceAll("{{BOT_ID}}", botId.toLowerCase())
  .replaceAll("{{PUBLIC_URL}}", publicUrl.origin)
  .replaceAll("{{PUBLIC_HOST}}", publicUrl.host);
JSON.parse(manifest); // fail early on a broken template

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "manifest.json"), manifest);
for (const icon of ["color.png", "outline.png"]) fs.copyFileSync(path.join(src, icon), path.join(out, icon));
execFileSync("zip", ["-q", "sidekick-teams.zip", "manifest.json", "color.png", "outline.png"], { cwd: out });

console.log(`✓ Built teams/build/sidekick-teams.zip
  Bot ID:   ${botId}
  App URL:  ${publicUrl.origin} (messaging endpoint: ${publicUrl.origin}/api/messages)
Upload it in Teams: Apps → Manage your apps → Upload an app → Upload a custom app.`);
