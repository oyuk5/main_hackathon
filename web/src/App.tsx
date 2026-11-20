/**
 * Operator dashboard. A summary bar answers "is everything fine?" at a glance. Two tabs below:
 * Portals (every portal, most urgent first, with a small chart of where they are) and Issues
 * (#/issues: what needs a person, what is fixing itself, what fixed itself). A portal opens in
 * a side panel (#/p/<id>) over either tab.
 */
import { useEffect, useMemo, useState } from "react";
import { Board, openIssues } from "./Board";
import { Beacon, Chart } from "./Chart";
import { Detail } from "./Detail";
import { Log } from "./Log";
import { Picker } from "./Picker";
import { Strip } from "./Strip";
import {
  CHARACTER, STATE_COLOR, STATE_ORDER, countryOf, host, int, plural, usd, useNow, usePoll, when,
  type LedgerRow, type PortalRow, type State,
} from "./lib";

type Tab = "portals" | "issues" | "log";

/** #/issues and #/log are tabs; #/p/<id> opens a portal over whichever tab was showing. */
function useRoute() {
  const read = () => {
    const h = window.location.hash;
    const id = h.match(/^#\/p\/(.+)$/)?.[1];
    return { id: id ? decodeURIComponent(id) : null, tab: h.startsWith("#/issues") ? ("issues" as Tab) : h.startsWith("#/log") ? ("log" as Tab) : id ? null : ("portals" as Tab) };
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
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useStored<View>("wt.portals.view", { state: "all", sort: "urgent" });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useStored<string[] | null>("wt.portals.picked", null);
  const all = useMemo(
    () => [...(data ?? [])].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || host(a.url).localeCompare(host(b.url))),
    [data],
  );
  // Every tab shows only the portals picked in the tab bar. Ids of deleted portals are ignored.
  const rows = useMemo(() => (picked ? all.filter((p) => picked.includes(p.id)) : all), [all, picked]);

  return (
    <div className="min-h-dvh">
      <Header now={now} onAdded={reload} />
      {failing && (
        <p role="alert" className="mx-auto max-w-[1440px] px-4 pt-4 text-sm text-failed sm:px-6">
          The Watchtower API is not answering. What you see is from the last successful update; retrying every 3 seconds.
        </p>
      )}
      {data === null && !failing ? (
        <p className="mx-auto max-w-[1440px] px-4 py-24 text-slate sm:px-6">Loading portals…</p>
      ) : (
        <main className="mx-auto max-w-[1440px] px-4 pt-6 pb-20 sm:px-6">
          <Summary rows={rows} total={all.length} picked={view.state} onPick={(s) => {
            setView({ ...view, state: view.state === s ? "all" : s });
            window.location.hash = "#/";
          }} />
          {all.length > 0 && <Tabs tab={tab} rows={rows} now={now} picker={<Picker all={all} picked={picked} setPicked={setPicked} />} />}
          {all.length > 0 && rows.length === 0 ? (
            <p className="mt-6 border border-dashed border-hairline px-5 py-10 text-center text-[14px] text-slate">
              No portal is selected.{" "}
              <button type="button" onClick={() => setPicked(null)} className="font-semibold text-ink underline underline-offset-2">Show all portals</button>
            </p>
          ) : tab === "issues" && rows.length > 0 ? (
            <div id="panel-issues" role="tabpanel" aria-labelledby="tab-issues" className="mt-6">
              <Board rows={rows} now={now} hover={hover} setHover={setHover} />
            </div>
          ) : tab === "log" && rows.length > 0 ? (
            <div id="panel-log" role="tabpanel" aria-labelledby="tab-log" className="mt-6">
              <Log portals={rows} now={now} />
            </div>
          ) : (
          <div id="panel-portals" role="tabpanel" aria-labelledby="tab-portals" className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <Portals rows={rows} view={view} setView={setView} query={query} setQuery={setQuery} now={now} hover={hover} setHover={setHover} />
            <aside className="space-y-6">
              {rows.length > 0 && (
                <section aria-labelledby="where" className="border border-hairline bg-paper p-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <h2 id="where" className="text-[14px] font-semibold">Where they are</h2>
                    <HoverNote rows={rows} hover={hover} />
                  </div>
                  <Chart rows={rows} hover={hover} setHover={setHover} compact />
                </section>
              )}
              <Cost rows={ledger ?? []} portals={rows.length} />
            </aside>
          </div>
          )}
        </main>
      )}
      {openId && <Detail id={openId} onClose={() => (window.location.hash = tab === "portals" ? "" : `#/${tab}`)} onChanged={reload} />}
    </div>
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
    <div className="mt-6 flex items-end gap-4 border-b border-hairline">
    <nav role="tablist" aria-label="Views" className="flex gap-6">
      {tabs.map((t) => (
        <a
          key={t.id}
          id={`tab-${t.id}`}
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`panel-${t.id}`}
          href={t.href}
          className={`-mb-px flex items-center gap-2 border-b-2 px-0.5 pb-2.5 text-[15px] font-semibold ${tab === t.id ? "border-ink text-ink" : "border-transparent text-slate hover:text-ink"}`}
        >
          {t.label}
          {t.count !== undefined && <span className={`num rounded-full px-2 py-px text-[12px] leading-[18px] font-semibold ${t.alert ? "bg-failed-wash text-failed" : "bg-mist text-slate"}`}>{t.count}</span>}
        </a>
      ))}
    </nav>
      <div className="mb-2 ml-auto">{picker}</div>
    </div>
  );
}

