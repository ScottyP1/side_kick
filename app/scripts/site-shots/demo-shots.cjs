// Captures the website's product shots that come from the seeded demo world (docs/DEMO.md): meeting notes with
// Save to knowledge, the Meetings page with automatic notes on, Needs attention on Home, Connectors, and meeting
// notes on a phone, each in light and dark, as 2x WebP files in app/public/site/ (sizes as in
// components/product-shot.tsx SHOTS). Made-up data only, from the local demo copy (preview "sidekick-demo",
// http://localhost:3330, fake Claude); never the live site.
// Needs: the demo world seeded and its copy running, Google Chrome, the pitch pack's _build/node_modules
// (playwright-core) and Python with Pillow. Demo passwords are read from app/.demo-logins.json, never printed.
// Usage: node app/scripts/site-shots/demo-shots.cjs [name ...]   (no names = all shots)
const path = require("path"); const fs = require("fs"); const os = require("os"); const { execFileSync } = require("child_process");
const PITCH = path.join(os.homedir(), "Desktop/Sidekick Pitch/_build");
const { chromium } = require(path.join(PITCH, "node_modules/playwright-core"));
const APP = path.resolve(__dirname, "../..");
const BASE = "http://localhost:3330";
const PASS = JSON.parse(fs.readFileSync(path.join(APP, ".demo-logins.json"), "utf8")).passwords;
const USERS = { teamLead: "priya.raman@northwind.example", orgOwner: "olivia.bennett@northwind.example" };
const OUT = path.join(APP, "public/site");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-demo-shots-"));
const ONLY = process.argv.slice(2);

const ALL_SHOTS = [
  { name: "portal-meeting", role: "teamLead", url: "/meetings", open: "Contoso – Sprint 14 planning" },
  { name: "portal-meetings-auto", role: "teamLead", url: "/meetings" },
  { name: "portal-attention", role: "teamLead", url: "/home", scrollTo: /Needs attention/ },
  { name: "portal-connectors", role: "orgOwner", url: "/connectors", scrollTo: /^Engineering$/ },
  { name: "phone-meeting", role: "teamLead", url: "/meetings", open: "Contoso – Sprint 14 planning", phone: true },
];
const SHOTS = ONLY.length ? ALL_SHOTS.filter((s) => ONLY.includes(s.name)) : ALL_SHOTS;

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  for (const s of SHOTS) {
    for (const dark of [false, true]) {
      const ctx = await browser.newContext({
        viewport: s.phone ? { width: 390, height: 844 } : { width: 1440, height: 900 }, deviceScaleFactor: s.phone ? 3 : 2,
        isMobile: !!s.phone, hasTouch: !!s.phone, colorScheme: dark ? "dark" : "light",
      });
      const r = await ctx.request.post(BASE + "/api/auth/login", { data: { email: USERS[s.role], password: PASS[s.role] }, headers: { origin: BASE } });
      if (!r.ok()) throw new Error(`sign-in failed (${s.role}): ${r.status()}`);
      const page = await ctx.newPage();
      await page.goto(BASE + s.url, { waitUntil: "networkidle" });
      if (s.open) { await page.getByText(s.open).last().click(); await page.waitForTimeout(1500); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(300); }
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      if (s.scrollTo) await page.evaluate((src) => { const re = new RegExp(src, "i"); const el = [...document.querySelectorAll("h2,h3,h4,b,strong,div,span")].find((x) => x.children.length === 0 && re.test(x.textContent.trim())); if (el) window.scrollBy(0, el.getBoundingClientRect().top - 90); }, s.scrollTo.source);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(tmp, `${s.name}${dark ? "-dark" : ""}.png`) });
      await ctx.close();
    }
  }
  await browser.close();
  // Laptop shots: the whole 1440x900 screen at 1600x1000. Phone: the top of the screen, 640 wide, 1132 tall.
  const py = `
import sys
from PIL import Image
tmp, out, names = sys.argv[1], sys.argv[2], sys.argv[3].split(",")
for name in names:
    for v in ["", "-dark"]:
        im = Image.open(f"{tmp}/{name}{v}.png").convert("RGB")
        if name.startswith("phone"):
            im = im.crop((0, 0, im.width, round(im.width * 1132 / 640)))
            im = im.resize((640, 1132), Image.LANCZOS)
        else:
            im = im.resize((1600, 1000), Image.LANCZOS)
        im.save(f"{out}/{name}{v}.webp", "WEBP", quality=80, method=6)
        print(name + v, im.size)`;
  console.log(execFileSync("python3", ["-I", "-c", py, tmp, OUT, SHOTS.map((s) => s.name).join(",")], { encoding: "utf8" }));
})().catch((e) => { console.error(e); process.exit(1); });
