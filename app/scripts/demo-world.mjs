/**
 * The made-up demo world that `npm --prefix app run seed:demo` loads (scripts/seed-demo.mjs): who works where,
 * and everything the groups hold. Pure data and text generators, no I/O except reading `samples/`.
 *
 * Concepts
 * - **Northwind Consulting** (Business plan) is the main client organization: ~115 people in every role and ten
 *   groups, one per client engagement. Every company and person is invented (Microsoft's sample company names:
 *   Contoso, Fabrikam, Litware, Tailwind Traders, Adatum, Woodgrove, Wide World Importers, Alpine Ski House,
 *   Coho Winery, Fourth Coffee). Nothing comes from Accenture or a real client.
 * - **Contoso Retail – Cloud Migration** reuses the hand-written sample engagement in `samples/contoso/` (its planted
 *   conflicts are documented there). The other nine engagements are generated from a short **profile** each
 *   (`PROFILES`): the same five-meeting arc (kickoff, internal design review, weekly client status where a date
 *   moves, standup, steering), documents (SOW, runbook still showing the old date, RAID log, architecture, status
 *   report, internal staffing note, glossary) and a tracked Teams chat, worded from the profile so each reads differently.
 * - Each generated meeting comes with the **notes** a good model would write (summary, decisions, action items with
 *   owners and dates, open questions, decisions still to make, facts and risks). With fake Claude (the default) the
 *   seed writes these in place of the canned test notes, so the demo reads like real work.
 * - Small **other organizations** (Tailspin Partners near its Starter limits, a trial, a failed payment) give the
 *   Owner Console several clients to compare.
 * - Deterministic: the same people, emails and texts on every run (a fixed-seed random generator); only the
 *   passwords are random (scripts/seed-demo.mjs keeps them between runs).
 *
 * Who calls this: only scripts/seed-demo.mjs (and its test). Never the app.
 */
import fs from "node:fs";
import path from "node:path";

const SAMPLES = path.resolve(import.meta.dirname, "../../samples");

/** The date the demo world treats as "today" for its stories (meetings, chats). Usage history uses the real clock. */
export const WORLD_TODAY = "2026-10-22";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

/** A fixed-seed random number generator (mulberry32), so every run builds the same world. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `YYYY-MM-DD` plus `n` days. */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** "November 19" for 2026-11-19. */
export const spoken = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
/** "Thursday" for 2026-11-19. */
export const weekday = (day) => WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
/** "Nov 19" for 2026-11-19 (how people write due dates). */
const short = (day) => `${MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3)} ${Number(day.slice(8, 10))}`;
const first = (name) => name.replace(/^Dr\. /, "").split(" ")[0];
/** first.last, lower case, accents removed (Tomás → tomas). */
const localPart = (name) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^Dr\. /, "").toLowerCase().replace(/[^a-z ]/g, "").trim().replace(/\s+/g, ".");

/* ------------------------------------------------------------------ */
/* People                                                              */
/* ------------------------------------------------------------------ */

export const NORTHWIND = { org: "Northwind Consulting", domain: "northwind.example" };

/** The accounts the logins file lists (one per role), by key. Their passwords are kept between runs. */
export const LOGIN_KEYS = ["operator", "orgOwner", "orgAdmin", "teamLead", "member", "viewer", "tailspinOwner"];

/** The Owner Console (Sidekick team) account: not part of any organization. */
export const OPERATOR = { key: "operator", name: "Demo Operator", email: "operator@sidekick-demo.example" };

const FIRST = [
  "Aaron", "Abigail", "Adrian", "Alicia", "Amir", "Ana", "Andre", "Bianca", "Brandon", "Camila", "Carlos", "Chen", "Chiara", "Connor",
  "Daria", "David", "Diego", "Elif", "Emeka", "Emily", "Fatima", "Felix", "Gabriel", "Hana", "Hugo", "Imani", "Isaac", "Jasmine",
  "Javier", "Jin", "Julia", "Kai", "Kamala", "Keiko", "Liam", "Lucas", "Mai", "Malik", "Maya", "Mei", "Mohammed", "Nadia", "Naomi",
  "Nikhil", "Noah", "Olu", "Paolo", "Rhea", "Rosa", "Ruben", "Sana", "Santiago", "Sara", "Simone", "Sofia", "Tariq", "Theo", "Uma",
  "Valentina", "Wei", "Yara", "Yusuf", "Zainab", "Zoe",
];
const LAST = [
  "Abara", "Achebe", "Alvarez", "Andersen", "Banerjee", "Bauer", "Bianchi", "Campbell", "Castillo", "Cohen", "Costa", "Dang", "Das",
  "Delgado", "Dimitrov", "Eriksen", "Farouk", "Fischer", "Flores", "Gallagher", "Garcia", "Gupta", "Haddad", "Hansen", "Hoang", "Hughes",
  "Ibrahim", "Ito", "Jansen", "Johansson", "Kapoor", "Kaur", "Kowalski", "Kruger", "Larsen", "Liu", "Lopez", "Mahmoud", "Martins",
  "Mensah", "Moreau", "Murphy", "Nakamura", "Novak", "Nwosu", "Oyelaran", "Pereira", "Petrov", "Quinn", "Reddy", "Reyes", "Romano",
  "Saito", "Santos", "Schmidt", "Shah", "Sorensen", "Takahashi", "Torres", "Vargas", "Weber", "Yamamoto", "Zhang", "Zielinski",
];

/**
 * Northwind's people. Fixed, named people first (the ones the logins file and the Contoso sample use), then
 * generated Members and Viewers. `groups` lists group keys (empty for Org Owner/Admins: they see every group).
 * Team Leads are created as Members and become Team Leads when an admin picks them as a group's lead (the real path).
 */
export function northwindPeople() {
  const people = [];
  const add = (name, role, groups = [], key = null) => {
    people.push({ key, name, email: `${localPart(name)}@${NORTHWIND.domain}`, role, groups });
  };
  add("Olivia Bennett", "Org Owner", [], "orgOwner");
  add("Marcus Lee", "Org Admin", [], "orgAdmin");
  add("Aisha Khan", "Org Admin");
  add("Tomás Silva", "Org Admin");
  // Hannah is the Org Admin who looks after billing (the plan, invoices, the AI credit): only Org Owners and Org Admins
  // see Usage & billing, and only Olivia (the Org Owner) pays or changes the plan.
  add("Hannah Brooks", "Org Admin", [], "financeAdmin");
  // Team Leads, one per group (Priya leads the Contoso sample engagement).
  for (const p of PROFILES) add(p.lead, "Team Lead", [p.key], p.key === "contoso" ? "teamLead" : null);
  // The Contoso sample team (Maria is the Member login and also helps on Litware).
  add("Sam Okafor", "Member", ["contoso"]);
  add("Maria Chen", "Member", ["contoso", "litware"], "member");
  add("Dev Patel", "Member", ["contoso"]);
  // The Viewer login: a partner who reads two engagements.
  add("Ethan Wright", "Viewer", ["contoso", "fabrikam"], "viewer");
  // Each generated profile's named core team.
  for (const p of PROFILES) for (const n of p.team ?? []) add(n, "Member", [p.key]);

  // Generated Members and Viewers, spread over the groups; every 6th Member is on two groups.
  const r = rng(20261022);
  const taken = new Set(people.map((p) => p.name));
  const keys = PROFILES.map((p) => p.key);
  let i = 0;
  const fresh = () => {
    for (;;) {
      const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
      if (!taken.has(name)) {
        taken.add(name);
        return name;
      }
    }
  };
  const members = people.filter((p) => p.role === "Member").length;
  for (let n = members; n < 80; n++, i++) {
    const g = [keys[i % keys.length]];
    if (i % 6 === 5) g.push(keys[(i + 3) % keys.length]);
    add(fresh(), "Member", g);
  }
  const viewers = people.filter((p) => p.role === "Viewer").length;
  for (let n = viewers; n < 20; n++, i++) add(fresh(), "Viewer", [keys[(i * 7) % keys.length]]);
  return people;
}

/**
 * The smaller client organizations shown next to Northwind in the Owner Console. `plan`/`status` are set through the
 * Owner Console's billing route; `createdDaysAgo` backdates the organization for the business view's sign-up history.
 */
export const OTHER_ORGS = [
  {
    key: "tailspin", org: "Tailspin Partners", domain: "tailspin.example", plan: "starter", status: "active", createdDaysAgo: 38,
    owner: { key: "tailspinOwner", name: "Grace Kim" },
    // 14 of the Starter plan's 15 people and its 1 group: one more person or group hits the limit.
    people: ["Leo Park", "Mira Novak", "Owen Brandt", "Priyanka Iyer", "Quentin Ash", "Rafael Ortega", "Selma Yilmaz", "Tobias Klein", "Ursula Grant", "Vikram Joshi", "Wendy Cho"],
    viewers: 2,
    group: { key: "proseware", name: "Proseware – CRM Rollout", client: "Proseware", code: "PRW-CRM-26" },
    restrict: "insights", // the Owner Console turned the knowledge map off for this client
  },
  {
    key: "trey", org: "Trey Research Group", domain: "treyresearch.example", plan: "team", status: "trialing", createdDaysAgo: 10,
    owner: { name: "Nora Whitfield" }, people: ["Isaac Moreno", "Julia Banks"], viewers: 0,
    group: { key: "trey", name: "Margie's Travel – Booking Analytics", client: "Margie's Travel", code: "MTB-26" },
  },
  {
    key: "lucerne", org: "Lucerne Partners", domain: "lucerne.example", plan: "starter", status: "past_due", createdDaysAgo: 94,
    owner: { name: "Felix Hartmann" }, people: ["Greta Lind", "Hamid Rahimi", "Ivy Sutton"], viewers: 1,
    group: { key: "lucerne", name: "Lucerne Publishing – Content Hub", client: "Lucerne Publishing", code: "LUC-HUB-26" },
  },
];

/** Email for a person of another organization. */
export const emailAt = (name, domain) => `${localPart(name)}@${domain}`;

/* ------------------------------------------------------------------ */
/* Engagement profiles                                                 */
/* ------------------------------------------------------------------ */

