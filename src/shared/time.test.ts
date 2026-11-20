import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWithOffset, localWallTime } from "./time.js";

test("formats winter time in Berlin with +01:00", () => {
  assert.equal(formatWithOffset(new Date("2026-12-09T09:00:00Z"), "Europe/Berlin"), "2026-12-09T10:00:00+01:00");
});

test("formats summer time in Berlin with +02:00", () => {
  assert.equal(formatWithOffset(new Date("2026-07-01T08:00:00Z"), "Europe/Berlin"), "2026-07-01T10:00:00+02:00");
});

test("local wall time in Lisbon and Warsaw", () => {
  assert.equal(localWallTime("2026-12-09", "10:00", "Europe/Lisbon"), "2026-12-09T10:00:00+00:00");
  assert.equal(localWallTime("2026-07-01", "12:00", "Europe/Warsaw"), "2026-07-01T12:00:00+02:00");
});
