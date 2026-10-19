import "server-only";
import type { IAdaptiveCard } from "@microsoft/teams.cards";

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
} as const;
/** Every reminder-card verb starts with this, so the bot can route them to reminders.ts. */
export const REMIND_PREFIX = "sidekick.remind.";

type Block = Record<string, unknown>;
/** Builds a card from body elements and (optional) buttons. Version 1.5 is what Teams supports today. */
const card = (body: Block[], actions: Block[] = []): IAdaptiveCard =>
  ({ type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.5", body, ...(actions.length ? { actions } : {}) }) as unknown as IAdaptiveCard;
/** A wrapping TextBlock; `extra` sets size, weight, color and so on. */
const text = (t: string, extra: Block = {}): Block => ({ type: "TextBlock", text: t, wrap: true, ...extra });
/** Small accent label above a large bold title: the top of every Sidekick card. */
const header = (eyebrow: string, title: string): Block[] => [
  text(eyebrow.toUpperCase(), { size: "Small", weight: "Bolder", color: "Accent", spacing: "None" }),
  text(title, { size: "Large", weight: "Bolder", spacing: "Small" }),
];

// Card text is Markdown, so strip the source's own Markdown (headings, bold) from excerpts.
const plain = (s: string) => s.replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim();

/** One cited source, as returned by `ask()` in sidekick.ts. */
export type CardSource = { id: string; title: string; loc: string | null; type: string; excerpt: string };

/**
 * The reply to a question: the question as the title, the answer (with [S1]-style citations), and each
 * cited source with its location and a short excerpt. Unanswered questions say they were logged as a gap;
 * questions refused by the guardrails (`blocked`) say the organization's guardrails apply instead.
 */
export function answerCard(question: string, answer: { found: boolean; answer: string; sources: CardSource[]; blocked?: string | null }, workspace: string): IAdaptiveCard {
  const body: Block[] = [
    ...header(`Sidekick · ${workspace}`, question),
    text(answer.answer, { spacing: "Medium" }),
  ];
  if (answer.sources.length) {
    body.push(text("Sources", { weight: "Bolder", spacing: "Large", separator: true }));
    for (const s of answer.sources) {
      body.push({
        type: "Container",
        spacing: "Small",
        items: [
          text(`**[${s.id}]** ${s.title}${s.loc ? ` · ${s.loc}` : ""}`, { size: "Small" }),
          text(`“${plain(s.excerpt)}…”`, { size: "Small", isSubtle: true, spacing: "None", maxLines: 3 }),
        ],
      });
    }
  } else if (answer.blocked) {
    body.push(text("Your organization's guardrails apply here, in Teams and in the portal.", { size: "Small", isSubtle: true }));
  } else if (!answer.found) {
    body.push(text("I logged this as a knowledge gap so the team can fill it in.", { size: "Small", isSubtle: true }));
  }
  return card(body);
}

/** Shown in a conversation that isn't linked yet: explains linking and shows the 8-character code. */
export function linkCard(code: string, kind: string): IAdaptiveCard {
  const where = kind === "channel" ? "channel" : "chat";
  return card([
    ...header("Sidekick", `Link this ${where} to a workspace`),
    text(`I don't know which client workspace this ${where} belongs to yet, so I can't answer from its documents and meetings.`),
    text("An Org Admin can link it in the Sidekick portal: **Workspaces → Link a Teams chat or channel**, then enter this code:"),
    text(code, { size: "ExtraLarge", weight: "Bolder", fontType: "Monospace", horizontalAlignment: "Center", spacing: "Medium" }),
    text("The code works for 24 hours. Mention me with **link** to get a new one.", { size: "Small", isSubtle: true }),
  ]);
}

/** What Sidekick can do here, and which workspace this conversation is linked to (if any). */
export function helpCard(workspace: string | null): IAdaptiveCard {
  return card([
    ...header("Sidekick", workspace ? `Linked to ${workspace}` : "Not linked to a workspace yet"),
    text("Mention me with a question and I'll answer from this workspace's documents and meetings, with sources."),
    {
      type: "FactSet",
      facts: [
        { title: "@Sidekick <question>", value: "Answer with sources" },
        { title: "@Sidekick link", value: "Show the code to link this chat to a workspace" },
        { title: "@Sidekick help", value: "Show this card" },
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
  return card(body, [{ type: "Action.OpenUrl", title: "Open in Sidekick", url: m.portalUrl }]);
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
        { title: "Owner", value: a.owner || "Unassigned" },
        { title: "Due", value: a.due || "No date" },
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
  return card([...header("Sidekick", title), text(body), ...(footnote ? [text(footnote, { size: "Small", isSubtle: true })] : [])]);
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
  return card(body, [{ type: "Action.OpenUrl", title: "Open in Sidekick", url: r.portalUrl }]);
}
