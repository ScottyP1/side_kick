/**
 * @file Support tickets: customers asking the Sidekick team for help, and the team answering them in the
 * Owner Console's Support inbox.
 *
 * Concepts
 * - **Ticket** (`support_tickets`): one problem or question, with a short reference (`SUP-7K3Q2M`), a
 *   category (question, bug, billing, access, feature), a priority, the requester's contact details (filled in
 *   from their account in the portal; typed on the public form), the page they were on, and a **status**:
 *   `open` (the team's turn), `waiting` (waiting on the customer, after a team reply) or `resolved`. A reply from
 *   the customer reopens a waiting or resolved ticket.
 * - **Where tickets come from** (`source`): `portal` (Help → Contact support), `assistant` (the support
 *   assistant's "Turn this into a ticket", with a summary of what it checked), `public` (the /support form, no
 *   organization) and `helpbot` (the website help bot's "Talk to a human").
 * - **Who sees what**: tickets belong to the requester's organization. Org Owners and Org Admins see all of
 *   their organization's tickets; everyone else only their own (`visibleTicket`). Public tickets belong to no
 *   organization and are only seen by the Sidekick team. Internal notes (`internal = 1`) are never sent to
 *   customers.
 * - **Thread** (`support_messages`): the customer's messages, the team's replies, internal notes and system
 *   lines ("Reopened by …").
 * - **Attachments** (`support_attachments`): one file per message, at most `MAX_ATTACHMENT_BYTES`, only
 *   screenshots (PNG, JPEG, GIF, WebP), PDFs and plain-text logs (TXT, LOG, CSV), checked by their first bytes
 *   too (`checkAttachment`). Stored base64 in the database and always downloaded as a file, never shown inline.
 * - **Notifications**: in the app, through two flags per ticket: `customer_unread` (a team reply the requester
 *   hasn't opened: the dot on the assistant button) and `staff_unread` (new customer activity: the inbox
 *   count). `notify` is also the **email hook**: it does nothing else today; sending email belongs there.
 * - **Audit**: customers' ticket actions go to their organization's audit log; the team's actions go to the
 *   operator log and, for tickets with an organization, to that organization's audit log too.
 * - **Client context** (`ticketContext`): for the team, the client's plan and status and its recent errors by
 *   reference code (from its own traces, joined to the error log), plus any reference code quoted in the thread.
 *
 * Who calls it: the /api/support/* routes (portal, public form, attachments) and /api/owner/support/*
 * (operators). Every query is scoped by organization, or by requester for non-admins.
 */
import "server-only";
import crypto from "node:crypto";
import { audit, isAdmin, type User } from "./auth";
import { HttpError } from "./http-error";
import { all, get, newId, now, run, tx } from "./db";
import { platformLog } from "./owner";
import { takeHit } from "./rate-limit";
import { getSubscription } from "./billing";
import { orgPlan } from "./limits";
import { linkUsesToTicket } from "./support-articles";
import { maskPersonalData } from "./guard-text";
import { span } from "./trace";

export const CATEGORIES = ["question", "bug", "billing", "access", "feature"] as const;
export type Category = (typeof CATEGORIES)[number];
/** Plain names for the categories. */
export const CATEGORY_LABELS: Record<Category, string> = { question: "Question", bug: "Something's broken", billing: "Billing", access: "Sign-in or access", feature: "Feature request" };
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUSES = ["open", "waiting", "resolved"] as const;
export type Status = (typeof STATUSES)[number];
/** Plain names for the statuses, as customers read them. */
export const STATUS_LABELS: Record<Status, string> = { open: "Open", waiting: "Waiting on you", resolved: "Resolved" };
export type Source = "portal" | "assistant" | "public" | "helpbot";

/** Largest attachment accepted. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Public form: tickets per network address per hour. */
export const PUBLIC_PER_HOUR = Number(process.env.SIDEKICK_SUPPORT_PUBLIC_PER_HOUR) || 5;
/** Portal: new tickets per person per hour (a stuck script can't flood the inbox). */
export const PORTAL_PER_HOUR = 20;

