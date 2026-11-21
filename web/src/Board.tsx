/**
 * Current problems, recent recoveries, and a separate lane for first attaches.
 * A status filter shows only its matching lane; Serving lists portals, not past repair runs.
 * Tickets are built from the overview only; a ticket opens the portal's side panel.
 */
import { StatusIcon, stateToIconKind } from "./StatusIcon";
import { CHARACTER, clock, duration, host, int, when, type PortalRow, type RecentRun, type State } from "./lib";
import { t } from "./i18n";

type Lane = "person" | "fixing" | "fixed" | "attaching" | "clear";

interface Ticket {
  key: string;
  p: PortalRow;
  title: string;
  body: string;
  meta: string[];
  tried?: string;
  working?: boolean;
}

/** Lane texts come from the dictionary: lane.<id>.title, .note and .empty. */
const LANES: { id: Lane; tone: string }[] = [
  { id: "person", tone: "bg-failed" },
  { id: "fixing", tone: "bg-healing" },
  { id: "fixed", tone: "bg-serving" },
  { id: "attaching", tone: "bg-integrating" },
  { id: "clear", tone: "bg-serving" },
];
const laneText = (id: Lane, part: "title" | "note" | "empty") => t(`lane.${id}.${part}`);
const STATUS_LANE: Record<State, Lane> = { failed: "person", healing: "fixing", integrating: "attaching", serving: "clear" };

