# Owner Console guide

For the **Sidekick operator** (whoever runs Sidekick as a service), not for client users. The console lives at `/owner` and has its own sign-in, separate from every client account.

## First sign-in
The first owner account is created once, at `/owner/setup`:
- **On a laptop:** open `http://localhost:3000/owner` on the machine running Sidekick.
- **On the live site:** setup is off until you give the server a one-time **setup code**. Put a long random
  value (at least 16 characters) in the Container App secret `SIDEKICK_SETUP_CODE`, open `/owner/setup`,
  enter the code with your details, then **remove the secret** again. Without it, production refuses setup
  outright (the old "only from localhost" check trusted an address the caller can fake).

After that, sign in at `/owner/login`. Owner sessions last 12 hours. 5 wrong passwords for one owner email
(or 20 from one network address) in 15 minutes pause owner sign-in for 15 minutes, even with the right
password; failed sign-ins on real owner accounts and the pause are in the operator log (Releases & switches).

The portal's own first-run setup (the very first organization on an empty install) follows the same rule
(localhost on a laptop, the setup code in production). After that, organizations are created in two ways: **self-service sign-up** at `/signup` (a company signs itself up; **off until you open it**, see below), or **Add a client** here. Nobody inside a client organization can create another one, and the home assistant can't either.

## Pages
| Page | Shows |
|---|---|
| **Overview** | AI spend (today, this month, projected), number of clients, error rate, response time, spend per day and per client, latest errors |
| **Business** | Your one place to watch the business (no Azure dashboard needed): **MRR**, AI cost and **margin** (plan revenue minus AI cost) this month, **plan mix**, **trials ending** in the next 7 days, **failed payments**, **sign-ups per week** (12 weeks; darker = self-service), a table of every client with plan, **partner**, people, revenue, AI cost, margin, AI credit used and **Near / Over limit** flags, and **infrastructure health** (database, AI key, search, Teams bot, the running commit and release time, recent deploys seen, app errors in the last 24 hours with their reference codes) |
| **Clients** | Every client organization: its **plan** and subscription status ("Managed" = no self-service plan), users, workspaces, meetings, documents, monthly spend, errors. **Add a client** creates the organization and its Org Owner with a one-time password (shown once). **Pause / Resume** turns a client's access off or on. Click a client's name for its own page (below) |
| **Performance & errors** | Typical and slowest response times, error rates and prompt-cache savings per feature and model; failed AI requests; processing health per client; **App errors**: every unexpected problem with the **reference code** the person saw, so you can look up a code a client sends you |
| **Releases & switches** | Running version and commit, models in use, **kill switches** (including **Self-service sign-up**), operator log |

