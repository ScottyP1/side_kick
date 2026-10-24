/**
 * @file The help center's guides (/docs): which guides are public, their titles and summaries, their content
 * as blocks (lib/markdown.ts), and the search index the help-center search box filters. Pure, no I/O: the
 * Markdown itself is a generated copy of docs/guide/ (lib/help-content.ts, from scripts/sync-help.mjs).
 *
 * Concepts
 * - **Public guide**: one of the guides copied into help-content.ts (concepts, admin, Teams, roles, install as
 *   an app). Only
 *   those exist here, looked up by name in a fixed map, so no address can reach any other file.
 * - **Links between guides**: `admin-guide.md#7-link-…` becomes `/docs/admin-guide#7-link-…`; links to
 *   anything else that isn't a public guide or a web address (developer docs like ../PROGRESS.md) keep their
 *   text but lose the link.
 * - **Search section**: one heading of one guide with its text, so a search hit can jump to `#heading`.
 */
import { GUIDE_MARKDOWN } from "./help-content";
import { parseMarkdown, plainText, type Block, type Inline, type ListItem } from "./markdown";
import type { HelpSection } from "./help-search";

export { searchHelp, type HelpSection } from "./help-search";

/** A public guide, ready to show: name (used in /docs/<name>), title, one-line summary and blocks. */
export type Guide = { slug: string; title: string; summary: string; blocks: Block[] };

/** Who each guide is for, shown on the help-center cards. */
const AUDIENCE: Record<string, string> = {
  concepts: "Everyone",
  "admin-guide": "Org Owners and Org Admins",
  "teams-guide": "Everyone in Teams",
  meetings: "Everyone",
  "roles-and-permissions": "Everyone",
  "install-app": "Everyone",
};

/** Turns a guide's link into a help-center address, or null to show only its text (see the file header). */
export function helpLink(href: string): string | null {
  if (/^https:\/\//.test(href)) return href;
  if (href.startsWith("#")) return href;
  const m = /^(?:\.\/)?([\w-]+)\.md(#[\w-]+)?$/.exec(href);
  if (m && Object.hasOwn(GUIDE_MARKDOWN, m[1])) return `/docs/${m[1]}${m[2] ?? ""}`;
  return null;
}

const cache = new Map<string, Guide>();

/** The public guide with this name, or null for anything else (unknown names, paths, other docs). */
export function guide(slug: string): Guide | null {
  if (typeof slug !== "string" || !Object.hasOwn(GUIDE_MARKDOWN, slug)) return null;
  let g = cache.get(slug);
  if (!g) {
    const blocks = parseMarkdown(GUIDE_MARKDOWN[slug], helpLink);
    const h1 = blocks.find((b) => b.t === "h" && b.level === 1);
    const firstP = blocks.find((b) => b.t === "p");
    g = {
      slug,
      title: h1 && h1.t === "h" ? h1.text : slug,
      summary: firstP && firstP.t === "p" ? plainText(firstP.c) : "",
      // The page shows the title itself, so the guide's own top heading is left out of the body.
      blocks: blocks.filter((b) => b !== h1),
    };
    cache.set(slug, g);
  }
  return g;
}

/** Every public guide, in help-center order, with who it's for. */
export function guides(): (Guide & { audience: string })[] {
  return Object.keys(GUIDE_MARKDOWN).map((slug) => ({ ...guide(slug)!, audience: AUDIENCE[slug] ?? "Everyone" }));
}


const listText = (items: ListItem[]): string => items.map((it) => [plainText(it.c), it.sub ? listText(it.sub.items) : "", ...(it.more ?? []).map(plainText)].join(" ")).join(" ");
function blockText(b: Block): string {
  if (b.t === "p") return plainText(b.c);
  if (b.t === "list") return listText(b.items);
  if (b.t === "table") return [b.head, ...b.rows].map((r) => r.map((c: Inline[]) => plainText(c)).join(" ")).join(" ");
  if (b.t === "quote") return b.c.map(plainText).join(" ");
  if (b.t === "code") return b.v;
  return "";
}

/** The search index: every section of every public guide (the text before the first heading counts as the guide's intro). */
export function helpSections(): HelpSection[] {
  const out: HelpSection[] = [];
  for (const g of guides()) {
    let cur: HelpSection = { slug: g.slug, guide: g.title, heading: g.title, id: "", text: "" };
    for (const b of g.blocks) {
      if (b.t === "h") {
        if (cur.id || cur.text) out.push(cur);
        cur = { slug: g.slug, guide: g.title, heading: b.text, id: b.id, text: "" };
      } else cur.text = `${cur.text} ${blockText(b)}`.trim();
    }
    out.push(cur);
  }
  return out;
}
