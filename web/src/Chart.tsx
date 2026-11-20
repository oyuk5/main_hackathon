/**
 * The chart: Europe in nautical-chart colours, every portal a light on its country. A light's
 * characteristic is its state (see index.css). Portals with no known country go in the inset.
 */
import { geoGraticule, geoMercator, geoPath } from "d3-geo";
import type { FeatureCollection, MultiPolygon } from "geojson";
import { useMemo, useState } from "react";
import europe from "./geo/europe.json";
import { ANCHOR, CHARACTER, STATE_COLOR, countryOf, host, int, type PortalRow, type State } from "./lib";

/** Literal class names, so Tailwind finds them. Flares use the bright yellow; text uses the darker one. */
const GLOW: Record<State, string> = { serving: "text-serving", healing: "text-healing", failed: "text-failed", integrating: "text-integrating" };
const DOT: Record<State, string> = { serving: "fill-serving", healing: "fill-healing", failed: "fill-failed", integrating: "fill-paper" };
const STROKE: Record<State, string> = { serving: "stroke-serving", healing: "stroke-healing", failed: "stroke-failed", integrating: "stroke-integrating" };
const EDGE: Record<State, string> = { serving: "border-serving", healing: "border-healing", failed: "border-failed", integrating: "border-integrating" };

const W = 1000;
const VIEW = { w: -11.5, e: 31.5, s: 35.2, n: 62.6 };
const geo = europe as unknown as FeatureCollection<MultiPolygon>;

const SEAS: [string, [number, number]][] = [
  ["North Sea", [3.0, 56.6]],
  ["Atlantic Ocean", [-6.2, 59.7]],
  ["Baltic Sea", [18.4, 55.9]],
  ["Mediterranean Sea", [19.0, 35.9]],
  ["Norwegian Sea", [1.5, 61.6]],
];

function useProjection() {
  return useMemo(() => {
    const frame = { type: "MultiPoint" as const, coordinates: [[VIEW.w, VIEW.s], [VIEW.e, VIEW.n], [VIEW.w, VIEW.n], [VIEW.e, VIEW.s]] };
    const projection = geoMercator().fitWidth(W, frame);
    const [[, y0], [, y1]] = geoPath(projection).bounds(frame);
    projection.translate([projection.translate()[0], projection.translate()[1] - y0]);
    return { projection, H: Math.round(y1 - y0), path: geoPath(projection) };
  }, []);
}

type Placed = { p: PortalRow; x: number; y: number; side: "left" | "right" };
/** A country with more portals than fit as separate lights: one numbered marker in its worst state. */
type Cluster = { country: string; list: PortalRow[]; worst: State; x: number; y: number };

/** Above this many portals in one country, they share one numbered marker. */
const MAX_LIGHTS_PER_COUNTRY = 4;
/** At most this many portals listed under the map as "country unknown". */
const MAX_UNPLACED = 5;
const WORST: State[] = ["failed", "healing", "integrating", "serving"];

/**
 * Nudges markers apart until no two overlap (neighbouring countries such as NL, BE and LU sit
 * close together), and keeps every marker inside the frame. Deterministic: same input, same map.
 */
function spread(nodes: { x: number; y: number }[], min: number, W: number, H: number, margin: number) {
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!, b = nodes[j]!;
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.01) { dx = Math.cos(j); dy = Math.sin(j); d = 1; } // same spot: split along a fixed angle
        const push = (min - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        b.x += (dx / d) * push; b.y += (dy / d) * push;
        moved = true;
      }
    }
    for (const n of nodes) {
      n.x = Math.min(W - margin, Math.max(margin, n.x));
      n.y = Math.min(H - margin, Math.max(margin, n.y));
    }
    if (!moved) break;
  }
}

/**
 * `compact` draws the chart as a small side panel: bigger lights, no labels or sea names, and
 * portals without a country listed underneath instead of in an inset.
 */
