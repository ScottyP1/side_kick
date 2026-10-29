/**
 * Pitch and website capture of the **local demo world** (docs/DEMO.md → "Capture the walkthrough"): drives the
 * seeded demo copy (preview "sidekick-demo", http://localhost:3330, fake Claude, made-up Northwind data) through
 * every shot of the capture plan that doesn't need live Teams or a Microsoft sign-in, and saves
 *   <out>/desktop/NN-name.png   1440×900 at 2x
 *   <out>/phone/NN-name.png     390×844 at 3x
 *   <out>/clips/name.webm       short desktop clips (only with --clips; 1440×900 at 1x)
 *   <out>/manifest.json         every file with its caption, account and size, in shot order
 *
 * Flows that change data run in an order that keeps the next ones working (a made-up firm signs up, Jira switches
 * to "each person signs in", Maria connects her own Jira, an action item gets an owner and is marked done), so run it
 * on a **fresh seed** (`npm --prefix app run seed:demo`) each time.
 *
 * Who may run it: a person on their own Mac, by hand. It is **never** part of `npm test` (tests/run.mjs only runs
 * tests/*.test.mjs) and it refuses to run under npm's test lifecycle, against anything but localhost, or without
 * the demo logins. Demo passwords are read from the git-ignored app/.demo-logins.json and never printed; the
 * made-up firm's password is random and only kept in memory. Needs Google Chrome and playwright-core (app's own
 * node_modules if present, else the pitch pack's `_build/node_modules`, or PLAYWRIGHT_CORE=<path>).
 *
 * Usage (from the repo folder, with the demo copy running):
 *   node app/scripts/capture-walkthrough.mjs --draft                 # DRAFT badge, into the pitch folder's draft-capture-<date>/
 *   node app/scripts/capture-walkthrough.mjs --out <dir> [--clips] [--only signup,roles] [--base http://localhost:3370]
 * `--only` into a folder that already has a capture redoes just those flows: their files keep their names and are
 * overwritten, and manifest.json keeps every other entry (plus `redone`: which flows, when).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..");
const PITCH = path.join(os.homedir(), "Desktop/Sidekick Pitch");

// ---------- guards and options ----------
if (process.env.npm_lifecycle_event === "test" || process.env.NODE_TEST_CONTEXT) {
  console.error("capture-walkthrough is a manual tool and never runs inside npm test.");
  process.exit(1);
}
const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes(`--${name}`);
const DRAFT = flag("draft");
const CLIPS = flag("clips");
const ONLY = (opt("only") ?? "").split(",").filter(Boolean);
const BASE = opt("base") ?? process.env.DEMO_BASE ?? "http://localhost:3330";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(BASE)) throw new Error("capture-walkthrough only runs against a local demo copy (http://localhost:<port>).");
const today = new Date().toISOString().slice(0, 10);
const OUT = opt("out") ?? (DRAFT ? path.join(PITCH, "5 - Screenshots & mockups", `draft-capture-${today}`) : null);
if (!OUT) throw new Error("Say where to save: --out <dir> (or --draft for the pitch folder's draft-capture-<date>/).");
const LOGINS_FILE = path.join(APP, ".demo-logins.json");
if (!fs.existsSync(LOGINS_FILE)) throw new Error("No app/.demo-logins.json: seed the demo world first (npm --prefix app run seed:demo).");
const LOGINS = JSON.parse(fs.readFileSync(LOGINS_FILE, "utf8"));

/** playwright-core from the app, the pitch pack's build folder, or PLAYWRIGHT_CORE. */
function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_CORE, path.join(APP, "package.json"), path.join(PITCH, "_build/package.json")].filter(Boolean);
  for (const t of tries) {
    try { return createRequire(t.endsWith(".json") ? t : path.join(t, "x.js"))("playwright-core"); } catch { /* next */ }
  }
  throw new Error("playwright-core not found: install it in the pitch pack's _build/ or set PLAYWRIGHT_CORE=<folder with node_modules>.");
}
const { chromium } = loadPlaywright();

