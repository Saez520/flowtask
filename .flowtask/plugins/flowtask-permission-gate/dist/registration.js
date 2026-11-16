import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
export const ACTIVATION_MESSAGES = {
    unreadable: "FlowTask project registration is unreadable. Run: flowtask install.",
    unsupported: "FlowTask project registration uses an unsupported schema. Run: flowtask update.",
    broken: "FlowTask runtime is missing or incompatible. Run: flowtask install.",
};
function realDirectory(value) {
    try {
        return realpathSync(value);
    }
    catch {
        return value;
    }
}
function comparable(value) {
    return process.platform === "win32" ? value.toLowerCase() : value;
}
function readJson(filePath) {
    return JSON.parse(readFileSync(filePath, "utf8"));
}
/**
 * Find the closest OpenCode project registration walking up from `startDir`.
 * The registration must declare schema 1 and the real project path.
 */
export function findOpencodeRegistration(startDir) {
    let current = realDirectory(startDir);
    for (;;) {
        const candidate = join(current, ".opencode", "flowtask", "project.json");
        if (existsSync(candidate)) {
            let registry;
            try {
                const parsed = readJson(candidate);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    return { status: "unreadable", registry: null, path: candidate, projectDir: current, reason: "the registration is not a JSON object" };
                }
                registry = parsed;
            }
            catch (error) {
                return {
                    status: "unreadable",
                    registry: null,
                    path: candidate,
                    projectDir: current,
                    reason: error instanceof Error ? error.message : "the registration is not valid JSON",
                };
            }
            if (registry.schema !== 1) {
                return { status: "unsupported", registry, path: candidate, projectDir: current, reason: `schema ${String(registry.schema ?? "missing")}` };
            }
            if (typeof registry.projectPath !== "string" || !registry.projectPath) {
                return { status: "unreadable", registry, path: candidate, projectDir: current, reason: "the registration does not declare a project path" };
            }
            if (comparable(registry.projectPath) !== comparable(current)) {
                return { status: "inactive", registry, path: candidate, projectDir: current, reason: "the registration points to another project" };
            }
            return { status: "active", registry, path: candidate, projectDir: current, reason: null };
        }
        const parent = dirname(current);
        if (parent === current) {
            return { status: "absent", registry: null, path: null, projectDir: null, reason: null };
        }
        current = parent;
    }
}
/** Read the canonical runtime manifest and validate its payload is usable. */
export function readCanonicalRuntime(runtimeRoot) {
    const manifestPath = join(runtimeRoot, "runtime.json");
    if (!existsSync(manifestPath)) {
        return { status: "missing", manifest: null, payloadDir: null, reason: `runtime manifest not found at ${manifestPath}` };
    }
    let manifest;
    try {
        const parsed = readJson(manifestPath);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { status: "unreadable", manifest: null, payloadDir: null, reason: "the runtime manifest is not a JSON object" };
        }
        manifest = parsed;
    }
    catch (error) {
        return {
            status: "unreadable",
            manifest: null,
            payloadDir: null,
            reason: error instanceof Error ? error.message : "the runtime manifest is not valid JSON",
        };
    }
    if (manifest.schema !== 2) {
        return { status: "incompatible", manifest, payloadDir: null, reason: `unsupported runtime schema ${String(manifest.schema ?? "missing")}` };
    }
    const payloads = manifest.payloads;
    const canonical = payloads?.canonical;
    if (!canonical || typeof canonical.payloadId !== "string" || !canonical.payloadId || !Array.isArray(canonical.files)) {
        return { status: "incomplete", manifest, payloadDir: null, reason: "the canonical payload is not declared" };
    }
    const payloadDir = join(runtimeRoot, "versions", canonical.payloadId);
    if (!existsSync(payloadDir)
        || !existsSync(join(payloadDir, "runner.md"))
        || !existsSync(join(payloadDir, "skills"))) {
        return { status: "incomplete", manifest, payloadDir, reason: `the canonical payload is incomplete at ${payloadDir}` };
    }
    return { status: "active", manifest, payloadDir, reason: null };
}
/**
 * Decide whether the FlowTask surface must be active for this directory.
 * Without a runtime option the gate keeps its legacy behavior. A registered
 * project activates only when the canonical runtime and payload are usable.
 */
export function evaluateOpencodeActivation({ directory, runtimeRoot, }) {
    const runtime = { status: "missing", manifest: null, payloadDir: null, reason: null };
    if (!runtimeRoot) {
        return {
            status: "disabled",
            message: null,
            registration: { status: "absent", registry: null, path: null, projectDir: null, reason: null },
            runtime,
            runtimeRoot: "",
        };
    }
    const registration = findOpencodeRegistration(directory);
    if (registration.status === "absent" || registration.status === "inactive") {
        return { status: "inactive", message: null, registration, runtime, runtimeRoot };
    }
    if (registration.status === "unreadable") {
        return { status: "unreadable", message: ACTIVATION_MESSAGES.unreadable, registration, runtime, runtimeRoot };
    }
    if (registration.status === "unsupported") {
        return { status: "unsupported", message: ACTIVATION_MESSAGES.unsupported, registration, runtime, runtimeRoot };
    }
    const canonicalRuntime = readCanonicalRuntime(runtimeRoot);
    if (canonicalRuntime.status !== "active") {
        return { status: "broken", message: ACTIVATION_MESSAGES.broken, registration, runtime: canonicalRuntime, runtimeRoot };
    }
    return { status: "active", message: null, registration, runtime: canonicalRuntime, runtimeRoot };
}
