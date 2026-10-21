/**
 * @file Data export: everything a group (or a whole organization) holds, as one zip file people can keep
 * when an engagement ends or the company leaves (see lib/rolloff.ts).
 *
 * What's in a group's export (one folder per group in an organization's export):
 * - `index.html`: open this first; what's inside, with links, readable without any other software.
 * - `documents/`: each document's text as Sidekick extracted it (with `[Page 3]`-style markers). Sidekick
 *   doesn't keep the original uploaded files, only their text, so that's what is exported.
 * - `meetings/`: one Markdown file per meeting: notes, decisions and other notes, action items, transcript.
 * - `notes-and-decisions.csv`, `action-items.csv`, `questions-and-gaps.csv` (unanswered questions are the
 *   gaps), `people.csv` (the group's members).
 * - `teams-chats.md`: a summary of the Teams chats Sidekick kept track of (messages, first and last date)
 *   followed by the saved messages (kept 90 days).
 * An organization's export adds `people.csv` (everyone) and `audit-log.csv` at the top.
 *
 * Who: Org Owners and Org Admins (checked by the routes), any time, including while the group is ending or
 * the organization is read-only. Every query is scoped to the organization and the workspace. Exports are
 * built in memory (fine for now; a streamed export on the job queue is the later step for very large ones).
 */
import "server-only";
import { all, get } from "./db";
import { buildZip, safeName, uniqueNames, type ZipEntry } from "./zip";
import { span } from "./trace";
import { BRAND } from "./brand";

/** One CSV cell: quoted when needed; a leading =, +, - or @ is defused so spreadsheets don't run it as a formula. */
const cell = (v: unknown) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** A CSV file from a header row and data rows. */
export const csv = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "");

/** What one group's part of the export holds, for the index page. */
type Part = { label: string; href: string; count: number };

