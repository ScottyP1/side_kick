/**
 * The private logins guide for the demo world (scripts/seed-demo.mjs writes it after seeding): how to start the
 * seeded local copy, then one sign-in per role with the groups that person is in and 3-5 things to try that show
 * what the role can and can't do. It holds test passwords, so it is only ever written to git-ignored or
 * outside-the-repo files (chmod 600) and never printed. Who calls this: only scripts/seed-demo.mjs.
 */
import { NORTHWIND, OPERATOR, OTHER_ORGS, PROFILES, emailAt } from "./demo-world.mjs";

const group = (key) => PROFILES.find((p) => p.key === key).name;

/**
 * The guide as Markdown. `passwords` = the generated passwords by login key, `people` = Northwind's login people
 * by key (name, email, groups), `postgres` = the demo database URL when seeded on Postgres, `dataDir` = the SQLite
 * data folder relative to app/.
 */
export function loginsGuide({ passwords, people, postgres, dataDir }) {
  const tail = OTHER_ORGS.find((o) => o.key === "tailspin");
  const p = (k) => people[k];
  const row = (title, name, email, pw, where, tries) => `## ${title}

| | |
|---|---|
| Name | ${name} |
| Email | \`${email}\` |
| Password | \`${pw}\` |
| Where | ${where} |

Things to try:
${tries.map((t) => `- ${t}`).join("\n")}
`;
  return `# Sidekick demo world: logins (LOCAL ONLY)

> **Local test copy only, not the live site.** These accounts exist only in the throwaway demo copy on this Mac
> (${postgres ? `Postgres database \`${postgres}\`` : `data folder \`app/${dataDir}\``}). They don't work on the live site, and every company and person in it is made up.
> Keep this file private: it holds test passwords. Re-seeding keeps the same passwords.

## Start the demo copy

