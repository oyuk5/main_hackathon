import { test } from "node:test";
import assert from "node:assert/strict";
import { modelBudget, planDocuments, type PlanItem } from "./budget.js";

test("model budget blocks spent portal limits and reserves shared daily headroom", () => {
  const reserve = modelBudget();
  const day = "2026-11-21";
  const limits = { portal: 1, day: 20 };
  assert.throws(() => reserve("p", day, 0, { portal: 1, day: 1 }, limits), /\$1\.00 of \$1\.00/);
  const release = reserve("p", day, 0.7, { portal: 0, day: 19 }, limits);
  assert.throws(() => reserve("q", day, 0.4, { portal: 0, day: 19 }, limits), /Daily model budget/);
  release();
  reserve("q", day, 0.4, { portal: 0, day: 19 }, limits)();
});

const item = (id: string, need: PlanItem["need"], refs = 2, open = true, publicationDate: string | null = "2026-11-20"): PlanItem => ({ id, need, refs, open, publicationDate });

test("fetches everything that fits the budget", () => {
  const plan = planDocuments([item("a", "new"), item("b", "new"), item("c", "none")], 10);
  assert.deepEqual([...plan.fetch].sort(), ["a", "b"]);
  assert.equal(plan.pendingNew, 0);
});

test("newest new tenders first, and the rest wait", () => {
  const items = [item("old", "new", 3, true, "2026-01-01"), item("mid", "new", 3, true, "2026-06-01"), item("newest", "new", 3, true, "2026-11-20")];
  const plan = planDocuments(items, 6);
  assert.deepEqual([...plan.fetch].sort(), ["mid", "newest"]);
  assert.equal(plan.pendingNew, 1);
});

test("open tenders before closed ones, retries last", () => {
  const items = [item("retry", "retry", 1), item("closedNew", "new", 1, false), item("changed", "changed", 1), item("openNew", "new", 1)];
  const order = [...planDocuments(items, 3).fetch];
  assert.deepEqual(order, ["openNew", "changed", "closedNew"]);
});

test("a tender with more refs than the budget still gets fetched", () => {
  const plan = planDocuments([item("huge", "new", 50)], 10);
  assert.deepEqual([...plan.fetch], ["huge"]);
});

test("a big tender that does not fit is skipped for smaller ones", () => {
  const plan = planDocuments([item("small1", "new", 2, true, "2026-11-20"), item("big", "new", 20, true, "2026-11-19"), item("small2", "new", 2, true, "2026-11-18")], 5);
  assert.deepEqual([...plan.fetch].sort(), ["small1", "small2"]);
  assert.equal(plan.pendingNew, 1);
});

test("a tender without documents costs nothing, so it is served even when the budget is spent", () => {
  const plan = planDocuments([item("big", "new", 5), item("nodocs", "new", 0, true, "2026-11-01")], 5);
  assert.deepEqual([...plan.fetch].sort(), ["big", "nodocs"]);
  assert.equal(plan.pendingNew, 0);
});

test("a zero-cost tender cannot prevent the first oversized document batch from making progress", () => {
  const plan = planDocuments([item("nodocs", "new", 0), item("large-update", "changed", 12), item("retry", "retry", 1)], 5);
  assert.deepEqual([...plan.fetch], ["nodocs", "large-update"]);
  assert.equal(plan.pendingNew, 0);
  assert.equal(plan.pending, 1);
});
