#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RUNTIME_SCHEMA = 1;
const REGISTRY_SCHEMA = 1;
const INDEX_SCHEMA = 1;
const SESSION_START_LIMIT_BYTES = 10000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const runtimeRoot = path.resolve(__dirname, "..");

function writeLine(message) {
  process.stdout.write(`${message}\n`);
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function realPath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function comparablePath(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathsEqual(left, right) {
  return comparablePath(left) === comparablePath(right);
}

function findRegistry(startDir) {
  let current = realPath(startDir);
  for (;;) {
    const candidate = path.join(current, ".claude", "flowtask", "project.json");
    if (fs.existsSync(candidate)) return { registryPath: candidate, projectDir: current };
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function readJson(filePath) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch {
    return { ok: false };
  }
}

function readRuntime() {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fs.existsSync(manifestPath)) return null;

  const parsed = readJson(manifestPath);
  if (!parsed.ok || parsed.value?.schema !== RUNTIME_SCHEMA) return null;
  if (typeof parsed.value.payloadId !== "string" || !parsed.value.payloadId) return null;

  const payloadDir = path.join(runtimeRoot, "versions", parsed.value.payloadId);
  const sessionStartPath = path.join(payloadDir, "session-start.md");
  if (!fs.existsSync(payloadDir) || !fs.existsSync(sessionStartPath)) return null;
  return { manifest: parsed.value, sessionStartPath };
}

function syncProjectsIndex(registry) {
  try {
    const indexPath = path.join(runtimeRoot, "projects.json");
    const lockPath = path.join(runtimeRoot, ".projects.lock");
    let lock = null;
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
    } catch {
      return;
    }

    try {
      let index = { schema: INDEX_SCHEMA, updatedAt: null, projects: [] };
      if (fs.existsSync(indexPath)) {
        const parsed = readJson(indexPath);
        if (parsed.ok && parsed.value?.schema === INDEX_SCHEMA && Array.isArray(parsed.value.projects)) {
          index = parsed.value;
        }
      }

      const entry = {
        path: registry.projectPath,
        registeredAt: registry.registeredAt ?? null,
        runtimeVersion: registry.runtimeVersion ?? null,
      };
      const projects = index.projects.filter(
        (item) => item && typeof item.path === "string" && !pathsEqual(item.path, entry.path),
      );
      projects.push(entry);
      const next = { schema: INDEX_SCHEMA, updatedAt: new Date().toISOString(), projects };
      if (JSON.stringify(index.projects) === JSON.stringify(projects)) return;

      const tempPath = path.join(runtimeRoot, `.projects.${process.pid}.tmp`);
      fs.writeFileSync(tempPath, JSON.stringify(next, null, 2));
      fs.renameSync(tempPath, indexPath);
    } finally {
      try { fs.closeSync(lock); } catch { /* already closed */ }
      try { fs.rmSync(lockPath, { force: true }); } catch { /* already gone */ }
    }
  } catch {
    // The index is a cache; a failure never blocks the session.
  }
}

function main() {
  const input = readStdinJson();

  if (
    (typeof input.agent_id === "string" && input.agent_id.trim() !== "") ||
    input.is_subagent === true ||
    input.hook_event_name === "SubagentStart"
  ) {
    return;
  }

  const projectDir =
    process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const located = findRegistry(projectDir);
  if (!located) return;

  const registryRead = readJson(located.registryPath);
  if (!registryRead.ok) {
    writeLine("FlowTask project registration is unreadable. Run: flowtask install");
    return;
  }

  const registry = registryRead.value;
  if (!registry || typeof registry !== "object" || registry.schema !== REGISTRY_SCHEMA) {
    writeLine("FlowTask project registration uses an unsupported schema. Run: flowtask install");
    return;
  }
  if (typeof registry.projectPath !== "string" || !pathsEqual(registry.projectPath, located.projectDir)) {
    return;
  }

  const runtime = readRuntime();
  if (!runtime) {
    writeLine("FlowTask runtime is missing or incompatible. Run: flowtask install");
    return;
  }

  let content;
  try {
    content = fs.readFileSync(runtime.sessionStartPath, "utf8");
  } catch {
    writeLine("FlowTask runtime is missing or incompatible. Run: flowtask install");
    return;
  }

  if (Buffer.byteLength(content, "utf8") >= SESSION_START_LIMIT_BYTES) {
    writeLine("FlowTask startup exceeds the hook limit. Run: flowtask update");
    return;
  }

  syncProjectsIndex(registry);
  process.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
}

try {
  main();
} catch {
  // A hook failure must never break the Claude Code session.
}
