// Test-only: lets Node load the app's TypeScript files directly, the way Next.js does, by resolving
// extensionless relative imports ("./trace") to "./trace.ts". Used by tests/db.test.mjs via --import.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\\.[cm]?[jt]s$/.test(specifier)) {
    try { return await next(specifier + ".ts", context); } catch {}
  }
  return next(specifier, context);
}`),
  import.meta.url,
);