// ---------- the demo accounts (docs/DEMO.md, app/.demo-logins.md) ----------
const ACCOUNTS = {
  operator: "operator@sidekick-demo.example", orgOwner: "olivia.bennett@northwind.example", orgAdmin: "marcus.lee@northwind.example",
  teamLead: "priya.raman@northwind.example", member: "maria.chen@northwind.example", viewer: "ethan.wright@northwind.example",
  tailspinOwner: "grace.kim@tailspin.example",
};
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" };
// The made-up firm that signs up on the public site (Lakeside Advisory: the pitch pack's sample consultancy).
const FIRM = { org: "Lakeside Advisory", owner: "Alex Morgan", email: "alex.morgan@lakeside.example", password: crypto.randomBytes(12).toString("base64url") + "!Aa1" };

// Hides the Next.js dev badge; with --draft adds a "DRAFT" tag in the corner of every page (shots and clips).
const INIT = ({ draft }) => {
  const add = () => {
    const s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}" + (draft ? "#capture-draft{position:fixed;right:12px;bottom:12px;z-index:2147483647;font:700 12px/1 system-ui;letter-spacing:.12em;color:#fff;background:rgba(220,38,38,.85);padding:6px 9px;border-radius:6px;pointer-events:none}" : "");
    document.head.appendChild(s);
    if (draft) { const d = document.createElement("div"); d.id = "capture-draft"; d.textContent = "DRAFT"; document.body.appendChild(d); }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add); else add();
};

// ---------- runner ----------
fs.mkdirSync(OUT, { recursive: true });
const manifest = [];
const problems = [];
let n = 0;
// Re-running some flows (--only) into a folder that already holds a capture: each shot keeps its earlier file name
// (number and all) and is overwritten in place, and the other flows' manifest entries are kept.
const PREV = ONLY.length && fs.existsSync(path.join(OUT, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(OUT, "manifest.json"), "utf8")) : null;
const prevFile = (dir, name) => PREV?.shots.find((s) => s.file.startsWith(`${dir}/`) && s.file.endsWith(`-${name}.png`))?.file.slice(dir.length + 1);
let ip = 20;
const log = (...a) => console.log(...a);

/** A browser context, signed in as `who` (a key of ACCOUNTS, or { email, password } for the made-up firm), or anonymous. */
async function context(browser, who, { phone = false, video } = {}) {
  const dev = phone ? PHONE : DESKTOP;
  // Clips record at 1x without mobile emulation (Chrome's recorder otherwise leaves a grey band).
  const ctx = await browser.newContext({
    ...dev, ...(video ? { deviceScaleFactor: 1, isMobile: false, recordVideo: { dir: video, size: dev.viewport } } : {}),
    colorScheme: "light", extraHTTPHeaders: { "x-forwarded-for": `198.18.12.${ip++ % 250}` },
  });
  await ctx.addInitScript(INIT, { draft: DRAFT });
  if (who) {
    const owner = who === "operator";
    const email = typeof who === "string" ? ACCOUNTS[who] : who.email;
    const password = typeof who === "string" ? LOGINS.passwords[who] : who.password;
    const r = await ctx.request.post(BASE + (owner ? "/api/owner/auth/login" : "/api/auth/login"), { data: { email, password }, headers: { origin: BASE } });
    if (!r.ok()) throw new Error(`sign-in failed for ${typeof who === "string" ? who : "the made-up firm"}: ${r.status()}`);
  }
  return ctx;
}
/** JSON API call in a context (same-origin header, as the portal sends). */
async function api(ctx, method, url, data) {
  const r = await ctx.request.fetch(BASE + url, { method, data, headers: { origin: BASE }, timeout: 120000 });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok()) throw new Error(`${method} ${url} → ${r.status()} ${t.slice(0, 160)}`);
  return j;
}
/** The id of the first group whose name matches `re`, as this context sees it. */
async function groupId(ctx, re) { return (await api(ctx, "GET", "/api/workspaces")).workspaces.find((w) => re.test(w.name))?.id; }
/** Opens Knowledge, Meetings and Memory on this group for the whole context (the portal's group picker). */
async function pinGroup(ctx, id) { if (id) await ctx.addInitScript((g) => { try { localStorage.setItem("sidekick.ws", g); } catch { /* private */ } }, id); }

