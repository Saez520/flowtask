import { COLORS, log } from "./logger.js";

/**
 * Interactive multi-select for IDE targets.
 * Returns an array of selected values (e.g. ["opencode", "claude"]).
 * @param {object} readline - Node readline module
 * @returns {Promise<string[]>}
 */
export async function showInteractiveSelector(readline) {
  const options = [
    { name: "OpenCode (.opencode/flowtask/)", value: "opencode", selected: false },
    { name: "VS Code (.vscode/flowtask/)",    value: "vscode",   selected: false },
    { name: "Claude Code (.claude/flowtask/)", value: "claude",  selected: false },
  ];
  let cursor = 0;
  let lastRenderLines = 0;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  const render = () => {
    if (lastRenderLines > 0) {
      readline.moveCursor(process.stdout, 0, -lastRenderLines);
      readline.clearScreenDown(process.stdout);
    }
    const lines = [
      COLORS.cyan + "  Select target IDEs (Space to mark, Enter to confirm):" + COLORS.reset,
      ...options.map((opt, i) => {
        const cursorStr = i === cursor ? COLORS.cyan + "> " + COLORS.reset : "  ";
        const checkStr  = opt.selected  ? COLORS.green + "[*]" + COLORS.reset : "[ ]";
        return `${cursorStr}${checkStr} ${opt.name}`;
      }),
      `\n${COLORS.dim}↑/↓: navegar, Espacio: marcar, Enter: confirmar, Ctrl+C: cancelar${COLORS.reset}`,
    ];
    const output = lines.join("\n");
    process.stdout.write(output + "\n");
    lastRenderLines = output.split("\n").length;
  };

  const onResize = () => render();
  process.stdout.on("resize", onResize);
  render();

  return new Promise((resolve) => {
    const cleanup = () => {
      process.stdout.removeListener("resize", onResize);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
    };

    const onKeypress = (str, key) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        log("\nInstallation cancelled.", COLORS.yellow);
        process.exit(0);
      }
      if (key.name === "up")    { cursor = (cursor - 1 + options.length) % options.length; render(); }
      if (key.name === "down")  { cursor = (cursor + 1) % options.length; render(); }
      if (key.name === "space") { options[cursor].selected = !options[cursor].selected; render(); }
      if (key.name === "return") {
        cleanup();
        if (lastRenderLines > 0) {
          readline.moveCursor(process.stdout, 0, -lastRenderLines);
          readline.clearScreenDown(process.stdout);
        }
        resolve(options.filter((o) => o.selected).map((o) => o.value));
      }
    };

    process.stdin.on("keypress", onKeypress);
  });
}

/**
 * Render a progress bar on the current terminal line.
 * @param {object} readline - Node readline module
 * @param {number} current
 * @param {number} total
 * @param {string} label
 */
export function renderProgressBar(readline, current, total, label) {
  const width = 20;
  const filled = Math.round(width * Math.min(current / total, 1));
  const empty  = width - filled;
  const bar = COLORS.green + "█".repeat(filled) + COLORS.reset + COLORS.dim + "░".repeat(empty) + COLORS.reset;
  readline.cursorTo(process.stdout, 0);
  process.stdout.write(`  [${bar}] ${Math.round((current / total) * 100)}% ${label}`);
}
