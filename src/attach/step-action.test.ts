import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { CartographerStep, stepAction } from "./cartographer.js";

const parse = (o: unknown) => CartographerStep.parse(o);

test("an unknown action name counts when the answer carries a recipe or an address, else it is malformed", () => {
  assert.equal(stepAction(parse({ action: "recipe" })), "recipe");
  assert.equal(stepAction(parse({ action: "give_up", reason: "login" })), "give_up");
  const recipe = {
    schemaVersion: 1, tier: "html", timeZone: "Europe/Berlin",
    list: { request: { url: "https://x.example/list" }, pagination: { type: "none" }, item: "tr" },
    listFields: { id: { css: "td" } },
  };
  assert.equal(stepAction(parse({ action: "update_recipe", recipe })), "recipe");
  assert.equal(stepAction(parse({ action: "go", navigateTo: "https://x.example/list" })), "navigate");
  assert.equal(stepAction(parse({ action: "fix" })), null);
});

test("the step schema still converts to JSON Schema for the model request", () => {
  const schema = JSON.stringify(z.toJSONSchema(CartographerStep));
  for (const a of ["recipe", "navigate", "give_up"]) assert.ok(schema.includes(`"${a}"`), a);
});
