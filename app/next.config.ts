import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A separate build folder lets a test copy run next to the main dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
