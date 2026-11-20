/**
 * The log: every run across all portals, newest first, grouped by day. Each entry says what
 * went wrong or what was done, and how it ended. A row opens to show the steps the run logged.
 * Passing reads are left out by default; they are most runs and say nothing new.
 */
import { useMemo, useState } from "react";
import { clock, duration, host, plural, usd, usePoll, type PortalRow } from "./lib";

interface LogRow {
  id: string;
  portal_id: string;
  url: string;
  kind: "read" | "repair";
  started_at: string;
  finished_at: string | null;
  result: "ok" | "failed" | null;
  summary: string;
  cost_usd: number;
  events: { at: string; level: string; message: string }[];
}

type Outcome = "passed" | "problem" | "repaired" | "unrepaired" | "running";

const OUTCOME: Record<Outcome, { label: string; cls: string; dot: string }> = {
  problem: { label: "Problem found", cls: "text-failed", dot: "bg-failed" },
  unrepaired: { label: "Could not repair", cls: "text-failed", dot: "bg-failed" },
  running: { label: "Running", cls: "text-healing-text", dot: "bg-healing" },
  repaired: { label: "Repaired", cls: "text-serving", dot: "bg-serving" },
  passed: { label: "Passed", cls: "text-slate", dot: "bg-serving/60" },
};

function outcome(r: LogRow): Outcome {
  if (r.result === null) return "running";
  if (r.kind === "repair") return r.result === "ok" ? "repaired" : "unrepaired";
  return r.result === "ok" ? "passed" : "problem";
}

type Filter = "all" | "problems" | "repairs";
const FILTERS: { id: Filter; label: string; keep: (r: LogRow) => boolean }[] = [
  { id: "all", label: "Everything", keep: () => true },
  { id: "problems", label: "Problems", keep: (r) => r.result === "failed" },
  { id: "repairs", label: "Repairs", keep: (r) => r.kind === "repair" },
];

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso).toDateString();
  if (d === new Date(now).toDateString()) return "Today";
  if (d === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return dayFmt.format(new Date(iso));
}

export function Log({ portals, now }: { portals: PortalRow[]; now: number }) {
  const [passing, setPassing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<string | null>(null);
  const { data, failing } = usePoll<LogRow[]>(`/internal/log${passing ? "?all=1" : ""}`, 5000);

  const rows = useMemo(() => {
    const keep = FILTERS.find((f) => f.id === filter)!.keep;
    const ids = new Set(portals.map((p) => p.id));
    return (data ?? []).filter((r) => keep(r) && ids.has(r.portal_id));
  }, [data, filter, portals]);

  const days = useMemo(() => {
    const out: { label: string; rows: LogRow[] }[] = [];
    for (const r of rows) {
      const label = dayLabel(r.started_at, now);
      if (out.at(-1)?.label !== label) out.push({ label, rows: [] });
      out.at(-1)!.rows.push(r);
    }
    return out;
  }, [rows, now]);

  return (
    <section aria-labelledby="log" className="border border-hairline bg-paper">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-hairline px-5 py-3">
        <h2 id="log" className="text-[14px] font-semibold">{data ? plural(rows.length, "entry", "entries") : "Log"}</h2>
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`h-7 rounded-full border px-2.5 text-[12.5px] font-semibold ${filter === f.id ? "border-ink bg-ink text-paper" : "border-hairline text-slate hover:border-ink/40 hover:text-ink"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto sm:w-auto">
          <label className="flex items-center gap-2 text-[13px] text-slate">
            <input type="checkbox" checked={passing} onChange={(e) => setPassing(e.target.checked)} className="size-4 accent-[var(--color-ink)]" />
            Include reads that passed
          </label>
        </div>
      </div>

      {failing && !data && <p className="px-5 py-10 text-center text-[14px] text-failed">The log could not be loaded. Retrying every 5 seconds.</p>}
      {data && rows.length === 0 && (
        <p className="px-5 py-10 text-center text-[14px] text-slate">
          {passing || filter !== "all" ? "Nothing matches these filters." : "No problems or repairs yet. Tick “Include reads that passed” to see every read."}
        </p>
      )}

      {rows.length > 0 && (
        <div className="hidden grid-cols-[64px_minmax(0,0.9fr)_minmax(0,2fr)_150px_70px_70px] gap-x-4 border-b border-hairline px-5 py-2 text-[12px] text-slate md:grid">
          <span>Time</span>
          <span>Portal</span>
          <span>What happened</span>
          <span>Outcome</span>
          <span className="text-right">Took</span>
          <span className="text-right">Model cost</span>
        </div>
      )}

      {days.map((d) => (
        <div key={d.label}>
          <h3 className="sticky top-0 z-10 border-b border-hairline bg-mist px-5 py-1.5 text-[12.5px] font-semibold text-slate">{d.label}</h3>
          <ol>
            {d.rows.map((r) => (
              <Entry key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

function Entry({ r, open, toggle }: { r: LogRow; open: boolean; toggle: () => void }) {
  const o = OUTCOME[outcome(r)];
  const step = r.kind === "repair" ? "Repair" : "Read";
  const text = r.summary || (r.result === null ? `${step} in progress.` : "");
  return (
    <li className="border-b border-hairline last:border-b-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        disabled={r.events.length === 0}
        className="grid w-full gap-x-4 gap-y-1 px-5 py-3 text-left enabled:hover:bg-mist md:grid-cols-[64px_minmax(0,0.9fr)_minmax(0,2fr)_150px_70px_70px]"
      >
        <span className="num text-[13px] text-slate md:pt-px">{clock(r.started_at)}</span>
        <span className="min-w-0">
          <span className="narrow block truncate text-[14.5px] font-semibold">{host(r.url)}</span>
          <span className="block text-[12.5px] text-slate">{step}</span>
        </span>
        <span className="text-[14px] leading-snug">
          {text}
          {r.events.length > 0 && (
            <span className="ml-1.5 text-[12.5px] whitespace-nowrap text-faint">{open ? "Hide steps" : plural(r.events.length, "step")}</span>
          )}
        </span>
        <span className={`flex items-center gap-2 self-start text-[13px] font-semibold md:pt-px ${o.cls}`}>
          <span className={`size-2 shrink-0 rounded-full ${o.dot} ${r.result === null ? "animate-pulse" : ""}`} />
          {o.label}
        </span>
        <span className="num text-[13px] text-slate md:pt-px md:text-right">{duration(r.started_at, r.finished_at)}</span>
        <span className="num text-[13px] text-slate md:pt-px md:text-right">{r.cost_usd > 0 ? usd(r.cost_usd) : ""}</span>
      </button>
      {open && (
        <ol className="mx-5 mb-3 border-l-2 border-hairline md:ml-[calc(64px+2.25rem)]">
          {r.events.map((e, i) => (
            <li key={i} className="grid grid-cols-[56px_1fr] gap-x-3 py-1 pl-3 text-[13px]">
              <span className="num text-faint">{clock(e.at)}</span>
              <span className={e.level === "error" ? "text-failed" : e.level === "warn" ? "text-healing-text" : "text-ink"}>{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