/**
 * One profile per Northwind group. `sample: true` is the hand-written Contoso engagement (samples/contoso). For the
 * others: `team` = architect, engineer, analyst (named in meetings), `clients` = two client people (guests in client
 * meetings), `start` = kickoff day, `milestone` = the date that moves in the weekly status (old → new; the runbook keeps
 * the old one: an "Out of date" gap), `scope` = a number the SOW states that a client asks to change (a "Conflicting
 * information" gap). `ending: true` = the engagement is over (the group is set to Ending). `strict: true` = the group
 * has extra guardrails.
 */
export const PROFILES = [
  {
    key: "contoso", sample: true, name: "Contoso Retail – Cloud Migration", client: "Contoso Retail", code: "CON-MIG-26", lead: "Priya Raman",
    clients: [{ name: "Jordan Alvarez", title: "VP Store Technology" }, { name: "Lena Ortiz", title: "Store Operations" }],
  },
  {
    key: "fabrikam", name: "Fabrikam Bank – Payments Modernization", client: "Fabrikam Bank", code: "FAB-PAY-26", lead: "Rebecca Stone", strict: true,
    team: ["Kwame Asante", "Ines Moreau", "Lars Becker"], start: "2026-09-14",
    clients: [{ name: "Rachel Adeyemi", title: "Head of Payments" }, { name: "Victor Lindqvist", title: "Risk and Compliance" }],
    project: "moving card, ACH and wire payments onto a new payments hub in Azure",
    requirement: "every instant payment screened for fraud in under 150 milliseconds",
    approach: "an event-driven payments hub that calls the fraud scoring service inline",
    concern: "Our auditors will want proof that no card numbers ever land in logs.",
    scope: { what: "payment types", old: "3", new: "4", detail: "card, ACH and wire", ask: "We'd like real-time payments in the pilot as well, so 4 payment types instead of 3." },
    milestone: { label: "pilot go-live", old: "2026-11-05", new: "2026-11-19", reason: "Our change board meets late this month, so the pilot can't go before the 19th." },
    design: { topic: "the payment ledger", choice: "event sourcing for the payment ledger", short: "event sourcing", why: "every state change is kept, which is exactly what the auditors asked for", concern: "Replaying events for month-end reports could be slow.", fix: "We'll keep a reporting read model, rebuilt every night." },
    risk: "The core banking adapter has no test environment until November 2.",
    issue: "ISO 20022 validation rejected 3 percent of test wires because of address formats",
    ownerGap: "the cutover-night call with the card scheme",
    budget: "about 4 percent under budget on hours",
    signoff: "Who signs off the PCI scope for the pilot?",
    unknown: "the card scheme's test window dates",
    runbook: "Pilot go-live runbook v1.2", testBooked: "Performance test environment booked for the week of November 9 (2x peak).",
    glossary: [["ISO 20022", "The message standard for payments the hub speaks to the clearing networks."], ["Fraud score", "A 0 to 999 risk score returned inline for every payment."], ["Read model", "A reporting copy of the ledger, rebuilt nightly from the events."], ["RTP", "Real-time payments, settled in seconds."]],
    systems: ["Payments hub (Azure Kubernetes Service)", "Fraud scoring service", "Core banking adapter", "ISO 20022 gateway", "Ledger event store (Azure Cosmos DB)"],
    budgetHours: 6200,
  },
  {
    key: "litware", name: "Litware – Data Platform", client: "Litware", code: "LIT-DATA-26", lead: "Daniel Okoro",
    team: ["Freya Lindgren", "Arjun Mehta", "Chloe Martin"], start: "2026-09-08",
    clients: [{ name: "Hiroshi Tanaka", title: "Chief Data Officer" }, { name: "Amara Okoye", title: "Analytics Lead" }],
    project: "a lakehouse on Azure Databricks replacing the old on-premises warehouse",
    requirement: "daily sales dashboards refreshed by 7 a.m. Eastern",
    approach: "a medallion layout with bronze, silver and gold tables",
    concern: "Finance won't trust numbers that differ from the old warehouse by more than half a percent.",
    scope: { what: "source tables", old: "40", new: "52", detail: "the ERP, point of sale and e-commerce sources", ask: "Marketing wants their 12 campaign tables in too, so 52 source tables, not 40." },
    milestone: { label: "warehouse switch-off", old: "2026-11-14", new: "2026-12-05", reason: "Finance wants one more month-end close on both systems before we switch off." },
    design: { topic: "customer history", choice: "type 2 history on the customer and product tables", short: "type 2 history", why: "finance reports need to show what a customer's segment was at the time of each sale", concern: "The customer table will grow fast.", fix: "We'll partition by year and archive anything older than seven years." },
    risk: "Two source systems send timestamps without time zones.",
    issue: "The nightly point-of-sale load overran by 40 minutes twice this week",
    ownerGap: "data quality alerts at weekends",
    budget: "about 8 percent over budget on hours, mostly reconciliation work",
    signoff: "What reconciliation tolerance will finance sign off?",
    unknown: "who still has admin rights on the old warehouse",
    runbook: "Warehouse switch-off plan v0.4", testBooked: "Parallel-run reconciliation scheduled for the November month-end close.",
    glossary: [["Bronze / silver / gold", "Raw, cleaned and business-ready layers of the lakehouse."], ["Type 2 history", "Keeping every past version of a customer or product row with its valid dates."], ["Reconciliation", "Comparing totals between the old warehouse and the lakehouse."], ["Gold table", "A business-ready table the dashboards read."]],
    systems: ["Azure Databricks", "Azure Data Lake Storage", "Power BI", "Old warehouse (on premises)", "ERP, point of sale and e-commerce sources"],
    budgetHours: 5400,
  },
  {
    key: "tailwind", name: "Tailwind Traders – ERP Upgrade", client: "Tailwind Traders", code: "TWT-ERP-26", lead: "Grace Liu",
    team: ["Mateo Fernandez", "Ola Nordmann", "Ravi Shankar"], start: "2026-09-15",
    clients: [{ name: "Gabriela Ruiz", title: "CFO" }, { name: "Owen Mitchell", title: "IT Director" }],
    project: "upgrading the finance and supply chain ERP to the cloud version",
    requirement: "month-end close finished in 4 working days",
    approach: "a two-phase upgrade: finance first, then supply chain",
    concern: "Our warehouse can't stop shipping for more than one night.",
    scope: { what: "legal entities", old: "6", new: "8", detail: "the US, Canada and four EU companies", ask: "The two new Mexican entities should go live with finance too, so 8 legal entities instead of 6." },
    milestone: { label: "finance go-live", old: "2026-11-02", new: "2026-11-09", reason: "The bank file format test failed, and the bank needs a week to fix it on their side." },
    design: { topic: "custom reports", choice: "rebuilding the 23 custom reports as standard analytics views", short: "standard analytics views", why: "standard views survive future upgrades, custom reports broke on every one", concern: "Two of the reports use logic the standard views can't do.", fix: "Those two stay custom and get an owner on the client side." },
    risk: "Vendor master data has about 1,200 duplicates.",
    issue: "Intercompany invoices post twice in the test system",
    ownerGap: "the duplicate vendor clean-up",
    budget: "on budget for hours",
    signoff: "What are the go/no-go criteria for finance go-live?",
    unknown: "the bank's cut-off time for payment files",
    runbook: "Finance go-live cutover plan v2", testBooked: "Final mock cutover booked for the weekend of October 31.",
    glossary: [["Mock cutover", "A full rehearsal of the go-live steps on a copy of production."], ["Legal entity", "A company in the group that keeps its own books."], ["Intercompany", "Sales and invoices between two companies of the same group."]],
    systems: ["ERP (cloud version)", "Bank payment file interface", "Warehouse management system", "Analytics views"],
    budgetHours: 7800,
  },
  {
    key: "adatum", name: "Adatum Health – Patient Portal", client: "Adatum Health", code: "ADA-PORTAL-26", lead: "Samuel Mensah",
    team: ["Yuki Tanaka", "Laura Bianchi", "Omar Haddad"], start: "2026-09-16",
    clients: [{ name: "Dr. Nadia Rahman", title: "Chief Medical Information Officer" }, { name: "Kevin O'Brien", title: "Security Officer" }],
    project: "a new patient portal for appointments, test results and messages",
    requirement: "test results visible to patients within 24 hours, and never before their doctor releases them",
    approach: "a React web app with a FHIR API layer over the clinical record",
    concern: "Every access to a patient record has to be logged for HIPAA.",
    scope: { what: "clinics", old: "3", new: "5", detail: "the downtown, north and lakeside clinics", ask: "The two new urgent care clinics want to be in the pilot, so 5 clinics instead of 3." },
    milestone: { label: "pilot launch", old: "2026-11-10", new: "2026-11-24", reason: "The accessibility audit found 14 issues and we want them fixed before patients see it." },
    design: { topic: "sign-in", choice: "passwordless sign-in with a one-time code by text or email", short: "passwordless sign-in", why: "most support calls on the old portal were password resets", concern: "Some older patients don't have a mobile phone.", fix: "Email codes cover them, and the front desk can send a printed code." },
    risk: "The clinical record's FHIR API caps us at 50 requests a second.",
    issue: "Lab results from two lab vendors arrive without units",
    ownerGap: "accessibility re-testing",
    budget: "about 2 percent over budget on hours",
    signoff: "Who signs off the privacy impact assessment?",
    unknown: "which clinics are open on Saturdays",
    runbook: "Pilot launch checklist v1.1", testBooked: "Accessibility re-test booked with the audit firm for November 16.",
    glossary: [["FHIR", "The healthcare data standard the portal uses to read the clinical record."], ["Release rule", "A result is shown to the patient only after the doctor releases it, or after 24 hours for normal results."], ["PIA", "Privacy impact assessment."]],
    systems: ["Patient portal (React)", "FHIR API layer", "Clinical record system", "Notification service (text and email)"],
    budgetHours: 4600,
  },
  {
    key: "woodgrove", name: "Woodgrove Bank – Cloud Security Review", client: "Woodgrove Bank", code: "WGB-SEC-26", lead: "Isabel Navarro",
    team: ["Henrik Dahl", "Priti Desai", "Marco Ricci"], start: "2026-09-21",
    clients: [{ name: "Daniel Park", title: "CISO" }, { name: "Ingrid Svensson", title: "Cloud Platform Manager" }],
    project: "a security review of the bank's Azure landing zone and a 90-day fix plan",
    requirement: "no storage account reachable from the public internet",
    approach: "an automated scan with Microsoft Defender for Cloud plus interviews with each platform team",
    concern: "The regulator wants the findings report before their visit.",
    scope: { what: "subscriptions", old: "120", new: "160", detail: "production and non-production subscriptions", ask: "The trading division's 40 subscriptions should be in scope too, so 160 instead of 120." },
    milestone: { label: "findings report", old: "2026-11-06", new: "2026-11-13", reason: "With 40 more subscriptions in scope we need another week for the report." },
    design: { topic: "privileged access", choice: "just-in-time admin access through Privileged Identity Management", short: "just-in-time admin access", why: "standing admin rights were the biggest finding in the scan", concern: "The on-call team worries about delays at 3 a.m.", fix: "On-call gets pre-approved activation for one hour, logged and reviewed weekly." },
    risk: "Three platform teams still share one admin account.",
    issue: "The scan can't read 12 subscriptions because reader rights are missing",
    ownerGap: "the break-glass account review",
    budget: "on budget for hours",
    signoff: "Who agrees the risk ratings before the report goes out?",
    unknown: "the date of the regulator's visit",
    runbook: "Findings report outline v0.9", testBooked: "Read-out rehearsal booked with the CISO's team for November 11.",
    glossary: [["Landing zone", "The bank's standard Azure setup: subscriptions, networks, policies and identities."], ["PIM", "Privileged Identity Management: admin rights switched on only when needed, for a limited time."], ["Break-glass account", "An emergency admin account used only when normal sign-in fails."]],
    systems: ["Azure landing zone", "Microsoft Defender for Cloud", "Privileged Identity Management", "Azure Policy"],
    budgetHours: 2400,
  },
  {
    key: "wideworld", name: "Wide World Importers – Supply Chain Analytics", client: "Wide World Importers", code: "WWI-SCA-26", lead: "Hassan Ali",
    team: ["Elena Popescu", "Jonas Weber", "Akira Sato"], start: "2026-09-09",
    clients: [{ name: "Lucia Fernandes", title: "VP Supply Chain" }, { name: "Raj Malhotra", title: "Planning Manager" }],
    project: "a demand forecasting model and supply chain dashboards",
    requirement: "forecast error under 15 percent at product family level",
    approach: "gradient-boosted models per product family, retrained every week",
    concern: "Planners need to override the forecast and see why it changed.",
    scope: { what: "products", old: "1,800", new: "2,400", detail: "the furniture, garden and kitchen families", ask: "We'd like the 600 new imported products forecast from day one, so 2,400 products, not 1,800." },
    milestone: { label: "forecast go-live", old: "2026-11-03", new: "2026-11-17", reason: "The holiday promotions calendar arrived late, and the model needs it." },
    design: { topic: "forecast overrides", choice: "planner overrides stored next to the model forecast with a reason code", short: "overrides with reason codes", why: "the model can learn from overrides and planners can see who changed what", concern: "Planners might override everything in the first weeks.", fix: "We'll report override rates per planner in the weekly review." },
    risk: "Two years of history is missing for the new Asian suppliers.",
    issue: "Weekly retraining takes 5 hours, longer than the Sunday window",
    ownerGap: "the promotions calendar feed",
    budget: "about 5 percent over budget on hours",
    signoff: "What accuracy target does each region sign off?",
    unknown: "the cut-off day for the promotions calendar",
    runbook: "Forecast go-live plan v1.0", testBooked: "Backtest on the last two holiday seasons scheduled for November 4.",
    glossary: [["MAPE", "Mean absolute percentage error, how forecast error is measured."], ["Product family", "A group of similar products forecast together."], ["Override", "A planner's manual change to the model's forecast, with a reason code."]],
    systems: ["Forecasting models (Azure Machine Learning)", "Planning dashboards (Power BI)", "ERP sales history", "Promotions calendar"],
    budgetHours: 3900,
  },
  {
    key: "alpine", name: "Alpine Ski House – Booking Platform", client: "Alpine Ski House", code: "ASH-BOOK-26", lead: "Noah Fischer", ending: true,
    team: ["Clara Johansson", "Pedro Alves", "Sunita Rao"], start: "2026-08-17",
    clients: [{ name: "Sophie Laurent", title: "Director of Guest Experience" }, { name: "Mateo Rossi", title: "IT Manager" }],
    project: "a new booking platform for lift passes, lessons and rentals",
    requirement: "3,000 bookings a minute on the first snow day",
    approach: "a headless commerce platform with the booking engine on Azure",
    concern: "The first snow day sells out within an hour, so the site can't go down.",
    scope: { what: "resorts", old: "4", new: "5", detail: "the four Alpine Ski House resorts", ask: "The new partner resort should sell passes on the platform too, so 5 resorts instead of 4." },
    milestone: { label: "season sales launch", old: "2026-09-29", new: "2026-10-06", reason: "Our payment provider needs one more week to certify the new checkout." },
    design: { topic: "peak days", choice: "a virtual waiting room on peak days", short: "a virtual waiting room", why: "it keeps checkout fast for the people already in it", concern: "Guests hate queues.", fix: "The waiting room shows their place and an honest wait time." },
    risk: "The rentals system only accepts 20 bookings a second.",
    issue: "Season pass photos upload slowly on phones",
    ownerGap: "the hand-over of the support runbook",
    budget: "about 3 percent under budget on hours",
    signoff: "Who signs the hand-over to Alpine's own IT team?",
    unknown: "the payment provider's certification contact",
    runbook: "Season launch runbook v1.4", testBooked: "Peak load test booked for September 22 (3,500 bookings a minute).",
    glossary: [["Waiting room", "A queue page that lets shoppers into checkout at a safe rate."], ["Headless commerce", "Shop logic behind an API, with our own front end."], ["First snow day", "The day the first big snowfall is announced and sales peak."]],
    systems: ["Booking engine (Azure)", "Headless commerce platform", "Rentals system", "Payment provider"],
    budgetHours: 3200,
  },
  {
    key: "coho", name: "Coho Winery – Ecommerce Replatform", client: "Coho Winery", code: "COHO-ECOM-26", lead: "Leila Haddad",
    team: ["Bruno Costa", "Ingrid Holm", "Tyler Brooks"], start: "2026-09-22",
    clients: [{ name: "Elena Petrova", title: "Head of Digital" }, { name: "Ben Carter", title: "Operations Manager" }],
    project: "moving the wine club and online shop to a new commerce platform",
    requirement: "wine club renewals charged on the 1st of each month without failures",
    approach: "a SaaS commerce platform with our own subscriptions service",
    concern: "Age verification has to work in every state we ship to.",
    scope: { what: "states", old: "38", new: "41", detail: "the states Coho ships to", ask: "We're licensed in three more states from January, so 41 states instead of 38." },
    milestone: { label: "store launch", old: "2026-11-16", new: "2026-11-30", reason: "Our shipping partner changes their API on November 10 and we need two weeks after that." },
    design: { topic: "wine club subscriptions", choice: "keeping wine club subscriptions in our own service instead of the platform's add-on", short: "our own subscriptions service", why: "the add-on can't hold shipments in hot weather", concern: "One more service to run.", fix: "It's small, and it runs on the same Azure Functions plan as the order sync." },
    risk: "Shipping rules differ by state and change often.",
    issue: "Tax is off by one cent on split shipments",
    ownerGap: "the age verification vendor contract",
    budget: "about 3 percent under budget on hours",
    signoff: "Who makes the launch go/no-go call on Coho's side?",
    unknown: "which states need an adult signature on delivery",
    runbook: "Store launch runbook v0.7", testBooked: "Wine club renewal dry run booked for November 1.",
    glossary: [["Wine club", "Coho's subscription: 4 shipments a year, charged on the 1st of the shipping month."], ["Weather hold", "Pausing a shipment when it's too hot to ship wine."], ["Split shipment", "One order sent in two parcels."]],
    systems: ["Commerce platform (SaaS)", "Subscriptions service (Azure Functions)", "Shipping partner API", "Age verification service"],
    budgetHours: 3600,
  },
  {
    key: "fourthcoffee", name: "Fourth Coffee – Mobile App", client: "Fourth Coffee", code: "FC-MOB-26", lead: "Olivia Martins",
    team: ["Jae-won Kim", "Fiona Walsh", "Diego Herrera"], start: "2026-09-10",
    clients: [{ name: "Chloe Dubois", title: "VP Marketing" }, { name: "Andre Silva", title: "Head of Store Operations" }],
    project: "a mobile ordering app with loyalty rewards",
    requirement: "orders ready for pickup within 5 minutes at 90 percent of stores",
    approach: "a React Native app with the ordering API on Azure",
    concern: "Loyalty points from the old card scheme must carry over exactly.",
    scope: { what: "stores", old: "650", new: "720", detail: "the US and Canada stores", ask: "The 70 airport kiosks want mobile ordering too, so 720 stores instead of 650." },
    milestone: { label: "app store release", old: "2026-11-09", new: "2026-11-23", reason: "Apple's review flagged the payment sheet, and the fix needs another review round." },
    design: { topic: "orders without signal", choice: "queueing orders on the phone when the signal drops and sending them within 2 minutes", short: "queued offline orders", why: "a third of failed orders last year were lost in stores with poor signal", concern: "A queued order could arrive after the store closes.", fix: "The app checks store hours before queueing and says so plainly." },
    risk: "Store tablets run three different Android versions.",
    issue: "Push notifications arrive late on some Android phones",
    ownerGap: "loyalty points migration testing",
    budget: "on budget for hours",
    signoff: "Who signs off the loyalty migration rules?",
    unknown: "who owns the store opening-hours feed",
    runbook: "App release checklist v1.3", testBooked: "Pilot in 20 Seattle stores booked for November 12.",
    glossary: [["Loyalty points", "Stars earned per dollar, carried over from the old card scheme."], ["Pickup shelf", "Where mobile orders wait for the customer."], ["Offline queue", "Orders kept on the phone until it has signal again."]],
    systems: ["Mobile app (React Native)", "Ordering API (Azure)", "Loyalty service", "Store tablets"],
    budgetHours: 5000,
  },
];

