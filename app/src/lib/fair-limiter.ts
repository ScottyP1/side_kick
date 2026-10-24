/**
 * @file A fair limiter: runs at most `max` tasks at once overall and at most `perKey` at once for any one key, and
 * when tasks have to wait, hands out free turns **round-robin between keys** (so one busy key can't take every turn)
 * and to **priority** work first. Used by lib/claude.ts with the organization as the key, so one company asking
 * hundreds of questions at once can't use up Sidekick's Claude capacity and slow every other company down
 * (docs/SCALE.md, "per-company fairness").
 *
 * Concepts
 * - **Turn**: permission to run one task. A task that gets a turn at once doesn't wait at all.
 * - **Waiting line per key**: each key (organization) has its own first-come-first-served line. When a turn frees
 *   up, the limiter goes round the keys that are waiting, starting after the one it served last, and gives the turn
 *   to the first key that is under its own cap. Priority 0 lines (people waiting on an answer) are served before
 *   priority 1 (background work such as the watchers' checks).
 * - **Giving up**: a task that waited `maxWaitMs` is refused with `LimiterBusyError` (Claude callers turn it into the
 *   plain "very busy, try again in a minute" message), so nobody waits forever.
 * - **Per app copy**: the counts live in this process. With several copies of the app each has its own limiter, so
 *   the real overall cap is `max` × copies (docs/HOSTING.md has the numbers to keep under Anthropic's limits).
 *
 * Pure logic with no database or Next.js imports, so tests can run it directly (tests/db.test.mjs).
 */

/** Thrown when a task waited longer than `maxWaitMs` for a turn. */
export class LimiterBusyError extends Error {
  /** How long the task waited before it was refused (ms). */
  readonly waitedMs: number;
  constructor(waitedMs: number) {
    super(`No free turn after ${waitedMs} ms`);
    this.waitedMs = waitedMs;
  }
}

type Waiter = { grant: () => void; reject: (e: Error) => void; at: number; timer: ReturnType<typeof setTimeout> | null };

/** Options: overall cap, per-key cap, and how long a task may wait for a turn before it's refused. */
export type FairLimiterOptions = { max: number; perKey: number; maxWaitMs: number };

/** What `stats()` reports: tasks running and waiting, overall and per key. */
export type FairLimiterStats = { running: number; waiting: number; byKey: Record<string, { running: number; waiting: number }> };

export class FairLimiter {
  private running = 0;
  private runningBy = new Map<string, number>();
  /** Waiting lines: priority → key → FIFO of waiters. Map order = the order keys first started waiting. */
  private lines: Map<string, Waiter[]>[] = [new Map(), new Map()];
  /** The key served last at each priority, so the next turn goes to the key after it (round-robin). */
  private lastServed: (string | null)[] = [null, null];

  private readonly opts: FairLimiterOptions;
  constructor(opts: FairLimiterOptions) {
    this.opts = opts;
  }

  /**
   * Runs `fn` when `key` gets a turn (at once if there's room) and frees the turn when it settles.
   * `priority` 0 = a person is waiting (served first), 1 = background. `onWait` gets how long it waited (ms) just
   * before `fn` starts, 0 when it didn't wait. Throws `LimiterBusyError` after waiting `maxWaitMs`.
   */
  async run<T>(key: string, fn: () => Promise<T>, opts: { priority?: 0 | 1; onWait?: (ms: number) => void } = {}): Promise<T> {
    const started = Date.now();
    await this.acquire(key, opts.priority ?? 0);
    opts.onWait?.(Date.now() - started);
    try {
      return await fn();
    } finally {
      this.release(key);
    }
  }

  /** Tasks running and waiting right now (for traces and the Owner Console). */
  stats(): FairLimiterStats {
    const byKey: FairLimiterStats["byKey"] = {};
    for (const [k, n] of this.runningBy) byKey[k] = { running: n, waiting: 0 };
    let waiting = 0;
    for (const line of this.lines) {
      for (const [k, q] of line) {
        waiting += q.length;
        byKey[k] = { running: byKey[k]?.running ?? 0, waiting: (byKey[k]?.waiting ?? 0) + q.length };
      }
    }
    return { running: this.running, waiting, byKey };
  }

  private hasRoom(key: string) {
    return this.running < this.opts.max && (this.runningBy.get(key) ?? 0) < this.opts.perKey;
  }

  private take(key: string) {
    this.running++;
    this.runningBy.set(key, (this.runningBy.get(key) ?? 0) + 1);
  }

  private acquire(key: string, priority: 0 | 1): Promise<void> {
    // Only skip the line when nobody of this priority or higher is waiting, so turns stay fair.
    const someoneAhead = this.lines.slice(0, priority + 1).some((line) => line.size > 0);
    if (!someoneAhead && this.hasRoom(key)) {
      this.take(key);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const line = this.lines[priority];
      const waiter: Waiter = { grant: resolve, reject, at: Date.now(), timer: null };
      waiter.timer = setTimeout(() => {
        const q = line.get(key);
        const i = q?.indexOf(waiter) ?? -1;
        if (q && i >= 0) {
          q.splice(i, 1);
          if (!q.length) line.delete(key);
          reject(new LimiterBusyError(Date.now() - waiter.at));
        }
      }, this.opts.maxWaitMs);
      waiter.timer.unref?.();
      const q = line.get(key);
      if (q) q.push(waiter);
      else line.set(key, [waiter]);
      // There may be room for someone (e.g. this key is under its cap while others wait for theirs).
      this.dispatch();
    });
  }

  private release(key: string) {
    this.running--;
    const n = (this.runningBy.get(key) ?? 1) - 1;
    if (n > 0) this.runningBy.set(key, n);
    else this.runningBy.delete(key);
    this.dispatch();
  }

  /** Hands out free turns: priority 0 first, round-robin between keys after the one served last. */
  private dispatch() {
    for (let p = 0; p < this.lines.length && this.running < this.opts.max; p++) {
      const line = this.lines[p];
      let progress = true;
      while (progress && line.size && this.running < this.opts.max) {
        progress = false;
        const keys = [...line.keys()];
        const last = this.lastServed[p];
        const from = last === null ? 0 : (keys.indexOf(last) + 1) % keys.length;
        for (let i = 0; i < keys.length; i++) {
          const k = keys[(from + i) % keys.length];
          if (!this.hasRoom(k)) continue;
          const q = line.get(k)!;
          const w = q.shift()!;
          if (!q.length) line.delete(k);
          if (w.timer) clearTimeout(w.timer);
          this.take(k);
          this.lastServed[p] = k;
          w.grant();
          progress = true;
          break;
        }
      }
      // Anyone still waiting here is held by their own key's cap, so lower-priority work may use the free turns.
    }
  }
}
