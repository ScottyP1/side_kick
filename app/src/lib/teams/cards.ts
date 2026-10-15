import "server-only";
import type { IAdaptiveCard } from "@microsoft/teams.cards";

// Adaptive Cards Sidekick posts in Teams. Plain JSON so they're easy to read and tweak:
// paste any of them into https://adaptivecards.microsoft.com/designer to preview.
// Card buttons use Action.Execute (Universal Actions); /api/messages handles the verbs below.

export const VERBS = { assign: "sidekick.action.assign", done: "sidekick.action.done", reopen: "sidekick.action.reopen" } as const;

type Block = Record<string, unknown>;
const card = (body: Block[], actions: Block[] = []): IAdaptiveCard =>
  ({ type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.5", body, ...(actions.length ? { actions } : {}) }) as unknown as IAdaptiveCard;
const text = (t: string, extra: Block = {}): Block => ({ type: "TextBlock", text: t, wrap: true, ...extra });
const header = (eyebrow: string, title: string): Block[] => [
  text(eyebrow.toUpperCase(), { size: "Small", weight: "Bolder", color: "Accent", spacing: "None" }),
  text(title, { size: "Large", weight: "Bolder", spacing: "Small" }),
];

// Card text is Markdown, so strip the source's own Markdown (headings, bold) from excerpts.
const plain = (s: string) => s.replace(/[#*_`>|]+/g, " ").replace(/\s+/g, " ").trim();

export type CardSource = { id: string; title: string; loc: string | null; type: string; excerpt: string };

export function answerCard(question: string, answer: { found: boolean; answer: string; sources: CardSource[] }, workspace: string): IAdaptiveCard {
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
  } else if (!answer.found) {
    body.push(text("I logged this as a knowledge gap so the team can fill it in.", { size: "Small", isSubtle: true }));
  }
  return card(body);
}

export function linkCard(code: string, kind: string): IAdaptiveCard {
  const where = kind === "channel" ? "channel" : "chat";
  return card([
    ...header("Sidekick", `Link this ${where} to a workspace`),
    text(`I don't know which client workspace this ${where} belongs to yet, so I can't answer from its documents and meetings.`),
    text("An Org Admin can link it in the Sidekick portal: **Workspaces → Link Teams channel**, then enter this code:"),
    text(code, { size: "ExtraLarge", weight: "Bolder", fontType: "Monospace", horizontalAlignment: "Center", spacing: "Medium" }),
    text("The code works for 24 hours. Mention me with **link** to get a new one.", { size: "Small", isSubtle: true }),
  ]);
}

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
    text("After a meeting transcript is imported for this workspace, I post the notes and action items here.", { size: "Small", isSubtle: true }),
  ]);
}

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

export type ActionItemInput = { id: string; text: string; owner: string | null; due: string | null; status: string; updatedBy?: string };

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
