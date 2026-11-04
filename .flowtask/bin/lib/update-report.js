import fs from "fs";
import path from "path";
import { setLogSink } from "./logger.js";

const PHASE_LABEL_WIDTH = 10;
const SYNC_TARGET_WIDTH = 11;
const SYNC_CONTINUATION = " ".repeat(2 + PHASE_LABEL_WIDTH + 1);
const WARNING_PREFIX = /^⚠️?\s*/;
const ACTION_PATTERN = /flowtask (update|install)|https?:\/\//i;
const ACTION_SUFFIX = " · run flowtask update --verbose for details";
const SEARCH_PHASE_TEXT = {
  configured: "already configured",
  installed: "installed",
  declined: "declined",
  skipped: "deferred (no TTY)",
  unsupported: "unsupported",
  failed: "failed",
};
const QUERY_RANK = { success: 0, skipped: 1, pending: 1, degraded: 2, failed: 3 };
const QUERY_TEXT = ["mcp verified", "mcp skipped", "mcp degraded", "mcp failed"];

export function readProjectVersion(flowtaskDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(flowtaskDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export function formatDuration(ms) {
  const elapsed = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`;
  const totalSeconds = Math.floor(elapsed / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

export function describeGraphifyPhase(states) {
  if (!Array.isArray(states) || states.length === 0) return null;
  const valid = states.filter((state) => state && state.broken !== true && state.projectState);
  if (valid.length === 0) return "failed";
  const enabled = valid.filter(({ projectState }) => projectState.enabled === true);
  if (enabled.length === 0) return "disabled";
  const extractStatuses = enabled.map(({ projectState }) => projectState.extract_status);
  const graph = extractStatuses.includes("success")
    ? "graph rebuilt"
    : `graph ${extractStatuses.find((status) => status !== "success") ?? "failed"}`;
  const worstQuery = enabled.reduce((worst, { projectState }) => {
    const rank = QUERY_RANK[projectState.query_status] ?? QUERY_RANK.skipped;
    return Math.max(worst, rank);
  }, 0);
  return `${graph} · ${QUERY_TEXT[worstQuery]}`;
}

export function describeSearchPhase(result) {
  if (!result) return null;
  return SEARCH_PHASE_TEXT[result.status] ?? "failed";
}

export function createUpdateReport({ version, verbose = false } = {}) {
  const warnings = [];
  const errors = [];
  const seenWarnings = new Set();
  const seenErrors = new Set();
  const syncRows = [];
  let failures = 0;
  let finished = false;
  let disposed = false;
  let startedAt = Date.now();

  const remember = (list, seen, text) => {
    if (seen.has(text)) return;
    seen.add(text);
    list.push(text);
  };

  const sink = (entry) => {
    if (!entry || typeof entry.message !== "string") return;
    if (entry.kind === "warn") {
      remember(warnings, seenWarnings, entry.message.replace(WARNING_PREFIX, ""));
    } else if (entry.kind === "error") {
      remember(errors, seenErrors, entry.message);
    }
  };

  const print = (line) => {
    console.log(line);
  };

  const withAction = (text) => (ACTION_PATTERN.test(text) ? text : `${text}${ACTION_SUFFIX}`);

  return {
    verbose,
    begin() {
      startedAt = Date.now();
      if (verbose) {
        print(`FlowTask update · ${version}`);
        return;
      }
      setLogSink(sink);
      print(`FlowTask update · ${version}`);
      print("");
    },
    phase(label, value) {
      if (verbose) return;
      print(`  ${label.padEnd(PHASE_LABEL_WIDTH)} ${value}`);
    },
    syncRow(target, text, { failed = false } = {}) {
      if (verbose) return;
      syncRows.push({ target, text });
      if (failed) failures += 1;
    },
    endSync() {
      if (verbose || syncRows.length === 0) return;
      syncRows.forEach((row, index) => {
        const prefix = index === 0 ? `  ${"sync".padEnd(PHASE_LABEL_WIDTH)} ` : SYNC_CONTINUATION;
        print(`${prefix}${row.target.padEnd(SYNC_TARGET_WIDTH)}${row.text}`);
      });
    },
    markFailure() {
      failures += 1;
    },
    finish() {
      if (verbose || finished) return;
      finished = true;
      if (warnings.length > 0 || errors.length > 0) print("");
      if (warnings.length > 0) {
        print(`  warnings (${warnings.length})`);
        for (const warning of warnings) print(`    ⚠ ${withAction(warning)}`);
      }
      if (errors.length > 0) {
        print(`  errors (${errors.length})`);
        for (const error of errors) print(`    ✗ ${withAction(error)}`);
      }
      print("");
      const segments = [syncRows.length === 1 ? "1 target" : `${syncRows.length} targets`];
      if (failures > 0) segments.push(`${failures} failed`);
      segments.push(warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`);
      segments.push(formatDuration(Date.now() - startedAt));
      const glyph = failures > 0 || errors.length > 0 ? "✗" : "✓";
      print(`  ${glyph} ${segments.join(" · ")}`);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setLogSink(null);
    },
  };
}
