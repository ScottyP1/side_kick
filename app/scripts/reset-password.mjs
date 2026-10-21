// Operator access recovery: gives a portal user (or an Owner Console account) a one-time temporary password.
//
// Usage (from app/, or `npm --prefix app run reset-password -- …` from the repo root):
//   npm run reset-password -- <email>                  a client portal user (e.g. an Org Owner locked out)
//   npm run reset-password -- <email> --allow-password also turn off "Require Microsoft sign-in" for their org
//   npm run reset-password -- --owner <email>          an Owner Console account (creates the first one if
//                                                      there is none yet; --name "<Your name>" names it)
//   … --reset-2fa                                      also remove two-step sign-in (authenticator app,
//                                                      passkeys, backup codes), e.g. after losing the phone
//
// Which database: DATABASE_URL (Postgres) when set, otherwise the laptop's SQLite file
// (SIDEKICK_DATA_DIR/sidekick.db, default app/data). For the live Azure database use
// `./infra/azure/reset-password.sh <email>`, which opens the database to this Mac for the run only and
// passes DATABASE_URL without printing it (docs/RUNBOOKS.md → "Locked out of the portal").
//
// What it does, in one transaction:
// - sets a new random temporary password (about 100 bits) and prints it to this terminal only: it is never
//   written to a file, log or the database (only its scrypt hash is stored, the same format as lib/auth.ts);
// - marks it temporary, so the next sign-in must pick a new password before anything else works;
// - signs that account out everywhere (deletes its sessions) and clears its failed sign-in count;
// - with --reset-2fa, removes the account's two-step sign-in so it can be set up again after signing in;
// - writes an entry to the organization's audit log (portal) or the operator log (Owner Console).
// Who may run it: only someone who already has the database (DATABASE_URL, or the laptop's data folder),
// which is full control anyway; there is deliberately no web route that can do this.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const APP = path.resolve(import.meta.dirname, "..");
const ACTOR = "Sidekick operator (command line)";

/* ---------- arguments ---------- */
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const [, value] = args.splice(i, 2);
  return value ?? null;
};
const forOwner = flag("--owner");
const allowPassword = flag("--allow-password");
const reset2fa = flag("--reset-2fa");
const ownerName = option("--name");
const email = String(args[0] ?? "").trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+$/.test(email) || args.length !== 1) {
  console.error("Usage: npm run reset-password -- <email> [--allow-password] [--reset-2fa]   or   npm run reset-password -- --owner <email> [--name \"Your name\"] [--reset-2fa]");
  process.exit(2);
}

/* ---------- password ---------- */
/**
 * A temporary password: 4 groups of 5 characters from 31 easy-to-read letters and digits (no 0/o, 1/l/i),
 * about 99 bits of randomness, e.g. "k7m2p-x9qrt-…". Long enough for both the portal (10) and the Owner
 * Console (12) rules.
 */
function temporaryPassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let s = "";
    for (let i = 0; i < 5; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    groups.push(s);
  }
  return groups.join("-");
}
/** Same format as hashPassword() in src/lib/auth.ts: `scrypt$<salt hex>$<key hex>`. */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

