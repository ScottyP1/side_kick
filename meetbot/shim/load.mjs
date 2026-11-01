/**
 * @file How busy the meeting-bot container is (meetbot/shim/core.mjs uses it to report CPU use to Sidekick and to fall
 * back from the animated crystal ball to the still picture when the container is too busy).
 *
 * Reads the container's own CPU time from cgroup v2 (`/sys/fs/cgroup/cpu.stat` usage_usec) and its CPU limit
 * (`/sys/fs/cgroup/cpu.max`, e.g. "200000 100000" = 2 vCPU). Outside a container (tests, a Mac) it reports null.
 * No dependencies. Who calls it: meetbot/shim/main.mjs (`createLoad`); the tests use `cpuShare` directly.
 */
import fs from "node:fs";

/**
 * The share of the container's CPU limit used between two readings, 0..1 (can pass 1 briefly). `prev`/`next` are
 * `{ usageUs, atMs }`; `cores` is the limit in vCPU. Null when the readings can't be compared. Pure.
 */
export function cpuShare(prev, next, cores) {
  if (!prev || !next || !(cores > 0)) return null;
  const wallUs = (next.atMs - prev.atMs) * 1000;
  if (wallUs <= 0) return null;
  return Math.max(0, (next.usageUs - prev.usageUs) / (wallUs * cores));
}

/** The container's CPU limit in vCPU from cgroup v2's cpu.max ("max 100000" = no limit → the machine's CPUs). */
export function coresFrom(cpuMax, fallback) {
  const [quota, period] = String(cpuMax ?? "").trim().split(/\s+/);
  const q = Number(quota);
  const p = Number(period);
  return quota !== "max" && q > 0 && p > 0 ? q / p : fallback;
}

/**
 * A sampler: `sample()` returns the CPU share used since the previous call (0..1), or null when cgroup v2 isn't there.
 * `root` is the cgroup folder (tests point it at a fake one).
 */
export function createLoad({ root = "/sys/fs/cgroup", fallbackCores = 2 } = {}) {
  let prev = null;
  const read = () => {
    try {
      const stat = fs.readFileSync(`${root}/cpu.stat`, "utf8");
      const usageUs = Number(/usage_usec\s+(\d+)/.exec(stat)?.[1]);
      if (!Number.isFinite(usageUs)) return null;
      let max = null;
      try {
        max = fs.readFileSync(`${root}/cpu.max`, "utf8");
      } catch {
        max = null; // no limit file: the machine's CPUs
      }
      return { usageUs, atMs: Date.now(), cores: coresFrom(max, fallbackCores) };
    } catch {
      return null; // not in a cgroup v2 container
    }
  };
  return {
    sample() {
      const next = read();
      const share = next && prev ? cpuShare(prev, next, next.cores) : null;
      prev = next;
      return share;
    },
  };
}
