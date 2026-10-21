# Application security review (October 20, 2026)

Scope: the Sidekick app code (`app/src`) at commit `ba0a60a` (PRs #18–#20 deployed), tested by reading the
code and by attacking a throwaway local copy (SQLite, fake Claude, no Azure, no Teams) with two made-up
organizations ("Acme Test" and "Beta Corp"), one user per role, documents, meetings and action items.
Nothing was sent to the live site, Azure or Microsoft. The live Azure setup and operations are covered by a
separate review. Report only: nothing was fixed.

## Summary

- **No critical or high-severity problem found.** The walls hold: from org A, every route tried against
  org B's workspace, documents, meetings, action items, gaps, memory, guardrails, users, traces, audit,
  usage and Teams links answered "not found", and nothing of org B appeared in A's lists, Activity, audit
  or assistant. Lower roles were refused every admin action tried; Team Lead scoping held. SQL is
  parameterised everywhere; the few `${…}` pieces in SQL are fixed table/column names. Teams requests
  without Microsoft's signature are refused, the reminder timer needs its secret, and nothing user-written
  is rendered as HTML.
- **Fix first (medium):**
  1. The **Owner Console sign-in has no guessing limit** (30 wrong passwords in a row, then the right one
     works) and failed attempts aren't logged.
  2. **Changing your password doesn't sign out your other sessions**, so a stolen session cookie keeps
     working for up to 7 days.
  3. A **small "zip bomb" Word file** (190 KB) turned into 54 MB of text and 60,000 search passages in
     10 seconds; a 25 MB one would likely crash the app or, with Azure, run up embedding costs.
  4. **No CSRF check** beyond `SameSite=Lax` cookies: JSON routes accept `text/plain` and form posts, and no
     route checks `Origin`.
  5. **No security headers** (no CSP, no `X-Frame-Options`/`frame-ancestors`, no HSTS from the app), so
     the portal and Owner Console can be framed (clickjacking).
  6. **"Only from localhost" trusts the `Host` header**, which the caller controls. Safe only if the Azure
     front door never passes `Host: localhost` through, and only matters while a setup is still open.
- Plus 9 low and 9 informational items below.

## Findings

Severity: **Critical** = one org can read/change another's data or anyone can take over; **High** = a
realistic path to an account or data; **Medium** = needs a precondition, or denial of service / cost;
**Low** = minor or hard to use; **Info** = good to know.

### Medium

#### M1. Owner Console sign-in has no guessing limit and no failed-login log
- **Where:** `app/src/app/api/owner/auth/login/route.ts:8`, `lib/owner.ts` `checkOwnerPassword`.
- **Reproduce:** POST `/api/owner/auth/login` 30 times with a wrong password for a real owner email: all
  answer 401, never 429; the right password then works at once. Nothing goes to `platform_log` for failures.
- **Impact:** the most powerful account (sees every client org, people and usage; onboards orgs; pauses
  clients; flips kill switches) can be guessed at full speed from the internet. No MFA either.
- **Fix:** reuse `lib/login-limit.ts` for owner sign-in (own key prefix, e.g. `owner:<email>`), log failed
  and locked attempts to `platform_log`, and consider Microsoft sign-in (with MFA) for the console, or an
  IP allow-list on `/owner` and `/api/owner` in Azure.

#### M2. Sessions survive a password change
- **Where:** `app/src/app/api/auth/password/route.ts:15`.
- **Reproduce:** sign in as one user in two cookie jars; change the password from jar 1; jar 2 still reads
  `/api/workspaces` (200).
- **Impact:** if a session cookie is stolen (shared machine, malware, a leaked HAR file), changing the
  password doesn't lock the thief out; they keep access for up to 7 days. (Removing a user, pausing an org
  and "require Microsoft sign-in" do end sessions; those were checked.)
- **Fix:** in the password route, `DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?` (keep the
  current one). Optional: a "Sign out everywhere" button and an admin "end sessions" action on Users & access.

#### M3. Compressed Word files can blow up memory and indexing (any Member)
- **Where:** `lib/extract.ts:65` (`mammoth.extractRawText`), `app/api/docs/route.ts:52`; the 25 MB check is on
  the compressed size only and there's no limit on extracted text for documents (meetings have one:
  `MAX_TRANSCRIPT_CHARS`).
