/**
 * A fake Azure DevOps, Jira Cloud, GitHub, Confluence Cloud and Microsoft Graph (SharePoint, OneDrive) on one small
 * local HTTP server, for the automated tests (tests/api.test.mjs) and the demo world (scripts/seed-demo.mjs). No
 * real accounts, nothing leaves this Mac.
 *
 * It speaks just enough of each real API for Sidekick's connectors (lib/connector-ado.ts, lib/connector-jira.ts,
 * lib/connector-github.ts, lib/connector-confluence.ts, lib/connector-m365.ts):
 * - **Microsoft sign-in for ADO** (`/ado-login/<tenant>/oauth2/v2.0/authorize|token`): the authorize page approves
 *   at once and redirects back with a code; the token endpoint checks the client secret and PKCE, and issues
 *   access tokens (lifetime `state.ttl` seconds) and refresh tokens.
 * - **ADO REST** (`/ado/<org>/...`): project list in pages (`x-ms-continuationtoken`, `state.adoProjectPage` per
 *   page), WIQL with `[System.ChangedDate] > '<time>'`, workitemsbatch (with relations: "blocked by" links and
 *   parents), and comments.
 * - **Atlassian sign-in** (`/jira-auth/authorize`, `/jira-auth/oauth/token`): like the real one, refresh tokens
 *   **rotate** (each refresh returns a new one and the old one stops working).
 * - **Jira REST** (`/jira-api/oauth/token/accessible-resources`, `/jira-api/ex/jira/<cloud id>/rest/api/3/...`):
 *   paged project search (`state.jiraProjectPage`) and the enhanced JQL search with `nextPageToken`
 *   (`state.jiraIssuePage`), with `project = "KEY"` and `updated >= "yyyy/MM/dd HH:mm"`.
 * - **GitHub sign-in** (`/gh-login/login/oauth/authorize|access_token`): a GitHub App's user authorization with
 *   PKCE; like the real one, errors come back as **200** with an `error` field (`bad_refresh_token`), and refresh
 *   tokens rotate.
 * - **GitHub REST** (`/gh-api/...`): `/user`, `/user/installations` and each installation's repositories, the
 *   issues list (issues and pull requests, `since`, `sort=updated&direction=asc`) and comments, all paged with a
 *   `Link: <…>; rel="next"` header (`state.githubPage` per page).
 * - **Confluence** (`/confluence-auth/...`, `/confluence-api/...`): the Atlassian sign-in again (same app ids as Jira,
 *   rotating refresh tokens), accessible resources with Confluence scopes, v2 spaces (`_links.next`,
 *   `state.confluenceSpacePage`) and CQL content search (`space = "KEY" AND type = page AND lastmodified >= …`,
 *   `state.confluencePage` per page).
 * - **Microsoft sign-in for Microsoft 365** (`/m365-login/<tenant>/oauth2/v2.0/authorize|token`): like ADO's (PKCE,
 *   the refresh token stays the same), its own app ids.
 * - **Microsoft Graph** (`/graph/...`): `/organization` (the tenant, `world.m365.tenantId`), `/sites?search=*` in pages
 *   (`state.graphSitePage`), each site's `/drives`, a drive's `root/children`, one item (with `parentReference.path`),
 *   `/me/drive/sharedWithMe`, and **delta queries** (`/drives/<id>/root/delta`): every item has a change number
 *   (`seq`), a delta link carries the last one seen, pages of `state.graphDeltaPage` follow `@odata.nextLink`, and
 *   deleted items come back as `deleted` (no paths in delta, like the real one). `/content` answers 302 to a
 *   pre-authenticated `/m365-download/...` address (`counts.downloads`; `counts.downloadAuth` counts downloads that
 *   wrongly carried the token). Files are real Word, PDF and PowerPoint files built here (`office`).
 * - **Web pages** (`/ado-web/...`, `/jira-web/...`, `/gh-web/...`, `/confluence-web/...`, `/m365-web/...`): a plain
 *   page per item, so links in the demo open something.
 *
 * **People** ("each person signs in", lib/connector-access.ts): `signInAs(name)` makes the **next** sign-in a named
 * person's (otherwise it's the shared account, which sees everything). A person's tokens only see what they may:
 * an item (Jira issue, ADO work item) with `viewers: [names]` is open only to those people (`viewers` absent = open
 * to everyone who can open the site), a Jira site or ADO organization with `members: [names]` only to its members.
 * Their own token reaches Jira's `myself` and `issue/bulkfetch` (keys they can't open come back in `issueErrors`) and
 * ADO's `connectionData` and `workitemsbatch` with `errorPolicy: "Omit"` (null for items they can't read).
 * Microsoft 365: a file or folder with `viewers` is open only to those people (a folder's list covers everything
 * under it), a drive with `members` only to its members; a person's `GET /drives/<d>/items/<id>` answers 404 (403 for
 * the drive) otherwise, and `POST /graph/$batch` runs such GETs (`state.graphBatchStatus` forces every reply's status,
 * e.g. 429). Microsoft sign-ins remember the tenant in the sign-in address: `/organization` answers that tenant for
 * a person signed in at a tenant id (`state.m365Tenants` lists the ones that sign-ins went to), and a refresh at a
 * different tenant than the sign-in's is refused.
 * GitHub: a repository is private unless it has `visibility: "public"`; a private one with `members: [names]` is
 * open only to them (no list = everyone). A person's `GET /repos/{owner}/{repo}` (and its issues) answers 404
 * otherwise, like the real one; `/user` answers that person. Confluence: a page with `viewers` is open only to those
 * people (a page restriction), a site with `members` only to its members; a person's CQL search leaves out what
 * they can't view, including `id in (…)` searches, and `wiki/rest/api/user/current` answers that person.
 * `revokeUser(kind, name)` revokes one person's sign-in (their calls 401, their refreshes fail); `counts.personal`
 * counts their API calls.
 *
 * Test controls: `revoke(kind)` (sign-in revoked: API calls 401, refreshes fail), `deny(kind, project)` (403 for one
 * project, repository or space), `rateLimit(kind, { times, retryAfter, status })` (the next `times` API calls answer
 * "slow down" with `Retry-After`), `state.githubEvilNext` (the issues list's next link points off the API: it must
 * never be followed; `counts.evil` counts tries), `state.ttl` (make tokens run out), `counts` (token refreshes, API
 * calls), and the `world` object itself (add or change items; set `changed`/`updated` to now so the next sync picks
 * them up; Microsoft 365 files: `m365File(driveId, …)`, `m365Touch(item)`, `m365Delete(item)`, and
 * `state.graphDeltaGone` for one 410 "delta token expired").
 *
 * Use: `const fake = createFakeTools(); const base = await fake.listen(); env = { ...fake.env(base) }`.
 * Standalone (the demo): `node scripts/fake-tools.mjs --port 3331` (or FAKE_TOOLS_PORT=3331; the demo launch config
 * uses the variable so the preview tool only sees the app's own --port).
 */
import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";

const day = 86400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const dueIn = (days) => new Date(Date.now() + days * day).toISOString().slice(0, 10);

/* ---------- real (tiny) Office files, so Sidekick's own extraction reads them ---------- */

