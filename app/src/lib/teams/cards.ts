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
  // "Save to knowledge" / "Undo" on a meeting-notes card (lib/saved-items.ts). data: { itemId, meetingId }.
  saveKnowledge: "sidekick.knowledge.save",
  unsaveKnowledge: "sidekick.knowledge.unsave",
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

/**
 * The person who added Sidekick to a chat or channel (Teams' `from` on the install event), greeted by @mention.
 * `name` is null when neither Teams nor Sidekick knows it: the welcome then thanks without a mention.
 */
export type Installer = { id: string; name: string | null };

/**
 * Shown on every first-run card: what's AI about Sidekick and how to report a bad answer (Teams Store rules for
 * AI-generated content: a visible disclaimer and a way to report).
 */
export const AI_NOTE = `Answers and notes are written by AI (Claude) from your group's own content and can be wrong: check the sources. Report a bad answer with 👎 or at ${BRAND.supportEmail}.`;

/** Who must do what before Sidekick works (Store rule: call out admin dependencies and limitations up front). */
export const SETUP_NOTE = `${BRAND.name} needs your organization's ${BRAND.name} account and a one-time admin approval for Microsoft 365. It works in 1:1 chats, group chats, channels and meeting chats.`;

/** The welcome greeting for whoever added Sidekick ("Thanks for adding me, <at>Ana</at>."), or nothing. */
const welcomeIntro = (installer?: Installer): Block[] =>
  installer
    ? [
        text(`Thanks for adding me${installer.name ? `, <at>${installer.name}</at>` : ""}. I'm ${BRAND.name}: I answer this team's questions from its own documents and meetings, with sources, and post meeting notes and reminders. Mention me with **help** for the list of commands.`),
        text(AI_NOTE, { size: "Small", isSubtle: true, spacing: "Small" }),
      ]
    : [];

/** Adds the Teams mention entity a card needs so `<at>name</at>` in its text becomes a real @mention. */
function withMention(c: IAdaptiveCard, installer?: Installer): IAdaptiveCard {
  if (!installer?.name) return c;
  return { ...c, msteams: { entities: [{ type: "mention", text: `<at>${installer.name}</at>`, mentioned: { id: installer.id, name: installer.name } }] } } as unknown as IAdaptiveCard;
}

/** The help-center button. Its title says it leaves Teams (Store rule for links that open a browser). */
const helpCenterAction = (): Block => ({ type: "Action.OpenUrl", title: "Help center (opens in browser)", url: helpCenterUrl() });

/**
 * The public help center's Teams guide, from the same setting as `portalUrl` in lib/tenants.ts (SIDEKICK_PUBLIC_URL).
 * Not imported from there: cards stay free of the database and request helpers, so unit tests can load them.
 */
const helpCenterUrl = () => `${(process.env.SIDEKICK_PUBLIC_URL || "http://localhost:3000").replace(/\/$/, "")}/docs/teams-guide`;

// Card text is Markdown, so strip the source's own Markdown (headings, bold) from excerpts.
const plain = (s: string) => s.replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim();

/** One cited source, as returned by `ask()` in sidekick.ts. `origin` "firm" = the org's firm library. */
export type CardSource = { id: string; title: string; loc: string | null; type: string; excerpt: string; origin?: "group" | "firm"; outdated?: string | null; url?: string | null; appliesTo?: number };

/**
 * The button title for a cited connector source, from its title: "Open #4821" (Azure DevOps), "Open CUT-12"
 * (Jira), "Open store-pos#12" (GitHub), "Open in Confluence" (a page), "Open in SharePoint" / "Open in OneDrive" (a file).
 */
export function openLabel(title: string): string {
  if (title.startsWith("Confluence page")) return "Open in Confluence";
  if (title.startsWith("SharePoint file")) return "Open in SharePoint";
  if (title.startsWith("OneDrive file")) return "Open in OneDrive";
  return `Open ${title.split(":")[0].replace(/^(Azure DevOps|Jira|GitHub)\s.*?([#\w.-]+)$/, "$2")}`;
}

