import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReadOutcome } from "../shared/modules.js";
import { holdBackImpossibleTenders } from "./orchestrator.js";

function read(n: number, badIds: string[]): ReadOutcome {
  const tenders = Array.from({ length: n }, (_, i) => {
    const id = `t${i}`;
    return { id, publicationDate: "2026-11-10", submissionDeadline: badIds.includes(id) ? "2026-11-01T12:00:00+01:00" : "2026-12-01T12:00:00+01:00" };
  });
  return { kind: "ok", tenders, diagnostics: {} } as unknown as ReadOutcome;
}

test("one tender with a deadline before its publication date is held back, the rest go through", () => {
  const { read: out, heldBack } = holdBackImpossibleTenders(read(20, ["t3"]));
  assert.deepEqual([...heldBack], ["t3"]);
  assert.equal(out.kind === "ok" && out.tenders.length, 19);
});

test("many bad tenders mean a broken rule: nothing is held back, so Watch sends the read to repair", () => {
  const { read: out, heldBack } = holdBackImpossibleTenders(read(20, ["t1", "t2", "t3"]));
  assert.equal(heldBack.size, 0);
  assert.equal(out.kind === "ok" && out.tenders.length, 20);
  assert.equal(holdBackImpossibleTenders(read(1, ["t0"])).heldBack.size, 0);
});

test("a clean read is unchanged", () => {
  const r = read(5, []);
  const { read: out, heldBack } = holdBackImpossibleTenders(r);
  assert.equal(heldBack.size, 0);
  assert.equal(out, r);
});
