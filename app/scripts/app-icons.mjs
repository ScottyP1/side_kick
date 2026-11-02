// Draws every icon Sidekick ships from the brand artwork in app/public/brand/ (the crystal-ball mark, Nov 2026:
// a ring and one flowing swirl; source SVGs made for Cody, kept in the pitch folder too). Writes:
//   app/public/app-icons/icon-192.png, icon-512.png   the tile (tile.svg), for Chrome/Edge "Install app" and Android
//   app/public/app-icons/maskable-512.png             full-bleed Indigo with the ring inside the 80% safe zone
//                                                     (Android and Windows crop it to their own shape)
//   app/public/app-icons/apple-touch-icon.png         180×180 full bleed for iPhone/iPad "Add to Home Screen"
//   teams/color.png (192×192) and teams/outline.png (32×32, white on transparent): the Teams app package's icons
//   app/src/app/favicon.ico                           16, 32 and 48 px (orb-flat.svg, transparent)
//   meetbot/bot-logo.png                              1280×720: the meeting bot's still camera picture, the tile
//                                                     centred on a dark background (rebuild the bot image after:
//                                                     infra/azure/meetbot-setup.sh)
// The PNGs are committed; run this only when the artwork or brand color changes:
//   node app/scripts/app-icons.mjs
// Uses sharp (installed with Next.js). Nothing secret is read or written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { BRAND } from "../src/lib/brand.ts";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(app, "..");
const brand = (f) => fs.readFileSync(path.join(app, "public", "brand", f), "utf8");
const tile = brand("tile.svg");
const flat = brand("orb-flat.svg");
const outline = brand("orb-outline.svg");

/** One PNG of `svg` at `size` px (rendered large, then scaled down so thin strokes stay crisp). */
const png = (svg, size) => sharp(Buffer.from(svg), { density: 1200 }).resize(size, size).png().toBuffer();

/** The tile's mark (ring + swirl, without the rounded square) on a full-bleed Indigo square, the mark at `scale`. */
async function fullBleed(size, scale) {
  const mark = await png(tile.replace(/<rect[^>]*\/>/, ""), Math.round(size * scale));
  const off = Math.round((size - Math.round(size * scale)) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: BRAND.accent } }).composite([{ input: mark, left: off, top: off }]).png().toBuffer();
}

/** A .ico holding the given PNGs (the ICO format allows PNG entries; every current browser reads them). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.data)]);
}

/** The meeting bot's camera picture: the tile (320 px) centred on a dark radial background, 1280×720. */
async function botLogo() {
  const bg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs><radialGradient id="g" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#15142a"/><stop offset="1" stop-color="#08070f"/></radialGradient></defs><rect width="1280" height="720" fill="url(#g)"/></svg>`;
  return sharp(Buffer.from(bg)).composite([{ input: await png(tile, 320), left: 480, top: 200 }]).png().toBuffer();
}

const write = (rel, data) => {
  fs.writeFileSync(path.join(repo, rel), data);
  console.log("wrote", rel);
};

write("app/public/app-icons/icon-192.png", await png(tile, 192));
write("app/public/app-icons/icon-512.png", await png(tile, 512));
// Full bleed; the mark at 70% so a circle crop (the tightest mask) never cuts the ring.
write("app/public/app-icons/maskable-512.png", await fullBleed(512, 0.7));
write("app/public/app-icons/apple-touch-icon.png", await fullBleed(180, 0.8));
write("teams/color.png", await png(tile, 192));
write("teams/outline.png", await png(outline, 32));
write("app/src/app/favicon.ico", ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await png(flat, size) })))));
write("meetbot/bot-logo.png", await botLogo());
