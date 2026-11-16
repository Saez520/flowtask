export type RegistrationState = "absent" | "active" | "inactive" | "unsupported" | "unreadable";
export type RuntimeState = "active" | "missing" | "incompatible" | "unreadable" | "incomplete";
export type ActivationStatus = "disabled" | "inactive" | "active" | "unsupported" | "unreadable" | "broken";
export interface RegistrationResult {
    status: RegistrationState;
    registry: Record<string, unknown> | null;
    path: string | null;
    projectDir: string | null;
    reason: string | null;
}
export interface RuntimeResult {
    status: RuntimeState;
    manifest: Record<string, unknown> | null;
    payloadDir: string | null;
    reason: string | null;
}
export interface ActivationResult {
    status: ActivationStatus;
    message: string | null;
    registration: RegistrationResult;
    runtime: RuntimeResult;
    runtimeRoot: string;
}
export declare const ACTIVATION_MESSAGES: {
    readonly unreadable: "FlowTask project registration is unreadable. Run: flowtask install.";
    readonly unsupported: "FlowTask project registration uses an unsupported schema. Run: flowtask update.";
    readonly broken: "FlowTask runtime is missing or incompatible. Run: flowtask install.";
};
/**
 * Find the closest OpenCode project registration walking up from `startDir`.
 * The registration must declare schema 1 and the real project path.
 */
export declare function findOpencodeRegistration(startDir: string): RegistrationResult;
/** Read the canonical runtime manifest and validate its payload is usable. */
export declare function readCanonicalRuntime(runtimeRoot: string): RuntimeResult;
/**
 * Decide whether the FlowTask surface must be active for this directory.
 * Without a runtime option the gate keeps its legacy behavior. A registered
 * project activates only when the canonical runtime and payload are usable.
 */
export declare function evaluateOpencodeActivation({ directory, runtimeRoot, }: {
    directory: string;
    runtimeRoot: string | null;
}): ActivationResult;
