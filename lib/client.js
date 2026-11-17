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
import { daemonSetupGuide } from './platform.js';
/** Cap on complete raw `cua-driver call` stdout bytes we will parse. */
export const RAW_OUTPUT_MAX_BYTES = 4_000_000;
/** Cap on retained stderr tail bytes (embedded in error messages). */
export const STDERR_MAX_BYTES = 16_000;
/** Terminate-escalation grace (ms), handed to the subprocess seam. */
export const GRACE_MS = 2_000;
/**
 * Stable driver session label for this Harness process.
 *
 * Every tool call spawns a fresh CLI process, so the driver's implicit
 * per-transport session would not connect one call's snapshot/zoom context to
 * the next. An explicit label, unique per Harness process, gives the whole tool
 * suite one session (element-token and zoom continuations keep working) without
 * colliding with another concurrently running Harness.
 */
export const SESSION_LABEL = `dsh-cua-${process.pid}`;
/** Spawn `cua-driver.exe` with fixed argv, optional JSON payload over stdin. */
export async function runCua(ctx, exec, toolName, exePath, argvTail, payload, graceMs) {
    if (exec.signal.aborted) {
        throw new Error(`${toolName} was aborted before completion`);
    }
    const body = payload === undefined ? undefined : { ...payload, session: SESSION_LABEL };
    const wantsStdin = body !== undefined;
    const spec = {
        argv: [exePath, ...argvTail],
        cwd: process.cwd(),
        stdio: {
            stdin: wantsStdin ? 'pipe' : 'ignore',
            stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES },
            stderr: { maxBytes: STDERR_MAX_BYTES },
        },
        graceMs,
        signal: exec.signal,
    };
    let handle;
    try {
        handle = ctx.subprocess.spawn(spec);
    }
    catch (error) {
        if (exec.signal.aborted)
            throw new Error(`${toolName} was aborted before completion`);
        throw new Error(`${toolName} could not start cua-driver (launch failed)`, { cause: error });
    }
    if (wantsStdin && handle.stdin !== undefined) {
        // Fire-and-forget the write: the driver reads stdin to EOF; backpressure
        // of a few KB never matters here and awaiting stream events adds races.
        handle.stdin.end(JSON.stringify(body), 'utf8');
    }
    let outcome;
    try {
        outcome = await handle.done;
    }
    catch (error) {
        throw new Error(`${toolName} could not start cua-driver (launch failed)`, { cause: error });
    }
    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    if (stdout === undefined || stderr === undefined) {
        throw new Error(`${toolName} produced no collected output streams`);
    }
    if (exec.signal.aborted) {
        throw new Error(`${toolName} was aborted before completion`);
    }
    if (outcome.signal !== null || outcome.exitCode === null) {
        throw new Error(`${toolName} was killed by signal ${outcome.signal ?? '(unknown)'}`);
    }
    return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text };
}
/**
 * True when the parsed output is a driver refusal.
 *
 * The current driver answers refusals with `{ status: "refused", refusal: {
 * code, message }, hint }`, while older builds emitted a bare
 * `{ code, message | suggestion }` envelope. Both must fail closed: a refusal
 * mistaken for success would silently drop a stale-token or permission error.
 */
export function looksLikeErrorEnvelope(parsed) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return false;
    const record = parsed;
    if (record.status === 'refused')
        return true;
    if (typeof record.refusal === 'object' && record.refusal !== null)
        return true;
    if (typeof record.code !== 'string' || record.code.length === 0)
        return false;
    // A success payload never carries an explanatory field beside `code`.
    return 'suggestion' in record || 'message' in record || 'reason' in record || 'hint' in record;
}
/** Build a model-facing error from a structured driver refusal or legacy envelope. */
export function describeErrorEnvelope(toolName, parsed) {
    const refusal = typeof parsed.refusal === 'object' && parsed.refusal !== null
        ? parsed.refusal
        : undefined;
    const code = String(record_string(refusal?.code ?? parsed.code));
    // Refusal details live in `refusal`; the top-level `hint` still explains them.
    const parts = ['message', 'suggestion', 'reason', 'hint'].map((key) => {
        const inside = refusal?.[key];
        const outside = parsed[key];
        if (typeof inside === 'string' && inside.length > 0)
            return inside;
        return typeof outside === 'string' ? outside : '';
    });
    const tail = parts.filter((part) => part.length > 0).join(' — ');
    return new Error(`cua ${toolName}: [${code}]${tail.length > 0 ? ` ${tail}` : ''}`);
}
function record_string(value) {
    return typeof value === 'string' ? value : String(value ?? '');
}
/** Strip noisy one-shot CLI banners ("content-free product telemetry…"). */
export function stripCliNoise(text) {
    return text
        .split(/\r?\n/)
        .filter((line) => !/telemetry/i.test(line))
        .join('\n')
        .trim();
}
/** Parse `cua-driver call` stdout into a usable JSON value. */
export function parseCallOutput(toolName, run) {
    const out = stripCliNoise(run.stdout);
    if (out.length > 0) {
        try {
            const parsed = JSON.parse(out);
            if (looksLikeErrorEnvelope(parsed)) {
                throw describeErrorEnvelope(toolName, parsed);
            }
            return parsed;
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                // Not JSON (banner-only or permission prose) — fall through to text handling.
                return handleNonJsonOutput(toolName, run, out);
            }
            throw error;
        }
    }
    return handleNonJsonOutput(toolName, run, out);
}
function handleNonJsonOutput(toolName, run, out) {
    const lower = `${out}\n${run.stderr}`.toLowerCase();
    if (/daemon.*(not running|unreachable)|no .*daemon|pipe.*not.*found|socket.*(not found|no such)|no such file or directory|connection refused|denied/.test(lower)) {
        throw new Error(`cua ${toolName}: ${daemonSetupGuide()}\n驱动输出：${out.slice(0, 400)}`);
    }
    if (run.exitCode !== 0) {
        const tail = run.stderr.trim();
        throw new Error(`cua ${toolName} failed with exit code ${run.exitCode}${tail.length > 0 ? `\n${tail.slice(0, 2_000)}` : ''}`);
    }
    if (/permission denied|not permitted|risk classification/i.test(out)) {
        throw new Error(`cua ${toolName}: 驱动权限策略拒绝了该调用。${out.slice(0, 400)}`);
    }
    // Empty-but-successful actions print {} — anything else printable is odd.
    return out.length > 0 && out !== '{}' ? { _raw: out.slice(0, 2_000) } : {};
}
/** Read `status` subcommand text (used by `cua_status`). */
export function summarizeStatus(run) {
    const body = stripCliNoise(run.stdout);
    if (body.length === 0)
        return run.exitCode === 0 ? '在线（无详细输出）。' : `(exit ${run.exitCode})`;
    return body.split('\n').slice(0, 20).join('\n');
}
