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
import { Strip } from "./Strip";
import {
  CHARACTER, STATE_COLOR, STATE_ORDER, countryOf, host, int, plural, usd, useNow, usePoll, when,
  type LedgerRow, type PortalRow, type State,
} from "./lib";

type Tab = "portals" | "issues";

/** #/issues is the issues tab; #/p/<id> opens a portal over whichever tab was showing. */
function useRoute() {
  const read = () => {
    const h = window.location.hash;
    const id = h.match(/^#\/p\/(.+)$/)?.[1];
    return { id: id ? decodeURIComponent(id) : null, tab: h.startsWith("#/issues") ? ("issues" as Tab) : id ? null : ("portals" as Tab) };
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
  const rows = useMemo(
    () => [...(data ?? [])].sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || host(a.url).localeCompare(host(b.url))),
    [data],
  );

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
          <Summary rows={rows} />
          {rows.length > 0 && <Tabs tab={tab} rows={rows} now={now} />}
          {tab === "issues" && rows.length > 0 ? (
            <div id="panel-issues" role="tabpanel" aria-labelledby="tab-issues" className="mt-6">
              <Board rows={rows} now={now} hover={hover} setHover={setHover} />
            </div>
          ) : (
          <div id="panel-portals" role="tabpanel" aria-labelledby="tab-portals" className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
            <Portals rows={rows} now={now} hover={hover} setHover={setHover} />
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
      {openId && <Detail id={openId} onClose={() => (window.location.hash = tab === "issues" ? "#/issues" : "")} onChanged={reload} />}
    </div>
  );
}

function Tabs({ tab, rows, now }: { tab: Tab; rows: PortalRow[]; now: number }) {
  const open = openIssues(rows, now);
  const tabs: { id: Tab; href: string; label: string; count: number; alert: boolean }[] = [
    { id: "portals", href: "#/", label: "Portals", count: rows.length, alert: false },
    { id: "issues", href: "#/issues", label: "Issues", count: open, alert: rows.some((r) => r.state === "failed") },
  ];
  return (
    <nav role="tablist" aria-label="Views" className="mt-6 flex gap-6 border-b border-hairline">
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
          <span className={`num rounded-full px-2 py-px text-[12px] leading-[18px] font-semibold ${t.alert ? "bg-failed-wash text-failed" : "bg-mist text-slate"}`}>{t.count}</span>
        </a>
      ))}
    </nav>
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

function Summary({ rows }: { rows: PortalRow[] }) {
  if (rows.length === 0) {
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
          {plural(rows.length, "portal")} watched, <span className="num font-semibold text-ink">{int(open)}</span> open tenders delivered
        </p>
      </div>
      {ORDER.map((s) => {
        const n = rows.filter((r) => r.state === s).length;
        return (
          <div key={s} className={`flex items-center gap-3 border-hairline px-4 py-3.5 sm:px-5 sm:py-4 max-sm:odd:border-l max-sm:[&:nth-child(-n+3)]:border-b sm:border-l sm:first-of-type:border-l-0 ${n === 0 ? "opacity-45" : ""}`}>
            <Beacon state={s} size={20} />
            <div>
              <p className="num wide text-[24px] leading-none font-[750]">{n}</p>
              <p className={`mt-1 text-[13px] font-semibold ${STATE_COLOR[s]}`}>{CHARACTER[s].words}</p>
            </div>
          </div>
        );
      })}
    </section>
  );
}

// ------------------------------------------------------------ portal list

function Portals({ rows, now, hover, setHover }: { rows: PortalRow[]; now: number; hover: string | null; setHover: (id: string | null) => void }) {
  if (rows.length === 0) return <div />;
  return (
    <section aria-labelledby="portals" className="min-w-0 border border-hairline bg-paper">
      <div className="flex items-baseline justify-between border-b border-hairline px-5 py-3">
        <h2 id="portals" className="text-[14px] font-semibold">All portals, most urgent first</h2>
        <p className="text-[12.5px] text-slate">Updates every 3 seconds</p>
      </div>
      <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_80px_120px] gap-x-5 border-b border-hairline px-5 py-2 text-[12px] text-slate md:grid xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_80px_120px_170px]">
        <span>Portal</span>
        <span>What Watchtower says</span>
        <span className="text-right">Open tenders</span>
        <span>Last delivered</span>
        <span className="hidden xl:flex xl:justify-between"><span>24 h ago</span><span>now</span></span>
      </div>
      <ol>
        {rows.map((r) => (
          <li key={r.id} className="border-b border-hairline last:border-b-0">
            <a
              href={`#/p/${encodeURIComponent(r.id)}`}
              onMouseEnter={() => setHover(r.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(r.id)}
              onBlur={() => setHover(null)}
              className={`grid gap-x-5 gap-y-1 px-5 py-3.5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_80px_120px] xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_80px_120px_170px] ${hover === r.id ? "bg-mist" : "hover:bg-mist"}`}
            >
              <span className="flex min-w-0 items-start gap-2.5">
                <span className="pt-0.5"><Beacon state={r.state} size={18} /></span>
                <span className="min-w-0">
                  <span className="narrow block truncate text-[15.5px] font-semibold">{host(r.url)}</span>
                  <span className="block text-[13px]">
                    <span className={`font-semibold ${STATE_COLOR[r.state]}`}>{CHARACTER[r.state].words}</span>
                    {r.busy && <span className="text-slate">, {r.busy.kind === "repair" ? "repairing" : "reading"} now</span>}
                  </span>
                </span>
              </span>
              <span className="text-[14px] leading-snug md:pt-0.5">{r.reason}</span>
              <span className="num wide text-[16px] font-[700] md:pt-0.5 md:text-right">
                {int(r.tenderCount)}
                <span className="narrow ml-1 text-[12.5px] font-normal text-slate md:hidden">open tenders</span>
              </span>
              <span className="text-[13px] text-slate md:pt-1">{r.lastSuccessAt ? when(r.lastSuccessAt, now) : "Not yet"}</span>
              <span className="hidden pt-1 xl:block">
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
