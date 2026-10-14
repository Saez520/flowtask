import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { classifyOwnership, OWNERSHIP, OWNER_MARKER } from "./ownership.js";

test("ownership classifies absent, external, symlink, and exact V2 marker deterministically", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-owner-"));
  try {
    const plugin = path.join(root, "plugin");
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.ABSENT);
    fs.mkdirSync(plugin);
    fs.writeFileSync(path.join(plugin, "third-party.txt"), "keep");
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.EXTERNAL);
    fs.writeFileSync(path.join(plugin, ".flowtask-plugin-owner.json"), JSON.stringify(OWNER_MARKER));
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.MANAGED_V2);
    fs.rmSync(plugin, { recursive: true });
    fs.symlinkSync(root, plugin);
    assert.equal(classifyOwnership(plugin).state, OWNERSHIP.AMBIGUOUS);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
