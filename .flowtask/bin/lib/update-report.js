import fs from "fs";
import path from "path";
import { setLogSink } from "./logger.js";

const FRAME_WIDTH = 68;
const INNER_WIDTH = 66;
const LEFT_MARGIN = 2;
const RIGHT_MARGIN = 1;
const COL_PHASE = 11;
const COL_DETAIL = 38;
const COL_TIME = 6;
const COL_STATE = 5;
const COL_GAP = 1;
const SYNC_TARGET_WIDTH = 11;
const WARNING_WRAP_WIDTH = 61;
const WARNING_PREFIX = /^⚠️?\s*/;
const ACTION_PATTERN = /flowtask (update|install)|https?:\/\//i;
const ACTION_SUFFIX = " · run flowtask update --verbose for details";
const STATE_GLYPHS = { ok: "✓", warn: "!", fail: "✗" };
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

function truncateTo(text, width) {
  const value = String(text ?? "");
  if (width <= 0) return "";
  if (value.length <= width) return value;
  return `${value.slice(0, width - 1)}…`;
}

function padRight(text, width) {
  const value = String(text ?? "");
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function padLeft(text, width) {
  const value = String(text ?? "");
  return value.length >= width ? value : `${" ".repeat(width - value.length)}${value}`;
}

function center(text, width) {
  const value = String(text ?? "");
  const total = Math.max(0, width - value.length);
  const left = Math.floor(total / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(total - left)}`;
}

function wrapText(text, width) {
  const words = String(text ?? "").split(/\s+/).filter((word) => word.length > 0);
  const lines = [];
  let current = "";
  for (const word of words) {
    if (word.length > width) {
      if (current) {
        lines.push(current);
        current = "";
      }
      for (let index = 0; index < word.length; index += width) {
        lines.push(word.slice(index, index + width));
      }
      continue;
    }
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function formatPhaseDuration(ms) {
  const elapsed = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`;
  return `${Math.floor(elapsed / 60_000)}m`;
}

function hasWord(text, tokens) {
  return tokens.some((token) => new RegExp(`\\b${token}\\b`).test(text));
}

function classifyPhaseStatus(label, detail) {
  const text = String(detail ?? "").toLowerCase();
  if (label === "graphify") {
    if (hasWord(text, ["failed"])) return "fail";
    if (hasWord(text, ["degraded", "skipped", "disabled"])) return "warn";
    return "ok";
  }
  if (label === "search") {
    if (hasWord(text, ["failed"])) return "fail";
    if (hasWord(text, ["declined", "deferred", "skipped", "unsupported"])) return "warn";
    return "ok";
  }
  return "ok";
}

function stateGlyph(status) {
  return STATE_GLYPHS[status] ?? STATE_GLYPHS.ok;
}

function normalizeMessage(text) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.replace(WARNING_PREFIX, "").trim();
}