/* ------------------------------------------------------------------ */
/* Contoso: the hand-written sample engagement                         */
/* ------------------------------------------------------------------ */

const readSample = (rel) => fs.readFileSync(path.join(SAMPLES, rel), "utf8");

/** The Contoso sample documents (both chat exports become tracked chat messages instead of documents). */
function contosoDocs() {
  const docs = [];
  const add = (rel, audience, daysBefore) => docs.push({ name: path.basename(rel), audience, text: readSample(rel), day: addDays(WORLD_TODAY, -daysBefore) });
  add("Contoso SOW v3 - summary.md", "shareable", 45);
  add("ADR-007 Cosmos DB for store inventory.md", "shareable", 40);
  add("contoso/docs-shareable/Architecture overview.md", "shareable", 30);
  add("contoso/docs-shareable/Contoso glossary.md", "shareable", 28);
  add("contoso/docs-shareable/Wave 2 cutover runbook v0.3.md", "shareable", 19);
  add("contoso/docs-internal/RAID log.csv", "internal", 15);
  add("contoso/docs-internal/Staffing plan (internal).md", "internal", 14);
  add("contoso/docs-internal/Wave 2 cutover travel note.md", "internal", 13);
  return docs;
}

/** Notes for each Contoso sample meeting, as a good model would write them (from the transcripts in samples/). */
const CONTOSO_NOTES = {
  "Wave 1 retro and wave 2 kickoff": {
    summary: "Wave 1 went live in 36 stores on September 29 with no lost sales; two Northeast stores lost the price feed for about an hour because the SKU sync ran before the price tables were ready. The team agreed a new cutover order for wave 2 and planned 48 stores for November 5. Contoso security keeps the PCI assessment; who decides a night-time rollback goes to the architecture review.",
    decisions: [["Wave 2 cutover order: price tables first, then SKU sync, then open the tills", "Priya Raman"], ["Wave 2 is 48 stores, cutover on November 5", "Jordan Alvarez"], ["PCI assessment stays with Contoso security, as in the SOW", "Priya Raman"]],
    actions: [["Publish cutover runbook v0.3 with a one-page store manager checklist", "Maria Chen", "Oct 3", "2026-10-03", "Done"], ["Share the wave 2 store list with Contoso security", "Priya Raman", "Oct 10", "2026-10-10", "Done"], ["Write the wave 2 rollback plan", "Sam Okafor", null, null, "In progress"]],
    questions: [["Who decides to roll back if a cutover goes wrong at night?", false, null]],
    pending: [],
    facts: [["fact", "Wave 1: 36 stores live on September 29, no lost sales."], ["risk", "New card readers in wave 2 stores are a PCI question for Contoso security."]],
  },
  "Daily standup": null, // filled per date below
  "Architecture review (rollback and PCI)": {
    summary: "Internal review. The rollback rule for wave 2 is a decision at 30 minutes after cutover and the rollback finished within 45 minutes; the night-shift rollback owner is still not named. The card reader model for wave 2 is unknown, which is a PCI risk. Cosmos DB request costs are back within 5% of the estimate after the index change. Hours are about 6% over budget this month (internal only).",
    decisions: [["Rollback rule: decide at 30 minutes if a store can't take payments, roll back within 45 minutes", "Sam Okafor"]],
    actions: [["Log the unknown card reader model in the RAID log", "Sam Okafor", null, null, "Done"], ["Name a night-shift owner for the wave 2 rollback", null, null, null, "Open"]],
    questions: [["Who runs the rollback at 2 a.m.?", false, null]],
    pending: [],
    facts: [["fact", "A wave 1 test rollback took about 40 minutes end to end."], ["risk", "Card reader model for wave 2 stores not known yet (PCI)."], ["fact", "Hours about 6% over budget this month, internal only."]],
  },
  "Weekly client status": {
    summary: "Wave 1 is stable. Jordan said two more regions may join wave 2 (52 stores instead of 48), which would change CR-02; he'll know by October 16. Store managers want a Thursday cutover, so wave 2 tentatively moves to Thursday November 12, to be confirmed next week. Tom will send the card reader list by October 10.",
    decisions: [["Tentatively move the wave 2 cutover to Thursday November 12", "Jordan Alvarez"]],
    actions: [["Confirm the November 12 cutover date", "Jordan Alvarez", "next week", "2026-10-14", "Done"], ["Send the card reader list", "Tom Becker", "Oct 10", "2026-10-10", "Done"], ["Confirm whether two more regions join wave 2", "Jordan Alvarez", "Oct 16", "2026-10-16", "Open"]],
    questions: [],
    pending: [["Wave 2 store count: 48 or 52 (needs a CR-02 change)", "2026-10-16"]],
    facts: [["requirement", "Cutover on a Thursday night: weekends are too busy and Wednesdays have deliveries."], ["risk", "Wave 2 may grow to 52 stores; CR-02 was priced for 48."]],
  },
  "Sprint 14 planning": {
    summary: "Sprint 14 focuses on wave 2: the cutover is on November 12 (final), possibly 52 stores. The SKU sync failures get retries with exponential backoff (five attempts, then page on-call); Maria owns them by October 21 and Sam runs a 3x-peak load test by October 24. The rollback owner and the PCI scope of the new card readers are still open.",
    decisions: [["Wave 2 cutover is November 12 (final)", "Jordan Alvarez"], ["SKU sync retries: exponential backoff, five attempts, then page on-call", "Priya Raman"]],
    actions: [["Add retry logic to the SKU sync job", "Maria Chen", "Oct 21", "2026-10-21", "In progress"], ["Run a load test at three times peak before cutover", "Sam Okafor", "Oct 24", "2026-10-24", "Open"], ["Send the updated cutover date to all store managers", "Priya Raman", "tomorrow", "2026-10-15", "Done"]],
    questions: [["Who owns the rollback plan for wave 2?", false, null], ["What's the PCI scope for the new card readers in wave 2 stores?", false, "2026-10-24"]],
    pending: [],
    facts: [["requirement", "Stores must keep selling for at least 4 hours without a connection."], ["fact", "Offline mode on Cosmos DB covers the 4-hour requirement."]],
  },
};
const CONTOSO_STANDUPS = {
  "2026-10-02": {
    summary: "Short standup. Maria fixed the price table ordering and is on the runbook. Dev needs a lab store with the network switched off for offline tests; Sam will ask Lena. Cosmos DB request costs were about 18% over the estimate, mostly inventory lookups; an index change should fix it.",
    decisions: [], actions: [["Ask Lena for a lab store for offline tests", "Sam Okafor", null, null, "Done"]], questions: [], pending: [],
    facts: [["fact", "Cosmos DB request costs were about 18% over the estimate last month."]],
  },
  "2026-10-08": {
    summary: "Maria updated the runbook for a possible Thursday cutover (not published). Dev's offline tests pass for 4 hours and he'll try 6. Sam is waiting on the card reader list and drafting the rollback plan with the 30/45-minute rule. Don't change plans until Jordan confirms the extra stores.",
    decisions: [], actions: [["Run a 6-hour offline test", "Dev Patel", "today", "2026-10-08", "Done"]], questions: [], pending: [], facts: [],
  },
  "2026-10-13": {
    summary: "The SKU sync job failed overnight again (second time in a week) with timeouts from the store API during 2 a.m. backups; it goes to sprint planning. The six-hour offline test passed. The card reader list from Tom, due October 10, hasn't arrived; Priya will chase.",
    decisions: [], actions: [["Chase Tom for the card reader list", "Priya Raman", "today", "2026-10-13", "Done"], ["Write up the six-hour offline test", "Dev Patel", null, null, "Open"]], questions: [], pending: [],
    facts: [["risk", "SKU sync job times out when the store API is slow during 2 a.m. backups."]],
  },
  "2026-10-15": {
    summary: "Sprint 14 is under way: Maria started the retry logic, the load test environment is booked for October 23, and the wave 2 stores all have the Verifone P400 card reader. Dev takes the wave 2 rollback for the night shift; his backup is still to be named.",
    decisions: [["Dev Patel owns the wave 2 rollback (backup to be decided)", "Priya Raman"]],
    actions: [["Add the Verifone P400 to the regression tests", "Dev Patel", null, null, "Open"], ["Name a backup for the rollback owner", null, null, null, "Open"]], questions: [], pending: [],
    facts: [["fact", "All wave 2 stores use the Verifone P400 card reader."]],
  },
};