The console has its own dark graphite look with the Indigo accent (whatever your device's light/dark setting), so you never mistake it for a client's portal.

## Kill switches
Each switch pauses one AI feature **for every client at once**: answering questions, meeting notes, knowledge map, the in-app assistant, the **guardrail check**, document uploads, or **reminders in Teams** (daily and after-meeting reminder cards). Pausing the guardrail check also stops answers (Sidekick never answers a question it hasn't checked). Use it during an incident or a cost spike. Clients see a friendly "paused by the Sidekick team" message, and Sidekick stops answering in Teams for that feature. A pause is a deliberate refusal: it isn't listed under App errors and doesn't count as a Claude error. Every flip is recorded in the operator log.

## Self-service sign-up and plans
- **Sign-up switch (off by default)**: a fresh install or deploy **refuses self-service sign-up**, so strangers can't create organizations that use real Claude credit. `/signup` then shows "Sign-up isn't open yet" with a **Contact us** button, and `/pricing` shows the same note with **Contact us** instead of **Start free trial**. Open it with **Releases & switches → Self-service sign-up** (and close it the same way), or set `SIDEKICK_SIGNUP_OPEN=true` on the deploy. Once you've flipped the switch in the console, your choice wins over the setting. It's platform-wide only, so it doesn't appear among a client's restrictions. Each new sign-up is written to the operator log ("New organization … on the … plan").
- **Plans** (Starter, Team, Business; made-up per-person prices, defined in `app/src/lib/plans.ts`) and **payments are in test mode**: no money moves and no card details are ever collected.
- **Setting a client's plan**: on the client's page, **Plan** shows plan, status, people and workspaces against the limits, and who changed it last. Pick a plan and/or a status and **Save plan**. Statuses restart their dates: **Active** = paid for 30 days from now, **Free trial** = a new 14-day trial, **Payment failed** = the 7-day grace period starts now, **Canceled** = read-only at once. Use it to extend a trial, mark an invoice paid, or end access. Every change goes to the operator log and the client's audit log ("Sidekick team: Set the plan to …"). Setting a plan for a managed client (no plan yet) creates one.
- A client whose plan lapsed is **read-only** (they see everything, change nothing, Sidekick doesn't answer). That's different from **Pause**, which locks them out entirely.

## Plan limits, AI credit and plan terms
Plans and their limits live in one file, `app/src/lib/plans.ts` (Starter, Team, Business, **Enterprise**; numbers are placeholders): people, groups, tracked Teams chats, meeting hours per month, documents, connectors and a **monthly AI credit** in dollars. Clients hit a limit with a clear "your plan allows…" message; nothing is ever deleted when a limit is lowered (they see **Over limit**). See the admin guide, section 16, for what clients see.

**AI credit.** Each client's Claude cost this month is compared with its credit before every AI call. At 80% their Org Owner, Org Admins and Billing Admins get a banner (and one audit entry); at 100% the client goes to **essentials only**: answers and guardrail checks keep working on cheaper models (`SIDEKICK_MODEL_ESSENTIAL_ASK/_GUARD/_EXTRACT`, default Sonnet for answers and notes, Haiku for the check), shorter meetings still get notes, and reminders, knowledge map, assistant and long-meeting notes pause. You get an operator-log line ("… used up its AI credit"). Managed clients (no plan) have no credit limit unless you set one.

**On a client's page:**
- **Limits this month**: every limit with its use and Near / Over flags.
- **AI credit**: used of included (with top-ups), and **Add top-up**: a one-off amount for this month, with an optional note. The table below shows their AI use by feature **and model**: model names are shown only here, never in the client portal (clients see "AI answers: working").
- **Plan terms**: custom limits (leave empty for the plan's number, type "unlimited" for none), the **AI credit per month** override, the **contract price per month** (Enterprise and managed clients; it's their revenue in MRR and margin), the **partner or referrer** who brought them, and **questions per person per hour** (default 60). **Save plan terms**.
- **Plan**: you can also put a client on **Enterprise** (not offered to buyers). Enterprise starts from the Business limits until you set terms.
- **AI use by model** includes **Cached**: the share of input read from the prompt cache (cheaper). The stable part of each prompt (instructions and the client's guardrail rules) is cached; short prompts are below the model's minimum and won't show cache reads.

**AI running costs and resilience** (all in `app/src/lib/claude.ts`): busy or overloaded answers from Claude are retried with backoff (`SIDEKICK_CLAUDE_RETRIES`, default 3); after that people see "Sidekick's AI is very busy right now. Try again in a minute." Daily reminder digests go through Claude's **Batch API** at half price and are posted a few minutes later than before (`SIDEKICK_BATCH=off` makes them live again). Each feature's model stays configurable (`SIDEKICK_MODEL_*`); change one only after comparing answers. Claude Haiku 5.5 is the candidate for cheap jobs such as the guardrail check and reminder wording. Live meeting hours are an Enterprise-only limit, ready for when Sidekick can join calls.

Top-ups and terms are recorded in the operator log and the client's own audit log ("Sidekick team").

**Revenue rules (test-mode prices):** an active Starter/Team/Business plan = people × price per person; Enterprise and managed = the contract price you set; trials, failed payments and canceled plans = $0. Margin = revenue − this month's AI cost.

## One client's page
Click a client on **Clients** to see:
- **People**: everyone in that organization with their role, the workspaces they can use ("All workspaces" for Org Owners and Org Admins), whether they sign in with Microsoft or a password, and when they were last active.
- **Plan**: plan, status and the controls to change them (see above).
- **Limits this month**, **AI credit** (with top-ups and AI use by model) and **Plan terms** (see "Plan limits, AI credit and plan terms").
- **Workspaces**: each one with its number of members, documents and meetings.
- **Restrictions for this client**: the same switches as the kill switches, but for **this client only**, for example turning off the in-app assistant or document uploads for one organization. Their people see a calm notice (not an error dialog): "… is turned off for your organization by the Sidekick team", with "contact the Sidekick team" for their Org Owner and "ask your Org Owner" for everyone else. It isn't listed under App errors and doesn't count as a Claude error. A feature paused for everyone stays off whatever this switch says.

Opening the page is recorded in the operator log once per visit ("Viewed the people and workspaces of …"; flipping switches on the page doesn't add more), and each restriction is recorded in both the operator log and the client's own audit log. The page shows names and counts only, never document or meeting content.

People, roles and workspace access are still managed by the client's own Org Owner or Org Admin on **Users & access**.

## Pausing a client
A paused organization can't use the portal or any feature, and Sidekick stops answering in its Teams channels. Its data is kept and comes back as it was on **Resume**.

## What owners can't do
Owners see usage, health, counts and who belongs to each client, but the console has no way to sign in as a client user or read a client's documents.
