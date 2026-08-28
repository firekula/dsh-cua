/**
 * Transport between the plugin and the local `cua-driver` daemon.
 *
 * Every tool call spawns the driver binary once, hands the JSON arguments
 * over stdin (no shell involved) and parses the single JSON document printed
 * to stdout. The daemon keeps all state (accessibility snapshots, sessions,
 * permission policy) between calls; the CLI process is stateless and
 * crash-isolated, mirroring the dsh-goz transport.
 *
 * Domain errors arrive as JSON envelopes on stdout (`{code, suggestion}` /
 * `{code, message}`) with exit code 0, so the parser — not the exit code —
 * decides failure. Everything else is passed through verbatim.
 *
 * @module dsh-cua/client
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-tools';
/** One completed spawn with captured output and exit code. */
export interface CuaRun {
    exitCode: number;
    stdout: string;
    stderr: string;
}
/** Cap on complete raw `cua-driver call` stdout bytes we will parse. */
export declare const RAW_OUTPUT_MAX_BYTES = 4000000;
/** Cap on retained stderr tail bytes (embedded in error messages). */
export declare const STDERR_MAX_BYTES = 16000;
/** Terminate-escalation grace (ms), handed to the subprocess seam. */
export declare const GRACE_MS = 2000;
/** Spawn `cua-driver.exe` with fixed argv, optional JSON payload over stdin. */
export declare function runCua(ctx: Context, exec: {
    signal: AbortSignal;
}, toolName: string, exePath: string, argvTail: readonly string[], payload: Record<string, unknown> | undefined, graceMs: number): Promise<CuaRun>;
/** Canonical value handed to the model for every driver interaction. */
export interface CuaValue {
    source: 'cua-driver';
    tool: string;
    summary: string;
    /** The unmodified driver JSON payload (bounded by transport caps). */
    data: JsonValue;
    image: CuaImageRef | null;
}
/** Minimal mirror of a dsh image attachment reference. */
export interface CuaImageRef {
    attachmentId: string;
    mediaType: string;
    bytes: number;
    width: number | null;
    height: number | null;
    name: string;
}
/** True when the parsed output looks like a driver error envelope. */
export declare function looksLikeErrorEnvelope(parsed: unknown): boolean;
/** Build a model-facing error from a structured driver envelope. */
export declare function describeErrorEnvelope(toolName: string, parsed: Record<string, unknown>): Error;
/** Strip noisy one-shot CLI banners ("content-free product telemetry…"). */
export declare function stripCliNoise(text: string): string;
/** Parse `cua-driver call` stdout into a usable JSON value. */
export declare function parseCallOutput(toolName: string, run: CuaRun): unknown;
/** Read `status` subcommand text (used by `cua_status`). */
export declare function summarizeStatus(run: CuaRun): string;