- **Reproduce:** a `.docx` whose `word/document.xml` is 56 MB of repeated text zips to 190 KB. Uploading it as
  a Member returned 200 after ~10 s and created **60,000 passages** for one document. Scaled to the 25 MB
  limit that's roughly 7 GB of XML: expected out-of-memory crash of the single app copy. With Azure AI Search
  on, each passage is also embedded (Azure OpenAI cost) and indexed. Many files per request are also allowed.
- **Impact:** any Member (or a stolen Member session) can take Sidekick down for every client or cause a
  large Azure bill.
- **Fix:** cap extracted text per document (e.g. reuse `MAX_TRANSCRIPT_CHARS` or ~2 M characters) and
  refuse beyond it; check the uncompressed size of `word/document.xml` before calling mammoth (read the zip
  central directory) and refuse ratios over ~50:1; cap files per upload (e.g. 20) and total request size;
  cap PDF pages. Consider a per-org daily upload budget.

#### M4. No CSRF protection beyond SameSite=Lax
- **Where:** every state-changing API route; `lib/api.ts` `readJson` parses the body whatever the
  `Content-Type`; no route checks `Origin`. Cookie: `lib/auth.ts:78` (`sameSite: "lax"`).
- **Reproduce:** with a valid session, `POST /api/workspaces` with `Content-Type: text/plain` (what a plain
  HTML form can send) and `Origin: https://evil.example` → 200, workspace created. Same for
  `application/x-www-form-urlencoded`, and multipart uploads to `/api/docs` and `/api/meetings`.
- **Impact:** today `SameSite=Lax` stops other *sites* from sending the cookie on POST, so this is not
  exploitable from an ordinary attacker site. It becomes exploitable from any **same-site** origin: another
  app on the same parent domain (if `*.azurecontainerapps.io` is not treated as a public suffix by
  browsers, any other Container App would be same-site; worth checking), a future custom domain's sibling
  subdomains, or a browser that doesn't enforce Lax.
- **Fix:** one check in `handle()` for non-GET requests: refuse unless `Origin` (or `Sec-Fetch-Site:
  same-origin`) matches `SIDEKICK_PUBLIC_URL`; and refuse JSON routes whose `Content-Type` isn't
  `application/json`. Skip it for `/api/messages` (Teams) and `/api/reminders/tick` (secret header).

#### M5. No security headers
- **Where:** `app/next.config.ts` (no `headers()`), `app/src/proxy.ts`.
- **Reproduce:** `curl -I` on `/` and `/api/me`: no `Content-Security-Policy`, `X-Frame-Options`,
  `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security` or `Permissions-Policy`;
  `X-Powered-By: Next.js` is sent.
- **Impact:** the portal and Owner Console can be put in an invisible frame on another site and clicked
  through (clickjacking: e.g. "Delete workspace" confirm, Owner "Suspend"). No CSP means any future XSS bug
  would have no second line of defence. (HSTS may be added by Azure; check on the live site.)
- **Fix:** in `next.config.ts` `headers()` for all routes: `X-Frame-Options: DENY` and CSP
  `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Strict-Transport-Security: max-age=31536000; includeSubDomains` (production), a starter CSP
  (`default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`,
  tightened later with nonces), and `poweredByHeader: false`.

#### M6. "Only from localhost" is decided by the `Host` header
- **Where:** `lib/owner.ts:44–47` `assertLocalRequest`, used by `POST /api/owner/auth/setup` (first owner
  account) and `POST /api/auth/setup` (first organization).
- **Reproduce:** locally, the same TCP connection is refused with `Host: seca.localhost:3311` and accepted
  with `Host: localhost:3311`: the check reads the header, not where the request came from. Any client can
  send `Host: localhost`.
- **Impact:** both setups close themselves once an account exists, so this only matters while one is still
  open. If the live **Owner Console was never set up** and Azure's ingress forwards a request with
  `Host: localhost` to the app, anyone could create the platform owner account and run the console. Not
  tested against Azure (out of scope); it depends on how Container Apps routes by host. The Dockerfile's
  health check also calls the app as `127.0.0.1`, so anything inside the container counts as "local".
- **Fix:** confirm an owner account exists in production now. Then replace the check with a one-time setup
  code (HOSTING.md already proposes this): e.g. `SIDEKICK_SETUP_CODE` secret required in the body, or setup
  disabled entirely when `NODE_ENV=production`.

### Low

#### L1. Anyone can lock any account out of password sign-in
- **Where:** `lib/login-limit.ts` (per-email limit), `app/api/auth/login/route.ts:18`.
- **Reproduce:** 5 wrong passwords for `vic@…` without signing in; the real password then gets 429 for
  15 minutes (also with the email in upper case or with spaces: normalisation works).
