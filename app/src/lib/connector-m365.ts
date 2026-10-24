/**
 * @file The Microsoft 365 files connector: signs in with Microsoft Entra ID (delegated, read-only) and reads the
 * Word, PDF, PowerPoint and text files of SharePoint document libraries and OneDrive shared folders into a group's
 * documents. The framework (lib/connectors.ts) handles tokens, syncing, health and indexing; this file only knows
 * Microsoft Graph.
 *
 * Concepts
 * - **Sign-in**: the Microsoft identity platform's authorization code flow with PKCE, authority "organizations"
 *   (work and school accounts). Delegated scopes `Sites.Read.All` and `Files.Read.All` (read every site and file
 *   *the signed-in person* can open, nothing more, never write), `User.Read` (which organization the account
 *   belongs to) and `offline_access` (a refresh token). `Sites.Read.All` needs a Microsoft admin's consent once
 *   per organization; the connecting Org Owner/Admin is usually asked for it (docs/RUNBOOKS.md → Connector apps →
 *   Microsoft 365). App: `M365_CLIENT_ID` / `M365_CLIENT_SECRET` (an Entra app for "accounts in any organizational
 *   directory"; Cody may reuse the Microsoft sign-in app, but these must be set on purpose so the tile only says
 *   "Ready to connect" once the permissions exist).
 * - **Account** (the framework's "site"): the Microsoft organization (tenant) the token opens. When the Sidekick
 *   organization has linked its own Microsoft tenant (orgs.entra_tenant_id), only that tenant may be connected.
 * - **Library or folder** (the framework's "project"): what gets linked to a group. Key `<drive id>` for a whole
 *   SharePoint document library, `<drive id>/<item id>` for one folder (a top-level folder of a library, or a
 *   OneDrive folder shared with the connecting account). Listed by `projects`: the sites the account can open
 *   (`/sites?search=*`) and their libraries and top-level folders, then the folders shared with it.
 * - **Files**: every file in the library or folder (and its subfolders) whose type Sidekick reads (`READ_TYPES`:
 *   the upload types, lib/extract.ts). Each is downloaded (Graph answers `/content` with a short-lived,
 *   pre-authenticated address that is fetched *without* the token), read through the upload path's extraction
 *   (`fileToText`) and indexed as a document with a link to the file. A file over `MAX_UPLOAD_BYTES` is not
 *   downloaded: it is kept as a note card "Not read: the file is 80 MB …" (state "Skipped"), as is a file that
 *   couldn't be opened (encrypted, broken). Files of other types are ignored.
 * - **Incremental sync** with Graph **delta queries**: the first sync lists the whole drive (`root/delta`), pages
 *   follow `@odata.nextLink`, and the last page's `@odata.deltaLink` is the cursor: the next sync only gets what
 *   changed. Both links are saved as the cursor after every page, so a stopped sync resumes. Deleted files, files
 *   moved out of a linked folder and files renamed to a type Sidekick doesn't read come back as `removed` (their
 *   copies are deleted). Delta only works on a drive's root in SharePoint and OneDrive for Business, so a folder
 *   link reads the drive's delta and keeps the files under that folder (each parent folder's path is looked up
 *   once per sync). A 410 ("the delta token expired") starts over from a full listing. At most
 *   `MAX_DOWNLOADS_PER_SYNC` downloads per sync; the rest come on the next run.
 *
 * Read-only: only GET requests are made. Tests and the demo world point `M365_LOGIN_BASE` and `M365_GRAPH_BASE` at
 * a fake Microsoft Graph (scripts/fake-tools.mjs); both overrides are ignored in production.
 */
import "server-only";
import path from "node:path";
import { BRAND } from "./brand";
import { HttpError } from "./http-error";
import { ACCEPTED, fileToText, MAX_DOCUMENT_CHARS, MAX_UPLOAD_BYTES } from "./extract";
import { ConnectorError, isoOf, type WorkItem } from "./connector-text";
import type { ChangePage, Provider } from "./connectors";

const SCOPE = "offline_access User.Read Sites.Read.All Files.Read.All";
/** File types read from Microsoft 365: the upload types except Teams transcripts (those go through Meetings). */
export const READ_TYPES = ACCEPTED.filter((e) => e !== ".vtt");
/** At most this many files downloaded per sync; the rest come on the next run (the cursor has moved). */
export const MAX_DOWNLOADS_PER_SYNC = 200;
/** At most this many SharePoint sites are looked through when listing libraries. */
const MAX_SITES = 100;