function HoverNote({ rows, hover }: { rows: PortalRow[]; hover: string | null }) {
  const p = rows.find((r) => r.id === hover);
  const countries = new Set(rows.map(countryOf).filter(Boolean)).size;
  if (!p) return <span className="text-[12.5px] text-slate">{plural(countries, "country", "countries")}</span>;
  return <span className={`truncate pl-2 text-[12.5px] font-semibold ${STATE_COLOR[p.state]}`}>{host(p.url)}</span>;
}

// ------------------------------------------------------------ header

function Header({ now, onAdded }: { now: number; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (!value) return;
    setSending(true);
    try {
      const res = await fetch("/portals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: value }) });
      if (res.status === 400) return setNote({ ok: false, text: "That is not a web address. Use the portal's full address, starting with https://." });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      setUrl("");
      setNote({ ok: true, text: `${host(value)} is now watched. Attaching starts now.` });
      onAdded();
      window.location.hash = `#/p/${encodeURIComponent(id)}`;
    } catch {
      setNote({ ok: false, text: "The portal was not added: the API did not answer. Try again in a moment." });
    } finally {
      setSending(false);
    }
  };

  const today = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);

  return (
    <header className="border-b border-ink/80 bg-paper">
      <div className="mx-auto flex max-w-[1520px] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-6 sm:px-6">
        <a href="#" className="flex items-baseline gap-3">
          <span className="wide text-[19px] font-[750] tracking-[-0.02em]">Watchtower</span>
          <span className="font-chart text-[15px] text-slate italic">Keeps tender portals delivering</span>
        </a>
        <span className="num text-[13px] text-slate sm:ml-2">{today}</span>
        <form onSubmit={add} className="flex w-full gap-2 sm:ml-auto sm:w-auto">
          <label htmlFor="portal-url" className="sr-only">Portal address</label>
          <input
            id="portal-url"
            type="url"
            inputMode="url"
            required
            value={url}
            onChange={(e) => (setUrl(e.target.value), setNote(null))}
            placeholder="https://portal-address"
            className="h-9 min-w-0 flex-1 border border-ink/30 bg-sea px-3 text-sm placeholder:text-faint focus:border-ink focus:bg-paper focus:outline-none sm:w-[300px]"
          />
          <button disabled={sending} className="h-9 shrink-0 bg-ink px-3.5 text-sm font-semibold text-paper hover:bg-magenta disabled:opacity-60">
            {sending ? "Adding…" : "Watch portal"}
          </button>
        </form>
      </div>
      {note && (
        <p role="status" className={`mx-auto max-w-[1520px] px-4 pb-2.5 text-sm sm:px-6 sm:text-right ${note.ok ? "text-slate" : "text-failed"}`}>
          {note.text}
        </p>
      )}
    </header>
  );
}


// ------------------------------------------------------------ summary bar

const ORDER: State[] = ["failed", "healing", "integrating", "serving"];