async function go(page, url, wait = 900) {
  await page.goto(BASE + url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(wait);
}
/** Scrolls so the first element whose text matches `re` sits ~120 px below the top. */
async function scrollToText(page, re, offset = 120) {
  await page.evaluate(([src, flags, off]) => {
    const r = new RegExp(src, flags);
    const el = [...document.querySelectorAll("h1,h2,h3,h4,b,strong,td,li,p,span,a,button,label")].find((x) => r.test(x.textContent ?? ""));
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - off);
  }, [re.source, re.flags, offset]);
  await page.waitForTimeout(500);
}

/** Saves one screenshot as the next numbered shot and records it in the manifest. */
function snapper(page, flow, phone) {
  return async (name, caption, { full = false, wait = 500 } = {}) => {
    await page.waitForTimeout(wait);
    const dir = phone ? "phone" : "desktop";
    const file = prevFile(dir, name) ?? `${String(++n + (PREV?.shots.length ?? 0)).padStart(2, "0")}-${name}.png`;
    fs.mkdirSync(path.join(OUT, dir), { recursive: true });
    // One retry: a busy Mac sometimes times out a 2x/3x capture of the animated Home orb.
    const take = () => page.screenshot({ path: path.join(OUT, dir, file), fullPage: full, animations: "disabled" });
    await take().catch(async () => { await page.waitForTimeout(2000); await take(); });
    manifest.push({ file: `${dir}/${file}`, flow: flow.id, who: flow.whoLabel, size: phone ? "390×844 @3x" : "1440×900 @2x", caption });
    log("saved", `${dir}/${file}`);
  };
}

