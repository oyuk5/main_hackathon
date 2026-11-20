/**
 * THE API CONTRACT. FROZEN.
 *
 * Mirrors the Patterno brief appendix ("Exact answers", "Every field of a tender").
 * Source of truth: docs/BRIEF.md. Do not change a field name, type or enum value
 * without the whole team agreeing. Patterno's grader calls these shapes.
 *
 * Responses on the public routes must contain exactly these fields.
 * Extra data for the dashboard goes on /internal/* routes, never here.
 */
import { z } from "zod";

/** Date and time WITH an explicit offset, e.g. 2026-12-09T10:00:00+01:00. Never "Z". */
export const DateTimeWithOffset = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?[+-]\d{2}:\d{2}$/, "date-time with offset, e.g. 2026-12-09T10:00:00+01:00");

/** Calendar date, e.g. 2026-11-20. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date, e.g. 2026-11-20");

// ---------------------------------------------------------------- portals

export const PortalState = z.enum(["integrating", "serving", "healing", "failed"]);
export type PortalState = z.infer<typeof PortalState>;

/** GET /portals (array of these) and GET /portals/{id}. */
export const PortalEntry = z.strictObject({
  id: z.string().min(1),
  url: z.string().url(),
  state: PortalState,
  /** Plain words for an operator. Always set, in every state. */
  reason: z.string().min(1),
  tenderCount: z.number().int().nonnegative(),
  lastSuccessAt: DateTimeWithOffset.nullable(),
});
export type PortalEntry = z.infer<typeof PortalEntry>;

/** POST /portals body. */
export const AddPortalBody = z.object({ url: z.string().url() });
/** POST /portals answer (201). Same address twice returns the same id. */
export const AddPortalResponse = z.strictObject({ id: z.string().min(1) });
/** POST /portals/{id}/refresh answer (202). */
export const RefreshResponse = z.strictObject({ runId: z.string().min(1) });

// ---------------------------------------------------------------- runs

export const RunKind = z.enum(["read", "repair"]);
export const RunResult = z.enum(["ok", "failed"]);

/** GET /portals/{id}/runs (array). The first attach is a "read". */
export const Run = z.strictObject({
  id: z.string().min(1),
  kind: RunKind,
  startedAt: DateTimeWithOffset,
  finishedAt: DateTimeWithOffset.nullable(),
  /** null while the run is still going. */
  result: RunResult.nullable(),
});
export type Run = z.infer<typeof Run>;

// ---------------------------------------------------------------- tenders

export const TenderStatus = z.enum(["open", "closed", "withdrawn"]);
export const ProcedureType = z.enum(["open", "restricted", "negotiated", "other"]);
export const ContractNature = z.enum(["works", "services", "supplies"]);

export const TenderDocument = z.strictObject({
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Path on OUR API that returns the bytes, e.g. /files/ab12... */
  path: z.string().startsWith("/files/"),
});
export type TenderDocument = z.infer<typeof TenderDocument>;

export const PlaceOfPerformance = z.strictObject({
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  /** Two letters, e.g. DE. */
  countryCode: z.string().regex(/^[A-Z]{2}$/).nullable(),
});

/**
 * GET /portals/{id}/tenders (array).
 * Required fields are always present; send null when the portal does not show them.
 * Optional ("if shown") fields are LEFT OUT when not shown.
 * A wrong value is worse than a missing one: when unsure, send null / leave out.
 */
export const Tender = z.strictObject({
  // required
  id: z.string().min(1), // the portal's own identifier, stable across reads
  url: z.string().url(), // the tender's own page, not a summary page
  title: z.string().min(1).nullable(),
  buyerName: z.string().min(1).nullable(),
  publicationDate: IsoDate.nullable(),
  submissionDeadline: DateTimeWithOffset.nullable(), // local time of the portal, with its offset
  status: TenderStatus,
  documents: z.array(TenderDocument),
  lastChangedAt: DateTimeWithOffset,
  // if shown
  referenceNumber: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  procedureType: ProcedureType.optional(),
  contractNature: ContractNature.optional(),
  cpvCodes: z.array(z.string().regex(/^\d{8}$/, "8 digits, no check digit")).optional(),
  placeOfPerformance: PlaceOfPerformance.optional(),
});
export type Tender = z.infer<typeof Tender>;

export const TenderList = z.array(Tender);
export const PortalList = z.array(PortalEntry);
export const RunList = z.array(Run);
