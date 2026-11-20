/**
 * One portal in a side panel: what it says now, what happened (reads folded together, every
 * failure and repair in full, with what the repair changed in the recipe), the run log and cost.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Strip } from "./Strip";
import { StatusIcon, stateToIconKind } from "./StatusIcon";
import {
  STATE_LABEL, clock, diffRecipes, duration, host, int, usd, useNow, usePoll, when,
  type PortalDetail, type RunRow,
} from "./lib";
import { t, tx, useT, type Key } from "./i18n";

export function Detail({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data, failing, reload } = usePoll<PortalDetail>(`/internal/portals/${encodeURIComponent(id)}`);
  const now = useNow();
  useT();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as (HTMLElement | SVGElement) | null;
    const drawer = panel.current;
    drawer?.querySelector("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        const stops = [...(drawer?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), summary') ?? [])]
          .filter((el) => el.getClientRects().length > 0);
        const first = stops[0];
        const last = stops.at(-1);
        if (e.shiftKey ? document.activeElement === first : document.activeElement === last) {
          e.preventDefault();
          (e.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", key);
      document.body.style.overflow = overflow;
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-40">
      <div className="backdrop absolute inset-0 bg-ink/25" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={data ? host(data.portal.url) : t("detail.portal")}
        className="drawer absolute inset-y-0 right-0 flex w-full max-w-[680px] flex-col overflow-y-auto bg-paper shadow-[0_0_0_1px_var(--color-hairline),-24px_0_48px_-24px_rgb(0_0_0/0.25)] focus:outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-hairline bg-paper/90 px-4 py-3 backdrop-blur sm:px-6">
          <span className="text-[13px] text-slate">{failing ? t("detail.stale") : t("detail.live")}</span>
          <button onClick={onClose} className="px-2 py-1 text-sm text-slate hover:bg-mist hover:text-ink">
            {t("detail.close")}
          </button>
        </div>
        {!data ? (
          <p className="px-6 py-10 text-slate">{failing ? t("detail.gone") : t("detail.loading")}</p>
        ) : (
          <Body d={data} now={now} onChanged={() => (reload(), onChanged())} onRemoved={() => (onChanged(), onClose())} />
        )}
      </div>
    </div>
  );
}

function Body({ d, now, onChanged, onRemoved }: { d: PortalDetail; now: number; onChanged: () => void; onRemoved: () => void }) {
  const p = d.portal;
  const recipe = d.recipes.at(-1);
  const cost = d.ledger.reduce((s, r) => s + r.cost_usd, 0);
  const busy = d.busy ?? null;

  return (
    <div className="px-4 pt-6 pb-16 sm:px-6">
      <header>
        <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
          <StatusIcon kind={stateToIconKind(p.state)} size={12} />
          <span>{STATE_LABEL[p.state]}</span>
          {busy && <span className="font-normal text-slate">{busy.kind === "repair" ? t("detail.busyRepair") : t("detail.busyRead")}</span>}
        </div>
        <h2 className="mt-2 text-[1.7rem] leading-tight font-semibold tracking-tight break-words text-ink">{host(p.url)}</h2>
        <a href={p.url} target="_blank" rel="noreferrer" className="text-[13px] break-all text-docker hover:underline">
          {p.url}
        </a>
        <p className="mt-3 max-w-[60ch] text-[14.5px] leading-relaxed text-slate">{p.reason}</p>
        <Actions id={p.id} busy={!!busy} onChanged={onChanged} onRemoved={onRemoved} />
      </header>

      <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-hairline py-5 sm:grid-cols-4">
        <Fact label={t("detail.openTenders")}>
          <a href={`/portals/${encodeURIComponent(p.id)}/tenders`} target="_blank" rel="noreferrer" className="num underline decoration-hairline underline-offset-4 hover:decoration-ink">
            {int(p.tenderCount)}
          </a>
        </Fact>
        <Fact label={t("detail.lastDelivered")}>{p.lastSuccessAt ? when(p.lastSuccessAt, now) : <span className="text-faint">{t("table.notYet")}</span>}</Fact>
        <Fact label={t("detail.howRead")}>
          {recipe ? t("detail.recipe", { tier: tierName((recipe.json as { tier?: string }).tier), v: String(recipe.version) }) : <span className="text-faint">{t("detail.notLearned")}</span>}
        </Fact>
        <Fact label={t("detail.modelCost")}>
          <span className="num">{usd(cost)}</span>
        </Fact>
      </dl>

      <section className="mt-8 rounded-[6px] border border-hairline bg-sea p-3" aria-labelledby="activity-title">
        <h3 id="activity-title" className="mb-2 text-sm font-semibold">{t("detail.activity")}</h3>
        <Strip runs={d.runs.map((r) => ({ kind: r.kind, result: r.result, startedAt: r.started_at, finishedAt: r.finished_at }))} now={now} />
        <div className="mt-1 flex justify-between text-xs text-faint"><span>{t("detail.24h")}</span><span>{t("detail.12h")}</span><span>{t("detail.now")}</span></div>
        <p className="mt-3 text-xs text-slate">{t("detail.marks")}</p>
      </section>
      <History d={d} now={now} />
      <Log events={d.events} />
      <Usage d={d} />
      {recipe && <RecipeView recipe={recipe} />}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-slate">{label}</dt>
      <dd className="mt-0.5 text-[15px]">{children}</dd>
    </div>
  );
}

const TIERS = ["feed", "jsonApi", "html", "browser"];
const tierName = (tier?: string) => t(tier && TIERS.includes(tier) ? (`tier.${tier}` as Key) : "tier.unknown");

function Actions({ id, busy, onChanged, onRemoved }: { id: string; busy: boolean; onChanged: () => void; onRemoved: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(t);
  }, [confirm]);

  const refresh = async () => {
    const res = await fetch(`/portals/${encodeURIComponent(id)}/refresh`, { method: "POST" }).catch(() => null);
    setNote(res?.ok ? (busy ? t("detail.alreadyRunning") : t("detail.readingNow")) : t("detail.readNotStarted"));
    onChanged();
  };
  const remove = async () => {
    if (!confirm) return setConfirm(true);
    const res = await fetch(`/portals/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok || res?.status === 404) onRemoved();
    else setNote(t("detail.notRemoved"));
  };

  return (
    <div className="mt-5 flex flex-wrap items-center gap-2">
      <button onClick={refresh} className="h-8 rounded-[4px] bg-docker-solid px-3 text-[13px] font-semibold text-white hover:bg-docker-hover cursor-pointer">
        {t("detail.readNow")}
      </button>
      <button
        onClick={remove}
        className={`h-8 rounded-[4px] border px-3 text-[13px] font-medium cursor-pointer ${confirm ? "border-failed bg-failed text-white" : "border-hairline text-slate hover:border-failed/50 hover:text-failed"}`}
      >
        {confirm ? t("detail.confirmStop") : t("detail.stop")}
      </button>
      {note && <span role="status" className="text-[13px] text-slate">{note}</span>}
    </div>
  );
}

// ------------------------------------------------------------ history

const sameDay = (iso: string, now: number) => new Date(iso).toDateString() === new Date(now).toDateString();

type Item = { type: "run"; run: RunRow } | { type: "quiet"; runs: RunRow[] };

/** Consecutive passing reads fold into one line; anything else stays visible. */
function fold(runs: RunRow[]): Item[] {
  const out: Item[] = [];
  for (const r of runs) {
    const quiet = r.kind === "read" && r.result === "ok";
    const last = out.at(-1);
    if (quiet && last?.type === "quiet") last.runs.push(r);
    else if (quiet) out.push({ type: "quiet", runs: [r] });
    else out.push({ type: "run", run: r });
  }
  return out;
}

