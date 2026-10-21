/**
 * @file `HttpError`: an error with an HTTP status and a message that is safe to show the user. Kept in its
 * own module (no Next.js imports) so small libraries such as lib/secret-box.ts and lib/passwords.ts can throw
 * it and still be loaded directly by the database-layer tests. lib/auth.ts re-exports it, so existing
 * `import { HttpError } from "@/lib/auth"` keeps working.
 */
/**
 * An error with an HTTP status and a message that is safe to show the user. API routes wrapped in
 * `handle()` (api.ts) turn it into a JSON `{ error }` response with that status.
 */
export class HttpError extends Error {
  status: number;
  // A plain field, not a TypeScript parameter property, so Node's own type stripping can load it in tests.
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
