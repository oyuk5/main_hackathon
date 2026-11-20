/**
 * The log: every run across all portals, sortable by time, portal site, outcome, duration, or
 * model cost. Time sort groups strictly by unique calendar day; portal sort groups by host.
 */
import { useMemo, useState } from "react";
import { clock, duration, host, plural, usd, usePoll, type PortalRow } from "./lib";
import { StatusIcon, type StatusIconKind } from "./StatusIcon";
import { Select } from "./Select";

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

const OUTCOME: Record<Outcome, { label: string; cls: string; order: number; icon: StatusIconKind }> = {
  problem: { label: "Problem found", cls: "text-ink", order: 0, icon: "failed" },
  unrepaired: { label: "Could not repair", cls: "text-ink", order: 1, icon: "failed" },
  running: { label: "Running", cls: "text-ink", order: 2, icon: "running" },
  repaired: { label: "Repaired", cls: "text-ink", order: 3, icon: "ok" },
  passed: { label: "Passed", cls: "text-slate", order: 4, icon: "passed" },
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

type SortKey = "time" | "portal" | "outcome" | "took" | "cost";
type SortDir = "asc" | "desc";

const DEFAULT_DIR: Record<SortKey, SortDir> = {
  time: "desc",
  portal: "asc",
  outcome: "asc",
  took: "desc",
  cost: "desc",
};

const ts = (iso: string) => Date.parse(iso) || 0;
const elapsedMs = (r: LogRow) => (r.finished_at ? Math.max(0, ts(r.finished_at) - ts(r.started_at)) : -1);

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long" });
const shortDateFmt = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

function dayLabel(iso: string, now: number): string {
  const d = new Date(iso).toDateString();
  if (d === new Date(now).toDateString()) return "Today";
  if (d === new Date(now - 86_400_000).toDateString()) return "Yesterday";
  return dayFmt.format(new Date(iso));
}

function shortWhen(iso: string, now: number): string {
  const t = new Date(iso);
  const d = t.toDateString();
  if (d === new Date(now).toDateString()) return `Today ${clock(iso)}`;
  if (d === new Date(now - 86_400_000).toDateString()) return `Yest ${clock(iso)}`;
  return `${shortDateFmt.format(t)} ${clock(iso)}`;
}

function SortArrow({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active)
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ml-1 inline shrink-0 text-faint">
        <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />
      </svg>
    );
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="ml-1 inline shrink-0 text-docker"
    >
      {dir === "asc" ? (
        <>
          <path d="M8 13V3" />
          <path d="M4.5 6.5 8 3l3.5 3.5" />
        </>
      ) : (
        <>
          <path d="M8 3v10" />
          <path d="M4.5 9.5 8 13l3.5-3.5" />
        </>
      )}
    </svg>
  );
}

const GRID_COLS = "md:grid-cols-[104px_minmax(0,0.95fr)_minmax(0,2fr)_156px_76px_112px]";