export function Chart({ rows, hover, setHover, compact = false }: { rows: PortalRow[]; hover: string | null; setHover: (id: string | null) => void; compact?: boolean }) {
  const k = compact ? 2.3 : 1;
  const [openCountry, setOpenCountry] = useState<string | null>(null);
  const { projection, H, path } = useProjection();
  const xy = (lon: number, lat: number) => projection([lon, lat]) as [number, number];

  const { placed, clusters, unplaced, watched } = useMemo(() => {
    const byCountry = new Map<string, PortalRow[]>();
    const unplaced: PortalRow[] = [];
    for (const p of rows) {
      const c = countryOf(p);
      if (!c) unplaced.push(p);
      else byCountry.set(c, [...(byCountry.get(c) ?? []), p]);
    }
    const placed: Placed[] = [];
    const clusters: Cluster[] = [];
    for (const [c, list] of [...byCountry].sort(([a], [b]) => a.localeCompare(b))) {
      const [x, y] = xy(...ANCHOR[c]!);
      const side = ANCHOR[c]![0] < 7 ? "left" : "right";
      if (list.length > MAX_LIGHTS_PER_COUNTRY) {
        const worst = WORST.find((s) => list.some((p) => p.state === s))!;
        clusters.push({ country: c, list, worst, x, y });
        continue;
      }
      // Stable order, so lights don't swap places between polls.
      [...list].sort((a, b) => a.id.localeCompare(b.id)).forEach((p, i, all) => {
        if (all.length === 1) return placed.push({ p, x, y, side });
        const a = -Math.PI / 2 + (i / all.length) * Math.PI * 2;
        placed.push({ p, x: x + Math.cos(a) * 16 * k, y: y + Math.sin(a) * 16 * k, side });
      });
    }
    spread([...placed, ...clusters], 26 * k, W, H, 24 * k);
    return { placed, clusters, unplaced, watched: new Set(byCountry.keys()) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, projection]);

  const labels = useMemo(() => (compact ? [] : layoutLabels(placed, H)), [placed, H, compact]);
  const graticule = useMemo(() => path(geoGraticule().step([5, 5]).extent([[VIEW.w - 5, VIEW.s - 5], [VIEW.e + 5, VIEW.n + 5]])()) ?? "", [path]);
  const land = useMemo(() => path(geo) ?? "", [path]);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full select-none" role="img" aria-label={`Chart of ${rows.length} portals: ${summary(rows)}`}>
        <defs>
          <clipPath id="sea">
            <rect x="10" y="10" width={W - 20} height={H - 20} />
          </clipPath>
        </defs>
        <rect width={W} height={H} className="fill-sea" />
        <g clipPath="url(#sea)">
          <path d={graticule} className="fill-none stroke-grat" strokeWidth="0.6" />
          {!compact && SEAS.map(([name, at]) => {
            const [x, y] = xy(...at);
            return (
              <text key={name} x={x} y={y} textAnchor="middle" className="fill-slate/70 font-chart text-[17px] italic" style={{ letterSpacing: "0.04em" }}>
                {name}
              </text>
            );
          })}
          {/* Shallow water: a wide pale band and a narrow deeper band along every coast. */}
          <path d={land} className="fill-none stroke-shallow" strokeWidth="18" strokeLinejoin="round" />
          <path d={land} className="fill-none stroke-shallow-deep" strokeWidth="7" strokeLinejoin="round" />
          {geo.features.map((f) => (
            <path key={String(f.id)} d={path(f) ?? ""} className={watched.has(String(f.id)) ? "fill-land-watched" : "fill-land"} />
          ))}
          <path d={land} className="fill-none stroke-ink/35" strokeWidth="0.6" strokeLinejoin="round" />

          {labels.map((l) => (
            <Leader key={l.p.p.id} l={l} active={hover === l.p.p.id} />
          ))}
          {placed.map((pl) => (
            <Light key={pl.p.id} pl={pl} k={k} active={hover === pl.p.id} setHover={setHover} />
          ))}
          {clusters.map((cl) => (
            <ClusterMark
              key={cl.country}
              cl={cl}
              k={k}
              active={openCountry === cl.country || cl.list.some((p) => p.id === hover)}
              onOpen={() => setOpenCountry(openCountry === cl.country ? null : cl.country)}
            />
          ))}
          {labels.map((l) => (
            <Label key={l.p.p.id} l={l} active={hover === l.p.p.id} />
          ))}
        </g>
        <Neatline xy={xy} H={H} labels={!compact} />
      </svg>
      {(() => {
        const cl = clusters.find((c) => c.country === openCountry);
        return cl ? <ClusterList cl={cl} hover={hover} setHover={setHover} onClose={() => setOpenCountry(null)} /> : null;
      })()}
      {unplaced.length > 0 && <Inset rows={unplaced} hover={hover} setHover={setHover} compact={compact} />}
    </div>
  );
}

