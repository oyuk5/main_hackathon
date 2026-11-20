/**
 * RECIPE: how to read one portal, as data. Owned by B (attach).
 *
 * The LLM writes and patches recipes. The Extractor runs them without any model call.
 * Keep it declarative: no code strings, no eval. Every new capability is a new field
 * with a validator, so the Medic can patch it with a small JSON Patch.
 */
import { z } from "zod";

/** Where a value comes from. Exactly one of css / jsonPath / regex / const. */
export const Selector = z
  .object({
    css: z.string().optional(),
    /** Attribute to read instead of text, e.g. "href". */
    attr: z.string().optional(),
    jsonPath: z.string().optional(),
    /** Applied to the text after selection; first capture group wins. */
    regex: z.string().optional(),
    const: z.string().optional(),
    /** Label text next to the value, e.g. "Vergabestelle" or "Date limite". Used with css scope. */
    label: z.string().optional(),
    all: z.boolean().optional(),
  })
  .describe("Selector");
export type Selector = z.infer<typeof Selector>;

export const FieldRule = Selector.extend({
  parse: z.enum(["text", "date", "datetime", "cpv", "url", "procedureType", "contractNature", "postalCode"]).optional(),
  /** e.g. "dd.MM.yyyy HH:mm". Optional; normalizer also tries common European formats. */
  format: z.string().optional(),
});
export type FieldRule = z.infer<typeof FieldRule>;

export const RequestSpec = z.object({
  /** May contain {page}, {offset}, {pageSize}. */
  url: z.string(),
  method: z.enum(["GET", "POST"]).default("GET"),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export const Pagination = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("pageParam"), start: z.number().int().default(1), maxPages: z.number().int().default(50) }),
  z.object({ type: z.literal("offsetParam"), pageSize: z.number().int(), maxPages: z.number().int().default(50) }),
  z.object({ type: z.literal("nextLink"), selector: Selector, maxPages: z.number().int().default(50) }),
  z.object({ type: z.literal("clickNext"), selector: z.string(), maxPages: z.number().int().default(50) }),
]);

export const DocumentsRule = z.object({
  /** Optional hops from the tender page to the page that lists the files ("Vergabeunterlagen"). */
  hops: z.array(Selector).default([]),
  /** Links or buttons that yield files on the final page. */
  files: Selector,
  via: z.enum(["http", "browser"]).default("http"),
});

export const Recipe = z.object({
  schemaVersion: z.literal(1),
  /** Software family if recognised, e.g. "cosinex-vmp". */
  family: z.string().nullable().default(null),
  /** feed | jsonApi | html | browser. Prefer the most stable one the portal offers. */
  tier: z.enum(["feed", "jsonApi", "html", "browser"]),
  /** IANA zone for times shown without offset, e.g. Europe/Berlin. */
  timeZone: z.string(),
  /** Two letters, used for placeOfPerformance when the portal is national. */
  countryCode: z.string().length(2).nullable().default(null),
  list: z.object({
    request: RequestSpec,
    pagination: Pagination,
    /** CSS selector or JSONPath for one item in the list. */
    item: z.string(),
    /** Text that means "no tenders right now", so empty is not mistaken for broken. */
    emptyText: z.array(z.string()).default([]),
  }),
  /** Field rules applied to each list item. */
  listFields: z.record(z.string(), FieldRule),
  /** Field rules applied to the tender's own page, fetched for new or changed items only. */
  detail: z
    .object({
      urlFrom: z.string().default("url"),
      fields: z.record(z.string(), FieldRule),
    })
    .nullable()
    .default(null),
  documents: DocumentsRule.nullable().default(null),
  /** Words on the page that mean the buyer cancelled the tender. */
  withdrawnText: z.array(z.string()).default([]),
});
export type Recipe = z.infer<typeof Recipe>;
