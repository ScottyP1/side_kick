# Meetings and automatic notes

Sidekick writes the notes for your group's meetings: a short summary, the **decisions**, **action items** (with owners and dates as spoken), **open questions**, and lasting facts like requirements, risks and terms. Notes land in the right group in the portal, are posted to the group's notes chat in Teams, and answers can use them straight away.

There are two ways meetings get to Sidekick:
- **Automatic notes after Teams meetings**: when a Teams meeting of a group's people ends, Sidekick reads its transcript and writes the notes by itself. That includes scheduled meetings and calls started with **Meet now** inside a group chat. No bot joins the call.
- **Add a past or outside meeting**: upload a transcript yourself, for meetings held before automatic notes were on, or outside Teams.

## Automatic notes after Teams meetings

### Turning it on (Org Owners and Org Admins)
1. Connect Sidekick to your Microsoft 365 organization: **Settings → Microsoft sign-in**.
2. A Microsoft admin of your organization approves Sidekick to read meeting and call transcripts, once for the whole organization, and allows Sidekick in Teams' meeting settings, including turning on **Transcript API access** (Microsoft Graph access to transcripts, off by default in new Microsoft 365 organizations). Your IT team has the exact steps from the Sidekick team.
3. Make sure Teams records transcripts for your meetings (Teams meeting policy: transcription on). Sidekick can only write notes for meetings that have a transcript.
4. On **Meetings**, press **Turn on** under *Automatic notes after Teams meetings*.

Sidekick then checks for new meetings straight away. With everything approved, new meetings usually arrive within minutes of ending (otherwise at the latest every 15 minutes). **Check now** looks again immediately. **Turn off** stops new meetings from being captured; meetings already captured stay.

