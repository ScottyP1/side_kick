/**
 * Test helper for tests/db.test.mjs: one separate worker process for the job queue's exactly-once test. It
 * registers the test job kind, then runs the worker until no test jobs are left and prints its report as JSON.
 * Run like db.test.mjs (same engine settings): node --conditions=react-server --import ./tests/register-ts.mjs
 * tests/queue-worker.mjs <worker id>. Several of these run at once against the same database.
 */
const db = await import("../src/lib/db.ts");
const jobs = await import("../src/lib/jobs.ts");
const worker = process.argv[2] ?? "worker";

await db.run("CREATE TABLE IF NOT EXISTS test_job_runs (job_id TEXT NOT NULL, worker TEXT NOT NULL)");
jobs.defineJob("test.record", {
  label: "Test: record a run",
  run: async ({ job }) => {
    await db.run("INSERT INTO test_job_runs (job_id, worker) VALUES (?, ?)", job.id, worker);
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    return { recorded: 1 };
  },
});
const report = await jobs.runWorker({ workerId: worker, kinds: ["test.record"], maxMs: 60_000, maxJobs: 1000 });
console.log(JSON.stringify(report));
process.exit(0);
