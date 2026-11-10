import { execFileSync } from "child_process";

export const MIN_PYTHON_VERSION = "3.9";
export const PYTHON_RUNTIME_PROBE_TIMEOUT_MS = 5000;

const VERSION_PROBE = "import sys; print('%d.%d.%d' % sys.version_info[:3])";
const EXECUTABLE_PROBE = "import sys; print(sys.executable)";

const WINDOWS_CANDIDATES = Object.freeze([
  Object.freeze({ command: "py", prefix: Object.freeze(["-3"]) }),
  Object.freeze({ command: "python3", prefix: Object.freeze([]) }),
  Object.freeze({ command: "python", prefix: Object.freeze([]) }),
]);
const POSIX_CANDIDATES = Object.freeze([
  Object.freeze({ command: "python3", prefix: Object.freeze([]) }),
  Object.freeze({ command: "python", prefix: Object.freeze([]) }),
]);

function compareVersions(left, right) {
  const parse = (value) => String(value).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function lastLine(value) {
  return String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop() ?? "";
}

/**
 * A Windows app execution alias lives under `WindowsApps`. It is only a stub:
 * the Store application may not be installed, and running the alias opens the
 * Store instead of starting an interpreter.
 */
export function isMicrosoftStoreAlias(executable) {
  if (typeof executable !== "string" || executable.length === 0) return false;
  return /[\\/]WindowsApps[\\/]/i.test(executable);
}

function runLocator(locator, args, { timeoutMs, env }) {
  try {
    const stdout = execFileSync(locator, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: env ?? process.env,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** Resolve every executable path a command name stands for on this machine. */
function resolveCommandPaths(command, { platform, timeoutMs, env }) {
  if (platform !== "win32") {
    const all = runLocator("which", ["-a", command], { timeoutMs, env });
    if (all.length > 0) return all;
    return runLocator("which", [command], { timeoutMs, env });
  }
  return runLocator("where", [command], { timeoutMs, env });
}

/**
 * Run one read-only interpreter probe. The probe never writes, never installs
 * and never invokes a shell, so a localized launcher message is data and not a
 * command to execute.
 */
function runProbe(executable, args, { timeoutMs, env }) {
  try {
    const stdout = execFileSync(executable, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: env ?? process.env,
    });
    return { ok: true, stdout };
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    const cause = error?.killed || error?.signal
      ? `probe exceeded ${timeoutMs} ms`
      : (error?.code === "ENOENT"
        ? `${executable} is not available`
        : (lastLine(stderr) || String(error?.message ?? "probe failed").trim()));
    return { ok: false, cause };
  }
}

function describeFailedProbe(executable, result) {
  if (isMicrosoftStoreAlias(executable)) {
    return `${executable} is a Microsoft Store app execution alias, not a usable Python interpreter`;
  }
  return `${executable}: ${result?.cause ?? "the probe failed"}`;
}

/**
 * Resolve a real Python 3.9+ interpreter.
 *
 * The candidates follow the platform convention: the Windows launcher first,
 * then the usual command names. Every path reported by `where`/`which` is
 * probed, so a Store alias or a broken first match never hides a usable
 * interpreter later on PATH.
 */
export function resolvePythonRuntime(options = {}) {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? PYTHON_RUNTIME_PROBE_TIMEOUT_MS;
  const candidates = Array.isArray(options.candidates)
    ? options.candidates
    : (platform === "win32" ? WINDOWS_CANDIDATES : POSIX_CANDIDATES);
  const resolveExecutables = typeof options.resolveExecutables === "function"
    ? options.resolveExecutables
    : (command) => resolveCommandPaths(command, { platform, timeoutMs, env: options.env });
  const probe = typeof options.probe === "function"
    ? options.probe
    : (executable, args) => runProbe(executable, args, { timeoutMs, env: options.env });

  const causes = [];
  for (const candidate of candidates) {
    const command = candidate?.command;
    const prefix = Array.isArray(candidate?.prefix) ? candidate.prefix : [];
    if (typeof command !== "string" || command.length === 0) continue;
    const executables = resolveExecutables(command) ?? [];
    if (executables.length === 0) {
      causes.push(`${command} is not available on PATH`);
      continue;
    }
    for (const executable of executables) {
      const versionResult = probe(executable, [...prefix, "-c", VERSION_PROBE], { timeoutMs });
      if (!versionResult?.ok) {
        causes.push(describeFailedProbe(executable, versionResult));
        continue;
      }
      const version = lastLine(versionResult.stdout);
      if (!/^\d+\.\d+\.\d+$/.test(version)) {
        causes.push(`${executable} did not report a usable Python version`);
        continue;
      }
      if (compareVersions(version, MIN_PYTHON_VERSION) < 0) {
        causes.push(`python ${version} at ${executable} is older than the required ${MIN_PYTHON_VERSION}`);
        continue;
      }
      const executableResult = probe(executable, [...prefix, "-c", EXECUTABLE_PROBE], { timeoutMs });
      const resolvedExecutable = executableResult?.ok
        ? (lastLine(executableResult.stdout) || executable)
        : executable;
      return {
        available: true,
        version,
        executable: resolvedExecutable,
        command,
        prefix: [...prefix],
        cause: null,
      };
    }
  }

  return {
    available: false,
    version: null,
    executable: null,
    command: null,
    prefix: [],
    cause: causes.join("; ") || `no Python ${MIN_PYTHON_VERSION}+ interpreter was found`,
  };
}
