import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { toPosixPath } from "./submodule-publication.js";

test("toPosixPath normalizes Windows separators to POSIX", () => {
  assert.equal(toPosixPath("a\\b\\c", "\\"), "a/b/c");
});

test("toPosixPath preserves already POSIX relative paths", () => {
  assert.equal(toPosixPath(".flowtask/plugins/x"), ".flowtask/plugins/x");
});

test("toPosixPath normalizes mixed separators when given an explicit separator", () => {
  assert.equal(toPosixPath("a/b\\c", "\\"), "a/b/c");
});

test("toPosixPath is idempotent when reapplied", () => {
  const once = toPosixPath("a\\b", "\\");
  assert.equal(once, "a/b");
  assert.equal(toPosixPath(once, "\\"), "a/b");
});

test("toPosixPath defaults to the platform separator", () => {
  assert.equal(toPosixPath(`a${path.sep}b`), "a/b");
});
