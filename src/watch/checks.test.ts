import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Baseline,
  ExtractedTender,
  GoldenRecord,
  ReadDiagnostics,
  ReadOutcome,
} from "../shared/modules.js";
import { evaluateRead, verifyGoldenRecords } from "./checks.js";

function makeTender(overrides: Partial<ExtractedTender> = {}): ExtractedTender {
  return {
    id: "T-1",
    url: "https://portal.example.org/tenders/T-1",
    title: "Road maintenance 2026",
    buyerName: "City of Example",
    publicationDate: "2026-11-01",
    submissionDeadline: "2026-12-01T12:00:00+01:00",
    documentRefs: [{ url: "https://portal.example.org/files/spec.pdf", via: "http" }],
    ...overrides,
  };
}

function makeDiagnostics(overrides: Partial<ReadDiagnostics> = {}): ReadDiagnostics {
  return {
    requests: 2,
    listPages: 1,
    itemsSeen: 1,
    fieldFill: {},
    durationMs: 120,
    ...overrides,
  };
}

function makeOkRead(
  tenders: ExtractedTender[],
  diagOverrides: Partial<ReadDiagnostics> = {},
): Extract<ReadOutcome, { kind: "ok" }> {
  return {
    kind: "ok",
    tenders,
    diagnostics: makeDiagnostics({ itemsSeen: tenders.length, ...diagOverrides }),
  };
}

function makeBaseline(overrides: Partial<Baseline> = {}): Baseline {
  return {
    lastGoodCount: null,
    lastGoodFieldFill: null,
    lastGoodSkeletonHash: null,
    golden: [],
    ...overrides,
  };
}

describe("verifyGoldenRecords", () => {
  it("matches golden records with normalized whitespace", () => {
    const tenders = [
      makeTender({
        id: "T-1",
        title: "  Road   maintenance\n2026  ",
        buyerName: "City  of Example",
      }),
    ];
    const golden: GoldenRecord[] = [
      {
        id: "T-1",
        fields: { title: "Road maintenance 2026", buyerName: "City of Example" },
      },
      {
        id: "T-MISSING",
        fields: { title: "Not on page anymore" },
      },
    ];

    const result = verifyGoldenRecords(tenders, golden);
    assert.deepEqual(result, { checked: 1, matched: 1, mismatches: [] });
  });

  it("reports plain-English mismatches when golden fields change", () => {
    const tenders = [makeTender({ id: "T-1", title: "B", buyerName: null })];
    const golden: GoldenRecord[] = [
      { id: "T-1", fields: { title: "A", buyerName: "City of Example" } },
    ];

    const result = verifyGoldenRecords(tenders, golden);
    assert.equal(result.checked, 1);
    assert.equal(result.matched, 0);
    assert.deepEqual(result.mismatches, [
      'Golden tender "T-1" field title changed from "A" to "B".',
      'Golden tender "T-1" field buyerName changed from "City of Example" to null.',
    ]);
  });
});