- **Impact:** an outsider who knows (or guesses) work emails can keep people, including the Org Owner,
  locked out by repeating this every 15 minutes. Microsoft sign-in still works where connected. There's
  no admin "unlock", although the message says to ask an Org Admin.
- **Fix:** accept this trade-off but add an admin "clear sign-in lock" on Users & access, or limit per
  email *and* IP pair before locking the email outright (e.g. lock the email only after 20+ failures from
  several addresses), and alert the Org Owner in the audit log (already logged).

#### L2. Unknown emails answer faster (account discovery by timing)
- **Where:** `app/api/auth/login/route.ts:23`: for an unknown email the slow scrypt check is skipped.
- **Reproduce:** wrong password for a real email ≈ 50–70 ms, for an unknown one ≈ 10 ms.
- **Impact:** someone can find out which work emails have Sidekick accounts (useful for phishing or L1).
  The sign-in limit slows this down but each email gets 5 tries.
- **Fix:** when the user isn't found, verify against a fixed dummy hash so both paths take the same time.

#### L3. The sign-in IP limit trusts `X-Forwarded-For`; only safe behind a proxy that appends
- **Where:** `lib/login-limit.ts:41` (`forwarded.at(-1)`).
- **Reproduce:** locally (no proxy) 25 failures with a different `X-Forwarded-For` each → never 429 for the
  IP; without the header the 21st is refused.
- **Impact:** in Azure this is fine *if* Container Apps' ingress always appends the real client address as
  the last entry (the code comment assumes so; not verified here). Run the container anywhere without such a
  proxy (`docker run -p`) and the per-IP limit is bypassed. The per-email limit still applies.
- **Fix:** verify on Azure that a client-sent `X-Forwarded-For: 1.2.3.4` arrives as `1.2.3.4, <real ip>`;
  make the trusted-proxy behaviour explicit (e.g. `TRUST_PROXY=1` env, otherwise use only the socket address).

#### L4. Any text can be shown on the sign-in page (content spoofing)
- **Where:** `app/src/app/(auth)/login/page.tsx:22` shows `?error=` from the address; same for
  `/settings?error=` and, via `error_description`, the Microsoft callback.
