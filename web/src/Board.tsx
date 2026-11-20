/**
 * The issues board: every problem as a ticket in one of three lanes, read left to right in order
 * of urgency. Needs a person, Fixing itself, Fixed by itself (last 24 h). Healthy portals live
 * in the Portals tab.
 * Tickets are built from the overview only; a ticket opens the portal's side panel.
 */
import { Beacon } from "./Chart";
import { CHARACTER, STATE_COLOR, clock, duration, host, int, plural, when, type PortalRow, type RecentRun } from "./lib";

type Lane = "person" | "fixing" | "fixed" | "clear";

interface Ticket {
  key: string;
  p: PortalRow;
  title: string;
  body: string;
  meta: string[];
  tried?: string;
  working?: boolean;
}

const LANES: { id: Lane; title: string; note: string; empty: string; tone: string }[] = [
  { id: "person", title: "Needs a person", note: "Watchtower could not fix these on its own.", empty: "Nothing needs a person.", tone: "border-failed" },
  { id: "fixing", title: "Fixing itself", note: "Repairs and first attaches running now. The last correct tenders stay served.", empty: "No repair running.", tone: "border-healing" },
  { id: "fixed", title: "Fixed by itself", note: "Portals that changed in the last 24 hours and were repaired without help.", empty: "No repairs in the last 24 hours.", tone: "border-serving" },
];

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1).replace(/\s+\S*$/, "") + "…" : s);

/**
 * A ticket's title and description from a reason sentence.
 * "Documents need a login: the button…" gives title "Documents need a login" and the rest as text.
 * A short label ("Blocked: robots.txt disallows /api/, where…") keeps its first clause in the title.
 * A reason without a label uses its first sentence as the title and the rest as text.
 */
export function ticketText(reason: string, max = 64): { title: string; body: string } {
  const r = reason.trim();
  const colon = r.indexOf(": ");
  const firstClause = (s: string) => s.split(/[,;]\s|\.\s|\.$/)[0]!.trim();
  if (colon > 0) {
    const label = r.slice(0, colon);
    const rest = r.slice(colon + 2);
    if (label.split(/\s+/).length >= 3) return { title: clip(label, max), body: cap(rest) };
    return { title: clip(`${label}: ${firstClause(rest)}`, max), body: r };
  }
  const first = firstClause(r);
  const rest = r.slice(first.length).replace(/^[.,;]\s*/, "");
  return { title: clip(cap(first), max), body: cap(rest) };
}