/* ---------- database (both engines, `?` placeholders like lib/db.ts) ---------- */
/** Opens the database and returns { all, get, run, tx, close, engine }. */
async function open() {
  const url = process.env.DATABASE_URL;
  if (url) {
    const local = /^postgres(ql)?:\/\/\//.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url);
    const client = new pg.Client({ connectionString: url, ssl: local ? undefined : { rejectUnauthorized: true } });
    await client.connect();
    const toPg = (sql) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    const all = async (sql, ...p) => (await client.query(toPg(sql), p)).rows;
    return {
      engine: local ? "Postgres (this Mac)" : `Postgres (${new URL(url).hostname})`,
      all,
      get: async (sql, ...p) => (await all(sql, ...p))[0],
      run: async (sql, ...p) => void (await client.query(toPg(sql), p)),
      tx: async (fn) => {
        await client.query("BEGIN");
        try {
          const r = await fn();
          await client.query("COMMIT");
          return r;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        }
      },
      hasColumn: async (table, col) => Boolean((await all("SELECT 1 FROM information_schema.columns WHERE table_name = ? AND column_name = ?", table, col))[0]),
      close: () => client.end(),
    };
  }
  const file = path.join(process.env.SIDEKICK_DATA_DIR || path.join(APP, "data"), "sidekick.db");
  if (!fs.existsSync(file)) {
    console.error(`✗ No database: DATABASE_URL isn't set and there's no SQLite file at ${file}.`);
    process.exit(1);
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000");
  const all = async (sql, ...p) => db.prepare(sql).all(...p);
  return {
    engine: `SQLite (${file})`,
    all,
    get: async (sql, ...p) => db.prepare(sql).get(...p),
    run: async (sql, ...p) => void db.prepare(sql).run(...p),
    tx: async (fn) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = await fn();
        db.exec("COMMIT");
        return r;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    hasColumn: async (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col),
    close: () => db.close(),
  };
}

const db = await open();

/**
 * Removes two-step sign-in for one account when --reset-2fa was given (the tables may not exist yet on an
 * older database). Returns true if anything was removed.
 */
async function clearTwoStep(kind, id) {
  if (!reset2fa || !(await db.hasColumn("mfa_factors", "id"))) return false;
  const had = await db.get("SELECT COUNT(*) AS n FROM mfa_factors WHERE account_kind = ? AND account_id = ?", kind, id);
  for (const table of ["mfa_factors", "mfa_backup_codes", "mfa_challenges"]) await db.run(`DELETE FROM ${table} WHERE account_kind = ? AND account_id = ?`, kind, id);
  return Number(had?.n ?? 0) > 0;
}
const nowIso = () => new Date().toISOString();
const password = temporaryPassword();
let done;
try {
  done = forOwner ? await resetOwner() : await resetUser();
} catch (e) {
  console.error(`✗ ${e.message}`);
  await db.close();
  process.exit(1);
}
await db.close();

console.log(`\nDatabase: ${db.engine}`);
for (const line of done) console.log(line);
console.log(`\n  Temporary password:  ${password}\n`);
console.log("It works once: the next sign-in asks for a new password before anything else.");
console.log("Copy it straight into the sign-in page (or your password manager). Don't paste it into chat, email or a ticket.");

/** Portal user: temporary password, signed out everywhere, failures cleared, audited in their org. */
async function resetUser() {
  const user = await db.get(
    "SELECT u.id, u.org_id, u.name, u.role, o.name AS org_name, o.sso_required FROM users u JOIN orgs o ON o.id = u.org_id WHERE lower(u.email) = ?",
    email,
  );
  if (!user) throw new Error(`No portal user with the email ${email}. (For the Owner Console account add --owner.)`);
  const ssoRequired = Number(user.sso_required) === 1;
  await db.tx(async () => {
    await db.run("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?", hashPassword(password), user.id);
    await db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
    await db.run("DELETE FROM login_failures WHERE email = ?", email);
    await db.run(
      "INSERT INTO audit_log (org_id, actor, action, kind, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      user.org_id, ACTOR, `Reset ${user.name}'s password to a temporary one and signed them out everywhere`, "Sign-in", null, nowIso(),
    );
    if (await clearTwoStep("user", user.id)) {
      await db.run(
        "INSERT INTO audit_log (org_id, actor, action, kind, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        user.org_id, ACTOR, `Removed ${user.name}'s two-step sign-in (authenticator app, passkeys, backup codes)`, "Sign-in", null, nowIso(),
      );
    }
    if (ssoRequired && allowPassword) {
      await db.run("UPDATE orgs SET sso_required = 0 WHERE id = ?", user.org_id);
      await db.run(
        "INSERT INTO audit_log (org_id, actor, action, kind, workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        user.org_id, ACTOR, "Turned off “Require Microsoft sign-in” (passwords work again) for access recovery", "Policy change", null, nowIso(),
      );
    }
  });
  const lines = [`Reset: ${user.name} <${email}>, ${user.role} of “${user.org_name}”. Signed out everywhere.`];
  if (reset2fa) lines.push("Two-step sign-in removed: set it up again in Settings once you're in.");
  if (ssoRequired && allowPassword) lines.push("“Require Microsoft sign-in” is now off for this organization, so the password works. Turn it back on in Settings once you're in.");
  else if (ssoRequired) lines.push("⚠ This organization requires Microsoft sign-in, so passwords are refused. Use “Sign in with Microsoft”, or run again with --allow-password to turn that off.");
  return lines;
}

/** Owner Console account: temporary password, signed out everywhere, in the operator log. Creates the first one. */
async function resetOwner() {
  // Older databases don't have the column yet (the app adds it when it starts); add it so the change is forced.
  if (!(await db.hasColumn("platform_admins", "must_change_password"))) {
    await db.run("ALTER TABLE platform_admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
  }
  const owner = await db.get("SELECT id, name FROM platform_admins WHERE lower(email) = ?", email);
  const anyOwner = await db.get("SELECT id FROM platform_admins LIMIT 1");
  if (!owner && anyOwner) throw new Error(`No Owner Console account with the email ${email}.`);
  return db.tx(async () => {
    if (owner) {
      await db.run("UPDATE platform_admins SET password_hash = ?, must_change_password = 1 WHERE id = ?", hashPassword(password), owner.id);
      await db.run("DELETE FROM owner_sessions WHERE admin_id = ?", owner.id);
      await db.run("DELETE FROM login_failures WHERE email = ?", `owner:${email}`);
      await db.run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", ACTOR, `Reset ${owner.name}'s Owner Console password to a temporary one and signed them out everywhere`, nowIso());
      const removed = await clearTwoStep("owner", owner.id);
      if (removed) await db.run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", ACTOR, `Removed ${owner.name}'s two-step sign-in`, nowIso());
      return [`Reset: Owner Console account ${owner.name} <${email}>. Signed out everywhere.`, ...(reset2fa ? ["Two-step sign-in removed: set it up again on Security once you're in."] : [])];
    }
    const name = ownerName?.trim() || email.split("@")[0];
    await db.run(
      "INSERT INTO platform_admins (id, name, email, password_hash, must_change_password, created_at) VALUES (?, ?, ?, ?, 1, ?)",
      crypto.randomUUID(), name, email, hashPassword(password), nowIso(),
    );
    await db.run("INSERT INTO platform_log (actor, action, created_at) VALUES (?, ?, ?)", ACTOR, `Created the Owner Console account for ${name}`, nowIso());
    return [`Created the first Owner Console account: ${name} <${email}>. Sign in at /owner/login.`];
  });
}
