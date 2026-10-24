/**
 * @file Pure helpers for connectors (lib/connectors.ts): turning a work item from Azure DevOps, Jira or GitHub, a
 * Confluence page, or a SharePoint / OneDrive file (Microsoft 365), into the plain text Sidekick indexes, and turning each tool's rich text (ADO's HTML, Jira's
 * "Atlassian Document Format", Confluence's storage format) into plain text. No I/O, so the unit tests in
 * tests/db.test.mjs can call them directly.
 *
 * Concepts
 * - **Work item**: one ADO work item (bug, task, user story...), one Jira issue, or one GitHub issue or pull
 *   request, read-only. Sidekick keeps its title, type, state, assignee, due date, link, what blocks it, its
 *   description and a short summary of the latest comments, written out as one small text "card"
 *   (`workItemText`) so Ask, Memory & gaps and meeting notes can use it like any other source, and cite it with a
 *   link back to the tool.
 * - **Page** (Confluence): a wiki page is a *document*, not a task: it is indexed with its whole text
 *   (`pageText`, cut at `PAGE_MAX`) as source type `page`, searched and cited like an uploaded document (with a
 *   link to the page), and kept out of the "open work items" lists. `isPageKind` says which tools hold pages.
 * - **File** (Microsoft 365: SharePoint document libraries, OneDrive shared folders): a Word, PDF, PowerPoint or
 *   text file read through the upload path's extraction (lib/extract.ts), indexed like a page (`fileText`, cut at
 *   `FILE_MAX`) as source type `page`, cited with a link to the file. A file Sidekick won't read (too large, or it
 *   couldn't be opened) is kept as a short note card saying so (`state` "Skipped"), so people see it exists.
 * - **Comments summary**: not written by AI (that would cost a Claude call per item on every sync): the number
 *   of comments plus the latest few, each cut short, newest first.
 */

/**
 * Which tool a connector reads from: Azure DevOps Boards, Jira Cloud, GitHub Issues, Confluence Cloud, or
 * Microsoft 365 files (`m365`: SharePoint document libraries and OneDrive shared folders, one sign-in for both).
 */
export type ConnectorKind = "ado" | "jira" | "github" | "confluence" | "m365";
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ["ado", "jira", "github", "confluence", "m365"];
/** The tool's name as people see it. */
export const KIND_LABEL: Record<ConnectorKind, string> = { ado: "Azure DevOps", jira: "Jira", github: "GitHub", confluence: "Confluence", m365: "Microsoft 365" };
/** What one linked "project" is called in each tool (a GitHub repository, a Confluence space, a SharePoint library or folder). */
export const PROJECT_WORD: Record<ConnectorKind, string> = { ado: "project", jira: "project", github: "repository", confluence: "space", m365: "library or folder" };

/** True for tools whose items are documents (Confluence pages, Microsoft 365 files), not work items. See the file comment. */
export const isPageKind = (kind: ConnectorKind) => kind === "confluence" || kind === "m365";

/**
 * One work item (ADO), issue (Jira), issue or pull request (GitHub), page (Confluence) or file (Microsoft 365) as
 * Sidekick keeps it. `externalId` is "4821" (ADO), "CUT-12" (Jira), "store-pos#12" (GitHub: repository name and
 * number), the Confluence page id or the Microsoft Graph drive item id. For a file, `type` is "SharePoint file" or
 * "OneDrive file", `assignee` who changed it last, `parent` its folder, and `description` its extracted text.
 */
export type WorkItem = {
  externalId: string;
  type: string | null;
  title: string;
  state: string | null;
  assignee: string | null;
  /** YYYY-MM-DD, or null. */
  dueOn: string | null;
  url: string;
  /** When the tool last changed it (ISO). The sync cursor moves to the latest one seen. */
  changedAt: string;
  description: string;
  /** What blocks it, e.g. "#4810 Firewall change request (New)". */
  blockedBy: string[];
  parent: string | null;
  tags: string[];
  commentCount: number;
  /** The latest few comments, newest first. */
  comments: { author: string; at: string | null; text: string }[];
};

const DESCRIPTION_MAX = 2500;
const COMMENT_MAX = 300;
const COMMENTS_KEPT = 3;

/** Squeezes whitespace and cuts `s` to `max` characters (with "…"). */
export const squeeze = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** ADO's HTML (descriptions, comments) as plain text: tags dropped, block tags become line breaks, entities decoded. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
      if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
      if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)));
      return m;
    })
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

type AdfNode = { type?: string; text?: string; content?: AdfNode[]; attrs?: Record<string, unknown> };