/** What a person can do about a portal Watchtower cannot fix itself. Null when the reason gives no clue. */
export function nextStep(reason: string): string | null {
  const r = reason.toLowerCase();
  if (r.includes("robots.txt")) return t("next.robots");
  if (r.includes("login") || r.includes("sign-in")) return t("next.login");
  if (r.includes("captcha")) return t("next.captcha");
  if (r.includes("403") || r.includes("forbidden")) return t("next.forbidden");
  if (r.includes("session")) return t("next.session");
  if (r.includes("javascript")) return t("next.javascript");
  return null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A ticket's title and description from a reason sentence.
 * "Documents need a login: the button…" gives title "Documents need a login" and the rest as text.
 * A short label ("Blocked: robots.txt disallows /api/, where…") keeps its first clause in the title.
 * A reason without a label uses its first sentence as the title and the rest as text.
 */
export function ticketText(reason: string): { title: string; body: string } {
  const r = reason.trim();
  const colon = r.indexOf(": ");
  const firstClause = (s: string) => s.split(/[,;]\s|\.\s|\.$/)[0]!.trim();
  if (colon > 0) {
    const label = r.slice(0, colon);
    const rest = r.slice(colon + 2);
    if (label.split(/\s+/).length >= 3) return { title: label, body: cap(rest) };
    const first = firstClause(rest);
    const more = rest.slice(first.length).replace(/^[.,;]\s*/, "");
    // A remainder that starts mid-sentence ("where this portal…") reads better whole.
    return { title: `${label}: ${first}`, body: cap(/^(where|which|so|and|because|but)\b/i.test(more) ? rest : more) };
  }
  const first = firstClause(r);
  const rest = r.slice(first.length).replace(/^[.,;]\s*/, "");
  return { title: cap(first), body: cap(rest) };
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
  return p.tenderCount > 0 ? t("board.served", { n: p.tenderCount }) : t("board.nothingYet");
}

function tickets(rows: PortalRow[], now: number): Record<Lane, Ticket[]> {
  const out: Record<Lane, Ticket[]> = { person: [], fixing: [], fixed: [], attaching: [], clear: [] };
  for (const p of rows) {
    const runs = newestFirst(p.recent);
    const since = troubleSince(p);

    if (p.state === "failed") {
      const tried = runs.find((r) => r.kind === "repair" && r.result === "failed")?.summary;
      out.person.push({
        key: p.id, p, ...ticketText(p.reason), tried: tried || undefined,
        meta: [since ? t("board.broke", { when: when(since, now) }) : t("board.never"), served(p)],
      });
    } else if (p.state === "healing") {
      const repair = runs.find((r) => r.kind === "repair" && r.result === null);
      out.fixing.push({
        key: p.id, p, ...ticketText(p.reason.replace(/^Repairing:\s*/i, "")), working: true,
        meta: [repair ? t("board.repairStarted", { when: when(repair.startedAt, now) }) : since ? t("board.broke", { when: when(since, now) }) : t("board.queued"), served(p)],
      });
    } else if (p.state === "integrating") {
      out.attaching.push({ key: p.id, p, title: t("board.learning"), body: p.reason, working: true, meta: [t("board.firstTenders")] });
    } else {
      out.clear.push({ key: p.id, p, title: host(p.url), body: p.reason, meta: [] });
    }

    // Every repair that worked in the last 24 hours is a closed ticket, whatever the state is now.
    runs.forEach((r, i) => {
      if (r.kind !== "repair" || r.result !== "ok" || Date.parse(r.startedAt) < now - 24 * 3_600_000) return;
      const broke = runs.slice(i + 1).find((x) => x.result === "failed");
      out.fixed.push({
        key: `${p.id}-${r.startedAt}`, p,
        title: ticketText(broke?.summary || t("board.changed")).title,
        body: r.summary || t("board.repairedDot"),
        meta: [
          t("board.brokeRepaired", { a: clock(broke?.startedAt ?? r.startedAt), b: clock(r.finishedAt ?? r.startedAt) }),
          r.finishedAt ? t("board.took", { d: duration(broke?.startedAt ?? r.startedAt, r.finishedAt) }) : "",
        ].filter(Boolean),
      });
    });
  }
  out.fixed.sort((a, b) => b.key.localeCompare(a.key));
  return out;
}

/** Count current problems, not first attaches or historical repair runs. */
export function openIssues(rows: PortalRow[]): number {
  return rows.filter((p) => p.state === "failed" || p.state === "healing").length;
}

export function Board({ rows, state, now, hover, setHover }: { rows: PortalRow[]; state: State | "all"; now: number; hover: string | null; setHover: (id: string | null) => void }) {
  const lanes = tickets(rows, now);
  const visibleLanes = LANES.filter(({ id }) => state === "all"
    ? id !== "clear" && (id !== "attaching" || lanes.attaching.length > 0)
    : id === STATUS_LANE[state]);
  const columns = state !== "all" ? "" : visibleLanes.length === 4 ? "md:grid-cols-2 xl:grid-cols-4" : "lg:grid-cols-3";
  return (
    <section aria-label={t("board.label")} className={`grid gap-5 ${columns}`}>
      {visibleLanes.map((lane) => (
        <div key={lane.id} className="flex min-w-0 flex-col rounded-[6px] border border-hairline bg-paper/60 px-3 pt-3 pb-2">
          <header className="pb-3">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
                <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${lane.tone}`} />
                {laneText(lane.id, "title")}
              </h2>
              <span className="num text-[15px] font-semibold text-slate">{lanes[lane.id].length}</span>
            </div>
            <p className="mt-0.5 text-[12.5px] leading-snug text-slate">{laneText(lane.id, "note")}</p>
          </header>
          {lanes[lane.id].length === 0 ? (
            <p className="rounded-[4px] border border-dashed border-hairline px-4 py-6 text-center text-[13px] text-faint">{laneText(lane.id, "empty")}</p>
          ) : lane.id === "clear" ? (
            <ul className="rounded-[4px] border border-hairline bg-sea/40">
              {lanes.clear.map((k) => <ClearRow key={k.key} k={k} now={now} hover={hover} setHover={setHover} />)}
            </ul>
          ) : (
            <ul className="space-y-2.5">
              {lanes[lane.id].map((k) => <Card key={k.key} k={k} hover={hover} setHover={setHover} />)}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}

function Card({ k, hover, setHover }: { k: Ticket; hover: string | null; setHover: (id: string | null) => void }) {
  const p = k.p;
  return (
    <li>
      <a
        href={`#/p/${encodeURIComponent(p.id)}`}
        onMouseEnter={() => setHover(p.id)}
        onMouseLeave={() => setHover(null)}
        onFocus={() => setHover(p.id)}
        onBlur={() => setHover(null)}
        className={`block rounded-[4px] border border-hairline bg-paper px-3.5 py-2.5 transition-colors ${hover === p.id ? "border-docker/60 bg-mist" : "hover:bg-mist"}`}
      >
        <span className="flex items-center gap-2 text-[13px]">
          <StatusIcon kind={stateToIconKind(p.state)} size={11} />
          <span className="min-w-0 truncate font-semibold text-ink">{host(p.url)}</span>
          {k.working && <span className="ml-auto shrink-0 text-[12px] text-slate">{t("board.working")}</span>}
        </span>
        <span className="mt-1.5 block text-[15px] leading-snug font-semibold [overflow-wrap:anywhere]">{k.title}</span>
        <span className="mt-1 block text-[13.5px] leading-snug text-slate">{k.body}</span>
        {p.state === "failed" && nextStep(p.reason) && (
          <span className="mt-2 block rounded-[4px] bg-failed-wash px-2.5 py-1.5 text-[13px] leading-snug text-ink">
            <span className="font-semibold">{t("board.todo")}</span>{nextStep(p.reason)}
          </span>
        )}
        {k.tried && (
          <span className="mt-2 block border-l-2 border-hairline pl-2.5 text-[13px] leading-snug text-slate">
            <span className="font-semibold text-ink">{t("board.tried")}</span>{k.tried}
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
        <StatusIcon kind={stateToIconKind(p.state)} size={11} />
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-ink">{host(p.url)}</span>
          <span className="block text-[12px] text-slate">{p.lastSuccessAt ? t("board.lastRead", { when: when(p.lastSuccessAt, now) }) : CHARACTER[p.state].words}</span>
        </span>
        <span className="text-right">
          <span className="num block text-[14.5px] leading-tight font-semibold text-ink">{int(p.tenderCount)}</span>
          <span className="block text-[11.5px] text-slate">{t("board.open")}</span>
        </span>
      </a>
    </li>
  );
}