/** A zip of `files` (name → text), deflated, with a central directory (what Word and PowerPoint files are). */
function zipOf(files) {
  const parts = [], dir = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data), n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    parts.push(h, n, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    dir.push(c, n);
    off += 30 + n.length + comp.length;
  }
  const d = Buffer.concat(dir), e = Buffer.alloc(22), count = Object.keys(files).length;
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(count, 8); e.writeUInt16LE(count, 10); e.writeUInt32LE(d.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, d, e]);
}
const xml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Builders for made-up files: `office.docx(paragraphs)`, `office.pdf(lines)` (one page), `office.pptx(slides)` (each a list of text boxes). */
export const office = {
  docx: (paras) => zipOf({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${xml(p)}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`,
  }),
  pdf: (lines) => {
    const esc = (t) => t.replace(/[\\()]/g, (m) => `\\${m}`);
    const stream = `BT /F1 12 Tf 72 720 Td 14 TL ${lines.map((l) => `(${esc(l)}) '`).join(" ")} ET`;
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let out = "%PDF-1.4\n";
    const offs = [];
    objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const x = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
  },
  pptx: (slides) => zipOf(Object.fromEntries(slides.map((boxes, i) => [
    `ppt/slides/slide${i + 1}.xml`,
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${boxes.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${xml(t)}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`,
  ]))),
};

/** The made-up world: Northwind's ADO organization, Jira site, GitHub repositories, Confluence spaces and SharePoint (shared by the tests and the demo). */
export function defaultWorld() {
  // Microsoft 365: one drive item. `content` is a function so big files are only built when downloaded.
  let seq = 0;
  const f = (id, name, parent, modified, by, content, size) => ({ id, name, parent, modified, by, content, size, seq: ++seq });
  const dir = (id, name, parent) => ({ id, name, parent, folder: true, modified: iso(9 * day), by: "Ana Ruiz", seq: ++seq });
  return {
    ado: {
      orgs: {
        northwind: {
          projects: [
            {
              name: "Wave 2 Cutover",
              items: [
                { id: 4810, type: "Task", title: "Firewall change request for the payment gateway", state: "New", assignedTo: null, due: dueIn(3), changed: iso(5 * day), description: "<p>Open port 8443 from the store network to the new payment gateway. Waiting on the network team's change board.</p>", tags: ["network"], comments: [], blockedBy: [], parent: 4800 },
                { id: 4821, type: "Bug", title: "Payment gateway cutover blocked by firewall rule", state: "Active", assignedTo: "Priya Shah", due: dueIn(5), changed: iso(2 * day), description: "<p>The <b>cutover of the payment gateway</b> for wave 2 can't start until the firewall rule is in place.</p>", tags: ["Blocked", "cutover"], comments: [{ by: "Priya Shah", at: iso(2 * day), text: "<p>Change board meets Thursday; asked for an emergency slot.</p>" }, { by: "Marcus Lee", at: iso(3 * day), text: "<p>Without this the Nov 12 cutover slips.</p>" }], blockedBy: [4810], parent: 4800 },
                { id: 4800, type: "Feature", title: "Wave 2 store cutover (48 stores)", state: "Active", assignedTo: "Marcus Lee", due: dueIn(20), changed: iso(6 * day), description: "<p>Move 48 stores to the new point-of-sale platform on November 12.</p>", tags: [], comments: [], blockedBy: [], parent: null },
                { id: 4833, type: "User Story", title: "Rollback runbook for the cutover weekend", state: "Resolved", assignedTo: "Ana Ruiz", due: dueIn(-2), changed: iso(4 * day), description: "<p>Steps to roll back a store within 30 minutes.</p>", tags: [], comments: [], blockedBy: [], parent: 4800 },
                { id: 4840, type: "Task", title: "Train store managers on the new tills", state: "New", assignedTo: null, due: dueIn(-1), changed: iso(7 * day), description: "<p>Two-hour session per region before go-live.</p>", tags: [], comments: [], blockedBy: [], parent: 4800 },
              ],
            },
            { name: "Data Platform", items: [{ id: 5101, type: "Task", title: "Nightly sales export to the data lake", state: "Active", assignedTo: "Dev Patel", due: null, changed: iso(1 * day), description: "<p>Export runs at 02:00.</p>", tags: [], comments: [], blockedBy: [], parent: null }] },
            { name: "Internal Tools", items: [] },
          ],
        },
      },
    },
    jira: {
      sites: [
        {
          id: "11111111-aaaa-4bbb-8ccc-000000000001",
          name: "northwind",
          projects: [
            {
              key: "STORE",
              name: "Store Systems",
              issues: [
                { key: "STORE-12", type: "Task", summary: "Price file feed for wave 2 stores", status: "In Progress", assignee: "Lena Fischer", duedate: dueIn(4), updated: iso(1 * day), description: "Load the new price file into every wave 2 store the night before cutover.", labels: ["cutover"], comments: [{ by: "Lena Fischer", at: iso(1 * day), text: "Feed tested in two pilot stores." }], blockedBy: [] },
                { key: "STORE-15", type: "Bug", summary: "Receipt printer driver crashes on the new tills", status: "To Do", assignee: null, duedate: dueIn(2), updated: iso(2 * day), description: "Seen in the pilot store in Leeds.", labels: [], comments: [], blockedBy: ["STORE-16"] },
                { key: "STORE-16", type: "Task", summary: "Vendor patch for the receipt printer driver", status: "Waiting for vendor", assignee: "Tom Baker", duedate: dueIn(6), updated: iso(3 * day), description: "Vendor promised a patch next week.", labels: ["vendor"], comments: [], blockedBy: [] },
                { key: "STORE-9", type: "Story", summary: "Store opening checklist", status: "Done", assignee: "Ana Ruiz", duedate: null, updated: iso(9 * day), description: "", labels: [], comments: [], blockedBy: [] },
              ],
            },
            { key: "OPS", name: "Operations", issues: [] },
          ],
        },
      ],
    },
    github: {
      user: { id: 90001, login: "northwind-dev" },
      installations: [
        {
          id: 501,
          repos: [
            {
              full_name: "northwind/store-pos",
              issues: [
                { number: 41, title: "Receipt printer times out on the new tills", state: "open", pr: false, assignees: ["lena-fischer"], labels: ["bug", "cutover"], milestone: { title: "Wave 2", due_on: `${dueIn(10)}T07:00:00Z` }, updated: iso(1 * day), body: "Tills in the Leeds pilot store wait 30 seconds for the receipt printer.\n<!-- template: bug -->", comments: [{ by: "tom-baker", at: iso(2 * day), text: "Seen twice on Saturday." }, { by: "lena-fischer", at: iso(1 * day), text: "Vendor driver 2.4.1 fixes it in the lab." }] },
                { number: 42, title: "Offline mode for card payments", state: "open", pr: true, merged: false, draft: false, assignees: ["priya-shah"], labels: ["payments"], milestone: { title: "Wave 2", due_on: `${dueIn(10)}T07:00:00Z` }, updated: iso(2 * day), body: "Queues card payments while the payment gateway can't be reached and replays them afterwards.", comments: [] },
                { number: 38, title: "Till firmware 5.2", state: "closed", pr: true, merged: true, draft: false, assignees: ["dev-patel"], labels: [], milestone: null, updated: iso(6 * day), body: "", comments: [] },
                { number: 35, title: "Store opening checklist screen", state: "closed", pr: false, assignees: [], labels: ["ui"], milestone: null, updated: iso(9 * day), body: "Checklist shown when a manager opens the till in the morning.", comments: [] },
              ],
            },
            { full_name: "northwind/data-pipeline", issues: [{ number: 7, title: "Nightly sales export fails on public holidays", state: "open", pr: false, assignees: [], labels: ["bug"], milestone: null, updated: iso(3 * day), body: "The 02:00 export skips days marked as holidays.", comments: [] }] },
            { full_name: "northwind/internal-wiki", issues: [] },
          ],
        },
      ],
    },
    confluence: {
      sites: [
        {
          id: "11111111-aaaa-4bbb-8ccc-000000000001",
          name: "northwind",
          spaces: [
            {
              key: "CUT",
              name: "Wave 2 Cutover",
              pages: [
                { id: "98301", title: "Cutover weekend runbook", updated: iso(2 * day), by: "Ana Ruiz", ancestors: ["Wave 2 Cutover"], labels: ["runbook", "cutover"], body: "<h2>Friday</h2><p>22:00: freeze the price files.</p><h2>Saturday</h2><p>06:00: switch the stores in batches of 12. Roll a store back within 30 minutes if the payment gateway check fails.</p>" },
                { id: "98302", title: "Store batch schedule", updated: iso(3 * day), by: "Marcus Lee", ancestors: ["Wave 2 Cutover"], labels: [], body: "<table><tr><td>Batch 1</td><td>Leeds, York, Hull</td></tr><tr><td>Batch 2</td><td>Bristol, Bath</td></tr></table>" },
                { id: "98303", title: "Decision log", updated: iso(5 * day), by: "Priya Shah", ancestors: ["Wave 2 Cutover"], labels: ["decisions"], body: "<p>2026-10-14: the three airport stores keep their old tills until January.</p>" },
              ],
            },
            { key: "OPS", name: "Store Operations", pages: [] },
          ],
        },
      ],
    },
    m365: {
      // The demo world's made-up Microsoft tenant (scripts/seed-demo.mjs links Northwind to it), so reconnecting in the demo works.
      tenantId: "00000000-demo-4000-8000-000000000001",
      tenantName: "Northwind Traders",
      seq: () => ++seq,
      sites: [
        {
          id: "northwind.sharepoint.example,site-ops", displayName: "Store Operations",
          drives: [
            {
              id: "b!ops-documents", name: "Documents", driveType: "documentLibrary",
              items: [
                dir("cut-folder", "Wave 2 Cutover", null),
                f("cut-plan", "Cutover plan.docx", "cut-folder", iso(2 * day), "Ana Ruiz", () => office.docx(["Wave 2 cutover plan", "Stores switch in batches of 12 on Saturday from 06:00.", "The payment gateway check must pass before a batch goes live; otherwise roll the store back within 30 minutes."])),
                f("cut-checklist", "Go-live checklist.pdf", "cut-folder", iso(3 * day), "Marcus Lee", () => office.pdf(["Go-live checklist", "1. Price files frozen at 22:00 Friday.", "2. Store managers trained on the new tills."])),
                f("cut-deck", "Steering committee deck.pptx", "cut-folder", iso(4 * day), "Priya Shah", () => office.pptx([["Wave 2 steering committee"], ["Budget: 1.2M approved", "Risk: firewall change for the payment gateway"]])),
                f("cut-notes", "Open questions.txt", "cut-folder", iso(5 * day), "Priya Shah", () => Buffer.from("Do the airport stores move in wave 2? Decision due Thursday.")),
                f("cut-budget", "Budget.xlsx", "cut-folder", iso(5 * day), "Priya Shah", () => Buffer.from("not a spreadsheet Sidekick reads")),
                // Metadata says 80 MB: never downloaded, kept as a "not read" note.
                f("cut-photos", "Store survey photos.pdf", "cut-folder", iso(6 * day), "Dev Patel", () => Buffer.from("never downloaded"), 80 * 1024 * 1024),
                f("ops-handbook", "Store operations handbook.docx", null, iso(8 * day), "Ana Ruiz", () => office.docx(["Store operations handbook", "Every store opens at 08:00 and runs the till check before the doors open."])),
              ],
            },
          ],
        },
        { id: "northwind.sharepoint.example,site-empty", displayName: "Internal Wiki", drives: [{ id: "b!wiki-documents", name: "Documents", driveType: "documentLibrary", items: [] }] },
      ],
      onedrive: {
        id: "b!priya-onedrive", name: "OneDrive", driveType: "business",
        items: [dir("handover", "Priya handover", null), f("handover-notes", "Handover notes.md", "handover", iso(1 * day), "Priya Shah", () => Buffer.from("# Handover\nThe vendor patch for the receipt printer lands next week."))],
      },
      // Folders shared with the connecting account: [drive id, folder id, shared by].
      shared: [["b!priya-onedrive", "handover", "Priya Shah"]],
    },
  };
}

