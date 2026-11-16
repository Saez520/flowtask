import fs from "fs";
import path from "path";
import {
  resolveActiveRuntimePaths,
  sha256File,
  writeFileAtomic,
} from "./claude.js";
import { fileExists } from "./logger.js";
import {
  BASE_NAME_PATTERN,
  DEFAULT_BASE_NAME,
  IDENTITY_FILE,
  ensureUserRuntime,
  ensureUserRuntimeConfig,
  hasLayerFiles,
  preflightUserRuntimeConfig,
  readIdentityProfile,
  readUserRuntimeManifest,
  removeUserRuntime,
} from "./user-runtime.js";

export {
  BASE_NAME_PATTERN,
  DEFAULT_BASE_NAME,
  IDENTITY_FILE,
  hasLayerFiles,
  readIdentityProfile,
};

/** Read-only check of the user-level layers used by the Claude target. */
export function preflightClaudeRuntimeConfig(configDir) {
  return preflightUserRuntimeConfig(configDir);
}

/** Ensure the user-level layers and the installation identity. */
export function ensureClaudeRuntimeConfig(configDir, options = {}) {
  return ensureUserRuntimeConfig(configDir, options);
}

// ─── Runtime manifest ─────────────────────────────────────────────────────────

function legacyManifestError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Read the schema 1 manifest written by an earlier Claude-only runtime. It is
 * accepted only by the migration path; the current reader rejects it.
 */
export function readLegacyClaudeRuntimeManifest(runtimeRoot, { verifyPayload = true } = {}) {
  const manifestPath = path.join(runtimeRoot, "runtime.json");
  if (!fileExists(manifestPath)) {
    throw legacyManifestError(
      "runtime_manifest_missing",
      `FlowTask runtime manifest not found at ${manifestPath}. Run: flowtask install`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (parseError) {
    throw legacyManifestError(
      "runtime_manifest_invalid",
      `FlowTask runtime manifest at ${manifestPath} is not valid JSON: ${parseError.message}`,
    );
  }
  if (manifest?.schema !== 1) {
    throw legacyManifestError(
      "runtime_manifest_incompatible",
      `FlowTask runtime manifest uses schema ${manifest?.schema ?? "missing"}; the legacy reader supports schema 1.`,
    );
  }
  if (typeof manifest.payloadId !== "string" || !manifest.payloadId || !Array.isArray(manifest.files)) {
    throw legacyManifestError(
      "runtime_manifest_invalid",
      `FlowTask runtime manifest at ${manifestPath} is incomplete. Run: flowtask install`,
    );
  }

  const active = resolveActiveRuntimePaths(runtimeRoot, manifest.payloadId);
  for (const file of manifest.files) {
    if (!file || typeof file.path !== "string" || typeof file.sha256 !== "string") {
      throw legacyManifestError(
        "runtime_manifest_invalid",
        `FlowTask runtime manifest at ${manifestPath} declares an invalid file entry. Run: flowtask update`,
      );
    }
    const absolute = path.resolve(active.payloadDir, file.path);
    if (!absolute.startsWith(path.resolve(active.payloadDir) + path.sep)) {
      throw legacyManifestError(
        "runtime_payload_incomplete",
        `FlowTask runtime payload is incomplete: ${file.path} is missing. Run: flowtask install`,
      );
    }
    if (!verifyPayload) continue;
    if (!fileExists(absolute) || sha256File(absolute) !== file.sha256) {
      throw legacyManifestError(
        `runtime_payload_${fileExists(absolute) ? "modified" : "incomplete"}`,
        `FlowTask runtime payload was modified or is incomplete: ${file.path}. Run: flowtask install`,
      );
    }
  }
  return manifest;
}

/**
 * Read and validate the current runtime manifest. Schema 1 is rejected here;
 * migration reads it through `readLegacyClaudeRuntimeManifest`.
 */
export function readClaudeRuntimeManifest(runtimeRoot, options = {}) {
  return readUserRuntimeManifest(runtimeRoot, options);
}

// ─── Runtime payload ──────────────────────────────────────────────────────────

/**
 * Build the Claude payload atomically and point the manifest at it. The
 * runner body may be a builder that receives the final payload paths, which is
 * the form used by the installer; a plain string is accepted for callers that
 * already resolved their target.
 */
export function ensureClaudeRuntime(flowtaskDir, options = {}) {
  const { runnerBody, buildRunnerBody, version } = options;
  if (typeof buildRunnerBody !== "function" && (typeof runnerBody !== "string" || !runnerBody.trim())) {
    throw new Error("ensureClaudeRuntime requires a runner body.");
  }
  if (typeof version !== "string" || !version.trim()) {
    throw new Error("ensureClaudeRuntime requires a version.");
  }

  const result = ensureUserRuntime(flowtaskDir, {
    runtimeRoot: options.runtimeRoot,
    version,
    variants: ["claude"],
    descriptor: options.descriptor ?? {},
    targets: options.targets ?? null,
    buildRunnerBody: typeof buildRunnerBody === "function"
      ? buildRunnerBody
      : () => runnerBody,
  });
  return {
    ok: result.ok,
    action: result.action,
    payloadId: result.payloads.claude.payloadId,
    previousPayloadId: result.previousPayloadId,
    version: result.version,
    restoredPaths: result.restoredPaths,
    manifest: result.manifest,
  };
}

/** Remove the user-level runtime, preserving modified or unknown files. */
export function removeClaudeRuntime(runtimeRoot, options = {}) {
  return removeUserRuntime(runtimeRoot, options);
}

export { writeFileAtomic };
