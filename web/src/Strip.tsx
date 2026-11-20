/**
 * The last 24 hours of one portal, as marks on a time axis: every regular read, every failed
 * read, every repair. Quiet when nothing happened; a repair stands out because it is taller.
 */
import { clock, type RecentRun } from "./lib";

const W = 288; // 12 units per hour
const H = 26;

function mark(r: RecentRun) {
  if (r.kind === "repair") {
    if (r.result === null) return { h: 20, cls: "fill-integrating", label: "Repair running" };
    return r.result === "ok" ? { h: 20, cls: "fill-serving", label: "Repaired" } : { h: 20, cls: "fill-failed", label: "Repair failed" };
  }
  if (r.result === "failed") return { h: 12, cls: "fill-failed", label: "Read failed" };
  if (r.result === null) return { h: 8, cls: "fill-integrating", label: "Reading" };
  return { h: 6, cls: "fill-faint", label: "Read passed" };
}

export function Strip({ runs, now, compact = false }: { runs: RecentRun[]; now: number; compact?: boolean }) {
  const day = 24 * 3_600_000;
  const visible = runs.filter((r) => now - new Date(r.startedAt).getTime() <= day);
  const reads = visible.filter((r) => r.kind === "read").length;
  const repairs = visible.filter((r) => r.kind === "repair").length;
  const failed = visible.filter((r) => r.result === "failed").length;
  const label = visible.length
    ? `Last 24 hours: ${reads} reads, ${repairs} repairs, ${failed} failed.`
    : "No activity in the last 24 hours.";
  // Draw quiet marks first so a repair is never hidden under a read.
  const ordered = [...visible].sort((a, b) => mark(a).h - mark(b).h);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`block w-full ${compact ? "h-[14px]" : "h-[26px]"}`} role="img" aria-label={label}>
      <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-hairline" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {[6, 12, 18].map((h) => (
        <line key={h} x1={h * 12} x2={h * 12} y1={H - 4} y2={H} className="stroke-hairline" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      {ordered.map((r, i) => {
        const age = now - new Date(r.startedAt).getTime();
        const x = W - (age / day) * W;
        const m = mark(r);
        return (
          <rect key={i} x={Math.min(W - 2, Math.max(0, x - 1))} y={H - 1 - m.h} width={r.kind === "repair" ? 3 : 2} height={m.h} rx="1" className={m.cls}>
            <title>{`${m.label} at ${clock(r.startedAt)}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