// ---------- the flows (CAPTURE-PLAN.md sections; order matters for the ones that change data) ----------
const FLOWS = [
  {
    id: "site", whoLabel: "visitor (signed out)",
    run: async ({ page, snap }) => {
      await go(page, "/"); await snap("site-home", "The public website: every meeting, remembered.");
      await go(page, "/pricing"); await snap("site-pricing", "Plans priced per group per month (illustrative pricing).");
    },
  },
  {
    id: "signup", whoLabel: "visitor → new Org Owner (made-up firm)",
    run: async ({ page, snap }) => {
      await go(page, "/signup?plan=team");
      await page.fill("#org", FIRM.org); await page.fill("#name", FIRM.owner); await page.fill("#email", FIRM.email); await page.fill("#password", FIRM.password);
      await snap("signup-form", "A made-up firm signs up: company, name, work email, password (shown as dots).");
      await page.getByRole("button", { name: "Create organization" }).click();
      await page.waitForURL(/checkout/, { timeout: 30000 }); await page.waitForLoadState("networkidle");
      await snap("signup-checkout", "Checkout in test mode: no money moves and no card details are asked for.");
      await page.getByRole("button", { name: /Pay \(test mode\)/ }).click();
      await page.waitForURL(/get-started/, { timeout: 30000 });
      // Two people exist before the wizard's group step, so the Team Lead is picked (no temporary password on screen).
      const ctx = page.context();
      for (const [name, role] of [["Priya Raman", "Member"], ["Sam Okafor", "Member"]]) {
        await api(ctx, "POST", "/api/users", { name, email: name.toLowerCase().replace(" ", ".") + "@lakeside.example", role, workspaces: [] });
      }
      await go(page, "/get-started", 1200);
      await snap("wizard-welcome", "The setup wizard: five short steps, can be left and picked up any time.");
      for (const [label, name, cap] of [
        ["Connect Microsoft 365", "wizard-microsoft-365", "Connect Microsoft 365 once so people sign in with their work account (the real sign-in needs Cody)."],
        ["Add to Teams", "wizard-teams", "Who may add Sidekick to a Teams chat (recommended: Team Leads and admins)."],
        ["Rules", "wizard-rules", "Pick a starting point for the guardrails."],
        ["First groups", "wizard-first-group", "The first group: one client team with its Team Lead."],
      ]) {
        await page.getByRole("button", { name: new RegExp(label) }).first().click();
        await page.waitForTimeout(700);
        if (name === "wizard-first-group") {
          await page.fill("#g-name-0", "Contoso Retail – Cloud Migration"); await page.fill("#g-client-0", "Contoso Retail");
          await page.selectOption("#g-lead-0", { label: "Priya Raman (Member)" }).catch(() => {});
        }
        await snap(name, cap);
      }
      await page.getByRole("button", { name: /^Create 1 group/ }).click();
      await page.getByText(/Created 1 group/).waitFor({ timeout: 20000 });
      await snap("wizard-group-created", "The group is created with Priya as its Team Lead.");
      await page.getByRole("button", { name: "Continue" }).click(); await page.waitForTimeout(800);
      await snap("wizard-done", "Setup done: what happens next.");
      await page.getByRole("button", { name: "Finish setup" }).click(); await page.waitForTimeout(1500);
    },
  },
  {
    id: "people", whoLabel: "Org Owner of the made-up firm",
    who: () => ({ email: FIRM.email, password: FIRM.password }),
    run: async ({ page, snap, ctx }) => {
      await go(page, "/users");
      await page.getByRole("button", { name: "Add person" }).first().click();
      await page.fill("#pname", "Maria Chen"); await page.fill("#pemail", "maria.chen@lakeside.example");
      await page.selectOption("#prole", { label: "Org Admin" }).catch(() => page.selectOption("#prole", { index: 1 }));
      await snap("people-add-person", "Add a person and pick their role.");
      await page.keyboard.press("Escape").catch(() => {});
      // Added through the API so the temporary password never appears on screen.
      for (const [name, role] of [["Maria Chen", "Org Admin"], ["Dev Patel", "Member"], ["Grace Park", "Viewer"]]) {
        await api(ctx, "POST", "/api/users", { name, email: name.toLowerCase().replace(" ", ".") + "@lakeside.example", role, workspaces: [] });
      }
      await go(page, "/users"); await snap("people-list", "Everyone with their role and how they sign in.");
      const g = await groupId(ctx, /Contoso/);
      await go(page, `/workspaces/${g}`);
      await page.getByRole("tab", { name: /People/ }).click();
      await page.getByRole("button", { name: "Add people" }).first().click(); await page.waitForTimeout(900);
      for (const nm of ["Sam Okafor", "Dev Patel", "Grace Park"]) await page.locator(".plist").getByText(nm, { exact: true }).first().click().catch(() => {});
      await snap("people-add-to-group", "Pick the group's people from the firm.");
      await page.getByRole("button", { name: /^Add \d/ }).click(); await page.waitForTimeout(1200);
      await snap("people-group", "The group's people and their roles.");
    },
  },
  {
    // The Org Owner: a Team Lead's "Assign a chat" lists only chats Teams says they added (none in the demo world).
    id: "teams-assign", whoLabel: "Org Owner (Olivia Bennett)", who: "orgOwner",
    run: async ({ page, snap, ctx }) => {
      const g = await groupId(ctx, /^Contoso/);
      await go(page, `/workspaces/${g}`);
      await page.getByRole("tab", { name: /Teams chats/ }).click(); await page.waitForTimeout(800);
      await snap("teams-group-chats", "Contoso's Teams chats: which chats Sidekick follows (one with client guests).");
      await page.getByRole("button", { name: "Assign a chat" }).click(); await page.waitForTimeout(1500);
      await snap("teams-assign-waiting-chat", "Assign a chat: the chats where Sidekick was added and waits for a group.");
      await page.locator('[role="dialog"] input[type=radio], [role="dialog"] [role="radio"]').first().click().catch(() => {});
      await page.waitForTimeout(500);
      await snap("teams-assign-picked", "Pick the waiting chat (with who added Sidekick and who's in it), then Assign.");
    },
  },
  {
    id: "ask", whoLabel: "Member (Maria Chen)", who: "member", group: /^Contoso/,
    run: async ({ page, snap }) => {
      await go(page, "/knowledge");
      await page.getByLabel("Question").fill("When is the wave 2 cutover, how many stores, and who owns the rollback?");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await page.waitForTimeout(1500);
      await page.getByRole("button", { name: "Ask", exact: true }).waitFor({ timeout: 120000 });
      await scrollToText(page, /^Ask /, 90);
      await snap("ask-answer-sources", "Ask in the portal: the answer with its sources.");
    },
  },
  {
    id: "meeting", whoLabel: "Team Lead (Priya Raman)", who: "teamLead", group: /^Contoso/,
    run: async ({ page, snap }) => {
      await go(page, "/meetings"); await snap("meetings-list", "Meetings: notes appear by themselves with automatic notes on.");
      await page.getByText(/Sprint 14 planning/).first().click(); await page.waitForTimeout(1500);
      await snap("meeting-notes", "Meeting notes: summary, decisions, open questions.");
      await scrollToText(page, /^Action items/);
      await snap("meeting-action-items", "Action items with owners and due dates.");
      // The first action item without an owner (else the first one).
      const owners = page.locator('input[placeholder="Assign owner"]');
      const i = await owners.evaluateAll((els) => els.findIndex((e) => !e.value));
      if (i >= 0) { const box = owners.nth(i); await box.fill("Sam Okafor"); await box.press("Tab"); await page.waitForTimeout(900); }
      const open = page.locator('input[type=checkbox][aria-label^="Done:"]:not(:checked)');
      if (await open.count()) await open.first().check();
      await page.waitForTimeout(1000);
      await snap("meeting-assign-done", "Assign an owner and mark one done (the same buttons are on the Teams card).");
    },
  },
  {
    id: "reminders", whoLabel: "Team Lead (Priya Raman)", who: "teamLead",
    run: async ({ page, snap }) => {
      await go(page, "/home", 1500); await scrollToText(page, /^Needs attention/, 80);
      await snap("reminders-needs-attention", "Needs attention: overdue and unowned items, a runbook a decision changed.");
      await go(page, "/memory", 1200); await page.getByRole("tab", { name: /Gaps/ }).click().catch(() => {}); await page.waitForTimeout(800);
      await snap("reminders-gaps", "Memory & gaps: what's out of date or never written down.");
    },
  },
  {
    id: "upload-guard", whoLabel: "Member (Maria Chen, in Contoso and Litware)", who: "member", group: /^Contoso/,
    run: async ({ page, snap }) => {
      await go(page, "/knowledge", 1200); await scrollToText(page, /Litware pipeline SLA notes/, 220);
      await snap("upload-guard-held", "A Litware file uploaded to Contoso is held: no Contoso answer can use it.");
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.locator("input[type=file]").first().setInputFiles({ name: "Contoso wave 3 store list.md", mimeType: "text/markdown", buffer: Buffer.from("# Contoso Retail wave 3 stores\n\nTwelve stores in the north region, cutover in January.\n") });
      await page.getByText("Which group is this for?").waitFor({ timeout: 8000 });
      await snap("upload-guard-which-group", "In two groups, Maria confirms the group for every upload.");
    },
  },
  {
    id: "jira", whoLabel: "Team Lead, then Member (Maria Chen)", who: "teamLead",
    run: async ({ page, snap, browser, phone }) => {
      // The Team Lead switches Contoso's Jira to "each person signs in" (Connectors page), then Maria connects her own.
      await go(page, "/connectors", 1200);
      // The "Each person signs in" button under the Jira heading (the page lists each tool type in turn).
      const buttons = page.getByRole("button", { name: "Each person signs in" });
      const i = await buttons.evaluateAll((els) => {
        const tools = /^(Azure DevOps|Jira|GitHub|Confluence|Microsoft 365.*)$/;
        let tool = null; const at = new Map();
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        for (let el = walk.nextNode(); el; el = walk.nextNode()) {
          if (!el.children.length && tools.test((el.textContent ?? "").trim())) tool = el.textContent.trim();
          if (els.includes(el)) at.set(el, tool);
        }
        return els.findIndex((el) => at.get(el) === "Jira");
      });
      if (i < 0) throw new Error("no Jira connection with a Who sees what switch on Connectors");
      page.once("dialog", (d) => d.accept());
      await buttons.nth(i).scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, 160));
      await buttons.nth(i).click(); await page.waitForTimeout(1500);
      await snap("jira-each-person", "The Team Lead switches Jira to \"each person signs in\".");
      const m = await context(browser, "member", { phone });
      const c = await groupId(m, /^Contoso/); await pinGroup(m, c);
      const p = await m.newPage();
      await go(p, "/knowledge", 1200);
      await p.getByLabel("Question").fill("Which Jira tickets block the payment gateway cutover?");
      await p.getByRole("button", { name: "Ask", exact: true }).click();
      await p.waitForTimeout(1500); await p.getByRole("button", { name: "Ask", exact: true }).waitFor({ timeout: 120000 });
      await scrollToText(p, /Connect your Jira|^Ask /, 90);
      await snapper(p, { id: "jira", whoLabel: "Member (Maria Chen)" }, phone)("jira-connect-your-jira", "An answer that left Jira out says so: \"Connect your Jira\".");
      await go(p, "/knowledge#signins", 900); await scrollToText(p, /Your sign-ins|sign-ins to tools/i, 90);
      const connect = p.getByRole("link", { name: /^Connect/ }).or(p.getByRole("button", { name: /^Connect/ })).first();
      await connect.click(); await p.waitForURL(/signedin=|knowledge/, { timeout: 20000 }); await p.waitForTimeout(1500);
      await scrollToText(p, /Your sign-ins|sign-ins to tools/i, 90);
      await snapper(p, { id: "jira", whoLabel: "Member (Maria Chen)" }, phone)("jira-connected", "Maria's own Jira is connected: answers now include what she can open.");
      await m.close();
    },
  },
  ...["orgOwner", "orgAdmin", "teamLead", "member", "viewer"].map((role) => ({
    id: "roles", whoLabel: role, who: role, group: /^Contoso/,
    run: async ({ page, snap }) => {
      // Home below the live orb: the stat cards and Needs attention differ by role (the menu on the left too).
      await go(page, "/home", 2000); await scrollToText(page, /^Recent meetings$/, 260); await snap(`role-${role}-home`, `${role}: Home (menu, numbers and Needs attention for this role).`);
      await go(page, "/workspaces", 1000);
      await snap(`role-${role}-groups`, role === "member" ? "Maria is in two groups (Contoso and Litware) and never sees the other eight." : `${role}: the groups this role sees.`);
      if (role === "viewer") { await go(page, "/knowledge", 1000); await snap("role-viewer-knowledge", "A Viewer reads and asks, with no upload."); }
    },
  })),
  {
    id: "roles", whoLabel: "Member in one group", who: "singleMember",
    run: async ({ page, snap }) => { await go(page, "/home", 2000); await scrollToText(page, /^Recent meetings$/, 260); await snap("role-member-one-group-home", "A Member in one group: only that client's work."); },
  },
  {
    id: "phone", whoLabel: "Team Lead (Priya Raman), phone", who: "teamLead", phone: true, group: /^Contoso/,
    run: async ({ page, snap }) => {
      await go(page, "/home", 2000); await snap("phone-home", "Home on a phone.");
      await page.getByRole("button", { name: /menu/i }).first().click().catch(() => {}); await page.waitForTimeout(700);
      await snap("phone-menu", "The phone menu.");
      await go(page, "/meetings", 1000); await page.getByText(/Sprint 14 planning/).first().click().catch(() => {}); await page.waitForTimeout(1500);
      await snap("phone-meeting-notes", "Meeting notes on a phone.");
      await go(page, "/knowledge", 1000); await snap("phone-knowledge", "Knowledge and Ask on a phone.");
      const g = await groupId(page.context(), /^Contoso/);
      await go(page, `/workspaces/${g}`, 1200); await snap("phone-group", "A group on a phone.");
    },
  },
  {
    id: "owner", whoLabel: "Owner Console operator", who: "operator",
    run: async ({ page, snap }) => {
      await go(page, "/owner", 1500); await snap("owner-overview", "Owner Console: every client firm at a glance.");
      await go(page, "/owner/clients", 1200); await snap("owner-clients", "All client firms (the made-up Lakeside Advisory just signed up).");
      await go(page, "/owner/business", 1500); await snap("owner-business", "Business: revenue, plan mix, trials, AI credit.");
      await go(page, "/owner/performance", 1500); await snap("owner-ai-usage", "AI usage and performance per client (counts, never content).");
      await go(page, "/owner/support", 1200); await snap("owner-tickets", "The support inbox: tickets from every role.");
    },
  },
];