/** The ticket row. */
export type TicketRow = {
  id: string; ref: string; org_id: string | null; user_id: string | null; name: string; email: string; phone: string | null;
  subject: string; category: Category; priority: Priority; status: Status; source: Source; page: string | null; checks: string | null;
  assigned_to: string | null; customer_unread: number; staff_unread: number; created_at: string; updated_at: string; resolved_at: string | null;
};

/** A file someone attached, read from the form and checked. */
export type AttachmentInput = { name: string; mime: string; data: Buffer };

/** Allowed file types: extension → content type, and how the first bytes must look ("text" = readable text). */
const TYPES: Record<string, { mime: string; magic: number[] | "text" }> = {
  png: { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  gif: { mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  webp: { mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
  pdf: { mime: "application/pdf", magic: [0x25, 0x50, 0x44, 0x46] },
  txt: { mime: "text/plain", magic: "text" },
  log: { mime: "text/plain", magic: "text" },
  csv: { mime: "text/csv", magic: "text" },
};
/** The extensions people may attach, for the form's hint. */
export const ATTACHMENT_TYPES = "PNG, JPEG, GIF, WebP, PDF, TXT, LOG or CSV";

/**
 * Reads and checks an attached file: allowed extension, not empty, not too big, and first bytes that match the
 * type (so a renamed program isn't accepted as a screenshot). Returns null for no file; throws 400 otherwise.
 */
export async function checkAttachment(file: unknown): Promise<AttachmentInput | null> {
  if (!file || typeof file === "string" || typeof (file as File).arrayBuffer !== "function") return null;
  const f = file as File;
  if (!f.size) return null;
  const ext = (f.name.split(".").pop() ?? "").toLowerCase();
  const type = TYPES[ext];
  if (!type) throw new HttpError(400, `That file type can't be attached. Use ${ATTACHMENT_TYPES}.`);
  if (f.size > MAX_ATTACHMENT_BYTES) throw new HttpError(400, `Attachments can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  const data = Buffer.from(await f.arrayBuffer());
  const ok = type.magic === "text" ? !data.subarray(0, 4096).includes(0) : type.magic.every((b, i) => data[i] === b);
  if (!ok) throw new HttpError(400, `“${f.name.slice(0, 80)}” doesn't look like a real ${ext.toUpperCase()} file.`);
  const name = f.name.replace(/[^\w .()-]+/g, "_").slice(0, 120) || `attachment.${ext}`;
  return { name, mime: type.mime, data };
}

/** A new reference like "SUP-7K3Q2M" (no look-alike letters). */
const newRef = () => `SUP-${Array.from(crypto.randomBytes(6), (b) => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[b % 32]).join("")}`;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\r\n/g, "\n").trim().slice(0, max) : "");

/** The fields of a new ticket, checked. Throws 400 with a plain reason. */
function checkNew(body: Record<string, unknown>, opts: { contact: boolean }) {
  const subject = text(body.subject, 160).replace(/\s+/g, " ");
  const description = text(body.description, 8000);
  const category = (body.category ?? "question") as Category;
  const priority = (body.priority ?? "normal") as Priority;
  if (subject.length < 4) throw new HttpError(400, "Add a short subject (at least 4 characters).");
  if (description.length < 10) throw new HttpError(400, "Describe the problem in a sentence or two (at least 10 characters).");
  if (!CATEGORIES.includes(category)) throw new HttpError(400, "Pick a category: question, bug, billing, access or feature.");
  if (!PRIORITIES.includes(priority)) throw new HttpError(400, "Pick a priority: low, normal, high or urgent.");
  const phone = text(body.phone, 40) || null;
  if (phone && !/^[+\d][\d ().-]{5,38}$/.test(phone)) throw new HttpError(400, "That phone number doesn't look right. Leave it empty if you prefer email.");
  // The page they were on: a path inside Sidekick only (never a full address someone typed).
  const page = typeof body.page === "string" && /^\/[\w\-/[\].#?=&%]*$/.test(body.page) ? body.page.slice(0, 200) : null;
  let name = "";
  let email = "";
  if (opts.contact) {
    name = text(body.name, 120).replace(/\s+/g, " ");
    email = text(body.email, 200).toLowerCase();
    if (name.length < 2) throw new HttpError(400, "Tell us your name.");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter an email address we can reply to.");
  }
  return { subject, description, category, priority, phone, page, name, email };
}

/** Inserts a ticket, its first message and attachment in one transaction; returns the row. */
async function insertTicket(t: {
  orgId: string | null; userId: string | null; name: string; email: string; phone: string | null; subject: string; category: Category; priority: Priority;
  source: Source; page: string | null; checks?: unknown; description: string; attachment?: AttachmentInput | null;
}): Promise<TicketRow> {
  const id = newId();
  const at = now();
  await tx(async () => {
    await run(
      `INSERT INTO support_tickets (id, ref, org_id, user_id, name, email, phone, subject, category, priority, status, source, page, checks, assigned_to, customer_unread, staff_unread, created_at, updated_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, 0, 1, ?, ?, NULL)`,
      id, newRef(), t.orgId, t.userId, t.name, t.email, t.phone, t.subject, t.category, t.priority, t.source, t.page, t.checks ? JSON.stringify(t.checks) : null, at, at,
    );
    await addMessage({ id, org_id: t.orgId }, "customer", t.name, t.description, false, t.attachment ?? null, at);
  });
  return (await get<TicketRow>("SELECT * FROM support_tickets WHERE id = ?", id))!;
}

/** Adds one message (and its attachment) to a ticket's thread. */
async function addMessage(ticket: { id: string; org_id: string | null }, kind: "customer" | "staff" | "system", author: string, body: string, internal: boolean, attachment: AttachmentInput | null, at = now()) {
  const messageId = newId();
  await run("INSERT INTO support_messages (id, ticket_id, org_id, author_kind, author, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", messageId, ticket.id, ticket.org_id, kind, author, body, internal ? 1 : 0, at);
  if (attachment) {
    await run(
      "INSERT INTO support_attachments (id, ticket_id, message_id, org_id, name, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      newId(), ticket.id, messageId, ticket.org_id, attachment.name, attachment.mime, attachment.data.length, attachment.data.toString("base64"), at,
    );
  }
  return messageId;
}

/** Something happened on a ticket that someone should hear about. */
export type SupportEvent = { kind: "new_ticket" | "customer_reply" | "staff_reply" | "resolved" | "reopened"; ticket: Pick<TicketRow, "ref" | "subject" | "email" | "org_id">; to: "staff" | "customer" };

/**
 * The notification hook. In the app, notifications are the unread flags on the ticket (set by the callers),
 * shown as the inbox count and the dot on the assistant button. **Email goes here later** (a mail service is
 * not set up yet): send `event.ticket.email` (customer) or the team's support address (staff) a short note with
 * the reference and a link, never the message text of an internal note.
 */
export async function notify(event: SupportEvent): Promise<void> {
  void event; // Email hook: nothing to send until a mail service exists (see the doc comment).
}

/**
 * Opens a ticket from the portal (Help → Contact support). The person's name and email come from their account;
 * phone is optional. Audited in the organization's log; logged for the Sidekick team. Limited to
 * `PORTAL_PER_HOUR` per person. Who: anyone signed in.
 */
export async function createPortalTicket(user: User, body: Record<string, unknown>, attachment: AttachmentInput | null): Promise<TicketRow> {
  const f = checkNew(body, { contact: false });
  await takeHit(`support-ticket:${user.id}`, PORTAL_PER_HOUR, 60, "You've opened a lot of tickets in the last hour. Add to an open ticket instead, or try again later.");
  return span("request", "Support: open a ticket", async () => {
    const t = await insertTicket({ orgId: user.org_id, userId: user.id, name: user.name, email: user.email, phone: f.phone, subject: f.subject, category: f.category, priority: f.priority, source: "portal", page: f.page, description: f.description, attachment });
    await audit(user, `Contacted support: ${t.ref} “${t.subject}”`, "Support");
    await platformLog(user.name, `New support ticket ${t.ref} (${f.category}, ${f.priority})`);
    await notify({ kind: "new_ticket", ticket: t, to: "staff" });
    return t;
  });
}

/**
 * Turns a support assistant conversation into a ticket: the subject is the first question, the description is
 * what was asked and answered, and `checks` is what the assistant checked (shown to the team). The articles the
 * assistant cited are linked to the ticket. Who: the person who had the conversation (the route loads it for them).
 */
export async function createTicketFromConversation(
  user: User,
  conv: { id: string; turns: { role: string; text: string; question: string | null; meta: Record<string, unknown> | null }[] },
  extra: { description?: unknown; page?: unknown; priority?: unknown },
): Promise<TicketRow> {
  const asked = conv.turns.filter((t) => t.role === "user");
  if (!asked.length) throw new HttpError(400, "Ask the Help assistant something first, or use Contact support.");
  const transcript = conv.turns.map((t) => `${t.role === "user" ? "Me" : "Help assistant"}: ${t.text}`).join("\n\n");
  const note = text(extra.description, 4000);
  const checks = [...conv.turns].reverse().find((t) => t.meta?.checks)?.meta?.checks ?? null;
  const subject = (asked[0].question ?? asked[0].text).replace(/\s+/g, " ").slice(0, 150);
  const f = checkNew({ subject: subject.length >= 4 ? subject : `Help: ${subject}`, description: `${note ? `${note}\n\n` : ""}Conversation with the Help assistant:\n\n${transcript}`.slice(0, 8000), category: "question", priority: extra.priority ?? "normal", page: extra.page }, { contact: false });
  await takeHit(`support-ticket:${user.id}`, PORTAL_PER_HOUR, 60, "You've opened a lot of tickets in the last hour. Add to an open ticket instead, or try again later.");
  const t = await insertTicket({ orgId: user.org_id, userId: user.id, name: user.name, email: user.email, phone: null, subject: f.subject, category: f.category, priority: f.priority, source: "assistant", page: f.page, checks, description: f.description });
  await linkUsesToTicket(conv.id, t.id);
  await audit(user, `Contacted support from the Help assistant: ${t.ref} “${t.subject}”`, "Support");
  await platformLog(user.name, `New support ticket ${t.ref} from the Help assistant`);
  await notify({ kind: "new_ticket", ticket: t, to: "staff" });
  return t;
}

/**
 * Opens a ticket from the public /support form or the help bot's "Talk to a human" (no organization, no
 * sign-in). Anti-abuse: a hidden honeypot field (`website`) that people never fill (a filled one is accepted
 * quietly and dropped), and `PUBLIC_PER_HOUR` tickets per network address. The help bot's conversation (already
 * masked) can be added for context. Returns the ticket's reference, or null when the honeypot caught a bot.
 */
export async function createPublicTicket(body: Record<string, unknown>, ip: string, opts: { source: "public" | "helpbot"; transcript?: string } = { source: "public" }): Promise<{ ref: string } | null> {
  if (typeof body.website === "string" && body.website.trim()) return null;
  const f = checkNew(body, { contact: true });
  await takeHit(`support-public:${crypto.createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 32)}`, PUBLIC_PER_HOUR, 60, "Too many messages from this network in the last hour. Try again later.");
  const description = opts.transcript ? `${f.description}\n\nConversation with the help bot:\n\n${opts.transcript}`.slice(0, 8000) : f.description;
  const t = await insertTicket({ orgId: null, userId: null, name: f.name, email: f.email, phone: f.phone, subject: f.subject, category: f.category, priority: f.priority === "urgent" ? "high" : f.priority, source: opts.source, page: f.page, description });
  await platformLog("Website visitor", `New support ticket ${t.ref} from the ${opts.source === "helpbot" ? "help bot" : "support form"}`);
  await notify({ kind: "new_ticket", ticket: t, to: "staff" });
  return { ref: t.ref };
}

/** One ticket in a list, as customers and the team see it. */
const summary = (t: TicketRow) => ({
  id: t.id, ref: t.ref, subject: t.subject, category: t.category, priority: t.priority, status: t.status, source: t.source,
  requester: t.name, createdAt: t.created_at, updatedAt: t.updated_at, resolvedAt: t.resolved_at,
});

/**
 * The tickets this person may see: all of the organization's for Org Owners and Org Admins, their own for
 * everyone else. Newest activity first. `unread` = a team reply they haven't opened (their own tickets only).
 */
export async function listTicketsFor(user: User) {
  const rows = isAdmin(user)
    ? await all<TicketRow>("SELECT * FROM support_tickets WHERE org_id = ? ORDER BY updated_at DESC LIMIT 200", user.org_id)
    : await all<TicketRow>("SELECT * FROM support_tickets WHERE org_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 200", user.org_id, user.id);
  return rows.map((t) => ({ ...summary(t), mine: t.user_id === user.id, unread: t.user_id === user.id && Number(t.customer_unread) === 1 }));
}

/** How many of this person's own tickets have a team reply they haven't opened (the dot on the assistant button). */
export async function unreadCount(user: User): Promise<number> {
  return Number((await get<{ n: number }>("SELECT COUNT(*) AS n FROM support_tickets WHERE org_id = ? AND user_id = ? AND customer_unread = 1", user.org_id, user.id))?.n ?? 0);
}

/** The ticket if this person may see it (see `listTicketsFor`), else 404 (whether or not it exists). */
async function visibleTicket(user: User, id: unknown): Promise<TicketRow> {
  const t = typeof id === "string" ? await get<TicketRow>("SELECT * FROM support_tickets WHERE id = ? AND org_id = ?", id, user.org_id) : undefined;
  if (!t || (!isAdmin(user) && t.user_id !== user.id)) throw new HttpError(404, "Ticket not found.");
  return t;
}

/** A thread for display: messages (internal notes only when `internal`), each with its attachment's name and size. */
async function thread(ticketId: string, internal: boolean) {
  const msgs = await all<{ id: string; author_kind: string; author: string; body: string; internal: number; created_at: string }>(
    `SELECT id, author_kind, author, body, internal, created_at FROM support_messages WHERE ticket_id = ?${internal ? "" : " AND internal = 0"} ORDER BY created_at, id`,
    ticketId,
  );
  const files = await all<{ id: string; message_id: string; name: string; size: number }>("SELECT id, message_id, name, size FROM support_attachments WHERE ticket_id = ?", ticketId);
  return msgs.map((m) => ({
    id: m.id, kind: m.author_kind, author: m.author, body: m.body, internal: Number(m.internal) === 1, at: m.created_at,
    attachment: files.find((f) => f.message_id === m.id) ? (({ id, name, size }) => ({ id, name, size: Number(size) }))(files.find((f) => f.message_id === m.id)!) : null,
  }));
}

/**
 * One ticket with its thread (no internal notes), for the portal. Opening their own ticket clears the
 * requester's unread flag. Who: the requester, or an Org Owner/Admin of the same organization.
 */
export async function ticketFor(user: User, id: unknown) {
  const t = await visibleTicket(user, id);
  if (t.user_id === user.id && Number(t.customer_unread) === 1) await run("UPDATE support_tickets SET customer_unread = 0 WHERE id = ?", t.id);
  return { ticket: { ...summary(t), phone: t.phone, email: t.email, page: t.page, mine: t.user_id === user.id }, messages: await thread(t.id, false) };
}

/**
 * The customer side of a ticket: `reply` (adds a message, optionally with a file; reopens a waiting or resolved
 * ticket) or `resolve` ("this is sorted"). Audited. Who: the requester, or an Org Owner/Admin of the organization.
 */
export async function customerAct(user: User, id: unknown, body: Record<string, unknown>, attachment: AttachmentInput | null) {
  const t = await visibleTicket(user, id);
  if (body.action === "resolve") {
    if (t.status === "resolved") return ticketFor(user, t.id);
    await run("UPDATE support_tickets SET status = 'resolved', resolved_at = ?, updated_at = ?, staff_unread = 1 WHERE id = ?", now(), now(), t.id);
    await addMessage(t, "system", "Sidekick", `${user.name} marked this resolved.`, false, null);
    await audit(user, `Marked support ticket ${t.ref} resolved`, "Support");
    await notify({ kind: "resolved", ticket: t, to: "staff" });
    return ticketFor(user, t.id);
  }
  const message = text(body.message, 8000);
  if (!message && !attachment) throw new HttpError(400, "Write a reply or attach a file.");
  const reopen = t.status !== "open";
  await tx(async () => {
    await addMessage(t, "customer", user.name, message || "(file attached)", false, attachment);
    if (reopen) await addMessage(t, "system", "Sidekick", `Reopened by ${user.name}'s reply.`, false, null);
    await run("UPDATE support_tickets SET status = 'open', resolved_at = NULL, staff_unread = 1, updated_at = ? WHERE id = ?", now(), t.id);
  });
  await audit(user, `Replied to support ticket ${t.ref}${reopen ? " (reopened)" : ""}`, "Support");
  await notify({ kind: reopen ? "reopened" : "customer_reply", ticket: t, to: "staff" });
  return ticketFor(user, t.id);
}

/**
 * An attachment's file, if the caller may see its ticket: a portal user (`user`, same rules as the ticket) or the
 * Sidekick team (`owner`). 404 otherwise. The route sends it as a download.
 */
export async function attachmentFile(who: { user: User } | { owner: true }, id: unknown) {
  const a = typeof id === "string" ? await get<{ id: string; ticket_id: string; name: string; mime: string; data: string }>("SELECT id, ticket_id, name, mime, data FROM support_attachments WHERE id = ?", id) : undefined;
  if (!a) throw new HttpError(404, "File not found.");
  if ("user" in who) await visibleTicket(who.user, a.ticket_id).catch(() => {
    throw new HttpError(404, "File not found.");
  });
  return { name: a.name, mime: a.mime, data: Buffer.from(a.data, "base64") };
}

/* ------------------------------------------------------------------ */
/* The Sidekick team's side (Owner Console)                            */
/* ------------------------------------------------------------------ */

/** Inbox filters (all optional): status, priority, category, client (an org id, or "none" for public tickets), search text. */
export type InboxFilter = { status?: string; priority?: string; category?: string; client?: string; q?: string };

/**
 * The Support inbox: tickets matching the filters (newest activity first, up to 300), with the client's name,
 * and counts by status plus unread (new customer activity). Operators only (the route checks).
 */
export async function inbox(filter: InboxFilter) {
  const where: string[] = [];
  const values: string[] = [];
  const add = (clause: string, value?: string) => {
    where.push(clause);
    if (value !== undefined) values.push(value);
  };
  if (filter.status && STATUSES.includes(filter.status as Status)) add("t.status = ?", filter.status);
  if (filter.priority && PRIORITIES.includes(filter.priority as Priority)) add("t.priority = ?", filter.priority);
  if (filter.category && CATEGORIES.includes(filter.category as Category)) add("t.category = ?", filter.category);
  if (filter.client === "none") add("t.org_id IS NULL");
  else if (filter.client) add("t.org_id = ?", filter.client);
  if (filter.q?.trim()) {
    const q = `%${filter.q.trim().toLowerCase().slice(0, 80)}%`;
    where.push("(LOWER(t.subject) LIKE ? OR LOWER(t.ref) LIKE ? OR LOWER(t.email) LIKE ? OR LOWER(t.name) LIKE ?)");
    values.push(q, q, q, q);
  }
  const rows = await all<TicketRow & { org_name: string | null }>(
    `SELECT t.*, o.name AS org_name FROM support_tickets t LEFT JOIN orgs o ON o.id = t.org_id${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY t.updated_at DESC LIMIT 300`,
    ...values,
  );
  const counts = await all<{ status: string; n: number; unread: number }>("SELECT status, COUNT(*) AS n, SUM(staff_unread) AS unread FROM support_tickets GROUP BY status");
  const clients = await all<{ id: string; name: string }>("SELECT DISTINCT o.id, o.name FROM support_tickets t JOIN orgs o ON o.id = t.org_id ORDER BY o.name");
  return {
    tickets: rows.map((t) => ({ ...summary(t), client: t.org_name ?? "Website (no organization)", clientId: t.org_id, assignedTo: t.assigned_to, unread: Number(t.staff_unread) === 1 })),
    counts: Object.fromEntries(STATUSES.map((s) => [s, Number(counts.find((c) => c.status === s)?.n ?? 0)])) as Record<Status, number>,
    unread: counts.reduce((n, c) => n + Number(c.unread ?? 0), 0),
    clients,
  };
}

/** The ticket for an operator, or 404. */
async function ownerTicketRow(id: unknown): Promise<TicketRow> {
  const t = typeof id === "string" ? await get<TicketRow>("SELECT * FROM support_tickets WHERE id = ?", id) : undefined;
  if (!t) throw new HttpError(404, "Ticket not found.");
  return t;
}

const REF = /\b[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}\b/g;

/**
 * What the team needs next to a ticket: the client (name, status, plan and subscription status), its recent
 * errors by reference code (last 14 days, from its own traces, with the error log's message), and any reference
 * code quoted in the thread that belongs to this client. No client documents.
 */
export async function ticketContext(t: TicketRow, threadText: string) {
  if (!t.org_id) return { client: null, errors: [], quoted: [] };
  const org = await get<{ id: string; name: string; status: string }>("SELECT id, name, status FROM orgs WHERE id = ?", t.org_id);
  const [{ plan }, sub] = await Promise.all([orgPlan(t.org_id), getSubscription(t.org_id)]);
  const since = new Date(Date.now() - 14 * 86400_000).toISOString();
  const errors = await all<{ ref: string; name: string; error: string | null; http_status: number | null; actor: string | null; started_at: string }>(
    "SELECT ref, name, error, http_status, actor, started_at FROM traces WHERE org_id = ? AND ref IS NOT NULL AND started_at >= ? ORDER BY started_at DESC LIMIT 20",
    t.org_id, since,
  );
  const refs = [...new Set(threadText.toUpperCase().match(REF) ?? [])].slice(0, 10);
  const quoted = refs.length
    ? await all<{ ref: string; name: string; error: string | null; started_at: string }>(
        `SELECT ref, name, error, started_at FROM traces WHERE org_id = ? AND ref IN (${refs.map(() => "?").join(",")})`,
        t.org_id, ...refs,
      )
    : [];
  const allRefs = [...new Set([...errors.map((e) => e.ref), ...quoted.map((q) => q.ref)])];
  const logged = allRefs.length
    ? await all<{ ref: string; message: string; route: string | null }>(`SELECT ref, message, route FROM app_errors WHERE ref IN (${allRefs.map(() => "?").join(",")})`, ...allRefs)
    : [];
  const detail = (ref: string) => logged.find((l) => l.ref === ref);
  return {
    client: org ? { id: org.id, name: org.name, status: org.status, plan: plan?.name ?? "Managed by the Sidekick team", subscription: sub?.status ?? null } : null,
    errors: errors.map((e) => ({ ref: e.ref, what: e.name, error: e.error, status: e.http_status, who: e.actor, at: e.started_at, logged: detail(e.ref)?.message ?? null })),
    quoted: quoted.map((q) => ({ ref: q.ref, what: q.name, error: q.error, at: q.started_at, logged: detail(q.ref)?.message ?? null })),
  };
}

/**
 * One ticket for the Owner Console: everything including internal notes and contact details, the assistant's
 * checks (if it came from the Help assistant) and the client context. Opening it clears the team's unread flag.
 */
export async function ownerTicket(id: unknown) {
  const t = await ownerTicketRow(id);
  if (Number(t.staff_unread) === 1) await run("UPDATE support_tickets SET staff_unread = 0 WHERE id = ?", t.id);
  const messages = await thread(t.id, true);
  return {
    ticket: { ...summary(t), name: t.name, email: t.email, phone: t.phone, page: t.page, assignedTo: t.assigned_to, orgId: t.org_id, checks: t.checks ? JSON.parse(t.checks) : null },
    messages,
    context: await ticketContext(t, messages.map((m) => m.body).join("\n")),
  };
}

/**
 * The team's actions on a ticket: `reply` (to the customer; status becomes waiting, the customer gets the unread
 * dot), `note` (internal, never shown to customers), `assign` (to an operator's name, or nobody), `priority`,
 * `resolve` and `reopen`. Each is written to the operator log and, for a ticket with an organization, to that
 * organization's audit log (internal notes only as "added an internal note", never their text).
 */
export async function ownerAct(owner: { name: string }, id: unknown, body: Record<string, unknown>, attachment: AttachmentInput | null) {
  const t = await ownerTicketRow(id);
  const clientLog = (action: string) => (t.org_id ? audit({ org_id: t.org_id, name: `${owner.name} (Sidekick team)` }, action, "Support") : Promise.resolve());
  const at = now();
  switch (body.action) {
    case "reply": {
      const message = text(body.message, 8000);
      if (!message) throw new HttpError(400, "Write the reply first.");
      await tx(async () => {
        await addMessage(t, "staff", `${owner.name} (Sidekick team)`, message, false, attachment);
        await run("UPDATE support_tickets SET status = CASE WHEN status = 'resolved' THEN 'resolved' ELSE 'waiting' END, customer_unread = 1, staff_unread = 0, updated_at = ? WHERE id = ?", at, t.id);
      });
      await clientLog(`Sidekick team replied to support ticket ${t.ref}`);
      await platformLog(owner.name, `Replied to support ticket ${t.ref}`);
      await notify({ kind: "staff_reply", ticket: t, to: "customer" });
      break;
    }
    case "note": {
      const message = text(body.message, 8000);
      if (!message) throw new HttpError(400, "Write the note first.");
      await addMessage(t, "staff", owner.name, message, true, attachment);
      await run("UPDATE support_tickets SET updated_at = ? WHERE id = ?", at, t.id);
      await platformLog(owner.name, `Added an internal note to support ticket ${t.ref}`);
      break;
    }
    case "assign": {
      const to = text(body.to, 120) || null;
      await run("UPDATE support_tickets SET assigned_to = ?, updated_at = ? WHERE id = ?", to, at, t.id);
      await addMessage(t, "system", "Sidekick", to ? `Assigned to ${to}.` : "Unassigned.", true, null);
      await platformLog(owner.name, `${to ? `Assigned support ticket ${t.ref} to ${to}` : `Unassigned support ticket ${t.ref}`}`);
      break;
    }
    case "priority": {
      const p = body.priority as Priority;
      if (!PRIORITIES.includes(p)) throw new HttpError(400, "Pick a priority: low, normal, high or urgent.");
      if (p === t.priority) break;
      await run("UPDATE support_tickets SET priority = ?, updated_at = ? WHERE id = ?", p, at, t.id);
      await addMessage(t, "system", "Sidekick", `Priority changed from ${t.priority} to ${p}.`, true, null);
      await clientLog(`Sidekick team changed support ticket ${t.ref} priority to ${p}`);
      await platformLog(owner.name, `Changed support ticket ${t.ref} priority from ${t.priority} to ${p}`);
      break;
    }
    case "resolve":
    case "reopen": {
      const resolve = body.action === "resolve";
      if ((t.status === "resolved") === resolve) break;
      await run("UPDATE support_tickets SET status = ?, resolved_at = ?, customer_unread = 1, updated_at = ? WHERE id = ?", resolve ? "resolved" : "open", resolve ? at : null, at, t.id);
      await addMessage(t, "system", "Sidekick", resolve ? `Resolved by ${owner.name} (Sidekick team).` : `Reopened by ${owner.name} (Sidekick team).`, false, null);
      await clientLog(`Sidekick team ${resolve ? "resolved" : "reopened"} support ticket ${t.ref}`);
      await platformLog(owner.name, `${resolve ? "Resolved" : "Reopened"} support ticket ${t.ref}`);
      await notify({ kind: resolve ? "resolved" : "reopened", ticket: t, to: "customer" });
      break;
    }
    default:
      throw new HttpError(400, "Unknown action. Use reply, note, assign, priority, resolve or reopen.");
  }
  return ownerTicket(t.id);
}

/** Masks contact details in a help-bot transcript line (visitors' text is masked before it's stored anyway). */
export const maskTranscript = (s: string) => maskPersonalData(s).text;