const summary = (rows: PortalRow[]) =>
  (["failed", "healing", "integrating", "serving"] as const)
    .map((s) => [s, rows.filter((r) => r.state === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${CHARACTER[s].words.toLowerCase()}`)
    .join(", ");

// ------------------------------------------------------------ lights

/** A light: a coloured beacon with a soft glow that shows its characteristic. A repair shows a turning arc. */
function Light({ pl, k, active, setHover }: { pl: Placed; k: number; active: boolean; setHover: (id: string | null) => void }) {
  const { p, x, y } = pl;
  const c = CHARACTER[p.state];
  return (
    <a
      href={`#/p/${encodeURIComponent(p.id)}`}
      aria-label={`${host(p.url)}: ${c.words}`}
      onMouseEnter={() => setHover(p.id)}
      onMouseLeave={() => setHover(null)}
      onFocus={() => setHover(p.id)}
      onBlur={() => setHover(null)}
      className="cursor-pointer outline-none"
    >
      <circle cx={x} cy={y} r={24 * k} className="fill-transparent" />
      <g className={`${c.cls} ${GLOW[p.state]}`}>
        <circle cx={x} cy={y} r={21 * k} className="fill-current" opacity="0.13" />
        <circle cx={x} cy={y} r={13 * k} className="fill-current" opacity="0.2" />
      </g>
      {p.state === "healing" && (
        <circle cx={x} cy={y} r={11.5 * k} className="spin fill-none stroke-healing" strokeWidth={2.6 * k} strokeDasharray={`${20 * k} ${52 * k}`} strokeLinecap="round" />
      )}
      <circle cx={x} cy={y} r={6.5 * k} className={`${DOT[p.state]} ${p.state === "integrating" ? "stroke-integrating" : "stroke-paper"}`} strokeWidth={(p.state === "integrating" ? 3 : 2) * k} />
      {active && <circle cx={x} cy={y} r={17.5 * k} className="fill-none stroke-ink" strokeWidth={1.5 * k} />}
    </a>
  );
}

function ClusterMark({ cl, k, active, onOpen }: { cl: Cluster; k: number; active: boolean; onOpen: () => void }) {
  const { x, y, worst, list } = cl;
  const counts = WORST.map((s) => [s, list.filter((p) => p.state === s).length] as const).filter(([, n]) => n > 0);
  const text = `${countryName(cl.country)}: ${list.length} portals, ${counts.map(([s, n]) => `${n} ${CHARACTER[s].words.toLowerCase()}`).join(", ")}`;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${text}. Show the list.`}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
      className="cursor-pointer outline-none"
    >
      <title>{`${text}. Click for the list.`}</title>
      <circle cx={x} cy={y} r={24 * k} className="fill-transparent" />
      <g className={GLOW[worst]}>
        <circle cx={x} cy={y} r={21 * k} className="fill-current" opacity="0.13" />
      </g>
      <circle cx={x} cy={y} r={11 * k} className={`fill-paper ${STROKE[worst]}`} strokeWidth={2.4 * k} />
      <text x={x} y={y} dy="0.35em" textAnchor="middle" className="fill-ink font-semibold" style={{ fontSize: `${11 * k}px` }}>
        {list.length > 99 ? "99+" : list.length}
      </text>
      {active && <circle cx={x} cy={y} r={17.5 * k} className="fill-none stroke-ink" strokeWidth={1.5 * k} />}
    </g>
  );
}

const countryName = (code: string) => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** The portals behind a numbered marker, worst first; each opens its details. */
function ClusterList({ cl, hover, setHover, onClose }: { cl: Cluster; hover: string | null; setHover: (id: string | null) => void; onClose: () => void }) {
  const order: Record<State, number> = { failed: 0, healing: 1, integrating: 2, serving: 3 };
  const list = [...cl.list].sort((a, b) => order[a.state] - order[b.state] || host(a.url).localeCompare(host(b.url)));
  return (
    <div className="mt-2 rounded-[4px] border border-hairline bg-paper">
      <div className="flex items-center justify-between border-b border-hairline px-2.5 py-1.5">
        <p className="text-[13px] font-semibold text-ink">{countryName(cl.country)}: {list.length} portals</p>
        <button type="button" onClick={onClose} aria-label="Close the list" className="rounded-[4px] px-1.5 text-[15px] leading-none text-slate hover:bg-mist hover:text-ink cursor-pointer">
          ×
        </button>
      </div>
      <ul className="max-h-[260px] overflow-y-auto py-1">
        {list.map((p) => (
          <li key={p.id}>
            <a
              href={`#/p/${encodeURIComponent(p.id)}`}
              onMouseEnter={() => setHover(p.id)}
              onMouseLeave={() => setHover(null)}
              className={`flex items-center gap-2 px-2.5 py-1 text-[13px] hover:bg-mist ${hover === p.id ? "bg-mist" : ""}`}
            >
              <Beacon state={p.state} />
              <span className="min-w-0 truncate font-medium text-ink">{host(p.url)}</span>
              <span className={`ml-auto shrink-0 text-[12px] font-semibold ${STATE_COLOR[p.state]}`}>{CHARACTER[p.state].words}</span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------ labels

type Placement = { p: Placed; x: number; y: number; h: number; anchor: "start" | "end" };
const CARD_W = 232;
const GAP = 58;

/** What a label says under the portal's name: tenders when it delivers, else the short reason. */
function shortReason(p: PortalRow): string | null {
  if (p.state === "serving") return null;
  if (p.state === "integrating") return "Learning how to read it";
  const [head, ...rest] = p.reason.split(":");
  const words = head!.trim().split(/\s+/).length;
  const text = words >= 3 || rest.length === 0 ? head! : `${head}: ${rest.join(":").split(/[,.;]/)[0]!.trim()}`;
  return text.length > 44 ? text.slice(0, 43).replace(/\s+\S*$/, "") + "…" : text;
}
const labelHeight = (p: PortalRow) => (shortReason(p) ? 62 : 44);

/** Stacks labels on each side of their lights so none overlap, keeping each close to its light. */
function layoutLabels(placed: Placed[], H: number): Placement[] {
  const out: Placement[] = [];
  for (const side of ["left", "right"] as const) {
    let group = placed.filter((p) => p.side === side).sort((a, b) => a.y - b.y);
    const need = (g: Placed[]) => g.reduce((s, p) => s + labelHeight(p.p) + 8, 0);
    if (need(group) > H - 40) group = group.filter((p) => p.p.state !== "serving");
    while (group.length && need(group) > H - 40) group = group.slice(0, -1);
    if (!group.length) continue;
    let bottom = 20;
    const col = group.map((p) => {
      const h = labelHeight(p.p);
      const y = Math.max(p.y - h / 2, bottom);
      bottom = y + h + 8;
      return { p, y, h };
    });
    const over = bottom - (H - 20);
    if (over > 0) col.forEach((c) => (c.y -= over));
    const edge = side === "left" ? Math.min(...group.map((g) => g.x)) - GAP : Math.max(...group.map((g) => g.x)) + GAP;
    for (const c of col) out.push({ p: c.p, x: edge, y: c.y, h: c.h, anchor: side === "left" ? "end" : "start" });
  }
  return out;
}

function Leader({ l, active }: { l: Placement; active: boolean }) {
  const ty = l.y + l.h / 2;
  const mid = (l.p.x + l.x) / 2;
  return (
    <path
      d={`M${l.p.x} ${l.p.y} C ${mid} ${l.p.y}, ${mid} ${ty}, ${l.x} ${ty}`}
      className={`fill-none ${active ? "stroke-ink" : "stroke-ink/30"}`}
      strokeWidth={active ? 1.4 : 1}
    />
  );
}

function Label({ l, active }: { l: Placement; active: boolean }) {
  const p = l.p.p;
  const c = CHARACTER[p.state];
  const reason = shortReason(p);
  const x = l.anchor === "end" ? l.x - CARD_W : l.x;
  return (
    <foreignObject x={x} y={l.y} width={CARD_W} height={l.h} className="pointer-events-none max-md:hidden">
      <div
        className={`h-full border-l-[3px] ${EDGE[p.state]} bg-paper/95 px-2.5 py-1.5 leading-tight shadow-[0_0_0_1px_var(--color-hairline)] ${active ? "ring-2 ring-ink" : ""}`}
      >
        <p className="narrow truncate text-[15px] font-bold">{host(p.url)}</p>
        <p className="mt-0.5 truncate text-[13px]">
          <span className={`font-semibold ${STATE_COLOR[p.state]}`}>{c.words}</span>
          {(p.state === "serving" || p.state === "healing") && <span className="text-slate">, {int(p.tenderCount)} open tenders</span>}
        </p>
        {reason && <p className="mt-0.5 truncate text-[12.5px] text-slate">{reason}</p>}
      </div>
    </foreignObject>
  );
}

// ------------------------------------------------------------ frame

/** A quiet frame with a tick every 5 degrees, labelled every 10. */
function Neatline({ xy, H, labels }: { xy: (lon: number, lat: number) => [number, number]; H: number; labels: boolean }) {
  const ticks: React.ReactNode[] = [];
  for (let lon = -10; lon <= 30; lon += 5) {
    const x = xy(lon, 50)[0];
    ticks.push(<line key={`t${lon}`} x1={x} x2={x} y1={10} y2={lon % 10 === 0 ? 18 : 15} className="stroke-ink/50" />);
    ticks.push(<line key={`b${lon}`} x1={x} x2={x} y1={H - 10} y2={H - (lon % 10 === 0 ? 18 : 15)} className="stroke-ink/50" />);
  }
  for (let lat = 40; lat <= 60; lat += 5) {
    const y = xy(0, lat)[1];
    ticks.push(<line key={`l${lat}`} x1={10} x2={lat % 10 === 0 ? 18 : 15} y1={y} y2={y} className="stroke-ink/50" />);
    ticks.push(<line key={`r${lat}`} x1={W - 10} x2={W - (lat % 10 === 0 ? 18 : 15)} y1={y} y2={y} className="stroke-ink/50" />);
  }
  return (
    <g aria-hidden="true">
      <rect x="10" y="10" width={W - 20} height={H - 20} className="fill-none stroke-ink/50" strokeWidth="1" />
      {ticks}
      {labels && [-10, 0, 10, 20, 30].map((lon) => (
        <text key={lon} x={xy(lon, 50)[0] + 4} y={30} className="narrow fill-slate text-[11px]">
          {Math.abs(lon)}°{lon < 0 ? "W" : lon > 0 ? "E" : ""}
        </text>
      ))}
      {labels && [40, 50, 60].map((lat) => (
        <text key={lat} x={22} y={xy(0, lat)[1] - 4} className="narrow fill-slate text-[11px]">
          {lat}°N
        </text>
      ))}
    </g>
  );
}

// ------------------------------------------------------------ inset

function Inset({ rows, hover, setHover, compact }: { rows: PortalRow[]; hover: string | null; setHover: (id: string | null) => void; compact: boolean }) {
  return (
    <div className={compact ? "mt-2" : "absolute top-[4%] right-[2.5%] w-[min(330px,44%)] border border-hairline bg-paper/95 p-[3px] shadow-sm max-md:static max-md:mt-3 max-md:w-full"}>
      <div className={compact ? "" : "px-3 pt-2 pb-2.5"}>
        <p className="font-chart text-[15px] text-slate italic">Not on the map: country unknown</p>
        <ul className="mt-1.5 space-y-1.5">
          {rows.slice(0, MAX_UNPLACED).map((p) => {
            const c = CHARACTER[p.state];
            return (
              <li key={p.id}>
                <a
                  href={`#/p/${encodeURIComponent(p.id)}`}
                  onMouseEnter={() => setHover(p.id)}
                  onMouseLeave={() => setHover(null)}
                  className={`flex items-center gap-2 rounded-sm text-[13.5px] ${hover === p.id ? "bg-ink/5" : ""}`}
                >
                  <Beacon state={p.state} />
                  <span className="narrow min-w-0 truncate font-semibold">{host(p.url)}</span>
                  <span className={`ml-auto shrink-0 text-[12.5px] font-semibold ${STATE_COLOR[p.state]}`}>{c.words}</span>
                </a>
              </li>
            );
          })}
        </ul>
        {rows.length > MAX_UNPLACED && <p className="mt-1.5 text-[12.5px] text-slate">and {rows.length - MAX_UNPLACED} more, listed in the table</p>}
      </div>
    </div>
  );
}

/** Small beacon for lists and the key. */
export function Beacon({ state, size = 16 }: { state: State; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-8 -8 16 16" aria-hidden="true" className="shrink-0">
      <g className={`${CHARACTER[state].cls} ${GLOW[state]}`}>
        <circle r="7.5" className="fill-current" opacity="0.22" />
      </g>
      <circle r="4" className={`${DOT[state]} ${state === "integrating" ? "stroke-integrating" : "stroke-paper"}`} strokeWidth={state === "integrating" ? 2 : 1.2} />
    </svg>
  );
}
