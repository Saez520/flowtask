import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { applyOpencodeGlobalSurface, removeOpencodeGlobalSurface } from "./opencode-global.js";

const RUNTIME_MANIFEST = Object.freeze({
  payloads: { canonical: { payloadId: "1.0.0-test" } },
});

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-opencode-global-"));
  const flowtaskDir = path.join(root, "source");
  const runtimeRoot = path.join(root, "config", "flowtask");
  writeJson(path.join(flowtaskDir, "opencode.json"), {});
  return { root, flowtaskDir, runtimeRoot };
}

function apply(config, { flowtaskDir, runtimeRoot }) {
  return applyOpencodeGlobalSurface(config, {
    flowtaskDir,
    runtimeManifest: RUNTIME_MANIFEST,
    runtimeRoot,
    commandSource: { agents: {}, commands: {} },
  });
}

test("the global surface registers the gate by npm spec and keeps the checkpoint local", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const foreign = { package: "third-party-plugin", options: { keep: true } };
    const oldGate = {
      package: path.join(runtimeRoot, "plugins", "flowtask-permission-gate"),
      options: { configDir: path.join(runtimeRoot, "config"), runtimeRoot },
    };
    const result = apply({ plugins: [oldGate, foreign, "user-plugin"] }, { flowtaskDir, runtimeRoot });

    assert.deepEqual(result.config.plugins, [
      foreign,
      "user-plugin",
      {
        package: "flowtask-permission-gate@^2.0.0",
        options: { configDir: path.join(runtimeRoot, "config"), runtimeRoot },
      },
      {
        package: path.join(runtimeRoot, "plugins", "flowtask-context-checkpoint"),
        options: { runtimeRoot },
      },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("applying the global surface twice is idempotent and preserves foreign entries", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  try {
    const foreign = { package: "third-party-plugin", options: { keep: true } };
    const first = apply({ plugins: [foreign] }, { flowtaskDir, runtimeRoot });
    const second = apply(first.config, { flowtaskDir, runtimeRoot });

    assert.deepEqual(second.config, first.config);
    assert.equal(second.config.plugins.filter((entry) => entry?.package === "flowtask-permission-gate@^2.0.0").length, 1);
    assert.ok(second.config.plugins.includes(foreign));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("removing the global surface drops the npm gate and the local checkpoint only", () => {
  const { root, flowtaskDir, runtimeRoot } = createFixture();
  const previousXdg = process.env.XDG_CONFIG_HOME;
  const xdg = path.join(root, "xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    const foreign = { package: "third-party-plugin", options: { keep: true } };
    const configPath = path.join(xdg, "opencode", "opencode.json");
    writeJson(configPath, {
      plugins: [
        { package: "flowtask-permission-gate@^2.0.0", options: { runtimeRoot } },
        foreign,
        {
          package: path.join(runtimeRoot, "plugins", "flowtask-context-checkpoint"),
          options: { runtimeRoot },
        },
      ],
    });

    const result = removeOpencodeGlobalSurface({
      flowtaskDir,
      runtimeRoot,
      commandSource: { agents: {}, commands: {} },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(readJson(configPath).plugins, [foreign]);
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
