// Draws the installable web app's icons (docs/guide/install-app.md) into app/public/app-icons/: the same
// artwork as the Teams icon (teams/color.png) and the portal's brand mark, a white "S" in Instrument Sans Bold
// on the brand Indigo, at the sizes browsers ask for:
//   icon-192.png, icon-512.png   rounded square, for Chrome/Edge "Install app" and Android ("any" purpose)
//   maskable-512.png             full-bleed square with the letter inside the 80% safe zone ("maskable": Android
//                                and Windows crop it to their own shape)
//   apple-touch-icon.png         180×180 full-bleed square for iPhone/iPad "Add to Home Screen" (iOS rounds it)
// The PNGs are committed; run this only when the artwork, letter or brand color changes:
//   cd <scratch folder> && npm pack @fontsource/instrument-sans@5.3.0 && tar xzf fontsource-instrument-sans-5.3.0.tgz
//   node app/scripts/app-icons.mjs <scratch folder>/package/files/instrument-sans-latin-700-normal.woff
// (the drawing library reads .woff, not the .woff2 the portal serves; same font, same @fontsource version).
// The letter is the first letter of BRAND.name and the color BRAND.accent (app/src/lib/brand.ts, which Node
// reads directly), so a rename only needs a re-run. Nothing secret is read or written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { ImageResponse } from "next/dist/compiled/@vercel/og/index.node.js";
import { BRAND } from "../src/lib/brand.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "public", "app-icons");
const fontPath = process.argv[2];
if (!fontPath || !fs.existsSync(fontPath)) {
  console.error("Usage: node app/scripts/app-icons.mjs <instrument-sans-latin-700-normal.woff> (see the header)");
  process.exit(1);
}
const font = fs.readFileSync(fontPath);
const letter = BRAND.name.charAt(0).toUpperCase();

/** One icon: `size` px square; `radius` and `scale` (letter height as a share of the size) set the shape. */
async function draw(file, size, { radius, scale }) {
  const el = React.createElement(
    "div",
    {
      style: {
        width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center",
        background: BRAND.accent, borderRadius: radius * size, color: "#ffffff",
        fontFamily: "Instrument Sans", fontWeight: 700, fontSize: scale * size, lineHeight: 1,
      },
    },
    letter,
  );
  const res = new ImageResponse(el, {
    width: size, height: size, fonts: [{ name: "Instrument Sans", data: font, weight: 700, style: "normal" }],
  });
  fs.writeFileSync(path.join(out, file), Buffer.from(await res.arrayBuffer()));
  console.log("wrote", path.relative(process.cwd(), path.join(out, file)));
}

fs.mkdirSync(out, { recursive: true });
// Rounded like the portal's brand mark (8px on 30px ≈ 0.22) with transparent corners.
await draw("icon-192.png", 192, { radius: 0.22, scale: 0.62 });
await draw("icon-512.png", 512, { radius: 0.22, scale: 0.62 });
// Full bleed; the letter is smaller so a circle crop (the tightest mask) never cuts it.
await draw("maskable-512.png", 512, { radius: 0, scale: 0.5 });
await draw("apple-touch-icon.png", 180, { radius: 0, scale: 0.6 });