/** The files of one group's export, under `prefix` ("" or "groups/<name>/"). Scoped to the organization. */
async function groupEntries(orgId: string, workspaceId: string, prefix: string): Promise<{ entries: ZipEntry[]; name: string; parts: Part[] }> {
  const ws = await get<{ name: string; code: string | null; client: string | null; created_at: string }>("SELECT name, code, client, created_at FROM workspaces WHERE id = ? AND org_id = ?", workspaceId, orgId);
  if (!ws) return { entries: [], name: "", parts: [] };
  const entries: ZipEntry[] = [];
  const parts: Part[] = [];
  const scope = [workspaceId, orgId];

  // Documents: their extracted text, passage by passage in order.
  const docs = await all<{ id: string; name: string; audience: string; uploaded_by: string | null; created_at: string; status: string }>(
    "SELECT id, name, audience, uploaded_by, created_at, status FROM documents WHERE workspace_id = ? AND org_id = ? ORDER BY created_at", ...scope,
  );
  const docName = uniqueNames();
  for (const d of docs) {
    const passages = await all<{ text: string; loc: string | null }>("SELECT text, loc FROM passages WHERE source_id = ? AND org_id = ? AND workspace_id = ? ORDER BY rowid", d.id, orgId, workspaceId);
    const body = passages.map((p) => (p.loc ? `[${p.loc}]\n${p.text}` : p.text)).join("\n\n");
    const head = `${d.name}\nUploaded ${day(d.created_at)}${d.uploaded_by ? ` by ${d.uploaded_by}` : ""} · ${d.audience === "shareable" ? "Shareable with client guests" : "Internal"}${d.status !== "Ready" ? ` · ${d.status}` : ""}\n\n`;
    entries.push({ name: `${prefix}documents/${docName(`${safeName(d.name.replace(/\.[a-z0-9]+$/i, ""))}.txt`)}`, data: head + (body || "(No text was extracted from this document.)") + "\n" });
  }
  parts.push({ label: "Documents (extracted text)", href: "documents/", count: docs.length });

  // Meetings: notes, decisions/notes, action items and the transcript in one file each.
  const meetings = await all<{ id: string; title: string; held_at: string; summary: string | null; transcript: string; external_guests: number }>(
    "SELECT id, title, held_at, summary, transcript, external_guests FROM meetings WHERE workspace_id = ? AND org_id = ? ORDER BY held_at", ...scope,
  );
  const items = await all<{ meeting_id: string | null; kind: string; text: string; who: string | null; due_on: string | null; created_at: string }>(
    "SELECT meeting_id, kind, text, who, due_on, created_at FROM items WHERE workspace_id = ? AND org_id = ? ORDER BY rowid", ...scope,
  );
  const actions = await all<{ meeting_id: string | null; text: string; owner: string | null; due: string | null; due_on: string | null; status: string; created_at: string }>(
    "SELECT meeting_id, text, owner, due, due_on, status, created_at FROM action_items WHERE workspace_id = ? AND org_id = ? ORDER BY rowid", ...scope,
  );
  const title = new Map(meetings.map((m) => [m.id, m.title]));
  const meetingName = uniqueNames();
  for (const m of meetings) {
    const mine = items.filter((i) => i.meeting_id === m.id);
    const todo = actions.filter((a) => a.meeting_id === m.id);
    const md = [
      `# ${m.title}`, "", `Held ${day(m.held_at)}${m.external_guests ? " · client guests attended" : ""}`, "",
      "## Notes", "", m.summary || "(No notes.)", "",
      "## Decisions and other notes", "", ...(mine.length ? mine.map((i) => `- **${i.kind}**: ${i.text}${i.who ? ` (${i.who})` : ""}`) : ["(None.)"]), "",
      "## Action items", "", ...(todo.length ? todo.map((a) => `- [${a.status === "Done" ? "x" : " "}] ${a.text}${a.owner ? ` · ${a.owner}` : ""}${a.due_on || a.due ? ` · due ${a.due_on ?? a.due}` : ""} · ${a.status}`) : ["(None.)"]), "",
      "## Transcript", "", "```", m.transcript, "```", "",
    ].join("\n");
    entries.push({ name: `${prefix}meetings/${meetingName(`${day(m.held_at)} ${safeName(m.title)}.md`)}`, data: md });
  }
  parts.push({ label: "Meetings (notes, decisions, action items, transcripts)", href: "meetings/", count: meetings.length });

  entries.push({ name: `${prefix}notes-and-decisions.csv`, data: csv(["Kind", "Text", "Who", "Due", "Meeting", "Added"], items.map((i) => [i.kind, i.text, i.who, i.due_on, i.meeting_id ? title.get(i.meeting_id) : "", day(i.created_at)])) });
  parts.push({ label: "Decisions and other notes (CSV)", href: "notes-and-decisions.csv", count: items.length });
  entries.push({ name: `${prefix}action-items.csv`, data: csv(["Action item", "Owner", "Due", "Status", "Meeting", "Added"], actions.map((a) => [a.text, a.owner, a.due_on ?? a.due, a.status, a.meeting_id ? title.get(a.meeting_id) : "", day(a.created_at)])) });
  parts.push({ label: "Action items (CSV)", href: "action-items.csv", count: actions.length });

  const questions = await all<{ question: string; answer: string | null; found: number; asked_by: string | null; channel: string | null; created_at: string }>(
    "SELECT question, answer, found, asked_by, channel, created_at FROM questions WHERE workspace_id = ? AND org_id = ? ORDER BY created_at", ...scope,
  );
  entries.push({ name: `${prefix}questions-and-gaps.csv`, data: csv(["Question", "Answer", "Answered from sources", "Asked by", "Where", "Asked"], questions.map((q) => [q.question, q.answer, q.found ? "Yes" : "No (knowledge gap)", q.asked_by, q.channel, day(q.created_at)])) });
  parts.push({ label: "Questions and knowledge gaps (CSV)", href: "questions-and-gaps.csv", count: questions.length });

  // Teams chats: a summary per chat, then the saved messages.
  const messages = await all<{ conversation_id: string; author: string | null; text: string; sent_at: string }>(
    "SELECT conversation_id, author, text, sent_at FROM chat_messages WHERE workspace_id = ? AND org_id = ? ORDER BY sent_at", ...scope,
  );
  const convIds = [...new Set(messages.map((m) => m.conversation_id))];
  const names = convIds.length
    ? new Map((await all<{ id: string; name: string | null }>(`SELECT id, name FROM teams_conversations WHERE id IN (${convIds.map(() => "?").join(",")})`, ...convIds)).map((c) => [c.id, c.name]))
    : new Map<string, string | null>();
  const chatMd = [`# Teams chats of ${ws.name}`, ""];
  if (!convIds.length) chatMd.push(`${BRAND.name} didn't keep any Teams chat messages for this group (only chats an admin chose to track are kept, for 90 days).`);
  for (const id of convIds) {
    const mine = messages.filter((m) => m.conversation_id === id);
    chatMd.push(`## ${names.get(id) ?? "Teams chat"}`, "", `${mine.length} saved message${mine.length === 1 ? "" : "s"}, ${day(mine[0].sent_at)} to ${day(mine[mine.length - 1].sent_at)}.`, "");
  }
  for (const id of convIds) {
    chatMd.push(`## Messages: ${names.get(id) ?? "Teams chat"}`, "");
    for (const m of messages.filter((x) => x.conversation_id === id)) chatMd.push(`- ${m.sent_at.replace("T", " ").slice(0, 16)} **${m.author ?? "Someone"}**: ${m.text.replace(/\n+/g, " ")}`);
    chatMd.push("");
  }
  entries.push({ name: `${prefix}teams-chats.md`, data: chatMd.join("\n") });
  parts.push({ label: "Teams chats (summary and saved messages)", href: "teams-chats.md", count: messages.length });

  const people = await all<{ name: string; email: string; role: string }>(
    "SELECT u.name, u.email, u.role FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND u.org_id = ? ORDER BY u.name", ...scope,
  );
  entries.push({ name: `${prefix}people.csv`, data: csv(["Name", "Email", "Role"], people.map((p) => [p.name, p.email, p.role])) });
  parts.push({ label: "People in the group (CSV)", href: "people.csv", count: people.length });

  const intro = `${ws.client ? `Client: ${esc(ws.client)} · ` : ""}${ws.code ? `Engagement code: ${esc(ws.code)} · ` : ""}Created ${day(ws.created_at)}`;
  entries.unshift({ name: `${prefix}index.html`, data: indexPage(`${ws.name}`, intro, parts) });
  return { entries, name: ws.name, parts };
}

