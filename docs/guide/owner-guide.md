# Owner Console guide

For the **Sidekick operator** (whoever runs Sidekick as a service), not for client users. The console lives at `/owner` and has its own sign-in, separate from every client account.

## First sign-in
The first owner account can only be created **on the machine running Sidekick** (open `http://localhost:3000/owner`). After that, sign in at `/owner/login`. Owner sessions last 12 hours. Owner passwords need at least 12 characters and must not be one from a known data breach (use a different password from your client login); after 5 wrong passwords for one email (or 20 from one network address) in 15 minutes, owner sign-in waits 15 minutes, and failures show in the operator log.

**Security** (in the menu): change the owner password (signs out your other browsers) and turn on **two-step sign-in** with a passkey or an authenticator app, exactly like a client's Settings page. Strongly recommended: the console sees every client. Save the backup codes in your password manager.

**Lost the owner password, or a client's Org Owner is locked out?** Run the reset command on the Mac (`docs/RUNBOOKS.md` → Locked out). It prints a one-time password in your terminal only; signing in with it asks for a new password first. Lost the phone too? Add `--reset-2fa` to remove two-step sign-in from that account.

The portal's own first-run setup (the very first organization on an empty install) is also localhost-only. Every organization after that is added here with **Add a client**: nobody inside a client organization can create one, and the home assistant can't either.

## Pages
| Page | Shows |
|---|---|
| **Overview** | AI spend (today, this month, projected), number of clients, error rate, response time, spend per day and per client, latest errors |
| **Clients** | Every client organization: users, workspaces, meetings, documents, monthly spend, errors. **Add a client** creates the organization and its Org Owner with a one-time password (shown once). **Pause / Resume** turns a client's access off or on. Click a client's name for its own page (below) |
| **Performance & errors** | Typical and slowest response times, error rates and prompt-cache savings per feature and model; failed AI requests; processing health per client; **App errors**: every unexpected problem with the **reference code** the person saw, so you can look up a code a client sends you |
| **Releases & switches** | Running version and commit, models in use, **kill switches**, operator log |

## Kill switches
Each switch pauses one AI feature **for every client at once**: answering questions, meeting notes, knowledge map, the in-app assistant, the **guardrail check**, document uploads, or **reminders in Teams** (daily and after-meeting reminder cards). Pausing the guardrail check also stops answers (Sidekick never answers a question it hasn't checked). Use it during an incident or a cost spike. Clients see a friendly "paused by the Sidekick team" message, and Sidekick stops answering in Teams for that feature. A pause is a deliberate refusal: it isn't listed under App errors and doesn't count as a Claude error. Every flip is recorded in the operator log.

## One client's page
Click a client on **Clients** to see:
- **People**: everyone in that organization with their role, the workspaces they can use ("All workspaces" for Org Owners and Org Admins), whether they sign in with Microsoft or a password, and when they were last active.
- **Workspaces**: each one with its number of members, documents and meetings.
- **Restrictions for this client**: the same switches as the kill switches, but for **this client only**, for example turning off the in-app assistant or document uploads for one organization. Their people see a calm notice (not an error dialog): "… is turned off for your organization by the Sidekick team", with "contact the Sidekick team" for their Org Owner and "ask your Org Owner" for everyone else. It isn't listed under App errors and doesn't count as a Claude error. A feature paused for everyone stays off whatever this switch says.

Opening the page is recorded in the operator log once per visit ("Viewed the people and workspaces of …"; flipping switches on the page doesn't add more), and each restriction is recorded in both the operator log and the client's own audit log. The page shows names and counts only, never document or meeting content.

People, roles and workspace access are still managed by the client's own Org Owner or Org Admin on **Users & access**.

## Pausing a client
A paused organization can't use the portal or any feature, and Sidekick stops answering in its Teams channels. Its data is kept and comes back as it was on **Resume**.

## What owners can't do
Owners see usage, health, counts and who belongs to each client, but the console has no way to sign in as a client user or read a client's documents.