function History({ d, now }: { d: PortalDetail; now: number }) {
  const items = useMemo(() => fold(d.runs), [d.runs]);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 12);

  return (
    <section className="mt-10" aria-labelledby="history">
      <h3 id="history" className="text-sm font-semibold">{t("detail.history")}</h3>
      <p className="mt-1 text-xs text-faint">{t("detail.historyNote")}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-[14px] text-slate">{t("detail.historyEmpty")}</p>
      ) : (
        <ol className="relative mt-4 border-l border-hairline">
          {shown.map((it, i) =>
            it.type === "quiet" ? <Quiet key={i} runs={it.runs} now={now} /> : <Event key={it.run.id} run={it.run} d={d} now={now} />,
          )}
        </ol>
      )}
      {items.length > 12 && (
        <button onClick={() => setAll(!all)} className="mt-3 ml-5 text-[13px] text-slate underline decoration-hairline underline-offset-4 hover:text-ink">
          {all ? t("detail.showLess") : t("detail.showAll", { n: d.runs.length })}
        </button>
      )}
    </section>
  );
}

function Dot({ cls, big }: { cls: string; big?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`absolute top-[7px] rounded-full ring-4 ring-paper ${cls} ${big ? "-left-[5px] h-[9px] w-[9px]" : "-left-[3.5px] h-[6px] w-[6px]"}`}
    />
  );
}

