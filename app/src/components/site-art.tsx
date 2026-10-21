/**
 * The website's illustrations: soft, rounded shapes in the Indigo palette, drawn as inline SVG so they're
 * sharp at any size, cost no extra request, need nothing from other sites (Content-Security-Policy) and
 * follow light and dark mode through the colour tokens in globals.css (classes in public-site.css, `art-*`).
 * Each is decorative: the section's heading and text carry the meaning, so they're hidden from screen readers.
 *
 * Our own artwork only: a generic chat app and generic people, never Microsoft's logos, icons or artwork.
 * Gradient and filter ids carry a per-picture prefix so two pictures on one page never clash.
 */

/** Shared soft drop shadow and the accent gradient for one picture (`p` = id prefix). */
function Defs({ p }: { p: string }) {
  return (
    <defs>
      <linearGradient id={`${p}-g`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" className="art-stop-a" />
        <stop offset="1" className="art-stop-b" />
      </linearGradient>
      <radialGradient id={`${p}-blob`} cx=".5" cy=".5" r=".5">
        <stop offset="0" className="art-stop-soft" />
        <stop offset="1" className="art-stop-clear" />
      </radialGradient>
      <filter id={`${p}-sh`} x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="6" stdDeviation="8" className="art-shadow" />
      </filter>
    </defs>
  );
}

/** A small card: rounded rect with a soft shadow. */
const Card = ({ p, x, y, w, h, r = 12 }: { p: string; x: number; y: number; w: number; h: number; r?: number }) => (
  <rect x={x} y={y} width={w} height={h} rx={r} className="art-surface" filter={`url(#${p}-sh)`} />
);
/** A text line placeholder. */
const Line = ({ x, y, w, cls = "art-line" }: { x: number; y: number; w: number; cls?: string }) => (
  <rect x={x} y={y} width={w} height={7} rx={3.5} className={cls} />
);
/** A person: head and shoulders in a soft circle. */
const Person = ({ cx, cy, r = 18, cls = "art-soft" }: { cx: number; cy: number; r?: number; cls?: string }) => (
  <g>
    <circle cx={cx} cy={cy} r={r} className={cls} />
    <circle cx={cx} cy={cy - r * 0.22} r={r * 0.32} className="art-person" />
    <path d={`M${cx - r * 0.55} ${cy + r * 0.62}a${r * 0.55} ${r * 0.5} 0 0 1 ${r * 1.1} 0`} className="art-person" />
  </g>
);

/** Home hero: a meeting turns into notes, decisions and actions that land in the team's chat. */
export function HeroArt() {
  const p = "hero";
  return (
    <svg className="site-art" viewBox="0 0 520 400" role="presentation" aria-hidden="true">
      <Defs p={p} />
      <circle cx="270" cy="200" r="190" fill={`url(#${p}-blob)`} />
      {/* Meeting window */}
      <Card p={p} x={20} y={60} w={190} h={140} r={16} />
      <rect x="20" y="60" width="190" height="26" rx="16" className="art-sunken" />
      <circle cx="36" cy="73" r="4" className="art-line" /><circle cx="48" cy="73" r="4" className="art-line" /><circle cx="60" cy="73" r="4" className="art-line" />
      {[[34, 96], [118, 96], [34, 146], [118, 146]].map(([x, y], i) => (
        <g key={i}>
          <rect x={x} y={y} width="78" height="44" rx="8" className={i === 1 ? "art-accent-soft" : "art-sunken"} />
          <Person cx={x + 39} cy={y + 22} r={14} cls={i === 1 ? "art-accent" : "art-soft"} />
        </g>
      ))}
      {/* Flow */}
      <path d="M210 130 C 260 130, 250 210, 300 210" className="art-flow" />
      <path d="M210 150 C 250 160, 240 280, 300 290" className="art-flow" />
      {/* Notes / decision / action chips */}
      <g transform="translate(232 238)">
        <Card p={p} x={0} y={0} w={96} h={34} r={10} />
        <circle cx="17" cy="17" r="9" className="art-good-soft" /><path d="M13 17l3 3 6-6" className="art-good-stroke" />
        <Line x={32} y={14} w={52} />
      </g>
      <g transform="translate(222 178)">
        <Card p={p} x={0} y={0} w={96} h={34} r={10} />
        <rect x="9" y="9" width="16" height="16" rx="4" className="art-accent-soft" /><path d="M13 14h8M13 18h6" className="art-accent-stroke" />
        <Line x={32} y={14} w={52} />
      </g>
      <g transform="translate(246 298)">
        <Card p={p} x={0} y={0} w={96} h={34} r={10} />
        <circle cx="17" cy="17" r="9" className="art-hand-soft" /><path d="M17 12v6l3 2" className="art-hand-stroke" />
        <Line x={32} y={14} w={52} />
      </g>
      {/* Chat app */}
      <Card p={p} x={330} y={40} w={170} h={320} r={18} />
      <rect x="330" y="40" width="170" height="40" rx="18" className="art-sunken" />
      <Line x={346} y={56} w={80} cls="art-line-strong" />
      <circle cx="350" cy="104" r="10" className="art-soft" /><rect x="366" y="94" width="100" height="22" rx="10" className="art-sunken" />
      <circle cx="350" cy="146" r="10" className="art-accent" />
      <rect x="366" y="134" width="120" height="124" rx="12" fill={`url(#${p}-g)`} opacity=".14" />
      <rect x="366" y="134" width="120" height="124" rx="12" className="art-card-outline" />
      <Line x={378} y={148} w={70} cls="art-accent-line" />
      <Line x={378} y={164} w={96} />
      <Line x={378} y={178} w={84} />
      <circle cx="384" cy="202" r="6" className="art-good" /><Line x={396} y={199} w={70} />
      <circle cx="384" cy="222" r="6" className="art-hand" /><Line x={396} y={219} w={60} />
      <rect x="378" y="236" width="44" height="14" rx="7" className="art-accent" />
      <rect x="346" y="320" width="138" height="26" rx="13" className="art-sunken" />
    </svg>
  );
}

/** "Every meeting, remembered": meetings on a timeline feed one memory that answers later questions. */
export function RememberArt() {
  const p = "mem";
  return (
    <svg className="site-art" viewBox="0 0 520 340" role="presentation" aria-hidden="true">
      <Defs p={p} />
      <ellipse cx="300" cy="170" rx="210" ry="150" fill={`url(#${p}-blob)`} />
      <path d="M40 270 H 300" className="art-axis" />
      {[60, 130, 200].map((x, i) => (
        <g key={x}>
          <Card p={p} x={x - 30} y={170 - i * 40} w={84} h={62} r={12} />
          <rect x={x - 30} y={170 - i * 40} width="84" height="16" rx="12" className={i === 2 ? "art-accent" : "art-accent-soft"} />
          <Line x={x - 20} y={196 - i * 40} w={58} />
          <Line x={x - 20} y={210 - i * 40} w={40} />
          <path d={`M${x + 12} ${232 - i * 40} V 270`} className="art-axis" />
          <circle cx={x + 12} cy="270" r="7" className={i === 2 ? "art-accent" : "art-soft"} />
          <path d={`M${x + 54} ${200 - i * 40} C ${x + 120} ${200 - i * 40}, 330 170, 360 160`} className="art-flow" />
        </g>
      ))}
      {/* Memory: a layered stack with a bookmark */}
      <g transform="translate(350 90)">
        <rect x="14" y="26" width="132" height="132" rx="22" className="art-accent-soft" />
        <rect x="7" y="13" width="132" height="132" rx="22" className="art-surface" filter={`url(#${p}-sh)`} />
        <rect x="0" y="0" width="132" height="132" rx="22" fill={`url(#${p}-g)`} />
        <path d="M44 34h44v56l-22-14-22 14z" className="art-on-accent" />
        <path d="M30 108h72" className="art-on-accent-stroke" />
      </g>
      <g transform="translate(372 250)">
        <Card p={p} x={0} y={0} w={128} h={50} r={12} />
        <circle cx="20" cy="25" r="9" className="art-accent" />
        <Line x={36} y={16} w={76} cls="art-accent-line" />
        <Line x={36} y={30} w={56} />
      </g>
    </svg>
  );
}

/** Security: your company holds walled-off client groups; a guest sees only Shareable; another company apart. */
export function WallsArt() {
  const p = "walls";
  return (
    <svg className="site-art" viewBox="0 0 520 360" role="presentation" aria-hidden="true">
      <Defs p={p} />
      <circle cx="260" cy="180" r="175" fill={`url(#${p}-blob)`} />
      <rect x="30" y="50" width="370" height="260" rx="24" className="art-frame" />
      <rect x="30" y="50" width="370" height="40" rx="20" className="art-accent-soft" />
      <path d="M52 78 V64 l14-8 14 8 V78z" className="art-accent" />
      <Line x={92} y={66} w={90} cls="art-accent-line" />
      {[52, 170, 288].map((x, i) => (
        <g key={x}>
          <Card p={p} x={x} y={108} w={92} h={176} r={14} />
          <rect x={x + 10} y={120} width="72" height="10" rx="5" className={i === 0 ? "art-accent" : "art-line-strong"} />
          <rect x={x + 10} y={142} width="54" height="22" rx="10" className="art-sunken" />
          <rect x={x + 28} y={172} width="54" height="22" rx="10" className={i === 0 ? "art-accent-soft" : "art-sunken"} />
          <rect x={x + 10} y={206} width="30" height="38" rx="5" className="art-soft" />
          <rect x={x + 46} y={206} width="30" height="38" rx="5" className={i === 0 ? "art-good-soft" : "art-soft"} />
          {i === 0 && <path d="M54 225l4 4 8-8" transform={`translate(${x} 0)`} className="art-good-stroke" />}
          <Person cx={x + 26} cy={266} r={10} />
          <Person cx={x + 50} cy={266} r={10} cls={i === 0 ? "art-accent-soft" : "art-soft"} />
        </g>
      ))}
      {/* Walls between groups */}
      {[152, 270].map((x) => <rect key={x} x={x} y={104} width="10" height="184" rx="5" className="art-wall" />)}
      {/* Guest outside, seeing Shareable only */}
      <path d="M120 330 C 120 300, 110 290, 112 250" className="art-flow good" />
      <g transform="translate(96 318)"><Person cx={18} cy={18} r={16} cls="art-good-soft" /></g>
      {/* Another company, fully apart */}
      <rect x="420" y="90" width="80" height="180" rx="18" className="art-frame dashed" />
      <path d="M446 128 V114 l14-8 14 8 V128z" className="art-line-strong" />
      <Line x={438} y={150} w={44} />
      <Line x={438} y={164} w={30} />
      <rect x="405" y="70" width="8" height="220" rx="4" className="art-wall" />
      <circle cx="460" cy="230" r="16" className="art-sunken" />
      <path d="M454 230h12M460 224v12" transform="rotate(45 460 230)" className="art-muted-stroke" />
    </svg>
  );
}

/** How it works: a winding road with six numbered stops, ending in the team's chat. */
export function JourneyArt() {
  const p = "jour";
  const stops: [number, number][] = [[60, 270], [150, 200], [250, 250], [330, 160], [400, 210], [460, 120]];
  return (
    <svg className="site-art" viewBox="0 0 520 340" role="presentation" aria-hidden="true">
      <Defs p={p} />
      <ellipse cx="260" cy="190" rx="240" ry="140" fill={`url(#${p}-blob)`} />
      <path d="M40 300 C 100 300, 110 200, 150 200 S 220 260, 250 250 S 300 160, 330 160 S 380 215, 400 210 S 440 130, 460 120" className="art-road" />
      <path d="M40 300 C 100 300, 110 200, 150 200 S 220 260, 250 250 S 300 160, 330 160 S 380 215, 400 210 S 440 130, 460 120" className="art-road-dash" />
      {stops.map(([x, y], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r="17" className={i === stops.length - 1 ? "art-accent" : "art-surface"} filter={`url(#${p}-sh)`} />
          <circle cx={x} cy={y} r="17" className="art-card-outline" />
          <text x={x} y={y + 5} textAnchor="middle" className={i === stops.length - 1 ? "art-num on" : "art-num"}>{i + 1}</text>
        </g>
      ))}
      {/* The chat at the end */}
      <g transform="translate(372 30)">
        <Card p={p} x={0} y={0} w={130} h={64} r={14} />
        <circle cx="22" cy="22" r="9" className="art-accent" />
        <Line x={38} y={14} w={74} cls="art-accent-line" />
        <Line x={38} y={28} w={58} />
        <Line x={16} y={44} w={96} />
        <path d="M84 64 l6 10 6-10z" className="art-surface" />
      </g>
      {/* Sign-up card at the start */}
      <g transform="translate(20 150)">
        <Card p={p} x={0} y={0} w={96} h={70} r={12} />
        <Line x={12} y={14} w={50} cls="art-line-strong" />
        <rect x="12" y="28" width="72" height="12" rx="6" className="art-sunken" />
        <rect x="12" y="48" width="40" height="12" rx="6" className="art-accent" />
      </g>
    </svg>
  );
}

/** Pricing: groups as building blocks; more groups, more people, as a firm grows. */
export function PlansArt() {
  const p = "plans";
  const cols: [number, number, number][] = [[70, 1, 0], [190, 2, 1], [310, 3, 2]];
  return (
    <svg className="site-art" viewBox="0 0 520 320" role="presentation" aria-hidden="true">
      <Defs p={p} />
      <ellipse cx="260" cy="190" rx="240" ry="130" fill={`url(#${p}-blob)`} />
      <path d="M40 280 H 480" className="art-axis" />
      {cols.map(([x, n, k]) => (
        <g key={x}>
          {Array.from({ length: n }, (_, j) => (
            <g key={j}>
              <Card p={p} x={x} y={220 - j * 66} w={100} h={56} r={12} />
              <rect x={x + 10} y={230 - j * 66} width="40" height="8" rx="4" className={k === 1 && j === n - 1 ? "art-accent" : "art-line-strong"} />
              <Person cx={x + 22} cy={256 - j * 66} r={9} />
              <Person cx={x + 44} cy={256 - j * 66} r={9} cls="art-accent-soft" />
              <Person cx={x + 66} cy={256 - j * 66} r={9} />
            </g>
          ))}
        </g>
      ))}
      <g transform="translate(430 110)">
        <rect x="0" y="0" width="70" height="160" rx="16" className="art-frame dashed" />
        <path d="M35 66v28M21 80h28" className="art-accent-stroke big" />
      </g>
      <path d="M90 200 C 160 140, 260 120, 360 60" className="art-flow" />
      <path d="M352 54 l12 4 -6 11" className="art-flow-head" />
    </svg>
  );
}

/** Help center: an open guide, a search lens and a question bubble. */
export function HelpArt() {
  const p = "help";
  return (
    <svg className="site-art" viewBox="0 0 440 300" role="presentation" aria-hidden="true">
      <Defs p={p} />
      <ellipse cx="220" cy="160" rx="200" ry="130" fill={`url(#${p}-blob)`} />
      {/* Open book */}
      <path d="M70 90 Q 140 70 210 96 V 250 Q 140 226 70 244 Z" className="art-surface" filter={`url(#${p}-sh)`} />
      <path d="M350 90 Q 280 70 210 96 V 250 Q 280 226 350 244 Z" className="art-surface" filter={`url(#${p}-sh)`} />
      <path d="M210 96 V 250" className="art-axis" />
      {[118, 140, 162, 184].map((y, i) => <rect key={y} x="92" y={y - (i === 0 ? 6 : 0)} width={i === 0 ? 70 : 96 - i * 10} height={i === 0 ? 10 : 7} rx="4" className={i === 0 ? "art-accent" : "art-line"} />)}
      {[118, 140, 162].map((y, i) => <rect key={y} x="232" y={y} width={92 - i * 14} height="7" rx="3.5" className="art-line" />)}
      {/* Lens */}
      <circle cx="306" cy="196" r="34" className="art-lens" />
      <circle cx="306" cy="196" r="34" className="art-accent-ring" />
      <path d="M330 220 l26 26" className="art-accent-stroke big" />
      {/* Question bubble */}
      <g transform="translate(300 34)">
        <rect x="0" y="0" width="90" height="56" rx="18" fill={`url(#${p}-g)`} filter={`url(#${p}-sh)`} />
        <path d="M20 56 l-4 14 16-14z" className="art-accent" />
        <text x="45" y="38" textAnchor="middle" className="art-q">?</text>
      </g>
    </svg>
  );
}
