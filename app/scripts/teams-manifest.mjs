// Fills the brand placeholders ({{BRAND_NAME}}, {{BRAND_SHORT}}, {{BRAND_TAGLINE}}, {{BRAND_ACCENT}}) of
// teams/manifest.template.json from app/src/lib/brand.ts, the single brand setting, and checks a finished
// manifest against Microsoft's schema and the Teams Store rules a schema can't express (validateManifest).
// Used by scripts/teams-package.mjs (refuses to build a package that fails) and by the tests
// (tests/db.test.mjs). No side effects: it only transforms and checks text.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { BRAND } from "../src/lib/brand.ts";

/** The template text with the brand filled in. */
export function fillBrand(text) {
  return text
    .replaceAll("{{BRAND_NAME}}", BRAND.name)
    .replaceAll("{{BRAND_SHORT}}", BRAND.shortName)
    .replaceAll("{{BRAND_TAGLINE}}", BRAND.tagline)
    .replaceAll("{{BRAND_ACCENT}}", BRAND.accent);
}

const teamsDir = path.resolve(import.meta.dirname, "../../teams");

/**
 * Problems with a finished manifest (placeholders filled), as plain sentences; empty when it's fine.
 * 1. Microsoft's JSON schema for its `manifestVersion`, kept in teams/schema/ (downloaded from
 *    developer.microsoft.com/json-schemas, so the check works offline and in CI). Field lengths come from here.
 * 2. Teams Store validation rules (docs/STORE-READINESS.md): https addresses, valid domains without protocols,
 *    wildcards or tunnels, no Microsoft product names in the app name, a semantic version, bot commands
 *    without a leading "/", command-list scopes that match the bot's, and privacy/terms links on the website.
 *    `store: false` (the dev-tunnel package) allows a tunnel address, which only the Store refuses.
 */
export function validateManifest(manifest, { store = true } = {}) {
  const problems = [];
  const schemaFile = path.join(teamsDir, "schema", `MicrosoftTeams.schema.v${manifest.manifestVersion}.json`);
  if (!fs.existsSync(schemaFile)) {
    problems.push(`No schema for manifestVersion ${manifest.manifestVersion} in teams/schema/ (download it from developer.microsoft.com/json-schemas/teams).`);
  } else {
    // Microsoft's schema is JSON Schema draft-04, which Ajv 6 checks once told about that draft.
    const require = createRequire(import.meta.url);
    const Ajv = require("ajv");
    const ajv = new Ajv({ schemaId: "auto", allErrors: true, unknownFormats: "ignore", logger: false });
    ajv.addMetaSchema(require("ajv/lib/refs/json-schema-draft-04.json"));
    const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
    delete schema.$schema;
    const check = ajv.compile(schema);
    const body = { ...manifest };
    delete body.$schema; // the schema's own address isn't part of what it checks
    if (!check(body)) for (const e of check.errors ?? []) problems.push(`Schema: ${e.dataPath || "(root)"} ${e.message}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) problems.push(`version "${manifest.version}" isn't MAJOR.MINOR.PATCH.`);
  const names = `${manifest.name?.short ?? ""} ${manifest.name?.full ?? ""}`;
  for (const word of ["Microsoft", "Office", "Excel", "PowerPoint", "Word", "OneDrive", "SharePoint", "OneNote", "Azure", "Outlook", "Copilot"]) {
    if (new RegExp(`\\b${word}\\b`).test(names)) problems.push(`The app name uses "${word}" (Store rule: no Microsoft product names).`);
  }
  if (/\b(beta|dev|preview|uat|test)\b/i.test(names)) problems.push("The app name has a pre-production word (Store rule).");
  if (/\bapp\b/i.test(manifest.description?.short ?? "")) problems.push(`The short description uses the word "app" (Store guidance).`);
  const urls = [manifest.developer?.websiteUrl, manifest.developer?.privacyUrl, manifest.developer?.termsOfUseUrl];
  for (const u of urls) if (!/^https:\/\//.test(u ?? "")) problems.push(`${u} isn't an https address.`);
  if (!/\/privacy$/.test(manifest.developer?.privacyUrl ?? "")) problems.push("privacyUrl should be the website's /privacy page.");
  if (!/\/terms$/.test(manifest.developer?.termsOfUseUrl ?? "")) problems.push("termsOfUseUrl should be the website's /terms page.");
  for (const d of manifest.validDomains ?? []) {
    if (/:\/\/|^www\./.test(d)) problems.push(`Valid domain "${d}" has a protocol or www.`);
    if (/\*/.test(d)) problems.push(`Valid domain "${d}" uses a wildcard.`);
    if (store && /devtunnels\.ms|ngrok|trycloudflare|loca\.lt/.test(d)) problems.push(`Valid domain "${d}" is a tunnel (not allowed in the Store).`);
    if (/(^|\.)((azurewebsites\.net)|(microsoft\.com)|(microsoftonline\.com)|(onmicrosoft\.com))$/.test(d)) problems.push(`Valid domain "${d}" is one the Store forbids.`);
  }
  for (const bot of manifest.bots ?? []) {
    for (const list of bot.commandLists ?? []) {
      if (list.scopes.some((s) => !bot.scopes.includes(s))) problems.push("A bot command list has a scope the bot doesn't have.");
      const titles = list.commands.map((c) => c.title.toLowerCase());
      if (new Set(titles).size !== titles.length) problems.push("Duplicate bot command titles.");
      for (const c of list.commands) {
        if (c.title.startsWith("/")) problems.push(`Bot command "${c.title}" starts with "/".`);
        if (!c.description) problems.push(`Bot command "${c.title}" has no description.`);
      }
    }
  }
  return problems;
}

export { BRAND };
