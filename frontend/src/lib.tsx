import type { JSX } from "react";

/** Committed tile faces by height (1..5): light cream → deep gold. */
export const TILE_FACES = ["#F6E9D2", "#EED9AE", "#E6C887", "#DDB75F", "#D2A23C"];

/** Avatar colors by seat. */
export const AVATAR_COLORS = [
  { bg: "#F4C0D1", fg: "#72243E" },
  { bg: "#C0DD97", fg: "#27500A" },
  { bg: "#FAC775", fg: "#633806" },
  { bg: "#B5D4F4", fg: "#0C447C" },
];

export const displayLetter = (t: string) => (t === "qu" ? "Qu" : t.toUpperCase());

export const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase() || "?";

export function Tile({
  letter,
  height = 1,
  isNew = false,
  selected = false,
  dim = false,
  tappable = false,
  onClick,
}: {
  letter: string;
  height?: number;
  isNew?: boolean;
  selected?: boolean;
  dim?: boolean;
  tappable?: boolean;
  onClick?: () => void;
}) {
  const cls = ["tile", isNew && "is-new", selected && "selected", dim && "dim", tappable && "tappable"]
    .filter(Boolean)
    .join(" ");
  const style = isNew ? undefined : { background: TILE_FACES[Math.min(height, 5) - 1] };
  return (
    <div className={cls} style={style} onClick={onClick}>
      {displayLetter(letter)}
      {height > 1 && <span className="num">{height}</span>}
    </div>
  );
}

const S = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function Icon({ name, size = 18 }: { name: string; size?: number }): JSX.Element {
  const p = { width: size, height: size, viewBox: "0 0 24 24", ...S } as const;
  switch (name) {
    case "plus":
      return <svg {...p}><path d="M12 5v14M5 12h14" /></svg>;
    case "check":
      return <svg {...p}><path d="M5 12l5 5L20 7" /></svg>;
    case "undo":
      return <svg {...p}><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></svg>;
    case "shuffle":
      return <svg {...p}><path d="M16 4h4v4" /><path d="M4 20L20 4" /><path d="M16 20h4v-4" /><path d="M4 4l5 5" /><path d="M15 15l5 5" /></svg>;
    case "users":
      return <svg {...p}><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5" /><path d="M16 6a3 3 0 0 1 0 6M21 20c0-2-1-4-3-4.5" /></svg>;
    case "clock":
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case "history":
      return <svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></svg>;
    case "layers":
      return <svg {...p}><path d="M12 3l9 5-9 5-9-5 9-5z" /><path d="M3 13l9 5 9-5" /></svg>;
    case "book":
      return <svg {...p}><path d="M4 5a2 2 0 0 1 2-2h12v16H6a2 2 0 0 0-2 2z" /><path d="M18 19a2 2 0 0 1 0 2H6" /></svg>;
    case "flag":
      return <svg {...p}><path d="M5 21V4h11l-1.5 4L16 12H5" /></svg>;
    case "leave":
      return <svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></svg>;
    case "x":
      return <svg {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>;
    case "copy":
      return <svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>;
    case "menu":
      return <svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></svg>;
    case "trophy":
      return (
        <svg {...p}>
          <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
          <path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3" />
          <path d="M9 20h6M10 20l.5-4M14 20l-.5-4" />
        </svg>
      );
    case "swap":
      return <svg {...p}><path d="M7 4l-3 3 3 3" /><path d="M4 7h13a3 3 0 0 1 0 6h-1" /><path d="M17 20l3-3-3-3" /><path d="M20 17H7a3 3 0 0 1 0-6h1" /></svg>;
    case "pass":
      return <svg {...p}><path d="M13 5l7 7-7 7" /><path d="M4 12h16" /></svg>;
    case "ban":
      return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M5.64 5.64l12.72 12.72" /></svg>;
    default:
      return <svg {...p} />;
  }
}

/** 30s countdown ring (seconds remaining of total). */
export function TimerRing({ seconds, total = 30 }: { seconds: number; total?: number }): JSX.Element {
  const c = 2 * Math.PI * 16;
  const off = c * (1 - Math.max(0, seconds) / total);
  return (
    <svg width="38" height="38" viewBox="0 0 38 38">
      <circle cx="19" cy="19" r="16" fill="none" stroke="#E2DCCE" strokeWidth="3" />
      <circle
        cx="19"
        cy="19"
        r="16"
        fill="none"
        stroke="#0C447C"
        strokeWidth="3"
        strokeLinecap="round"
        strokeDasharray={c.toFixed(1)}
        strokeDashoffset={off.toFixed(1)}
        transform="rotate(-90 19 19)"
      />
      <text x="19" y="23" textAnchor="middle" fontSize="13" fontWeight="500" fill="#2C271C">
        {Math.max(0, Math.ceil(seconds))}
      </text>
    </svg>
  );
}