function Summary({ rows, total, picked, onPick }: { rows: PortalRow[]; total: number; picked: State | "all"; onPick: (s: State) => void }) {
  if (total === 0) {
    return (
      <section className="border border-hairline bg-paper px-5 py-6">
        <h1 className="wide text-[22px] font-[750] tracking-[-0.02em]">No portals yet</h1>
        <p className="mt-1 max-w-[62ch] text-slate">
          Add a portal's address above. Watchtower learns how to read it, delivers its open tenders and their documents, and repairs itself when the portal changes.
        </p>
      </section>
    );
  }
  const open = rows.reduce((s, r) => s + (r.state === "serving" || r.state === "healing" ? r.tenderCount : 0), 0);
  const failed = rows.filter((r) => r.state === "failed").length;
  const headline = failed === 0 ? "Nothing needs a person" : `${plural(failed, "portal")} ${failed === 1 ? "needs" : "need"} a person`;

  return (
    <section aria-label="Summary" className="grid grid-cols-2 border border-hairline bg-paper sm:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))]">
      <div className="col-span-2 border-b border-hairline px-5 py-4 sm:col-span-1 sm:border-r sm:border-b-0">
        <h1 className={`wide text-[21px] leading-tight font-[750] tracking-[-0.02em] ${failed ? "text-failed" : ""}`}>{headline}</h1>
        <p className="mt-1 text-[13.5px] text-slate">
          {rows.length === total ? `${plural(total, "portal")} watched` : `${rows.length} of ${plural(total, "portal")} selected`}, <span className="num font-semibold text-ink">{int(open)}</span> open tenders delivered
        </p>
      </div>
      {ORDER.map((s) => {
        const n = rows.filter((r) => r.state === s).length;
        return (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            aria-pressed={picked === s}
            title={picked === s ? "Show all portals" : `Show only portals that are ${CHARACTER[s].words.toLowerCase()}`}
            className={`flex items-center gap-3 border-hairline px-4 py-3.5 text-left sm:px-5 sm:py-4 max-sm:odd:border-l max-sm:[&:nth-child(-n+3)]:border-b sm:border-l sm:first-of-type:border-l-0 ${picked === s ? "bg-mist shadow-[inset_0_-3px_0_var(--color-ink)]" : "hover:bg-mist"} ${n === 0 ? "opacity-45" : ""}`}
          >
            <Beacon state={s} size={20} />
            <span>
              <span className="num wide block text-[24px] leading-none font-[750]">{n}</span>
              <span className={`mt-1 block text-[13px] font-semibold ${STATE_COLOR[s]}`}>{CHARACTER[s].words}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------ portal list

type SortKey = "urgent" | "tenders" | "stale" | "name";
interface View { state: State | "all"; sort: SortKey }

const SORTS: { id: SortKey; label: string }[] = [
  { id: "urgent", label: "Most urgent" },
  { id: "stale", label: "Longest without delivery" },
  { id: "tenders", label: "Most open tenders" },
  { id: "name", label: "Name" },
];

const time = (iso: string | null) => (iso ? Date.parse(iso) : -Infinity);
const SORT: Record<SortKey, (a: PortalRow, b: PortalRow) => number> = {
  urgent: (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || time(a.lastSuccessAt) - time(b.lastSuccessAt),
  stale: (a, b) => time(a.lastSuccessAt) - time(b.lastSuccessAt),
  tenders: (a, b) => b.tenderCount - a.tenderCount,
  name: () => 0,
};

/** A per-viewer setting kept in this browser; falls back to the default when storage is unavailable. */
function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* private window: keep it for this visit only */
    }
  };
  return [value, set];
}

const COLS = "md:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_88px_104px] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_88px_104px_150px]";

function Portals({ rows: all, view, setView, query, setQuery, now, hover, setHover }: {
  rows: PortalRow[]; view: View; setView: (v: View) => void; query: string; setQuery: (q: string) => void;
  now: number; hover: string | null; setHover: (id: string | null) => void;
}) {
  const q = query.trim().toLowerCase();
  const rows = all
    .filter((r) => view.state === "all" || r.state === view.state)
    .filter((r) => !q || host(r.url).toLowerCase().includes(q) || r.reason.toLowerCase().includes(q))
    .sort((a, b) => SORT[view.sort](a, b) || host(a.url).localeCompare(host(b.url)));
  if (all.length === 0) return <div />;
  const chips: (State | "all")[] = ["all", ...ORDER];

  return (
    <section aria-label="Portals" className="min-w-0 self-start border border-hairline bg-paper">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2.5">
        <div role="group" aria-label="Show portals that are" className="flex flex-wrap gap-1">
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
                className={`flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[12.5px] font-semibold ${on ? "border-ink bg-ink text-paper" : "border-hairline text-slate hover:border-ink/40 hover:text-ink"}`}
              >
                {s !== "all" && <Beacon state={s} size={11} />}
                {s === "all" ? "All" : CHARACTER[s].words}
                <span className={`num ${on ? "opacity-70" : "text-faint"}`}>{n}</span>
              </button>
            );
          })}
        </div>
        <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
          <label htmlFor="portal-find" className="sr-only">Find a portal or reason</label>
          <input
            id="portal-find"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find"
            className="h-7 min-w-0 flex-1 border border-hairline bg-sea px-2.5 text-[13px] placeholder:text-faint focus:border-ink focus:bg-paper focus:outline-none sm:w-[130px]"
          />
          <label className="flex items-center gap-1.5 text-[12.5px] text-slate">
            Sort
            <select
              value={view.sort}
              onChange={(e) => setView({ ...view, sort: e.target.value as SortKey })}
              className="h-7 border border-hairline bg-paper px-1.5 text-[13px] text-ink focus:border-ink focus:outline-none"
            >
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 py-10 text-center text-[14px] text-slate">
          No portal matches.{" "}
          <button type="button" onClick={() => (setView({ ...view, state: "all" }), setQuery(""))} className="font-semibold text-ink underline underline-offset-2">
            Clear the filters
          </button>
        </div>
      ) : (
        <div className={`hidden gap-x-4 border-b border-hairline px-4 py-1.5 text-[12px] text-slate md:grid ${COLS}`}>
          <span>Portal</span>
          <span>What Watchtower says</span>
          <span className="text-right">Open tenders</span>
          <span>Last delivered</span>
          <span className="hidden xl:flex xl:justify-between"><span>24 h ago</span><span>now</span></span>
        </div>
      )}
      <ol>
        {rows.map((r) => (
          <li key={r.id} className="border-b border-hairline last:border-b-0">
            <a
              href={`#/p/${encodeURIComponent(r.id)}`}
              onMouseEnter={() => setHover(r.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(r.id)}
              onBlur={() => setHover(null)}
              className={`grid items-center gap-x-4 gap-y-0.5 px-4 py-2 ${COLS} ${hover === r.id ? "bg-mist" : "hover:bg-mist"}`}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Beacon state={r.state} size={16} />
                <span className="min-w-0 leading-tight">
                  <span className="narrow block truncate text-[15px] font-semibold" title={r.url}>{host(r.url)}</span>
                  <span className="block truncate text-[12.5px]">
                    <span className={`font-semibold ${STATE_COLOR[r.state]}`}>{CHARACTER[r.state].words}</span>
                    {r.busy && <span className="text-slate">, {r.busy.kind === "repair" ? "repairing" : "reading"} now</span>}
                  </span>
                </span>
              </span>
              <span className="line-clamp-2 text-[13.5px] leading-snug text-ink/90" title={r.reason}>{r.reason}</span>
              <span className="num wide text-[15px] font-[700] md:text-right">
                {int(r.tenderCount)}
                <span className="narrow ml-1 text-[12.5px] font-normal text-slate md:hidden">open tenders</span>
              </span>
              <span className="text-[12.5px] leading-tight text-slate">{r.lastSuccessAt ? when(r.lastSuccessAt, now) : "Not yet"}</span>
              <span className="hidden xl:block">
                <Strip runs={r.recent ?? []} now={now} />
              </span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
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
    <section aria-labelledby="cost" className="border border-hairline bg-paper p-4">
      <h2 id="cost" className="text-[14px] font-semibold">Model usage so far</h2>
      <p className="num wide mt-1 text-[32px] leading-none font-[750] tracking-[-0.03em]">{usd(total)}</p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-slate">
        {attach ? <>Learning {plural(attach.calls, "portal")} cost <b className="num font-semibold text-ink">{usd(attach.cost_usd)}</b>, about <b className="num font-semibold text-ink">{usd(attach.cost_usd / attach.calls)}</b> each. </> : "No portal has been learned yet. "}
        {repair ? <>{plural(repair.calls, "repair")} cost <b className="num font-semibold text-ink">{usd(repair.cost_usd)}</b>. </> : "No repairs so far. "}
        {other > 0 && <>Checks cost <b className="num font-semibold text-ink">{usd(other)}</b>. </>}
        Regular reads run without a model and cost nothing.
      </p>
    </section>
  );
}