/** What the answer card shows besides the answer itself. */
export type AnswerExtras = { blocked?: string | null; conflict?: boolean; followUp?: string | null; questionId?: string | null };

/**
 * The reply to a question: the question as the title (with a short "Following up on …" line when it built on the
 * conversation), the answer (with [S1]-style citations), a note when sources disagree, and each cited source with
 * its origin ("Firm policy · …" for the firm library), location, an "may be out of date" flag, and a short excerpt;
 * a work item from a connector (Azure DevOps, Jira, GitHub) also gets an "Open #4821" button to the tool, and a
 * Confluence page an "Open in Confluence" button and a Microsoft 365 file "Open in SharePoint" / "Open in OneDrive" (`openLabel`).
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
      const origin = s.origin === "firm" ? `Firm policy${s.appliesTo ? ` (${s.appliesTo === 1 ? "this group only" : `${s.appliesTo} groups`})` : ""} · ` : "";
      body.push({
        type: "Container",
        spacing: "Small",
        items: [
          text(`**[${s.id}]** ${origin}${s.title}${s.loc ? ` · ${s.loc}` : ""}${s.outdated ? ` · may be out of date (${s.outdated})` : ""}`, { size: "Small" }),
          text(`“${plain(s.excerpt)}…”`, { size: "Small", isSubtle: true, spacing: "None", maxLines: 3 }),
          // A work item or page from a connector opens in the tool (a button, never a Markdown link).
          ...(s.url && /^https?:\/\//.test(s.url)
            ? [{ type: "ActionSet", spacing: "None", actions: [{ type: "Action.OpenUrl", title: openLabel(s.title), url: s.url }] }]
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
  body.push(text(`AI-generated: check the sources. Ask a follow-up the same way, or start with **new question** to start afresh.`, { size: "Small", isSubtle: true, spacing: "Medium" }));
  return card(body, [
    { type: "Action.Execute", title: "👍 Helpful", verb: VERBS.feedbackUp, data: { questionId: answer.questionId } },
    { type: "Action.Execute", title: "👎 Not helpful", verb: VERBS.feedbackDown, data: { questionId: answer.questionId } },
  ]);
}

/**
 * Shown in a conversation that isn't linked yet: explains linking and shows the 8-character code. On install it's
 * the welcome message, greeting `installer` by @mention.
 */
export function linkCard(code: string, kind: string, installer?: Installer): IAdaptiveCard {
  const where = kind === "channel" ? "channel" : "chat";
  return withMention(card([
    ...header(BRAND.name, `Link this ${where} to a group`),
    ...welcomeIntro(installer),
    text(`I don't know which group this ${where} belongs to yet, so I can't answer from its documents and meetings.`),
    text(`A Team Lead or admin can link it on the group's page in the ${BRAND.name} portal (**Teams chats**), with this code:`),
    text(code, { size: "ExtraLarge", weight: "Bolder", fontType: "Monospace", horizontalAlignment: "Center", spacing: "Medium" }),
    text("The code works for 24 hours. Mention me with **link** to get a new one.", { size: "Small", isSubtle: true }),
    text(SETUP_NOTE, { size: "Small", isSubtle: true }),
  ], [helpCenterAction()]), installer);
}

/**
 * Shown once when Sidekick is added to a chat or channel whose Microsoft organization uses Sidekick, by a Team
 * Lead or admin (and again if someone mentions Sidekick there before it's assigned). No buttons (assigning happens
 * only in the portal, on the group's page); the help center's address is in the text. On install it greets
 * `installer` (the welcome message).
 */
