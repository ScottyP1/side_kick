/**
 * @file Next.js settings for Sidekick: build output for the Docker image, files kept out of the build, and the
 * security headers sent with every response.
 */
import type { NextConfig } from "next";

const production = process.env.NODE_ENV === "production";

/**
 * Content Security Policy: where the browser may load scripts, styles, images and connections from. Everything
 * Sidekick uses is its own (fonts are self-hosted by next/font, the logo is a data: URL), so the rules are
 * "only from this site". Next.js puts small inline scripts in each page, hence 'unsafe-inline' for scripts
 * (tighten with nonces later); `next dev` also needs eval and a websocket for hot reload. `frame-ancestors
 * 'none'` stops other sites showing Sidekick in a frame (clickjacking); Sidekick has no Teams tab, so nothing
 * needs to frame it. Security review M5, Oct 2026.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${production ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${production ? "" : " ws: wss:"}`,
  "object-src 'none'",
  "base-uri 'self'",
  // The sign-in form's Microsoft round trip goes to Microsoft's sign-in page.
  "form-action 'self' https://login.microsoftonline.com",
  "frame-ancestors 'none'",
].join("; ");

/**
 * Security headers on every response (pages and API; security review Oct 2026, docs/HOSTING.md → Security):
 * HSTS (always HTTPS; browsers ignore it on plain-http localhost), no framing by other sites (clickjacking), no
 * MIME sniffing, a short referrer. The content policy is enforced (the ops review started it as report-only;
 * the app review checked the portal under it with no violations). If Sidekick ever gets a Teams tab,
 * `frame-ancestors` and X-Frame-Options must allow Teams.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Don't advertise the framework in an X-Powered-By header.
  poweredByHeader: false,
  // The assistant button owns the bottom-left corner (components/dock.tsx); keep the dev-only indicator off it.
  devIndicators: { position: "bottom-right" },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Support ticket attachments (customer files) are always downloads; a sandbox policy means even a file a
      // browser tried to open could run nothing. Later entries win for the same header.
      { source: "/api/support/attachments/:path*", headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }] },
    ];
  },
  // A separate build folder lets a test copy run next to the main dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // "standalone" bundles a small server.js plus only the files it needs, which is what the Docker image
  // runs (see Dockerfile). The app folder is the project root, not the repo root above it.
  output: "standalone",
  outputFileTracingRoot: process.cwd(),
  // Never bundle local data, secrets or dev-only files into the build (the SQLite path in db.ts would
  // otherwise pull app/data, with real client data, into the image).
  outputFileTracingExcludes: {
    "/**": ["data/**", ".playground-data/**", ".env*", "tests/**", "scripts/**", "devTools/**"],
  },
  turbopack: { root: process.cwd() },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
