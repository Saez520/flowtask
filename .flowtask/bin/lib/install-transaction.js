import fs from "fs";
import path from "path";
import { ASSETS, CLASSIFIER_PLUGIN_NAMES } from "./installer.js";
import { CONTEXT_CHECKPOINT_NAME } from "./ownership.js";
import { resolveClaudePaths } from "./claude.js";

const BACKUP_SUFFIX = "flowtask-tx";

function exists(targetPath) {
  return fs.lstatSync(targetPath, { throwIfNoEntry: false }) !== undefined;
}

function removeEntry(targetPath) {
  if (!exists(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyEntry(sourcePath, destinationPath) {
  const stat = fs.lstatSync(sourcePath);
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    fs.mkdirSync(destinationPath, { recursive: true });
    for (const name of fs.readdirSync(sourcePath)) {
      copyEntry(path.join(sourcePath, name), path.join(destinationPath, name));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(sourcePath), destinationPath);
    return;
  }
  fs.copyFileSync(sourcePath, destinationPath);
}

function moveEntry(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  try {
    fs.renameSync(sourcePath, destinationPath);
  } catch (error) {
    if (!error || error.code !== "EXDEV") throw error;
    copyEntry(sourcePath, destinationPath);
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }
}

/**
 * Reversible installation transaction. Every managed surface is captured before
 * the installation writes it and is restored in reverse order when the
 * installation aborts. A successful commit removes every backup.
 */
export function createInstallTransaction() {
  const entries = [];
  const captured = new Set();
  const stamp = `${process.pid}-${Date.now()}`;

  const backupPathFor = (targetPath) => `${targetPath}.${BACKUP_SUFFIX}-${stamp}`;

  return {
    /**
     * Captures a managed surface. `copy` keeps the original in place and saves
     * a copy; `move` takes the original away so the installer can rebuild it;
     * `absent` records a path the installer creates from scratch.
     */
    capture(targetPath, { mode = "copy" } = {}) {
      if (captured.has(targetPath)) return;
      captured.add(targetPath);

      if (mode === "absent") {
        if (exists(targetPath)) throw new Error(`cannot record an existing path as absent: ${targetPath}`);
        entries.push({ mode, path: targetPath });
        return;
      }
      if (mode !== "copy" && mode !== "move") {
        throw new Error(`unknown transaction capture mode: ${mode}`);
      }
      if (!exists(targetPath)) {
        entries.push({ mode: "absent", path: targetPath });
        return;
      }

      const backupPath = backupPathFor(targetPath);
      removeEntry(backupPath);
      if (mode === "copy") copyEntry(targetPath, backupPath);
      else moveEntry(targetPath, backupPath);
      entries.push({ mode, path: targetPath, backupPath });
    },

    /** Records a directory root that did not exist before the installation. */
    captureRoot(targetPath) {
      if (exists(targetPath)) return;
      this.capture(targetPath, { mode: "absent" });
    },

    /** Registers a composite operation whose rollback runs as one entry. */
    addJournal(journal) {
      if (journal) entries.push({ mode: "journal", journal });
    },

    rollback() {
      const failures = [];
      for (const entry of [...entries].reverse()) {
        try {
          if (entry.mode === "journal") {
            const result = entry.journal.rollback();
            failures.push(...(result.failures ?? []));
            continue;
          }
          if (entry.mode === "absent") {
            removeEntry(entry.path);
            continue;
          }
          removeEntry(entry.path);
          if (entry.mode === "move") moveEntry(entry.backupPath, entry.path);
          else copyEntry(entry.backupPath, entry.path);
          removeEntry(entry.backupPath);
        } catch (error) {
          failures.push({ path: entry.path ?? null, reason: error?.message ?? String(error) });
        }
      }
      entries.length = 0;
      return { ok: failures.length === 0, failures };
    },

    commit() {
      const failures = [];
      for (const entry of entries) {
        try {
          if (entry.mode === "journal") {
            const result = entry.journal.commit();
            failures.push(...(result.failures ?? []));
          } else if (entry.backupPath) {
            removeEntry(entry.backupPath);
          }
        } catch (error) {
          failures.push({ path: entry.path ?? null, reason: error?.message ?? String(error) });
        }
      }
      entries.length = 0;
      return { ok: failures.length === 0, failures };
    },
  };
}

/**
 * Moves a legacy root `.flowtask/` into the target directory as one reversible
 * operation. The journal undoes its own entries before the general rollback.
 */
export function migrateLegacyRootTransactional({ projectDir, targetDir, flowtaskDir }) {
  const rootDir = path.join(projectDir, ".flowtask");
  const noop = {
    moved: false,
    rollback: () => ({ ok: true, failures: [] }),
    commit: () => ({ ok: true, failures: [] }),
  };
  if (path.resolve(rootDir) === path.resolve(flowtaskDir) || !exists(rootDir)) return noop;

  const stamp = `${process.pid}-${Date.now()}`;
  const rootBackup = `${rootDir}.${BACKUP_SUFFIX}-${stamp}`;
  const moves = [];
  const replaced = [];
  const targetCreated = !exists(targetDir);

  try {
    moveEntry(rootDir, rootBackup);
    fs.mkdirSync(targetDir, { recursive: true });
    for (const name of fs.readdirSync(rootBackup)) {
      const destination = path.join(targetDir, name);
      if (exists(destination)) {
        const backup = `${destination}.${BACKUP_SUFFIX}-${stamp}`;
        removeEntry(backup);
        moveEntry(destination, backup);
        replaced.push({ destination, backup });
      }
      moveEntry(path.join(rootBackup, name), destination);
      moves.push({ destination, source: path.join(rootBackup, name) });
    }

    return {
      moved: true,
      rollback() {
        const rollbackFailures = [];
        for (const { destination, source } of [...moves].reverse()) {
          try {
            if (exists(destination)) moveEntry(destination, source);
          } catch (error) {
            rollbackFailures.push({ path: destination, reason: error?.message ?? String(error) });
          }
        }
        for (const { destination, backup } of [...replaced].reverse()) {
          try {
            moveEntry(backup, destination);
          } catch (error) {
            rollbackFailures.push({ path: destination, reason: error?.message ?? String(error) });
          }
        }
        try {
          removeEntry(rootDir);
          moveEntry(rootBackup, rootDir);
        } catch (error) {
          rollbackFailures.push({ path: rootDir, reason: error?.message ?? String(error) });
        }
        if (targetCreated) {
          try {
            if (exists(targetDir) && fs.readdirSync(targetDir).length === 0) fs.rmdirSync(targetDir);
          } catch {
            // The target root is left in place; the move error above is the
            // actionable failure.
          }
        }
        return { ok: rollbackFailures.length === 0, failures: rollbackFailures };
      },
      commit() {
        const commitFailures = [];
        try {
          removeEntry(rootBackup);
          for (const { backup } of replaced) removeEntry(backup);
        } catch (error) {
          commitFailures.push({ path: rootDir, reason: error?.message ?? String(error) });
        }
        return { ok: commitFailures.length === 0, failures: commitFailures };
      },
    };
  } catch (error) {
    const rollbackFailures = [];
    for (const { destination, source } of [...moves].reverse()) {
      try {
        if (exists(destination)) moveEntry(destination, source);
      } catch (inner) {
        rollbackFailures.push({ path: destination, reason: inner?.message ?? String(inner) });
      }
    }
    for (const { destination, backup } of [...replaced].reverse()) {
      try {
        moveEntry(backup, destination);
      } catch (inner) {
        rollbackFailures.push({ path: destination, reason: inner?.message ?? String(inner) });
      }
    }
    try {
      if (exists(rootDir)) removeEntry(rootDir);
      moveEntry(rootBackup, rootDir);
    } catch (inner) {
      rollbackFailures.push({ path: rootDir, reason: inner?.message ?? String(inner) });
    }
    error.rollback = { ok: rollbackFailures.length === 0, failures: rollbackFailures };
    throw error;
  }
}

function managedPluginNames(manifest) {
  const names = new Set();
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (entry?.managedPackage === true || entry?.name === CONTEXT_CHECKPOINT_NAME) names.add(entry.name);
  }
  return names;
}

/**
 * Captures every managed surface of the selected targets before the
 * installation writes it. Configuration and files keep a copy; directories the
 * installer rebuilds are taken away; a root that did not exist is recorded as
 * absent so a rollback removes it whole.
 */
export function captureInstallSurfaces(transaction, { projectDir, targets, manifest, flowtaskDir }) {
  const opencodeRoot = path.join(projectDir, ".opencode");
  const vscodeRoot = path.join(projectDir, ".vscode");
  const claudeRoot = path.join(projectDir, ".claude");

  transaction.captureRoot(opencodeRoot);
  transaction.captureRoot(vscodeRoot);
  transaction.captureRoot(claudeRoot);

  for (const target of targets ?? []) {
    if (!target || target.id === "claude") continue;
    const targetDir = path.join(projectDir, target.targetSubDir ?? target.subDir);
    transaction.captureRoot(targetDir);
    transaction.capture(path.join(targetDir, "config"), { mode: "copy" });
    transaction.capture(path.join(targetDir, ".installation-method"), { mode: "copy" });
    for (const asset of ASSETS[target.id] ?? []) {
      if (!exists(path.join(flowtaskDir, asset.src))) continue;
      transaction.capture(path.join(targetDir, asset.dest), { mode: "move" });
    }

    if (target.id !== "opencode") continue;
    transaction.capture(path.join(opencodeRoot, "skills"), { mode: "copy" });
    const pluginNames = new Set([...managedPluginNames(manifest), ...CLASSIFIER_PLUGIN_NAMES]);
    for (const name of pluginNames) {
      transaction.capture(path.join(opencodeRoot, "plugins", name), { mode: "move" });
    }
    for (const relative of [
      path.join(".opencode", "opencode.json"),
      path.join(".opencode", "tui.json"),
      path.join(".opencode", "cli.json"),
      "tui.json",
      "CLAUDE.md",
    ]) {
      transaction.capture(path.join(projectDir, relative), { mode: "copy" });
    }
  }

  const claudePaths = resolveClaudePaths(projectDir);
  const capturesClaude = (targets ?? []).some((target) => target?.id === "claude")
    || exists(claudePaths.runtimeManifestPath)
    || exists(claudePaths.projectFlowtaskDir);
  if (capturesClaude) {
    for (const surface of [
      claudePaths.runtimeRoot,
      path.join(claudePaths.claudeUserDir, "agents", "flowtask-runner.md"),
      path.join(claudePaths.claudeUserDir, "settings.json"),
      path.join(claudePaths.claudeUserDir, ".claude.json"),
      claudePaths.projectFlowtaskDir,
      claudePaths.projectAgentsDir,
      claudePaths.projectCommandsDir,
      claudePaths.projectLocalSettingsPath,
      claudePaths.projectMcpPath,
      path.join(projectDir, "CLAUDE.md"),
      path.join(projectDir, ".git", "info", "exclude"),
    ]) {
      transaction.capture(surface, { mode: "copy" });
    }
  }

  for (const relative of ["cli.json", "tui.json"]) {
    transaction.capture(path.join(flowtaskDir, relative), { mode: "copy" });
  }
  for (const relative of [path.join(".flowtask", "config", "profile.json"), path.join(".flowtask", "profile.json")]) {
    transaction.capture(path.join(projectDir, relative), { mode: "copy" });
  }
}
