import "server-only";
import type { IAdaptiveCard } from "@microsoft/teams.cards";
import { BRAND } from "../brand";

/**
 * @file The Adaptive Cards Sidekick posts in Teams.
 *
 * An **Adaptive Card** is a small JSON layout (text, facts, inputs, buttons) that Teams draws natively in
 * the chat. Cards are plain JSON here so they're easy to read and tweak: paste one into
 * https://adaptivecards.microsoft.com/designer to preview it. Text fields accept a little Markdown
 * (bold, lists, links), but not strikethrough or headings.
 *
 * Buttons use **Action.Execute** ("Universal Actions"): a click sends the button's `verb` and `data` (plus
 * any input values) back to /api/messages as a `card.action` activity, and the card returned replaces it.
 */

/** Button verbs handled by the `card.action` handler in bot.ts. Namespaced so they can't clash with other apps. */
export const VERBS = {
  assign: "sidekick.action.assign",
  done: "sidekick.action.done",
  reopen: "sidekick.action.reopen",
  // Buttons on a reminder card (see reminders.ts). All start with REMIND_PREFIX.
  remindAssign: "sidekick.remind.assign",
  remindDone: "sidekick.remind.done",
  remindSnooze: "sidekick.remind.snooze",
  remindDismiss: "sidekick.remind.dismiss",
  // 👍/👎 on an answer card (lib/feedback.ts). data: { questionId }.
  feedbackUp: "sidekick.feedback.up",
  feedbackDown: "sidekick.feedback.down",
} as const;
/** Every reminder-card verb starts with this, so the bot can route them to reminders.ts. */
export const REMIND_PREFIX = "sidekick.remind.";

