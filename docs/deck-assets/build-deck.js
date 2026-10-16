// Builds "Sidekick - Pitch Deck.pptx": dark theme, teal accent, Lucide line icons, real screenshots.
const path = require("path");
const fs = require("fs");
const pptxgen = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const lu = require("react-icons/lu");
const { applyTheme } = require(process.env.SKILL_DIR + "/scripts/apply_theme.js");

const OUT = process.argv[2] || "deck.pptx";
const SCR = __dirname;
const BUILD = path.join(SCR, "build");
fs.mkdirSync(BUILD, { recursive: true });
const ASSETS = "/Users/codyscott/Desktop/sidekick/docs/deck-assets";
const DOCS = "/Users/codyscott/Desktop/sidekick/docs";

const THEME = {
  name: "Sidekick Dark",
  headFontFace: "Arial",
  bodyFontFace: "Arial",
  colors: {
    dk1: "FFFFFF", // main text (white on dark)
    lt1: "0A0F1C", // background
    dk2: "9AA8BF", // muted text
    lt2: "121A2B", // card surface
    accent1: "0F6B5C", // teal
    accent2: "2DD4BF", // light teal
    accent3: "5EEAD4", // mint highlight
    accent4: "F5B942", // amber (gaps / warnings)
    accent5: "26344D", // borders
    accent6: "18233A", // raised surface
    hlink: "5EEAD4",
    folHlink: "2DD4BF",
  },
};
const HEX = THEME.colors;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.title = "Sidekick - the AI teammate inside Microsoft Teams";
pres.author = "Cody Scott";
pres.subject = "Sidekick pitch deck";
const C = pres.SchemeColor;
const W = 13.333, H = 7.5, M = 0.6;

// ---------- assets ----------
async function icon(name, color = HEX.accent3, size = 256) {
  const file = path.join(BUILD, `ic-${name}-${color}.png`);
  if (!fs.existsSync(file)) {
    const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(lu[name], { size, color: "#" + color }));
    await sharp(Buffer.from(svg)).resize(size, size).png().toFile(file);
  }
  return file;
}

async function background(name, glows) {
  const file = path.join(BUILD, `bg-${name}.png`);
  const defs = glows.map((g, i) => `<radialGradient id="g${i}" cx="${g.cx}" cy="${g.cy}" r="${g.r}"><stop offset="0" stop-color="#${g.c}" stop-opacity="${g.o}"/><stop offset="1" stop-color="#${g.c}" stop-opacity="0"/></radialGradient>`).join("");
  const rects = glows.map((_, i) => `<rect width="1920" height="1080" fill="url(#g${i})"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="base" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0B1222"/><stop offset="1" stop-color="#070B16"/></linearGradient>${defs}</defs><rect width="1920" height="1080" fill="url(#base)"/>${rects}</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}

// Rounded-corner copy of an image (optionally cropped), sized for a given placed width in inches.
async function rounded(src, wIn, { crop, radiusIn = 0.12, name } = {}) {
  let img = sharp(src);
  if (crop) img = img.extract(crop);
  const buf = await img.png().toBuffer();
  const meta = await sharp(buf).metadata();
  const r = Math.round(radiusIn * (meta.width / wIn));
  const mask = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}"><rect width="${meta.width}" height="${meta.height}" rx="${r}" ry="${r}" fill="#fff"/></svg>`);
  const file = path.join(BUILD, `rd-${name || path.basename(src, ".png")}.png`);
  await sharp(buf).composite([{ input: mask, blend: "dest-in" }]).png().toFile(file);
  return { path: file, aspect: meta.height / meta.width };
}

// ---------- drawing helpers ----------
const shadow = () => ({ type: "outer", color: "000000", blur: 14, offset: 4, angle: 90, opacity: 0.45 });

function text(slide, t, o) {
  slide.addText(t, Object.assign({ isTextBox: true, margin: 0, color: C.text1, fontSize: 14, valign: "top" }, o));
}
function card(slide, x, y, w, h, o = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w, h, rectRadius: o.r ?? 0.14,
    fill: { color: o.fill ?? C.background2, transparency: o.ft ?? 0 },
    line: { color: o.line ?? C.accent5, width: o.lw ?? 1, transparency: o.lt ?? 0 },
    shadow: o.noShadow ? undefined : shadow(),
    objectName: o.name,
  });
}
async function tile(slide, iconName, x, y, s = 0.6, o = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, {
    x, y, w: s, h: s, rectRadius: s * 0.24,
    fill: { color: o.fill ?? C.accent1, transparency: o.ft ?? 25 },
    line: { color: o.line ?? C.accent2, width: 1, transparency: o.lt ?? 55 },
  });
  const pad = s * 0.24;
  slide.addImage({ path: await icon(iconName, o.color ?? HEX.accent3), x: x + pad, y: y + pad, w: s - 2 * pad, h: s - 2 * pad, altText: iconName.replace(/^Lu/, "") + " icon" });
}
function badge(slide, n, x, y, s = 0.42, o = {}) {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: s, h: s, rectRadius: s * 0.26, fill: { color: o.fill ?? C.accent2 }, line: { color: o.fill ?? C.accent2, width: 0.5 } });
  text(slide, String(n), { x, y, w: s, h: s, align: "center", valign: "middle", bold: true, fontSize: o.fs ?? 16, color: o.color ?? C.background1 });
}
function pill(slide, t, x, y, w, o = {}) {
  const h = o.h ?? 0.32;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: h / 2, fill: { color: o.fill ?? C.accent1, transparency: o.ft ?? 20 }, line: { color: o.line ?? C.accent2, width: 0.75, transparency: o.lt ?? 40 } });
  text(slide, t, { x, y, w, h, align: "center", valign: "middle", bold: true, fontSize: o.fs ?? 11, color: o.color ?? C.accent3, charSpacing: o.cs ?? 1.5 });
}
function arrow(slide, x1, y1, x2, y2, o = {}) {
  const flipH = x2 < x1, flipV = y2 < y1;
  slide.addShape(pres.shapes.LINE, {
    x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1) || 0.001, h: Math.abs(y2 - y1) || 0.001, flipH, flipV,
    line: { color: o.color ?? C.accent2, width: o.w ?? 1.75, endArrowType: o.noHead ? undefined : "triangle", dashType: o.dash ?? "solid", transparency: o.t ?? 0 },
  });
}
async function shot(slide, img, x, y, w) {
  const h = w * img.aspect;
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x - 0.04, y: y - 0.04, w: w + 0.08, h: h + 0.08, rectRadius: 0.15, fill: { color: C.accent6 }, line: { color: C.accent5, width: 1 }, shadow: shadow() });
  slide.addImage({ path: img.path, x, y, w, h, altText: img.alt || "Screenshot" });
  return h;
}
// Title-only content slide on the CONTENT layout.
function content(section, kicker, title) {
  const s = pres.addSlide({ masterName: "CONTENT", sectionTitle: section });
  s.addText(kicker, { placeholder: "kicker" });
  s.addText(title, { placeholder: "title" });
  return s;
}

