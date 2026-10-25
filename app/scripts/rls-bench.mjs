/**
 * Measures what Postgres row-level security costs per query (docs/security/2026-10-row-level-security.md → Overhead).
 * Run against a throwaway local database, once with it off and once on:
 *   createdb rls_bench
 *   SIDEKICK_RLS=off DATABASE_URL=postgres:///rls_bench npm --prefix app run bench:rls
 *   DATABASE_URL=postgres:///rls_bench npm --prefix app run bench:rls
 * Adds two made-up orgs with 2,000 documents each (ids start with "bench-"), then times 3,000 queries per case.
 * Never point it at a real database.
 */
const db = await import("../src/lib/db.ts");
if (db.DIALECT !== "postgres") throw new Error("Set DATABASE_URL to a throwaway local Postgres database (row-level security is Postgres only).");
const N = 3000;
const t = db.now();
const orgs = [];
await db.asSystem("bench setup", async () => {
  for (const label of ["A", "B"]) {
    const org = `bench-${label}`, ws = `bench-ws-${label}`;
    await db.run("INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING", org, label, t);
    await db.run("INSERT INTO workspaces (id, org_id, name, color, created_at) VALUES (?, ?, ?, '#000', ?) ON CONFLICT (id) DO NOTHING", ws, org, label, t);
    for (let i = 0; i < 2000; i++) await db.run("INSERT INTO documents (id, org_id, workspace_id, name, size, status, created_at) VALUES (?, ?, ?, 'd', 1, 'ready', ?) ON CONFLICT (id) DO NOTHING", `${org}-d${i}`, org, ws, t);
    orgs.push({ org, ws });
  }
});
const time = async (label, fn) => {
  for (let i = 0; i < 300; i++) await fn(i); // warm up
  const t0 = performance.now();
  for (let i = 0; i < N; i++) await fn(i);
  const us = ((performance.now() - t0) / N) * 1000;
  console.log(`${label.padEnd(48)} ${us.toFixed(0).padStart(5)} µs/query`);
};
const [A, B] = orgs;
console.log((await db.rowLevelSecurity()).detail);
await time("by id, same org every time", (i) => db.withOrg(A.org, () => db.get("SELECT id FROM documents WHERE id = ?", `${A.org}-d${i % 2000}`)));
await time("by id, org alternates every query", (i) => { const o = i % 2 ? A : B; return db.withOrg(o.org, () => db.get("SELECT id FROM documents WHERE id = ?", `${o.org}-d${i % 2000}`)); });
await time("count a group's 2,000 documents, same org", () => db.withOrg(A.org, () => db.get("SELECT COUNT(*) AS n FROM documents WHERE workspace_id = ?", A.ws)));
await time("transaction with 2 queries, same org", (i) => db.withOrg(A.org, () => db.tx(async () => { await db.get("SELECT id FROM documents WHERE id = ?", `${A.org}-d${i % 2000}`); await db.get("SELECT id FROM workspaces WHERE id = ?", A.ws); })));
process.exit(0);