/** The Contoso sample meetings (Teams .vtt files) with their notes. Client meetings have guests. */
function contosoMeetings() {
  const files = fs.readdirSync(path.join(SAMPLES, "contoso/meetings")).map((f) => `contoso/meetings/${f}`);
  files.push("Contoso - Sprint 14 planning.vtt");
  return files.map((rel) => {
    const base = path.basename(rel, ".vtt");
    const day = base.match(/^(\d{4}-\d{2}-\d{2})/)?.[1] ?? "2026-10-14";
    const topic = base.replace(/^\d{4}-\d{2}-\d{2} /, "").replace(/^Contoso - /, "");
    const notes = topic === "Daily standup" ? CONTOSO_STANDUPS[day] : CONTOSO_NOTES[topic];
    const guests = /kickoff|client status|Sprint 14/i.test(topic);
    return { title: `Contoso – ${topic}`, day, guests, vtt: readSample(rel), notes: noteShape(notes) };
  });
}

/** Turns the compact tuples above into the notes shape the seed writes. */
function noteShape(n) {
  return {
    summary: n.summary,
    decisions: n.decisions.map(([text, by]) => ({ text, by })),
    actions: n.actions.map(([text, owner, due, dueOn, status]) => ({ text, owner, due, dueOn, status })),
    questions: n.questions.map(([text, answered, dueOn]) => ({ text, answered, dueOn })),
    pending: n.pending.map(([text, dueOn]) => ({ text, dueOn })),
    facts: n.facts.map(([kind, text]) => ({ kind, text })),
  };
}

