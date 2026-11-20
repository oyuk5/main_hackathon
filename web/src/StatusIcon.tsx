import type { State } from "./lib";

export type StatusIconKind = "ok" | "passed" | "running" | "integrating" | "failed";

export function stateToIconKind(state: State): StatusIconKind {
  if (state === "serving") return "ok";
  if (state === "healing") return "running";
  if (state === "integrating") return "integrating";
  return "failed";
}

const COLOR: Record<StatusIconKind, string> = {
  ok: "text-serving",
  passed: "text-faint",
  running: "text-healing",
  integrating: "text-integrating",
  failed: "text-failed",
};

/**
 * Docker Desktop style 10-12px status circles:
 * solid teal circle for active/serving (like in-use images), hollow circle for idle/passed,
 * calm amber ring+dot for repairing, solid muted red dot for needs-person.
 */
export function StatusIcon({ kind, size = 11 }: { kind: StatusIconKind; size?: number }) {
  const cls = `shrink-0 ${COLOR[kind]} ${kind === "integrating" ? "animate-pulse" : ""}`;

  if (kind === "ok" || kind === "failed") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" className={cls}>
        <circle cx="6" cy="6" r="4.5" />
      </svg>
    );
  }

  if (kind === "running") {
    return (
      <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true" className={cls}>
        <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2.4 1.6" />
        <circle cx="6" cy="6" r="1.9" fill="currentColor" />
      </svg>
    );
  }

  // passed / integrating: crisp hollow outline ring like unused images in Docker Desktop
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" aria-hidden="true" className={cls}>
      <circle cx="6" cy="6" r="4.25" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}