export function createUpdateReport({ version, verbose = false, color = false } = {}) {
  void color;
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
      remember(warnings, seenWarnings, normalizeMessage(entry.message));
    } else if (entry.kind === "error") {
      remember(errors, seenErrors, normalizeMessage(entry.message));
    }
  };

  const print = (line) => {
    console.log(line);
  };

  const withAction = (text) => (ACTION_PATTERN.test(text) ? text : `${text}${ACTION_SUFFIX}`);

  const frameLine = (left, right) => `${left}${"─".repeat(INNER_WIDTH)}${right}`;

  const emptyRow = () => `│${" ".repeat(INNER_WIDTH)}│`;

  const brandRow = () => {
    const label = "FLOWTASK · update";
    const versionText = version && version !== "unknown" ? `v${version}` : "";
    const right = versionText ? `${versionText}${" ".repeat(3)}` : "";
    const left = `${" ".repeat(LEFT_MARGIN)}${label}`;
    const fill = " ".repeat(Math.max(0, INNER_WIDTH - left.length - right.length));
    return `│${left}${fill}${right}│`;
  };

  const headerRow = () => {
    const interior = `${" ".repeat(LEFT_MARGIN)}${padRight("PHASE", COL_PHASE)}${" ".repeat(COL_GAP)}${padRight("DETAIL", COL_DETAIL)}${" ".repeat(COL_GAP)}${padLeft("TIME", COL_TIME)}${" ".repeat(COL_GAP)}${center("STATE", COL_STATE)}${" ".repeat(RIGHT_MARGIN)}`;
    return `│${interior}│`;
  };

  const ruleRow = () => {
    const interior = `${" ".repeat(LEFT_MARGIN)}${"─".repeat(INNER_WIDTH - LEFT_MARGIN * 2)}${" ".repeat(LEFT_MARGIN)}`;
    return `│${interior}│`;
  };

  const emitRow = (phaseLabel, detail, timeText, status) => {
    const interior = `${" ".repeat(LEFT_MARGIN)}${padRight(truncateTo(phaseLabel, COL_PHASE), COL_PHASE)}${" ".repeat(COL_GAP)}${padRight(truncateTo(detail, COL_DETAIL), COL_DETAIL)}${" ".repeat(COL_GAP)}${padLeft(truncateTo(timeText, COL_TIME), COL_TIME)}${" ".repeat(COL_GAP)}${center(stateGlyph(status), COL_STATE)}${" ".repeat(RIGHT_MARGIN)}`;
    print(`│${interior}│`);
  };

  const printNotice = (glyph, text) => {
    const lines = wrapText(text, WARNING_WRAP_WIDTH);
    if (lines.length === 0) lines.push("");
    lines.forEach((line, index) => {
      const indent = " ".repeat(LEFT_MARGIN + 2);
      const prefix = index === 0 ? `${" ".repeat(LEFT_MARGIN)}${glyph} ` : indent;
      print(`│${padRight(`${prefix}${line}`, INNER_WIDTH)}│`);
    });
  };

  const footerRow = () => {
    const targets = syncRows.length;
    const targetsText = targets === 1 ? "1 TARGET" : `${targets} TARGETS`;
    const warningsText = warnings.length === 1 ? "1 WARNING" : `${warnings.length} WARNINGS`;
    const failedCount = Math.max(failures, errors.length);
    const failed = failures > 0 || errors.length > 0;
    const chips = [` ${targetsText} `, ` ${warningsText} `];
    if (failedCount > 0) chips.push(` ${failedCount} FAILED `);
    const badge = failed ? " FAILED " : " COMPLETE ";
    const leftAvailable = INNER_WIDTH - LEFT_MARGIN - 1 - badge.length - 1;
    let pieces = [...chips, formatDuration(Date.now() - startedAt)];
    let left = pieces.join("   ");
    if (left.length > leftAvailable) {
      pieces = [...chips];
      left = pieces.join("   ");
      while (pieces.length > 0 && left.length > leftAvailable) {
        pieces = pieces.slice(0, -1);
        left = pieces.join("   ");
      }
    }
    const interior = `${" ".repeat(LEFT_MARGIN)}${padRight(left, leftAvailable)} ${badge} `;
    return `│${interior}│`;
  };

  return {
    verbose,
    begin() {
      startedAt = Date.now();
      if (verbose) {
        print(`FlowTask update · ${version}`);
        return;
      }
      setLogSink(sink);
      print(frameLine("┌", "┐"));
      print(brandRow());
      print(frameLine("├", "┤"));
      print(headerRow());
      print(ruleRow());
    },
    phase(label, detail, { status, durationMs } = {}) {
      if (verbose) return;
      const resolvedStatus = status ?? classifyPhaseStatus(label, detail);
      const timeText = durationMs == null ? "" : formatPhaseDuration(durationMs);
      emitRow(label, detail, timeText, resolvedStatus);
    },
    syncRow(target, detail, { failed = false, durationMs } = {}) {
      if (verbose) return;
      syncRows.push({ target, detail, status: failed ? "fail" : "ok", durationMs });
      if (failed) failures += 1;
    },
    endSync() {
      if (verbose || syncRows.length === 0) return;
      syncRows.forEach((row, index) => {
        const label = index === 0 ? "sync" : "";
        const detail = `${padRight(truncateTo(row.target, SYNC_TARGET_WIDTH), SYNC_TARGET_WIDTH)} ${row.detail}`;
        const timeText = row.durationMs == null ? "" : formatPhaseDuration(row.durationMs);
        emitRow(label, detail, timeText, row.status);
      });
    },
    markFailure() {
      failures += 1;
    },
    fail(message) {
      const text = normalizeMessage(message);
      if (!text) return;
      remember(errors, seenErrors, text);
      failures += 1;
    },
    finish() {
      if (verbose || finished) return;
      finished = true;
      if (warnings.length > 0 || errors.length > 0) {
        print(emptyRow());
        for (const warning of warnings) printNotice("⚠", withAction(warning));
        if (warnings.length > 0 && errors.length > 0) print(emptyRow());
        for (const error of errors) printNotice("✗", withAction(error));
      }
      print(frameLine("├", "┤"));
      print(footerRow());
      print(frameLine("└", "┘"));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      setLogSink(null);
    },
  };
}
