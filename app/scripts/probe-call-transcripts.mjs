/**
 * @file Probe: which Microsoft Graph path lists a Teams call's transcript (docs/RUNBOOKS.md → Automatic meeting notes,
 * "Meet now gives no notes"). Run it within an hour of a test call, as Sidekick's own app (app-only token, like the
 * live server), and paste the output. Read-only: it only lists transcripts and reads their metadata; for the first
 * transcript of each kind it downloads the content but prints only its size and how many speakers it has, never
 * the words.
 *
 * What it checks, per person, for v1.0 and beta:
 * - `users/{id}/adhocCalls/getAllTranscripts(userId='{id}',…)`: ad hoc calls (Meet now, chat calls), with and
 *   without a time window (`userId` is the person who started transcription, per Microsoft's docs);
 * - `users/{id}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='{id}',…)`: scheduled meetings;
 * following every `@odata.nextLink` page. For each transcript: its call/meeting id, times, organizer, and the chat
 * thread id Sidekick reads out of an ad hoc transcript id (`decodeTranscriptThread` in lib/meetings-graph.ts).
 *
 * Usage (secrets only from the environment, never on the command line or in chat; app/.env.local has them):
 *   node --env-file=app/.env.local app/scripts/probe-call-transcripts.mjs --tenant <tenant id> \
 *     --user cody@example.onmicrosoft.com --user <object id> [--hours 24]
 * Needs ENTRA_CLIENT_ID (or CLIENT_ID) and ENTRA_CLIENT_SECRET (or CLIENT_SECRET). People given by sign-in name are
 * looked up with User.Read.All. Exit code 0 even when Graph refuses: the refusals are the result.
 */
const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : [])).filter(Boolean);
const tenant = opt("tenant")[0];
const people = opt("user");
const hours = Number(opt("hours")[0] ?? 24);
const clientId = process.env.ENTRA_CLIENT_ID || process.env.CLIENT_ID;
const clientSecret = process.env.ENTRA_CLIENT_SECRET || process.env.CLIENT_SECRET;
if (!tenant || !people.length || !clientId || !clientSecret) {
  console.error("Usage: node --env-file=app/.env.local app/scripts/probe-call-transcripts.mjs --tenant <id> --user <upn or id> [--user …] [--hours 24]\n(needs ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET in the environment)");
  process.exit(2);
}
const GRAPH = "https://graph.microsoft.com";

/** An app-only Graph token for the tenant (never printed). */
async function token() {
  const r = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials", scope: `${GRAPH}/.default` }),
  });
  const b = await r.json();
  if (!b.access_token) throw new Error(`No token: ${b.error} ${String(b.error_description ?? "").split("\n")[0]}`);
  // Which application permissions the token carries (names only).
  const claims = JSON.parse(Buffer.from(b.access_token.split(".")[1], "base64url").toString());
  console.log(`Token roles: ${(claims.roles ?? []).sort().join(", ") || "(none)"}\n`);
  return b.access_token;
}

/** One Graph GET: { status, body } (body is JSON, or { bytes, text } with raw). */
async function get(tok, path, raw = false) {
  const r = await fetch(path.startsWith("http") ? path : `${GRAPH}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  if (raw && r.ok) {
    const text = await r.text();
    return { status: r.status, body: { bytes: text.length, text } };
  }
  const text = await r.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body };
}
const why = (b) => [b?.error?.code, b?.error?.innerError?.code, String(b?.error?.message ?? "").slice(0, 160)].filter(Boolean).join(" | ");

/** The chat thread an ad hoc transcript id carries (same rule as lib/meetings-graph.ts). */
function threadOf(id) {
  const m = /19:[\w.:-]+?@(?:thread\.v2|thread\.skype|unq\.gbl\.spaces)/.exec(Buffer.from(String(id), "base64").toString("latin1"));
  return m ? m[0] : null;
}

/** Lists every page of a getAllTranscripts address; returns the transcripts. */
async function listAll(tok, label, first) {
  const items = [];
  let path = first;
  let pages = 0;
  for (; path && pages < 30; pages++) {
    const { status, body } = await get(tok, path);
    if (status !== 200) {
      console.log(`  ${label}: ${status} ${why(body)}`);
      return items;
    }
    items.push(...(body.value ?? []));
    path = body["@odata.nextLink"] ?? null;
  }
  console.log(`  ${label}: 200, ${items.length} transcript(s) over ${pages} page(s)`);
  for (const t of items.slice(0, 10)) {
    console.log(`    - created ${t.createdDateTime ?? "?"} end ${t.endDateTime ?? "?"} callId ${t.callId ?? "-"} meetingId ${t.meetingId ? `${String(t.meetingId).slice(0, 24)}…` : "-"} organizer ${t.meetingOrganizer?.user?.id ?? "?"} chat ${threadOf(t.id) ?? "-"}`);
  }
  return items;
}

/** For one transcript: metadata and content (size and speaker count only). */
async function readOne(tok, version, userId, t, kind) {
  const base = kind === "adhoc"
    ? `/${version}/users/${userId}/adhocCalls/${encodeURIComponent(t.callId)}/transcripts/${encodeURIComponent(t.id)}`
    : `/${version}/users/${userId}/onlineMeetings/${encodeURIComponent(t.meetingId)}/transcripts/${encodeURIComponent(t.id)}`;
  const meta = await get(tok, base);
  console.log(`    read ${kind} transcript metadata (${version}): ${meta.status} ${meta.status === 200 ? "" : why(meta.body)}`);
  const content = await get(tok, `${base}/content?$format=text/vtt`, true);
  if (content.status === 200) {
    const speakers = new Set([...content.body.text.matchAll(/<v\s+([^>]+)>/g)].map((m) => m[1])).size;
    console.log(`    download content (${version}): 200, ${content.body.bytes} characters, ${speakers} speaker(s)`);
  } else console.log(`    download content (${version}): ${content.status} ${why(content.body)}`);
}

const tok = await token();
const to = new Date().toISOString();
const from = new Date(Date.now() - hours * 3600_000).toISOString();
console.log(`Window: ${from} → ${to}\n`);
for (const person of people) {
  let id = person;
  if (!/^[0-9a-f-]{36}$/i.test(person)) {
    const u = await get(tok, `/v1.0/users/${encodeURIComponent(person)}?$select=id,displayName`);
    if (u.status !== 200) {
      console.log(`${person}: can't look up (${u.status} ${why(u.body)})\n`);
      continue;
    }
    id = u.body.id;
  }
  console.log(`${person} (${id})`);
  for (const version of ["v1.0", "beta"]) {
    const adhoc = await listAll(tok, `${version} adhocCalls, window`, `/${version}/users/${id}/adhocCalls/getAllTranscripts(userId='${id}',startDateTime=${from},endDateTime=${to})`);
    await listAll(tok, `${version} adhocCalls, no window`, `/${version}/users/${id}/adhocCalls/getAllTranscripts(userId='${id}')`);
    const meetings = await listAll(tok, `${version} onlineMeetings, window`, `/${version}/users/${id}/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='${id}',startDateTime=${from},endDateTime=${to})`);
    if (adhoc[0]?.callId) await readOne(tok, version, id, adhoc[0], "adhoc");
    if (meetings[0]?.meetingId) await readOne(tok, version, id, meetings[0], "meeting");
  }
  console.log("");
}
