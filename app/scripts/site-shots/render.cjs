// Re-renders the website's chat product shots (app/public/site/chat-*.webp, phone-reminder*.webp).
// Source: the pitch pack's static chat mockups (~/Desktop/Sidekick Pitch/_build/src/teams-*.html, made-up data,
// card layouts copied from Sidekick's real Teams cards), restyled by site-override.css here: Indigo brand,
// Sidekick's own fonts, a generic chat-app frame (never Microsoft's artwork), plus dark and phone variants.
// Needs Google Chrome, the pitch pack's _build/node_modules (playwright-core) and Python with Pillow.
// Usage: node app/scripts/site-shots/render.cjs   → writes 2x PNGs to a temp folder, then WebP into app/public/site/.
// The portal shots (portal-*.webp, phone-meeting*.webp) come from demo-shots.cjs here (the demo world); portal-ask.webp (light
// only, a real answer) is the final pitch capture's desktop/19-ask-answer-sources.png resized to 1600x1000.
const path = require("path"); const fs = require("fs"); const os = require("os"); const { execFileSync } = require("child_process");
const PITCH = path.join(os.homedir(), "Desktop/Sidekick Pitch/_build");
const { chromium } = require(path.join(PITCH, "node_modules/playwright-core"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "site-shots-"));
fs.cpSync(path.join(PITCH, "src"), path.join(tmp, "src"), { recursive: true });
fs.cpSync(path.join(PITCH, "fonts"), path.join(tmp, "fonts"), { recursive: true });
fs.copyFileSync(path.join(__dirname, "site-override.css"), path.join(tmp, "src/site-override.css"));
for (const f of ["teams-answer", "teams-notes", "teams-reminder"]) {
  const p = path.join(tmp, "src", f + ".html");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace('href="teams.css">', 'href="teams.css"><link rel="stylesheet" href="site-override.css">'));
}
const JOBS = [["teams-answer", "chat-answer", []], ["teams-answer", "chat-answer-dark", ["dark"]], ["teams-notes", "chat-notes", []], ["teams-notes", "chat-notes-dark", ["dark"]], ["teams-reminder", "phone-reminder", ["phone"]], ["teams-reminder", "phone-reminder-dark", ["phone", "dark"]]];
const OUT = path.resolve(__dirname, "../../public/site");
(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  for (const [src, out, cls] of JOBS) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 1200 }, deviceScaleFactor: 2 });
    await page.goto("file://" + path.join(tmp, "src", src + ".html"));
    await page.evaluate((c) => document.documentElement.classList.add(...c), cls.length ? cls : ["light"]);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.locator(".frame").screenshot({ path: path.join(tmp, out + ".png"), omitBackground: true });
    await page.close();
  }
  await browser.close();
  // Sizes match components/product-shot.tsx SHOTS (crop height in 2x pixels before resizing; 0 = whole picture).
  const py = `
import sys
from PIL import Image
tmp, out = sys.argv[1:3]
for name, width, crop in [("chat-answer",1400,0),("chat-notes",1400,1500),("phone-reminder",640,1380)]:
    for v in ["", "-dark"]:
        im = Image.open(f"{tmp}/{name}{v}.png").convert("RGBA")
        if crop: im = im.crop((0, 0, im.width, min(crop, im.height)))
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
        im.save(f"{out}/{name}{v}.webp", "WEBP", quality=82, method=6)
        print(name + v, im.size)`;
  console.log(execFileSync("python3", ["-I", "-c", py, tmp, OUT], { encoding: "utf8" }));
})().catch((e) => { console.error(e); process.exit(1); });