export function Log({ portals, now }: { portals: PortalRow[]; now: number }) {
  const [passing, setPassing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [open, setOpen] = useState<string | null>(null);
  const { data, failing } = usePoll<LogRow[]>(`/internal/log${passing ? "?all=1" : ""}`, 5000);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const rows = useMemo(() => {
    const keep = FILTERS.find((f) => f.id === filter)!.keep;
    const ids = new Set(portals.map((p) => p.id));
    const q = query.trim().toLowerCase();
    const dir = sortDir === "asc" ? 1 : -1;

    return (data ?? [])
      .filter((r) => keep(r) && ids.has(r.portal_id))
      .filter((r) => !q || host(r.url).toLowerCase().includes(q) || r.summary.toLowerCase().includes(q))
      .sort((a, b) => {
        if (sortKey === "portal") {
          const cmp = host(a.url).localeCompare(host(b.url)) * dir;
          return cmp !== 0 ? cmp : ts(b.started_at) - ts(a.started_at);
        }
        if (sortKey === "outcome") {
          const cmp = (OUTCOME[outcome(a)].order - OUTCOME[outcome(b)].order) * dir;
          return cmp !== 0 ? cmp : ts(b.started_at) - ts(a.started_at);
        }
        if (sortKey === "took") {
          const cmp = (elapsedMs(a) - elapsedMs(b)) * dir;
          return cmp !== 0 ? cmp : ts(b.started_at) - ts(a.started_at);
        }
        if (sortKey === "cost") {
          const cmp = (a.cost_usd - b.cost_usd) * dir;
          return cmp !== 0 ? cmp : ts(b.started_at) - ts(a.started_at);
        }
        return (ts(a.started_at) - ts(b.started_at)) * dir;
      });
  }, [data, filter, portals, query, sortKey, sortDir]);

  // A portal that fails the same way read after read gets one row ("5 times since …"), not five.
  // Only in time order, and only while that portal's own entries keep repeating; anything else breaks the run.
  const folded = useMemo(() => {
    if (sortKey !== "time" || sortDir !== "desc") return rows.map((r) => ({ ...r, times: 1, since: r.started_at }));
    const same = (s: string) => s.toLowerCase().replace(/\bstill\s+/g, "").replace(/[.\s]+$/, "");
    const out: Folded[] = [];
    const last = new Map<string, Folded>();
    for (const r of rows) {
      const prev = last.get(r.portal_id);
      if (prev && r.result !== null && prev.kind === r.kind && outcome(prev) === outcome(r) && same(prev.summary) === same(r.summary)) {
        prev.times += 1;
        prev.since = r.started_at;
        continue;
      }
      const f = { ...r, times: 1, since: r.started_at };
      out.push(f);
      last.set(r.portal_id, f);
    }
    return out;
  }, [rows, sortKey, sortDir]);

  // Unique groups so Today / Yesterday never repeat, and Portal sort groups neatly by hostname.
  const sections = useMemo(() => {
    if (sortKey === "time") {
      const map = new Map<string, { key: string; label: string; rows: Folded[] }>();
      for (const r of folded) {
        const key = new Date(r.started_at).toDateString();
        let bucket = map.get(key);
        if (!bucket) {
          bucket = { key, label: dayLabel(r.started_at, now), rows: [] };
          map.set(key, bucket);
        }
        bucket.rows.push(r);
      }
      return [...map.values()];
    }
    if (sortKey === "portal") {
      const map = new Map<string, { key: string; label: string; rows: Folded[] }>();
      for (const r of folded) {
        const key = host(r.url);
        let bucket = map.get(key);
        if (!bucket) {
          bucket = { key, label: key, rows: [] };
          map.set(key, bucket);
        }
        bucket.rows.push(r);
      }
      return [...map.values()].map((b) => ({ ...b, label: `${b.label}, ${plural(b.rows.length, "entry", "entries")}` }));
    }
    return [{ key: "flat", label: null as string | null, rows: folded }];
  }, [folded, now, sortKey]);

  return (
    <section aria-labelledby="log" className="overflow-hidden rounded-[6px] border border-hairline bg-paper">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-hairline px-4 py-3">
        <h2 id="log" className="text-[13.5px] font-semibold text-ink">
          {data ? plural(folded.length, "entry", "entries") : "Log"}
        </h2>

        <div className="relative w-full sm:w-[220px]">
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-slate"
          >
            <circle cx="7" cy="7" r="4.8" />
            <path d="m10.6 10.6 3.2 3.2" strokeLinecap="round" />
          </svg>
          <label htmlFor="log-find" className="sr-only">Filter by portal or text</label>
          <input
            id="log-find"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter portal or text"
            className="h-7 w-full rounded-[4px] border border-hairline bg-sea pr-2.5 pl-8 text-[12.5px] text-ink placeholder:text-faint focus:border-docker focus:bg-paper"
          />
        </div>

        <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`h-7 rounded-[4px] border px-2.5 text-[12.5px] font-medium cursor-pointer ${
                filter === f.id
                  ? "border-docker bg-docker/15 text-docker"
                  : "border-hairline text-slate hover:border-slate/50 hover:text-ink"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto sm:w-auto">
          <Select
            label="Sort"
            size="sm"
            value={`${sortKey}:${sortDir}`}
            onChange={(v) => {
              const [k, d] = v.split(":") as [SortKey, SortDir];
              setSortKey(k);
              setSortDir(d);
            }}
            options={[
              { value: "time:desc", label: "Newest first" },
              { value: "time:asc", label: "Oldest first" },
              { value: "portal:asc", label: "Portal, A to Z" },
              { value: "portal:desc", label: "Portal, Z to A" },
              { value: "outcome:asc", label: "Problems first" },
              { value: "outcome:desc", label: "Passed first" },
              { value: "took:desc", label: "Took longest" },
              { value: "took:asc", label: "Quickest" },
              { value: "cost:desc", label: "Highest model cost" },
              { value: "cost:asc", label: "Lowest model cost" },
            ]}
          />

          <button
            type="button"
            role="switch"
            aria-checked={passing}
            onClick={() => setPassing(!passing)}
            className="flex items-center gap-2 text-[13px] text-slate hover:text-ink cursor-pointer"
          >
            <span className={`relative inline-block h-[18px] w-[30px] shrink-0 rounded-full transition-colors ${passing ? "bg-docker-solid" : "bg-hairline"}`}>
              <span className={`absolute top-[2px] left-[2px] size-[14px] rounded-full bg-paper shadow-sm transition-transform ${passing ? "translate-x-[12px]" : ""}`} />
            </span>
            Include reads that passed
          </button>
        </div>
      </div>

      {failing && !data && (
        <p className="px-5 py-10 text-center text-[13.5px] text-failed">The log could not be loaded. Retrying every 5 seconds.</p>
      )}
      {data && rows.length === 0 && (
        <p className="px-5 py-10 text-center text-[13.5px] text-slate">
          {passing || filter !== "all" || query
            ? "Nothing matches these filters."
            : "No problems or repairs yet. Tick “Include reads that passed” to see every read."}
        </p>
      )}

      {rows.length > 0 && (
        <div className={`hidden ${GRID_COLS} border-b border-hairline bg-sea/70 text-[12.5px] font-semibold text-ink md:grid`}>
          <button
            type="button"
            onClick={() => toggleSort("time")}
            className="flex items-center border-r border-hairline px-3 py-2 text-left whitespace-nowrap hover:text-docker cursor-pointer"
          >
            Time
            <SortArrow active={sortKey === "time"} dir={sortDir} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort("portal")}
            className="flex items-center border-r border-hairline px-3 py-2 text-left whitespace-nowrap hover:text-docker cursor-pointer"
          >
            Portal
            <SortArrow active={sortKey === "portal"} dir={sortDir} />
          </button>
          <span className="border-r border-hairline px-3 py-2 whitespace-nowrap">What happened</span>
          <button
            type="button"
            onClick={() => toggleSort("outcome")}
            className="flex items-center border-r border-hairline px-3 py-2 text-left whitespace-nowrap hover:text-docker cursor-pointer"
          >
            Outcome
            <SortArrow active={sortKey === "outcome"} dir={sortDir} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort("took")}
            className="flex items-center justify-end border-r border-hairline px-3 py-2 whitespace-nowrap hover:text-docker cursor-pointer"
          >
            Took
            <SortArrow active={sortKey === "took"} dir={sortDir} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort("cost")}
            className="flex items-center justify-end px-3 py-2 whitespace-nowrap hover:text-docker cursor-pointer"
          >
            Model cost
            <SortArrow active={sortKey === "cost"} dir={sortDir} />
          </button>
        </div>
      )}

      {sections.map((sec) => (
        <div key={sec.key}>
          {sec.label && (
            <h3 className="sticky top-0 z-10 border-b border-hairline bg-mist/80 px-4 py-1.5 text-[12px] font-semibold text-slate">
              {sec.label}
            </h3>
          )}
          <ol>
            {sec.rows.map((r) => (
              <Entry
                key={r.id}
                r={r}
                now={now}
                compactDate={sortKey !== "time"}
                open={open === r.id}
                toggle={() => setOpen(open === r.id ? null : r.id)}
              />
            ))}
          </ol>
        </div>
      ))}
    </section>
  );
}

type Folded = LogRow & { times: number; since: string };

function Entry({
  r,
  now,
  compactDate,
  open,
  toggle,
}: {
  r: Folded;
  now: number;
  compactDate: boolean;
  open: boolean;
  toggle: () => void;
}) {
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
        className={`grid w-full gap-x-0 gap-y-1 text-left enabled:hover:bg-mist ${GRID_COLS}`}
      >
        <span className="num px-3 py-2.5 text-[13px] whitespace-nowrap text-slate">
          {compactDate ? shortWhen(r.started_at, now) : clock(r.started_at)}
        </span>
        <span className="min-w-0 px-3 py-2.5">
          <span className="block truncate text-[13.5px] font-semibold text-ink">{host(r.url)}</span>
          <span className="block text-[12px] text-slate">{step}</span>
        </span>
        <span className="px-3 py-2.5 text-[13.5px] leading-snug text-slate">
          {text}
          {r.times > 1 && (
            <span className="ml-1.5 text-[12.5px] whitespace-nowrap text-faint">
              {r.times} times since {shortWhen(r.since, now).replace(/^Today /, "").replace(/^Yest /, "yesterday ")}
            </span>
          )}
          {r.events.length > 0 && (
            <span className="ml-1.5 text-[12px] whitespace-nowrap text-docker">
              {open ? "Hide steps" : plural(r.events.length, "step")}
            </span>
          )}
        </span>
        <span className={`flex items-center gap-2 self-start px-3 py-2.5 text-[13px] font-medium ${o.cls}`}>
          <StatusIcon kind={o.icon} size={11} />
          {o.label}
        </span>
        <span className="num px-3 py-2.5 text-[13px] whitespace-nowrap text-slate md:text-right">
          {duration(r.started_at, r.finished_at)}
        </span>
        <span className="num px-3 py-2.5 text-[13px] whitespace-nowrap text-slate md:text-right">
          {r.cost_usd > 0 ? usd(r.cost_usd) : ""}
        </span>
      </button>
      {open && (
        <ol className="mx-4 mb-3 border-l-2 border-hairline md:ml-[104px]">
          {r.events.map((e, i) => (
            <li key={i} className="grid grid-cols-[56px_1fr] gap-x-3 py-1 pl-3 text-[13px]">
              <span className="num text-faint">{clock(e.at)}</span>
              <span className={e.level === "error" ? "text-failed" : e.level === "warn" ? "text-healing-text" : "text-ink"}>
                {e.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