/** Short desktop clips (with --clips): run after the screenshots on the data they left behind. */
const CLIP_FLOWS = [
  { id: "clip-meeting", who: "teamLead", group: /^Contoso/, run: async ({ page }) => {
    await go(page, "/meetings", 1500); await page.getByText(/Sprint 14 planning/).first().click(); await page.waitForTimeout(2500);
    await scrollToText(page, /^Decisions/); await page.waitForTimeout(2000); await scrollToText(page, /^Action items/); await page.waitForTimeout(2000);
    await page.locator('input[type=checkbox][aria-label^="Done:"]').nth(1).check().catch(() => {}); await page.waitForTimeout(2500);
  } },
  { id: "clip-ask", who: "member", group: /^Contoso/, run: async ({ page }) => {
    await go(page, "/knowledge", 1200);
    await page.getByLabel("Question").pressSequentially("How do we roll a store back?", { delay: 45 });
    await page.getByRole("button", { name: "Ask", exact: true }).click(); await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Ask", exact: true }).waitFor({ timeout: 120000 }); await scrollToText(page, /^Ask /, 90); await page.waitForTimeout(3000);
  } },
  { id: "clip-upload-guard", who: "member", group: /^Contoso/, run: async ({ page }) => {
    await go(page, "/knowledge", 1500); await scrollToText(page, /Litware pipeline SLA notes/); await page.waitForTimeout(2500);
    await page.getByRole("button", { name: /Move to Litware/ }).first().click().catch(() => {}); await page.waitForTimeout(3000);
  } },
  { id: "clip-owner", who: "operator", run: async ({ page }) => {
    for (const u of ["/owner", "/owner/clients", "/owner/business", "/owner/support"]) { await go(page, u, 2500); }
  } },
];

