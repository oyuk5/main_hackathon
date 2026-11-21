/**
 * The log: every run across all portals, sortable by time, portal site, outcome, duration, or
 * model cost. Time sort groups strictly by unique calendar day; portal sort groups by host.
 */
import { useMemo, useState } from "react";
import { clock, duration, host, usd, usePoll, type PortalRow } from "./lib";
import { locale, t, useT, type Key } from "./i18n";
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

/** Labels come from the dictionary as log.<outcome>. */
const OUTCOME: Record<Outcome, { cls: string; order: number; icon: StatusIconKind }> = {
  problem: { cls: "text-ink", order: 0, icon: "failed" },
  unrepaired: { cls: "text-ink", order: 1, icon: "failed" },
  running: { cls: "text-ink", order: 2, icon: "running" },
  repaired: { cls: "text-ink", order: 3, icon: "ok" },
  passed: { cls: "text-slate", order: 4, icon: "passed" },
};

function outcome(r: LogRow): Outcome {
  if (r.result === null) return "running";
  if (r.kind === "repair") return r.result === "ok" ? "repaired" : "unrepaired";
  return r.result === "ok" ? "passed" : "problem";
}

type Filter = "all" | "problems" | "repairs";
/** Texts come from the dictionary: log.f.<id> (label), log.e.<id> (empty), log.nm.<id> (no search match). */
const FILTERS: { id: Filter; keep: (r: LogRow) => boolean }[] = [
  { id: "all", keep: () => true },
  { id: "problems", keep: (r) => r.result === "failed" },
  { id: "repairs", keep: (r) => r.kind === "repair" },
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

const dayFmt = () => new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" });
const shortDateFmt = () => new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short" });

function dayLabel(iso: string, now: number): string {
  const d = new Date(iso).toDateString();
  if (d === new Date(now).toDateString()) return t("log.today");
  if (d === new Date(now - 86_400_000).toDateString()) return t("log.yesterday");
  return dayFmt().format(new Date(iso));
}

/** "Today 10:42" in a column, or "today at 10:42" inside a sentence. */
function shortWhen(iso: string, now: number): string {
  const date = new Date(iso);
  const d = date.toDateString();
  if (d === new Date(now).toDateString()) return t("log.todayAt", { t: clock(iso) });
  if (d === new Date(now - 86_400_000).toDateString()) return t("log.yestAt", { t: clock(iso) });
  return `${shortDateFmt().format(date)} ${clock(iso)}`;
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
  const { lang } = useT();
  const { data, failing } = usePoll<LogRow[]>(`/internal/log${passing ? "?all=1" : ""}`, 5000);
  const currentFilter = FILTERS.find((f) => f.id === filter)!;

  const matching = useMemo(() => {
    const ids = new Set(portals.map((p) => p.id));
    const q = query.trim().toLowerCase();
    return (data ?? []).filter((r) => ids.has(r.portal_id) && (!q || host(r.url).toLowerCase().includes(q) || r.summary.toLowerCase().includes(q)));
  }, [data, portals, query]);
  const problemCount = matching.filter((r) => r.result === "failed").length;

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(DEFAULT_DIR[key]);
    }
  };

  const rows = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;

    return matching.filter(currentFilter.keep)
      .sort((a, b) => {
        if (sortKey === "portal") {
          const cmp = host(a.url).localeCompare(host(b.url), locale()) || a.portal_id.localeCompare(b.portal_id);
          return cmp !== 0 ? cmp * dir : ts(b.started_at) - ts(a.started_at);
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
  }, [matching, currentFilter, sortKey, sortDir, lang]);

  // Unique groups so Today / Yesterday never repeat, and Portal sort groups neatly by hostname.
  const sections = useMemo(() => {
    if (sortKey === "time") {
      const map = new Map<string, { key: string; label: string; rows: LogRow[] }>();
      for (const r of rows) {
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
      const map = new Map<string, { key: string; label: string; rows: LogRow[] }>();
      for (const r of rows) {
        const key = r.portal_id;
        let bucket = map.get(key);
        if (!bucket) {
          bucket = { key, label: host(r.url), rows: [] };
          map.set(key, bucket);
        }
        bucket.rows.push(r);
      }
      return [...map.values()].map((b) => ({ ...b, label: `${b.label}, ${t("log.entries", { n: b.rows.length })}` }));
    }
    return [{ key: "flat", label: null as string | null, rows }];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, now, sortKey, lang]);

  return (
    <section aria-labelledby="log" className="min-w-0 rounded-[6px] border border-hairline bg-paper">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5 border-b border-hairline px-4 py-3">
        <h2 id="log" className="text-[13.5px] font-semibold text-ink">
          {data ? t("log.entries", { n: rows.length }) : t("log.title")}
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
          <label htmlFor="log-find" className="sr-only">{t("log.find")}</label>
          <input
            id="log-find"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("log.findPlaceholder")}
            className="h-7 w-full rounded-[4px] border border-hairline bg-sea pr-2.5 pl-8 text-[12.5px] text-ink placeholder:text-faint focus:border-docker focus:bg-paper"
          />
        </div>

        <div role="group" aria-label={t("log.show")} className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              title={f.id === "problems" ? t("log.failedRunsHint") : undefined}
              onClick={() => setFilter(f.id)}
              className={`h-7 rounded-[4px] border px-2.5 text-[12.5px] font-medium cursor-pointer ${
                filter === f.id
                  ? "border-docker bg-docker/15 text-docker"
                  : "border-hairline text-slate hover:border-slate/50 hover:text-ink"
              }`}
            >
              {t(`log.f.${f.id}` as Key)}{f.id === "problems" && data && <span className="num"> ({problemCount})</span>}
            </button>
          ))}
        </div>

        <div className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 sm:ml-auto sm:w-auto">
          <Select
            label={t("sort.label")}
            size="sm"
            value={`${sortKey}:${sortDir}`}
            onChange={(v) => {
              const [k, d] = v.split(":") as [SortKey, SortDir];
              setSortKey(k);
              setSortDir(d);
            }}
            options={[
              { value: "time:desc", label: t("log.s.timeDesc") },
              { value: "time:asc", label: t("log.s.timeAsc") },
              { value: "portal:asc", label: t("log.s.portalAsc") },
              { value: "portal:desc", label: t("log.s.portalDesc") },
              { value: "outcome:asc", label: t("log.s.outcomeAsc") },
              { value: "outcome:desc", label: t("log.s.outcomeDesc") },
              { value: "took:desc", label: t("log.s.tookDesc") },
              { value: "took:asc", label: t("log.s.tookAsc") },
              { value: "cost:desc", label: t("log.s.costDesc") },
              { value: "cost:asc", label: t("log.s.costAsc") },
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
            {t("log.passing")}
          </button>
        </div>
      </div>

      {failing && !data && (
        <p className="px-5 py-10 text-center text-[13.5px] text-failed">{t("log.failed")}</p>
      )}
      {data && rows.length === 0 && (
        <p className="px-5 py-10 text-center text-[13.5px] text-slate">
          {query.trim() ? t(`log.nm.${filter}` as Key) : t(`log.e.${filter}` as Key)}
          {filter === "all" && !passing && !query.trim() && t("log.hint")}
        </p>
      )}

      {rows.length > 0 && (
        <div className={`hidden ${GRID_COLS} border-b border-hairline bg-sea/70 text-[12.5px] font-semibold text-ink md:grid`}>
          <button
            type="button"
            onClick={() => toggleSort("time")}
            className="flex items-center border-r border-hairline px-3 py-2 text-left whitespace-nowrap hover:text-docker cursor-pointer"
          >
            {t("log.c.time")}
            <SortArrow active={sortKey === "time"} dir={sortDir} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort("portal")}
            className="flex items-center border-r border-hairline px-3 py-2 text-left whitespace-nowrap hover:text-docker cursor-pointer"
          >
            {t("log.c.portal")}
            <SortArrow active={sortKey === "portal"} dir={sortDir} />
          </button>
          <span className="border-r border-hairline px-3 py-2 whitespace-nowrap">{t("log.c.what")}</span>
          <button
            type="button"
            onClick={() => toggleSort("outcome")}
            className="flex items-center border-r border-hairline px-3 py-2 text-left whitespace-nowrap hover:text-docker cursor-pointer"
          >
            {t("log.c.outcome")}
            <SortArrow active={sortKey === "outcome"} dir={sortDir} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort("took")}
            className="flex items-center justify-end border-r border-hairline px-3 py-2 whitespace-nowrap hover:text-docker cursor-pointer"
          >
            {t("log.c.took")}
            <SortArrow active={sortKey === "took"} dir={sortDir} />
          </button>
          <button
            type="button"
            onClick={() => toggleSort("cost")}
            className="flex items-center justify-end px-3 py-2 whitespace-nowrap hover:text-docker cursor-pointer"
          >
            {t("log.c.cost")}
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

function Entry({
  r,
  now,
  compactDate,
  open,
  toggle,
}: {
  r: LogRow;
  now: number;
  compactDate: boolean;
  open: boolean;
  toggle: () => void;
}) {
  const o = OUTCOME[outcome(r)];
  const step = r.kind === "repair" ? t("log.repair") : t("log.read");
  const text = r.summary || (r.result === null ? t("log.inProgress", { step }) : "");
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
        <span className="min-w-0 px-3 py-2.5 text-[13.5px] leading-snug text-slate [overflow-wrap:anywhere]">
          {text}
          {r.events.length > 0 && (
            <span className="ml-1.5 text-[12px] whitespace-nowrap text-docker">
              {open ? t("log.hideSteps") : t("log.steps", { n: r.events.length })}
            </span>
          )}
        </span>
        <span className={`flex items-center gap-2 self-start px-3 py-2.5 text-[13px] font-medium ${o.cls}`}>
          <StatusIcon kind={o.icon} size={11} />
          {t(`log.${outcome(r)}` as Key)}
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
              <span className={`min-w-0 [overflow-wrap:anywhere] ${e.level === "error" ? "text-failed" : e.level === "warn" ? "text-healing-text" : "text-ink"}`}>
                {e.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