If something is missing (for example the transcript permission isn't approved yet), the panel says so in plain words. Fix it and press **Check now**.

### Meet now in a group chat
Pressing **Meet now** (the camera button) inside a Teams group chat starts a call that Microsoft keeps apart from scheduled meetings. Sidekick picks those up too: turn on transcription during the call as usual, and when it ends the notes land in the group that chat is linked to and are posted to the group's notes chat. A call started in a chat that isn't linked to a group goes to the group whose people spoke in it (at least two of them), like a scheduled meeting.

Microsoft needs a separate approval for these calls (*Read all call transcripts*). If your organization approved Sidekick before October 2026, the Meetings page says *"approve the new call transcripts permission"*: a Microsoft admin presses **Users & access → Approve Sidekick for your organization** once more. Scheduled meetings keep working meanwhile, and calls from the last day are still picked up once it's approved.

### Which group a meeting goes to
Sidekick picks the group like this:
1. **The meeting's own chat**: if Sidekick was added to the meeting's chat (for example by adding the Sidekick tab to the meeting) and a Team Lead or admin assigned that chat to a group, the meeting goes to that group. For a **Meet now** call this is the group chat it was started from.
2. **Otherwise, the people**: the group with the most of its people in the meeting (the organizer and the invitees; for a Meet now call, who started it and who spoke), and at least two of them. People count once they've signed in to Sidekick with Microsoft at least once, or were imported from Microsoft 365.
3. **A tie**: if people from several groups were there equally, the meeting waits under **Pick a group** on the Meetings page. An Org Owner, Org Admin or the Team Lead of one of those groups picks it; a Team Lead only sees their own groups as choices.
4. **Nobody's meeting**: if it isn't a meeting of any group's people, Sidekick skips it and keeps nothing about it (not even its title).

If anyone from another Microsoft organization (a client guest) was in the meeting, it's marked **Client guests present**: its notes count as shareable, and notes from internal meetings are never posted to chats with client guests.

### Plan limits
Each captured meeting's length counts toward your plan's **meeting hours** this month, like an uploaded transcript. When the month's hours are used up, a meeting is **Skipped** with the reason (shown on the Meetings page and in the audit log); nothing extra is ever charged. Skipped meetings can be tried again by an Org Owner or Org Admin with **Try again**, for example after adding hours. The same applies when the AI credit is used up (long meetings are skipped) or the plan is read-only.

### What you see on the Meetings page
- Captured meetings have a **Teams** tag, and the meeting page says *captured from Microsoft Teams*.
- The panel lists recent Teams meetings with their status: **Writing notes**, **Notes written**, **Pick a group**, **Skipped** (with the reason) or **Failed** (with **Try again**). Members see the meetings of their own groups; Org Owners, Org Admins and Team Leads also see skipped ones and the ones waiting for a group.

## Add a past or outside meeting
**Meetings → Add a past or outside meeting.** Upload the transcript (a Teams `.vtt` file, a Word file, or paste the text), give it a title and date, and tick **Client guests attended** if the client was there. Notes are usually ready in 20–60 seconds.

In Teams you download a past meeting's transcript from the meeting's **Recap → Transcript → Download**.

Limits: files up to 25 MB and up to 300,000 characters of transcript (about five hours of talk); split longer meetings into parts. If writing the notes fails, the meeting is still saved with **Try again**: don't add it twice.

## The notes chat in Teams
Many teams have more than one chat for an engagement (say, one for the core team and one with the client), so the group's **Team Lead** chooses where meeting notes go. Open the group (**Groups**, then its card) → **Teams chats** → **Meeting notes go to**:
- tick **one chat** (the usual choice) or several, or
- **Don't post notes in Teams**: notes then stay on the Meetings page in Sidekick.

Then **Save choice** (or **Save** once a choice exists). Org Owners and Org Admins can choose for any group; Members and Viewers see the same list read-only. Every change is in the audit log.

Only the group's own linked chats are listed, never anyone's other Teams chats. If a group has **six or more** chats, a search box appears and each chat shows how many people are in it and when it was last active, so similar chats are easy to tell apart.

**Send test message** (next to each chat, for the Team Lead and admins) posts a small card in that chat: "👋 This is where *group*'s meeting notes will go (sent from the Sidekick portal by *you*)". Use it to check you've picked the right chat. Each chat takes one test message a minute; if Teams refuses the post (for example, Sidekick was removed from that chat), the portal says why.

**From the chat itself**: in one of the group's chats, the Team Lead (or an Org Owner or Org Admin) can type:

> @Sidekick post meeting notes here
>
> @Sidekick stop posting notes here

Close variants work too ("notes here", "send meeting notes here", "don't post notes here"). Sidekick replies "Done ✓ Meeting notes for *group* will be posted here." **Post here** adds this chat to the chats already chosen; **stop** takes it off (if no chat is left, notes stay in the portal). Anyone else gets "Only the Team Lead or an admin can change where notes go." Sidekick has to recognise you: sign in to the portal with Microsoft once. Changes made in Teams are in the audit log with "(from Teams)".

Chats with **client guests** are marked: only notes from meetings the client attended go there. That holds when you choose the chat from Teams too: Sidekick accepts and explains that internal meetings' notes never go there. Notes from internal meetings never go to a chat with client guests, whatever is ticked.

**Before anyone chooses**, notes go to **one** chat only: a chat with "notes" in its name if there is one, otherwise the group's first chat without client guests. A group with two or more chats and no choice yet shows **Pick which chat gets meeting notes** under *Needs attention* for its Team Lead, with a button to the Teams chats tab. (Groups that had switched notes off in some chats before this choice existed keep that: the chats that still had notes on are the chosen ones.)

After each meeting Sidekick posts to the chosen chat(s):
1. a **notes card**: summary, the decisions and things to keep, and questions still open, with **Open in Sidekick**. Its last line says where the notes were posted ("Notes posted to Core team only."); in a chat with client guests it only names other client chats;
2. one **card per action item**, with **Assign** and **Mark done**.

The Teams chats tab also shows where the latest meeting's notes went. A group without any Teams chat shows up under *Needs attention* so its Team Lead can add one.

## Save to knowledge
Decisions, requirements, risks, facts and terms from a meeting can be **saved to the group's knowledge**:
- in Teams, with **Save to knowledge** next to each one on the notes card (the card then shows who saved it, with **Undo**);
- in the portal, on the meeting's page or in the Teams tab, with **Save to knowledge** next to each one.

A saved item becomes lasting knowledge: answers find it first, long after the meeting, and it's marked *Saved* with who saved it. **Remove from knowledge** undoes it. Members, Team Leads and admins can save; Viewers can't. Open questions and decisions still to make can't be saved (they're temporary).

## Sidekick in the Teams app bar and as a tab
Sidekick also works as a Teams app with a **Meetings** tab:
- **In the Teams app bar** (left side), open Sidekick → **Meetings**: your groups' recent meetings, their notes, and the open action items. Switch groups at the top.
- **As a tab in a chat, channel or meeting**: add Sidekick with **+** at the top of the chat or meeting. The tab opens on the group linked to that chat. Adding it to a meeting also brings Sidekick into the meeting's chat, so it can be assigned to the group and that group gets the meeting's notes.

You're signed in automatically with your Microsoft account (Teams single sign-on). You see only the groups you belong to, and can mark action items done and save things to knowledge with your own role. If the tab says you don't have an account yet, ask your Sidekick admin to add you, then sign in to the Sidekick portal with Microsoft once.

<!-- help-center:skip -->
For developers: lib/meetings-graph.ts (capture), lib/notes-chats.ts ("Meeting notes go to", the Teams command), lib/notes-chat-rules.ts (default chat, command words), /api/workspaces/:id/notes-chats/test (test message), lib/saved-items.ts (Save to knowledge), lib/teams/tab.ts (tab); tests in app/tests/meetings-graph.test.mjs. Microsoft setup steps for Cody: docs/RUNBOOKS.md → Automatic meeting notes.
<!-- /help-center:skip -->