type Block = Record<string, unknown>;
/** Builds a card from body elements and (optional) buttons. Version 1.5 is what Teams supports today. */
const card = (body: Block[], actions: Block[] = []): IAdaptiveCard =>
  ({ type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.5", body, ...(actions.length ? { actions } : {}) }) as unknown as IAdaptiveCard;
/**
 * Breaks Markdown link syntax (`[label](url)` becomes `[label] (url)`), so text Sidekick didn't write itself
 * (answers, excerpts, document and meeting titles, action items, names typed on cards) can't show a
 * clickable link with a misleading label inside a Sidekick card. Citations like [S1] still read the same.
 * Sidekick's own cards never use Markdown links (links are Action.OpenUrl buttons). Security review L5.
 */
export const noLinks = (t: string) => t.replace(/\]\s*\(/g, "] (");
/** A wrapping TextBlock; `extra` sets size, weight, color and so on. Markdown links are neutralised (`noLinks`). */
const text = (t: string, extra: Block = {}): Block => ({ type: "TextBlock", text: noLinks(t), wrap: true, ...extra });
/** Small accent label above a large bold title: the top of every Sidekick card. */
const header = (eyebrow: string, title: string): Block[] => [
  text(eyebrow.toUpperCase(), { size: "Small", weight: "Bolder", color: "Accent", spacing: "None" }),
  text(title, { size: "Large", weight: "Bolder", spacing: "Small" }),
];

// Card text is Markdown, so strip the source's own Markdown (headings, bold) from excerpts.
const plain = (s: string) => s.replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim();

/** One cited source, as returned by `ask()` in sidekick.ts. `origin` "firm" = the org's firm library. */
export type CardSource = { id: string; title: string; loc: string | null; type: string; excerpt: string; origin?: "group" | "firm"; outdated?: string | null; url?: string | null };

/** What the answer card shows besides the answer itself. */
export type AnswerExtras = { blocked?: string | null; conflict?: boolean; followUp?: string | null; questionId?: string | null };

/**
 * The reply to a question: the question as the title (with a short "Following up on …" line when it built on the
 * conversation), the answer (with [S1]-style citations), a note when sources disagree, and each cited source with
 * its origin ("Firm policy · …" for the firm library), location, an "may be out of date" flag, and a short excerpt;
 * a work item from a connector (Azure DevOps, Jira) also gets an "Open #4821" button to the tool.
 * Unanswered questions say they were logged as a gap; questions refused by the guardrails (`blocked`) say the
 * organization's guardrails apply instead. Answered (and "I don't know") replies get 👍/👎 buttons and a hint
 * about "new question".
 */
export function answerCard(question: string, answer: { found: boolean; answer: string; sources: CardSource[] } & AnswerExtras, workspace: string): IAdaptiveCard {
  const body: Block[] = [
    ...header(`${BRAND.name} · ${workspace}`, question),
    ...(answer.followUp ? [text(`Following up on: “${answer.followUp}”`, { size: "Small", isSubtle: true, spacing: "None" })] : []),
    text(answer.answer, { spacing: "Medium" }),
  ];
  if (answer.conflict) body.push(text("⚠ The sources disagree on this; both are cited below.", { size: "Small", color: "Warning", spacing: "Small" }));
  if (answer.sources.length) {
    body.push(text("Sources", { weight: "Bolder", spacing: "Large", separator: true }));
    for (const s of answer.sources) {
      const origin = s.origin === "firm" ? "Firm policy · " : "";
      body.push({
        type: "Container",
        spacing: "Small",
        items: [
          text(`**[${s.id}]** ${origin}${s.title}${s.loc ? ` · ${s.loc}` : ""}${s.outdated ? ` · may be out of date (${s.outdated})` : ""}`, { size: "Small" }),
          text(`“${plain(s.excerpt)}…”`, { size: "Small", isSubtle: true, spacing: "None", maxLines: 3 }),
          // A work item from Azure DevOps or Jira opens in the tool (a button, never a Markdown link).
          ...(s.url && /^https?:\/\//.test(s.url)
            ? [{ type: "ActionSet", spacing: "None", actions: [{ type: "Action.OpenUrl", title: `Open ${s.title.split(":")[0].replace(/^(Azure DevOps|Jira)\s.*?([#\w-]+)$/, "$2")}`, url: s.url }] }]
            : []),
        ],
      });
    }
  } else if (answer.blocked) {
    body.push(text("Your organization's guardrails apply here, in Teams and in the portal.", { size: "Small", isSubtle: true }));
  } else if (!answer.found) {
    body.push(text("I logged this as a knowledge gap so the team can fill it in.", { size: "Small", isSubtle: true }));
  }
  if (answer.blocked || !answer.questionId) return card(body);
  body.push(text(`Ask a follow-up the same way, or start with **new question** to start afresh.`, { size: "Small", isSubtle: true, spacing: "Medium" }));
  return card(body, [
    { type: "Action.Execute", title: "👍 Helpful", verb: VERBS.feedbackUp, data: { questionId: answer.questionId } },
    { type: "Action.Execute", title: "👎 Not helpful", verb: VERBS.feedbackDown, data: { questionId: answer.questionId } },
  ]);
}

/** Shown in a conversation that isn't linked yet: explains linking and shows the 8-character code. */
export function linkCard(code: string, kind: string): IAdaptiveCard {
  const where = kind === "channel" ? "channel" : "chat";
  return card([
    ...header(BRAND.name, `Link this ${where} to a group`),
    text(`I don't know which group this ${where} belongs to yet, so I can't answer from its documents and meetings.`),
    text(`A Team Lead or admin can link it on the group's page in the ${BRAND.name} portal (**Teams chats**), with this code:`),
    text(code, { size: "ExtraLarge", weight: "Bolder", fontType: "Monospace", horizontalAlignment: "Center", spacing: "Medium" }),
    text("The code works for 24 hours. Mention me with **link** to get a new one.", { size: "Small", isSubtle: true }),
  ]);
}

/**
 * Shown once when Sidekick is added to a chat or channel whose Microsoft organization uses Sidekick, by a Team
 * Lead or admin (and again if someone mentions Sidekick there before it's assigned). No buttons: assigning
 * happens only in the portal, on the group's page.
 */
export function notSetUpCard(kind: string, days: number): IAdaptiveCard {
  const where = kind === "channel" ? "channel" : "chat";
  return card([
    ...header(BRAND.name, `I'm not set up for this ${where} yet`),
    text(`A Team Lead needs to assign this ${where} to a group in the ${BRAND.name} portal. Until then I won't read, save or answer anything here.`),
    text(`If nobody assigns it within ${days} days, I'll leave the ${where}.`, { size: "Small", isSubtle: true }),
  ]);
}

/**
 * Posted when a Team Lead or admin assigns the chat to a group in the portal: from now on Sidekick reads every
 * message here (assigned means full access), and what it can do.
 */
export function assignedCard(workspace: string, by: string, retentionDays: number): IAdaptiveCard {
  return card([
    ...header(BRAND.name, `Assigned to ${workspace}`),
    text(`${by} assigned this chat to **${workspace}** in the ${BRAND.name} portal. From now on I read every message here to keep track of decisions, dates and to-dos, and only ${workspace}'s team can search what I learn. Messages are kept ${retentionDays} days.`),
    {
      type: "FactSet",
      facts: [
        { title: `@${BRAND.name} <question>`, value: "Answer with sources" },
        { title: `@${BRAND.name} new question`, value: "Start afresh (forget the earlier questions)" },
        { title: `@${BRAND.name} add @name`, value: "Add someone to the group (Team Lead or admin)" },
        { title: `@${BRAND.name} help`, value: "What I can do here" },
      ],
    },
    text(`To stop, a Team Lead or admin removes me from this chat on the group's page in ${BRAND.name}.`, { size: "Small", isSubtle: true }),
  ]);
}

/**
 * Shown in multi-tenant mode when Sidekick is added to (or mentioned in) a chat whose Microsoft organization
 * hasn't signed up for Sidekick. Nothing about the chat is stored.
 */
export function unknownTenantCard(signupUrl: string): IAdaptiveCard {
  return card(
    [
      ...header(BRAND.name, `${BRAND.name} isn't set up for your organization yet`),
      text(`Sign up at ${signupUrl} and connect your Microsoft 365 organization. Then a Team Lead or admin adds me to this chat again and assigns it to a group.`),
      text("Until then I don't read or keep anything from this chat.", { size: "Small", isSubtle: true }),
    ],
    [{ type: "Action.OpenUrl", title: "Sign up", url: signupUrl }],
  );
}

/** What Sidekick can do here, and which workspace this conversation is linked to (if any). */
export function helpCard(workspace: string | null): IAdaptiveCard {
  return card([
    ...header(BRAND.name, workspace ? `Linked to ${workspace}` : "Not linked to a group yet"),
    text("Mention me with a question and I'll answer from this group's documents, meetings and chats and your firm library, with sources. Follow-ups build on the last answer: in a channel, reply in the same thread; in a chat, within 30 minutes."),
    {
      type: "FactSet",
      facts: [
        { title: `@${BRAND.name} <question>`, value: "Answer with sources" },
        { title: `@${BRAND.name} new question`, value: "Start afresh (forget the earlier questions)" },
        { title: `@${BRAND.name} link`, value: "Show which group this chat belongs to" },
        { title: `@${BRAND.name} add @name`, value: "Add someone to this group (Team Lead or admin)" },
        { title: `@${BRAND.name} remove @name`, value: "Take someone off this group (Team Lead or admin)" },
        { title: `@${BRAND.name} help`, value: "Show this card" },
      ],
    },
    text("Depending on how an admin set up this chat, I post meeting notes and action items here after each meeting, and reminders about what's still open.", { size: "Small", isSubtle: true }),
  ]);
}

/** Everything the meeting-notes card shows. `portalUrl` is where "Open in Sidekick" goes. */
export type NotesInput = {
  workspace: string;
  title: string;
  heldAt: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  actionCount: number;
  portalUrl: string;
};

/** Meeting summary, decisions and still-open questions, with a link to the full notes in the portal. */
export function meetingNotesCard(m: NotesInput): IAdaptiveCard {
  const body: Block[] = [...header(`Meeting notes · ${m.workspace}`, m.title), text(m.heldAt, { isSubtle: true, spacing: "None", size: "Small" }), text(m.summary, { spacing: "Medium" })];
  const list = (label: string, items: string[]) => {
    if (!items.length) return;
    body.push(text(label, { weight: "Bolder", spacing: "Large", separator: true }));
    body.push(text(items.map((i) => `- ${i}`).join("\n"), { spacing: "Small" }));
  };
  list("Decisions", m.decisions);
  list("Still open", m.openQuestions);
  if (m.actionCount) body.push(text(`${m.actionCount} action item${m.actionCount === 1 ? "" : "s"} below. Assign them or mark them done right here.`, { size: "Small", isSubtle: true, spacing: "Large" }));
  return card(body, [{ type: "Action.OpenUrl", title: `Open in ${BRAND.name}`, url: m.portalUrl }]);
}

/** One action item as stored in `action_items`; `updatedBy` shows who last changed it from Teams. */
export type ActionItemInput = { id: string; text: string; owner: string | null; due: string | null; status: string; updatedBy?: string };

/**
 * One action item with its owner, due date and status. Open items get an "Assign to" box with Assign
 * and Mark done buttons; done items get Reopen. Assigning an Open item also moves it to In progress.
 */
export function actionItemCard(a: ActionItemInput): IAdaptiveCard {
  const done = a.status === "Done";
  const body: Block[] = [
    {
      type: "ColumnSet",
      columns: [
        { type: "Column", width: "stretch", items: [text(a.text, { weight: "Bolder", isSubtle: done })] },
        { type: "Column", width: "auto", items: [text(done ? "✓ Done" : a.status, { color: done ? "Good" : "Accent", size: "Small", weight: "Bolder" })] },
      ],
    },
    {
      type: "FactSet",
      spacing: "Small",
      facts: [
        { title: "Owner", value: noLinks(a.owner || "Unassigned") },
        { title: "Due", value: noLinks(a.due || "No date") },
      ],
    },
  ];
  if (a.updatedBy) body.push(text(`Updated by ${a.updatedBy}`, { size: "Small", isSubtle: true }));
  if (done) return card(body, [{ type: "Action.Execute", title: "Reopen", verb: VERBS.reopen, data: { itemId: a.id } }]);
  body.push({ type: "Input.Text", id: "owner", placeholder: "Name of the person taking it", value: a.owner ?? "", label: "Assign to", spacing: "Medium" });
  return card(body, [
    { type: "Action.Execute", title: "Assign", verb: VERBS.assign, data: { itemId: a.id }, associatedInputs: "auto" },
    { type: "Action.Execute", title: "Mark done", verb: VERBS.done, data: { itemId: a.id }, style: "positive", associatedInputs: "none" },
  ]);
}

/** A short announcement from Sidekick, e.g. that message tracking was switched on in this chat. */
export function noticeCard(title: string, body: string, footnote?: string): IAdaptiveCard {
  return card([...header(BRAND.name, title), text(body), ...(footnote ? [text(footnote, { size: "Small", isSubtle: true })] : [])]);
}

/** Where a reminder point came from: a meeting, document or tracked Teams chat, with its date. */
export type ReminderSource = { type: "meeting" | "document" | "chat"; title: string; when: string | null };

/**
 * One point on a reminder card. `key` names the item (action:<id>, item:<id>, gap:<hash>); `canAssign`
 * is true for action items. `status`/`by` are set once someone clicked a button on it.
 */
export type ReminderPointInput = {
  key: string;
  label: string;
  text: string;
  canAssign: boolean;
  sources: ReminderSource[];
  status?: "done" | "assigned" | "snoozed" | "dismissed";
  by?: string;
  owner?: string;
};

const SOURCE_WORD = { meeting: "Meeting", document: "Document", chat: "Chat" } as const;
const STATUS_TEXT = { done: "✓ Marked done", assigned: "✓ Assigned", snoozed: "Snoozed for a week", dismissed: "Marked not relevant" } as const;

/**
 * The reminder digest: a friendly intro, then up to six points. Each point shows what kind of reminder
 * it is, the text, and its source(s), then the buttons: Assign (action items only; opens a name box),
 * Mark done, Snooze (a week) and Not relevant. A point someone already handled shows who did what instead.
 */
export function reminderCard(r: { runId: string; workspace: string; intro: string; points: ReminderPointInput[]; portalUrl: string }): IAdaptiveCard {
  const body: Block[] = [...header(`Reminders · ${r.workspace}`, "Still open for the team"), text(r.intro, { spacing: "Small" })];
  r.points.forEach((p, i) => {
    const sources = p.sources.map((s) => `${SOURCE_WORD[s.type]}: ${s.title}${s.when ? ` · ${s.when}` : ""}`).join("  |  ");
    const items: Block[] = [
      text(p.label.toUpperCase(), { size: "Small", weight: "Bolder", color: p.label.startsWith("Overdue") ? "Attention" : "Accent", spacing: "None" }),
      text(p.text, { spacing: "Small" }),
      text(`Source: ${sources}`, { size: "Small", isSubtle: true, spacing: "None" }),
    ];
    if (p.status) {
      items.push(text(`${STATUS_TEXT[p.status]}${p.status === "assigned" && p.owner ? ` to ${p.owner}` : ""}${p.by ? ` by ${p.by}` : ""}`, { size: "Small", weight: "Bolder", color: p.status === "done" || p.status === "assigned" ? "Good" : "Default" }));
    } else {
      const data = { runId: r.runId, key: p.key };
      const actions: Block[] = [];
      if (p.canAssign) {
        actions.push({
          type: "Action.ShowCard",
          title: "Assign",
          card: {
            type: "AdaptiveCard",
            body: [{ type: "Input.Text", id: `owner_${i}`, placeholder: "Name of the person taking it", label: "Assign to" }],
            actions: [{ type: "Action.Execute", title: "Assign", verb: VERBS.remindAssign, data: { ...data, input: `owner_${i}` }, associatedInputs: "auto" }],
          },
        });
      }
      actions.push(
        { type: "Action.Execute", title: "Mark done", verb: VERBS.remindDone, data, style: "positive", associatedInputs: "none" },
        { type: "Action.Execute", title: "Snooze", verb: VERBS.remindSnooze, data, associatedInputs: "none" },
        { type: "Action.Execute", title: "Not relevant", verb: VERBS.remindDismiss, data, associatedInputs: "none" },
      );
      items.push({ type: "ActionSet", actions, spacing: "Small" });
    }
    body.push({ type: "Container", separator: true, spacing: "Medium", items });
  });
  return card(body, [{ type: "Action.OpenUrl", title: `Open in ${BRAND.name}`, url: r.portalUrl }]);
}
