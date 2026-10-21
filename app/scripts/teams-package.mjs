// Builds the Teams app package (manifest + icons) that you upload to Teams: one official package for the
// live Azure site, or a local one for the dev tunnel.
// Usage: npm --prefix app run teams:package            → teams/build/sidekick-teams-live.zip (default)
//        npm --prefix app run teams:package -- --local → teams/build/sidekick-teams-local.zip
// Both use the same Teams app ID (the Azure Bot's Microsoft App ID, CLIENT_ID), so to Teams they are the
// same app: uploading one replaces the other. Messages always go wherever the Azure Bot's messaging
// endpoint points (the live site since Oct 16, 2026), whichever package is installed. The package only
// sets the app's web address (links, valid domains, sign-in resource).
// Live address: SIDEKICK_LIVE_URL if set, otherwise asked from Azure (`az login` needed), like deploy.sh.
// Local address: SIDEKICK_PUBLIC_URL (the dev tunnel). CLIENT_ID and SIDEKICK_PUBLIC_URL are read from the
// environment or app/.env.local; nothing secret is read or written.
// Entra app in webApplicationInfo: ENTRA_CLIENT_ID (the multi-tenant sign-in/directory app) when set, else the
// bot's app. Microsoft ties the Teams app's resource-specific and "self" installation permissions to that app,
// which is how Sidekick may remove itself from a chat (lib/teams/install.ts, docs/TEAMS-MULTITENANT.md).
// Public website (store listing: website, privacy /privacy and terms /terms pages): SIDEKICK_WEBSITE_URL if
// set (e.g. a custom domain), otherwise the app's own address, which serves those pages.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const src = path.join(root, "teams");
const out = path.join(src, "build");
const flavor = process.argv.includes("--local") ? "local" : "live";

// Only these non-secret values are read from .env.local; nothing else in it is touched.
const env = { ...process.env };
const envFile = path.join(root, "app/.env.local");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(CLIENT_ID|ENTRA_CLIENT_ID|SIDEKICK_PUBLIC_URL|SIDEKICK_LIVE_URL|SIDEKICK_WEBSITE_URL)\s*=\s*"?([^"\s#]*)"?/);
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

/** The live site's https address: SIDEKICK_LIVE_URL, or the container app's address from Azure. */
function liveUrl() {
  if (env.SIDEKICK_LIVE_URL) return env.SIDEKICK_LIVE_URL;
  try {
    const fqdn = execFileSync("az", ["containerapp", "show", "-g", "sidekick-rg", "-n", "sidekick-app", "--query", "properties.configuration.ingress.fqdn", "-o", "tsv"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (fqdn) return `https://${fqdn}`;
  } catch {}
  fail("Couldn't get the live address from Azure. Run `az login` first, or set SIDEKICK_LIVE_URL=https://... (or use --local for the dev tunnel).");
}

let publicUrl;
try {
  publicUrl = new URL(flavor === "live" ? liveUrl() : (env.SIDEKICK_PUBLIC_URL ?? ""));
} catch {
  fail(flavor === "live" ? "The live address isn't a valid URL." : "SIDEKICK_PUBLIC_URL is missing. Put the app's https address (your dev tunnel) in app/.env.local.");
}
if (publicUrl.protocol !== "https:") fail("The app's address must start with https:// (Teams only accepts https).");

let websiteUrl = publicUrl;
if (env.SIDEKICK_WEBSITE_URL) {
  try {
    websiteUrl = new URL(env.SIDEKICK_WEBSITE_URL);
  } catch {
    fail("SIDEKICK_WEBSITE_URL isn't a valid URL.");
  }
  if (websiteUrl.protocol !== "https:") fail("SIDEKICK_WEBSITE_URL must start with https://.");
}

const template = fs.readFileSync(path.join(src, "manifest.template.json"), "utf8");
const manifest = template
  .replaceAll("{{AAD_APP_ID}}", (env.ENTRA_CLIENT_ID || botId).toLowerCase())
  .replaceAll("{{BOT_ID}}", botId.toLowerCase())
  .replaceAll("{{PUBLIC_URL}}", publicUrl.origin)
  .replaceAll("{{PUBLIC_HOST}}", publicUrl.host)
  .replaceAll("{{WEBSITE_URL}}", websiteUrl.origin)
  .replaceAll("{{WEBSITE_HOST}}", websiteUrl.host);
const parsed = JSON.parse(manifest); // also fails early on a broken template
const { version } = parsed;
// Teams refuses duplicate valid domains.
parsed.validDomains = [...new Set(parsed.validDomains)];
const manifestOut = JSON.stringify(parsed, null, 2);

// Each flavor is staged in its own folder (both have a manifest.json) and zipped next to the other.
const stage = path.join(out, flavor);
const zip = `sidekick-teams-${flavor}.zip`;
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(path.join(out, zip), { force: true });
// Leftovers of the old unlabeled package (before Oct 20, 2026): ambiguous about where it points, so removed.
for (const old of ["sidekick-teams.zip", "manifest.json", "color.png", "outline.png"]) fs.rmSync(path.join(out, old), { force: true });
fs.mkdirSync(stage, { recursive: true });
fs.writeFileSync(path.join(stage, "manifest.json"), manifestOut);
for (const icon of ["color.png", "outline.png"]) fs.copyFileSync(path.join(src, icon), path.join(stage, icon));
execFileSync("zip", ["-q", path.join(out, zip), "manifest.json", "color.png", "outline.png"], { cwd: stage });

console.log(`✓ Built teams/build/${zip} (${flavor}, version ${version})
  Teams app / bot ID: ${botId}
  App address:        ${publicUrl.origin}
${
  flavor === "live"
    ? `Upload it once to the org app catalog: Teams admin center → Teams apps → Manage apps → Upload new app
(an update: open Sidekick there → Upload file). People then add it from "Built for your org".`
    : `⚠ Local package: only useful while the Azure Bot's messaging endpoint points at your dev tunnel.
  Uploading it replaces the live package in Teams (same app ID); upload the live one again afterwards.`
}`);
