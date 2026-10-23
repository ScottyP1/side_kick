/**
 * @file Pure helpers for connectors (lib/connectors.ts): turning a work item from Azure DevOps or Jira into the
 * plain text Sidekick indexes, and turning each tool's rich text (ADO's HTML, Jira's "Atlassian Document
 * Format") into plain text. No I/O, so the unit tests in tests/db.test.mjs can call them directly.
 *
 * Concepts
 * - **Work item**: one ADO work item (bug, task, user story...) or one Jira issue, read-only. Sidekick keeps its
 *   title, type, state, assignee, due date, link, what blocks it, its description and a short summary of the
 *   latest comments, written out as one small text "card" (`workItemText`) so Ask, Memory & gaps and meeting
 *   notes can use it like any other source, and cite it with a link back to the tool.
 * - **Comments summary**: not written by AI (that would cost a Claude call per item on every sync): the number
 *   of comments plus the latest few, each cut short, newest first.
 */

/** Which tool a connector reads from: Azure DevOps Boards or Jira Cloud. */
export type ConnectorKind = "ado" | "jira";
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ["ado", "jira"];
/** The tool's name as people see it. */
export const KIND_LABEL: Record<ConnectorKind, string> = { ado: "Azure DevOps", jira: "Jira" };

/** One work item (ADO) or issue (Jira) as Sidekick keeps it. `externalId` is "4821" (ADO) or "CUT-12" (Jira). */
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

/** "Azure DevOps Bug #4821: …" / "Jira CUT-12: …": the title a work item is searched and cited by. */
export function workItemTitle(kind: ConnectorKind, item: Pick<WorkItem, "externalId" | "title" | "type">): string {
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

/** States that mean "finished" in the usual ADO and Jira workflows (for "open items" lists). */
export const isDoneState = (state: string | null) => /^(done|closed|resolved|removed|completed|cancel+ed)$/i.test(state ?? "");

/** An ADO organization name as typed ("northwind", or a pasted "https://dev.azure.com/northwind/..."), or null if it can't be one. */
export function adoOrgName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().replace(/^https?:\/\/dev\.azure\.com\//i, "").replace(/^https?:\/\/([\w-]+)\.visualstudio\.com.*$/i, "$1").split("/")[0];
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,49}$/.test(t) ? t : null;
}

/**
 * A problem talking to a tool, with a plain message for the Connectors page. `reason`:
 * - `auth`: the sign-in expired or was revoked (the connector is marked expired; someone must reconnect),
 * - `access`: the tool refused a project (the account lost access), `notfound`: it's gone or renamed,
 * - `busy`: the tool is rate limiting or down, `network`: it couldn't be reached (both retried on the next sync),
 * - `tool`: anything else the tool answered.
 */
export class ConnectorError extends Error {
  reason: "auth" | "access" | "notfound" | "busy" | "network" | "tool";
  constructor(reason: ConnectorError["reason"], message: string) {
    super(message);
    this.reason = reason;
    this.name = "ConnectorError";
  }
}