/** Tracked Teams chats for Contoso: the internal channel and a chat with client guests (from the sample exports). */
function contosoChats() {
  const parse = (rel) =>
    readSample(rel).split("\n").map((l) => l.match(/^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\] ([^:]+): (.*)$/)).filter(Boolean)
      .map(([, d, t, author, text]) => ({ at: `${d}T${t}:00.000Z`, author, text }));
  const guestChat = [
    ...parse("contoso/docs-internal/Teams chat - Priya and Jordan.txt"),
    { at: "2026-10-16T14:10:00.000Z", author: "Lena Ortiz", text: "Store managers have the November 12 date. Can we get the checklist as a printable PDF?" },
    { at: "2026-10-16T14:25:00.000Z", author: "Maria Chen", text: "Yes, I'll attach a PDF version of the checklist to the runbook this week." },
    { at: "2026-10-19T09:05:00.000Z", author: "Jordan Alvarez", text: "Update: the two regions are in. Wave 2 will be 52 stores. I'll send the CR-02 change on Wednesday." },
    { at: "2026-10-19T09:30:00.000Z", author: "Priya Raman", text: "Thanks Jordan. We'll re-plan for 52 stores on November 12 and confirm the extra cost with the CR." },
  ].sort((a, b) => a.at.localeCompare(b.at));
  return [
    { name: "Contoso Delivery – General", guests: false, messages: [...parse("contoso/docs-internal/Teams chat - contoso-delivery channel.txt"),
      { at: "2026-10-20T08:40:00.000Z", author: "Dev Patel", text: "P400 regression tests added. All green on the lab store." },
      { at: "2026-10-21T16:15:00.000Z", author: "Maria Chen", text: "Retry logic merged. Five attempts with backoff, pages on-call after that. Runbook still says Nov 5, will fix tomorrow." }] },
    { name: "Contoso wave 2 – client chat", guests: true, messages: guestChat },
  ];
}

/* ------------------------------------------------------------------ */
/* Generated engagements                                               */
/* ------------------------------------------------------------------ */

/** The named people of a generated group: lead, architect, engineer, analyst, and the two client people. */
function cast(p) {
  const [arch, eng, analyst] = p.team;
  const [c1, c2] = p.clients;
  return { lead: p.lead, arch, eng, analyst, c1: c1.name, c2: c2.name, c1t: c1.title, c2t: c2.title };
}