async function resolveWho(flow, browser) {
  if (typeof flow.who === "function") return flow.who();
  if (flow.who !== "singleMember") return flow.who;
  // A Member in exactly one group (the seed gives the others a shared password, kept in .demo-logins.json).
  const owner = await context(browser, "orgOwner");
  const people = (await api(owner, "GET", "/api/users")).users ?? [];
  await owner.close();
  for (const u of people.filter((x) => x.role === "Member" && x.email !== ACCOUNTS.member)) {
    const c = await browser.newContext();
    const r = await c.request.post(BASE + "/api/auth/login", { data: { email: u.email, password: LOGINS.peoplePassword }, headers: { origin: BASE } });
    await c.close();
    if (r.ok()) return { email: u.email, password: LOGINS.peoplePassword };
  }
  throw new Error("no Member with the shared demo password");
}

async function runFlow(browser, flow, { video } = {}) {
  const phone = !!flow.phone;
  const ctx = flow.who ? await context(browser, await resolveWho(flow, browser), { phone, video }) : await context(browser, null, { phone, video });
  if (flow.group) await pinGroup(ctx, await groupId(ctx, flow.group));
  const page = await ctx.newPage();
  try {
    await flow.run({ page, ctx, browser, phone, snap: snapper(page, flow, phone) });
  } catch (e) {
    const msg = `${flow.id} (${flow.whoLabel ?? flow.who}): ${e.message.split("\n")[0]}`;
    problems.push(msg); log("!! flow failed:", msg);
    await page.screenshot({ path: path.join(OUT, `_failed-${flow.id}-${n}.png`) }).catch(() => {});
  }
  const vid = page.video();
  await ctx.close();
  return vid ? vid.path() : null;
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  // Fails early (with a clear message) if the demo copy isn't running or wasn't seeded with these logins.
  await (await context(browser, "orgOwner")).close();
  // The demo world keeps self-service sign-up off (the platform default); the operator opens it for the website and
  // sign-up shots (Pricing then shows the plans' sign-up buttons instead of "Sign-up isn't open yet").
  if (!ONLY.length || ONLY.includes("site") || ONLY.includes("signup")) {
    const op = await context(browser, "operator");
    await api(op, "POST", "/api/owner/releases", { key: "signup", enabled: true });
    await op.close();
  }
  for (const flow of FLOWS) if (!ONLY.length || ONLY.includes(flow.id)) await runFlow(browser, flow);
  if (CLIPS) {
    const dir = path.join(OUT, "clips"); fs.mkdirSync(dir, { recursive: true });
    for (const flow of CLIP_FLOWS) {
      if (ONLY.length && !ONLY.includes(flow.id)) continue;
      const tmp = path.join(dir, "_raw"); const file = await runFlow(browser, flow, { video: tmp });
      if (file) { fs.renameSync(file, path.join(dir, `${flow.id}.webm`)); manifest.push({ file: `clips/${flow.id}.webm`, flow: flow.id, who: flow.who, size: "1440×900 @1x", caption: "clip" }); log("saved", `clips/${flow.id}.webm`); }
    }
    fs.rmSync(path.join(dir, "_raw"), { recursive: true, force: true });
  }
  await browser.close();
  // With an earlier capture in the folder: its entries, with the re-run flows' entries replaced (same order).
  const shots = PREV ? [...PREV.shots.filter((s) => !ONLY.includes(s.flow)).concat(manifest)].sort((a, b) => (PREV.shots.findIndex((s) => s.file === a.file) + 1 || 1e6) - (PREV.shots.findIndex((s) => s.file === b.file) + 1 || 1e6)) : manifest;
  const allProblems = PREV ? [...(PREV.problems ?? []).filter((p) => !ONLY.some((f) => p.startsWith(`${f} (`))), ...problems] : problems;
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ base: BASE, draft: DRAFT, taken: new Date().toISOString(), ...(PREV ? { redone: { flows: ONLY, at: new Date().toISOString() } } : {}), shots, problems: allProblems }, null, 1));
  if (DRAFT) fs.writeFileSync(path.join(OUT, "README - DRAFT.md"), `# DRAFT capture, ${today}\n\nNot for the pitch or website. A dry run of CAPTURE-PLAN.md on the local demo world (made-up data, fake Claude), taken with app/scripts/capture-walkthrough.mjs --draft. Every shot carries a red DRAFT tag. See manifest.json for captions.\n`);
  log(`\n${manifest.length} files in ${OUT}${problems.length ? `\n${problems.length} flow(s) failed:\n- ${problems.join("\n- ")}` : ""}`);
})().catch((e) => { console.error(e); process.exit(1); });
