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
const ANSI_PATTERN = /\x1b\[[0-9;]*[A-Za-z]/g;
const ACTION_PATTERN = /flowtask (update|install)|https?:\/\//i;
const ACTION_SUFFIX = " · run flowtask update --verbose for details";
const STATE_GLYPHS = { ok: "✓", warn: "!", fail: "✗" };
const GRADIENT_STOPS = ["#6366F1", "#A855F7", "#2DD4BF"];
const HEADER_COLOR = "#64748B";
const DETAIL_COLOR = "#E2E8F0";
const NUMBER_COLOR = "#2DD4BF";
const TIME_COLOR = "#64748B";
const BRAND_BACKGROUND = "#4F46E5";
const BRAND_TEXT = "#FFFFFF";
const VERSION_TEXT = "#A5B4FC";
const PHASE_COLORS = {
  detect: "#818CF8",
  sync: "#38BDF8",
  plugins: "#A78BFA",
  graphify: "#34D399",
  search: "#FBBF24",
};
const STATUS_COLORS = { ok: "#22C55E", warn: "#F59E0B", fail: "#EF4444" };
const TARGET_CHIP = { background: "#16A34A", text: "#052E16" };
const WARNING_CHIP = { background: "#F59E0B", text: "#052E16" };
const WARNING_CHIP_EMPTY = { background: "#475569", text: "#E2E8F0" };
const FAILURE_CHIP = { background: "#EF4444", text: "#FFFFFF" };
const COMPLETE_BADGE = { background: "#0EA5E9", text: "#FFFFFF" };
const FAILED_BADGE = { background: "#EF4444", text: "#FFFFFF" };
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

function supportsColor({ isTTY = process.stdout.isTTY, env = process.env } = {}) {
  return Boolean(isTTY) && !env.NO_COLOR && env.TERM !== "dumb";
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function gradientColorAt(position, total) {
  const ratio = total <= 1 ? 0 : Math.min(Math.max(position / (total - 1), 0), 1);
  const scaled = ratio * (GRADIENT_STOPS.length - 1);
  const index = Math.min(Math.floor(scaled), GRADIENT_STOPS.length - 2);
  const local = scaled - index;
  const from = hexToRgb(GRADIENT_STOPS[index]);
  const to = hexToRgb(GRADIENT_STOPS[index + 1]);
  const channel = (start, end) => Math.round(start + (end - start) * local);
  const hex = (value) => value.toString(16).padStart(2, "0");
  return `#${hex(channel(from.r, to.r))}${hex(channel(from.g, to.g))}${hex(channel(from.b, to.b))}`;
}

function codePointWidth(codePoint) {
  if (
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  ) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3041 && codePoint <= 0x33ff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f5ff) ||
    (codePoint >= 0x1f600 && codePoint <= 0x1f64f) ||
    (codePoint >= 0x1f680 && codePoint <= 0x1f6ff) ||
    (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x1fa70 && codePoint <= 0x1faff) ||
    (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

function displayWidth(text) {
  const value = String(text ?? "").replace(ANSI_PATTERN, "");
  let width = 0;
  for (const character of value) {
    width += codePointWidth(character.codePointAt(0));
  }
  return width;
}

function truncateTo(text, width) {
  const value = String(text ?? "").replace(ANSI_PATTERN, "");
  if (width <= 0) return "";
  if (displayWidth(value) <= width) return value;
  const target = width - 1;
  let result = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = codePointWidth(character.codePointAt(0));
    if (used + characterWidth > target) break;
    result += character;
    used += characterWidth;
  }
  return `${result.replace(/\u200d+$/u, "")}…`;
}

function padRight(text, width) {
  const value = String(text ?? "");
  const current = displayWidth(value);
  return current >= width ? value : `${value}${" ".repeat(width - current)}`;
}

function padLeft(text, width) {
  const value = String(text ?? "");
  const current = displayWidth(value);
  return current >= width ? value : `${" ".repeat(width - current)}${value}`;
}

function center(text, width) {
  const value = String(text ?? "");
  const total = Math.max(0, width - displayWidth(value));
  const left = Math.floor(total / 2);
  return `${" ".repeat(left)}${value}${" ".repeat(total - left)}`;
}

function splitByDisplayWidth(text, width) {
  const chunks = [];
  let current = "";
  let used = 0;
  for (const character of text) {
    const characterWidth = codePointWidth(character.codePointAt(0));
    if (current && used + characterWidth > width) {
      chunks.push(current);
      current = "";
      used = 0;
    }
    current += character;
    used += characterWidth;
  }
  if (current) chunks.push(current);
  return chunks;
}

function wrapText(text, width) {
  const value = String(text ?? "").replace(ANSI_PATTERN, "");
  const words = value.split(/\s+/).filter((word) => displayWidth(word) > 0);
  const lines = [];
  let current = "";
  let currentWidth = 0;
  for (const word of words) {
    const wordWidth = displayWidth(word);
    if (wordWidth > width) {
      if (current) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      const chunks = splitByDisplayWidth(word, width);
      lines.push(...chunks.slice(0, -1));
      current = chunks[chunks.length - 1] ?? "";
      currentWidth = displayWidth(current);
      continue;
    }
    const separatorWidth = current ? 1 : 0;
    if (current && currentWidth + separatorWidth + wordWidth > width) {
      lines.push(current);
      current = word;
      currentWidth = wordWidth;
      continue;
    }
    current = current ? `${current} ${word}` : word;
    currentWidth += separatorWidth + wordWidth;
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

export function createUpdateReport({ version, verbose = false, color } = {}) {
  const useColor = color ?? supportsColor();
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

  const paint = (text, style = {}) => {
    if (!useColor || !text) return text;
    const { fg, bg, bold } = style;
    if (!fg && !bg && !bold) return text;
    let codes = "";
    if (fg) {
      const color = hexToRgb(fg);
      codes += `\x1b[38;2;${color.r};${color.g};${color.b}m`;
    }
    if (bg) {
      const color = hexToRgb(bg);
      codes += `\x1b[48;2;${color.r};${color.g};${color.b}m`;
    }
    if (bold) codes += "\x1b[1m";
    return `${codes}${text}\x1b[0m`;
  };

  const render = (segments) => segments.map(({ text, style }) => (style ? paint(text, style) : text)).join("");

  const withAction = (text) => (ACTION_PATTERN.test(text) ? text : `${text}${ACTION_SUFFIX}`);

  const borderStyle = (column) => ({ fg: gradientColorAt(column, FRAME_WIDTH) });

  const frameLine = (left, right) => {
    const segments = [{ text: left, style: borderStyle(0) }];
    for (let column = 1; column < FRAME_WIDTH - 1; column += 1) {
      segments.push({ text: "─", style: borderStyle(column) });
    }
    segments.push({ text: right, style: borderStyle(FRAME_WIDTH - 1) });
    return render(segments);
  };

  const emptyRow = () => render([
    { text: "│", style: borderStyle(0) },
    { text: " ".repeat(INNER_WIDTH) },
    { text: "│", style: borderStyle(FRAME_WIDTH - 1) },
  ]);

  const brandRow = () => {
    const label = "FLOWTASK · update";
    const versionText = version && version !== "unknown" ? `v${version}` : "";
    const right = versionText ? `${versionText}${" ".repeat(3)}` : "";
    const left = `${" ".repeat(LEFT_MARGIN)}${label}`;
    const fill = " ".repeat(Math.max(0, INNER_WIDTH - displayWidth(left) - displayWidth(right)));
    const segments = [
      { text: "│", style: borderStyle(0) },
      { text: " ".repeat(LEFT_MARGIN), style: { bg: BRAND_BACKGROUND } },
      { text: label, style: { fg: BRAND_TEXT, bg: BRAND_BACKGROUND, bold: true } },
      { text: fill, style: { bg: BRAND_BACKGROUND } },
    ];
    if (versionText) {
      segments.push({ text: versionText, style: { fg: VERSION_TEXT, bg: BRAND_BACKGROUND } });
      segments.push({ text: " ".repeat(3), style: { bg: BRAND_BACKGROUND } });
    }
    segments.push({ text: "│", style: borderStyle(FRAME_WIDTH - 1) });
    return render(segments);
  };

  const headerRow = () => {
    const interior = `${" ".repeat(LEFT_MARGIN)}${padRight("PHASE", COL_PHASE)}${" ".repeat(COL_GAP)}${padRight("DETAIL", COL_DETAIL)}${" ".repeat(COL_GAP)}${padLeft("TIME", COL_TIME)}${" ".repeat(COL_GAP)}${center("STATE", COL_STATE)}${" ".repeat(RIGHT_MARGIN)}`;
    return render([
      { text: "│", style: borderStyle(0) },
      { text: interior, style: { fg: HEADER_COLOR } },
      { text: "│", style: borderStyle(FRAME_WIDTH - 1) },
    ]);
  };

  const ruleRow = () => {
    const segments = [
      { text: "│", style: borderStyle(0) },
      { text: " ".repeat(LEFT_MARGIN) },
    ];
    for (let column = LEFT_MARGIN + 1; column <= INNER_WIDTH - LEFT_MARGIN; column += 1) {
      segments.push({ text: "─", style: borderStyle(column) });
    }
    segments.push({ text: " ".repeat(LEFT_MARGIN) });
    segments.push({ text: "│", style: borderStyle(FRAME_WIDTH - 1) });
    return render(segments);
  };

  const detailSegments = (cell) => {
    const segments = [];
    const pattern = /\d+(?:\.\d+)?/g;
    let lastIndex = 0;
    let match = pattern.exec(cell);
    while (match !== null) {
      if (match.index > lastIndex) {
        segments.push({ text: cell.slice(lastIndex, match.index), style: { fg: DETAIL_COLOR } });
      }
      segments.push({ text: match[0], style: { fg: NUMBER_COLOR, bold: true } });
      lastIndex = match.index + match[0].length;
      match = pattern.exec(cell);
    }
    if (lastIndex < cell.length) {
      segments.push({ text: cell.slice(lastIndex), style: { fg: DETAIL_COLOR } });
    }
    if (segments.length === 0) {
      segments.push({ text: cell, style: { fg: DETAIL_COLOR } });
    }
    return segments;
  };

  const emitRow = (phaseLabel, detail, timeText, status) => {
    const phaseCell = padRight(truncateTo(phaseLabel, COL_PHASE), COL_PHASE);
    const detailCell = padRight(truncateTo(detail, COL_DETAIL), COL_DETAIL);
    const timeCell = padLeft(truncateTo(timeText, COL_TIME), COL_TIME);
    const stateCell = center(stateGlyph(status), COL_STATE);
    const segments = [
      { text: "│", style: borderStyle(0) },
      { text: " ".repeat(LEFT_MARGIN) },
      { text: phaseCell, style: PHASE_COLORS[phaseLabel] ? { fg: PHASE_COLORS[phaseLabel] } : undefined },
      { text: " ".repeat(COL_GAP) },
      ...detailSegments(detailCell),
      { text: " ".repeat(COL_GAP) },
      { text: timeCell, style: { fg: TIME_COLOR } },
      { text: " ".repeat(COL_GAP) },
      { text: stateCell, style: { fg: STATUS_COLORS[status] } },
      { text: " ".repeat(RIGHT_MARGIN) },
      { text: "│", style: borderStyle(FRAME_WIDTH - 1) },
    ];
    print(render(segments));
  };

  const printNotice = (glyph, text, color) => {
    const lines = wrapText(text, WARNING_WRAP_WIDTH);
    if (lines.length === 0) lines.push("");
    lines.forEach((line, index) => {
      const indent = " ".repeat(LEFT_MARGIN + 2);
      const prefix = index === 0 ? `${" ".repeat(LEFT_MARGIN)}${glyph} ` : indent;
      const contentWidth = displayWidth(prefix) + displayWidth(line);
      print(render([
        { text: "│", style: borderStyle(0) },
        { text: prefix, style: { fg: color } },
        { text: line, style: { fg: color } },
        { text: " ".repeat(Math.max(0, INNER_WIDTH - contentWidth)) },
        { text: "│", style: borderStyle(FRAME_WIDTH - 1) },
      ]));
    });
  };

  const footerRow = () => {
    const targets = syncRows.length;
    const targetsText = targets === 1 ? "1 TARGET" : `${targets} TARGETS`;
    const warningsText = warnings.length === 1 ? "1 WARNING" : `${warnings.length} WARNINGS`;
    const failedCount = Math.max(failures, errors.length);
    const failed = failures > 0 || errors.length > 0;
    const warningChip = warnings.length > 0 ? WARNING_CHIP : WARNING_CHIP_EMPTY;
    const pieces = [
      { text: ` ${targetsText} `, style: { fg: TARGET_CHIP.text, bg: TARGET_CHIP.background } },
      { text: ` ${warningsText} `, style: { fg: warningChip.text, bg: warningChip.background } },
    ];
    if (failedCount > 0) {
      pieces.push({ text: ` ${failedCount} FAILED `, style: { fg: FAILURE_CHIP.text, bg: FAILURE_CHIP.background } });
    }
    pieces.push({ text: formatDuration(Date.now() - startedAt), style: { fg: TIME_COLOR } });
    const badge = failed ? " FAILED " : " COMPLETE ";
    const badgeStyle = failed ? FAILED_BADGE : COMPLETE_BADGE;
    const leftAvailable = INNER_WIDTH - LEFT_MARGIN - 1 - displayWidth(badge) - 1;
    let left = pieces.map(({ text }) => text).join("   ");
    while (pieces.length > 0 && displayWidth(left) > leftAvailable) {
      pieces.pop();
      left = pieces.map(({ text }) => text).join("   ");
    }
    const segments = [
      { text: "│", style: borderStyle(0) },
      { text: " ".repeat(LEFT_MARGIN) },
    ];
    pieces.forEach((piece, index) => {
      if (index > 0) segments.push({ text: "   " });
      segments.push(piece);
    });
    segments.push({ text: " ".repeat(Math.max(0, leftAvailable - displayWidth(left))) });
    segments.push({ text: " " });
    segments.push({ text: badge, style: { fg: badgeStyle.text, bg: badgeStyle.background } });
    segments.push({ text: " " });
    segments.push({ text: "│", style: borderStyle(FRAME_WIDTH - 1) });
    return render(segments);
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
        for (const warning of warnings) printNotice("⚠", withAction(warning), STATUS_COLORS.warn);
        if (warnings.length > 0 && errors.length > 0) print(emptyRow());
        for (const error of errors) printNotice("✗", withAction(error), STATUS_COLORS.fail);
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
