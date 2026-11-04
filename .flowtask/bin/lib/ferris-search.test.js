import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ensureGlobalFerrisSearch } from "./ferris-search.js";
import { mergeOpencodeConfig } from "./opencode.js";

const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fs.rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowtask-ferris-search-"));
  fixtures.push(root);
  return {
    root,
    homeDir: path.join(root, "home"),
    flowtaskDir: path.join(root, "flowtask"),
  };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/*
 * gap_ref: C4
 * criterio: con búsqueda global ausente, con o sin copia local, al aceptar
 *   queda creada en global, sin copia local y con informe.
 * defecto: un install/update que cree la copia local en lugar de la global
 *   pasaría inadvertido.
 * why_not_detected: no había prueba del camino global ni de la oferta; el
 *   merge existente no menciona ferris-search.
 * comportamiento observable: la aceptación crea una única entrada global,
 *   copia el binario, retira la copia local del target y una segunda invocación
 *   devuelve configured sin volver a preguntar.
 */
test("accepting installs web search once per user and leaves no project-local copy", async () => {
  const { root, homeDir, flowtaskDir } = fixture();
  const sourceBinary = path.join(flowtaskDir, "bin", "ferris-search-darwin-arm64");
  fs.mkdirSync(path.dirname(sourceBinary), { recursive: true });
  fs.writeFileSync(sourceBinary, "#!/bin/sh\necho ferris-search\n", { mode: 0o755 });

  const globalConfigPath = path.join(homeDir, ".config", "opencode", "opencode.json");
  writeJson(globalConfigPath, {
    $schema: "https://opencode.ai/config.json",
    theme: "system",
    mcp: { external: { type: "local", command: ["external"] } },
  });

  writeJson(path.join(flowtaskDir, "opencode.json"), {
    mcp: { engram: { type: "local", command: ["engram", "mcp"] } },
  });

  const prompts = [];
  const readline = {
    createInterface() {
      return {
        question(text, callback) {
          prompts.push(text);
          callback("y");
        },
        close() {},
      };
    },
  };

  const first = await ensureGlobalFerrisSearch({
    flowtaskDir,
    readline,
    homeDir,
    platform: "darwin",
    arch: "arm64",
    isTTY: true,
  });

  assert.equal(first.status, "installed");
  assert.equal(first.globalConfigPath, globalConfigPath);
  assert.equal(first.binaryInstalled, true);
  assert.equal(prompts.length, 1);

  const global = readJson(globalConfigPath);
  assert.equal(global.theme, "system");
  assert.deepEqual(global.mcp.external, { type: "local", command: ["external"] });
  assert.deepEqual(global.mcp["ferris-search"], {
    type: "local",
    command: ["ferris-search"],
    env: { DEFAULT_SEARCH_ENGINE: "bing" },
    enabled: true,
  });
  assert.equal(global.$schema, "https://opencode.ai/config.json");

  const destinationBinary = path.join(homeDir, ".opencode", "bin", "ferris-search");
  assert.equal(fs.readFileSync(destinationBinary, "utf8"), fs.readFileSync(sourceBinary, "utf8"));
  assert.equal(fs.statSync(destinationBinary).mode & 0o111, 0o111);

  const targetWithLocal = path.join(root, "project-a", ".opencode", "opencode.json");
  writeJson(targetWithLocal, {
    mcp: {
      external: { enabled: true },
      "ferris-search": { type: "local", command: ["ferris-search"] },
    },
  });
  const removed = mergeOpencodeConfig(targetWithLocal, flowtaskDir, ".opencode");
  assert.equal(removed.ok, true);
  assert.equal(removed.removedFerrisSearch, true);
  const targetConfig = readJson(targetWithLocal);
  assert.equal(Object.hasOwn(targetConfig.mcp, "ferris-search"), false);
  assert.deepEqual(targetConfig.mcp.external, { enabled: true });

  const cleanTarget = path.join(root, "project-b", ".opencode", "opencode.json");
  writeJson(cleanTarget, { mcp: { external: { enabled: true } } });
  const clean = mergeOpencodeConfig(cleanTarget, flowtaskDir, ".opencode");
  assert.equal(clean.ok, true);
  assert.equal(clean.removedFerrisSearch, false);
  assert.equal(Object.hasOwn(readJson(cleanTarget).mcp, "ferris-search"), false);

  assert.deepEqual(readJson(globalConfigPath), global);

  const second = await ensureGlobalFerrisSearch({
    flowtaskDir,
    readline,
    homeDir,
    platform: "darwin",
    arch: "arm64",
    isTTY: true,
  });
  assert.equal(second.status, "configured");
  assert.equal(second.binaryInstalled, false);
  assert.equal(prompts.length, 1);
});