/** Atlassian Document Format for a plain string (one paragraph), like Jira sends descriptions and comments. */
const adf = (text) => (text ? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } : null);

/**
 * Creates the fake tools server. `world` is the data it serves (see `defaultWorld`); `clients` the app ids and
 * secrets it accepts. Returns controls (see the file comment).
 */
export function createFakeTools({
  world = defaultWorld(),
  clients = {
    ado: { id: "fake-ado-client", secret: "fake-ado-secret" }, jira: { id: "fake-jira-client", secret: "fake-jira-secret" }, github: { id: "fake-github-client", secret: "fake-github-secret" },
    // Confluence uses the same Atlassian app as Jira (lib/connector-confluence.ts falls back to the Jira app ids).
    confluence: { id: "fake-jira-client", secret: "fake-jira-secret" },
    m365: { id: "fake-m365-client", secret: "fake-m365-secret" },
  },
  lenient = false,
} = {}) {
  const state = { ttl: 3600, adoProjectPage: 100, jiraProjectPage: 50, jiraIssuePage: 50, githubPage: 100, confluenceSpacePage: 250, confluencePage: 25, githubEvilNext: false, graphSitePage: 100, graphDeltaPage: 200, graphDeltaGone: false, graphBatchStatus: null, m365Tenants: [] };
  const counts = { refresh: { ado: 0, jira: 0, github: 0, confluence: 0, m365: 0 }, api: { ado: 0, jira: 0, github: 0, confluence: 0, m365: 0 }, personal: { ado: 0, jira: 0, github: 0, confluence: 0, m365: 0 }, unauthorized: 0, limited: 0, evil: 0, downloads: 0, downloadAuth: 0 };
  let nextUser = null; // signInAs: the next sign-in's person (null = the shared account)
  const revokedUsers = new Set(); // `${kind}:${name}`
  const limits = new Map(); // kind → { times, retryAfter, status }
  const codes = new Map(); // code → { kind, challenge, redirectUri }
  const access = new Map(); // token → { kind, expires }
  const refresh = new Map(); // token → { kind }
  const revokedKinds = new Set();
  const denied = new Set(); // `${kind}:${project}`
  let base = "";

  const newToken = (p) => `${p}_${crypto.randomBytes(18).toString("base64url")}`;
  const issue = (kind, user = null, tenant = null) => {
    const a = newToken(`${kind}at`);
    const r = newToken(`${kind}rt`);
    access.set(a, { kind, user, tenant, expires: Date.now() + state.ttl * 1000 });
    refresh.set(r, { kind, user, tenant });
    return { access_token: a, refresh_token: r, expires_in: state.ttl, token_type: "Bearer" };
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://fake");
      const path = decodeURIComponent(url.pathname);
      const send = (status, json, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(json));
      };
      const html = (text) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><meta charset="utf-8"><title>${text}</title><body style="font-family:system-ui;padding:40px"><p style="color:#888">Made-up demo tool (no real account)</p><h1>${text}</h1></body>`);
      };
      let who = null; // the person whose token made this call (null = the shared account)
      let whoTenant = null; // the Microsoft tenant a person's Microsoft 365 token was issued at (null = "organizations")
      const authed = (kind) => {
        const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        // Lenient (the standalone demo fake): tokens it handed out before a restart still work.
        const t = access.get(tok) ?? (lenient && tok.startsWith(`${kind}at_`) ? { kind, expires: Infinity } : undefined);
        if (!t || t.kind !== kind || t.expires < Date.now() || (t.user ? revokedUsers.has(`${kind}:${t.user}`) : revokedKinds.has(kind))) {
          counts.unauthorized++;
          send(401, { message: "Unauthorized" });
          return false;
        }
        const lim = limits.get(kind);
        if (lim && lim.times > 0) {
          lim.times--;
          counts.limited++;
          const h = { "retry-after": String(lim.retryAfter) };
          if (lim.status === 403) Object.assign(h, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.ceil(Date.now() / 1000) + lim.retryAfter) });
          send(lim.status, { message: "API rate limit exceeded" }, h);
          return false;
        }
        who = t.user ?? null;
        whoTenant = t.tenant ?? null;
        if (who && counts.personal[kind] !== undefined) counts.personal[kind]++;
        else counts.api[kind]++;
        return true;
      };
      /** Whether the caller may open something with `viewers` / `members` lists (see the file comment). */
      const sees = (x) => !who || !x?.viewers || x.viewers.includes(who);
      const member = (x) => !who || !x?.members || x.members.includes(who);
      /** Microsoft 365: the caller may open a file or folder if it and every folder above it let them (`viewers`). */
      const m365Sees = (drive, it) => {
        for (let cur = it; cur; cur = drive.items.find((x) => x.id === cur.parent)) if (!sees(cur)) return false;
        return true;
      };
      const m365Member = (drive) => member(drive);
      const link = (next) => (next ? { link: `<${next}>; rel="next"` } : {});

      // ---- sign-in pages (approve at once) ----
      let m;
      const kindOfPath = (p) => (p.startsWith("/ado") ? "ado" : p.startsWith("/m365") ? "m365" : p.startsWith("/gh") ? "github" : p.startsWith("/confluence") ? "confluence" : "jira");
      if (req.method === "GET" && ((m = path.match(/^\/(ado|m365)-login\/[^/]+\/oauth2\/v2\.0\/authorize$/)) || path === "/jira-auth/authorize" || path === "/gh-login/login/oauth/authorize" || path === "/confluence-auth/authorize")) {
        const kind = kindOfPath(path);
        const q = url.searchParams;
        if (q.get("client_id") !== clients[kind].id) return send(400, { error: "invalid_client" });
        const code = crypto.randomUUID();
        const tenant = kind === "m365" ? path.split("/")[2] : null;
        if (tenant) state.m365Tenants.push(`${tenant} ${q.get("scope")}`);
        codes.set(code, { kind, challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri"), user: nextUser, tenant: tenant && tenant !== "organizations" ? tenant : null });
        nextUser = null;
        const back = new URL(q.get("redirect_uri"));
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      // ---- token endpoints ----
      if (req.method === "POST" && (/^\/(ado|m365)-login\/[^/]+\/oauth2\/v2\.0\/token$/.test(path) || path === "/jira-auth/oauth/token" || path === "/gh-login/login/oauth/access_token" || path === "/confluence-auth/oauth/token")) {
        const kind = kindOfPath(path);
        const entra = kind === "ado" || kind === "m365";
        const f = entra || kind === "github" ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || "{}");
        // GitHub answers token errors with 200 and an `error` field, like the real one.
        const fail = (status, error) => send(kind === "github" ? 200 : status, { error });
        if (f.client_id !== clients[kind].id || f.client_secret !== clients[kind].secret) return fail(401, kind === "github" ? "incorrect_client_credentials" : "invalid_client");
        // GitHub's code exchange has no grant_type.
        const grant = f.grant_type ?? (kind === "github" && f.code ? "authorization_code" : undefined);
        if (grant === "authorization_code") {
          const c = codes.get(f.code);
          codes.delete(f.code);
          if (!c || c.kind !== kind || c.redirectUri !== f.redirect_uri) return fail(400, kind === "github" ? "bad_verification_code" : "invalid_grant");
          if ((entra || kind === "github") && crypto.createHash("sha256").update(f.code_verifier ?? "").digest("base64url") !== c.challenge) return fail(400, "invalid_grant");
          if (c.user) revokedUsers.delete(`${kind}:${c.user}`);
          else revokedKinds.delete(kind);
          return send(200, issue(kind, c.user, c.tenant ?? null));
        }
        if (grant === "refresh_token") {
          const r = refresh.get(f.refresh_token) ?? (lenient && String(f.refresh_token).startsWith(`${kind}rt_`) ? { kind } : undefined);
          if (!r || r.kind !== kind || (r.user ? revokedUsers.has(`${kind}:${r.user}`) : revokedKinds.has(kind))) return fail(400, kind === "github" ? "bad_refresh_token" : "invalid_grant");
          // A refresh token only works at the tenant it was issued at.
          if (r.tenant && path.split("/")[2] !== r.tenant) return fail(400, "invalid_grant");
          counts.refresh[kind]++;
          const out = issue(kind, r.user ?? null, r.tenant ?? null);
          if (!entra) {
            refresh.delete(f.refresh_token); // rotating refresh tokens: the old one stops working
          } else {
            refresh.delete(out.refresh_token); // Entra here keeps the same refresh token
            out.refresh_token = f.refresh_token;
          }
          return send(200, out);
        }
        return send(400, { error: "unsupported_grant_type" });
      }

      // ---- Azure DevOps REST ----
      if ((m = path.match(/^\/ado\/([^/]+)\/(?:([^/]+)\/)?_apis\/(.+)$/))) {
        if (!authed("ado")) return;
        const [, orgName, projectName, rest] = m;
        const org = world.ado.orgs[orgName];
        if (!org) return send(404, { message: "Organization not found" });
        // Not a member of this organization: ADO answers 401 even with a good token.
        if (!member(org)) return send(401, { message: "Not a member of this organization" });
        if (rest === "connectionData" && !projectName) {
          return send(200, { authenticatedUser: { providerDisplayName: who ? (world.people?.[who] ?? who) : "Northwind reader", id: `u-${who ?? "shared"}` } });
        }
        // Org-level work item batch (the per-person check): with errorPolicy Omit, items the caller can't read are null.
        if (rest === "wit/workitemsbatch" && !projectName && req.method === "POST") {
          const b = JSON.parse(body || "{}");
          const find = (id) => org.projects.flatMap((p) => p.items).find((x) => x.id === Number(id));
          const value = (b.ids ?? []).map((id) => {
            const it = find(id);
            return it && sees(it) ? { id: it.id, fields: { "System.Id": it.id } } : null;
          });
          if (b.errorPolicy !== "Omit" && value.includes(null)) return send(404, { message: "Work item not found or no access" });
          return send(200, { count: value.length, value });
        }
        if (rest === "projects" && !projectName) {
          const start = Number(url.searchParams.get("continuationToken") ?? 0);
          const page = org.projects.slice(start, start + state.adoProjectPage);
          const more = start + page.length < org.projects.length;
          return send(200, { count: page.length, value: page.map((p, i) => ({ id: `p-${start + i}`, name: p.name })) }, more ? { "x-ms-continuationtoken": String(start + page.length) } : {});
        }
        const project = org.projects.find((p) => p.name === projectName);
        if (!project) return send(404, { message: "Project not found" });
        if (denied.has(`ado:${project.name}`)) return send(403, { message: "Access denied" });
        const fields = (it) => ({
          "System.Id": it.id, "System.Title": it.title, "System.State": it.state, "System.WorkItemType": it.type,
          "System.AssignedTo": it.assignedTo ? { displayName: it.assignedTo, uniqueName: `${it.assignedTo.split(" ")[0].toLowerCase()}@northwind.example` } : undefined,
          "System.ChangedDate": it.changed, "System.Description": it.description, "System.Tags": it.tags.join("; "),
          "System.CommentCount": it.comments.length, "Microsoft.VSTS.Scheduling.DueDate": it.due ? `${it.due}T00:00:00Z` : undefined,
        });
        const find = (id) => org.projects.flatMap((p) => p.items).find((x) => x.id === Number(id));
        if (rest === "wit/wiql" && req.method === "POST") {
          const q = JSON.parse(body || "{}").query ?? "";
          const since = q.match(/\[System\.ChangedDate\] > '([^']+)'/)?.[1];
          const top = Number(url.searchParams.get("$top") ?? 20000);
          const ids = project.items.filter((it) => !since || it.changed > since).sort((a, b) => a.changed.localeCompare(b.changed)).slice(0, top).map((it) => ({ id: it.id }));
          return send(200, { workItems: ids });
        }
        if (rest === "wit/workitemsbatch" && req.method === "POST") {
          const b = JSON.parse(body || "{}");
          const value = (b.ids ?? []).map(find).filter(Boolean).map((it) => {
            if (b.fields) return { id: it.id, fields: Object.fromEntries(b.fields.map((f) => [f, fields(it)[f]])) };
            const relations = [
              ...it.blockedBy.map((id) => ({ rel: "System.LinkTypes.Dependency-Reverse", url: `${base}/ado/${orgName}/_apis/wit/workItems/${id}` })),
              ...(it.parent ? [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${base}/ado/${orgName}/_apis/wit/workItems/${it.parent}` }] : []),
            ];
            return { id: it.id, fields: fields(it), relations };
          });
          return send(200, { count: value.length, value });
        }
        if ((m = rest.match(/^wit\/workItems\/(\d+)\/comments$/))) {
          const it = find(m[1]);
          if (!it) return send(404, { message: "Work item not found" });
          const top = Number(url.searchParams.get("$top") ?? 200);
          const list = [...it.comments].sort((a, b) => b.at.localeCompare(a.at)).slice(0, top);
          return send(200, { totalCount: it.comments.length, count: list.length, comments: list.map((c) => ({ text: c.text, createdBy: { displayName: c.by }, createdDate: c.at })) });
        }
        return send(404, { message: "Not found" });
      }

      // ---- Jira REST ----
      if (path === "/jira-api/oauth/token/accessible-resources") {
        if (!authed("jira")) return;
        return send(200, world.jira.sites.filter(member).map((s) => ({ id: s.id, name: s.name, url: `${base}/jira-web/${s.name}`, scopes: ["read:jira-work", "read:jira-user"] })));
      }
      if ((m = path.match(/^\/jira-api\/ex\/jira\/([^/]+)\/rest\/api\/3\/(.+)$/))) {
        if (!authed("jira")) return;
        const site = world.jira.sites.find((s) => s.id === m[1]);
        if (!site) return send(404, { message: "Site not found" });
        if (!member(site)) return send(401, { message: "Not a member of this site" });
        if (m[2] === "myself") return send(200, { accountId: `acc-${who ?? "shared"}`, displayName: who ? (world.people?.[who] ?? who) : "Northwind reader" });
        if (m[2] === "issue/bulkfetch" && req.method === "POST") {
          const b = JSON.parse(body || "{}");
          const all = site.projects.flatMap((p) => p.issues);
          const issues = [], issueErrors = [];
          for (const key of b.issueIdsOrKeys ?? []) {
            const it = all.find((x) => x.key === key);
            if (it && sees(it)) issues.push({ key: it.key, fields: { summary: it.summary } });
            else issueErrors.push({ id: key, status: 404, errorMessages: ["Issue does not exist or you do not have permission to see it."] });
          }
          return send(200, { issues, issueErrors });
        }
        if (m[2] === "project/search") {
          const start = Number(url.searchParams.get("startAt") ?? 0);
          const size = Math.min(Number(url.searchParams.get("maxResults") ?? 50), state.jiraProjectPage);
          const values = site.projects.slice(start, start + size).map((p) => ({ key: p.key, name: p.name }));
          return send(200, { startAt: start, maxResults: size, total: site.projects.length, isLast: start + values.length >= site.projects.length, values });
        }
        if (m[2] === "search/jql" && req.method === "POST") {
          const b = JSON.parse(body || "{}");
          const key = b.jql?.match(/project = "([^"]+)"/)?.[1];
          const project = site.projects.find((p) => p.key === key);
          if (!project) return send(400, { errorMessages: ["The value for field 'project' does not exist."] });
          if (denied.has(`jira:${project.key}`)) return send(403, { errorMessages: ["You don't have access."] });
          const since = b.jql.match(/updated >= "(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"/);
          const sinceIso = since ? `${since[1]}-${since[2]}-${since[3]}T${since[4]}:${since[5]}:00.000Z` : null;
          const all = project.issues.filter((i) => !sinceIso || i.updated >= sinceIso).sort((a, c) => a.updated.localeCompare(c.updated));
          const start = Number(b.nextPageToken ?? 0);
          const size = Math.min(Number(b.maxResults ?? 50), state.jiraIssuePage);
          const page = all.slice(start, start + size);
          const more = start + page.length < all.length;
          const byKey = (k) => site.projects.flatMap((p) => p.issues).find((x) => x.key === k);
          return send(200, {
            isLast: !more,
            ...(more ? { nextPageToken: String(start + page.length) } : {}),
            issues: page.map((i) => ({
              key: i.key,
              fields: {
                summary: i.summary, status: { name: i.status }, assignee: i.assignee ? { displayName: i.assignee } : null, duedate: i.duedate,
                issuetype: { name: i.type }, updated: i.updated.replace("Z", "+0000"), description: adf(i.description), labels: i.labels,
                issuelinks: i.blockedBy.map((k) => ({ type: { name: "Blocks", inward: "is blocked by", outward: "blocks" }, inwardIssue: { key: k, fields: { summary: byKey(k)?.summary, status: { name: byKey(k)?.status } } } })),
                comment: { total: i.comments.length, comments: i.comments.map((c) => ({ author: { displayName: c.by }, created: c.at, body: adf(c.text) })) },
              },
            })),
          });
        }
        return send(404, { message: "Not found" });
      }

      // ---- GitHub REST ----
      if ((m = path.match(/^\/gh-api\/(.+)$/))) {
        if (!authed("github")) return;
        const rest = m[1];
        const gh = world.github;
        const pageOf = (list, extra = "") => {
          const n = Math.max(1, Number(url.searchParams.get("page") ?? 1));
          const size = Math.min(Number(url.searchParams.get("per_page") ?? 30), state.githubPage);
          const part = list.slice((n - 1) * size, n * size);
          const q = new URLSearchParams(url.searchParams);
          q.set("page", String(n + 1));
          const next = n * size < list.length ? `${base}/gh-api/${rest}?${q}${extra}` : null;
          return { part, next };
        };
        if (rest === "user") return send(200, who ? { id: 70000 + [...who].reduce((n, ch) => n + ch.charCodeAt(0), 0), login: `${who}-gh`, type: "User" } : { id: gh.user.id, login: gh.user.login, type: "User" });
        const ghRepo = (name) => gh.installations.flatMap((i) => i.repos).find((r) => r.full_name.toLowerCase() === name.toLowerCase());
        /** Whether the caller may open a repository: public ones are open to all, private ones to `members` (if listed). */
        const ghSees = (r) => r.visibility === "public" || member(r);
        if ((m = rest.match(/^repos\/([^/]+\/[^/]+)$/))) {
          const repo = ghRepo(m[1]);
          if (!repo || !ghSees(repo)) return send(404, { message: "Not Found" });
          const visibility = repo.visibility ?? "private";
          return send(200, { id: 4000 + gh.installations.flatMap((i) => i.repos).indexOf(repo), full_name: repo.full_name, private: visibility !== "public", visibility });
        }
        if (rest === "user/installations") {
          const { part, next } = pageOf(gh.installations);
          return send(200, { total_count: gh.installations.length, installations: part.map((i) => ({ id: i.id, account: { login: "northwind" } })) }, link(next));
        }
        if ((m = rest.match(/^user\/installations\/(\d+)\/repositories$/))) {
          const inst = gh.installations.find((i) => i.id === Number(m[1]));
          if (!inst) return send(404, { message: "Not Found" });
          const { part, next } = pageOf(inst.repos);
          return send(200, { total_count: inst.repos.length, repositories: part.map((r) => ({ full_name: r.full_name, name: r.full_name.split("/")[1], private: r.visibility !== "public", archived: false })) }, link(next));
        }
        if ((m = rest.match(/^repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)\/comments)?$/))) {
          const repo = gh.installations.flatMap((i) => i.repos).find((r) => r.full_name === m[1]);
          if (!repo || !ghSees(repo)) return send(404, { message: "Not Found" });
          if (denied.has(`github:${repo.full_name}`)) return send(403, { message: "Resource not accessible by integration" });
          if (m[2]) {
            const it = repo.issues.find((i) => i.number === Number(m[2]));
            if (!it) return send(404, { message: "Not Found" });
            const { part, next } = pageOf([...it.comments].sort((a, b) => a.at.localeCompare(b.at)));
            return send(200, part.map((c) => ({ user: { login: c.by }, created_at: c.at, body: c.text })), link(next));
          }
          const since = url.searchParams.get("since");
          const list = repo.issues.filter((i) => !since || i.updated >= since).sort((a, b) => a.updated.localeCompare(b.updated));
          const { part, next } = pageOf(list);
          const nextLink = next && state.githubEvilNext ? `${base}/gh-evil/steal?page=2` : next;
          return send(200, part.map((i) => ({
            number: i.number, title: i.title, state: i.state, updated_at: i.updated, body: i.body, comments: i.comments.length,
            html_url: `${base}/gh-web/${repo.full_name}/${i.pr ? "pull" : "issues"}/${i.number}`,
            assignee: i.assignees[0] ? { login: i.assignees[0] } : null, assignees: i.assignees.map((login) => ({ login })),
            labels: i.labels.map((name) => ({ name })), milestone: i.milestone ? { ...i.milestone, state: "open" } : null,
            ...(i.pr ? { draft: Boolean(i.draft), pull_request: { merged_at: i.merged ? i.updated : null, html_url: `${base}/gh-web/${repo.full_name}/pull/${i.number}` } } : {}),
          })), link(nextLink));
        }
        return send(404, { message: "Not Found" });
      }
      if (path.startsWith("/gh-evil/")) {
        counts.evil++;
        return send(200, []);
      }

      // ---- Confluence REST ----
      if (path === "/confluence-api/oauth/token/accessible-resources") {
        if (!authed("confluence")) return;
        return send(200, world.confluence.sites.filter(member).map((s) => ({ id: s.id, name: s.name, url: `${base}/confluence-web/${s.name}`, scopes: ["read:confluence-content.all", "read:confluence-space.summary", "search:confluence", "read:confluence-user"] })));
      }
      if ((m = path.match(/^\/confluence-api\/ex\/confluence\/([^/]+)\/wiki\/(.+)$/))) {
        if (!authed("confluence")) return;
        const site = world.confluence.sites.find((s) => s.id === m[1]);
        if (!site) return send(404, { message: "Site not found" });
        if (!member(site)) return send(401, { message: "Not a member of this site" });
        if (m[2] === "rest/api/user/current") return send(200, { type: "known", accountId: `acc-${who ?? "shared"}`, displayName: who ? (world.people?.[who] ?? who) : "Northwind reader" });
        const pageJson = (space, p) => ({
          id: p.id, type: "page", status: "current", title: p.title,
          body: { storage: { value: p.body, representation: "storage" } },
          version: { when: p.updated, by: { displayName: p.by } },
          ancestors: p.ancestors.map((title) => ({ title })),
          metadata: { labels: { results: p.labels.map((name) => ({ name })) } },
          _links: { webui: `/spaces/${space.key}/pages/${p.id}/${encodeURIComponent(p.title.replace(/ /g, "+"))}` },
        });
        // "Who can open these": `id in (…)` across the site, only pages the caller may view.
        const ids = m[2] === "rest/api/content/search" ? (url.searchParams.get("cql") ?? "").match(/^id in \(([\d,\s]*)\) AND type = page$/) : null;
        if (ids) {
          const want = new Set(ids[1].split(",").map((x) => x.trim()).filter(Boolean));
          const results = site.spaces.flatMap((sp) => sp.pages.filter((p) => want.has(p.id) && sees(p)).map((p) => ({ ...pageJson(sp, p), body: undefined })));
          return send(200, { results, start: 0, limit: Number(url.searchParams.get("limit") ?? 25), size: results.length, _links: {} });
        }
        if (m[2] === "api/v2/spaces") {
          const start = Number(url.searchParams.get("cursor") ?? 0);
          const size = Math.min(Number(url.searchParams.get("limit") ?? 25), state.confluenceSpacePage);
          const part = site.spaces.slice(start, start + size);
          const more = start + part.length < site.spaces.length;
          return send(200, { results: part.map((sp, i) => ({ id: String(1000 + start + i), key: sp.key, name: sp.name, status: "current" })), _links: more ? { next: `/wiki/api/v2/spaces?cursor=${start + part.length}&limit=${size}` } : {} });
        }
        if (m[2] === "rest/api/content/search") {
          const cql = url.searchParams.get("cql") ?? "";
          const key = cql.match(/space = "([^"]+)"/)?.[1];
          const space = site.spaces.find((sp) => sp.key === key);
          if (!space) return send(400, { message: "Could not parse cql" });
          if (denied.has(`confluence:${space.key}`)) return send(403, { message: "Not permitted to use Confluence" });
          const since = cql.match(/lastmodified >= "(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})"/);
          const sinceIso = since ? `${since[1]}-${since[2]}-${since[3]}T${since[4]}:${since[5]}:00.000Z` : null;
          const list = space.pages.filter((p) => (!sinceIso || p.updated >= sinceIso) && sees(p)).sort((a, b) => a.updated.localeCompare(b.updated));
          const start = Number(url.searchParams.get("start") ?? 0);
          const size = Math.min(Number(url.searchParams.get("limit") ?? 25), state.confluencePage);
          const part = list.slice(start, start + size);
          const more = start + part.length < list.length;
          const q = new URLSearchParams(url.searchParams);
          q.set("start", String(start + part.length));
          return send(200, {
            results: part.map((p) => pageJson(space, p)),
            start, limit: size, size: part.length,
            // Like the real one: relative to the site's /wiki context.
            _links: { base: `${base}/confluence-web/${site.name}/wiki`, context: "/wiki", ...(more ? { next: `/rest/api/content/search?${q}` } : {}) },
          });
        }
        return send(404, { message: "Not found" });
      }

      // ---- Microsoft Graph (SharePoint, OneDrive) ----
      if ((m = path.match(/^\/m365-download\/([^/]+)\/([^/]+)$/))) {
        // The pre-authenticated download address: no token needed, and none should be sent.
        if (req.headers.authorization) counts.downloadAuth++;
        const it = m365Drive(m[1])?.items.find((x) => x.id === m[2]);
        if (!it || it.deleted || url.searchParams.get("tempauth") !== `ok-${m[2]}`) return send(404, { error: { code: "itemNotFound" } });
        counts.downloads++;
        const bytes = it.content();
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
        return res.end(bytes);
      }
      if ((m = path.match(/^\/graph\/(.+)$/))) {
        if (!authed("m365")) return;
        const rest = m[1];
        const w = world.m365;
        const graph = `${base}/graph`;
        if (rest === "organization") return send(200, { value: [{ id: whoTenant ?? w.tenantId, displayName: whoTenant && whoTenant !== w.tenantId ? "Another organization" : w.tenantName }] });
        if (rest === "me") return send(200, { displayName: who ? (world.people?.[who] ?? who) : "Sidekick Reader", userPrincipalName: `${who ?? "reader"}@example.test` });
        if (rest === "$batch" && req.method === "POST") {
          // Each request: a GET of one item in a drive, answered as that GET would be for this caller.
          const replies = (JSON.parse(body || "{}").requests ?? []).slice(0, 20).map((r) => {
            const mm = String(r.url ?? "").match(/^\/drives\/([^/?]+)\/items\/([^/?]+)/);
            const drive = mm && m365Drive(decodeURIComponent(mm[1]));
            const it = drive && drive.items.find((x) => x.id === decodeURIComponent(mm[2]));
            const status = state.graphBatchStatus ?? (!drive ? 404 : !m365Member(drive) ? 403 : !it || it.deleted || !m365Sees(drive, it) ? 404 : 200);
            return { id: r.id, status, body: status === 200 ? { id: it.id } : { error: { code: status === 403 ? "accessDenied" : "itemNotFound" } } };
          });
          return send(200, { responses: replies });
        }
        if (rest === "sites") {
          const start = Number(url.searchParams.get("skip") ?? 0);
          const part = w.sites.slice(start, start + state.graphSitePage);
          const more = start + part.length < w.sites.length;
          return send(200, { value: part.map((x) => ({ id: x.id, displayName: x.displayName, name: x.displayName })), ...(more ? { "@odata.nextLink": `${graph}/sites?search=*&skip=${start + part.length}` } : {}) });
        }
        if ((m = rest.match(/^sites\/([^/]+)\/drives$/))) {
          const site = w.sites.find((x) => x.id === m[1]);
          if (!site) return send(404, { error: { code: "itemNotFound" } });
          return send(200, { value: site.drives.filter((d) => !denied.has(`m365:${d.id}`)).map((d) => ({ id: d.id, name: d.name, driveType: d.driveType })) });
        }
        if (rest === "me/drive/sharedWithMe") {
          return send(200, { value: w.shared.map(([d, id, by]) => {
            const it = m365Drive(d)?.items.find((x) => x.id === id);
            return { id: `shared-${id}`, name: it?.name, remoteItem: { id, name: it?.name, folder: { childCount: 1 }, parentReference: { driveId: d }, shared: { sharedBy: { user: { displayName: by } } } } };
          }) });
        }
        if ((m = rest.match(/^drives\/([^/]+)(?:\/(.+))?$/))) {
          const drive = m365Drive(m[1]);
          if (!drive) return send(404, { error: { code: "itemNotFound", message: "The drive was not found." } });
          if (denied.has(`m365:${drive.id}`) || !m365Member(drive)) return send(403, { error: { code: "accessDenied", message: "Access denied" } });
          const sub = m[2] ?? "";
          const pathOf = (id) => {
            const names = [];
            for (let cur = drive.items.find((x) => x.id === id); cur; cur = drive.items.find((x) => x.id === cur.parent)) names.unshift(cur.name);
            return `/drives/${drive.id}/root:${names.length ? `/${names.join("/")}` : ""}`;
          };
          const shape = (it, withPath) => it.deleted ? { id: it.id, deleted: { state: "deleted" }, parentReference: { driveId: drive.id } } : {
            id: it.id, name: it.name, lastModifiedDateTime: it.modified, lastModifiedBy: { user: { displayName: it.by } },
            webUrl: `${base}/m365-web/${encodeURIComponent(drive.id)}/${encodeURIComponent(it.name)}`,
            ...(it.folder ? { folder: { childCount: drive.items.filter((x) => x.parent === it.id).length } } : { file: { mimeType: "application/octet-stream" }, size: it.size ?? 1024 }),
            parentReference: { driveId: drive.id, id: it.parent ?? `root-${drive.id}`, ...(withPath ? { path: pathOf(it.parent) } : {}) },
          };
          if (!sub) return send(200, { id: drive.id, name: drive.name, driveType: drive.driveType });
          if (sub === "root/children") return send(200, { value: drive.items.filter((x) => !x.parent && !x.deleted).map((x) => shape(x, true)) });
          if (sub === "root/delta") {
            if (state.graphDeltaGone && url.searchParams.get("token")) {
              state.graphDeltaGone = false;
              return send(410, { error: { code: "resyncRequired", message: "Resync required. Replace any local items with the server's version." } });
            }
            const since = Number(url.searchParams.get("token") ?? 0);
            const skip = Number(url.searchParams.get("skip") ?? 0);
            const list = drive.items.filter((x) => x.seq > since && !(since === 0 && x.deleted)).sort((a, b) => a.seq - b.seq);
            const part = list.slice(skip, skip + state.graphDeltaPage);
            const more = skip + part.length < list.length;
            // The delta token is the newest change number this listing covers (taken when it started).
            const upTo = url.searchParams.get("upto") ?? String(Math.max(since, ...drive.items.map((x) => x.seq)));
            const value = [...(since === 0 && skip === 0 ? [{ id: `root-${drive.id}`, name: "root", root: {}, folder: {} }] : []), ...part.filter((x) => x.seq <= Number(upTo)).map((x) => shape(x, false))];
            const link = more ? { "@odata.nextLink": `${graph}/drives/${encodeURIComponent(drive.id)}/root/delta?token=${since}&skip=${skip + part.length}&upto=${upTo}` } : { "@odata.deltaLink": `${graph}/drives/${encodeURIComponent(drive.id)}/root/delta?token=${upTo}` };
            return send(200, { value, ...link });
          }
          if ((m = sub.match(/^items\/([^/]+)(\/content)?$/))) {
            if (m[1] === `root-${drive.id}`) return send(200, { id: m[1], name: "root", root: {}, folder: {} });
            const it = drive.items.find((x) => x.id === m[1]);
            if (!it || it.deleted || !m365Sees(drive, it)) return send(404, { error: { code: "itemNotFound", message: "The resource could not be found." } });
            if (m[2]) {
              res.writeHead(302, { location: `${base}/m365-download/${encodeURIComponent(drive.id)}/${encodeURIComponent(it.id)}?tempauth=ok-${encodeURIComponent(it.id)}` });
              return res.end();
            }
            return send(200, shape(it, true));
          }
        }
        return send(404, { error: { code: "itemNotFound" } });
      }

      // ---- web pages for links ----
      if ((m = path.match(/^\/ado-web\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)$/))) return html(`Azure DevOps · ${m[2]} · work item #${m[3]}`);
      if ((m = path.match(/^\/jira-web\/([^/]+)\/browse\/([\w-]+)$/))) return html(`Jira · ${m[1]} · ${m[2]}`);
      if ((m = path.match(/^\/gh-web\/([^/]+\/[^/]+)\/(issues|pull)\/(\d+)$/))) return html(`GitHub · ${m[1]} · ${m[2] === "pull" ? "pull request" : "issue"} #${m[3]}`);
      if ((m = path.match(/^\/confluence-web\/([^/]+)\/wiki\/spaces\/([^/]+)\/pages\/(\d+)/))) return html(`Confluence · ${m[1]} · ${m[2]} · page ${m[3]}`);
      if ((m = path.match(/^\/m365-web\/([^/]+)\/(.+)$/))) return html(`SharePoint · ${m[2]}`);
      send(404, { message: "Not found" });
    });
  });

  /** A Microsoft 365 drive by id: a SharePoint library or the OneDrive. */
  function m365Drive(id) {
    return world.m365.sites.flatMap((x) => x.drives).find((d) => d.id === id) ?? (world.m365.onedrive.id === id ? world.m365.onedrive : undefined);
  }

  return {
    server,
    world,
    state,
    counts,
    clients,
    /** Starts listening (port 0 = any free port) and returns the base address. */
    async listen(port = 0) {
      await new Promise((r) => server.listen(port, "127.0.0.1", r));
      base = `http://127.0.0.1:${server.address().port}`;
      return base;
    },
    close: () => new Promise((r) => server.close(r)),
    /** The app's environment for this fake: where each tool's sign-in, API and web pages are, and the app ids. */
    env(b = base) {
      return {
        ADO_CLIENT_ID: clients.ado.id, ADO_CLIENT_SECRET: clients.ado.secret, ADO_TENANT: "organizations",
        ADO_LOGIN_BASE: `${b}/ado-login`, ADO_API_BASE: `${b}/ado`, ADO_WEB_BASE: `${b}/ado-web`,
        JIRA_CLIENT_ID: clients.jira.id, JIRA_CLIENT_SECRET: clients.jira.secret,
        JIRA_AUTH_BASE: `${b}/jira-auth`, JIRA_API_BASE: `${b}/jira-api`,
        GITHUB_CLIENT_ID: clients.github.id, GITHUB_CLIENT_SECRET: clients.github.secret,
        GITHUB_LOGIN_BASE: `${b}/gh-login`, GITHUB_API_BASE: `${b}/gh-api`, GITHUB_WEB_BASE: `${b}/gh-web`,
        // No CONFLUENCE_CLIENT_ID/SECRET: Confluence uses the Jira app (as in production when Cody adds Confluence to it).
        CONFLUENCE_AUTH_BASE: `${b}/confluence-auth`, CONFLUENCE_API_BASE: `${b}/confluence-api`,
        M365_CLIENT_ID: clients.m365.id, M365_CLIENT_SECRET: clients.m365.secret, M365_LOGIN_BASE: `${b}/m365-login`, M365_GRAPH_BASE: `${b}/graph`,
      };
    },
    /** Adds a file (or folder: `folder: true`) to a Microsoft 365 drive as a new change; returns it. `content()` gives its bytes. */
    m365File(driveId, it) {
      const item = { modified: new Date().toISOString(), by: "Bea B", parent: null, ...it, seq: world.m365.seq() };
      m365Drive(driveId).items.push(item);
      return item;
    },
    /** Marks a Microsoft 365 item changed (edited, renamed, moved): the next delta returns it. */
    m365Touch(item) {
      item.modified = new Date().toISOString();
      item.seq = world.m365.seq();
    },
    /** Deletes a Microsoft 365 item: the next delta returns it as `deleted`. */
    m365Delete(item) {
      item.deleted = true;
      item.seq = world.m365.seq();
    },
    /** The sign-in was revoked (or expired): API calls answer 401 and refreshes fail, until someone connects again. */
    revoke: (kind) => revokedKinds.add(kind),
    /** The next sign-in (of any tool) is this person's own; `null` (or not calling it) = the shared account. */
    signInAs: (name) => { nextUser = name; },
    /** One person's sign-in to a tool was revoked: their calls answer 401 and their refreshes fail until they sign in again. */
    revokeUser: (kind, name) => revokedUsers.add(`${kind}:${name}`),
    /**
     * The next `times` API calls of a tool answer "slow down": `status` 429 (default) or 403 (GitHub's rate limit,
     * with `x-ratelimit-remaining: 0`), with `Retry-After: retryAfter` seconds. `rateLimit(kind)` clears it.
     */
    rateLimit: (kind, { times = 0, retryAfter = 1, status = 429 } = {}) => limits.set(kind, { times, retryAfter, status }),
    /** The connected account loses access to one project (403); `allow` gives it back. */
    deny: (kind, project) => denied.add(`${kind}:${project}`),
    allow: (kind, project) => denied.delete(`${kind}:${project}`),
    /** Makes every access token handed out so far run out now (the next call must refresh). */
    expireAccessTokens: () => { for (const t of access.values()) t.expires = 0; },
  };
}

// Standalone: `node scripts/fake-tools.mjs --port 3331` (the demo world's tools; see docs/DEMO.md).
if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--port");
  // Lenient: the demo copy's sealed sign-ins were made by the seed's fake, before this one started.
  const fake = createFakeTools({ lenient: true });
  const b = await fake.listen(i > 0 ? Number(process.argv[i + 1]) : Number(process.env.FAKE_TOOLS_PORT) || 3331);
  console.log(`Fake Azure DevOps, Jira, GitHub, Confluence and Microsoft 365 (made-up data) on ${b}`);
}
