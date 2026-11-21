import { test } from "node:test";
import assert from "node:assert/strict";
import { installCrashGuard } from "./crashguard.js";

test("an uncaught error or rejection is logged and the process keeps running", async () => {
  const logs: string[] = [];
  const uninstall = installCrashGuard((m) => logs.push(m));
  try {
    // Call the installed listeners directly: node:test fails a test on a real uncaughtException event.
    const onException = process.listeners("uncaughtException").at(-1) as (e: unknown) => void;
    const onRejection = process.listeners("unhandledRejection").at(-1) as (e: unknown) => void;
    onException(new Error("assert(!this.paused)"));
    onRejection(new Error("late socket error"));
    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /Uncaught error, server keeps running: Error: assert\(!this\.paused\)/);
    assert.match(logs[1]!, /Unhandled rejection, server keeps running: Error: late socket error/);
  } finally {
    uninstall();
  }
  assert.equal(process.listeners("uncaughtException").some((l) => l.toString().includes("server keeps running")), false);
});