- **Reproduce:** open `/login?error=Your account is locked. Call the help desk on +1 555 0100…`: the real
  Sidekick sign-in page shows that sentence as an error. (It's plain text, not HTML, so no script runs.)
- **Impact:** convincing phishing on Sidekick's own address ("call this number", "use this other site").
- **Fix:** pass an error *code* (`?error=sso_not_connected`) and map it to fixed messages in the page; for
  Microsoft errors show a generic sentence plus the reference code.

#### L5. Teams cards render user and document text as Markdown
- **Where:** `lib/teams/cards.ts:35` (`TextBlock` with raw text): answers, excerpts, document titles,
  meeting notes, action-item text and owners, guest names.
- **Impact:** a document named `[Re-sign in to Sidekick](https://evil.example).docx`, a transcript line, or
  an owner typed on a card shows as a clickable link inside a Sidekick card in Teams. Text only, no script.
- **Fix:** escape Markdown characters (`[ ] ( ) * _ ~ \``) in anything not written by Sidekick before it goes
  into a `TextBlock`, and keep links only in `Action.OpenUrl` buttons built from known URLs.

#### L6. Microsoft sign-in links accounts by a mutable email claim
- **Where:** `lib/entra.ts:176` (`email ?? preferred_username`), `app/api/auth/microsoft/callback/route.ts:46`.
- **Impact:** the first Microsoft sign-in attaches the Microsoft account to whichever Sidekick user in that
  org has the same email and no Microsoft link yet. `preferred_username` and `email` are not guaranteed to be
  verified or unique (Microsoft says not to use them for authorisation). Someone in the client's Microsoft
  tenant who can get an account with a colleague's email/UPN (e.g. an IT admin, or a renamed account) could
  sign in as that Sidekick user, possibly an Org Admin. Requires the org to have connected its tenant.
- **Fix:** only auto-link on the `email` claim when the token says it is verified (`xms_edov` /
  `verified_primary_email`), or require the person to link once while signed in with their password (as the
  Org Owner already does), or have admins enter the Microsoft account when adding someone.

#### L7. Teams card buttons: anyone in a linked chat edits any action item in that workspace
- **Where:** `lib/teams/bot.ts:387–393`.
- **Impact:** in a chat marked as having client guests, a guest acts as a Member and can mark done or
  reassign *any* action item of the workspace, including ones from internal-only meetings (whose cards
  are never posted there), if they know its id (ids are random UUIDs, so this needs a leaked id or a forged
  button payload). The reminder buttons already refuse internal items in guest chats; the action-item
  buttons don't.
- **Fix:** in guest chats, only allow items from meetings with `external_guests = 1` (as the reminder path
  does), and consider treating unknown Teams users as Viewers for changes.

#### L8. Manual reminders ignore the per-organization "Reminders" restriction
- **Where:** `app/api/reminders/route.ts:19`: `assertEnabled("remind")` without the org id.
- **Impact:** if the Sidekick team turns Reminders off for one client, that client's admins can still
  "Send now" from the Workspaces page. Policy bypass only, no data exposure.
- **Fix:** `assertEnabled("remind", user.org_id, user.role)` (and check `runDueReminders` does the same per org).

#### L9. Test data folders aren't ignored by git or Docker
- **Where:** `app/.gitignore`, `app/.dockerignore`.
- **Impact:** the `e2e-*` launch configs write `app/.e2e-data-*` (SQLite with test users and documents) and
  `app/.next-e2e-*`; both show as untracked in `git status` and would be sent in an `az acr build ./app`
  context and copied into the build stage by `COPY . .`. Easy to commit or ship by accident.
- **Fix:** add `/.e2e-data-*/` and `/.next-e2e-*/` (and `/.preview-data/` to `.dockerignore`), or a single
  pattern like `.*-data*/`.

### Informational

- **I1. Link codes have no attempt limit.** `POST /api/teams-links` accepts unlimited wrong codes (30 in a
  row → all 404). With 8 characters from 32 (40 bits) and a 24-hour life, guessing isn't practical; a
  simple per-user limit would remove the question. Note a code works for *any* org's admin: whoever enters
  it first links the chat (a code seen by a client guest who is also an admin of another Sidekick org could
  be claimed). Optionally bind the link to the org whose Microsoft tenant matches the chat's tenant.
- **I2. Upload error text comes from libraries.** Failed files show messages like "Invalid PDF structure."
  or "Corrupted zip: can't find end of central directory" (`app/api/docs/route.ts:58`). Harmless today, but
  any library message (possibly with paths) is shown and stored. Prefer a fixed message plus a reference.
- **I3. `/api/health` is public** and says whether Claude, Teams and Azure Search are configured. Fine for
  probes; trim to `{ ok }` if you want less to read for strangers.
- **I4. Cross-org email check.** Adding someone whose email exists in *another* org says "already has an
  account", revealing that the email uses Sidekick elsewhere. Same for Owner Console onboarding (that's fine).
- **I5. Password rules are minimal.** New password ≥ 10 characters; the same password (even the temporary
  one) can be set again; no check against common passwords. Owners have no way to change their own password
  and no MFA.
- **I6. Prompt boundaries.** Passage text goes into `<source>` tags unescaped (`lib/sidekick.ts:85`), so a
  document can contain `</source>` and pretend to be another source or instructions. All sources come from
  the same workspace and grounding only accepts real source ids, so this can't pull in another workspace's
  data; it only lets a workspace's own author steer answers there. Escaping `<`/`>` in passages is cheap.
- **I7. npm audit (production):** 3 moderate, all `sprintf-js` via `mammoth → argparse` (used by mammoth's
  command-line tool, not by Sidekick). Dev only: 5 high in `eslint-config-next → fast-glob → micromatch →
  braces` (build tooling, not shipped). Lockfile v3, every package from registry.npmjs.org.
- **I8. Sessions aren't cleaned up.** Expired `sessions`/`owner_sessions` rows are never deleted (the cookie
  just stops working). Housekeeping only.
- **I9. Login while paused.** A paused org's users can still sign in (a session is created) but every request
  is then refused; harmless, slightly confusing.

## Checked and fine

- **Cross-org isolation (live test):** org A's Org Owner against org B's ids: `GET/POST/DELETE /api/meetings/:id`,
  `PATCH/DELETE /api/docs/:id`, `PATCH /api/action-items/:id`, `/api/docs`, `/api/meetings`, `/api/memory`,
  `/api/memory/refresh`, `/api/gaps`, `/api/ask`, `/api/workspaces/:id` (GET/PATCH/DELETE), `/api/users/:id`
  (PATCH/DELETE), `/api/guardrails?ws=`, `/api/guardrails/rules|workspace|test`, `/api/activity?view=trace&id=`:
  all 404. A's `/api/activity` (messages), `/api/audit`, `/api/usage`, `/api/teams-links` showed nothing of B.
  Adding a user to B's workspace silently drops it. The assistant only knows the caller's workspaces.
