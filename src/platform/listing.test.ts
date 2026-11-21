import { test } from "node:test";
import assert from "node:assert/strict";
import { mayClose, sawWholeList } from "./listing.js";

const toEpoch = (iso: string) => Date.parse(iso);
const now = Date.parse("2026-11-20T18:00:00+01:00");

test("a single-page list or a read below the page cap saw the whole list", () => {
  assert.equal(sawWholeList({ type: "none" }, 1, false), true);
  assert.equal(sawWholeList({ type: "pageParam", start: 0, maxPages: 40 }, 30, false), true);
});

test("a read that hit the page cap or was aborted did not see the whole list", () => {
  assert.equal(sawWholeList({ type: "pageParam", start: 0, maxPages: 40 }, 40, false), false);
  assert.equal(sawWholeList({ type: "none" }, 1, true), false);
});

test("a missing tender is closed after a full read, or when its deadline passed", () => {
  assert.equal(mayClose({ wholeList: true, submissionDeadline: null, now, toEpoch }), true);
  assert.equal(mayClose({ wholeList: false, submissionDeadline: "2026-11-19T12:00:00+01:00", now, toEpoch }), true);
});

test("a missing tender stays open after a partial read when its deadline is ahead or unknown", () => {
  assert.equal(mayClose({ wholeList: false, submissionDeadline: "2029-01-01T12:00:00+01:00", now, toEpoch }), false);
  assert.equal(mayClose({ wholeList: false, submissionDeadline: null, now, toEpoch }), false);
});

test("a missing tender older than everything a full read saw stays open: the list may be a window", () => {
  const base = { wholeList: true, submissionDeadline: "2029-01-01T12:00:00+01:00", now, toEpoch, oldestSeen: "2026-11-13" };
  assert.equal(mayClose({ ...base, publicationDate: "2026-11-06" }), false);
  assert.equal(mayClose({ ...base, publicationDate: "2026-11-13" }), true);
  assert.equal(mayClose({ ...base, publicationDate: null }), true);
  assert.equal(mayClose({ ...base, publicationDate: "2026-11-06", submissionDeadline: "2026-11-19T12:00:00+01:00" }), true, "a passed deadline still closes it");
});

test("a recipe asking for more than 200 pages is capped at 200: a read that reached 200 did not see the whole list", () => {
  assert.equal(sawWholeList({ type: "pageParam", start: 1, maxPages: 500 }, 200, false), false);
  assert.equal(sawWholeList({ type: "pageParam", start: 1, maxPages: 500 }, 199, false), true);
});
