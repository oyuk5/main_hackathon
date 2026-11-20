/**
 * Operator dashboard styled after Docker Desktop: clean dark/light surfaces, 1px hairlines,
 * vertical column header dividers, Docker Blue primary controls, and 10px status circles.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Board, openIssues } from "./Board";
import { Chart } from "./Chart";
import { Detail } from "./Detail";
import { ImportDialog } from "./Import";
import { Log } from "./Log";
import { Picker } from "./Picker";
import { Select } from "./Select";
import { Strip } from "./Strip";
import { ThemeSwitch } from "./Theme";
import { StatusIcon, stateToIconKind } from "./StatusIcon";
import {
  CHARACTER, STATE_ORDER, countryOf, host, int, plural, usd, useNow, usePoll, when,
  type LedgerRow, type PortalRow, type State,
} from "./lib";

type Tab = "portals" | "issues" | "log";

/** #/issues and #/log are tabs; #/p/<id> opens a portal over whichever tab was showing. */
function useRoute() {
  const read = () => {
    const h = window.location.hash;
    const id = h.match(/^#\/p\/(.+)$/)?.[1];
    return {
      id: id ? decodeURIComponent(id) : null,
      tab: h.startsWith("#/issues")
        ? ("issues" as Tab)
        : h.startsWith("#/log")
          ? ("log" as Tab)
          : id
            ? null
            : ("portals" as Tab),
    };
  };
  const [route, setRoute] = useState(read);
  const [tab, setTab] = useState<Tab>(read().tab ?? "portals");
  useEffect(() => {
    const on = () => {
      const r = read();
      setRoute(r);
      if (r.tab) setTab(r.tab);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return { openId: route.id, tab };
}

export function App() {
  const { data, failing, reload } = usePoll<PortalRow[]>("/internal/overview");
  const { data: ledger } = usePoll<LedgerRow[]>("/internal/ledger", 10_000);
  const now = useNow(15_000);
  const { openId, tab } = useRoute();
  const closeDetail = useCallback(() => {
    window.location.hash = tab === "portals" ? "" : `#/${tab}`;
  }, [tab]);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useStored<View>("wt.portals.view", { state: "all", sort: "urgent", desc: false });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useStored<string[] | null>("wt.portals.picked", null);
  const [showSide, setShowSide] = useStored<boolean>("wt.portals.side", true);

  const all = useMemo(
    () => [...(data ?? [])].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || host(a.url).localeCompare(host(b.url))),
    [data],
  );
  // Every tab shows only the portals picked in the tab bar. Ids of deleted portals are ignored.
  const rows = useMemo(() => {
    if (!picked) return all;
    const ids = new Set(picked);
    return all.filter((p) => ids.has(p.id));
  }, [all, picked]);
  const totalCost = useMemo(() => (ledger ?? []).reduce((s, r) => s + r.cost_usd, 0), [ledger]);

  // The browser tab says how many portals need a person, so a glance at the tab bar is enough.
  const needPerson = all.filter((r) => r.state === "failed").length;
  useEffect(() => {
    document.title = needPerson > 0 ? `(${needPerson}) Watchtower` : "Watchtower";
  }, [needPerson]);

  return (
    <div className="min-h-dvh text-ink">
      <Header onAdded={reload} />
      {/* Pinned over the page, so it never pushes the layout down and leaves no gap when the API is fine. */}
      {failing && (
        <p role="alert" className="fixed bottom-4 left-1/2 z-40 w-[min(560px,calc(100%-32px))] -translate-x-1/2 rounded-[6px] border border-failed/40 bg-paper px-4 py-2.5 text-center text-[13px] text-failed shadow-[0_8px_24px_rgb(0_0_0/0.18)]">
          The Watchtower API is not answering. {data ? "Showing the last successful update; retrying every 3 seconds." : "Retrying every 3 seconds."}
        </p>
      )}
      {data === null ? (
        failing ? <main className="mx-auto max-w-[1440px] min-[1800px]:max-w-[1680px] px-4 py-5 sm:px-6">
          <button type="button" onClick={() => void reload()} className="rounded-[4px] border border-hairline bg-paper px-3 py-2 font-semibold text-docker">Try again</button>
        </main> : <DashboardSkeleton />
      ) : (
        <main className="mx-auto max-w-[1440px] min-[1800px]:max-w-[1680px] px-4 pt-5 pb-16 sm:px-6">
          <SummaryStrip
            rows={rows}
            total={all.length}
            totalCost={totalCost}
            picked={view.state}
            now={now}
            onReload={reload}
            onPick={(s) => {
              setView({ ...view, state: view.state === s ? "all" : s });
              window.location.hash = "#/";
            }}
          />

          {all.length > 0 && (
            <Tabs
              tab={tab}
              rows={rows}
              now={now}
              picker={<Picker all={all} picked={picked} setPicked={setPicked} />}
            />
          )}

          {all.length > 0 && rows.length === 0 ? (
            <p className="mt-4 rounded-[6px] border border-dashed border-hairline bg-paper px-5 py-10 text-center text-[13.5px] text-slate">
              No portal is selected.{" "}
              <button type="button" onClick={() => setPicked(null)} className="font-semibold text-docker hover:underline">
                Show all portals
              </button>
            </p>
          ) : tab === "issues" && rows.length > 0 ? (
            <div id="panel-issues" role="tabpanel" aria-labelledby="tab-issues" className="mt-4">
              <Board rows={rows} now={now} hover={hover} setHover={setHover} />
            </div>
          ) : tab === "log" && rows.length > 0 ? (
            <div id="panel-log" role="tabpanel" aria-labelledby="tab-log" className="mt-4">
              <Log portals={rows} now={now} />
            </div>
          ) : (
            <div
              id="panel-portals"
              role="tabpanel"
              aria-labelledby="tab-portals"
              className={`mt-4 grid grid-cols-[minmax(0,1fr)] gap-5 ${showSide && rows.length > 0 ? "xl:grid-cols-[minmax(0,1fr)_300px] min-[1800px]:grid-cols-[minmax(0,1fr)_340px]" : ""}`}
            >
              <Portals
                rows={rows}
                view={view}
                setView={setView}
                query={query}
                setQuery={setQuery}
                now={now}
                hover={hover}
                setHover={setHover}
                showSide={showSide}
                setShowSide={setShowSide}
                onReload={reload}
              />
              {showSide && rows.length > 0 && (
                <aside className="grid min-w-0 content-start gap-4 md:max-xl:grid-cols-2 [&>*]:min-w-0">
                  <Cost rows={ledger ?? []} portals={rows.length} />
                  <section aria-labelledby="where" className="rounded-[6px] border border-hairline bg-paper p-3.5">
                    <div className="mb-2 flex h-5 items-baseline justify-between gap-2 overflow-hidden">
                      <h2 id="where" className="shrink-0 whitespace-nowrap text-[13px] font-semibold text-ink">Where they are</h2>
                      <HoverNote rows={rows} hover={hover} />
                    </div>
                    <Chart rows={rows} hover={hover} setHover={setHover} compact />
                  </section>
                </aside>
              )}
            </div>
          )}
        </main>
      )}
      {openId && (
        <Detail
          key={openId}
          id={openId}
          onClose={closeDetail}
          onChanged={reload}
        />
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <main className="mx-auto max-w-[1440px] min-[1800px]:max-w-[1680px] px-4 pt-5 sm:px-6">
      <div role="status" aria-label="Loading dashboard">
        <div aria-hidden="true">
          <div className="space-y-3 rounded-[6px] border border-hairline bg-paper px-5 py-4">
            <div className="h-6 w-48 max-w-full rounded-sm bg-mist" />
            <div className="h-3 w-72 max-w-full rounded-sm bg-mist" />
            <div className="h-3 w-56 max-w-full rounded-sm bg-mist" />
          </div>
          <div className="mt-5 flex gap-5 border-b border-hairline pb-3">
            {[0, 1, 2].map((i) => <div key={i} className="h-4 w-12 rounded-sm bg-land" />)}
          </div>
          <div className="mt-4 divide-y divide-hairline rounded-[6px] border border-hairline bg-paper">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="flex items-center gap-4 p-4">
              <div className="size-2 shrink-0 rounded-full bg-land" />
              <div className="h-3 w-36 max-w-[65%] rounded-sm bg-mist" />
              <div className="ml-auto hidden h-3 w-24 rounded-sm bg-mist sm:block" />
            </div>)}
          </div>
        </div>
      </div>
    </main>
  );
}

// ------------------------------------------------------------ header & tabs

function Header({ onAdded }: { onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  const [importing, setImporting] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    setSending(true);
    try {
      const res = await fetch("/portals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: value }),
      });
      if (res.status === 400) return setNote({ ok: false, text: "That is not a web address. Start with https://." });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      setUrl("");
      setNote({ ok: true, text: `${host(value)} is now watched. Attaching starts now.` });
      onAdded();
      window.location.hash = `#/p/${encodeURIComponent(id)}`;
    } catch {
      setNote({ ok: false, text: "The portal was not added: the API did not answer." });
    } finally {
      setSending(false);
    }
  };

  return (
    <header className="border-b border-hairline bg-paper">
      <div className="mx-auto flex max-w-[1440px] min-[1800px]:max-w-[1680px] flex-wrap items-center gap-x-5 gap-y-3 px-4 py-2.5 sm:px-6">
        <a href="#" className="order-1 flex items-center gap-2.5">
          <svg width="22" height="22" viewBox="0 0 22 22" fill="none" aria-hidden="true" className="shrink-0 text-docker">
            {/* A watchtower: lantern room, tapering tower, and a beam sweeping right. */}
            <path d="M14 5.2 20.5 2.8v6.4L14 6.8Z" fill="currentColor" opacity="0.28" />
            <path d="M8.2 3.2h5.6v4.4H8.2Z" fill="currentColor" />
            <path d="M7 7.6h8M8.6 7.6 7.4 20M13.4 7.6 14.6 20M5.5 20h11M8.1 12.6h5.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="font-display text-[18px] font-bold tracking-tight text-ink">Watchtower</span>
          <span className="hidden text-[13px] text-slate md:inline">keeps tender portals delivering</span>
        </a>
        <div className="order-2 ml-auto sm:order-3 sm:ml-0">
          <ThemeSwitch />
        </div>
        <form onSubmit={add} className="order-3 flex w-full gap-2 sm:order-2 sm:ml-auto sm:w-auto">
          <label htmlFor="portal-url" className="sr-only">Portal address</label>
          <input
            id="portal-url"
            type="url"
            inputMode="url"
            required
            value={url}
            onChange={(e) => (setUrl(e.target.value), setNote(null))}
            placeholder="https://portal-address"
            className="h-8 min-w-0 flex-1 rounded-[4px] border border-hairline bg-sea px-3 text-[13px] text-ink placeholder:text-faint focus:border-docker focus:bg-paper sm:w-[290px]"
          />
          <button
            disabled={sending}
            className="h-8 shrink-0 rounded-[4px] bg-docker-solid px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-docker-hover disabled:opacity-60 cursor-pointer"
          >
            {sending ? "Adding…" : "Watch portal"}
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            title="Add many portals from an Excel, CSV, JSON or text file"
            className="h-8 shrink-0 cursor-pointer rounded-[4px] border border-hairline bg-sea px-3 text-[13px] font-semibold text-ink transition-colors hover:border-docker"
          >
            Import list
          </button>
        </form>
        {importing && <ImportDialog onClose={() => setImporting(false)} onAdded={onAdded} />}
      </div>
      {note && (
        <p role="status" className={`mx-auto max-w-[1440px] min-[1800px]:max-w-[1680px] px-4 pb-2 text-[13px] sm:px-6 sm:text-right ${note.ok ? "text-slate" : "text-failed"}`}>
          {note.text}
        </p>
      )}
    </header>
  );
}

function Tabs({ tab, rows, now, picker }: { tab: Tab; rows: PortalRow[]; now: number; picker: React.ReactNode }) {
  const open = openIssues(rows, now);
  const tabs: { id: Tab; href: string; label: string; count?: number; alert?: boolean }[] = [
    { id: "portals", href: "#/", label: "Portals", count: rows.length },
    { id: "issues", href: "#/issues", label: "Issues", count: open, alert: rows.some((r) => r.state === "failed") },
    { id: "log", href: "#/log", label: "Log" },
  ];
  return (
    <div className="mt-5 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-hairline max-sm:flex-col-reverse max-sm:items-stretch">
      <nav role="tablist" aria-label="Views" className="flex gap-6 sm:gap-7">
        {tabs.map((t) => (
          <a
            key={t.id}
            id={`tab-${t.id}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            href={t.href}
            className={`-mb-px flex items-center gap-2 border-b-2 px-0.5 pb-3 text-[15px] transition-colors ${
              tab === t.id ? "border-docker font-semibold text-docker" : "border-transparent font-medium text-slate hover:text-ink"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span
                className={`num rounded-[4px] px-2 py-0.5 text-[12px] leading-[18px] font-medium ${
                  t.alert ? "bg-failed-wash text-failed" : "bg-mist text-slate"
                }`}
              >
                {t.count}
              </span>
            )}
          </a>
        ))}
      </nav>
      <div className="mb-2.5 sm:ml-auto max-sm:mb-1">{picker}</div>
    </div>
  );
}

function HoverNote({ rows, hover }: { rows: PortalRow[]; hover: string | null }) {
  const p = rows.find((r) => r.id === hover);
  const countries = new Set(rows.map(countryOf).filter(Boolean)).size;
  if (!p) return <span className="truncate text-[12px] text-slate">{plural(countries, "country", "countries")}</span>;
  return <span className="min-w-0 truncate text-[12px] font-semibold text-ink">{host(p.url)}</span>;
}

// ------------------------------------------------------------ docker-style summary strip

const ORDER: State[] = ["failed", "healing", "integrating", "serving"];
/** Literal class names, so Tailwind finds them. */
const GROUP_TEXT: Record<State, string> = { failed: "text-failed", healing: "text-healing-text", integrating: "text-integrating", serving: "text-serving" };

function SummaryStrip({
  rows,
  total,
  totalCost,
  picked,
  now,
  onReload,
  onPick,
}: {
  rows: PortalRow[];
  total: number;
  totalCost: number;
  picked: State | "all";
  now: number;
  onReload: () => void;
  onPick: (s: State) => void;
}) {
  if (total === 0) {
    return (
      <section className="mt-4 rounded-[6px] border border-hairline bg-paper px-5 py-6">
        <h1 className="text-[18px] font-semibold text-ink">No portals yet</h1>
        <p className="mt-1 max-w-[62ch] text-[13.5px] text-slate">
          Add a portal address above. Watchtower learns how to read it, delivers its open tenders and documents, and repairs itself when a portal changes.
        </p>
      </section>
    );
  }

  const servingCount = rows.filter((r) => r.state === "serving").length;
  const failedCount = rows.filter((r) => r.state === "failed").length;
  const open = rows.reduce((s, r) => s + (r.state === "serving" || r.state === "healing" ? r.tenderCount : 0), 0);
  // What Watchtower did in the last 24 hours, across the shown portals: the "what did it do about it" line.
  const DAY = 24 * 3_600_000;
  const runs = rows.flatMap((r) => (r.recent ?? []).filter((x) => now - Date.parse(x.startedAt) <= DAY));
  const reads = runs.filter((x) => x.kind === "read").length;
  const problems = runs.filter((x) => x.kind === "read" && x.result === "failed").length;
  const repaired = runs.filter((x) => x.kind === "repair" && x.result === "ok").length;
  const handed = runs.filter((x) => x.kind === "repair" && x.result === "failed").length;
  const headline = failedCount === 0 ? "Nothing needs a person" : `${plural(failedCount, "portal")} ${failedCount === 1 ? "needs" : "need"} a person`;
  const refreshed = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);

  // One statement, then the four states as filters. The counts appear once, not in a second row of tiles.
  return (
    <section aria-label="Summary" className="flex flex-col gap-4 rounded-[6px] border border-hairline bg-paper px-5 py-4 xl:flex-row xl:items-center xl:gap-8">
      <div className="min-w-0 flex-1">
        <h1 className={`font-display text-[26px] leading-tight font-bold tracking-tight ${failedCount > 0 ? "text-failed" : "text-calm"}`}>{headline}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-1 text-[13.5px] text-slate">
          <span>
            <span className="num font-semibold text-ink">{int(open)}</span> open tenders delivered from{" "}
            <span className="num font-semibold text-ink">{servingCount}</span> of {plural(rows.length, "portal")}.
          </span>
          <span className="inline-flex items-center gap-1">
            Checked <span className="num">{refreshed}</span>
            <button
              type="button"
              onClick={onReload}
              title="Check again now"
              aria-label="Check again now"
              className="rounded-[4px] p-1 text-docker hover:bg-mist cursor-pointer"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13.5 8a5.5 5.5 0 1 1-1.35-3.6" />
                <path d="M13.8 2.4v2.8H11" />
              </svg>
            </button>
          </span>
        </p>
        {runs.length > 0 && (
          <p className="mt-1 text-[13.5px] text-slate">
            Last 24 hours: <span className="num font-semibold text-ink">{int(reads)}</span> reads,{" "}
            <span className={`num font-semibold ${problems ? "text-failed" : "text-ink"}`}>{problems}</span> {problems === 1 ? "problem" : "problems"} found,{" "}
            <span className={`num font-semibold ${repaired ? "text-serving" : "text-ink"}`}>{repaired}</span> repaired by itself
            {handed > 0 && (
              <>
                , <span className="num font-semibold text-ink">{handed}</span> handed to a person
              </>
            )}
            .
          </p>
        )}
        {failedCount > 0 && (
          <p className="mt-1.5 text-[13.5px] text-slate">
              Needs you:{" "}
              {rows
                .filter((r) => r.state === "failed")
                .slice(0, 3)
                .map((r, i, shown) => (
                  <Fragment key={r.id}>
                    <a href={`#/p/${encodeURIComponent(r.id)}`} className="font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink">
                      {host(r.url)}
                    </a>
                    {i < shown.length - 1 ? ", " : ""}
                  </Fragment>
                ))}
              {failedCount > 3 ? ` and ${failedCount - 3} more.` : "."}
          </p>
        )}
      </div>

      <div role="group" aria-label="Show only portals that are" className="flex flex-wrap gap-2 xl:shrink-0 xl:flex-nowrap">
        {ORDER.map((s) => {
          const n = rows.filter((r) => r.state === s).length;
          const active = picked === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              aria-pressed={active}
              disabled={n === 0 && !active}
              title={active ? "Show all portals" : `Show only: ${CHARACTER[s].words}`}
              className={`flex h-10 items-center gap-2.5 rounded-[6px] border px-3.5 text-left transition-colors cursor-pointer disabled:cursor-default disabled:opacity-45 ${
                active ? "border-docker bg-docker/10" : "border-hairline hover:border-slate/40 hover:bg-mist disabled:hover:bg-transparent"
              }`}
            >
              <StatusIcon kind={stateToIconKind(s)} size={11} />
              <span className="num font-display text-[19px] leading-none font-bold text-ink">{n}</span>
              <span className="text-[13px] font-medium text-slate">{CHARACTER[s].words}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ------------------------------------------------------------ portal table

type SortKey = "urgent" | "tenders" | "stale" | "name";
interface View {
  state: State | "all";
  sort: SortKey;
  /** Reverse the sort's natural direction (each key's natural direction is the first label below). */
  desc: boolean;
}

/** What each sort shows first, in its natural and its reversed direction. */
const SORT_WORDS: Record<SortKey, [string, string]> = {
  urgent: ["Most urgent first", "Least urgent first"],
  stale: ["Longest without delivery", "Most recently delivered"],
  tenders: ["Most open tenders", "Fewest open tenders"],
  name: ["Name A–Z", "Name Z–A"],
};

/** A serving portal with no delivery for this long is late: reads normally run every 30 minutes. */
const STALE_MS = 2 * 60 * 60 * 1000;
const time = (iso: string | null) => (iso ? Date.parse(iso) : -Infinity);
const SORT: Record<SortKey, (a: PortalRow, b: PortalRow) => number> = {
  urgent: (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || time(a.lastSuccessAt) - time(b.lastSuccessAt),
  stale: (a, b) => time(a.lastSuccessAt) - time(b.lastSuccessAt),
  tenders: (a, b) => b.tenderCount - a.tenderCount,
  name: (a, b) => host(a.url).localeCompare(host(b.url)),
};

/** Stored JSON helper safely handling both objects and booleans. */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return initial;
      const parsed = JSON.parse(raw);
      return typeof initial === "object" && initial !== null && !Array.isArray(initial)
        ? { ...initial, ...parsed }
        : parsed;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  };
  return [value, set];
}

function SortArrow({ active, desc = false }: { active: boolean; desc?: boolean }) {
  if (!active)
    return (
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="ml-1 inline shrink-0 text-faint">
        <path d="M5 6.5 8 3.5l3 3M5 9.5l3 3 3-3" />
      </svg>
    );
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={`ml-1 inline shrink-0 text-docker transition-transform ${desc ? "rotate-180" : ""}`}>
      <path d="M8 13V3" />
      <path d="M4.5 6.5 8 3l3.5 3.5" />
    </svg>
  );
}

function Portals({
  rows: all,
  view,
  setView,
  query,
  setQuery,
  now,
  hover,
  setHover,
  showSide,
  setShowSide,
  onReload,
}: {
  rows: PortalRow[];
  view: View;
  setView: (v: View) => void;
  query: string;
  setQuery: (q: string) => void;
  now: number;
  hover: string | null;
  setHover: (id: string | null) => void;
  showSide: boolean;
  setShowSide: (v: boolean) => void;
  onReload: () => void;
}) {
  const [showFilterBar, setShowFilterBar] = useState(false);

  // "/" jumps to the search box, as on most tools operators already use.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== "/" || e.metaKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable || el.closest('[role="dialog"]')) return;
      e.preventDefault();
      document.getElementById("portal-find")?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({});

  const q = query.trim().toLowerCase();
  const rows = useMemo(() => all
    .filter((r) => view.state === "all" || r.state === view.state)
    .filter((r) => !q || host(r.url).toLowerCase().includes(q) || r.reason.toLowerCase().includes(q))
    .sort((a, b) => (view.desc ? -1 : 1) * SORT[view.sort](a, b) || host(a.url).localeCompare(host(b.url))), [all, q, view.sort, view.desc, view.state]);
  /** Clicking the column already sorted reverses it; another column starts in its natural direction. */
  const sortBy = (sort: SortKey) => setView({ ...view, sort, desc: view.sort === sort ? !view.desc : false });
  const groupCounts = useMemo(() => {
    const counts: Record<State, number> = { failed: 0, healing: 0, integrating: 0, serving: 0 };
    for (const row of rows) counts[row.state]++;
    return counts;
  }, [rows]);
  const pageSize = 40;
  const pageKey = JSON.stringify([q, view.sort, view.desc, view.state]);
  const [paging, setPaging] = useState({ key: pageKey, index: 0 });
  const lastPage = Math.max(0, Math.ceil(rows.length / pageSize) - 1);
  const page = paging.key === pageKey ? Math.min(paging.index, lastPage) : 0;
  const offset = page * pageSize;
  const visible = rows.slice(offset, offset + pageSize);

  if (all.length === 0) return <div />;

  const chips: (State | "all")[] = ["all", ...ORDER];

  const triggerRefresh = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setRefreshing((m) => ({ ...m, [id]: true }));
    try {
      await fetch(`/portals/${encodeURIComponent(id)}/refresh`, { method: "POST" });
      onReload();
    } finally {
      setTimeout(() => {
        setRefreshing((m) => {
          const next = { ...m };
          delete next[id];
          return next;
        });
      }, 800);
    }
  };

  return (
    <section aria-label="Portals" className="min-w-0">
      {/* Docker Search & Action Bar */}
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="relative basis-full sm:basis-auto sm:w-[290px]">
          <svg
            width="15"
            height="15"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate"
          >
            <circle cx="7" cy="7" r="4.8" />
            <path d="m10.6 10.6 3.2 3.2" strokeLinecap="round" />
          </svg>
          <label htmlFor="portal-find" className="sr-only">Search portals</label>
          {!query && (
            <kbd aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-[3px] border border-hairline px-1.5 text-[11px] leading-[18px] text-faint">/</kbd>
          )}
          <input
            id="portal-find"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search portals and reasons"
            className="h-9 w-full rounded-[4px] border border-hairline bg-paper pr-8 pl-9 text-[13.5px] text-ink placeholder:text-faint focus:border-docker"
          />
        </div>

        {/* Docker Blue Filter Toggle */}
        <button
          type="button"
          onClick={() => setShowFilterBar((v) => !v)}
          aria-expanded={showFilterBar}
          aria-label="Filter by state"
          title="Filter by state"
          className={`inline-flex h-9 w-9 items-center justify-center rounded-[4px] border transition-colors cursor-pointer ${
            showFilterBar || view.state !== "all"
              ? "border-docker bg-docker/15 text-docker"
              : "border-transparent text-docker hover:bg-mist"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M2.5 4.5h11M4.5 8h7M6.5 11.5h3" />
          </svg>
        </button>

        {/* Docker Blue Side Panel / Map Toggle */}
        <button
          type="button"
          onClick={() => setShowSide(!showSide)}
          aria-pressed={showSide}
          aria-label={showSide ? "Hide map and cost panel" : "Show map and cost panel"}
          title={showSide ? "Hide map & cost panel" : "Show map & cost panel"}
          className={`inline-flex h-9 w-9 items-center justify-center rounded-[4px] border transition-colors cursor-pointer ${
            showSide ? "border-docker/40 bg-docker/10 text-docker" : "border-transparent text-docker hover:bg-mist"
          }`}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2.5" width="12" height="11" rx="1.8" />
            <path d="M10 2.5v11" />
          </svg>
        </button>

        <Select<SortKey>
          label="Sort"
          value={view.sort}
          onChange={(sort) => setView({ ...view, sort, desc: false })}
          options={(Object.keys(SORT_WORDS) as SortKey[]).map((k) => ({ value: k, label: SORT_WORDS[k][k === view.sort && view.desc ? 1 : 0] }))}
        />
        <button
          type="button"
          onClick={() => setView({ ...view, desc: !view.desc })}
          title={`Reverse: ${SORT_WORDS[view.sort][view.desc ? 0 : 1]}`}
          aria-label={`Reverse the order. Now: ${SORT_WORDS[view.sort][view.desc ? 1 : 0]}`}
          className="-ml-1 inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[4px] border border-hairline text-slate transition-colors hover:border-docker hover:text-docker"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={view.desc ? "M5 3v10M2.5 10.5 5 13l2.5-2.5" : "M5 13V3M2.5 5.5 5 3l2.5 2.5"} className="text-docker" stroke="currentColor" />
            <path d={view.desc ? "M11 13V3M8.5 5.5 11 3l2.5 2.5" : "M11 3v10M8.5 10.5 11 13l2.5-2.5"} opacity="0.45" />
          </svg>
        </button>

        {(showFilterBar || view.state !== "all") && (
          <div role="group" aria-label="Show portals that are" className="flex flex-wrap items-center gap-1 sm:ml-2">
            {chips.map((s) => {
              const n = s === "all" ? all.length : all.filter((r) => r.state === s).length;
              if (s !== "all" && n === 0) return null;
              const on = view.state === s;
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setView({ ...view, state: s })}
                  className={`flex h-7 items-center gap-1.5 rounded-[4px] border px-2 text-[12px] font-medium cursor-pointer ${
                    on
                      ? "border-docker bg-docker/15 text-ink"
                      : "border-hairline bg-paper text-slate hover:border-slate/50 hover:text-ink"
                  }`}
                >
                  {s !== "all" && <StatusIcon kind={stateToIconKind(s)} size={10} />}
                  {s === "all" ? "All" : CHARACTER[s].words}
                  <span className="num text-faint">{n}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Docker Desktop Table */}
      <div className="relative overflow-x-auto rounded-[6px] border border-hairline bg-paper">
        {rows.length === 0 ? (
          <div className="px-5 py-10 text-center text-[13.5px] text-slate">
            No portal matches.{" "}
            <button
              type="button"
              onClick={() => {
                setView({ ...view, state: "all" });
                setQuery("");
              }}
              className="font-semibold text-docker hover:underline cursor-pointer"
            >
              Clear the filters
            </button>
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-[13.5px]">
            <thead>
              <tr className="border-b border-hairline bg-sea/70 text-[12.5px] font-semibold text-ink">
                <th scope="col" className="w-10 border-r border-hairline px-2 py-2.5 text-center">
                  <button
                    type="button"
                    onClick={() => sortBy("urgent")}
                    title={view.sort === "urgent" ? `${SORT_WORDS.urgent[view.desc ? 1 : 0]}. Click to reverse.` : "Most urgent first"}
                    aria-label="Sort by urgency"
                    className={`inline-flex items-center hover:text-docker cursor-pointer ${view.sort === "urgent" ? "text-docker" : "text-faint"}`}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4" fill="currentColor" /></svg>
                  </button>
                </th>
                <th scope="col" className="border-r border-hairline px-3 py-2.5 whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => sortBy("name")}
                    className="inline-flex items-center hover:text-docker cursor-pointer"
                  >
                    Portal
                    <SortArrow active={view.sort === "name"} desc={view.desc} />
                  </button>
                </th>
                <th scope="col" className="hidden border-r border-hairline px-3 py-2.5 whitespace-nowrap lg:table-cell">
                  What Watchtower says
                </th>
                <th scope="col" className="border-r border-hairline px-3 py-2.5 text-right whitespace-nowrap">
                  <button
                    type="button"
                    onClick={() => sortBy("tenders")}
                    className="inline-flex items-center hover:text-docker cursor-pointer"
                  >
                    Tenders
                    <SortArrow active={view.sort === "tenders"} desc={view.desc} />
                  </button>
                </th>
                <th scope="col" className="hidden border-r border-hairline px-3 py-2.5 whitespace-nowrap sm:table-cell">
                  <button
                    type="button"
                    onClick={() => sortBy("stale")}
                    className="inline-flex items-center hover:text-docker cursor-pointer"
                  >
                    Last delivered
                    <SortArrow active={view.sort === "stale"} desc={view.desc} />
                  </button>
                </th>

                <th scope="col" className="hidden px-3 py-2.5 sm:table-cell"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r, i) => {
                const isSelectedRow = hover === r.id;
                const groupStart = view.sort === "urgent" && (i === 0 || visible[i - 1]!.state !== r.state);
                const groupSize = groupCounts[r.state];
                const isBusy = Boolean(r.busy || refreshing[r.id]);
                const detailHref = `#/p/${encodeURIComponent(r.id)}`;

                return (
                  <Fragment key={r.id}>
                  {groupStart && (
                    <tr className="border-b border-hairline bg-sea/70">
                      <th scope="rowgroup" colSpan={6} className={`px-3 py-1.5 text-left text-[12.5px] font-semibold ${GROUP_TEXT[r.state]}`}>
                        {CHARACTER[r.state].words}
                        <span className="num ml-2 font-medium text-faint">{groupSize}</span>
                      </th>
                    </tr>
                  )}
                  <tr
                    onMouseEnter={() => setHover(r.id)}
                    onMouseLeave={() => setHover(null)}
                    onClick={(e) => {
                      e.currentTarget.querySelector("a")?.focus({ preventScroll: true });
                      window.location.hash = detailHref;
                    }}
                    className={`group border-b border-hairline last:border-b-0 cursor-pointer transition-colors ${
                      isSelectedRow ? "bg-mist" : "hover:bg-mist/80"
                    }`}
                  >
                    <td className="px-2 py-2.5 text-center align-top">
                      <div className="flex justify-center">
                        <StatusIcon kind={stateToIconKind(r.state)} size={11} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 align-top lg:max-w-[230px]">
                      <a
                        href={detailHref}
                        onClick={(e) => e.stopPropagation()}
                        title={r.url}
                        className="block font-semibold break-all text-ink hover:underline lg:truncate lg:break-normal"
                      >
                        {host(r.url)}
                      </a>
                      <span className={`mt-0.5 block text-[12.5px] whitespace-nowrap ${view.sort === "urgent" && !r.busy ? "sr-only" : ""} ${r.state === "failed" ? "font-medium text-failed" : r.state === "healing" ? "text-healing-text" : "text-slate"}`}>
                        {view.sort === "urgent" ? "" : CHARACTER[r.state].words}
                        {r.busy && <span className="text-faint">{view.sort === "urgent" ? "" : ", "}{r.busy.kind === "repair" ? "repairing now" : "reading now"}</span>}
                      </span>
                      <span className={`mt-1 line-clamp-3 text-[12.5px] leading-snug lg:hidden ${r.state === "serving" ? "text-faint" : "text-slate"}`}>{shortReason(r)}</span>
                    </td>
                    <td className={`hidden min-w-[200px] px-3 py-2.5 align-top lg:table-cell xl:min-w-[260px] ${r.state === "serving" ? "text-faint" : r.state === "integrating" ? "text-slate" : "text-ink"}`} title={r.reason}>
                      <span className="line-clamp-2">{shortReason(r)}</span>
                    </td>
                    <td className="num px-3 py-2.5 text-right align-top font-medium text-ink whitespace-nowrap">
                      {r.tenderCount === 0 && !r.lastSuccessAt ? <span className="text-faint" aria-label="none yet">–</span> : int(r.tenderCount)}
                    </td>
                    <td className="hidden px-3 py-2.5 align-top text-[13px] text-slate whitespace-nowrap sm:table-cell">
                      {r.lastSuccessAt ? (
                        r.state === "serving" && now - Date.parse(r.lastSuccessAt) > STALE_MS ? (
                          <span className="font-medium text-healing-text" title="No delivery for over 2 hours, while reads run every 30 minutes">
                            {when(r.lastSuccessAt, now)}
                          </span>
                        ) : (
                          when(r.lastSuccessAt, now)
                        )
                      ) : (
                        <span className="text-faint">Not yet</span>
                      )}
                      {(r.recent ?? []).length > 0 && (
                        <span className="mt-1 block w-[132px]" title="Every read and repair in the last 24 hours. Tall marks are repairs; red marks are problems.">
                          <Strip runs={r.recent ?? []} now={now} compact />
                        </span>
                      )}
                    </td>
                    <td className="hidden px-2 py-2.5 align-top sm:table-cell">
                      <button
                        type="button"
                        onClick={(e) => void triggerRefresh(e, r.id)}
                        disabled={isBusy}
                        aria-label={`Read ${host(r.url)} now`}
                        className={`h-7 rounded-[4px] border border-hairline px-2.5 text-[12.5px] font-medium whitespace-nowrap text-ink transition-opacity ${isBusy ? "" : "md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"} hover:border-docker hover:text-docker disabled:border-transparent disabled:text-faint cursor-pointer disabled:cursor-default`}
                      >
                        {isBusy ? "Running" : "Read now"}
                      </button>
                    </td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {lastPage > 0 && (
        <nav aria-label="Portal table pages" className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[13px]">
          <span className="num text-slate" role="status">{int(offset + 1)}–{int(offset + visible.length)} of {int(rows.length)} portals</span>
          <div className="flex gap-2">
            <button type="button" disabled={page === 0} onClick={() => setPaging({ key: pageKey, index: page - 1 })} className="rounded-[4px] border border-hairline bg-paper px-2 py-1 text-docker disabled:text-faint">Previous page</button>
            <button type="button" disabled={page === lastPage} onClick={() => setPaging({ key: pageKey, index: page + 1 })} className="rounded-[4px] border border-hairline bg-paper px-2 py-1 text-docker disabled:text-faint">Next page</button>
          </div>
        </nav>
      )}
    </section>
  );
}

/**
 * A healthy portal's reason repeats what its own columns already say (tender count, last read).
 * Keep only the news: "2 new, 0 changed, all checks passed". Anything else is shown as written.
 */
function shortReason(r: PortalRow): string {
  const m = r.state === "serving" && /^Serving [\d,]+ open tenders? \(([^)]*)\)\.(?: Last read [\d:]+,)? all checks passed\.$/.exec(r.reason);
  return m ? `${m[1]}, all checks passed` : r.reason;
}

// ------------------------------------------------------------ cost

function Cost({ rows, portals }: { rows: LedgerRow[]; portals: number }) {
  if (portals === 0) return null;
  const by = (p: string) => rows.find((r) => r.purpose === p);
  const total = rows.reduce((s, r) => s + r.cost_usd, 0);
  const attach = by("attach");
  const repair = by("repair");
  const other = rows.filter((r) => r.purpose !== "attach" && r.purpose !== "repair").reduce((s, r) => s + r.cost_usd, 0);

  return (
    <section aria-labelledby="cost" className="rounded-[6px] border border-hairline bg-paper p-3.5">
      <h2 id="cost" className="text-[13px] font-semibold text-ink">Model usage so far</h2>
      <p className="num font-display mt-1 text-[24px] font-bold text-ink">{usd(total)}</p>
      <p className="mt-0.5 text-[12.5px] text-slate">Regular reads call no model and cost $0.</p>
      {total > 0 && (
        <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-hairline pt-2.5 text-[12.5px]">
          <div>
            <dt className="text-slate">Attaching</dt>
            <dd className="num font-semibold text-ink">{usd(attach?.cost_usd ?? 0)}</dd>
          </div>
          <div>
            <dt className="text-slate">Repairs</dt>
            <dd className="num font-semibold text-ink">{usd((repair?.cost_usd ?? 0) + other)}</dd>
          </div>
        </dl>
      )}
    </section>
  );
}