- **Inside one org:** a Member can't reach a workspace they aren't in (404); Viewer and Billing Admin can't
  upload, delete, refresh or edit; Members can't open users, audit, usage, traces or branding. Team Lead:
  can't give roles other than Member/Viewer, change roles, remove people, add to or take from workspaces
  they don't lead, change their own workspaces, or create workspaces; a role change takes effect on the next request.
- **Sessions:** random 32-byte tokens, only the SHA-256 stored; cookies `HttpOnly`, `SameSite=Lax`
  (portal) / `Strict` (owner), `Secure` in production; removed users, paused orgs and "require Microsoft
  sign-in" end sessions; logout deletes the row.
- **Temporary passwords:** a user with one gets 403 on everything except `/api/me` and the password change.
- **Sign-in limit:** 5 per email, 20 per IP, email trimmed and lower-cased; a 40-request parallel burst
  got only 5 through on SQLite (Postgres not tested in parallel).
- **Microsoft sign-in:** PKCE (S256), `state` bound to an HttpOnly cookie and single-use in the database,
  `nonce` checked, ID token verified with Microsoft's keys, issuer and audience; personal accounts refused;
  `next` limited to same-site paths (`//evil`, `/\evil`, `https://evil` all become `/`).
- **Owner Console:** every `/api/owner/*` route needs an owner session (a client session gets 401); owner
  setup refused once an owner exists.
- **Injection:** all SQL values are `?` parameters; `${table}`/`${column}` interpolations are fixed lists;
  search terms are reduced to letters/digits before FTS/tsquery; Azure filters quote ids. No shell
  commands, no files written to disk (uploads are parsed in memory; filenames are only stored as text,
  so `../` names do nothing).
- **SSRF:** the only outbound URLs are Microsoft's token endpoint, Azure endpoints from env, and Teams
  `serviceUrl`s, which the Teams SDK checks against the signed token's `serviceurl` claim; Playground mode is
  off in production and local-only.
- **XSS:** no `dangerouslySetInnerHTML` or HTML rendering; workspace/user/file names with `<script>` and
  `<img onerror>` show as text (checked in the browser); the logo is shown with `<img>`, so an SVG logo with
  `onload` and `<script>` (accepted on upload) doesn't run; brand colour must be `#rrggbb`. Assistant links
  come from a fixed page list.
- **Teams bot:** unsigned or `alg:none` activities → 401; `/api/reminders/tick` without the secret → 404
  (constant-time compare); card buttons check the item belongs to the chat's linked org and workspace and
  the clicker's role; reminder buttons check the run belongs to that chat; paused orgs get no answers.
- **AI context:** answers use only passages from the asking workspace (org + workspace filter in both search
  engines; Shareable only for guest chats); the assistant gets names and counts of the caller's own
  workspaces, never document text; refusals use fixed messages; traces hold timings and counts only (no
  document text found in any trace or span after uploads, meetings and questions).
- **Errors:** unexpected errors return a generic message and a reference code; stack traces stay in the
  server log and `app_errors` (Owner Console only).
- **Secrets in git:** all 80 commits (`git log --all -p`) searched for Anthropic/AWS/GitHub/Slack keys,
  private keys, connection strings and `SECRET/KEY/PASSWORD = <long value>`: none. Only test values in
  tests (`test-entra-secret`, a random tick secret). `.env*` is ignored (only `.env.example`, with empty
  values, is tracked).
- **Docker:** multi-stage, runs as `node`, final image has only the standalone build, static files, `public`
  and `db`; `.env*`, `data`, tests excluded; secrets come at run time.

## Not covered

- The live Azure site and its settings (ingress host routing, HSTS, TLS, firewall, secrets, logs): covered by
  the operations review. Items M5, M6 and L3 each need one check there.
- Real Microsoft sign-in and real Teams traffic (no tenant or bot used); real Claude (fake mode), so prompt
  injection was reviewed in code, not tried against the model; Azure AI Search (local index only).
- Postgres concurrency of the sign-in limit; load testing beyond the one zip-bomb sample; PDF bombs.
- Next.js/React framework vulnerabilities beyond `npm audit`; the browser UI beyond spot checks.
