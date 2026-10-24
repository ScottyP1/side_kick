# Meetings and automatic notes

Sidekick writes the notes for your group's meetings: a short summary, the **decisions**, **action items** (with owners and dates as spoken), **open questions**, and lasting facts like requirements, risks and terms. Notes land in the right group in the portal, are posted to the group's notes chat in Teams, and answers can use them straight away.

There are two ways meetings get to Sidekick:
- **Automatic notes after Teams meetings**: when a Teams meeting of a group's people ends, Sidekick reads its transcript and writes the notes by itself. No bot joins the call.
- **Add a past or outside meeting**: upload a transcript yourself, for meetings held before automatic notes were on, or outside Teams.

## Automatic notes after Teams meetings

### Turning it on (Org Owners and Org Admins)
1. Connect Sidekick to your Microsoft 365 organization: **Settings → Microsoft sign-in**.
2. A Microsoft admin of your organization approves Sidekick to read meeting transcripts, once for the whole organization, and allows Sidekick in Teams' meeting settings. Your IT team has the exact steps from the Sidekick team.
3. Make sure Teams records transcripts for your meetings (Teams meeting policy: transcription on). Sidekick can only write notes for meetings that have a transcript.
4. On **Meetings**, press **Turn on** under *Automatic notes after Teams meetings*.

Sidekick then checks for new meetings straight away. With everything approved, new meetings usually arrive within minutes of ending (otherwise at the latest every 15 minutes). **Check now** looks again immediately. **Turn off** stops new meetings from being captured; meetings already captured stay.

If something is missing (for example the transcript permission isn't approved yet), the panel says so in plain words. Fix it and press **Check now**.

### Which group a meeting goes to
Sidekick picks the group like this:
1. **The meeting's own chat**: if Sidekick was added to the meeting's chat (for example by adding the Sidekick tab to the meeting) and a Team Lead or admin assigned that chat to a group, the meeting goes to that group.
2. **Otherwise, the people**: the group with the most of its people in the meeting (the organizer and the invitees), and at least two of them. People count once they've signed in to Sidekick with Microsoft at least once, or were imported from Microsoft 365.
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
Each group can have a **notes chat**: a Teams chat or channel linked to the group with *meeting notes* switched on (the default for a linked chat; change it on the group's page under Teams chats). After each meeting Sidekick posts there:
1. a **notes card**: summary, the decisions and things to keep, and questions still open, with **Open in Sidekick**;
2. one **card per action item**, with **Assign** and **Mark done**.

A group without a notes chat shows up under *Needs attention* so its Team Lead can add one.

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
For developers: lib/meetings-graph.ts (capture), lib/saved-items.ts (Save to knowledge), lib/teams/tab.ts (tab); tests in app/tests/meetings-graph.test.mjs. Microsoft setup steps for Cody: docs/RUNBOOKS.md → Automatic meeting notes.
<!-- /help-center:skip -->
