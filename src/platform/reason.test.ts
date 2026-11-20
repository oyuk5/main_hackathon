import { test } from "node:test";
import assert from "node:assert/strict";
import { count, join, labelled, sentence } from "./reason.js";

test("sentence keeps one clean line with a full stop", () => {
  assert.equal(sentence("  HTTP 503 from portal  \n    at fetch (node:internal)"), "HTTP 503 from portal.");
  assert.equal(sentence("Already done!"), "Already done!");
  assert.equal(sentence(""), "");
});

test("sentence caps long text on a word boundary", () => {
  const s = sentence("word ".repeat(100), 40);
  assert.ok(s.length <= 40 && s.endsWith("…"), s);
});

test("labelled does not double a label the reason already has", () => {
  assert.equal(labelled("Blocked", "Blocked by a captcha on the list page"), "Blocked by a captcha on the list page.");
  assert.equal(labelled("Blocked", "Tender documents need a login."), "Blocked: Tender documents need a login.");
  assert.equal(labelled("Portal not reachable", "Portal not reachable: HTTP 503."), "Portal not reachable: HTTP 503.");
});

test("join builds sentences without run-ons or empty parts", () => {
  assert.equal(join("Could not repair: no tender has a title", "", "A person is needed"), "Could not repair: no tender has a title. A person is needed.");
});

test("count pluralises", () => {
  assert.equal(count(1, "open tender"), "1 open tender");
  assert.equal(count(23, "open tender"), "23 open tenders");
});
