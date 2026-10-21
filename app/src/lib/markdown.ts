/**
 * @file A small Markdown reader for the help center: turns the guides in docs/guide/ into a tree of blocks
 * (headings, paragraphs, lists, tables, quotes, code) that components/markdown.tsx renders as React elements.
 * Pure, no I/O, no dependency.
 *
 * Concepts
 * - **Safe by construction**: the output is data, never HTML. Text is rendered by React (so `<` stays text)
 *   and nothing uses dangerouslySetInnerHTML, so a guide can't inject markup or scripts (and the enforced
 *   Content-Security-Policy has nothing to object to).
 * - **Only what the guides use**: `#` headings, paragraphs, `-`/`1.` lists with one nested level, tables
 *   with alignment, `>` quotes, fenced code, and inline `**bold**`, `*italic*`, `` `code` `` and `[links](…)`.
 * - **Links** go through a `link` function the caller gives: it returns the href to use, or null to show
 *   the link's text without a link (lib/help.ts uses it to keep internal docs off the public site).
 */

/** Inline text: plain, bold, italic, code or a link (whose text can itself hold bold/italic/code). */
export type Inline =
  | { t: "text"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string; c: Inline[] };

/** One list item: its text, an optional nested list, then any further paragraphs (indented after a blank line). */
export type ListItem = { c: Inline[]; sub?: { ordered: boolean; items: ListItem[] }; more?: Inline[][] };

/** A block of a guide. Headings carry an `id` for links like /docs/admin-guide#4-add-people. */
export type Block =
  | { t: "h"; level: number; id: string; text: string; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "list"; ordered: boolean; items: ListItem[] }
  | { t: "table"; align: ("left" | "center" | "right" | null)[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "quote"; c: Inline[][] }
  | { t: "code"; v: string };

/** Decides what a link points to: the href to use, or null to drop the link and keep its text. */
export type LinkRule = (href: string) => string | null;

/** Plain text of some inline nodes (for heading ids, search and page descriptions). */
export function plainText(nodes: Inline[]): string {
  return nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : plainText(n.c))).join("");
}

/** "4. Add people" → "4-add-people": the id GitHub gives a heading, so links written for GitHub work here. */
export function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
}

const INLINE = /(\*\*(.+?)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*\s][^*]*?)\*)/;

/** Reads inline Markdown (bold, italic, code, links) in one line of text. */
export function parseInline(text: string, link: LinkRule): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push({ t: "text", v: rest });
      break;
    }
    if (m.index) out.push({ t: "text", v: rest.slice(0, m.index) });
    if (m[2] !== undefined) out.push({ t: "b", c: parseInline(m[2], link) });
    else if (m[3] !== undefined) out.push({ t: "code", v: m[3] });
    else if (m[4] !== undefined) {
      const inner = parseInline(m[4], link);
      const href = link(m[5]);
      if (href) out.push({ t: "a", href, c: inner });
      else out.push(...inner);
    } else out.push({ t: "i", c: parseInline(m[6], link) });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const LIST = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Reads a whole Markdown document into blocks. Heading ids are unique within the document. */
export function parseMarkdown(source: string, link: LinkRule): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  const uniqueId = (text: string) => {
    const base = slugify(text) || "section";
    const n = ids.get(base) ?? 0;
    ids.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const c = parseInline(heading[2].trim(), link);
      const text = plainText(c);
      blocks.push({ t: "h", level: heading[1].length, id: uniqueId(text), text, c });
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push({ t: "code", v: body.join("\n") });
      continue;
    }
    if (line.trimStart().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) rows.push(cells(lines[i++]));
      const sep = rows.length > 1 && rows[1].every((c) => /^:?-+:?$/.test(c)) ? rows[1] : null;
      const align = (sep ?? rows[0]).map((c) => (!sep ? null : c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : c.startsWith(":") ? "left" : null));
      const body = sep ? rows.slice(2) : rows.slice(1);
      blocks.push({ t: "table", align, head: rows[0].map((c) => parseInline(c, link)), rows: body.map((r) => r.map((c) => parseInline(c, link))) });
      continue;
    }
    if (line.startsWith(">")) {
      const paras: string[][] = [[]];
      while (i < lines.length && lines[i].startsWith(">")) {
        const text = lines[i++].replace(/^>\s?/, "");
        if (text.trim()) paras[paras.length - 1].push(text.trim());
        else if (paras[paras.length - 1].length) paras.push([]);
      }
      blocks.push({ t: "quote", c: paras.filter((p) => p.length).map((p) => parseInline(p.join(" "), link)) });
      continue;
    }
    const first = LIST.exec(line);
    if (first) {
      const top = { ordered: /\d/.test(first[2]), items: [] as ListItem[] };
      const baseIndent = first[1].length;
      // Raw text per item, joined at the end so continuation lines become part of the item.
      const raw: { text: string[]; sub?: { ordered: boolean; items: { text: string[] }[] }; more: string[][] }[] = [];
      let afterBlank = false;
      while (i < lines.length) {
        const l = lines[i];
        const m = LIST.exec(l);
        if (m && m[1].length <= baseIndent + 1) raw.push({ text: [m[3]], more: [] });
        else if (m && raw.length) {
          const last = raw[raw.length - 1];
          last.sub ??= { ordered: /\d/.test(m[2]), items: [] };
          last.sub.items.push({ text: [m[3]] });
        } else if (l.trim() && /^\s+/.test(l) && raw.length) {
          const last = raw[raw.length - 1];
          // After a blank line an indented line starts a new paragraph of the item; otherwise it carries on the line above.
          if (afterBlank) last.more.push([l.trim()]);
          else (last.more.at(-1) ?? last.sub?.items.at(-1)?.text ?? last.text).push(l.trim());
        } else if (!l.trim()) {
          // A blank line ends the list unless the next line carries on with it.
          const next = lines[i + 1] ?? "";
          if (!(LIST.test(next) || (/^\s+\S/.test(next) && raw.length))) break;
        } else break;
        afterBlank = !l.trim();
        i++;
      }
      top.items = raw.map((r) => ({
        c: parseInline(r.text.join(" "), link),
        sub: r.sub && { ordered: r.sub.ordered, items: r.sub.items.map((s) => ({ c: parseInline(s.text.join(" "), link) })) },
        more: r.more.length ? r.more.map((p) => parseInline(p.join(" "), link)) : undefined,
      }));
      blocks.push({ t: "list", ...top });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*\|)/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++].trim());
    blocks.push({ t: "p", c: parseInline(para.join(" "), link) });
  }
  return blocks;
}