function Quiet({ runs, now }: { runs: RunRow[]; now: number }) {
  const newest = runs[0]!;
  const oldest = runs.at(-1)!;
  const text = runs.length === 1 ? t("detail.quietOne", { t: clock(newest.started_at) }) : t("detail.quietMany", { n: runs.length, a: clock(oldest.started_at), b: clock(newest.started_at) });
  return (
    <li className="relative pb-5 pl-5">
      <Dot cls="bg-faint" />
      <p className="text-[14px] text-slate">
        {text}
        {!sameDay(newest.started_at, now) && <span className="text-faint">, {when(newest.started_at, now)}</span>}
      </p>
      <p className="mt-0.5 text-[13px] text-faint">{newest.summary}</p>
    </li>
  );
}

function Event({ run, d, now }: { run: RunRow; d: PortalDetail; now: number }) {
  const repair = run.kind === "repair";
  const running = run.result === null;
  const title = repair
    ? running ? t("run.repairing") : run.result === "ok" ? t("run.repaired") : t("run.repairFailed")
    : running ? t("run.reading") : run.result === "ok" ? t("run.readPassed") : t("run.readFailed");
  const tone = running ? "bg-integrating" : run.result === "ok" ? (repair ? "bg-serving" : "bg-faint") : "bg-failed";
  const text = "text-ink";
  const cost = d.runCosts?.[run.id] ?? 0;
  const events = d.events.filter((e) => e.run_id === run.id).reverse();

  // The recipe this repair produced, and the one before it.
  const made = repair && run.result === "ok"
    ? d.recipes.find((r) => r.origin === "repair" && Math.abs(new Date(r.created_at).getTime() - new Date(run.finished_at ?? run.started_at).getTime()) < 15 * 60_000 && new Date(r.created_at) >= new Date(run.started_at))
    : undefined;
  const before = made ? d.recipes.find((r) => r.version === made.version - 1) : undefined;
  const changes = made && before ? diffRecipes(before.json, made.json) : [];

  return (
    <li className="relative pb-6 pl-5">
      <Dot cls={tone} big />
      <div className="flex flex-wrap items-baseline gap-x-3">
        <p className={`text-[14.5px] font-semibold ${text}`}>{title}</p>
        <p className="text-[13px] text-slate">
          <time dateTime={run.started_at}>{when(run.started_at, now)}</time>
          {run.finished_at && t("run.took", { d: duration(run.started_at, run.finished_at) })}
          {cost > 0 && tx("run.cost", {}, { c: <span className="num">{usd(cost)}</span> })}
        </p>
      </div>
      {run.summary && <p className="mt-1 max-w-[60ch] text-[14.5px] leading-relaxed">{run.summary}</p>}
      {events.length > 0 && (
        <ul className="mt-2 space-y-1">
          {events.map((e, i) => (
            <li key={i} className="flex gap-2 text-[13px] text-slate">
              <span className="num shrink-0 text-faint">{clock(e.at)}</span>
              <span className={e.level === "error" ? "text-failed" : e.level === "warn" ? "text-healing-text" : ""}>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
      {changes.length > 0 && <Changes changes={changes} from={before!.version} to={made!.version} />}
    </li>
  );
}

function Changes({ changes, from, to }: { changes: ReturnType<typeof diffRecipes>; from: number; to: number }) {
  return (
    <figure className="mt-3 overflow-hidden rounded-lg border border-hairline">
      <figcaption className="border-b border-hairline bg-mist px-3 py-1.5 text-[12.5px] text-slate">
        {t("detail.changes", { a: String(from), b: String(to) })}
      </figcaption>
      <dl className="divide-y divide-hairline font-mono text-[12.5px] leading-relaxed">
        {changes.map((c) => (
          <div key={c.path} className="px-3 py-2">
            <dt className="text-slate">{c.path}</dt>
            {c.before !== null && <dd className="text-failed"><span aria-label={t("detail.removed")}>− </span>{c.before}</dd>}
            {c.after !== null && <dd className="text-serving"><span aria-label={t("detail.addedAria")}>+ </span>{c.after}</dd>}
          </div>
        ))}
      </dl>
    </figure>
  );
}

// ------------------------------------------------------------ log, usage, recipe

function Log({ events }: { events: PortalDetail["events"] }) {
  const [open, setOpen] = useState(false);
  if (events.length === 0) return null;
  const warnings = events.filter((e) => e.level !== "info").length;
  return (
    <section className="mt-8 border-t border-hairline pt-6">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-baseline justify-between text-left">
        <h3 className="text-sm font-semibold">{t("detail.runLog")}</h3>
        <span className="text-[13px] text-slate">
          {t("detail.entries", { n: events.length, w: warnings })} {open ? t("detail.hide") : t("detail.show")}
        </span>
      </button>
      {open && (
        <ul className="mt-3 max-h-[360px] space-y-1.5 overflow-y-auto rounded-lg bg-mist p-3 text-[13px]">
          {events.map((e, i) => (
            <li key={i} className="flex gap-3">
              <span className="num shrink-0 text-faint">{clock(e.at)}</span>
              <span className={e.level === "error" ? "text-failed" : e.level === "warn" ? "text-healing-text" : "text-slate"}>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Usage({ d }: { d: PortalDetail }) {
  if (d.ledger.length === 0) return null;
  const names: Record<string, string> = { attach: t("usage.attach"), repair: t("usage.repair"), check: t("usage.check"), triage: t("usage.triage") };
  return (
    <section className="mt-8 border-t border-hairline pt-6">
      <h3 className="text-sm font-semibold">{t("usage.title")}</h3>
      <table className="mt-3 w-full text-[14px]">
        <thead className="text-[12.5px] text-slate">
          <tr>
            <th scope="col" className="pb-1.5 text-left font-medium">{t("usage.for")}</th>
            <th scope="col" className="pb-1.5 text-right font-medium">{t("usage.calls")}</th>
            <th scope="col" className="pb-1.5 text-right font-medium">{t("usage.tokens")}</th>
            <th scope="col" className="pb-1.5 text-right font-medium">{t("usage.cost")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {d.ledger.map((r) => (
            <tr key={r.purpose}>
              <td className="py-1.5">{names[r.purpose] ?? r.purpose}</td>
              <td className="num py-1.5 text-right">{int(r.calls)}</td>
              <td className="num py-1.5 text-right text-slate">{int(r.input_tokens)}, {int(r.output_tokens)}</td>
              <td className="num py-1.5 text-right">{usd(r.cost_usd)}</td>
            </tr>
          ))}
          <tr>
            <td className="py-1.5 text-slate" colSpan={3}>{t("usage.regular")}</td>
            <td className="num py-1.5 text-right text-slate">{usd(0)}</td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}

function RecipeView({ recipe }: { recipe: PortalDetail["recipes"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="mt-8 border-t border-hairline pt-6">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-baseline justify-between text-left">
        <h3 className="text-sm font-semibold">{t("detail.recipeTitle", { v: String(recipe.version) })}</h3>
        <span className="text-[13px] text-slate">{open ? t("detail.hide") : t("detail.show")}</span>
      </button>
      <p className="mt-1 max-w-[60ch] text-[14px] text-slate">{recipe.note}</p>
      {open && (
        <pre className="mt-3 max-h-[420px] overflow-auto rounded-lg bg-mist p-3 font-mono text-[12px] leading-relaxed">
          {JSON.stringify(recipe.json, null, 2)}
        </pre>
      )}
    </section>
  );
}
