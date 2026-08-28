/**
 * Model-facing tool suite backed by the local cua-driver daemon.
 *
 * Tool names carry the `cua_` prefix. Parameter names deliberately mirror the
 * driver's snake_case wire contract (pid / window_id / element_token /
 * delivery_mode / …) so payloads forward verbatim — renaming here would
 * translate every schema drift upstream into silent plugin bugs.
 *
 * Targeting rules implemented below follow the driver's own guidance:
 * prefer `element_token` from `cua_window_state`; pixel coordinates are the
 * fallback for canvas/WebGL surfaces; background-first delivery stays the
 * driver default and foreground remains an explicit escalation.
 *
 * @module dsh-cua/tools
 */
import type { Context } from '@deepseek-ai/cordis';
/** Plugin configuration resolved once at apply time. */
export interface ResolvedConfig {
    exePath: string;
    timeoutMs: number;
    maxElements: number;
    maxRows: number;
}
/** Tools that change machine state — routed through the approval gate. */
export declare const ACT_TOOLS: ReadonlySet<string>;
/** Snapshot 参数上限：元素树会被模型端的 max_elements 夹紧。 */
export declare function registerCuaTools(ctx: Context, cfg: ResolvedConfig): void;