describe("evaluateRead", () => {
  it("returns healthy for a valid read", () => {
    const tenders = [
      makeTender({ id: "T-1", cpvCodes: ["45000000", "45233141"] }),
      makeTender({ id: "T-2", url: "https://portal.example.org/tenders/T-2" }),
    ];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline({ lastGoodCount: 2 }));

    assert.equal(verdict.kind, "healthy");
    assert.ok(verdict.checks.every((c) => c.ok));
  });

  it("treats an empty list with emptyStateText as a healthy empty day", () => {
    const read = makeOkRead([], { emptyStateText: "No open tenders today" });
    const verdict = evaluateRead(read, makeBaseline({ lastGoodCount: 15 }));

    assert.equal(verdict.kind, "healthy");
    const countCheck = verdict.checks.find((c) => c.name === "item-count");
    assert.equal(countCheck?.ok, true);
    assert.match(countCheck?.detail ?? "", /Portal says: "No open tenders today"/);
  });

  it("marks an empty list without emptyStateText as broken", () => {
    const verdict = evaluateRead(makeOkRead([]), makeBaseline());

    assert.equal(verdict.kind, "broken");
    const countCheck = verdict.checks.find((c) => c.name === "item-count");
    assert.equal(countCheck?.ok, false);
    assert.equal(countCheck?.detail, "No tenders found on the list.");
  });

  it("detects a count drop below 50% of baseline", () => {
    const tenders = [makeTender({ id: "T-1" }), makeTender({ id: "T-2" })];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline({ lastGoodCount: 10 }));

    assert.equal(verdict.kind, "broken");
    const dropCheck = verdict.checks.find((c) => c.name === "count-drop");
    assert.equal(dropCheck?.ok, false);
  });

  it("detects 0% fill on a required field", () => {
    const tenders = [
      makeTender({ id: "T-1", title: null }),
      makeTender({ id: "T-2", title: null }),
    ];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline());

    assert.equal(verdict.kind, "broken");
    const titleCheck = verdict.checks.find((c) => c.name === "field-fill:title");
    assert.equal(titleCheck?.ok, false);
    assert.equal(titleCheck?.detail, "No tender has a title.");
  });

  it("detects silent partial breakage when baseline field fill collapses", () => {
    const tenders = [
      makeTender({ id: "T-1", buyerName: "City A" }),
      makeTender({ id: "T-2", buyerName: null }),
      makeTender({ id: "T-3", buyerName: null }),
      makeTender({ id: "T-4", buyerName: null }),
      makeTender({ id: "T-5", buyerName: null }),
    ];
    const baseline = makeBaseline({
      lastGoodFieldFill: {
        buyerName: { filled: 5, total: 5 },
      },
    });
    const verdict = evaluateRead(makeOkRead(tenders), baseline);

    assert.equal(verdict.kind, "broken");
    const buyerCheck = verdict.checks.find((c) => c.name === "field-fill:buyerName");
    assert.equal(buyerCheck?.ok, false);
    assert.match(buyerCheck?.detail ?? "", /dropped from 100% to 20%/);
  });

  it("fails on duplicate or blank tender IDs", () => {
    const tenders = [
      makeTender({ id: "T-1" }),
      makeTender({ id: "T-1" }),
      makeTender({ id: "   " }),
    ];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline());

    assert.equal(verdict.kind, "broken");
    const idCheck = verdict.checks.find((c) => c.name === "unique-ids");
    assert.equal(idCheck?.ok, false);
  });

  it("fails on invalid tender or document URLs", () => {
    const tenders = [
      makeTender({ id: "T-1", url: "/relative/path" }),
      makeTender({
        id: "T-2",
        documentRefs: [{ url: "javascript:void(0)", via: "http" }],
      }),
    ];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline());

    assert.equal(verdict.kind, "broken");
    const urlCheck = verdict.checks.find((c) => c.name === "valid-urls");
    assert.equal(urlCheck?.ok, false);
  });

  it("fails on invalid calendar dates or deadlines missing offset", () => {
    const badCalendar = makeTender({ id: "T-1", publicationDate: "2026-02-30" });
    const badOffset = makeTender({ id: "T-2", submissionDeadline: "2026-12-01T12:00:00Z" });

    const verdict1 = evaluateRead(makeOkRead([badCalendar]), makeBaseline());
    assert.equal(verdict1.kind, "broken");
    assert.equal(verdict1.checks.find((c) => c.name === "dates")?.ok, false);

    const verdict2 = evaluateRead(makeOkRead([badOffset]), makeBaseline());
    assert.equal(verdict2.kind, "broken");
    assert.equal(verdict2.checks.find((c) => c.name === "dates")?.ok, false);
  });

  it("fails when submissionDeadline is earlier than publicationDate", () => {
    const tenders = [
      makeTender({
        id: "T-1",
        publicationDate: "2026-11-20",
        submissionDeadline: "2026-11-19T23:59:00+01:00",
      }),
    ];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline());

    assert.equal(verdict.kind, "broken");
    const orderCheck = verdict.checks.find((c) => c.name === "deadline-order");
    assert.equal(orderCheck?.ok, false);
  });

  it("fails on CPV codes with a check digit", () => {
    const tenders = [makeTender({ id: "T-1", cpvCodes: ["45000000-7"] })];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline());

    assert.equal(verdict.kind, "broken");
    const cpvCheck = verdict.checks.find((c) => c.name === "cpv-codes");
    assert.equal(cpvCheck?.ok, false);
    assert.match(cpvCheck?.detail ?? "", /45000000-7/);
  });

  it("passes golden-records check when known tenders match", () => {
    const tenders = [makeTender({ id: "T-1", title: "Road maintenance 2026" })];
    const baseline = makeBaseline({
      golden: [{ id: "T-1", fields: { title: "Road maintenance 2026" } }],
    });
    const verdict = evaluateRead(makeOkRead(tenders), baseline);

    assert.equal(verdict.kind, "healthy");
    const goldenCheck = verdict.checks.find((c) => c.name === "golden-records");
    assert.equal(goldenCheck?.ok, true);
    assert.equal(goldenCheck?.detail, "1 of 1 known tenders match.");
  });

  it("fails golden-records check when a known tender field changes", () => {
    const tenders = [makeTender({ id: "T-1", title: "Wrong selector text" })];
    const baseline = makeBaseline({
      golden: [{ id: "T-1", fields: { title: "Road maintenance 2026" } }],
    });
    const verdict = evaluateRead(makeOkRead(tenders), baseline);

    assert.equal(verdict.kind, "broken");
    const goldenCheck = verdict.checks.find((c) => c.name === "golden-records");
    assert.equal(goldenCheck?.ok, false);
    assert.match(goldenCheck?.detail ?? "", /Golden tender "T-1" field title changed/);
  });

  it("emits skeleton-drift as an early warning without marking read broken", () => {
    const read = makeOkRead([makeTender()], { listSkeletonHash: "hash-new" });
    const baseline = makeBaseline({ lastGoodSkeletonHash: "hash-old" });
    const verdict = evaluateRead(read, baseline);

    assert.equal(verdict.kind, "healthy");
    const driftCheck = verdict.checks.find((c) => c.name === "skeleton-drift");
    assert.equal(driftCheck?.ok, true);
    assert.equal(driftCheck?.detail, "List page structure changed (early warning).");
  });

  it("maps blocked, unreachable, and error outcomes directly", () => {
    const baseline = makeBaseline();

    assert.deepEqual(
      evaluateRead({ kind: "blocked", reason: "CAPTCHA detected" }, baseline),
      { kind: "blocked", reason: "CAPTCHA detected" },
    );

    assert.deepEqual(
      evaluateRead({ kind: "unreachable", reason: "503 Service Unavailable", httpStatus: 503 }, baseline),
      { kind: "unreachable", reason: "503 Service Unavailable" },
    );

    assert.deepEqual(
      evaluateRead({ kind: "error", reason: "Selector timed out" }, baseline),
      { kind: "broken", reason: "Selector timed out", checks: [] },
    );
  });

  it("allows nullable required fields on first read when portal omits them", () => {
    const tenders = [
      makeTender({ id: "T-1", buyerName: null, publicationDate: null, submissionDeadline: null }),
      makeTender({ id: "T-2", buyerName: null, publicationDate: null, submissionDeadline: null }),
    ];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline());

    assert.equal(verdict.kind, "healthy");
    const pubCheck = verdict.checks.find((c) => c.name === "field-fill:publicationDate");
    assert.equal(pubCheck?.ok, true);
    assert.match(pubCheck?.detail ?? "", /not shown by portal/);
  });

  it("fails when a previously populated nullable field drops to 0%", () => {
    const tenders = [
      makeTender({ id: "T-1", publicationDate: null }),
      makeTender({ id: "T-2", publicationDate: null }),
    ];
    const baseline = makeBaseline({
      lastGoodFieldFill: {
        publicationDate: { filled: 5, total: 5 },
      },
    });
    const verdict = evaluateRead(makeOkRead(tenders), baseline);

    assert.equal(verdict.kind, "broken");
    const pubCheck = verdict.checks.find((c) => c.name === "field-fill:publicationDate");
    assert.equal(pubCheck?.ok, false);
    assert.equal(pubCheck?.detail, "No tender has a publicationDate.");
  });

  it("ignores count drops when baseline had fewer than 6 tenders", () => {
    const tenders = [makeTender({ id: "T-1" }), makeTender({ id: "T-2" })];
    const verdict = evaluateRead(makeOkRead(tenders), makeBaseline({ lastGoodCount: 5 }));

    assert.equal(verdict.kind, "healthy");
    assert.equal(verdict.checks.find((c) => c.name === "count-drop"), undefined);
  });

  it("detects golden ID-format drift when same title or URL appears under a different ID", () => {
    const tenders = [
      makeTender({
        id: "https://portal.example.org/tenders/T-1",
        url: "https://portal.example.org/tenders/T-1",
        title: "Road maintenance 2026",
      }),
    ];
    const baseline = makeBaseline({
      golden: [
        {
          id: "T-1",
          fields: {
            url: "https://portal.example.org/tenders/T-1",
            title: "Road maintenance 2026",
          },
        },
      ],
    });

    const drift = verifyGoldenRecords(tenders, baseline.golden);
    assert.equal(drift.checked, 1);
    assert.equal(drift.matched, 0);
    assert.match(drift.mismatches[0] ?? "", /appears under a changed ID/);

    const verdict = evaluateRead(makeOkRead(tenders), baseline);
    assert.equal(verdict.kind, "broken");
    assert.equal(verdict.checks.find((c) => c.name === "golden-records")?.ok, false);
  });
});