const dev = (v: string | undefined, real: string) => (process.env.NODE_ENV !== "production" && v ? v.replace(/\/$/, "") : real);
/** Microsoft's sign-in service (not imported from lib/entra.ts, so the database-layer tests can load this file). */
const loginBase = () => dev(process.env.M365_LOGIN_BASE, "https://login.microsoftonline.com");
/** Where Microsoft Graph lives (`https://graph.microsoft.com/v1.0`). */
export const graphBase = () => dev(process.env.M365_GRAPH_BASE, "https://graph.microsoft.com/v1.0");
const conf = () => ({ id: process.env.M365_CLIENT_ID ?? "", secret: process.env.M365_CLIENT_SECRET ?? "", tenant: process.env.M365_TENANT || "organizations" });

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };

async function token(form: Record<string, string>): Promise<TokenReply & { status: number }> {
  const c = conf();
  const res = await fetch(`${loginBase()}/${encodeURIComponent(c.tenant)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, scope: SCOPE, ...form }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, ...((await res.json().catch(() => ({}))) as TokenReply) };
}

/**
 * A Graph paging link (`@odata.nextLink` / `@odata.deltaLink`, or a saved cursor) when it points back at Graph
 * under `base`; null otherwise, so a link to anywhere else is never followed with the token.
 */
export function graphNext(link: unknown, base: string): string | null {
  if (typeof link !== "string") return null;
  return link.startsWith(`${base}/`) && !/[\s\\]/.test(link) ? link : null;
}

/** A linked library or folder key: `{ drive, folder }` (folder null for a whole library), or null if malformed. */
export function m365Key(key: string): { drive: string; folder: string | null } | null {
  const m = key.match(/^([A-Za-z0-9!_\-.]{1,300})(?:\/([A-Za-z0-9!_\-.]{1,300}))?$/);
  return m ? { drive: m[1], folder: m[2] ?? null } : null;
}

/** A Graph `parentReference.path` ("/drives/<id>/root:/Cutover/Runbooks") as the folder people see ("Cutover/Runbooks"), or null at the top. */
export function folderOf(graphPath: string | null): string | null {
  if (!graphPath) return null;
  const rel = graphPath.replace(/^.*?root:\/?/, "");
  if (!rel) return null;
  try {
    return decodeURIComponent(rel);
  } catch {
    return rel;
  }
}

/** "80 MB" / "900 KB". */
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

type GraphItem = {
  id: string; name?: string; size?: number; webUrl?: string; lastModifiedDateTime?: string;
  file?: object; folder?: object; root?: object; deleted?: object; package?: object;
  lastModifiedBy?: { user?: { displayName?: string } };
  parentReference?: { id?: string; driveId?: string; path?: string };
  remoteItem?: GraphItem & { shared?: { sharedBy?: { user?: { displayName?: string } }; owner?: { user?: { displayName?: string } } } };
};
type GraphList<T> = { value?: T[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };

const enc = encodeURIComponent;

export const m365: Provider = {
  kind: "m365",
  needsSite: false,
  configured: () => Boolean(conf().id && conf().secret),

  authorizeUrl({ state, challenge, redirectUri }) {
    const c = conf();
    const url = new URL(`${loginBase()}/${enc(c.tenant)}/oauth2/v2.0/authorize`);
    url.search = new URLSearchParams({
      client_id: c.id, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: SCOPE, state,
      code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    return url.toString();
  },

  async exchange(code, verifier, redirectUri) {
    const r = await token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
    if (!r.access_token) return { error: r.error ?? `status ${r.status}` };
    return { access: r.access_token, refresh: r.refresh_token ?? null, expiresIn: r.expires_in ?? 3600 };
  },

  async refresh(refreshToken) {
    const r = await token({ grant_type: "refresh_token", refresh_token: refreshToken });
    // invalid_grant (revoked, consent withdrawn, password reset) and interaction_required both come as 400.
    if (!r.access_token) return { error: r.error ?? `status ${r.status}`, revoked: r.status === 400 || r.status === 401 };
    return { access: r.access_token, refresh: r.refresh_token ?? refreshToken, expiresIn: r.expires_in ?? 3600 };
  },

  /** `site` is the organization's own Microsoft tenant id when it linked one (lib/connectors.ts `startConnect`). */
  async account(api, site) {
    const r = await api(`${graphBase()}/organization?$select=id,displayName`, {}, { what: "your Microsoft organization" });
    const org = ((r.json as GraphList<{ id?: string; displayName?: string }>)?.value ?? [])[0];
    if (!org?.id) throw new ConnectorError("notfound", "This Microsoft account doesn't belong to a work or school organization. Sign in with your work account.");
    if (site && org.id.toLowerCase() !== site.toLowerCase()) {
      throw new ConnectorError("access", `That Microsoft account belongs to ${org.displayName ?? "another organization"}, not the Microsoft organization linked to this ${BRAND.name} organization. Sign in with your own work account.`);
    }
    return { account: org.id, accountName: org.displayName ?? org.id, apiBase: graphBase(), webBase: "https://www.microsoft365.com" };
  },

  async projects(api, conn) {
    const base = conn.api_base;
    const out: { key: string; name: string }[] = [];
    // Sites and pages of sites this account can open; a site whose libraries it can't list is left out.
    const sites: { id: string; displayName?: string; name?: string }[] = [];
    let url: string | null = `${base}/sites?search=*&$select=id,displayName,name&$top=100`;
    for (let page = 0; url && page < 10 && sites.length < MAX_SITES; page++) {
      const j = (await api(url, {}, { what: "the SharePoint sites" })).json as GraphList<{ id: string; displayName?: string; name?: string }> | null;
      sites.push(...(j?.value ?? []).filter((s) => s.id));
      url = graphNext(j?.["@odata.nextLink"], base);
    }
    const quiet = async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof ConnectorError && (e.reason === "access" || e.reason === "notfound")) return null;
        throw e;
      }
    };
    for (const s of sites.slice(0, MAX_SITES)) {
      const siteName = s.displayName || s.name || "SharePoint site";
      const drives = await quiet(async () => ((await api(`${base}/sites/${enc(s.id)}/drives?$select=id,name,driveType`)).json as GraphList<{ id: string; name?: string; driveType?: string }> | null)?.value ?? []);
      for (const d of drives ?? []) {
        if (d.driveType && d.driveType !== "documentLibrary") continue;
        const lib = `${siteName} › ${d.name ?? "Documents"}`;
        out.push({ key: d.id, name: lib });
        const kids = await quiet(async () => ((await api(`${base}/drives/${enc(d.id)}/root/children?$select=id,name,folder&$top=200`)).json as GraphList<GraphItem> | null)?.value ?? []);
        for (const f of kids ?? []) if (f.folder && f.id) out.push({ key: `${d.id}/${f.id}`, name: `${lib} › ${f.name ?? "Folder"}` });
      }
    }
    // OneDrive (and SharePoint) folders shared with this account. No OneDrive yet = nothing shared.
    const shared = await quiet(async () => ((await api(`${base}/me/drive/sharedWithMe`)).json as GraphList<GraphItem> | null)?.value ?? []);
    for (const it of shared ?? []) {
      const r = it.remoteItem ?? it;
      const drive = r.parentReference?.driveId;
      if (!r.folder || !drive || !r.id) continue;
      const by = it.remoteItem?.shared?.sharedBy?.user?.displayName ?? it.remoteItem?.shared?.owner?.user?.displayName;
      out.push({ key: `${drive}/${r.id}`, name: `OneDrive › ${r.name ?? "Shared folder"}${by ? ` (shared by ${by})` : ""}` });
    }
    const seen = new Set<string>();
    return out.filter((p) => m365Key(p.key) && !seen.has(p.key) && seen.add(p.key)).sort((a, b) => a.name.localeCompare(b.name));
  },

  async *changes(api, conn, project, cursor) {
    const key = m365Key(project);
    if (!key) throw new ConnectorError("notfound", "That isn't a SharePoint library or folder Sidekick can read.");
    const base = conn.api_base;
    const what = "the linked library or folder";
    const drive = (await api(`${base}/drives/${enc(key.drive)}?$select=id,driveType`, {}, { what })).json as { driveType?: string } | null;
    const type = drive?.driveType === "documentLibrary" ? "SharePoint file" : "OneDrive file";
    // A folder link: the folder's own path, so files below it can be recognized.
    let folderPath: string | null = null;
    if (key.folder) {
      const f = (await api(`${base}/drives/${enc(key.drive)}/items/${enc(key.folder)}?$select=id,name,parentReference,root`, {}, { what })).json as GraphItem | null;
      folderPath = f?.root ? null : `${f?.parentReference?.path ?? ""}/${f?.name ?? ""}`;
    }
    // Each parent folder's full Graph path, looked up once per sync (delta responses don't carry paths).
    const paths = new Map<string, string | null>();
    const pathOf = async (id: string | undefined): Promise<string | null> => {
      if (!id) return null;
      if (paths.has(id)) return paths.get(id)!;
      let p: string | null = null;
      try {
        const it = (await api(`${base}/drives/${enc(key.drive)}/items/${enc(id)}?$select=id,name,parentReference,root`)).json as GraphItem | null;
        p = it?.root ? `/drives/${key.drive}/root:` : it?.parentReference?.path ? `${it.parentReference.path}/${it.name ?? ""}` : null;
      } catch (e) {
        if (!(e instanceof ConnectorError && e.reason === "notfound")) throw e; // deleted meanwhile: not inside
      }
      paths.set(id, p);
      return p;
    };
    const inside = (p: string | null) => !folderPath || (p !== null && (p === folderPath || p.startsWith(`${folderPath}/`)));

    const fresh = `${base}/drives/${enc(key.drive)}/root/delta?$select=id,name,size,file,folder,root,deleted,package,parentReference,lastModifiedDateTime,lastModifiedBy,webUrl`;
    let url: string | null = graphNext(cursor, base) ?? fresh;
    let restarted = false, downloads = 0;
    while (url) {
      let j: GraphList<GraphItem> | null;
      try {
        j = (await api(url, {}, { what })).json as GraphList<GraphItem> | null;
      } catch (e) {
        // 410 Gone: the saved delta token is too old; list everything again (unchanged files aren't re-indexed).
        if (e instanceof ConnectorError && e.status === 410 && !restarted) {
          restarted = true;
          url = fresh;
          continue;
        }
        throw e;
      }
      const items: WorkItem[] = [];
      const removed: string[] = [];
      for (const it of j?.value ?? []) {
        if (!it.id) continue;
        if (it.deleted) {
          removed.push(it.id);
          continue;
        }
        if (!it.file || it.package) continue; // folders, the root, OneNote notebooks
        const name = it.name ?? "Untitled";
        const parent = await pathOf(it.parentReference?.id);
        // Moved out of the linked folder, or renamed to a type Sidekick doesn't read: its copy (if any) goes.
        if (!inside(parent) || !READ_TYPES.includes(path.extname(name).toLowerCase())) {
          removed.push(it.id);
          continue;
        }
        const card: WorkItem = {
          externalId: it.id, type, title: name, state: null, assignee: it.lastModifiedBy?.user?.displayName ?? null, dueOn: null,
          url: /^https?:\/\//i.test(it.webUrl ?? "") ? it.webUrl! : "", changedAt: isoOf(it.lastModifiedDateTime, new Date().toISOString()),
          description: "", blockedBy: [], parent: folderOf(parent), tags: [], commentCount: 0, comments: [],
        };
        const where = type === "OneDrive file" ? "OneDrive" : "SharePoint";
        const tooBig = (bytes: number) => ({ ...card, state: "Skipped", description: `the file is ${size(bytes)}, over the ${size(MAX_UPLOAD_BYTES)} limit for files Sidekick reads. Open it in ${where}, or save a smaller copy.` });
        if ((it.size ?? 0) > MAX_UPLOAD_BYTES) {
          items.push(tooBig(it.size!));
          continue;
        }
        downloads++;
        let bytes: Buffer;
        try {
          bytes = (await api(`${base}/drives/${enc(key.drive)}/items/${enc(it.id)}/content`, {}, { what: `the file “${name}”`, binary: true, maxBytes: MAX_UPLOAD_BYTES })).body ?? Buffer.alloc(0);
        } catch (e) {
          if (e instanceof ConnectorError && e.status === 413) {
            items.push(tooBig(MAX_UPLOAD_BYTES + 1));
            continue;
          }
          if (e instanceof ConnectorError && e.reason === "notfound") continue; // deleted since the listing
          throw e; // sign-in, throttling, network: stop here; this page is read again next time
        }
        try {
          items.push({ ...card, description: (await fileToText(name, bytes)).slice(0, MAX_DOCUMENT_CHARS) });
        } catch (e) {
          // A file that can't be opened (encrypted, broken, too many pages) is a note, never a failed sync.
          const why = e instanceof HttpError ? sentence(e.message) : "The file couldn't be opened (it may be password-protected or damaged).";
          items.push({ ...card, state: "Skipped", description: `${why} Open it in ${where}.` });
        }
      }
      const next = graphNext(j?.["@odata.nextLink"], base);
      const delta = graphNext(j?.["@odata.deltaLink"], base);
      const page: ChangePage = { items, removed, cursor: next ?? delta ?? undefined };
      yield page;
      if (!next || downloads >= MAX_DOWNLOADS_PER_SYNC) break;
      url = next;
    }
  },
};

/** The reason a file couldn't be read (lib/extract.ts messages are already plain), ending with a full stop. */
const sentence = (m: string) => (m.endsWith(".") ? m : `${m}.`);