export function notSetUpCard(kind: string, days: number, installer?: Installer): IAdaptiveCard {
  const where = kind === "channel" ? "channel" : "chat";
  return withMention(card([
    ...header(BRAND.name, `I'm not set up for this ${where} yet`),
    ...welcomeIntro(installer),
    text(`A Team Lead needs to assign this ${where} to a group in the ${BRAND.name} portal. Until then I won't read, save or answer anything here.`),
    text(`If nobody assigns it within ${days} days, I'll leave the ${where}. Mention me with **help** to see what I can do once I'm set up, or read the help center (opens in browser): ${helpCenterUrl()}`, { size: "Small", isSubtle: true }),
  ]), installer);
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
      text(SETUP_NOTE, { size: "Small", isSubtle: true }),
    ],
    [{ type: "Action.OpenUrl", title: "Sign up", url: signupUrl }],
  );
}

/**
 * What Sidekick can do here, and which workspace this conversation is linked to (if any). Answers `help` (and an
 * empty mention) everywhere, linked or not, so it never dead-ends: unlinked chats get the next step, and every
 * version has the help-center button (Teams Store rule: help answers inside Teams and offers a way forward).
 * With `installer` it's the welcome message for a chat that was already linked when Sidekick was added: it greets
 * the person who added it by @mention (Store rule for group chats and channels). Sent once per install, never
 * again on `help`.
 */
export function helpCard(workspace: string | null, installer?: Installer): IAdaptiveCard {
  return withMention(card([
    ...header(BRAND.name, workspace ? `Linked to ${workspace}` : "Not linked to a group yet"),
    ...welcomeIntro(installer),
    ...(workspace ? [] : [text(`To get started, a Team Lead or admin links this chat to a group in the ${BRAND.name} portal. Until then I can't answer from any group's documents or meetings.`)]),
    text("Mention me with a question and I'll answer from this group's documents, meetings and chats and your firm library, with sources. Follow-ups build on the last answer: in a channel, reply in the same thread; in a chat, within 30 minutes."),
    {
      type: "FactSet",
      facts: [
        { title: `@${BRAND.name} <question>`, value: "Answer with sources" },
        { title: `@${BRAND.name} new question`, value: "Start afresh (forget the earlier questions)" },
        { title: `@${BRAND.name} link`, value: "Show which group this chat belongs to" },
        { title: `@${BRAND.name} add @name`, value: "Add someone to this group (Team Lead or admin)" },
        { title: `@${BRAND.name} remove @name`, value: "Take someone off this group (Team Lead or admin)" },
        { title: `@${BRAND.name} post meeting notes here`, value: "Send this group's meeting notes to this chat (Team Lead or admin)" },
        { title: `@${BRAND.name} stop posting notes here`, value: "Stop sending meeting notes to this chat (Team Lead or admin)" },
        { title: `@${BRAND.name} stop transcription reminders`, value: "No more “turn on transcription” reminders in this group's calls (Team Lead or admin)" },
        { title: `@${BRAND.name} help`, value: "Show this card" },
      ],
    },
    text("Depending on how the Team Lead set up this group, I post meeting notes and action items here after each meeting, and reminders about what's still open.", { size: "Small", isSubtle: true }),
    ...(installer ? [] : [text(AI_NOTE, { size: "Small", isSubtle: true })]),
    text(SETUP_NOTE, { size: "Small", isSubtle: true }),
  ], [helpCenterAction()]), installer);
}

/** A decision, requirement, risk, fact or term on the notes card, with its "Save to knowledge" state. */
export type NotesKeepItem = { id: string; kind: string; text: string; savedBy: string | null };

/**
 * Everything the meeting-notes card shows. `portalUrl` is where "Open in Sidekick" goes. `meetingId` and `keep`
 * add a "Save to knowledge" button per decision and per requirement/risk/fact/term (lib/saved-items.ts); a card
 * without them shows the decisions as a plain list (`decisions`).
 */