All commands run in the repo folder (\`~/Desktop/sidekick\`, once the demo-world PR is merged; until then its worktree).

1. Seed it (once, or again to reset it to the start):
   \`npm --prefix app run seed:demo\`${postgres ? ` (this copy was seeded on Postgres: \`npm --prefix app run seed:demo -- --postgres ${postgres}\`)` : ""}
2. Start it: in Claude Code, preview \`sidekick-demo\`${postgres ? "-pg" : ""} (from \`.claude/launch.json\`), or in a terminal:
   \`cd app && env AZURE_SEARCH_ENDPOINT= AZURE_SEARCH_API_KEY= AZURE_OPENAI_ENDPOINT= AZURE_OPENAI_API_KEY= CLIENT_ID= CLIENT_SECRET= ENTRA_CLIENT_ID= ENTRA_CLIENT_SECRET= DATABASE_URL=${postgres ?? ""} TENANT_ID=00000000-demo-4000-8000-000000000001 SIDEKICK_PUBLIC_URL= SIDEKICK_SCHEDULER=off SIDEKICK_DATA_DIR=.demo-data NEXT_DIST_DIR=.next-demo SIDEKICK_FAKE_CLAUDE=1 ./node_modules/.bin/next dev --port 3330\`
3. Open **http://localhost:3330/login** (portal) or **http://localhost:3330/owner/login** (Owner Console).
   Use a private window per person, or sign out in between: the portal and the Owner Console have separate sign-ins,
   but two portal people in one browser replace each other.

Answers come from **fake Claude** (short "Test answer…" replies) unless you start the copy without
\`SIDEKICK_FAKE_CLAUDE=1\` (then your key in \`app/.env.local\` is used and it costs money). The seeded notes, answers in
the history and knowledge maps are realistic either way. Teams posts from the demo copy go to a fake Teams
(started with the demo copy), so they succeed like in a working tenant.

${row("Owner Console operator (the Sidekick team)", OPERATOR.name, OPERATOR.email, passwords.operator, "Owner Console, every client organization (never their documents)", [
  "**Business**: MRR and margin by plan, the trial ending in 4 days (Trey Research), the failed payment (Lucerne Partners), Northwind at ~68% of its AI credit (~84% after `seed:demo -- --credit-banner`).",
  "**Clients → Northwind Consulting**: people, groups, documents and meetings as counts only. You can't open a document or read a meeting: the console never sees client content.",
  "**Clients → Tailspin Partners**: the Knowledge map is switched off for this client only (a restriction), and it is at 14 of 15 people on Starter.",
  "**Support inbox**: four Northwind tickets and one from Tailspin, with replies, an internal note (only the team sees it) and one from the public website form. Reply to one and see it on the customer's Help & support page.",
  "**Roll-offs**: Alpine Ski House's group is Ending (deleted in 21 days); extend it or download a certificate later.",
])}
${row("Org Owner (runs the whole organization)", p("orgOwner").name, p("orgOwner").email, passwords.orgOwner, `${NORTHWIND.org}: every group (${PROFILES.length})`, [
  "**Groups**: all ten engagements with Team Leads and health labels; Alpine Ski House shows **Ending**. Open Contoso and look at Overview, People, Teams chats (one with client guests) and Documents.",
  "**Guardrails**: only you can flip the company-wide switches. The Fabrikam Bank group has extra switches and a custom rule (\"Never quote card numbers…\").",
  "**Usage & billing**: Business plan in test mode, usage per group (the 80% AI credit notice only after `seed:demo -- --credit-banner`), Export CSV. You can change or cancel the plan.",
  "**Settings → Two-step sign-in for everyone**: only you can switch it on (an Org Admin sees \"Only the Org Owner can change this\").",
  "**Memory & gaps** (Contoso): the runbook still says November 5 but the cutover moved to November 12 (an \"Out of date\" gap), and 48 vs 52 stores.",
])}
${row("Org Admin (runs people, groups and Teams day to day)", p("orgAdmin").name, p("orgAdmin").email, passwords.orgAdmin, `${NORTHWIND.org}: every group`, [
  "**Users & access**: ~115 people; change someone's role, add a person, take someone off. Nobody can be made Org Owner here, and the Org Owner can't be changed.",
  "**New group**: pick a client, a Team Lead and members in one go.",
  "**Firm library**: add or replace a policy (Expense policy v3 replaced v2).",
  "**Guardrails**: you can make a group stricter and write custom rules; the company-wide switches show as On/Off only (\"Set by your Org Owner\").",
  "**Activity** and **Security & audit**: traces from the seeding, sign-ins, every change.",
  "**Usage & billing**: what Sidekick did for the whole company (counts), the AI allowance as a percentage, the plan and the 80% notice (no AI cost or models); only the Org Owner can pay or change the plan (\"Only the Org Owner can…\"). Hannah Brooks, another Org Admin, looks after billing and has the invoice PO ticket.",
])}
${row("Team Lead (runs the people side of their group)", p("teamLead").name, p("teamLead").email, passwords.teamLead, group("contoso"), [
  "**Groups → Contoso**: your one group; People tab shows emails (you manage it). Add a Member or Viewer; you can't add an Org Admin or take yourself off.",
  "**Users & access**: only the people in your group, and only the Member and Viewer roles.",
  "**Groups → Contoso → Overview**: the **Last 30 days** card (questions, answers, meetings, documents, Contoso's share of the AI use; no prices) and the **Sources** line. Opening another group's numbers by address says \"not found\".",
  "**Teams chats** tab: two linked chats (one with client guests: answers there use only Shareable documents). Change reminders for the team chat.",
  "**Meetings**: eight Contoso meetings with notes, decisions and action items; mark an item Done.",
  "**Connectors** is in your menu (link a tool's project to Contoso); **Usage & billing**, **Guardrails**, **Activity** aren't (typing the address shows who can use it).",
])}
${row("Member (does the client work)", p("member").name, p("member").email, passwords.member, `${group("contoso")} and ${group("litware")}`, [
  "Top bar: switch between your two groups; you never see the other eight.",
  "**Knowledge & docs**: upload a document, ask a question, rate an answer 👍/👎.",
  "**Meetings**: import \`samples/Contoso - Sprint 14 planning.vtt\` again, or update an action item.",
  "Your menu has only the client-work pages plus Settings (**My account**: password, two-step, sessions) and Help. No Users & access, Connectors or Guardrails; the Groups page has no New group button.",
  "**Groups → Contoso**: the **Sources** line shows which tools feed it. **Help & support → Rules Sidekick follows**: the locked rules and your organization's switches, On/Off.",
  "**Help & support → My tickets**: your resolved ticket about a long transcript.",
])}
${row("Viewer (reads and asks, changes nothing)", p("viewer").name, p("viewer").email, passwords.viewer, `${group("contoso")} and ${group("fabrikam")}`, [
  "**Knowledge & docs**: ask questions and rate answers, but there's no Upload button.",
  "**Meetings**: read the notes; no Import button, and action items can't be changed.",
  "**Memory & gaps**: see the gaps, but you can't resolve or assign them.",
  "In the Fabrikam Bank group, small talk and competitor questions are refused (that group's extra guardrails).",
])}
${row("Org Owner of a second client (Tailspin Partners, Starter)", tail.owner.name, emailAt(tail.owner.name, tail.domain), passwords.tailspinOwner, `${tail.org}: ${tail.group.name}`, [
  "Only Tailspin's own group and people: Northwind doesn't exist from here.",
  "**Users & access → Add person**: one more is fine, the next one hits the Starter limit (15 people) with the price of an extra group or an upgrade.",
  "**Groups → New group**: refused at 1 of 1 group, with both options and prices.",
  "**Users & access → make someone Team Lead**: refused, because Team Leads come with the Team plan and up (the message names the plan and price).",
  "**Memory & gaps → Build knowledge map**: refused, because the Sidekick team turned the knowledge map off for this organization (the message says so).",
])}
## Everyone else

The other ~110 Northwind people (and the other client organizations' people) have random passwords nobody knows;
sign in as one of the accounts above. To try someone else, an Org Owner or Org Admin can add a new person on
Users & access and use the temporary password it shows.
`;
}
