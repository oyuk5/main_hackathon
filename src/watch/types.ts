import type { CheckResult } from "../shared/modules.js";

export interface GoldenVerificationResult {
  checked: number;
  matched: number;
  mismatches: string[];
}

export type SnapshotOutcome =
  | {
      kind: "ok";
      url: string;
      finalUrl: string;
      httpStatus: number;
      contentType: string;
      compressedContent: string;
      structureSummary: string;
      capturedApiUrls?: string[];
    }
  | { kind: "blocked"; reason: string; httpStatus?: number }
  | { kind: "unreachable"; reason: string; httpStatus?: number };

export type TriageCategory =
  | "blocked"
  | "unreachable"
  | "url-moved"
  | "selector-broken"
  | "json-key-renamed"
  | "pagination-changed"
  | "format-changed"
  | "golden-mismatch"
  | "unknown";

export interface TriageReport {
  category: TriageCategory;
  reason: string;
  hint: string;
  failedChecks: CheckResult[];
  snapshot: SnapshotOutcome;
  redirectUrl?: string;
}
