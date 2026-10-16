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
};

export default nextConfig;
