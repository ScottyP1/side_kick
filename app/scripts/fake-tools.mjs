/**
 * A fake Azure DevOps and a fake Jira Cloud on one small local HTTP server, for the automated tests
 * (tests/api.test.mjs) and the demo world (scripts/seed-demo.mjs). No real accounts, nothing leaves this Mac.
 *
 * It speaks just enough of each real API for Sidekick's connectors (lib/connector-ado.ts, lib/connector-jira.ts):
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
 * - **Web pages** (`/ado-web/...`, `/jira-web/...`): a plain page per work item, so links in the demo open something.
 *
 * Test controls: `revoke(kind)` (sign-in revoked: API calls 401, refreshes fail with invalid_grant), `deny(kind,
 * project)` (403 for one project), `state.ttl` (make tokens run out), `counts` (token refreshes, API calls), and the
 * `world` object itself (add or change items; set `changed` to now so the next sync picks them up).
 *
 * Use: `const fake = createFakeTools(); const base = await fake.listen(); env = { ...fake.env(base) }`.
 * Standalone (the demo): `node scripts/fake-tools.mjs --port 3331`.
 */
import http from "node:http";
import crypto from "node:crypto";

const day = 86400_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const dueIn = (days) => new Date(Date.now() + days * day).toISOString().slice(0, 10);

/** The made-up world: Northwind's ADO organization and Jira site (shared by the tests and the demo). */
export function defaultWorld() {
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
  };
}

/** Atlassian Document Format for a plain string (one paragraph), like Jira sends descriptions and comments. */
const adf = (text) => (text ? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } : null);

/**
 * Creates the fake tools server. `world` is the data it serves (see `defaultWorld`); `clients` the app ids and
 * secrets it accepts. Returns controls (see the file comment).
 */
export function createFakeTools({ world = defaultWorld(), clients = { ado: { id: "fake-ado-client", secret: "fake-ado-secret" }, jira: { id: "fake-jira-client", secret: "fake-jira-secret" } } } = {}) {
  const state = { ttl: 3600, adoProjectPage: 100, jiraProjectPage: 50, jiraIssuePage: 50 };
  const counts = { refresh: { ado: 0, jira: 0 }, api: { ado: 0, jira: 0 }, unauthorized: 0 };
  const codes = new Map(); // code → { kind, challenge, redirectUri }
  const access = new Map(); // token → { kind, expires }
  const refresh = new Map(); // token → { kind }
  const revokedKinds = new Set();
  const denied = new Set(); // `${kind}:${project}`
  let base = "";

  const newToken = (p) => `${p}_${crypto.randomBytes(18).toString("base64url")}`;
  const issue = (kind) => {
    const a = newToken(`${kind}at`);
    const r = newToken(`${kind}rt`);
    access.set(a, { kind, expires: Date.now() + state.ttl * 1000 });
    refresh.set(r, { kind });
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
      const authed = (kind) => {
        const tok = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        const t = access.get(tok);
        if (!t || t.kind !== kind || t.expires < Date.now() || revokedKinds.has(kind)) {
          counts.unauthorized++;
          send(401, { message: "Unauthorized" });
          return false;
        }
        counts.api[kind]++;
        return true;
      };

      // ---- sign-in pages (approve at once) ----
      let m;
      if (req.method === "GET" && ((m = path.match(/^\/ado-login\/[^/]+\/oauth2\/v2\.0\/authorize$/)) || path === "/jira-auth/authorize")) {
        const kind = path.startsWith("/ado") ? "ado" : "jira";
        const q = url.searchParams;
        if (q.get("client_id") !== clients[kind].id) return send(400, { error: "invalid_client" });
        const code = crypto.randomUUID();
        codes.set(code, { kind, challenge: q.get("code_challenge"), redirectUri: q.get("redirect_uri") });
        const back = new URL(q.get("redirect_uri"));
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      // ---- token endpoints ----
      if (req.method === "POST" && (/^\/ado-login\/[^/]+\/oauth2\/v2\.0\/token$/.test(path) || path === "/jira-auth/oauth/token")) {
        const kind = path.startsWith("/ado") ? "ado" : "jira";
        const f = kind === "ado" ? Object.fromEntries(new URLSearchParams(body)) : JSON.parse(body || "{}");
        if (f.client_id !== clients[kind].id || f.client_secret !== clients[kind].secret) return send(401, { error: "invalid_client" });
        if (f.grant_type === "authorization_code") {
          const c = codes.get(f.code);
          codes.delete(f.code);
          if (!c || c.kind !== kind || c.redirectUri !== f.redirect_uri) return send(400, { error: "invalid_grant" });
          if (kind === "ado" && crypto.createHash("sha256").update(f.code_verifier ?? "").digest("base64url") !== c.challenge) return send(400, { error: "invalid_grant" });
          revokedKinds.delete(kind);
          return send(200, issue(kind));
        }
        if (f.grant_type === "refresh_token") {
          const r = refresh.get(f.refresh_token);
          if (!r || r.kind !== kind || revokedKinds.has(kind)) return send(400, { error: "invalid_grant" });
          counts.refresh[kind]++;
          const out = issue(kind);
          if (kind === "jira") {
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
        return send(200, world.jira.sites.map((s) => ({ id: s.id, name: s.name, url: `${base}/jira-web/${s.name}`, scopes: ["read:jira-work", "read:jira-user"] })));
      }
      if ((m = path.match(/^\/jira-api\/ex\/jira\/([^/]+)\/rest\/api\/3\/(.+)$/))) {
        if (!authed("jira")) return;
        const site = world.jira.sites.find((s) => s.id === m[1]);
        if (!site) return send(404, { message: "Site not found" });
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

      // ---- web pages for links ----
      if ((m = path.match(/^\/ado-web\/([^/]+)\/([^/]+)\/_workitems\/edit\/(\d+)$/))) return html(`Azure DevOps · ${m[2]} · work item #${m[3]}`);
      if ((m = path.match(/^\/jira-web\/([^/]+)\/browse\/([\w-]+)$/))) return html(`Jira · ${m[1]} · ${m[2]}`);
      send(404, { message: "Not found" });
    });
  });

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
      };
    },
    /** The sign-in was revoked (or expired): API calls answer 401 and refreshes fail, until someone connects again. */
    revoke: (kind) => revokedKinds.add(kind),
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
  const fake = createFakeTools();
  const b = await fake.listen(i > 0 ? Number(process.argv[i + 1]) : 3331);
  console.log(`Fake Azure DevOps and Jira (made-up data) on ${b}`);
}
