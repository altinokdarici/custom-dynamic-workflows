import assert from "node:assert/strict";
import { test } from "node:test";
import { runCheck } from "../src/check.ts";

test("checks run with CI=true and keep the rest of the environment", async () => {
  process.env.CDW_CHECK_PROBE = "kept";
  const result = await runCheck('test "$CI" = true && test "$CDW_CHECK_PROBE" = kept', process.cwd());
  delete process.env.CDW_CHECK_PROBE;
  assert.equal(result.ok, true, result.output);
});
