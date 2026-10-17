# Sidekick in Teams

Sidekick works inside Microsoft Teams channels, group chats and 1:1 chats. It answers from **one client workspace** (the one the channel is linked to), posts meeting notes after each meeting, and, where an admin turned it on, keeps track of the chat and reminds the team about what's still open.

## Getting started in a channel
1. Add Sidekick to the team or chat (Apps → Sidekick → Add).
2. Mention it: `@Sidekick link`. If the channel isn't linked yet, Sidekick replies with an 8-character code.
3. Ask an Org Admin to enter that code in the Sidekick portal (**Workspaces → Link Teams channel**). Sidekick confirms in the channel when it's done.

## Asking questions
Mention Sidekick with your question:

> @Sidekick when is the wave 2 cutover and how many stores are in it?

In a 1:1 chat with Sidekick you don't need the mention. You get a card with:
- the answer, with citations like **[S1]**;
- each source: the document or meeting, the page or timestamp, and a short excerpt.

If the workspace doesn't contain the answer, Sidekick says so instead of guessing, and logs it as a knowledge gap for the team to fill.

Your organization's **guardrails** apply in Teams exactly as in the portal. A question that breaks them (abuse, trying to get Sidekick to drop its rules, asking about another client, something your Org Owner switched off, or one of your organization's or workspace's custom rules) gets a short, polite refusal card instead of an answer.

## Meeting notes
After a meeting transcript is imported for the workspace, Sidekick posts:
1. a **notes card**: summary, decisions and questions still open, with **Open in Sidekick** for the full notes;
2. one **card per action item** (in channels, as replies in the notes thread).

On an action-item card:
- **Assign**: type a name, click Assign. Open items move to *In progress*.
- **Mark done**: closes it. **Reopen** brings it back.

Changes show on the card for everyone, in the portal's tracker, and in the audit log under your name.

## Reminders
In chats where an Org Admin turned **Reminders** on, Sidekick posts a short **reminder card** once a day (at the chosen time, not on quiet days such as weekends) and right after each meeting. It lists up to six things that are still open:
- action items that are **overdue** or have **no owner**;
- **open questions** and **decisions still to make** that are due (or have been open for a week);
- documents that look **out of date** compared with newer meetings or chat messages (for example the runbook says Nov 5 but the cutover moved to Nov 12);
- **sources that disagree**.

Every point says where it comes from (the meeting, document or chat, with its date). Sidekick never posts a point it can't back up with a source, and it posts nothing when there's nothing to remind about.

Buttons on each point:
- **Assign** (action items): type a name. **Mark done**: closes the action item, answers the question or decision, or resolves the knowledge gap.
- **Snooze**: hides it from reminders for a week. **Not relevant**: hides it for good.

Changes show on the card for everyone and go in the audit log under your name. A Viewer can't change items.

## Chats Sidekick keeps track of
An Org Admin can switch **Keep track of every message** on for a channel or group chat. Sidekick then posts a notice in that chat, reads every message there (not only @mentions) and remembers them for 90 days, so it can answer from them and notice when plans change. It doesn't reply to messages that don't mention it. Only the linked workspace's team can search what it learned; in a chat with client guests, what's said there counts as Shareable. When the switch is turned off, Sidekick says so in the chat; when the chat is unlinked, the saved messages are deleted.

## Who you are in Teams
Once you've signed in to the Sidekick portal with Microsoft, Sidekick recognises you in Teams too: your questions and card clicks count under your Sidekick name and role. A **Viewer** can ask questions but can't assign or close action items. People in a linked chat who don't have a Sidekick account can still ask and use the cards, for that chat's workspace only.

## Commands
| Type | Does |
|---|---|
| `@Sidekick <question>` | Answer with sources |
| `@Sidekick link` | Show the link code, or which workspace this chat is linked to |
| `@Sidekick help` | Show what Sidekick can do here |

## What Sidekick can and can't see
- It only reads messages that mention it (every message in a 1:1 chat with it), unless an admin turned on **Keep track of every message** for that chat (Sidekick announces it there).
- Meeting notes go to the chats an admin left notes switched on for (all linked chats by default), so a workspace can keep them in one dedicated notes chat.
- It only answers from the linked workspace. It never uses other workspaces or other clients' material.
- In channels marked as having **client guests**, it only uses documents tagged *Shareable*, never posts notes from internal-only meetings there, and only reminds about items whose every source is Shareable.
- If the channel is unlinked, Sidekick stops answering and posting there until it's linked again.
