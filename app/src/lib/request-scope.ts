/**
 * @file What kind of request is running, for checks deep inside shared helpers.
 *
 * `handle()` (lib/api.ts) runs every API route inside `runRequest`, recording whether the request would
 * change something (any method but GET/HEAD/OPTIONS). `requireWorkspace` (lib/auth.ts) reads it with
 * `isWriteRequest()` to keep groups that are ending (lib/rolloff.ts) read-only without every route having
 * to remember. Work outside a request (the timer, tests calling a library directly) counts as not writing.
 */
import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

type Scope = { writes: boolean };

declare global {
  var __sidekickRequestScope: AsyncLocalStorage<Scope> | undefined;
}
// One store per process, shared by every copy of this module after a development reload.
const store = (globalThis.__sidekickRequestScope ??= new AsyncLocalStorage<Scope>());

/** Runs `fn` as the request `req`. Called by `handle()` only. */
export function runRequest<T>(req: unknown, fn: () => Promise<T>): Promise<T> {
  const method = req instanceof Request ? req.method : "GET";
  return store.run({ writes: !["GET", "HEAD", "OPTIONS"].includes(method) }, fn);
}

/** True while an API request that changes something (POST, PATCH, PUT, DELETE) is running. */
export function isWriteRequest(): boolean {
  return store.getStore()?.writes ?? false;
}
