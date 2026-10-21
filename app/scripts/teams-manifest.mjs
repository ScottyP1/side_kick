// Fills the brand placeholders ({{BRAND_NAME}}, {{BRAND_SHORT}}, {{BRAND_TAGLINE}}, {{BRAND_ACCENT}}) of
// teams/manifest.template.json from app/src/lib/brand.ts, the single brand setting. Used by
// scripts/teams-package.mjs and by the test that checks the manifest uses the brand (tests/db.test.mjs).
// No side effects: it only transforms text.
import { BRAND } from "../src/lib/brand.ts";

/** The template text with the brand filled in. */
export function fillBrand(text) {
  return text
    .replaceAll("{{BRAND_NAME}}", BRAND.name)
    .replaceAll("{{BRAND_SHORT}}", BRAND.shortName)
    .replaceAll("{{BRAND_TAGLINE}}", BRAND.tagline)
    .replaceAll("{{BRAND_ACCENT}}", BRAND.accent);
}

export { BRAND };