/** A small, self-contained page listing what's in the export (no scripts, no outside files). */
function indexPage(title: string, intro: string, parts: Part[], extra = "") {
  const rows = parts.map((p) => `<tr><td><a href="${esc(p.href)}">${esc(p.label)}</a></td><td style="text-align:right">${p.count}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · ${esc(BRAND.name)} export</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;color:#1d1b2e;background:#fff}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #e3e1f0;padding:8px 4px}a{color:#4f46e5}.muted{color:#5d5a73}</style></head>
<body><h1>${esc(title)}</h1><p class="muted">${intro}</p><p class="muted">Exported from ${esc(BRAND.name)} on ${new Date().toISOString().slice(0, 10)}. Documents are the text ${esc(BRAND.name)} extracted from each file (the original files aren't kept). CSV files open in Excel.</p>
${extra}<table>${rows}</table></body></html>
`;
}

/** The file name for a download: "<name> export 2026-10-21.zip". */
const zipName = (name: string) => `${safeName(name, "export")} export ${new Date().toISOString().slice(0, 10)}.zip`;

/** One group's export as a zip. Caller checks the role (Org Owner/Admin) and the workspace wall. */
export async function exportGroup(orgId: string, workspaceId: string): Promise<{ filename: string; zip: Buffer }> {
  return span("file", "Export a group", async () => {
    const { entries, name } = await groupEntries(orgId, workspaceId, "");
    return { filename: zipName(name), zip: buildZip(entries) };
  });
}

/** The whole organization's export as a zip: every group in its own folder, plus people and audit log. */
export async function exportOrganization(orgId: string): Promise<{ filename: string; zip: Buffer }> {
  return span("file", "Export an organization", async () => {
    const org = await get<{ name: string }>("SELECT name FROM orgs WHERE id = ?", orgId);
    const groups = await all<{ id: string; name: string }>("SELECT id, name FROM workspaces WHERE org_id = ? ORDER BY name", orgId);
    const folder = uniqueNames();
    const entries: ZipEntry[] = [];
    const groupLinks: Part[] = [];
    for (const g of groups) {
      const dir = folder(safeName(g.name, "group"));
      const part = await groupEntries(orgId, g.id, `groups/${dir}/`);
      entries.push(...part.entries);
      groupLinks.push({ label: `Group: ${g.name}`, href: `groups/${dir}/index.html`, count: part.parts.reduce((n, p) => n + p.count, 0) });
    }
    const people = await all<{ name: string; email: string; role: string; created_at: string }>("SELECT name, email, role, created_at FROM users WHERE org_id = ? ORDER BY name", orgId);
    entries.push({ name: "people.csv", data: csv(["Name", "Email", "Role", "Added"], people.map((p) => [p.name, p.email, p.role, day(p.created_at)])) });
    const log = await all<{ actor: string; action: string; kind: string; created_at: string }>("SELECT actor, action, kind, created_at FROM audit_log WHERE org_id = ? ORDER BY id", orgId);
    entries.push({ name: "audit-log.csv", data: csv(["When (UTC)", "Who", "What", "Kind"], log.map((l) => [l.created_at.replace("T", " ").slice(0, 19), l.actor, l.action, l.kind])) });
    const parts = [...groupLinks, { label: "Everyone in the organization (CSV)", href: "people.csv", count: people.length }, { label: "Audit log (CSV)", href: "audit-log.csv", count: log.length }];
    entries.unshift({ name: "index.html", data: indexPage(org?.name ?? "Organization", `${groups.length} group${groups.length === 1 ? "" : "s"} · ${people.length} people`, parts, "<p>Each group has its own folder with its own index page.</p>") });
    return { filename: zipName(org?.name ?? "organization"), zip: buildZip(entries) };
  });
}

/** A download response for a zip. */
export function zipResponse(filename: string, zip: Buffer): Response {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
  return new Response(new Uint8Array(zip), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "cache-control": "no-store",
    },
  });
}