(async () => {
  // ---------- layouts ----------
  const bgTitle = await background("title", [
    { cx: "0.82", cy: "0.30", r: "0.55", c: "0F6B5C", o: 0.55 },
    { cx: "0.10", cy: "1.00", r: "0.45", c: "1D4ED8", o: 0.14 },
  ]);
  const bgContent = await background("content", [
    { cx: "0.95", cy: "0.00", r: "0.42", c: "0F6B5C", o: 0.30 },
    { cx: "0.00", cy: "1.05", r: "0.40", c: "1E3A8A", o: 0.12 },
  ]);
  const bgSection = await background("section", [
    { cx: "0.20", cy: "0.50", r: "0.60", c: "0F6B5C", o: 0.42 },
  ]);
  const footer = [
    { text: { text: "Sidekick", options: { x: M, y: 7.02, w: 3, h: 0.3, fontSize: 10, bold: true, color: C.text2, margin: 0, charSpacing: 1 } } },
    { text: { text: "Made-up demo data · Microsoft 365 test org", options: { x: 4.17, y: 7.02, w: 5, h: 0.3, fontSize: 10, color: C.text2, align: "center", margin: 0 } } },
  ];
  pres.defineSlideMaster({
    title: "TITLE", background: { path: bgTitle },
    objects: [
      { placeholder: { options: { name: "title", type: "title", x: M, y: 2.35, w: 6.6, h: 1.25, fontSize: 66, bold: true, color: C.text1, margin: 0, valign: "middle", align: "left" }, text: "" } },
      { placeholder: { options: { name: "body", type: "body", x: M, y: 3.6, w: 6.6, h: 0.65, fontSize: 26, color: C.accent3, margin: 0, valign: "top" }, text: "" } },
    ],
  });
  pres.defineSlideMaster({
    title: "SECTION", background: { path: bgSection },
    objects: [
      { placeholder: { options: { name: "kicker", type: "body", x: M, y: 2.75, w: 9, h: 0.4, fontSize: 14, bold: true, color: C.accent2, charSpacing: 3, margin: 0 }, text: "" } },
      { placeholder: { options: { name: "title", type: "title", x: M, y: 3.15, w: 11, h: 1.0, fontSize: 48, bold: true, color: C.text1, margin: 0, valign: "top", align: "left" }, text: "" } },
      { placeholder: { options: { name: "body", type: "body", x: M, y: 4.2, w: 9.5, h: 0.9, fontSize: 18, color: C.text2, margin: 0, valign: "top" }, text: "" } },
    ],
  });
  pres.defineSlideMaster({
    title: "CONTENT", background: { path: bgContent },
    objects: [
      { placeholder: { options: { name: "kicker", type: "body", x: M, y: 0.42, w: 9, h: 0.3, fontSize: 12, bold: true, color: C.accent2, charSpacing: 3, margin: 0, valign: "middle" }, text: "" } },
      { placeholder: { options: { name: "title", type: "title", x: M, y: 0.74, w: 12.1, h: 0.7, fontSize: 34, bold: true, color: C.text1, margin: 0, valign: "middle", align: "left" }, text: "" } },
      ...footer,
    ],
    slideNumber: { x: 12.13, y: 7.02, w: 0.6, h: 0.3, fontSize: 10, color: HEX.dk2, align: "right" },
  });

  // ---------- images ----------
  const teamsAnswer = await rounded(`${ASSETS}/teams-answer.png`, 4.6, { name: "teams-answer" });
  const teamsAnswer2 = await rounded(`${ASSETS}/teams-answer.png`, 5.0, { name: "teams-answer-2" });
  const teamsNotes = await rounded(`${ASSETS}/teams-notes.png`, 3.7, { name: "teams-notes" });
  const actAssigned = await rounded(`${ASSETS}/teams-action-assigned.png`, 3.7, { name: "act-a" });
  const actUnassigned = await rounded(`${ASSETS}/teams-action-unassigned.png`, 3.7, { name: "act-u" });
  const pMeeting = await rounded(`${ASSETS}/portal-meeting-notes.png`, 8.3, { name: "p-meeting" });
  const pMemory = await rounded(`${ASSETS}/portal-memory.png`, 8.3, { name: "p-memory" });
  const pGaps = await rounded(`${ASSETS}/portal-gaps.png`, 8.3, { name: "p-gaps" });
  const pWork = await rounded(`${ASSETS}/portal-workspaces.png`, 8.3, { name: "p-work", crop: { left: 0, top: 0, width: 3026, height: 1160 } });
  const archToday = await rounded(`${DOCS}/sidekick-architecture.png`, 11.7, { name: "arch-today", crop: { left: 0, top: 262, width: 3200, height: 1538 } });
  const archTarget = await rounded(`${DOCS}/sidekick-architecture-target.png`, 11.7, { name: "arch-target", crop: { left: 0, top: 262, width: 3200, height: 1500 } });
  teamsAnswer.alt = teamsAnswer2.alt = "Sidekick answer card in Microsoft Teams with numbered sources";
  teamsNotes.alt = "Meeting notes card posted by Sidekick in Teams";
  actAssigned.alt = actUnassigned.alt = "Action item card with Assign and Mark done buttons";
  pMeeting.alt = "Sidekick portal meeting notes page"; pMemory.alt = "Sidekick portal knowledge map";
  pGaps.alt = "Sidekick portal knowledge gaps list"; pWork.alt = "Sidekick portal workspaces with linked Teams chat";
  archToday.alt = "Architecture diagram: how Sidekick works today"; archTarget.alt = "Architecture diagram: target all-Azure production";

  const await_icon_sync = { done: await icon("LuCircleCheck", HEX.accent3), next: await icon("LuCircleDashed", HEX.dk2), plan: await icon("LuCircleDot", HEX.accent4) };
  // =====================================================================
  // 1. Title
  pres.addSection({ title: "Story" });
  {
    const s = pres.addSlide({ masterName: "TITLE", sectionTitle: "Story" });
    pill(s, "AI TEAMMATE FOR MICROSOFT TEAMS", M, 1.75, 4.1);
    s.addText("Sidekick", { placeholder: "title" });
    s.addText("The AI teammate inside Microsoft Teams", { placeholder: "body" });
    text(s, "Answers with sources. Meeting notes that write themselves. A memory for every client engagement, walled off from every other.", { x: M, y: 4.45, w: 6.3, h: 0.95, fontSize: 17, color: C.text2, lineSpacingMultiple: 1.15 });
    await tile(s, "LuSparkles", M, 5.85, 0.5);
    text(s, [{ text: "Live in a Microsoft 365 test organization", options: { bold: true, color: C.text1, breakLine: true } }, { text: "October 2026 · all demo data is made up", options: { color: C.text2 } }], { x: M + 0.68, y: 5.83, w: 5.5, h: 0.56, fontSize: 13 });
    await shot(s, teamsAnswer, 7.95, 1.15, 4.6);
    s.addNotes("Sidekick is an AI teammate that lives inside Microsoft Teams. It reads a project's documents and meeting transcripts, answers questions with sources, writes the meeting notes and tracks action items. The screenshot on the right is real: Sidekick answering in Teams in our test organization, using a made-up client project.");
  }

  // 2. Problem
  {
    const s = content("Story", "THE PROBLEM", "Project knowledge is everywhere, and nowhere");
    const items = [
      ["LuFolders", "Scattered", "Decisions live in meeting recordings, documents, chats and email. Nobody can search all of it at once."],
      ["LuRepeat", "Asked again and again", "The same questions come up every week. The answer is buried in a call from three weeks ago."],
      ["LuUserPlus", "Slow onboarding", "New joiners spend their first weeks piecing together context from people who are already busy."],
      ["LuNotebookPen", "Notes nobody writes", "Action items get spoken, not written down. Owners and due dates are lost when the call ends."],
    ];
    const cw = 2.8, gap = 0.3, y = 1.85, ch = 3.35;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (cw + gap);
      card(s, x, y, cw, ch);
      await tile(s, items[i][0], x + 0.3, y + 0.32, 0.66);
      text(s, items[i][1], { x: x + 0.3, y: y + 1.15, w: cw - 0.6, h: 0.7, fontSize: 18, bold: true, valign: "bottom" });
      text(s, items[i][2], { x: x + 0.3, y: y + 1.98, w: cw - 0.6, h: 1.25, fontSize: 14, color: C.text2, lineSpacingMultiple: 1.15 });
    }
    card(s, M, 5.55, 12.1, 1.05, { fill: C.accent1, ft: 70, line: C.accent2, lt: 70, noShadow: true });
    await tile(s, "LuQuote", M + 0.3, 5.78, 0.6, { ft: 0 });
    text(s, [{ text: "“Where did we decide that?”", options: { bold: true, color: C.text1 } }, { text: "   Asked on every project, every week, and usually answered by the busiest person in the room.", options: { color: C.text2 } }], { x: M + 1.15, y: 5.55, w: 10.7, h: 1.05, fontSize: 17, valign: "middle" });
    s.addNotes("Consulting teams live in Teams meetings across many client engagements. The knowledge is there, but it is spread across recordings, files and chats, so people ask the same questions again, new joiners ramp slowly, and action items get lost.");
  }

  // 3. What Sidekick does
  {
    const s = content("Story", "THE SOLUTION", "Meet Sidekick: a teammate that remembers everything");
    const items = [
      ["LuMessageCircleQuestion", "Answers with sources", "Ask in Teams in plain language. Every claim cites the document or meeting it came from."],
      ["LuClipboardList", "Meeting notes & action items", "Summary, decisions, open questions and owners, posted to the team's chat with Assign and Done buttons."],
      ["LuMap", "Knowledge map & gaps", "Shows what the project knows, how well it's written down, and what is missing or out of date."],
      ["LuFolderLock", "Walls between clients", "Each engagement is its own workspace. Answers never mix clients, and internal material stays internal."],
    ];
    const cw = 3.95, ch = 2.35, gx = 0.3, gy = 0.3, y0 = 1.8;
    for (let i = 0; i < 4; i++) {
      const x = M + (i % 2) * (cw + gx), y = y0 + Math.floor(i / 2) * (ch + gy);
      card(s, x, y, cw, ch);
      await tile(s, items[i][0], x + 0.3, y + 0.3, 0.62);
      text(s, items[i][1], { x: x + 1.1, y: y + 0.3, w: cw - 1.35, h: 0.62, fontSize: 18, bold: true, valign: "middle" });
      text(s, items[i][2], { x: x + 0.3, y: y + 1.1, w: cw - 0.6, h: 1.1, fontSize: 14, color: C.text2, lineSpacingMultiple: 1.15 });
    }
    const rx = M + 2 * cw + gx + 0.3, rw = 12.7 - rx;
    card(s, rx, y0, rw, 2 * ch + gy, { fill: C.accent1, ft: 55, line: C.accent2, lt: 45 });
    pill(s, "COMING NEXT", rx + 0.3, y0 + 0.32, 1.7, { fill: C.background1, ft: 30 });
    await tile(s, "LuMic", rx + 0.3, y0 + 0.9, 0.7, { fill: C.background1, ft: 20 });
    text(s, "Sidekick joins the meeting", { x: rx + 0.3, y: y0 + 1.75, w: rw - 0.6, h: 0.8, fontSize: 20, bold: true });
    text(s, "Listens live, answers out loud when someone asks, and raises a virtual hand to bring back a decision the team forgot.", { x: rx + 0.3, y: y0 + 2.55, w: rw - 0.6, h: 1.3, fontSize: 14, color: C.text1, lineSpacingMultiple: 1.15 });
    text(s, "It never corrects people. It helps them remember.", { x: rx + 0.3, y: y0 + 4.1, w: rw - 0.6, h: 0.6, fontSize: 14, italic: true, bold: true, color: C.accent3 });
    s.addNotes("Four things work today: answers with sources, meeting notes with action items, a knowledge map that shows gaps, and strict walls between client engagements. Next, Sidekick joins live meetings as a participant with a virtual hand-raise.");
  }

  // 4. How it works
  {
    const s = content("Story", "IN ONE PICTURE", "How it works");
    const ins = [["LuVideo", "Meeting transcripts", "Teams recordings, Word, pasted text"], ["LuFileText", "Project documents", "PDF, Word, CSV, Markdown"], ["LuMessageSquare", "Questions in Teams", "@Sidekick in a channel or chat"]];
    const outs = [["LuQuote", "Answers with sources", "In Teams and the portal"], ["LuListChecks", "Notes & action items", "Posted to the linked chat"], ["LuMap", "Knowledge map & gaps", "What's known, what's missing"]];
    const nw = 3.55, nh = 1.05, y0 = 1.85, gy = 0.42;
    for (let i = 0; i < 3; i++) {
      const y = y0 + i * (nh + gy);
      for (const [arr, x] of [[ins, M], [outs, 12.73 - nw]]) {
        card(s, x, y, nw, nh);
        await tile(s, arr[i][0], x + 0.22, y + 0.22, 0.6);
        text(s, arr[i][1], { x: x + 0.98, y: y + 0.18, w: nw - 1.1, h: 0.36, fontSize: 15, bold: true });
        text(s, arr[i][2], { x: x + 0.98, y: y + 0.54, w: nw - 1.1, h: 0.42, fontSize: 12, color: C.text2 });
      }
    }
    // centre node
    const cx = M + nw + 0.72, cw = 12.73 - nw - 0.72 - (M + nw + 0.72), cy = 1.85, ch = 3 * nh + 2 * gy;
    card(s, cx, cy, cw, ch, { fill: C.accent1, ft: 45, line: C.accent2, lt: 30 });
    await tile(s, "LuSparkles", cx + cw / 2 - 0.45, cy + 0.35, 0.9, { fill: C.background1, ft: 10 });
    text(s, "Sidekick", { x: cx, y: cy + 1.4, w: cw, h: 0.5, fontSize: 26, bold: true, align: "center" });
    text(s, "One memory per client workspace", { x: cx + 0.2, y: cy + 1.92, w: cw - 0.4, h: 0.35, fontSize: 13, color: C.accent3, align: "center" });
    const chips = ["Search the workspace", "Claude writes the answer", "Cite every source"];
    chips.forEach((c, i) => pill(s, c, cx + 0.35, cy + 2.5 + i * 0.45, cw - 0.7, { fill: C.background1, ft: 25, color: C.text1, cs: 0, fs: 12 }));
    for (let i = 0; i < 3; i++) {
      const y = y0 + i * (nh + gy) + nh / 2;
      arrow(s, M + nw + 0.05, y, cx - 0.08, cy + ch / 2 + (i - 1) * 0.5);
      arrow(s, cx + cw + 0.08, cy + ch / 2 + (i - 1) * 0.5, 12.73 - nw - 0.05, y);
    }
    card(s, M, 6.25, 12.1, 0.55, { fill: C.background2, ft: 30, noShadow: true });
    await tile(s, "LuLock", M + 0.15, 6.32, 0.4, { ft: 10 });
    text(s, "Every step is scoped to one organization and one client workspace, and every answer can be traced back to its source.", { x: M + 0.7, y: 6.25, w: 11.2, h: 0.55, fontSize: 14, color: C.text1, valign: "middle" });
    s.addNotes("Sidekick takes in meeting transcripts and project documents, keeps one memory per client workspace, and gives back answers with sources, notes and action items, and a map of what the team knows and doesn't.");
  }

  // 5. Demo project
  pres.addSection({ title: "Demo" });
  {
    const s = content("Demo", "DEMO SETUP", "The demo: a made-up client project");
    card(s, M, 1.8, 5.6, 4.85);
    await tile(s, "LuBuilding2", M + 0.35, 2.12, 0.7);
    text(s, "Contoso Retail", { x: M + 1.25, y: 2.1, w: 4.1, h: 0.42, fontSize: 22, bold: true });
    text(s, "Cloud Migration · Sept 30 – Oct 15, 2026", { x: M + 1.25, y: 2.52, w: 4.2, h: 0.32, fontSize: 13, color: C.text2 });
    text(s, "Moving a retailer's store tills and inventory to the cloud, in waves of stores. A delivery team of four works with three people on the client side.", { x: M + 0.35, y: 3.15, w: 4.9, h: 1.0, fontSize: 14, color: C.text1, lineSpacingMultiple: 1.15 });
    const stats = [["8", "meetings"], ["9", "documents"], ["7", "people"]];
    stats.forEach(([n, l], i) => {
      const x = M + 0.35 + i * 1.68;
      card(s, x, 4.45, 1.5, 1.45, { fill: C.accent6, noShadow: true });
      text(s, n, { x, y: 4.6, w: 1.5, h: 0.75, fontSize: 40, bold: true, align: "center", color: C.accent3 });
      text(s, l, { x, y: 5.35, w: 1.5, h: 0.35, fontSize: 13, align: "center", color: C.text2 });
    });
    text(s, "Every name, number and company in the demo is invented.", { x: M + 0.35, y: 6.1, w: 4.9, h: 0.35, fontSize: 12, italic: true, color: C.text2 });
    const rx = 6.55;
    text(s, "Traps we planted for Sidekick to find", { x: rx, y: 1.8, w: 6.2, h: 0.4, fontSize: 18, bold: true });
    const traps = [
      ["LuHistory", "Out-of-date document", "The runbook says Nov 5; the cutover moved to Nov 12."],
      ["LuSplit", "Conflicting facts", "48 stores in the contract, but it may become 52."],
      ["LuUserCheck", "Missing owner", "Nobody owned the rollback plan until Oct 15."],
      ["LuVideo", "Decided only in a meeting", "The 30-minute / 45-minute rollback rule."],
      ["LuEyeOff", "Internal only", "Hours are over budget; never shown to the client."],
      ["LuCircleHelp", "Not in any source", "Someone's hourly rate: Sidekick should say it doesn't know."],
    ];
    for (let i = 0; i < traps.length; i++) {
      const y = 2.35 + i * 0.72;
      await tile(s, traps[i][0], rx, y, 0.52, { color: HEX.accent4, fill: C.accent4, ft: 82, line: C.accent4, lt: 55 });
      text(s, [{ text: traps[i][1], options: { bold: true, breakLine: true } }, { text: traps[i][2], options: { color: C.text2, fontSize: 13 } }], { x: rx + 0.7, y: y - 0.04, w: 5.5, h: 0.62, fontSize: 15 });
    }
    s.addNotes("To demo honestly we built a complete fake engagement: Contoso Retail. Eight meetings, nine documents, seven people. We planted the kind of problems real projects have: stale documents, conflicting numbers, missing owners and decisions that only exist in a meeting.");
  }

  // 6. Ask in Teams
  {
    const s = content("Demo", "DEMO · MICROSOFT TEAMS", "Ask in Teams, get an answer with sources");
    const steps = [
      ["Ask in plain language", "“When is the wave 2 cutover, how many stores, and who owns the rollback?”"],
      ["Answered from 7 sources", "Meetings, the contract, the risk log and the runbook. Every claim is tagged [S1] to [S9] with an excerpt."],
      ["Catches what people miss", "It flags that the runbook still says Nov 5, and that the store count may rise from 48 to 52."],
      ["Only this client's material", "The chat is linked to the Contoso workspace, so nothing from other clients can appear."],
    ];
    for (let i = 0; i < steps.length; i++) {
      const y = 1.8 + i * 1.15;
      badge(s, i + 1, M, y, 0.46);
      text(s, steps[i][0], { x: M + 0.7, y: y - 0.02, w: 5.6, h: 0.4, fontSize: 18, bold: true });
      text(s, steps[i][1], { x: M + 0.7, y: y + 0.4, w: 5.6, h: 0.72, fontSize: 14, color: C.text2, lineSpacingMultiple: 1.1 });
    }
    const w = 5.0, h = w * teamsAnswer2.aspect;
    await shot(s, teamsAnswer2, 12.73 - w, 1.62, w);
    text(s, "Real screenshot · Sidekick in Microsoft Teams", { x: M, y: 6.55, w: 5.6, h: 0.3, fontSize: 11, italic: true, color: C.text2 });
    s.addNotes("This is a real answer in Teams. One question, three parts. Sidekick searched only the Contoso workspace, pulled seven sources and cited each claim. It also noticed the runbook is out of date and that the store count is in question, things a busy team easily misses.");
  }

  // 7. Notes in Teams
  {
    const s = content("Demo", "DEMO · MICROSOFT TEAMS", "Meeting notes that post themselves");
    const y = 1.62;
    await shot(s, teamsNotes, M + 0.04, y, 3.7);
    const ax = 4.75;
    const h1 = await shot(s, actAssigned, ax, y, 3.7);
    await shot(s, actUnassigned, ax, y + h1 + 0.3, 3.7);
    const tx = 8.9, tw = 3.83;
    const pts = [
      ["LuNotebookPen", "Notes in seconds", "Summary, decisions and questions still open, posted to the linked chat after the meeting."],
      ["LuListChecks", "One card per action item", "Owner and due date as spoken in the meeting."],
      ["LuSquareCheck", "Assign or close in Teams", "The card, the portal tracker and the audit log update for everyone."],
      ["LuTriangleAlert", "No owner? It's flagged", "Unassigned items stand out so nothing falls through."],
    ];
    for (let i = 0; i < pts.length; i++) {
      const yy = y + i * 1.25;
      await tile(s, pts[i][0], tx, yy, 0.5);
      text(s, pts[i][1], { x: tx + 0.68, y: yy - 0.02, w: tw - 0.68, h: 0.36, fontSize: 16, bold: true });
      text(s, pts[i][2], { x: tx + 0.68, y: yy + 0.36, w: tw - 0.68, h: 0.8, fontSize: 13, color: C.text2, lineSpacingMultiple: 1.1 });
    }
    s.addNotes("After a meeting transcript is imported, Sidekick posts a notes card and one card per action item into the linked Teams chat. People can assign an owner or mark an item done right on the card, and the change shows everywhere.");
  }

  // 8. Portal meeting notes
  {
    const s = content("Demo", "DEMO · CLIENT PORTAL", "Every meeting, written up and searchable");
    const w = 8.3;
    await shot(s, pMeeting, M + 0.04, 1.65, w);
    const rx = 9.4, rw = 3.33;
    const st = [["2", "decisions"], ["5", "action items"], ["3", "open questions"], ["9", "facts learned"]];
    st.forEach(([n, l], i) => {
      const x = rx + (i % 2) * (rw / 2 + 0.08), yy = 1.65 + Math.floor(i / 2) * 1.32;
      card(s, x, yy, rw / 2 - 0.08, 1.15, { fill: C.accent6 });
      text(s, n, { x, y: yy + 0.1, w: rw / 2 - 0.08, h: 0.6, fontSize: 32, bold: true, align: "center", color: C.accent3 });
      text(s, l, { x, y: yy + 0.72, w: rw / 2 - 0.08, h: 0.3, fontSize: 12, align: "center", color: C.text2 });
    });
    text(s, "From one sprint planning meeting", { x: rx, y: 4.35, w: rw, h: 0.3, fontSize: 12, italic: true, color: C.text2 });
    await tile(s, "LuUsers", rx, 4.85, 0.5);
    text(s, [{ text: "Knows who was in the room", options: { bold: true, breakLine: true } }, { text: "Meetings with client guests are marked, so their notes only use what may be shared.", options: { color: C.text2, fontSize: 13 } }], { x: rx + 0.68, y: 4.82, w: rw - 0.68, h: 1.3, fontSize: 15, lineSpacingMultiple: 1.1 });
    s.addNotes("The same notes live in the client portal with the full transcript. Facts learned feed the long-term memory, so later questions can be answered from this meeting.");
  }

  // 9. Knowledge map
  {
    const s = content("Demo", "DEMO · MEMORY", "See what the project knows");
    await shot(s, pMemory, M + 0.04, 1.65, 8.3);
    const rx = 9.4, rw = 3.33;
    const pts = [
      ["LuMap", "Topics with coverage", "Each topic is scored for how well it is written down."],
      ["LuBadgeCheck", "Facts with their sources", "Key facts per topic, linked to the documents and meetings behind them."],
      ["LuListChecks", "Action items in one place", "33 open items tracked across 8 meetings; 6 still need an owner."],
    ];
    for (let i = 0; i < pts.length; i++) {
      const yy = 1.6 + i * 1.7;
      await tile(s, pts[i][0], rx, yy, 0.5);
      text(s, pts[i][1], { x: rx, y: yy + 0.6, w: rw, h: 0.34, fontSize: 16, bold: true });
      text(s, pts[i][2], { x: rx, y: yy + 0.95, w: rw, h: 0.62, fontSize: 13, color: C.text2, lineSpacingMultiple: 1.05 });
    }
    s.addNotes("The Memory page shows the topics Sidekick found, how well each one is covered by documents, and the key facts with their sources. It also tracks every action item from every meeting.");
  }

  // 10. Gaps
  {
    const s = content("Demo", "DEMO · MEMORY", "…and what it doesn't");
    const lx = M, lw = 3.4;
    text(s, "Sidekick tells you what the team should write down:", { x: lx, y: 1.7, w: lw, h: 0.62, fontSize: 15, color: C.text1 });
    const kinds = [
      ["Out of date", "Older document, newer decision", C.accent4],
      ["Unanswered in meeting", "A question nobody answered", C.accent4],
      ["Only in a meeting", "A decision never written down", C.accent2],
      ["Not in any source", "Asked, but no source has it", C.accent2],
    ];
    kinds.forEach(([k, d, col], i) => {
      const yy = 2.55 + i * 0.95;
      pill(s, k.toUpperCase(), lx, yy, 2.75, { fill: col, ft: 80, line: col, lt: 40, color: col, fs: 10, cs: 1 });
      text(s, d, { x: lx, y: yy + 0.4, w: lw, h: 0.4, fontSize: 13, color: C.text2 });
    });
    card(s, lx, 6.28, lw, 0.55, { fill: C.accent1, ft: 60, line: C.accent2, lt: 60, noShadow: true });
    text(s, "Each gap has a suggested fix and can be assigned.", { x: lx + 0.15, y: 6.28, w: lw - 0.3, h: 0.55, fontSize: 12, valign: "middle", color: C.text1 });
    await shot(s, pGaps, 12.73 - 8.3 - 0.04, 1.65, 8.3);
    s.addNotes("Gaps are the other half of the memory. Sidekick finds stale documents, open questions from meetings, decisions that only exist in a transcript, and questions it could not answer. Each comes with a suggested fix.");
  }

  // 11. Workspaces + link
  {
    const s = content("Demo", "DEMO · SETUP", "One workspace per client, linked to its Teams chats");
    const w = 7.9, h = await shot(s, pWork, M + 0.04, 1.62, w);
    const rx = 9.0, rw = 3.73;
    card(s, rx, 1.62, rw, h, { fill: C.accent1, ft: 60, line: C.accent2, lt: 50 });
    await tile(s, "LuLink", rx + 0.28, 1.9, 0.55, { fill: C.background1, ft: 20 });
    text(s, "Linked means walled", { x: rx + 0.28, y: 2.6, w: rw - 0.5, h: 0.4, fontSize: 17, bold: true });
    text(s, "In a linked chat Sidekick answers only from that workspace. Unlink it and Sidekick goes quiet there.", { x: rx + 0.28, y: 3.02, w: rw - 0.5, h: 0.2 + h - 1.6, fontSize: 13, color: C.text1, lineSpacingMultiple: 1.1 });
    const steps = [["LuBot", "Add Sidekick", "to a Teams channel or chat"], ["LuKeyRound", "Get a link code", "an 8-character code in the chat"], ["LuLink", "Admin links it", "enters it, picks the workspace"], ["LuUsers", "Client in the chat?", "turn on client-guest mode"]];
    const sy = 1.62 + h + 0.45, sw = 2.8, sg = 0.3;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (sw + sg);
      card(s, x, sy, sw, 6.75 - sy);
      badge(s, i + 1, x + 0.22, sy + 0.22, 0.4, { fs: 14 });
      await tile(s, steps[i][0], x + sw - 0.72, sy + 0.18, 0.5);
      text(s, steps[i][1], { x: x + 0.22, y: sy + 0.75, w: sw - 0.4, h: 0.34, fontSize: 15, bold: true });
      text(s, steps[i][2], { x: x + 0.22, y: sy + 1.08, w: sw - 0.4, h: 0.4, fontSize: 12, color: C.text2 });
    }
    s.addNotes("Each client engagement is a workspace. To bring Sidekick into a Teams chat, someone adds it, it replies with a one-time code, and an admin links the chat to the right workspace. If the client can read the chat, the admin turns on client-guest mode.");
  }

  // 12. Trust
  pres.addSection({ title: "Trust" });
  {
    const s = content("Trust", "TRUST", "Built for client confidentiality");
    const items = [
      ["LuBuilding2", "Walled by company", "Every record belongs to one organization. Nothing is ever shared across companies."],
      ["LuFolderLock", "Walled by engagement", "Every search and every AI request is limited to one client workspace."],
      ["LuEyeOff", "Internal vs Shareable", "With client guests present, Sidekick only uses documents marked Shareable."],
      ["LuQuote", "Always cites sources", "Answers come only from the workspace's own material. If it isn't there, Sidekick says so."],
      ["LuShieldCheck", "Data, not instructions", "Text inside a document or transcript can't change what Sidekick does."],
      ["LuScrollText", "Full audit log", "Sign-ins, access changes, Teams links, and everything Sidekick does on its own."],
    ];
    const cw = 3.83, ch = 2.25, gx = 0.3, gy = 0.3;
    for (let i = 0; i < 6; i++) {
      const x = M + (i % 3) * (cw + gx), y = 1.8 + Math.floor(i / 3) * (ch + gy);
      card(s, x, y, cw, ch);
      await tile(s, items[i][0], x + 0.3, y + 0.3, 0.6);
      text(s, items[i][1], { x: x + 1.08, y: y + 0.3, w: cw - 1.3, h: 0.6, fontSize: 18, bold: true, valign: "middle" });
      text(s, items[i][2], { x: x + 0.3, y: y + 1.08, w: cw - 0.6, h: 1.0, fontSize: 14, color: C.text2, lineSpacingMultiple: 1.15 });
    }
    s.addNotes("Confidentiality is designed in, not added later. Two levels of walls, a Shareable tag for anything that may be used in front of the client, sources on every answer, protection against instructions hidden in documents, and an audit log of everything.");
  }

  // 13. Client in the room
  {
    const s = content("Trust", "TRUST · CLIENT GUESTS", "When the client is in the room");
    const colW = 5.45, y = 1.85, h = 4.3;
    const cols = [
      { x: M, title: "Internal team chat", sub: "Only your people can read it", icon: "LuUsers", rows: [[true, "Uses Internal and Shareable documents"], [true, "Posts notes from every meeting"], [true, "Can answer about staffing, budget and risks"]] },
      { x: 12.73 - colW, title: "Chat with client guests", sub: "The client can read it", icon: "LuHandshake", rows: [[true, "Uses Shareable documents only"], [false, "Never posts notes from internal-only meetings"], [false, "Never reveals rates, staffing or internal risks"]] },
    ];
    for (const c of cols) {
      card(s, c.x, y, colW, h, c.icon === "LuHandshake" ? { fill: C.accent1, ft: 60, line: C.accent2, lt: 40 } : {});
      await tile(s, c.icon, c.x + 0.35, y + 0.35, 0.66);
      text(s, c.title, { x: c.x + 1.2, y: y + 0.32, w: colW - 1.5, h: 0.4, fontSize: 20, bold: true });
      text(s, c.sub, { x: c.x + 1.2, y: y + 0.72, w: colW - 1.5, h: 0.3, fontSize: 13, color: C.text2 });
      for (let i = 0; i < c.rows.length; i++) {
        const ry = y + 1.45 + i * 0.9;
        card(s, c.x + 0.35, ry, colW - 0.7, 0.72, { fill: C.background1, ft: 30, noShadow: true, r: 0.1 });
        s.addImage({ path: await icon(c.rows[i][0] ? "LuCircleCheck" : "LuBan", c.rows[i][0] ? HEX.accent3 : HEX.accent4), x: c.x + 0.55, y: ry + 0.2, w: 0.32, h: 0.32, altText: c.rows[i][0] ? "Yes" : "No" });
        text(s, c.rows[i][1], { x: c.x + 1.05, y: ry, w: colW - 1.6, h: 0.72, fontSize: 14, valign: "middle" });
      }
    }
    // switch in the middle
    const mx = W / 2;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: mx - 0.4, y: 3.62, w: 0.8, h: 0.42, rectRadius: 0.21, fill: { color: C.accent2 }, line: { color: C.accent2, width: 0.5 } });
    s.addShape(pres.shapes.OVAL, { x: mx + 0.02, y: 3.66, w: 0.34, h: 0.34, fill: { color: C.text1 }, line: { color: C.text1, width: 0.5 } });
    text(s, "Client guests", { x: mx - 0.7, y: 4.12, w: 1.4, h: 0.3, fontSize: 11, align: "center", color: C.text2 });
    text(s, "The same rule applies to imported meetings: tick “Client guests attended” and Sidekick treats that meeting as shared.", { x: M, y: 6.4, w: 12.1, h: 0.4, fontSize: 14, color: C.text2, align: "left" });
    s.addNotes("One switch changes Sidekick's behaviour. In an internal chat it can use everything in the workspace. In a chat the client can read, it only uses documents tagged Shareable and never posts notes from internal-only meetings.");
  }

  // 14-15. Architecture
  pres.addSection({ title: "Architecture" });
  {
    const s = content("Architecture", "ARCHITECTURE · TODAY", "How it runs today");
    await shot(s, archToday, (W - 5.22 / archToday.aspect) / 2, 1.6, 5.22 / archToday.aspect);
    s.addNotes("Today: Sidekick is live in our Sidekick Labs test organization. Teams sends messages through Azure Bot Service and a dev tunnel to the app; the app checks Microsoft's signed token, searches only the linked workspace, and asks Claude to answer from those passages with sources.");
  }
  {
    const s = content("Architecture", "ARCHITECTURE · PRODUCTION", "Where it's going: all on Microsoft Azure");
    await shot(s, archTarget, (W - 5.22 / archTarget.aspect) / 2, 1.6, 5.22 / archTarget.aspect);
    s.addNotes("In production everything runs in Microsoft Azure in the US: Entra ID single sign-on, Bot Service, Container Apps, Claude through Microsoft Foundry, Azure AI Search, PostgreSQL and Blob Storage with per-tenant keys, and Azure AI Speech for live meetings in step 3. One network, one bill, one sign-in.");
  }

  // 16. Owner Console
  {
    const s = content("Architecture", "OPERATIONS", "The Owner Console: run it like a service");
    const pages = [
      ["LuCircleDollarSign", "Overview", "AI spend today, this month and projected; clients, error rate, response time."],
      ["LuBuilding2", "Clients", "Every client's users, workspaces, meetings, documents, spend. Add, pause or resume."],
      ["LuActivity", "Performance & errors", "Typical and slowest responses, error rates and cache savings per feature."],
      ["LuRocket", "Releases & switches", "Running version, models in use, kill switches and the operator log."],
    ];
    const cw = 3.4, ch = 2.3;
    for (let i = 0; i < 4; i++) {
      const x = M + (i % 2) * (cw + 0.3), y = 1.8 + Math.floor(i / 2) * (ch + 0.3);
      card(s, x, y, cw, ch);
      await tile(s, pages[i][0], x + 0.28, y + 0.28, 0.58);
      text(s, pages[i][1], { x: x + 0.28, y: y + 1.0, w: cw - 0.5, h: 0.36, fontSize: 17, bold: true });
      text(s, pages[i][2], { x: x + 0.28, y: y + 1.38, w: cw - 0.5, h: 0.85, fontSize: 13, color: C.text2, lineSpacingMultiple: 1.1 });
    }
    const px = M + 2 * cw + 0.6, pw = 12.73 - px;
    card(s, px, 1.8, pw, 2 * ch + 0.3, { fill: C.accent6 });
    await tile(s, "LuPower", px + 0.3, 2.08, 0.55);
    text(s, "Kill switches", { x: px + 1.0, y: 2.06, w: pw - 1.3, h: 0.36, fontSize: 18, bold: true });
    text(s, "Pause one AI feature for every client at once", { x: px + 1.0, y: 2.42, w: pw - 1.3, h: 0.3, fontSize: 12, color: C.text2 });
    const sw = ["Answering questions", "Meeting notes", "Knowledge map", "Document uploads"];
    sw.forEach((n, i) => {
      const yy = 3.05 + i * 0.62;
      card(s, px + 0.3, yy, pw - 0.6, 0.5, { fill: C.background1, ft: 20, noShadow: true, r: 0.1 });
      text(s, n, { x: px + 0.5, y: yy, w: pw - 2, h: 0.5, fontSize: 14, valign: "middle" });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: px + pw - 1.05, y: yy + 0.12, w: 0.5, h: 0.26, rectRadius: 0.13, fill: { color: C.accent2 }, line: { color: C.accent2, width: 0.5 } });
      s.addShape(pres.shapes.OVAL, { x: px + pw - 0.79, y: yy + 0.145, w: 0.21, h: 0.21, fill: { color: C.text1 }, line: { color: C.text1, width: 0.5 } });
    });
    s.addImage({ path: await icon("LuEyeOff", HEX.accent3), x: px + 0.3, y: 5.7, w: 0.3, h: 0.3, altText: "Privacy" });
    text(s, "Owners see usage and health, never a client's documents.", { x: px + 0.75, y: 5.6, w: pw - 1.0, h: 0.5, fontSize: 13, color: C.text1, valign: "middle" });
    s.addNotes("The Owner Console is the operator's view of the whole service: spend, clients, performance and releases. Kill switches pause a feature for every client during an incident or a cost spike. Owners can see usage and health but cannot read client documents.");
  }

  // 17. Roadmap
  pres.addSection({ title: "Plan" });
  {
    const s = content("Plan", "ROADMAP", "Three steps from portal to live meetings");
    const cols = [
      { n: 1, tag: "DONE", tagFill: C.accent2, title: "Client portal + AI brain", items: ["Documents, meetings and Q&A with sources", "Knowledge map, gaps and action items", "Roles, client walls and audit log", "Usage metering and Owner Console"] },
      { n: 2, tag: "LIVE IN TEST ORG", tagFill: C.accent2, title: "Sidekick in Teams", items: ["Answers, notes and action-item cards", "Link chats to workspaces, client-guest mode", "Next: Microsoft sign-in (Entra ID)", "Next: Azure AI Search, Claude via Foundry, PostgreSQL"] },
      { n: 3, tag: "NEXT", tagFill: C.accent4, title: "Live in meetings", items: ["Joins the call as “Sidekick (AI)”", "Listens and transcribes with Azure AI Speech", "Answers out loud when asked", "Virtual hand-raise to share forgotten context"] },
    ];
    const cw = 3.83, gx = 0.3, y = 2.4;
    arrow(s, M + 0.3, 2.02, 12.43, 2.02, { color: C.accent5, w: 2, noHead: true });
    for (let i = 0; i < 3; i++) {
      const x = M + i * (cw + gx);
      badge(s, cols[i].n, x, 1.78, 0.48, { fill: i < 2 ? C.accent2 : C.accent4, fs: 18 });
      pill(s, cols[i].tag, x + 0.62, 1.86, i === 1 ? 1.95 : 1.0, { fill: cols[i].tagFill, ft: 78, line: cols[i].tagFill, color: cols[i].tagFill, fs: 10, h: 0.3 });
      card(s, x, y, cw, 4.3, i === 1 ? { fill: C.accent1, ft: 55, line: C.accent2, lt: 40 } : {});
      text(s, "STEP " + cols[i].n, { x: x + 0.3, y: y + 0.28, w: cw - 0.6, h: 0.3, fontSize: 11, bold: true, color: C.text2, charSpacing: 2 });
      text(s, cols[i].title, { x: x + 0.3, y: y + 0.58, w: cw - 0.6, h: 0.45, fontSize: 20, bold: true });
      cols[i].items.forEach((it, j) => {
        const yy = y + 1.3 + j * 0.72;
        const isNext = it.startsWith("Next:");
        s.addImage({ path: await_icon_sync[isNext ? "next" : i === 2 ? "plan" : "done"], x: x + 0.3, y: yy + 0.04, w: 0.26, h: 0.26, altText: "" });
        text(s, it, { x: x + 0.7, y: yy, w: cw - 1.0, h: 0.62, fontSize: 14, color: isNext ? C.text2 : C.text1, lineSpacingMultiple: 1.05 });
      });
    }
    s.addNotes("Step 1, the portal and AI brain, is done. Step 2, Sidekick in Teams, is live in our test organization; next in step 2 are Microsoft sign-in and the move to Azure services. Step 3 brings Sidekick into live meetings with voice and a virtual hand-raise.");
  }

  // 18. Value
  {
    const s = content("Plan", "WHY IT MATTERS", "What changes for a delivery team");
    const v = [
      ["LuClock", "Answers in seconds", "instead of digging through recordings, folders and old chats."],
      ["LuRepeat", "Fewer repeated questions", "The team asks Sidekick, not the busiest person on the project."],
      ["LuGraduationCap", "Faster onboarding", "New joiners get the project's history on day one, with sources."],
      ["LuListChecks", "Nothing falls through", "Every action item has an owner and a due date, tracked in one place."],
      ["LuShieldCheck", "Safe by design", "Walls between clients, internal stays internal, everything audited."],
      ["LuLayers", "Microsoft-native", "Lives in Teams, runs on Azure, signs in with Entra ID."],
    ];
    const cw = 5.9, ch = 1.38, gx = 0.3, gy = 0.25;
    for (let i = 0; i < 6; i++) {
      const x = M + (i % 2) * (cw + gx), y = 1.8 + Math.floor(i / 2) * (ch + gy);
      card(s, x, y, cw, ch);
      await tile(s, v[i][0], x + 0.3, y + (ch - 0.72) / 2, 0.72);
      text(s, v[i][1], { x: x + 1.3, y: y + 0.26, w: cw - 1.55, h: 0.42, fontSize: 20, bold: true });
      text(s, v[i][2], { x: x + 1.3, y: y + 0.72, w: cw - 1.55, h: 0.45, fontSize: 14, color: C.text2 });
    }
    text(s, "We'll measure these in the pilot rather than promise numbers up front.", { x: M, y: 6.6, w: 12.1, h: 0.3, fontSize: 12, italic: true, color: C.text2 });
    s.addNotes("The value is easy to see: answers in seconds, fewer repeated questions, faster onboarding and no lost action items, without risking client confidentiality. We'll measure the impact in a pilot rather than quote numbers we haven't earned yet.");
  }

  // 19. Pilot
  {
    const s = content("Plan", "PROPOSAL", "A pilot: start small, prove it, then expand");
    const ph = [
      ["LuSettings2", "Weeks 1–2", "Set up", ["IT approves Sidekick in the Teams admin catalog", "Deploy to Azure in the US", "Load one team's documents"]],
      ["LuUsers", "Weeks 3–6", "Internal pilot", ["One delivery team", "Internal meetings only", "Weekly check-ins and feedback"]],
      ["LuHandshake", "After that", "Client engagement", ["With the client's agreement", "Client-guest mode on", "Sidekick announces itself"]],
    ];
    const cw = 3.83, gx = 0.3, y = 1.8, ch = 3.1;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (cw + gx);
      card(s, x, y, cw, ch, i === 1 ? { fill: C.accent1, ft: 55, line: C.accent2, lt: 40 } : {});
      await tile(s, ph[i][0], x + 0.3, y + 0.3, 0.6);
      text(s, ph[i][1].toUpperCase(), { x: x + 1.05, y: y + 0.3, w: cw - 1.3, h: 0.28, fontSize: 11, bold: true, color: C.accent3, charSpacing: 2 });
      text(s, ph[i][2], { x: x + 1.05, y: y + 0.56, w: cw - 1.3, h: 0.38, fontSize: 18, bold: true });
      text(s, ph[i][3].map((t, j) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: j < 2 } })), { x: x + 0.3, y: y + 1.25, w: cw - 0.55, h: 1.7, fontSize: 14, color: C.text1, paraSpaceAfter: 6 });
      if (i < 2) arrow(s, x + cw + 0.04, y + ch / 2, x + cw + gx - 0.04, y + ch / 2, { w: 1.5 });
    }
    card(s, M, 5.2, 12.1, 1.5, { fill: C.accent6 });
    await tile(s, "LuTarget", M + 0.3, 5.48, 0.6);
    text(s, "How we'll know it works", { x: M + 1.1, y: 5.38, w: 4, h: 0.4, fontSize: 17, bold: true });
    const ms = ["“Helpful” rating on answers (aim: 8 in 10)", "Share of questions answered from sources", "Action items with an owner and a date", "Team feedback on time saved"];
    ms.forEach((m, i) => {
      const x = M + 1.1 + (i % 2) * 5.4, yy = 5.85 + Math.floor(i / 2) * 0.36;
      s.addImage({ path: await_icon_sync.done, x, y: yy + 0.04, w: 0.22, h: 0.22, altText: "" });
      text(s, m, { x: x + 0.34, y: yy, w: 5.0, h: 0.32, fontSize: 13, color: C.text1 });
    });
    s.addNotes("We propose a small pilot: two weeks of setup, then four weeks with one delivery team in internal meetings only, then one client engagement with that client's agreement. Success is measured by helpful ratings, answers from sources, owned action items and the team's own sense of time saved.");
  }

  // 20. Next steps
  {
    const s = content("Plan", "NEXT STEPS", "What we need to get started");
    const st = [
      ["Security review", "A one-page summary: data stays in Azure in the US, no training on your data, full audit log."],
      ["Choose a pilot team", "One delivery team and, later, one client engagement willing to try it."],
      ["Approve the Teams app", "Added once to the org app catalog, with narrow permissions."],
      ["Kick off", "Two weeks of setup, then a four-to-six week pilot with weekly check-ins."],
    ];
    for (let i = 0; i < 4; i++) {
      const y = 1.85 + i * 1.18;
      card(s, M, y, 7.3, 1.0);
      badge(s, i + 1, M + 0.28, y + 0.27, 0.46);
      text(s, st[i][0], { x: M + 1.0, y: y + 0.14, w: 6.1, h: 0.36, fontSize: 17, bold: true });
      text(s, st[i][1], { x: M + 1.0, y: y + 0.5, w: 6.1, h: 0.4, fontSize: 13, color: C.text2 });
    }
    const rx = 8.3, rw = 12.73 - rx;
    card(s, rx, 1.85, rw, 4.54, { fill: C.accent1, ft: 45, line: C.accent2, lt: 30 });
    await tile(s, "LuSparkles", rx + rw / 2 - 0.5, 2.3, 1.0, { fill: C.background1, ft: 10 });
    text(s, "Sidekick", { x: rx, y: 3.55, w: rw, h: 0.6, fontSize: 32, bold: true, align: "center" });
    text(s, "The teammate that remembers everything, and keeps every client's work private.", { x: rx + 0.4, y: 4.2, w: rw - 0.8, h: 0.9, fontSize: 16, color: C.text1, align: "center", lineSpacingMultiple: 1.15 });
    text(s, "Thank you", { x: rx, y: 5.5, w: rw, h: 0.45, fontSize: 18, bold: true, color: C.accent3, align: "center" });
    s.addNotes("To start we need a security review, a pilot team, IT approval of the Teams app, and a kickoff date. Thank you.");
  }

  // ===================== Appendix =====================
  pres.addSection({ title: "Appendix" });
  {
    const s = pres.addSlide({ masterName: "SECTION", sectionTitle: "Appendix" });
    s.addText("APPENDIX", { placeholder: "kicker" });
    s.addText("Technical detail", { placeholder: "title" });
    s.addText("How a question is answered, how meeting notes are made, security controls, the tech stack, and how Sidekick is installed in a Microsoft 365 organization.", { placeholder: "body" });
    s.addNotes("Backup slides for technical and security questions.");
  }

  // A1. RAG flow
  {
    const s = content("Appendix", "APPENDIX · HOW A QUESTION IS ANSWERED", "From question to cited answer");
    const st = [
      ["LuMessageSquare", "Question", "@Sidekick in Teams, or Ask in the portal"],
      ["LuUserCheck", "Who and where", "Checks the person, their role and the linked workspace"],
      ["LuSearch", "Search", "Finds up to 12 passages in that workspace only"],
      ["LuSparkles", "Claude writes", "Only from the numbered passages; returns answer + source ids"],
      ["LuQuote", "Answer card", "Citations [S1] with page or timestamp and an excerpt"],
      ["LuLightbulb", "Learn", "Saved; if not found, it becomes a knowledge gap"],
    ];
    const nw = 1.8, gap = (12.1 - 6 * nw) / 5, y = 1.95, nh = 2.6;
    for (let i = 0; i < 6; i++) {
      const x = M + i * (nw + gap);
      card(s, x, y, nw, nh, i === 3 ? { fill: C.accent1, ft: 45, line: C.accent2, lt: 30 } : {});
      await tile(s, st[i][0], x + (nw - 0.6) / 2, y + 0.3, 0.6);
      text(s, st[i][1], { x: x + 0.12, y: y + 1.05, w: nw - 0.24, h: 0.36, fontSize: 15, bold: true, align: "center" });
      text(s, st[i][2], { x: x + 0.15, y: y + 1.45, w: nw - 0.3, h: 1.05, fontSize: 12, color: C.text2, align: "center", lineSpacingMultiple: 1.05 });
      if (i < 5) arrow(s, x + nw + 0.03, y + nh / 2, x + nw + gap - 0.03, y + nh / 2, { w: 1.25 });
    }
    const notes = [
      ["LuShieldCheck", "Prompt safety", "Documents, transcripts and questions go to Claude inside tags; the system prompt tells it to ignore any instructions found in them."],
      ["LuEyeOff", "Client guests", "If the chat or meeting has client guests, the search only returns passages from documents tagged Shareable."],
      ["LuCpu", "Model and cost", "Claude Opus 5.5 by default, overridable per feature. Every request is metered: tokens, cost, time."],
    ];
    const cw = 3.83;
    for (let i = 0; i < 3; i++) {
      const x = M + i * (cw + 0.3), yy = 4.85;
      card(s, x, yy, cw, 1.85, { fill: C.accent6 });
      await tile(s, notes[i][0], x + 0.25, yy + 0.25, 0.46);
      text(s, notes[i][1], { x: x + 0.86, y: yy + 0.25, w: cw - 1.1, h: 0.46, fontSize: 15, bold: true, valign: "middle" });
      text(s, notes[i][2], { x: x + 0.25, y: yy + 0.85, w: cw - 0.5, h: 0.95, fontSize: 12, color: C.text2, lineSpacingMultiple: 1.05 });
    }
    s.addNotes("This is retrieval-augmented generation. The question is checked against the person and workspace, the workspace is searched, and Claude must answer only from the passages it was given, returning which sources it used. Unanswered questions become knowledge gaps.");
  }

  // A2. Meeting flow
  {
    const s = content("Appendix", "APPENDIX · HOW MEETING NOTES ARE MADE", "From transcript to Teams cards");
    const st = [
      ["LuFileText", "Import", "Teams .vtt transcript, Word file or pasted text; tick “Client guests attended” if needed"],
      ["LuSparkles", "Extract", "Claude writes summary, decisions, action items with owners and dates, open questions and lasting facts"],
      ["LuDatabase", "Save and index", "Stored in one step and added to the workspace's search, so later answers can cite it"],
      ["LuMessagesSquare", "Post to Teams", "Notes card plus one card per action item in every linked chat"],
    ];
    const nw = 2.75, gap = (12.1 - 4 * nw) / 3, y = 1.95, nh = 2.75;
    for (let i = 0; i < 4; i++) {
      const x = M + i * (nw + gap);
      card(s, x, y, nw, nh);
      badge(s, i + 1, x + 0.28, y + 0.3, 0.42, { fs: 14 });
      await tile(s, st[i][0], x + nw - 0.88, y + 0.26, 0.6);
      text(s, st[i][1], { x: x + 0.28, y: y + 1.05, w: nw - 0.5, h: 0.4, fontSize: 18, bold: true });
      text(s, st[i][2], { x: x + 0.28, y: y + 1.5, w: nw - 0.5, h: 1.15, fontSize: 13, color: C.text2, lineSpacingMultiple: 1.05 });
      if (i < 3) arrow(s, x + nw + 0.03, y + nh / 2, x + nw + gap - 0.03, y + nh / 2, { w: 1.25 });
    }
    card(s, M, 5.1, 12.1, 1.55, { fill: C.accent1, ft: 60, line: C.accent2, lt: 50 });
    await tile(s, "LuEyeOff", M + 0.3, 5.42, 0.6, { fill: C.background1, ft: 20 });
    text(s, "Walls apply here too", { x: M + 1.15, y: 5.32, w: 10.7, h: 0.38, fontSize: 17, bold: true });
    text(s, "Notes from an internal-only meeting are never posted to a chat with client guests. In channels, action items go in the notes thread. Every post is recorded in the audit log as an action Sidekick took on its own.", { x: M + 1.15, y: 5.75, w: 10.7, h: 0.8, fontSize: 14, lineSpacingMultiple: 1.1 });
    s.addNotes("A transcript goes in; Claude extracts structured notes; they are saved and indexed; then cards are posted to every linked Teams chat, respecting client-guest rules.");
  }

  // A3. Security table
  {
    const s = content("Appendix", "APPENDIX · SECURITY", "Security controls: today and in production");
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.accent3, fill: { color: C.accent6 }, fontSize: 13 } });
    const row = (a, b, c) => [{ text: a, options: { bold: true } }, { text: b, options: { color: C.text2 } }, { text: c }];
    const rows = [
      [hdr("Area"), hdr("Today (built)"), hdr("Production on Azure")],
      row("Sign-in", "Portal accounts, secure password hashes, five roles", "Entra ID single sign-on with MFA and Conditional Access"),
      row("Walls", "Every query filtered by organization and workspace", "Plus PostgreSQL row-level security, per-tenant search index and keys"),
      row("Teams", "Microsoft-signed token checked on every bot message", "Same, plus approval in the Teams admin catalog"),
      row("AI", "Claude API; every request metered", "Claude hosted on Azure via Microsoft Foundry; no training on customer data"),
      row("Network", "Local app; tunnel runs only while testing", "Private endpoints, Front Door with firewall, US region"),
      row("Audit", "Audit log of access, links and Sidekick's own actions", "Append-only log, exportable to the customer's SIEM"),
      row("Data rights", "Delete documents and meetings", "Full export, per-item forget, workspace and org deletion"),
    ];
    s.addTable(rows, { x: M, y: 1.75, w: 12.1, colW: [1.9, 4.8, 5.4], fontSize: 13, color: C.text1, fill: { color: C.background2 }, border: { type: "solid", pt: 0.75, color: HEX.accent5 }, margin: [0.07, 0.12, 0.07, 0.12], rowH: 0.56, valign: "middle" });
    s.addNotes("The left column is what exists today; the right is the production design from the blueprint, all in Azure.");
  }

  // A4. Stack table
  {
    const s = content("Appendix", "APPENDIX · TECH STACK", "Tech stack: today and target");
    const hdr = (t) => ({ text: t, options: { bold: true, color: C.accent3, fill: { color: C.accent6 }, fontSize: 13 } });
    const row = (a, b, c) => [{ text: a, options: { bold: true } }, { text: b, options: { color: C.text2 } }, { text: c }];
    const rows = [
      [hdr("Layer"), hdr("Today"), hdr("Target (all Azure)")],
      row("Web app", "Next.js 16 (React), runs locally", "Azure Container Apps or App Service behind Front Door"),
      row("Teams", "Teams SDK 2.1 + Azure Bot Service (free tier)", "Same, published to the org app catalog"),
      row("AI model", "Claude Opus 5.5 via the Claude API", "Claude via Microsoft Foundry (Haiku, Sonnet, Opus)"),
      row("Search", "Keyword search (SQLite full-text)", "Azure AI Search: hybrid keyword + vector"),
      row("Database & files", "SQLite on one machine", "Azure PostgreSQL + Blob Storage, per-tenant keys"),
      row("Identity", "Sidekick accounts", "Microsoft Entra ID"),
      row("Voice (step 3)", "—", "Azure AI Speech + C#/.NET media bot on Azure"),
      row("Monitoring", "Usage metering + Owner Console", "Azure Monitor + Application Insights"),
    ];
    s.addTable(rows, { x: M, y: 1.75, w: 12.1, colW: [2.2, 4.6, 5.3], fontSize: 13, color: C.text1, fill: { color: C.background2 }, border: { type: "solid", pt: 0.75, color: HEX.accent5 }, margin: [0.07, 0.12, 0.07, 0.12], rowH: 0.52, valign: "middle" });
    s.addNotes("Search and Claude calls each go through one module in the code, so Azure AI Search and Microsoft Foundry can be swapped in without touching the rest of the app.");
  }

  // A5. Setup
  {
    const s = content("Appendix", "APPENDIX · INSTALLATION", "Installing Sidekick in a Microsoft 365 organization");
    const st = [
      ["LuKeyRound", "Register the bot in Entra ID", "One app registration, single tenant; the secret lives only in the server's configuration."],
      ["LuBot", "Create an Azure Bot", "Turn on the Microsoft Teams channel and point it at Sidekick's messaging endpoint."],
      ["LuPlug", "Upload the Teams app", "The package passes Microsoft's 62 app-package checks; IT allows it once."],
      ["LuLink", "Add and link", "Add Sidekick to a channel or chat and link it to a workspace with the one-time code."],
      ["LuCircleCheck", "Use it", "Import a meeting or ask a question; notes and answers arrive in Teams."],
    ];
    for (let i = 0; i < st.length; i++) {
      const y = 1.8 + i * 0.97;
      badge(s, i + 1, M, y + 0.12, 0.44, { fs: 15 });
      await tile(s, st[i][0], M + 0.62, y + 0.06, 0.56);
      text(s, st[i][1], { x: M + 1.4, y: y + 0.02, w: 6.0, h: 0.36, fontSize: 16, bold: true });
      text(s, st[i][2], { x: M + 1.4, y: y + 0.38, w: 6.0, h: 0.5, fontSize: 13, color: C.text2 });
    }
    const rx = 8.25, rw = 12.73 - rx;
    card(s, rx, 1.8, rw, 4.75, { fill: C.accent6 });
    await tile(s, "LuShield", rx + 0.3, 2.1, 0.55);
    text(s, "What IT approves", { x: rx + 1.0, y: 2.1, w: rw - 1.2, h: 0.55, fontSize: 18, bold: true, valign: "middle" });
    const facts = [
      "Bot scopes: personal chat, team channels, group chats",
      "Reads only messages that @mention it (every message in a 1:1 chat with it)",
      "Only Org Owners and Admins can link or unlink a chat",
      "Every link and post is in the audit log",
    ];
    text(s, facts.map((t, j) => ({ text: t, options: { bullet: { indent: 14 }, breakLine: j < facts.length - 1 } })), { x: rx + 0.3, y: 2.95, w: rw - 0.6, h: 3.4, fontSize: 14, color: C.text1, paraSpaceAfter: 10, lineSpacingMultiple: 1.1 });
    s.addNotes("Installation takes an hour for an admin: register the bot, create the Azure Bot, upload the Teams package, then add Sidekick to a chat and link it. Permissions stay narrow.");
  }

  await pres.writeFile({ fileName: OUT });
  await applyTheme(OUT, THEME);
  console.log("wrote", OUT);
})().catch((e) => { console.error(e); process.exit(1); });
