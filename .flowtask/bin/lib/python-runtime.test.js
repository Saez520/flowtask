import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePythonRuntime, isMicrosoftStoreAlias, MIN_PYTHON_VERSION } from "./python-runtime.js";

const fixtures = [];

function mkTmp(prefix = "flowtask-python-runtime-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(dir);
  return dir;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function probeAnswers(answers) {
  return (executable, args) => {
    const key = args.some((arg) => String(arg).includes("version_info")) ? "version" : "executable";
    const answer = answers[executable]?.[key];
    if (!answer) return { ok: false, cause: `fixture has no ${key} answer for ${executable}` };
    return { ok: true, stdout: `${answer}\n` };
  };
}

test("a failing candidate is skipped and the next interpreter answers", () => {
  const calls = [];
  const result = resolvePythonRuntime({
    platform: "linux",
    candidates: [
      { command: "python3", prefix: [] },
      { command: "python", prefix: [] },
    ],
    resolveExecutables: (command) => {
      calls.push(command);
      return command === "python3" ? ["/opt/broken/python3"] : ["/opt/real/python"];
    },
    probe: probeAnswers({
      "/opt/real/python": { version: "3.12.4", executable: "/opt/real/bin/python3.12" },
    }),
  });

  assert.deepEqual(calls, ["python3", "python"]);
  assert.equal(result.available, true);
  assert.equal(result.version, "3.12.4");
  assert.equal(result.executable, "/opt/real/bin/python3.12");
  assert.equal(result.command, "python");
  assert.deepEqual(result.prefix, []);
  assert.equal(result.cause, null);
});

test("the Windows launcher probes with -3 and drops the launcher prefix once the interpreter is resolved", () => {
  const commands = [];
  const probes = [];
  const result = resolvePythonRuntime({
    platform: "win32",
    resolveExecutables: (command) => {
      commands.push(command);
      return [];
    },
    probe: () => ({ ok: false, cause: "unused" }),
  });

  assert.deepEqual(commands, ["py", "python3", "python"]);
  assert.equal(result.available, false);
  assert.match(result.cause, /py is not available/);

  const prefixed = resolvePythonRuntime({
    platform: "win32",
    candidates: [{ command: "py", prefix: ["-3"] }],
    resolveExecutables: () => ["C:\\Windows\\py.exe"],
    probe: (executable, args) => {
      probes.push([executable, ...args]);
      if (args.some((arg) => String(arg).includes("version_info"))) {
        return { ok: true, stdout: "3.11.9\n" };
      }
      return { ok: true, stdout: "C:\\Python311\\python.exe\n" };
    },
  });
  assert.equal(prefixed.available, true);
  assert.deepEqual(prefixed.prefix, [], "the launcher prefix never applies to the resolved interpreter");
  assert.equal(prefixed.executable, "C:\\Python311\\python.exe");
  assert.ok(probes.every(([executable, first]) => executable === "C:\\Windows\\py.exe" && first === "-3"));
});

test("a candidate that cannot report its interpreter path is skipped", () => {
  const result = resolvePythonRuntime({
    platform: "win32",
    candidates: [{ command: "py", prefix: ["-3"] }],
    resolveExecutables: () => ["C:\\Windows\\py.exe"],
    probe: (executable, args) => {
      if (args.some((arg) => String(arg).includes("version_info"))) {
        return { ok: true, stdout: "3.11.9\n" };
      }
      return { ok: false, cause: "the interpreter path probe failed" };
    },
  });

  assert.equal(result.available, false);
  assert.equal(result.executable, null);
  assert.deepEqual(result.prefix, []);
  assert.match(result.cause, /did not report a usable interpreter path/);
  assert.match(result.cause, /the interpreter path probe failed/);
});

test("a Microsoft Store app execution alias is not Python and hides its localized message", () => {
  const localized = "no se encontró Python; ejecutar sin argumentos para instalar desde el Microsoft Store";
  const alias = "C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe";
  assert.equal(isMicrosoftStoreAlias(alias), true);
  assert.equal(isMicrosoftStoreAlias("C:\\Python311\\python.exe"), false);
  assert.equal(isMicrosoftStoreAlias("/usr/bin/python3"), false);

  const result = resolvePythonRuntime({
    platform: "win32",
    candidates: [{ command: "python3", prefix: [] }],
    resolveExecutables: () => [alias],
    probe: () => ({ ok: false, cause: localized }),
  });

  assert.equal(result.available, false);
  assert.match(result.cause, /Microsoft Store app execution alias/);
  assert.equal(result.cause.includes("no se encontró"), false);
});

test("a Python older than the floor is rejected with the version in the cause", () => {
  const result = resolvePythonRuntime({
    platform: "linux",
    candidates: [{ command: "python3", prefix: [] }],
    resolveExecutables: () => ["/usr/bin/python3"],
    probe: probeAnswers({
      "/usr/bin/python3": { version: "3.8.10", executable: "/usr/bin/python3" },
    }),
  });

  assert.equal(result.available, false);
  assert.match(result.cause, new RegExp(`older than the required ${MIN_PYTHON_VERSION.replace(".", "\\.")}`));
  assert.match(result.cause, /3\.8\.10/);
});

test("an unusable interpreter reports a clear cause when no candidate answers", () => {
  const result = resolvePythonRuntime({
    platform: "linux",
    candidates: [
      { command: "python3", prefix: [] },
      { command: "python", prefix: [] },
    ],
    resolveExecutables: (command) => (command === "python3" ? ["/opt/python3"] : []),
    probe: () => ({ ok: false, cause: "fixture probe rejected the interpreter" }),
  });

  assert.equal(result.available, false);
  assert.equal(result.version, null);
  assert.equal(result.executable, null);
  assert.match(result.cause, /fixture probe rejected the interpreter/);
  assert.match(result.cause, /python is not available on PATH/);
});

test("a fake python3 earlier on PATH is skipped and a later real interpreter is used", { skip: process.platform === "win32" }, () => {
  const root = mkTmp();
  const fakeBin = path.join(root, "fake-bin");
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakePython = path.join(fakeBin, "python3");
  fs.writeFileSync(
    fakePython,
    "#!/bin/sh\necho 'no se encontró Python; ejecutar sin argumentos para instalar desde el Microsoft Store' >&2\nexit 1\n",
    { mode: 0o755 },
  );

  const result = resolvePythonRuntime({
    platform: process.platform,
    env: { ...process.env, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}` },
  });

  assert.equal(result.available, true);
  assert.notEqual(result.executable, fakePython);
  assert.ok(result.executable);
  assert.ok(result.version);
});
