/**
 * Test helper for tests/db.test.mjs: one separate worker process for the job queue's exactly-once test. It
 * registers the test job kind, then runs the worker until no test jobs are left and prints its report as JSON.
 * Run like db.test.mjs (same engine settings): node --conditions=react-server --import ./tests/register-ts.mjs
 * tests/queue-worker.mjs <worker id> <barrier folder>. Several of these run at once against the same database.
 *
 * No luck involved: each worker writes "<id>.ready" in the barrier folder once it has loaded, then waits for a "go"
 * file, so all of them start claiming at the same moment (a slow process start can't let one drain the queue). And
 * each job holds its lane until at least two different workers have recorded a run (or 10 s pass), so the work is
 * always shared: the worker that claims first can hold at most its few lanes while the others take the rest.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const db = await import("../src/lib/db.ts");
const jobs = await import("../src/lib/jobs.ts");
db.useSystemScopeForProcess("queue worker test process"); // like a script: no request, many orgs
const worker = process.argv[2] ?? "worker";
const barrier = process.argv[3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await db.run("CREATE TABLE IF NOT EXISTS test_job_runs (job_id TEXT NOT NULL, worker TEXT NOT NULL)");
jobs.defineJob("test.record", {
  label: "Test: record a run",
  run: async ({ job }) => {
    await db.run("INSERT INTO test_job_runs (job_id, worker) VALUES (?, ?)", job.id, worker);
    for (let waited = 0; waited < 10_000; waited += 20) {
      const seen = await db.get("SELECT COUNT(DISTINCT worker) AS n FROM test_job_runs");
      if (Number(seen.n) >= 2) break;
      await sleep(20);
    }
    return { recorded: 1 };
  },
});
if (barrier) {
  writeFileSync(join(barrier, `${worker}.ready`), "");
  for (let waited = 0; !existsSync(join(barrier, "go")); waited += 10) {
    if (waited > 60_000) throw new Error("no go signal from the test");
    await sleep(10);
  }
}
const report = await jobs.runWorker({ workerId: worker, kinds: ["test.record"], maxMs: 60_000, maxJobs: 1000 });
console.log(JSON.stringify(report));
process.exit(0);
