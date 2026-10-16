# Admin guide

For **Org Owners** and **Org Admins**: everything needed to set Sidekick up for your organization and keep it running. New to the terms? Read [Concepts](concepts.md) first.

## 1. First sign-in
The first person to open a new Sidekick install sets up the organization and becomes its **Org Owner**. If the Sidekick team onboarded you, sign in with the temporary password they gave you; you'll be asked to choose your own.

## 2. Create workspaces
**Workspaces → New workspace.** Create one per client engagement, e.g. "Contoso Retail – Cloud Migration", with an optional engagement code. You're added as a member automatically.

## 3. Add people
**Users & access → Add a person.** Pick their role and the workspaces they can see. Sidekick shows a **temporary password once**: share it with them privately; they must change it at first sign-in. Change roles or workspaces at any time from the same page. (In production people sign in with their Microsoft account instead.)

## 4. Add documents
**Knowledge & docs**, in the workspace you want. Drop in PDF, Word (.docx), text, Markdown, CSV or JSON files, up to 25 MB each. Tag each one:
- **Internal** for team-only material.
- **Shareable** for anything fine to use in front of the client.

You can change the tag later; it takes effect immediately.

## 5. Import meetings
**Meetings → Import transcript.** Upload the Teams transcript (`.vtt`), a Word file or paste the text, give it a title and date, and tick **Client guests attended** if the client was there. Notes are ready in about 15–30 seconds. If processing fails (for example, Sidekick was paused), open the meeting and choose **Try again**.

If the workspace has linked Teams channels, Sidekick posts the notes and action items there automatically.

## 6. Link Teams channels
See [Sidekick in Teams](teams-guide.md) for what people see. To link:
1. Someone adds Sidekick to the Teams channel or chat and mentions it (`@Sidekick link`).
2. Sidekick replies with an 8-character code, valid for 24 hours.
3. In the portal: **Workspaces → Link Teams channel**, enter the code, pick the workspace.
4. Tick **Client guests are in this channel** if the client can read it.

The **Teams channels and chats** table on the Workspaces page shows every link. Use the switch to change the client-guests setting, or **Unlink** to stop Sidekick answering and posting there.

## 7. Keep knowledge healthy
**Memory & gaps → Refresh knowledge map** after adding material (Members and Admins can; Viewers and Billing Admins can't, since each refresh is a paid AI request). Work through the gaps: upload the missing document, or assign the gap to someone. Track action items in the same place.

## 8. Watch usage and activity
- **Usage & billing**: AI cost by feature, workspace and day (also open to Billing Admins).
- **Security & audit**: who did what and when, including everything Sidekick did on its own.

## 9. See what Sidekick is doing (Activity)
- **Home → Sidekick live:** a live picture of Sidekick and its connections (Teams, Claude, search, database) with their health, and who's active.
- **Govern → Activity:** every request from the portal and Teams. **Traces** shows each one step by step (how long search, Claude and Teams delivery took, and why something failed, with its reference code). **Messages** lists what people asked and whether Sidekick found the answer. Kept for 30 days; no document text is stored.

## 10. Use the assistant for quick admin jobs
On the home page, type requests like "create a workspace for Fabrikam, code FAB", "add Maria Chen maria@fabrikam.example as a Member of Fabrikam" or "link Teams code K7Q2 to Fabrikam". Sidekick shows a card with the details; check them and press **Confirm**. When adding a person, the card shows their temporary password once: send it to them privately. If a detail is missing, the assistant asks for it first.

## 11. Branding
**Settings**: upload your logo and pick a brand color. They're applied across the portal.

## Troubleshooting
| You see | What to do |
|---|---|
| A dialog "Something went wrong on our side" with a reference code | It's on Sidekick's side, not yours. Try again; if it repeats, click **Copy details** and send it (with the reference code) to the Sidekick team. |
| A dialog "Can't reach Sidekick" | Your connection or Sidekick is down. Anything you saved is safe; try again in a minute. |
| "This page hit a problem" | Click **Try again**, or use the menu. If it repeats, send the reference code to the Sidekick team. |
| "Claude isn't connected yet" | The Sidekick team needs to configure the AI key. Contact them. |
| "… is paused by the Sidekick team" | A feature was paused for maintenance. Try again later. |
| "This organization's Sidekick access is paused" | Contact the Sidekick team. |
| A Teams link code doesn't work | Codes expire after 24 hours. Mention `@Sidekick link` in Teams for a new one. |
| Sidekick answers "I couldn't find that" | The workspace doesn't have it yet. Upload the document; the question is already listed as a gap. |
