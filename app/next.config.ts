import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  // Don't advertise the framework ("x-powered-by: Next.js").
  poweredByHeader: false,
  // Browser security headers on every response (security review Oct 2026, docs/HOSTING.md → Security):
  // HSTS (always HTTPS), no framing by other sites (clickjacking), no MIME sniffing, a short referrer.
  // The content policy starts in report-only mode: the browser only reports what it would block, so a
  // missed source can't break the portal. Switch it to `Content-Security-Policy` once the console is clean.
  // Teams cards only link to the portal; if Sidekick ever gets a Teams tab, framing must allow Teams.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "form-action 'self' https://login.microsoftonline.com",
              "base-uri 'self'",
              "object-src 'none'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
