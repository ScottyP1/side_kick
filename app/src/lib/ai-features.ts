/**
 * Plain names for the AI features (the `feature` of `lib/claude.ts` calls, as stored in `usage_events.feature`), so
 * every screen shows "Reminders" or "Document checks" instead of raw ids like `remind` or `watch`. Used by the Owner
 * Console (Overview, Performance, Releases); safe to import in browser code (no server imports).
 *
 * A new feature in `MODELS` (lib/claude.ts) needs a name here too: tests/db.test.mjs checks every one has one.
 */
import type { Feature } from "./claude";

/** The name of each AI feature, as the Owner Console shows it. */
export const AI_FEATURE_LABEL: Record<Feature, string> = {
  ask: "Answering questions",
  extract: "Meeting notes",
  insights: "Knowledge map",
  assist: "In-app assistant",
  guard: "Guardrail check",
  remind: "Reminders",
  support: "Support assistant",
  helpbot: "Public help bot",
  followup: "Follow-up rewrite",
  watch: "Document checks",
};

/** The plain name for a feature id; an unknown id (e.g. an old row) is shown as it is. */
export function aiFeatureLabel(feature: string): string {
  return (AI_FEATURE_LABEL as Record<string, string>)[feature] ?? feature;
}
