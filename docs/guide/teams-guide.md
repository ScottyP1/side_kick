# Sidekick in Teams

Sidekick works inside Microsoft Teams group chats, channels and 1:1 chats. It answers from **one client workspace** (the one the chat or channel is linked to), posts meeting notes after each meeting, and, where an admin turned it on, keeps track of the chat and reminds the team about what's still open.

## Getting started
1. Add Sidekick where your team works:
   - **Group chat** (including a meeting's chat): open the chat, click **+** or **⋯ → Manage apps** at the top, add **Sidekick**.
   - **Channel**: on the team, **⋯ → Manage team → Apps**, add **Sidekick**.

   Teams asks the chat or team owner to let Sidekick **read messages** there. Accept it: that's what lets an admin later turn on *Keep track of every message* (Sidekick still only does that once an admin switches it on, and announces it).
2. Sidekick posts **"This chat is waiting to be assigned"**: the chat now shows in the Sidekick portal under **Workspaces → Waiting to be assigned**, with its name, who added Sidekick and when.
3. An Org Admin (or the Team Lead of the right workspace) picks the workspace there and presses **Assign**. No code to copy. Sidekick confirms in the chat when it's done.

The card also shows an 8-character **link code** as a fallback (or mention `@Sidekick link` for a new one): entering it on **Workspaces → Link a Teams chat or channel** does the same thing. If your organization hasn't connected Microsoft sign-in to Sidekick yet, Sidekick shows only the code.

**Your organization isn't on Sidekick yet?** Sidekick replies "Sidekick isn't set up for your organization yet" with a link to sign up, and reads or keeps nothing from that chat. After your company signs up and its Org Owner connects Microsoft (Settings → Microsoft sign-in), mention `@Sidekick` in the chat again and it appears under *Waiting to be assigned*.

### Group chat or channel?
Both work the same for Sidekick; use whatever your team already uses.
- **Group chat**: one running conversation. Sidekick's answers, notes, action-item cards and reminders appear in the chat in order.
- **Channel**: posts with replies. Meeting notes are a new post and their action items go in that post's thread; reminders are a new post; answers are replies to the post that mentioned Sidekick.
- A **meeting chat** (the chat of a scheduled Teams meeting) is a group chat to Sidekick, so it's a natural place for that meeting series' notes.
- **Names on the Workspaces page**: a group chat shows its name if someone gave it one. A channel shows as "Team › Channel"; a team's first channel shows only the team name until it's renamed, because Teams doesn't tell apps that channel's name (it's "General" unless someone renamed it).

## Asking questions
Mention Sidekick with your question:

> @Sidekick when is the wave 2 cutover and how many stores are in it?

Pick **Sidekick** from the list Teams shows while you type `@Sidek…`, so the name turns into a highlighted mention. If you just type "@Sidekick" without picking it, Teams doesn't treat it as a mention: Sidekick usually still answers when the message *starts* with "@Sidekick" (it can read the chat's messages since version 1.1.0 of the app), but picking it from the list always works.

In a 1:1 chat with Sidekick you don't need the mention. You get a card with:
- the answer, with citations like **[S1]**;
- each source: the document or meeting, the page or timestamp, and a short excerpt.

If the workspace doesn't contain the answer, Sidekick says so instead of guessing, and logs it as a knowledge gap for the team to fill.

Your organization's **guardrails** apply in Teams exactly as in the portal. A question that breaks them (abuse, trying to get Sidekick to drop its rules, asking about another client, something your Org Owner switched off, or one of your organization's or workspace's custom rules) gets a short, polite refusal card instead of an answer.

## Meeting notes
After a meeting transcript is imported for the workspace, Sidekick posts:
1. a **notes card**: summary, decisions and questions still open, with **Open in Sidekick** for the full notes;
2. one **card per action item** (in a group chat they follow the notes; in a channel they're replies in the notes post's thread).

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

## Adding people from the chat
In a chat linked to a workspace, the workspace's **Team Lead** or an **Org Admin** can manage who's in it without leaving Teams:

> @Sidekick add @Maria Lopez
>
> @Sidekick remove @Maria Lopez

Pick each person from Teams' mention list (so they become real mentions). Sidekick replies with a card saying what it did for each person:
- **add**: puts them in this chat's workspace. Someone who isn't in Sidekick yet gets an account as a **Member** who signs in with their Microsoft work account (no password to hand out). Guests from other companies can't be added (they can still ask questions in the chat), and Org Owners and Org Admins already see every workspace.
- **remove**: takes them off this workspace only; their Sidekick account stays (an Org Admin removes accounts on Users & access). Nobody can take themselves off, and a Team Lead only adds or removes Members and Viewers.

Sidekick needs to know who's asking: sign in to the Sidekick portal with Microsoft once. Anyone else gets a polite "only this workspace's Team Lead or an Org Admin can…". Every change is in the audit log ("… from Teams").

## Commands
| Type | Does |
|---|---|
| `@Sidekick <question>` | Answer with sources |
| `@Sidekick link` | Show the link code, or which workspace this chat is linked to |
| `@Sidekick add @name` | Add someone to this chat's workspace (Team Lead or Org Admin) |
| `@Sidekick remove @name` | Take someone off this chat's workspace (Team Lead or Org Admin) |
| `@Sidekick help` | Show what Sidekick can do here |

## What Sidekick can and can't see
- It only reads messages that mention it (every message in a 1:1 chat with it), unless an admin turned on **Keep track of every message** for that chat (Sidekick announces it there).
- Meeting notes go to the chats an admin left notes switched on for (all linked chats by default), so a workspace can keep them in one dedicated notes chat.
- It only answers from the linked workspace. It never uses other workspaces or other clients' material.
- In chats and channels marked as having **client guests**, it only uses documents tagged *Shareable*, never posts notes from internal-only meetings there, and only reminds about items whose every source is Shareable.
- If the chat or channel is unlinked, Sidekick stops answering and posting there until it's linked again.
