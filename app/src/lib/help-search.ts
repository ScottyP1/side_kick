/**
 * @file Searching the help center: the shape of one searchable section and the matching rule. Kept apart
 * from lib/help.ts so the search box in the browser (components/help-search.tsx) doesn't download every
 * guide's Markdown: the page hands it only the sections. Pure, no I/O.
 */

/** One searchable piece of the help center: a heading of a guide (`id` = its anchor, "" for the intro) and the text under it. */
export type HelpSection = { slug: string; guide: string; heading: string; id: string; text: string };

/**
 * The sections matching a search: every word of `query` (case-insensitive) must appear in the heading or
 * text; heading matches come first. Used by the search box on /docs (components/help-search.tsx) and tests.
 */
export function searchHelp(sections: HelpSection[], query: string, limit = 12): HelpSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return sections
    .map((s) => {
      const head = s.heading.toLowerCase();
      const all = `${head} ${s.text.toLowerCase()}`;
      if (!words.every((w) => all.includes(w))) return null;
      return { s, score: words.filter((w) => head.includes(w)).length };
    })
    .filter((x) => x !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.s);
}