const newestFirst = (runs: RecentRun[] = []) => [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

/** When the current trouble began: the oldest run in the unbroken streak of runs that did not pass. */
function troubleSince(p: PortalRow): string | null {
  let since: string | null = null;
  for (const r of newestFirst(p.recent)) {
    if (r.kind === "read" && r.result === "ok") break;
    since = r.startedAt;
  }
  return since;
}

function served(p: PortalRow) {
  return p.tenderCount > 0 ? `${plural(p.tenderCount, "tender")} still served` : "Nothing delivered yet";
}

function tickets(rows: PortalRow[], now: number): Record<Lane, Ticket[]> {
  const out: Record<Lane, Ticket[]> = { person: [], fixing: [], fixed: [], clear: [] };
  for (const p of rows) {
    const runs = newestFirst(p.recent);
    const since = troubleSince(p);

    if (p.state === "failed") {
      const tried = runs.find((r) => r.kind === "repair" && r.result === "failed")?.summary;
      out.person.push({
        key: p.id, p, ...ticketText(p.reason), tried: tried || undefined,
        meta: [since ? `Broke ${when(since, now)}` : "Never delivered", served(p)],
      });
    } else if (p.state === "healing") {
      const repair = runs.find((r) => r.kind === "repair" && r.result === null);
      out.fixing.push({
        key: p.id, p, ...ticketText(p.reason.replace(/^Repairing:\s*/i, "")), working: true,
        meta: [repair ? `Repair started ${when(repair.startedAt, now)}` : since ? `Broke ${when(since, now)}` : "Repair queued", served(p)],
      });
    } else if (p.state === "integrating") {
      out.fixing.push({ key: p.id, p, title: "Learning a new portal", body: p.reason, working: true, meta: ["First tenders arrive once the recipe passes every check"] });
    } else {
      out.clear.push({ key: p.id, p, title: host(p.url), body: p.reason, meta: [] });
    }

    // Every repair that worked in the last 24 hours is a closed ticket, whatever the state is now.
    runs.forEach((r, i) => {
      if (r.kind !== "repair" || r.result !== "ok") return;
      const broke = runs.slice(i + 1).find((x) => x.result === "failed");
      out.fixed.push({
        key: `${p.id}-${r.startedAt}`, p,
        title: ticketText(broke?.summary || "The portal changed").title,
        body: r.summary || "Repaired.",
        meta: [
          `Broke ${clock(broke?.startedAt ?? r.startedAt)}, repaired ${clock(r.finishedAt ?? r.startedAt)}`,
          r.finishedAt ? `took ${duration(broke?.startedAt ?? r.startedAt, r.finishedAt)}` : "",
        ].filter(Boolean),
      });
    });
  }
  out.fixed.sort((a, b) => b.key.localeCompare(a.key));
  return out;
}

/** Issues still open: what needs a person plus what is fixing itself. */
export function openIssues(rows: PortalRow[], now: number): number {
  const t = tickets(rows, now);
  return t.person.length + t.fixing.length;
}

export function Board({ rows, now, hover, setHover }: { rows: PortalRow[]; now: number; hover: string | null; setHover: (id: string | null) => void }) {
  const t = tickets(rows, now);
  return (
    <section aria-label="Issues" className="grid gap-5 lg:grid-cols-3">
      {LANES.map((lane) => (
        <div key={lane.id} className={`flex min-w-0 flex-col border-t-[3px] ${lane.tone} bg-paper/60`}>
          <header className="px-1 pt-3 pb-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="wide text-[16px] font-[750] tracking-[-0.01em]">{lane.title}</h2>
              <span className="num wide text-[16px] font-[750] text-slate">{t[lane.id].length}</span>
            </div>
            <p className="mt-0.5 text-[13px] leading-snug text-slate">{lane.note}</p>
          </header>
          {t[lane.id].length === 0 ? (
            <p className="border border-dashed border-hairline px-4 py-6 text-center text-[13.5px] text-faint">{lane.empty}</p>
          ) : lane.id === "clear" ? (
            <ul className="border border-hairline bg-paper">
              {t.clear.map((k) => <ClearRow key={k.key} k={k} now={now} hover={hover} setHover={setHover} />)}
            </ul>
          ) : (
            <ul className="space-y-3">
              {t[lane.id].map((k) => <Card key={k.key} k={k} lane={lane.id} hover={hover} setHover={setHover} />)}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

const EDGE: Record<Lane, string> = { person: "border-l-failed", fixing: "border-l-healing", fixed: "border-l-serving", clear: "border-l-hairline" };

function Card({ k, lane, hover, setHover }: { k: Ticket; lane: Lane; hover: string | null; setHover: (id: string | null) => void }) {
  const p = k.p;
  return (
    <li>
      <a
        href={`#/p/${encodeURIComponent(p.id)}`}
        onMouseEnter={() => setHover(p.id)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(p.id)}
        onBlur={() => setHover(null)}
        className={`block border border-l-[3px] border-hairline ${EDGE[lane]} bg-paper px-4 py-3 transition-colors ${hover === p.id ? "border-r-ink/30 border-y-ink/30 bg-mist" : "hover:bg-mist"}`}
      >
        <span className="flex items-center gap-2 text-[13px]">
          <Beacon state={p.state} size={15} />
          <span className="narrow min-w-0 truncate font-semibold">{host(p.url)}</span>
          {k.working && <span className="ml-auto shrink-0 text-[12px] text-slate">working</span>}
        </span>
        <span className="mt-1.5 block text-[15px] leading-snug font-semibold">{k.title}</span>
        <span className="mt-1 block text-[13.5px] leading-snug text-slate">{k.body}</span>
        {k.tried && (
          <span className="mt-2 block border-l-2 border-hairline pl-2.5 text-[13px] leading-snug text-slate">
            <span className="font-semibold text-ink">Tried: </span>{k.tried}
          </span>
        )}
        <span className="mt-2.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] text-faint">
          {k.meta.map((m) => <span key={m}>{m}</span>)}
        </span>
      </a>
    </li>
  );
}

function ClearRow({ k, now, hover, setHover }: { k: Ticket; now: number; hover: string | null; setHover: (id: string | null) => void }) {
  const p = k.p;
  return (
    <li className="border-b border-hairline last:border-b-0">
      <a
        href={`#/p/${encodeURIComponent(p.id)}`}
        onMouseEnter={() => setHover(p.id)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(p.id)}
        onBlur={() => setHover(null)}
        className={`grid grid-cols-[auto_1fr_auto] items-center gap-x-2.5 px-3.5 py-2.5 ${hover === p.id ? "bg-mist" : "hover:bg-mist"}`}
      >
        <Beacon state={p.state} size={15} />
        <span className="min-w-0">
          <span className="narrow block truncate text-[14.5px] font-semibold">{host(p.url)}</span>
          <span className="block text-[12.5px] text-slate">{p.lastSuccessAt ? `Last read ${when(p.lastSuccessAt, now)}` : CHARACTER[p.state].words}</span>
        </span>
        <span className="text-right">
          <span className="num wide block text-[15px] leading-tight font-[700]">{int(p.tenderCount)}</span>
          <span className={`block text-[11.5px] ${STATE_COLOR[p.state]}`}>open</span>
        </span>
      </a>
    </li>
  );
}