/** A Teams-style .vtt transcript from [speaker, text] lines, ~40-110 seconds apart (so meetings have realistic lengths). */
export function toVtt(lines, seed = 1) {
  const r = rng(seed);
  let t = 5;
  const ts = (s) => `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.000`;
  const cues = lines.map(([who, text]) => {
    const start = t;
    const end = start + 8 + Math.floor(text.length / 12);
    t = end + 30 + Math.floor(r() * 80);
    return `${ts(start)} --> ${ts(end)}\n<v ${who}>${text}</v>`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** The five meetings of a generated engagement, each with its transcript and notes. */
function generatedMeetings(p) {
  const c = cast(p);
  const m = p.milestone;
  const kickoff = p.start;
  const design = addDays(p.start, 7);
  const status = addDays(p.start, 21);
  const standup = addDays(p.start, 24);
  const steering = addDays(p.start, 30);
  const out = [];
  const seed = [...p.key].reduce((n, ch) => n * 31 + ch.charCodeAt(0), 7) >>> 0;

  out.push({
    title: `${p.client} – Kickoff`, day: kickoff, guests: true,
    lines: [
      [c.lead, `Welcome everyone. This is the kickoff for ${p.project}.`],
      [c.c1, `Thanks. For us the must-have is ${p.requirement}.`],
      [c.arch, `Our proposal is ${p.approach}. We'll show the details in the design review next week.`],
      [c.c2, p.concern],
      [c.lead, `Understood, that goes into the requirements. Let's agree the plan: ${p.scope.old} ${p.scope.what}, ${p.scope.detail}, and the ${m.label} on ${spoken(m.old)}.`],
      [c.c1, `Agreed, ${spoken(m.old)} for the ${m.label}, ${p.scope.old} ${p.scope.what}.`],
      [c.eng, `I'll draft the ${p.runbook.replace(/ v[\d.]+$/, "")} so everyone can comment. I can have it out by ${spoken(addDays(kickoff, 5))}.`],
      [c.lead, `Thanks. I'll send the team list and the weekly status invite today. Status calls are every ${weekday(status)}.`],
      [c.c2, p.signoff],
      [c.lead, "Good question. I don't know yet, let's confirm it in the first status call."],
      [c.analyst, `I'll set up the RAID log and share it with ${first(c.c1)} by the end of the week.`],
    ],
    notes: {
      summary: `Kickoff for ${p.project}. ${p.client} needs ${p.requirement}; the team proposed ${p.approach}. The plan is ${p.scope.old} ${p.scope.what} and the ${m.label} on ${spoken(m.old)}. ${p.concern.replace(/^Our /, `${p.client}'s `)} Who gives one sign-off is still open.`,
      decisions: [{ text: `Plan: ${p.scope.old} ${p.scope.what}, ${m.label} on ${spoken(m.old)}`, by: c.c1 }, { text: `Approach: ${p.approach}`, by: c.lead }],
      actions: [
        { text: `Draft the ${p.runbook.replace(/ v[\d.]+$/, "")}`, owner: c.eng, due: short(addDays(kickoff, 5)), dueOn: addDays(kickoff, 5), status: "Done" },
        { text: "Send the team list and the weekly status invite", owner: c.lead, due: "today", dueOn: kickoff, status: "Done" },
        { text: `Set up the RAID log and share it with ${c.c1}`, owner: c.analyst, due: "end of the week", dueOn: addDays(kickoff, 4), status: "Done" },
      ],
      questions: [{ text: p.signoff, answered: false, dueOn: null }],
      pending: [],
      facts: [{ kind: "requirement", text: p.requirement[0].toUpperCase() + p.requirement.slice(1) + "." }, { kind: "requirement", text: p.concern }],
    },
  });

  out.push({
    title: `${p.client} – Design review (${p.design.topic})`, day: design, guests: false,
    lines: [
      [c.arch, `This one is internal, no client today. Main topic is ${p.design.topic}.`],
      [c.arch, `My proposal: ${p.design.choice}, because ${p.design.why}.`],
      [c.analyst, p.design.concern],
      [c.arch, `Fair point. ${p.design.fix}`],
      [c.lead, `Agreed, let's go with ${p.design.choice}. ${first(c.arch)}, can you write it up as an ADR?`],
      [c.arch, `Yes, by ${spoken(addDays(design, 4))}.`],
      [c.eng, `One risk: ${p.risk[0].toLowerCase() + p.risk.slice(1)}`],
      [c.lead, "Log it in the RAID log please."],
      [c.analyst, `Who owns ${p.ownerGap}? We still don't have a name.`],
      [c.lead, "Honestly I don't know yet. Let's leave it open and come back to it."],
      [c.lead, `Internal note: we're ${p.budget} this month. Let's keep that inside the team for now.`],
    ],
    notes: {
      summary: `Internal design review on ${p.design.topic}. The team chose ${p.design.choice}, because ${p.design.why}; ${p.design.fix.charAt(0).toLowerCase() + p.design.fix.slice(1)} Nobody owns ${p.ownerGap} yet. Hours are ${p.budget} (internal only).`,
      decisions: [{ text: `Use ${p.design.choice}`, by: c.lead }],
      actions: [
        { text: `Write the ADR for ${p.design.short}`, owner: c.arch, due: short(addDays(design, 4)), dueOn: addDays(design, 4), status: "Done" },
        { text: `Log the risk: ${p.risk.replace(/\.$/, "")}`, owner: c.eng, due: null, dueOn: null, status: "Done" },
        { text: `Find an owner for ${p.ownerGap}`, owner: null, due: null, dueOn: null, status: "Open" },
      ],
      questions: [{ text: `Who owns ${p.ownerGap}?`, answered: false, dueOn: null }],
      pending: [],
      facts: [{ kind: "risk", text: p.risk }, { kind: "fact", text: `Hours ${p.budget} (internal only).` }],
    },
  });

  out.push({
    title: `${p.client} – Weekly client status`, day: status, guests: true,
    lines: [
      [c.lead, `Weekly status. The ${p.design.short} design is agreed and the ADR is out.`],
      [c.c1, `Thanks. One change from our side: ${m.reason}`],
      [c.c1, `Can we move the ${m.label} to ${spoken(m.new)}?`],
      [c.lead, `${spoken(m.new)} is a ${weekday(m.new)}. We'd need a few days to re-plan, but it's possible.`],
      [c.c1, `Then let's move it to ${spoken(m.new)}. I'll confirm in writing this week.`],
      [c.c2, p.scope.ask],
      [c.lead, `That would need a change request, since the SOW says ${p.scope.old}. When will you know for sure?`],
      [c.c2, `By ${spoken(addDays(status, 7))}.`],
      [c.eng, `The ${p.runbook} still says ${spoken(m.old)}. I'll update it once the new date is confirmed.`],
      [c.analyst, `Also, ${p.issue.charAt(0).toLowerCase() + p.issue.slice(1)}. We're on it.`],
    ],
    notes: {
      summary: `${p.client} asked to move the ${m.label} from ${spoken(m.old)} to ${spoken(m.new)} (${m.reason.replace(/\.$/, "")}); agreed, to be confirmed in writing. ${p.client} may also want ${p.scope.new} ${p.scope.what} instead of the ${p.scope.old} in the SOW, which needs a change request; they'll know by ${spoken(addDays(status, 7))}. The ${p.runbook} still shows the old date.`,
      decisions: [{ text: `Move the ${m.label} to ${spoken(m.new)}`, by: c.c1 }],
      actions: [
        { text: `Confirm the new ${m.label} date in writing`, owner: c.c1, due: "this week", dueOn: addDays(status, 3), status: "Done" },
        { text: `Update the ${p.runbook} to ${spoken(m.new)}`, owner: c.eng, due: "once confirmed", dueOn: addDays(status, 4), status: "Open" },
        { text: `Prepare a change request for ${p.scope.new} ${p.scope.what}`, owner: c.lead, due: null, dueOn: null, status: "Open" },
      ],
      questions: [],
      pending: [{ text: `${p.scope.old} or ${p.scope.new} ${p.scope.what} (needs a change request)`, dueOn: addDays(status, 7) }],
      facts: [{ kind: "risk", text: `Scope may grow to ${p.scope.new} ${p.scope.what}; the SOW says ${p.scope.old}.` }, { kind: "fact", text: `${p.issue}.` }],
    },
  });

  out.push({
    title: `${p.client} – Daily standup`, day: standup, guests: false,
    lines: [
      [c.lead, `Quick standup. ${first(c.eng)}, go.`],
      [c.eng, `Yesterday I worked on ${p.issue.charAt(0).toLowerCase() + p.issue.slice(1)}. Today I keep going. No blockers.`],
      [c.analyst, `I'm blocked on ${p.unknown}. Nobody seems to know.`],
      [c.lead, `I'll ask ${first(c.c2)} today.`],
      [c.arch, p.testBooked],
      [c.lead, `Reminder: the ${m.label} is now ${spoken(m.new)}, but don't change the plan documents until ${first(c.c1)} confirms in writing.`],
    ],
    notes: {
      summary: `Short standup. Work continues on: ${p.issue.charAt(0).toLowerCase() + p.issue.slice(1)}. The team is blocked on ${p.unknown}; ${c.lead} will ask ${c.c2}. ${p.testBooked}`,
      decisions: [],
      actions: [{ text: `Ask ${c.c2} about ${p.unknown}`, owner: c.lead, due: "today", dueOn: standup, status: "Done" }],
      questions: [{ text: `What is ${p.unknown}?`, answered: false, dueOn: null }],
      pending: [],
      facts: [{ kind: "fact", text: p.testBooked }],
    },
  });

  const later = (n) => addDays(steering, n);
  out.push({
    title: `${p.client} – Steering committee`, day: steering, guests: true,
    lines: [
      [c.lead, `Steering committee. Headline: the ${m.label} is confirmed for ${spoken(m.new)}.`],
      [c.c1, "Confirmed on our side. We sent it in writing on Monday."],
      [c.lead, `Plan for the next two weeks: ${first(c.eng)} on ${p.issue.split(" ").slice(0, 4).join(" ").toLowerCase()}, ${first(c.arch)} on the test, me on the change request.`],
      [c.eng, `I'll have the fix by ${spoken(later(12))}.`],
      [c.arch, `${p.testBooked} I'll share the results by ${spoken(later(14))}.`],
      [c.c2, p.signoff],
      [c.lead, `We'd propose ${c.c1} signs off. Can you confirm by ${spoken(later(5))}?`],
      [c.c1, "Yes, I'll confirm."],
      [c.lead, `And ${p.ownerGap} still needs an owner. I'll bring a name by ${spoken(later(10))}.`],
    ],
    notes: {
      summary: `The ${m.label} is confirmed for ${spoken(m.new)}. Next two weeks: fix ${p.issue.split(" ").slice(0, 4).join(" ").toLowerCase()} (${c.eng}), run the test (${c.arch}) and the change request (${c.lead}). ${c.c1} is asked to confirm the sign-off question by ${spoken(later(5))}; ${p.ownerGap} still has no owner.`,
      decisions: [{ text: `${m.label[0].toUpperCase() + m.label.slice(1)} confirmed for ${spoken(m.new)}`, by: c.c1 }],
      actions: [
        { text: `Fix: ${p.issue}`, owner: c.eng, due: short(later(12)), dueOn: later(12), status: "In progress" },
        { text: "Share the test results", owner: c.arch, due: short(later(14)), dueOn: later(14), status: "Open" },
        { text: `Confirm: ${p.signoff.replace(/\?$/, "")}`, owner: c.c1, due: short(later(5)), dueOn: later(5), status: "Done" },
        { text: `Name an owner for ${p.ownerGap}`, owner: c.lead, due: short(later(10)), dueOn: later(10), status: "Open" },
      ],
      questions: [{ text: p.signoff, answered: true, dueOn: null }],
      pending: [],
      facts: [],
    },
  });

  return out.map((mt, i) => ({ ...mt, vtt: toVtt(mt.lines, seed + i) }));
}

/** The documents of a generated engagement. The runbook keeps the old milestone date on purpose ("Out of date"). */
function generatedDocs(p) {
  const c = cast(p);
  const m = p.milestone;
  const docs = [];
  const add = (name, audience, day, text) => docs.push({ name, audience, day, text });
  add(`${p.client} SOW - summary.md`, "shareable", addDays(p.start, -10), `# ${p.name}: Statement of Work (summary)

- **Client:** ${p.client} · **Sponsor:** ${c.c1} (${c.c1t})
- **Delivery lead:** ${c.lead} · **Architect:** ${c.arch} · **Engineer:** ${c.eng} · **Analyst:** ${c.analyst}
- **Scope:** ${p.project}.
- **In scope:** ${p.scope.old} ${p.scope.what} (${p.scope.detail}).
- **Key requirement:** ${p.requirement}.
- **Milestone:** ${m.label}, date set in project meetings.
- **Budget:** time and materials, about ${p.budgetHours.toLocaleString("en-US")} hours.
- **Out of scope:** anything not listed above needs a change request.
`);
  add(`${p.runbook}.md`, "shareable", addDays(p.start, 6), `# ${p.runbook.replace(/ v([\d.]+)$/, " (v$1)")}

**Engagement:** ${p.name} · **Author:** ${c.eng} · **Published:** ${spoken(addDays(p.start, 6))}, 2026

## Summary
- **${m.label[0].toUpperCase() + m.label.slice(1)}:** ${weekday(m.old)}, ${spoken(m.old)}, 2026
- **Scope:** ${p.scope.old} ${p.scope.what}
- **Systems:** ${p.systems.join(", ")}

## Steps
1. Freeze changes 48 hours before.
2. Final backup and sign-off from ${c.c2}.
3. Switch traffic to the new platform; watch the dashboards for 30 minutes.
4. Smoke tests: ${p.requirement}.
5. Go/no-go call with ${c.c1}; roll back if the smoke tests fail.

## Open points
- Owner for ${p.ownerGap}: to be confirmed.
`);
  add("RAID log.csv", "internal", addDays(p.start, 4), [
    "ID,Type,Description,Owner,Status,Opened,Due",
    `R-01,Risk,${p.risk.replace(/,/g, ";")},${c.arch},Open,${addDays(p.start, 7)},${addDays(p.start, 28)}`,
    `R-02,Risk,Scope may grow to ${p.scope.new} ${p.scope.what}; SOW says ${p.scope.old},${c.lead},Open,${addDays(p.start, 21)},${addDays(p.start, 28)}`,
    `I-01,Issue,${p.issue.replace(/,/g, ";")},${c.eng},Open,${addDays(p.start, 20)},${addDays(p.start, 36)}`,
    `A-01,Assumption,${c.client ?? p.client} provides test data two weeks before the ${m.label},${c.c2},Open,${p.start},`,
    `D-01,Dependency,${p.unknown[0].toUpperCase() + p.unknown.slice(1)},${c.c2},Open,${addDays(p.start, 24)},`,
  ].join("\n"));
  add("Architecture overview.md", "shareable", addDays(p.start, 9), `# ${p.client} – Architecture overview

${p.approach[0].toUpperCase() + p.approach.slice(1)}.

## Components
${p.systems.map((s) => `- ${s}`).join("\n")}

## Key decisions
- ${p.design.choice[0].toUpperCase() + p.design.choice.slice(1)} (see the ADR): ${p.design.why}.

## Non-functional requirements
- ${p.requirement[0].toUpperCase() + p.requirement.slice(1)}.
- ${p.concern}
`);
  add(`Weekly status report - ${spoken(addDays(p.start, 14))}.md`, "shareable", addDays(p.start, 14), `# ${p.client} – Weekly status (${spoken(addDays(p.start, 14))})

**Overall:** green · **Next milestone:** ${m.label} on ${spoken(m.old)}

## Done this week
- ${p.design.short[0].toUpperCase() + p.design.short.slice(1)} agreed and written up.
- RAID log shared with ${c.c1}.

## Next week
- ${p.testBooked}

## Risks
- ${p.risk}
`);
  add("Staffing and budget (internal).md", "internal", addDays(p.start, 16), `# ${p.client} – staffing and budget (internal only)

| Person | Role | Allocation |
|---|---|---|
| ${c.lead} | Delivery lead | 100% |
| ${c.arch} | Architect | 80% |
| ${c.eng} | Engineer | 100% |
| ${c.analyst} | Analyst | 100% |

- Budget: about ${p.budgetHours.toLocaleString("en-US")} hours. We're ${p.budget}.
- Not shared with the client.
`);
  add(`${p.client} glossary.md`, "shareable", addDays(p.start, 3), `# ${p.client} glossary\n\n${p.glossary.map(([t, d]) => `- **${t}:** ${d}`).join("\n")}\n`);
  return docs;
}

/** The tracked internal Teams chat of a generated engagement (about 13 messages over four weeks). */
function generatedChat(p) {
  const c = cast(p);
  const m = p.milestone;
  const at = (offset, time) => `${addDays(p.start, offset)}T${time}:00.000Z`;
  const extra = p.team.length > 3 ? p.team[3] : c.analyst;
  return {
    name: `${p.client} delivery team`, guests: false,
    messages: [
      { at: at(6, "09:10"), author: c.eng, text: `${p.runbook} is in the Files tab. Comments welcome.` },
      { at: at(6, "09:25"), author: c.lead, text: `Thanks! I'll send it to ${first(c.c2)} after our review.` },
      { at: at(7, "16:40"), author: c.arch, text: `Decision from today's design review: ${p.design.choice}. ADR to follow.` },
      { at: at(10, "11:05"), author: c.analyst, text: `Heads-up: ${p.risk[0].toLowerCase() + p.risk.slice(1)}` },
      { at: at(15, "10:30"), author: c.analyst, text: `Does anyone know ${p.unknown}?` },
      { at: at(15, "10:42"), author: c.eng, text: `Not sure. ${first(c.lead)}?` },
      { at: at(15, "11:02"), author: c.lead, text: `I'll ask ${first(c.c2)}. Remind me if I forget.` },
      { at: at(21, "13:05"), author: c.lead, text: `Heads up: ${first(c.c1)} wants to move the ${m.label} to ${spoken(m.new)}. Not confirmed yet, don't change the runbook date yet.` },
      { at: at(23, "07:55"), author: c.eng, text: `${p.issue[0].toUpperCase() + p.issue.slice(1)}. Logs are in the incident folder.` },
      { at: at(26, "17:30"), author: c.arch, text: p.testBooked },
      { at: at(28, "09:00"), author: c.lead, text: `Confirmed by ${first(c.c1)} in writing: the ${m.label} is ${spoken(m.new)}.` },
      { at: at(29, "14:20"), author: extra, text: `Who's covering ${p.ownerGap}? Still nobody named.` },
      { at: at(31, "08:45"), author: c.analyst, text: "Status report for this week is up in Files." },
    ].filter((x) => x.at.slice(0, 10) <= WORLD_TODAY),
  };
}

/* ------------------------------------------------------------------ */
/* What each group holds                                               */
/* ------------------------------------------------------------------ */

/**
 * Everything one Northwind group holds: documents, meetings (with notes), tracked chats, questions asked in the
 * portal (with the answer a good model gives, whether it found one, and the 👍/👎 votes), and the knowledge map.
 */
export function groupContent(p) {
  if (p.sample) return { docs: contosoDocs(), meetings: contosoMeetings(), chats: contosoChats(), questions: contosoQuestions(), insights: contosoInsights() };
  const meetings = generatedMeetings(p);
  const docs = generatedDocs(p);
  return { docs, meetings, chats: [generatedChat(p)], questions: generatedQuestions(p, meetings), insights: generatedInsights(p, docs, meetings) };
}

/** Portal questions for Contoso (from samples/contoso/README.md "Good questions to try"). `asker` = a role in the group. */
function contosoQuestions() {
  return [
    { asker: "lead", q: "When is the wave 2 cutover, how many stores, and who owns the rollback?", found: true, votes: ["up", "up"],
      a: "Wave 2 cuts over on Thursday November 12 (moved from November 5; confirmed by Jordan on October 12). It was planned for 48 stores; Jordan said on October 19 the two extra regions are in, so it will be 52 (CR-02 needs a change). Dev Patel owns the rollback for the night shift; his backup isn't named yet. Note: the cutover runbook v0.3 still says November 5." },
    { asker: "member", q: "Why did we choose Cosmos DB?", found: true, votes: ["up"],
      a: "For the offline requirement: stores must keep selling for at least 4 hours without a connection (SOW section 2.4), and Cosmos DB's offline mode covers that (ADR-007). It was chosen in April." },
    { asker: "member", q: "What's the rollback rule if a store can't take payments?", found: true, votes: ["up"],
      a: "Decide at 30 minutes after cutover; if the store still can't take payments, roll it back to the legacy POS, finished within 45 minutes (architecture review, October 6)." },
    { asker: "viewer", q: "What's Sam's hourly rate?", found: false, votes: [], a: "I couldn't find that in this group's documents, meetings or chats." },
    { asker: "lead", q: "Are we over budget?", found: true, votes: ["down"],
      a: "Yes: hours are about 6% over budget for October, mostly from the wave 1 price feed issue (staffing plan, architecture review). This hasn't been shared with the client yet." },
  ];
}

/** Portal questions for a generated group: when is the milestone (with the stale runbook), why the design, an owner gap, a rate nobody wrote down. */
function generatedQuestions(p, meetings) {
  const m = p.milestone;
  const c = cast(p);
  return [
    { asker: "lead", q: `When is the ${m.label}?`, found: true, votes: ["up", "up"],
      a: `The ${m.label} is on ${weekday(m.new)}, ${spoken(m.new)}. It moved from ${spoken(m.old)} in the weekly client status on ${spoken(meetings[2].day)} and ${c.c1} confirmed it in writing. Note: the ${p.runbook} still says ${spoken(m.old)}.` },
    { asker: "member", q: `Why did we choose ${p.design.short}?`, found: true, votes: ["up"],
      a: `Because ${p.design.why} (design review, ${spoken(meetings[1].day)}). ${p.design.fix}` },
    { asker: "member", q: `Who owns ${p.ownerGap}?`, found: true, votes: ["down"],
      a: `Nobody yet. It came up in the design review and again at the steering committee; ${c.lead} said they'd bring a name.` },
    { asker: "viewer", q: `What's ${first(c.arch)}'s day rate?`, found: false, votes: [], a: "I couldn't find that in this group's documents, meetings or chats." },
  ];
}

/** The Contoso knowledge map (what a good model finds in the sample: see samples/contoso/README.md "Planted on purpose"). */
function contosoInsights() {
  return {
    topics: [
      { name: "Wave 2 cutover", summary: "Wave 2 moves to Thursday November 12 with 48, now likely 52, stores; cutover order and the store manager checklist are agreed.", coverage: 62, key_facts: ["Cutover Thursday November 12 (moved from November 5)", "52 stores (CR-02 priced for 48)", "Order: price tables, SKU sync, then tills"], document_titles: ["Wave 2 cutover runbook v0.3.md", "Contoso SOW v3 - summary.md"], meeting_titles: ["Contoso – Weekly client status", "Contoso – Sprint 14 planning"] },
      { name: "Rollback plan", summary: "Decide at 30 minutes, roll back within 45. Dev Patel owns the night shift; his backup isn't named.", coverage: 35, key_facts: ["30-minute decision point", "45-minute rollback", "Owner: Dev Patel (from Oct 15)"], document_titles: [], meeting_titles: ["Contoso – Architecture review (rollback and PCI)", "Contoso – Daily standup"] },
      { name: "Offline mode and Cosmos DB", summary: "Stores must sell for 4 hours offline; Cosmos DB offline mode covers it; six-hour test passed.", coverage: 85, key_facts: ["4-hour offline requirement (SOW 2.4)", "Six-hour offline test passed Oct 13", "Request costs back within 5% of estimate"], document_titles: ["ADR-007 Cosmos DB for store inventory.md", "Architecture overview.md"], meeting_titles: ["Contoso – Daily standup"] },
      { name: "SKU sync reliability", summary: "Overnight sync times out during 2 a.m. backups; retries with backoff are being added.", coverage: 48, key_facts: ["Five attempts with exponential backoff, then page on-call", "Retry logic due Oct 21", "Load test at 3x peak by Oct 24"], document_titles: ["RAID log.csv"], meeting_titles: ["Contoso – Sprint 14 planning"] },
      { name: "PCI and card readers", summary: "Contoso security owns the PCI assessment; wave 2 stores use the Verifone P400.", coverage: 55, key_facts: ["Verifone P400 in all wave 2 stores", "PCI out of scope for Northwind"], document_titles: ["Contoso SOW v3 - summary.md", "RAID log.csv"], meeting_titles: ["Contoso – Architecture review (rollback and PCI)"] },
    ],
    gaps: [
      { kind: "Out of date", text: "The cutover runbook v0.3 still says Wednesday November 5; the cutover moved to Thursday November 12.", suggestion: "Publish runbook v0.4 with the new date and 52 stores.", topic: "Wave 2 cutover", sources: ["Wave 2 cutover runbook v0.3.md", "Contoso – Sprint 14 planning"] },
      { kind: "Conflicting information", text: "The SOW and CR-02 say 48 wave 2 stores; Jordan said in the client chat that it will be 52.", suggestion: "Update CR-02 and the SOW summary once the change is signed.", topic: "Wave 2 cutover", sources: ["Contoso SOW v3 - summary.md", "Teams chat: Contoso wave 2 – client chat (2026-10-19)"] },
      { kind: "Only in a meeting", text: "The 30-minute decision / 45-minute rollback rule exists only in the architecture review transcript.", suggestion: "Add the rollback rule to the runbook.", topic: "Rollback plan", sources: ["Contoso – Architecture review (rollback and PCI)"] },
      { kind: "Unanswered in meeting", text: "Nobody has been named as backup for the rollback owner.", suggestion: "Name a backup on the night-shift rota.", topic: "Rollback plan", sources: ["Contoso – Daily standup"] },
      { kind: "Couldn't find an answer", text: "Someone asked for Sam's hourly rate; no source has it.", suggestion: "Rates aren't shared in Sidekick; point people to the rate card owner.", topic: "Wave 2 cutover", sources: [] },
    ],
  };
}

/** A generated group's knowledge map: the planted gaps (stale runbook, scope conflict, unowned work, decision only in a meeting, a missing rate). */
function generatedInsights(p, docs, meetings) {
  const m = p.milestone;
  const runbookDoc = `${p.runbook}.md`;
  const sow = `${p.client} SOW - summary.md`;
  return {
    topics: [
      { name: `${m.label[0].toUpperCase() + m.label.slice(1)}`, summary: `The ${m.label} moved from ${spoken(m.old)} to ${spoken(m.new)} and is confirmed in writing.`, coverage: 58, key_facts: [`New date ${spoken(m.new)}`, `Old date ${spoken(m.old)} still in the runbook`, m.reason], document_titles: [runbookDoc], meeting_titles: [meetings[2].title, meetings[4].title] },
      { name: p.design.topic[0].toUpperCase() + p.design.topic.slice(1), summary: `Chose ${p.design.choice}: ${p.design.why}.`, coverage: 81, key_facts: [p.design.fix], document_titles: ["Architecture overview.md"], meeting_titles: [meetings[1].title] },
      { name: "Scope", summary: `${p.scope.old} ${p.scope.what} in the SOW; the client asked for ${p.scope.new}.`, coverage: 44, key_facts: [p.scope.ask], document_titles: [sow, "RAID log.csv"], meeting_titles: [meetings[2].title] },
      { name: "Risks and issues", summary: `${p.risk} ${p.issue}.`, coverage: 52, key_facts: [p.risk, `${p.issue}.`], document_titles: ["RAID log.csv"], meeting_titles: [meetings[3].title] },
      { name: "Requirements", summary: `${p.requirement[0].toUpperCase() + p.requirement.slice(1)}. ${p.concern}`, coverage: 77, key_facts: [p.requirement], document_titles: [sow, "Architecture overview.md"], meeting_titles: [meetings[0].title] },
    ],
    gaps: [
      { kind: "Out of date", text: `The ${p.runbook} still says ${spoken(m.old)}; the ${m.label} moved to ${spoken(m.new)}.`, suggestion: `Publish a new version of the runbook with ${spoken(m.new)}.`, topic: m.label[0].toUpperCase() + m.label.slice(1), sources: [runbookDoc, meetings[2].title] },
      { kind: "Conflicting information", text: `The SOW says ${p.scope.old} ${p.scope.what}; in the weekly status the client asked for ${p.scope.new}.`, suggestion: "Agree the change request and update the SOW summary.", topic: "Scope", sources: [sow, meetings[2].title] },
      { kind: "Unanswered in meeting", text: `Nobody owns ${p.ownerGap}.`, suggestion: "Name an owner at the next steering committee.", topic: "Risks and issues", sources: [meetings[1].title, meetings[4].title] },
      { kind: "Only in a meeting", text: `The decision to use ${p.design.short} is only in the design review transcript and the chat.`, suggestion: "Link the ADR from the architecture overview.", topic: p.design.topic[0].toUpperCase() + p.design.topic.slice(1), sources: [meetings[1].title] },
      { kind: "Couldn't find an answer", text: "Someone asked for a day rate; no source has it.", suggestion: "Rates aren't shared in Sidekick; point people to the rate card owner.", topic: "Scope", sources: [] },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Other organizations' groups                                         */
/* ------------------------------------------------------------------ */

/** A small group for one of the other organizations: two documents and one meeting with notes. */
export function smallOrgContent(o) {
  const g = o.group;
  const lead = o.owner.name;
  const helper = o.people[0];
  const day = addDays(WORLD_TODAY, -9);
  const lines = [
    [lead, `Kickoff for ${g.name}. ${g.client} wants the first release live before the end of the year.`],
    [helper, "I'll draft the plan and the RAID log this week."],
    [lead, "Good. Status calls every Tuesday. Who signs off the first release on the client side is still open."],
  ];
  return {
    docs: [
      { name: `${g.client} SOW - summary.md`, audience: "shareable", day: addDays(day, -5), text: `# ${g.name}: SOW summary\n\n- Client: ${g.client}\n- Lead: ${lead}\n- First release before December 18, 2026.\n` },
      { name: "Project plan v0.1.md", audience: "internal", day: addDays(day, 2), text: `# ${g.name}: plan\n\n1. Discovery (2 weeks)\n2. Build (6 weeks)\n3. First release: December 18, 2026\n` },
    ],
    meetings: [{
      title: `${g.client} – Kickoff`, day, guests: true, vtt: toVtt(lines, 99), lines,
      notes: {
        summary: `Kickoff for ${g.name}. ${g.client} wants the first release live before the end of the year. ${helper} drafts the plan and RAID log; who signs off the first release is still open.`,
        decisions: [{ text: "Weekly status calls on Tuesdays", by: lead }],
        actions: [{ text: "Draft the plan and the RAID log", owner: helper, due: "this week", dueOn: addDays(day, 4), status: "Open" }],
        questions: [{ text: "Who signs off the first release on the client side?", answered: false, dueOn: null }],
        pending: [], facts: [{ kind: "requirement", text: "First release before December 18, 2026." }],
      },
    }],
  };
}

/* ------------------------------------------------------------------ */
/* Firm library, support tickets                                       */
/* ------------------------------------------------------------------ */

/**
 * Northwind's firm library: the sample firm library (samples/firm-library, renamed to Northwind Consulting) plus
 * three more standards and templates. `replaces` names the title of the document a newer version supersedes.
 */
export function firmLibrary() {
  const nw = (rel) => readSample(`firm-library/${rel}`).replace(/Fabrikam Advisory/g, NORTHWIND.org);
  return [
    { name: "Expense policy v2.md", title: "Expense policy (version 2)", audience: "internal", effective: "2025-01-01", text: nw("Expense policy v2.md") },
    { name: "Expense policy v3.md", title: "Expense policy (version 3)", audience: "internal", effective: "2026-07-01", replaces: "Expense policy (version 2)", text: nw("Expense policy v3.md") },
    { name: "Travel policy.md", title: "Travel policy", audience: "shareable", effective: "2026-01-01", text: nw("Travel policy.md") },
    { name: "Rate card rules.md", title: "Rate card rules", audience: "internal", effective: "2026-04-01", text: nw("Rate card rules.md") },
    { name: "Client data handling standard.md", title: "Client data handling standard", audience: "shareable", effective: "2026-03-01", text: nw("Client data handling standard.md") },
    { name: "Delivery standard - RAID logs.md", title: "Delivery standard: RAID logs", audience: "internal", effective: "2026-05-01", text: `# ${NORTHWIND.org} – Delivery standard: RAID logs

Effective 1 May 2026.

- Every engagement keeps one RAID log (risks, assumptions, issues, dependencies), shared with the client sponsor.
- Every row has a named owner and a due date. "TBD" is not an owner.
- The delivery lead reviews the log every week before the client status call.
- Risks rated high go to the steering committee within 5 working days.
- Closed rows stay in the log with the date they closed.
` },
    { name: "Template - weekly status report.md", title: "Template: weekly status report", audience: "shareable", effective: "2026-02-01", text: `# Template: weekly status report

**Engagement:** · **Week ending:** · **Overall:** green / amber / red

## Done this week
## Next week
## Decisions needed (with the date they're needed by)
## Risks and issues (from the RAID log, high first)
## Milestones (planned date, forecast date, change since last week)
` },
    { name: "Information security policy.md", title: "Information security policy", audience: "shareable", effective: "2026-06-01", text: `# ${NORTHWIND.org} – Information security policy

Effective 1 June 2026.

- Client production data never leaves the client's environment; no copies on laptops or personal drives.
- Multi-factor sign-in on every firm and client account.
- Report a lost device or a suspected incident to the security desk within 1 hour.
- Shared admin accounts are not allowed; use named accounts with just-in-time access.
- Card numbers, patient data and passwords are never pasted into chats, tickets or AI tools.
` },
  ];
}

/**
 * Support tickets people opened from the portal, with the Sidekick team's replies. `as` = the person's key or
 * email; `staff` = replies from the operator (`note: true` = internal note), `customer` = a follow-up from the
 * person; `resolve` = closed at the end.
 */
export function supportTickets() {
  return [
    { as: "member", subject: "Meeting import failed for a long workshop recording", category: "bug", priority: "normal",
      description: "I imported a 4-hour design workshop transcript into Contoso and it said it was too long. Is there a limit?",
      staff: [{ body: "Thanks Maria. The limit is about five hours of talk per transcript; yours was just over because of the long breaks in the recording. Splitting it into two parts and importing each one works. We're also looking at raising the limit." }],
      customer: [{ body: "Split it in two, both imported fine. Thanks!" }], resolve: true },
    { as: "financeAdmin", subject: "Can invoices show our purchase order number?", category: "billing", priority: "low",
      description: "Our finance team needs PO 4500-1182 on every invoice from November.",
      staff: [{ body: "Yes, we can add it from the November invoice. Can you confirm the PO is valid until the end of the year?" }] },
    { as: "fabrikamLead", subject: "Can client guests in a Teams chat see internal documents?", category: "question", priority: "normal",
      description: "We're adding Fabrikam's payments team to our Teams chat. I want to be sure they never see our staffing note.",
      staff: [{ body: "Internal notes for the team: customer asked about guests; pointed to the guests switch.", note: true }, { body: "They can't: in a chat with client guests, Sidekick only answers from documents marked Shareable. Turn on 'Client guests in this chat' for that chat on the group's Teams chats tab, and keep the staffing note Internal." }] },
    { as: "orgAdmin", subject: "Knowledge map shows a gap we already fixed", category: "question", priority: "low",
      description: "Litware's map still says the switch-off plan is out of date, but Daniel uploaded v0.5 yesterday.",
      staff: [] },
  ];
}

/**
 * The upload guard's demo (lib/upload-guard.ts), uploaded by scripts/seed-demo.mjs after the groups' own documents:
 * - `misfiled`: a Litware document that Maria Chen (in Contoso and Litware) drops into **Contoso** by mistake. It
 *   names Litware and its engagement code, so it is saved **Held** and Contoso's Knowledge page asks "Keep it here,
 *   or move it?".
 * - `limited`: a firm standard for the two banking engagements only ("Applies to": Fabrikam Bank and Woodgrove Bank).
 * - `firmHeld`: a Contoso-only store checklist uploaded to the **firm library**, held because firm documents reach
 *   every group ("Put it in the Contoso group instead?").
 */
export function uploadGuardDemo() {
  return {
    misfiled: {
      name: "Litware pipeline SLA notes.md", audience: "internal", text: `# Litware – data pipeline SLA notes (LIT-DATA-26)

Internal working notes for the Litware Data Platform engagement.

- Litware expects the nightly ingestion to finish by 05:00 Central so the finance dashboards are ready at 07:00.
- Late loads more than twice in a week trigger a service review with Litware's data office.
- Our on-call rotation covers the pipelines from Monday to Friday; weekend support starts after the November release.
- Open point: Litware wants a 99.5% monthly availability target for the curated layer; we proposed 99%.
` },
    limited: {
      name: "Banking engagements - data residency standard.md", title: "Banking engagements: data residency standard", audience: "internal", effective: "2026-09-01",
      groups: ["fabrikam", "woodgrove"], text: `# ${NORTHWIND.org} – Data residency standard for banking engagements

Effective 1 September 2026. Applies to engagements with regulated banks only.

- Customer and account data stays in the bank's own cloud tenant and region. Never copy it to our tenant, laptops or personal storage.
- Test data is masked or synthetic. Production extracts need the bank's written approval, recorded in the RAID log.
- Screenshots in status reports never show account numbers, balances or customer names.
- Any suspected data leak is reported to the engagement lead and the firm's security team within 1 hour.
` },
    firmHeld: {
      name: "Store cutover checklist - wave 2.md", title: "Store cutover checklist (wave 2)", audience: "internal", effective: "2026-10-01", text: `# Contoso Retail – store cutover checklist, wave 2

For store managers in the Contoso Retail cloud migration (wave 2 stores).

1. The evening before: confirm the last end-of-day report reached the old system.
2. Cutover night: tills stay offline from 23:00 to 02:00; the night manager keeps the paper log.
3. Next morning: open one till first and run a test sale before opening the others.
4. Problems: call the Contoso Retail cutover bridge, not the regular help desk.
` },
  };
}