/**
 * Jira's Atlassian Document Format (descriptions, comments: a JSON tree) as plain text. Paragraphs and list items
 * become lines; mentions keep the person's name. A plain string (older Jira) is returned as it is.
 */
export function adfToText(doc: unknown): string {
  if (!doc) return "";
  if (typeof doc === "string") return doc.trim();
  const out: string[] = [];
  const walk = (n: AdfNode) => {
    if (n.type === "text" && n.text) out.push(n.text);
    else if (n.type === "mention") out.push(String(n.attrs?.text ?? ""));
    else if (n.type === "hardBreak") out.push("\n");
    for (const c of n.content ?? []) walk(c);
    if (["paragraph", "heading", "listItem", "blockquote", "codeBlock"].includes(n.type ?? "")) out.push("\n");
  };
  walk(doc as AdfNode);
  return out.join("").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

/**
 * "Azure DevOps Bug #4821: …" / "Jira CUT-12: …" / "GitHub Pull request store-pos#12: …" / "Confluence page: …" /
 * "SharePoint file: …" / "OneDrive file: …": the title a work item, page or file is searched and cited by.
 */
export function workItemTitle(kind: ConnectorKind, item: Pick<WorkItem, "externalId" | "title" | "type">): string {
  if (kind === "m365") return `${item.type === "OneDrive file" ? "OneDrive" : "SharePoint"} file: ${squeeze(item.title, 200)}`;
  if (isPageKind(kind)) return `${KIND_LABEL[kind]} page: ${squeeze(item.title, 200)}`;
  const id = kind === "ado" ? `#${item.externalId}` : item.externalId;
  return `${KIND_LABEL[kind]}${item.type ? ` ${item.type}` : ""} ${id}: ${squeeze(item.title, 200)}`;
}

/**
 * The text Sidekick indexes for one work item: a short card with its facts, then the description and the
 * comments summary. `project` is the project's name. Never includes tokens or anything from other items except
 * the titles of what blocks it.
 */
export function workItemText(kind: ConnectorKind, project: string, item: WorkItem): string {
  const facts = [
    item.state ? `State: ${item.state}` : null,
    `Assigned to: ${item.assignee ?? "nobody"}`,
    item.dueOn ? `Due: ${item.dueOn}` : null,
    item.type ? `Type: ${item.type}` : null,
  ].filter(Boolean).join(" · ");
  const lines = [
    workItemTitle(kind, item),
    facts,
    `Project: ${project} (${KIND_LABEL[kind]})`,
    item.parent ? `Part of: ${item.parent}` : null,
    item.blockedBy.length ? `Blocked by: ${item.blockedBy.join("; ")}` : null,
    item.tags.length ? `Tags: ${item.tags.join(", ")}` : null,
    `Last changed: ${item.changedAt.slice(0, 10)}`,
    `Link: ${item.url}`,
    item.description ? `Description: ${squeeze(item.description, DESCRIPTION_MAX)}` : null,
    commentsSummary(item),
  ];
  return lines.filter(Boolean).join("\n");
}

/** At most this much of a page's text is indexed (about 40 passages); longer pages are cut. */
export const PAGE_MAX = 50_000;

/**
 * The text Sidekick indexes for one Confluence page: its title, the space, where it sits (`parent`: its
 * ancestors), labels, who changed it last and when, the link, then the page's own text (up to `PAGE_MAX`).
 * lib/search.ts cuts it into passages like an uploaded document.
 */
export function pageText(kind: ConnectorKind, space: string, item: WorkItem): string {
  const body = item.description.length > PAGE_MAX ? `${item.description.slice(0, PAGE_MAX - 1).trimEnd()}…` : item.description;
  const lines = [
    workItemTitle(kind, item),
    `Space: ${space} (${KIND_LABEL[kind]})`,
    item.parent ? `Part of: ${item.parent}` : null,
    item.tags.length ? `Labels: ${item.tags.join(", ")}` : null,
    `Last changed: ${item.changedAt.slice(0, 10)}${item.assignee ? ` by ${item.assignee}` : ""}`,
    `Link: ${item.url}`,
    body ? `\n${body}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/** At most this much of a file's text is indexed (about 170 passages); longer files are cut, saying so. */
export const FILE_MAX = 200_000;

/**
 * The text Sidekick indexes for one Microsoft 365 file: its title, the library or folder it was linked from, the
 * folder it sits in, who changed it last and when, the link, then the file's extracted text (up to `FILE_MAX`,
 * keeping `[Page N]` / `[Slide N]` markers so answers cite where). A skipped file (`state` "Skipped") is just
 * the card with the reason in `description`, so it can be found by name but nothing of it is read.
 */
export function fileText(library: string, item: WorkItem): string {
  const cut = item.description.length > FILE_MAX;
  const body = cut ? `${item.description.slice(0, FILE_MAX - 1).trimEnd()}…\n(Only the first part of this file was read.)` : item.description;
  const lines = [
    workItemTitle("m365", item),
    `${item.type === "OneDrive file" ? "Shared folder" : "Library"}: ${library} (${item.type === "OneDrive file" ? "OneDrive" : "SharePoint"})`,
    item.parent ? `Folder: ${item.parent}` : null,
    `Last changed: ${item.changedAt.slice(0, 10)}${item.assignee ? ` by ${item.assignee}` : ""}`,
    `Link: ${item.url}`,
    item.state === "Skipped" ? `Not read: ${body}` : body ? `\n${body}` : null,
  ];
  return lines.filter(Boolean).join("\n");
}

/** "Comments (5, latest first): Priya Shah (2026-10-20): …; …", or null when there are none. */
export function commentsSummary(item: Pick<WorkItem, "commentCount" | "comments">): string | null {
  if (!item.commentCount && !item.comments.length) return null;
  const kept = item.comments.slice(0, COMMENTS_KEPT).map((c) => `${c.author}${c.at ? ` (${c.at.slice(0, 10)})` : ""}: ${squeeze(c.text, COMMENT_MAX)}`);
  const n = Math.max(item.commentCount, item.comments.length);
  return `Comments (${n}${kept.length ? ", latest first" : ""})${kept.length ? `: ${kept.join("; ")}` : ""}`;
}

/** A due date from the tool as YYYY-MM-DD (ADO sends a full timestamp, Jira a day), or null. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const m = value.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Any timestamp the tool sends ("2026-10-20T10:00:00.000+0000") as ISO, or `fallback`. */
export function isoOf(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const fixed = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const t = new Date(fixed);
  return Number.isNaN(t.getTime()) ? fallback : t.toISOString();
}

/** States that mean "finished" in the usual ADO, Jira and GitHub workflows (for "open items" lists). */
export const isDoneState = (state: string | null) => /^(done|closed|resolved|removed|completed|cancel+ed|merged)$/i.test(state ?? "");

/** An ADO organization name as typed ("northwind", or a pasted "https://dev.azure.com/northwind/..."), or null if it can't be one. */
export function adoOrgName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().replace(/^https?:\/\/dev\.azure\.com\//i, "").replace(/^https?:\/\/([\w-]+)\.visualstudio\.com.*$/i, "$1").split("/")[0];
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(t) ? t : null;
}

/**
 * How long a "slow down" answer asks to wait, in seconds, or null when it isn't one: 429, a 403 that carries
 * `Retry-After` or `x-ratelimit-remaining: 0` (GitHub's primary and secondary rate limits), or a 503 with
 * `Retry-After` (Microsoft Graph when a service is overloaded). `Retry-After` may be
 * seconds or a date; `x-ratelimit-reset` is a Unix time. Unknown waits count as a minute.
 */
export function rateLimitWait(status: number, headers: Headers, at = Date.now()): number | null {
  const retry = headers.get("retry-after");
  const remaining = headers.get("x-ratelimit-remaining");
  if (status !== 429 && !(status === 403 && (retry !== null || remaining === "0")) && !(status === 503 && retry !== null)) return null;
  if (retry !== null) {
    const secs = /^\d+$/.test(retry.trim()) ? Number(retry) : (Date.parse(retry) - at) / 1000;
    if (Number.isFinite(secs)) return Math.max(0, Math.ceil(secs));
  }
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (remaining === "0" && reset > 0) return Math.max(0, Math.ceil(reset - at / 1000));
  return 60;
}

/**
 * A problem talking to a tool, with a plain message for the Connectors page. `reason`:
 * - `auth`: the sign-in expired or was revoked (the connector is marked expired; someone must reconnect),
 * - `access`: the tool refused a project (the account lost access), `notfound`: it's gone or renamed,
 * - `busy`: the tool is rate limiting or down, `network`: it couldn't be reached (both retried on the next sync),
 * - `tool`: anything else the tool answered.
 * `status` is the tool's HTTP status when there was one (Microsoft Graph's 410 "start the delta again" uses it).
 */
export class ConnectorError extends Error {
  reason: "auth" | "access" | "notfound" | "busy" | "network" | "tool";
  status: number | null;
  constructor(reason: ConnectorError["reason"], message: string, status: number | null = null) {
    super(message);
    this.reason = reason;
    this.status = status;
    this.name = "ConnectorError";
  }
}
