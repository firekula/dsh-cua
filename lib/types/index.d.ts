/**
 * `dsh-cua`: Computer Use for DeepSeek Harness, backed by the local
 * cua-driver daemon (trycua).
 *
 * Registers fourteen `cua_*` model-facing tools spanning three classes:
 *
 * - **观察** — `cua_status`, `cua_list_windows`, `cua_list_apps`,
 *   `cua_window_state`（UIA 元素树 + 窗口截图）, `cua_desktop_screenshot`,
 *   `cua_zoom`, `cua_verify_state`. Read-only; no approval prompt.
 * - **操作** — `cua_click`, `cua_type_text`, `cua_press_key`, `cua_hotkey`,
 *   `cua_scroll`, `cua_set_value`, `cua_bring_to_front`. Each one routes
 *   through dsh's `tools/pre-execute` gate and asks for human approval by
 *   default (`requireApproval: true`); the driver's own session/permission
 *   policy stays active underneath as the second fence.
 * - Every screenshot-bearing call persists its PNG as a dsh image attachment,
 *   so the model grounds pixel actions on the exact bytes it saw.
 *
 * Transport mirrors dsh-goz: one stateless CLI spawn per call carrying JSON
 * over stdin to the long-lived daemon on `\\.\pipe\cua-driver`; crash-safe,
 * no native modules in-process. The packaged `vendor/bin` ships
 * `cua-driver.exe` (+ UIA helper) so the plugin works out of the box;
 * `binDir` overrides for user-managed installs.
 *
 * @module dsh-cua
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "cua";
/** Services required by the tool suite. */
export declare const inject: string[];
/** Plugin config; every field is optional. */
export interface Config {
    /** Directory containing `cua-driver.exe`. Defaults to the packaged `vendor/bin/`. */
    binDir?: string;
    /** Cooperative tool-call timeout budget in milliseconds. */
    timeoutMs?: number;
    /** Ask via dsh's native approval panel before every state-changing action. */
    requireApproval?: boolean;
    /** Turn off the whole suite without uninstalling. */
    disabled?: boolean;
    /** Max UIA elements one snapshot may forward (upper clamp of max_elements). */
    maxElements?: number;
    /** Max rows one window/app listing may forward. */
    maxRows?: number;
}
export declare const Config: z<Config>;
/** Register the cua-driver-backed computer use tool suite. */
export declare function apply(ctx: Context, config: Config): void;
