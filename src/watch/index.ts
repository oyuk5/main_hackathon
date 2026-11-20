/**
 * Watch module. Owned by C.
 * evaluate(): deterministic verdict on a read. medic: repairs a broken recipe and proves it.
 * This first version has only the basic checks; C extends it (see docs/TASKS.md).
 */
import type { CheckResult, Medic, Verdict, Watch } from "../shared/modules.js";

const REQUIRED = ["id", "url", "title", "buyerName", "publicationDate", "submissionDeadline"] as const;

export const watch: Watch = {
  evaluate(read, baseline): Verdict {
    if (read.kind === "blocked") return { kind: "blocked", reason: read.reason };
    if (read.kind === "unreachable") return { kind: "unreachable", reason: read.reason };
    if (read.kind === "error") return { kind: "broken", reason: read.reason, checks: [] };

    const checks: CheckResult[] = [];
    const n = read.tenders.length;

    if (n === 0) {
      const empty = Boolean(read.diagnostics.emptyStateText);
      checks.push({ name: "items", ok: empty, detail: empty ? `Portal says: "${read.diagnostics.emptyStateText}"` : "No tenders found on the list." });
    } else {
      checks.push({ name: "items", ok: true, detail: `${n} tenders on the list.` });
    }

    if (baseline.lastGoodCount && n < baseline.lastGoodCount * 0.5 && !read.diagnostics.emptyStateText) {
      checks.push({ name: "count-drop", ok: false, detail: `Only ${n} tenders, was ${baseline.lastGoodCount}.` });
    }

    for (const f of REQUIRED) {
      const fill = read.diagnostics.fieldFill[f];
      if (fill && fill.total > 0 && fill.filled === 0) {
        checks.push({ name: `fill:${f}`, ok: false, detail: `No tender has a ${f}.` });
      }
    }

    // TODO(C): invariants, golden-record recheck, skeleton drift, duplicate ids, document reachability.
    const failed = checks.filter((c) => !c.ok);
    return failed.length
      ? { kind: "broken", reason: failed.map((c) => c.detail).join(" "), checks }
      : { kind: "healthy", reason: `${n} tenders, all checks passed.`, checks };
  },
};

export const medic: Medic = {
  async repair() {
    return { kind: "failed", reason: "Repair is not implemented yet." }; // TODO(C)
  },
};
