export type WorktreeManagerSource = "global";
export declare function globalWorktreeManagerDirectory(options?: {
    env?: Record<string, string | undefined>;
    home?: string;
}): string;
export declare function isValidManagerCheckout(dir: string): boolean;
export declare function resolveWorktreeManagerLocation(options?: {
    env?: Record<string, string | undefined>;
    home?: string;
}): {
    directory: string;
    source: WorktreeManagerSource;
} | null;
export declare function missingManagerCause(options?: {
    env?: Record<string, string | undefined>;
    home?: string;
}): string;