export type NotesInput = {
  workspace: string;
  title: string;
  heldAt: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  actionCount: number;
  portalUrl: string;
  meetingId?: string;
  keep?: NotesKeepItem[];
  /** "Captured from Microsoft Teams" for automatic notes. */
  source?: string;
  /** Footer: where these notes were posted ("Notes posted to …", lib/notes-chats.ts `postedToLine`). */
  postedTo?: string | null;
};

/** Cap on rows with a Save button, so a long meeting's card stays within Teams' card size; the rest is in the portal. */
const MAX_KEEP_ROWS = 12;
const KEEP_LABEL: Record<string, string> = { decision: "Decision", requirement: "Requirement", fact: "Fact", risk: "Risk", glossary: "Term" };

/**
 * Meeting summary, decisions and still-open questions, with a link to the full notes in the portal. With `keep`,
 * each decision (then requirements, risks, facts, terms) is a row with **Save to knowledge** (verb
 * `VERBS.saveKnowledge`, data `{ itemId, meetingId }`); a saved one shows who saved it and **Undo**
 * (`VERBS.unsaveKnowledge`). The bot answers a click with this card rebuilt, so everyone sees the new state.
 * The footer says which chats got the notes (`postedTo`).
 */
export function meetingNotesCard(m: NotesInput): IAdaptiveCard {
  const sub = [m.heldAt, m.source].filter(Boolean).join(" · ");
  const body: Block[] = [...header(`Meeting notes · ${m.workspace}`, m.title), text(sub, { isSubtle: true, spacing: "None", size: "Small" }), text(m.summary, { spacing: "Medium" })];
  const list = (label: string, items: string[]) => {
    if (!items.length) return;
    body.push(text(label, { weight: "Bolder", spacing: "Large", separator: true }));
    body.push(text(items.map((i) => `- ${i}`).join("\n"), { spacing: "Small" }));
  };
  if (m.keep && m.meetingId) {
    const rows = [...m.keep.filter((k) => k.kind === "decision"), ...m.keep.filter((k) => k.kind !== "decision")];
    if (rows.length) {
      body.push(text("Decisions and things to keep", { weight: "Bolder", spacing: "Large", separator: true }));
      for (const k of rows.slice(0, MAX_KEEP_ROWS)) {
        const label = k.kind === "decision" ? "" : `${KEEP_LABEL[k.kind] ?? "Note"}: `;
        body.push({
          type: "ColumnSet",
          spacing: "Small",
          columns: [
            { type: "Column", width: "stretch", verticalContentAlignment: "Center", items: [text(`${label}${k.text}`, { spacing: "None" }), ...(k.savedBy ? [text(`✓ Saved to knowledge by ${noLinks(k.savedBy)}`, { size: "Small", color: "Good", spacing: "None" })] : [])] },
            {
              type: "Column",
              width: "auto",
              verticalContentAlignment: "Center",
              items: [{
                type: "ActionSet",
                actions: [k.savedBy
                  ? { type: "Action.Execute", title: "Undo", verb: VERBS.unsaveKnowledge, data: { itemId: k.id, meetingId: m.meetingId } }
                  : { type: "Action.Execute", title: "Save to knowledge", verb: VERBS.saveKnowledge, data: { itemId: k.id, meetingId: m.meetingId } }],
              }],
            },
          ],
        });
      }
      if (rows.length > MAX_KEEP_ROWS) body.push(text(`${rows.length - MAX_KEEP_ROWS} more in ${BRAND.name}.`, { size: "Small", isSubtle: true }));
    }
  } else {
    list("Decisions", m.decisions);
  }
  list("Still open", m.openQuestions);
  if (m.actionCount) body.push(text(`${m.actionCount} action item${m.actionCount === 1 ? "" : "s"} below. Assign them or mark them done right here.`, { size: "Small", isSubtle: true, spacing: "Large" }));
  if (m.postedTo) body.push(text(m.postedTo, { size: "Small", isSubtle: true, spacing: m.actionCount ? "Small" : "Large" }));
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
