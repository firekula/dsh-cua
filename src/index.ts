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
 * over stdin to the long-lived daemon; crash-safe, no native modules
 * in-process. The packaged `vendor/bin` ships out-of-the-box driver binaries
 * for the platforms that have them (macOS universal, Windows x64); other
 * platforms resolve `cua-driver` from `binDir` / `CUA_DRIVER_BIN` / `PATH`.
 *
 * @module dsh-cua
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { registerCuaTools, ACT_TOOLS, type ResolvedConfig } from './tools.js'
import { resolveDriverPath, type DriverResolutionOrigin } from './platform.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cua'

/** Services required by the tool suite. */
export const inject = ['tools', 'systemPrompt', 'subprocess', 'attachments']

/** Cooperative tool-call timeout budget (ms) when the user config omits it. */
const DEFAULT_TIMEOUT_MS = 15_000
/** Client-side cap on UIA elements forwarded from one snapshot. */
const DEFAULT_MAX_ELEMENTS = 200
/** Client-side cap on list rows (windows/apps) forwarded per call. */
const DEFAULT_MAX_ROWS = 120

/** Plugin config; every field is optional. */
export interface Config {
  /** Directory containing the driver binary (`cua-driver` / `cua-driver.exe`). Overrides vendored copy, env and PATH. */
  binDir?: string
  /** Cooperative tool-call timeout budget in milliseconds. */
  timeoutMs?: number
  /** Ask via dsh's native approval panel before every state-changing action. */
  requireApproval?: boolean
  /** Turn off the whole suite without uninstalling. */
  disabled?: boolean
  /** Max UIA elements one snapshot may forward (upper clamp of max_elements). */
  maxElements?: number
  /** Max rows one window/app listing may forward. */
  maxRows?: number
}

export const Config: z<Config> = z.object({
  binDir: z.string(),
  timeoutMs: z.number().step(1).min(2_000).max(120_000),
  requireApproval: z.boolean(),
  disabled: z.boolean(),
  maxElements: z.number().step(1).min(20).max(5_000),
  maxRows: z.number().step(1).min(10).max(1_000),
})

type Resolved = Required<Config>

/** 解析来源转成用户可读标签，用于加载日志。 */
const ORIGIN_LABEL: Record<DriverResolutionOrigin, string> = {
  binDir: 'config binDir',
  env: 'CUA_DRIVER_BIN',
  vendored: '插件自带',
  path: 'PATH',
  missing: '未找到',
}

/**
 * Install the approval gate: every `ACT_TOOLS` member becomes an `ask`
 * decision unless `requireApproval` is turned off. Observation tools flow
 * through untouched — they never mutate machine state.
 */
function applyApprovalGate(ctx: Context, requireApproval: boolean): void {
  if (!requireApproval) return
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (!ACT_TOOLS.has(execution.name)) return next()
    const args = execution.arguments as Record<string, unknown> | undefined
    const where = describeTarget(args)
    return {
      kind: 'ask',
      reason: `dsh-cua 请求执行「${humanAction(execution.name)}」${where.length > 0 ? `（目标：${where}）` : ''}。这是对真实桌面环境的输入操作，请确认。`,
    }
  })
}

function humanAction(toolName: string): string {
  const map: Record<string, string> = {
    cua_click: '鼠标点击',
    cua_type_text: '键盘输入文本',
    cua_press_key: '按键',
    cua_hotkey: '组合键',
    cua_scroll: '滚动',
    cua_set_value: '控件赋值',
    cua_bring_to_front: '将窗口置前',
  }
  return map[toolName] ?? toolName
}

function describeTarget(args: Record<string, unknown> | undefined): string {
  if (typeof args !== 'object' || args === null) return ''
  const token = args['element_token']
  if (typeof token === 'string' && token.length > 0) return `元素 ${token}`
  const pid = args['pid']
  const windowId = args['window_id']
  if (args['scope'] === 'desktop') return `桌面坐标 (${String(args['x'])}, ${String(args['y'])})，作用于当前前台`
  if (typeof pid === 'number' && typeof windowId === 'number') return `窗口 pid=${pid} window_id=${windowId}`
  if (typeof pid === 'number') return `进程 pid=${pid}`
  return ''
}

/** Compose the fixed system-prompt guidance block. */
function systemPromptText(): string {
  return [
    'cua_* 是本机计算机控制（Computer Use）工具族，底层是常驻的 cua-driver daemon：无障碍元素级寻址（Windows 下经 UIA、macOS 下经原生 Accessibility，协议一致）、默认后台投递（不抢用户焦点）、结构化错误。',
    '标准闭环：先用 cua_list_windows / cua_list_apps 找到 pid 与 window_id；再 cua_window_state 拿 element_token 与 grounding 截图；用 token 执行点击/输入等动作；关键操作后用 cua_verify_state 做谓词自检。',
    'element_token 过期会显式报错——重拍快照即可，不要复用旧快照的 token 迭代多步动作。',
    '像素坐标只在 canvas/视频/自绘表面这类非 UIA 表面使用：窗口内像素基于该窗口最近一次截图（缩放后像素），桌面绝对像素配合 scope:"desktop"（依据 cua_desktop_screenshot 的真实物理像素）。非 UIA 表面的降级路径由驱动返回值中的 escalation/degraded 字段指明。',
    '动作类工具默认请求用户批准；请把操作限制在任务所需的最小范围，不要为了"看看会发生什么"而点击或输入。',
  ].join('\n')
}

/** Register the cua-driver-backed computer use tool suite. */
export function apply(ctx: Context, config: Config): void {
  const resolved: Resolved = {
    binDir: config.binDir ?? '',
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    requireApproval: config.requireApproval ?? true,
    disabled: config.disabled ?? false,
    maxElements: config.maxElements ?? DEFAULT_MAX_ELEMENTS,
    maxRows: config.maxRows ?? DEFAULT_MAX_ROWS,
  }
  if (resolved.disabled) {
    ctx.logger.info('cua: plugin loaded but disabled by config — no tools registered')
    return
  }

  const resolution = resolveDriverPath(resolved.binDir, process.env['CUA_DRIVER_BIN'])
  ctx.logger.info('cua: plugin loaded (driver: %s, exists: %s, source: %s, approval: %s)',
    resolve(resolution.path), String(existsSync(resolution.path)), ORIGIN_LABEL[resolution.origin], String(resolved.requireApproval))

  ctx.systemPrompt.section({
    name: 'tool:cua_*',
    order: 120,
    text: systemPromptText(),
  })

  applyApprovalGate(ctx, resolved.requireApproval)

  const resolvedCfg: ResolvedConfig = {
    exePath: resolution.path,
    timeoutMs: resolved.timeoutMs,
    maxElements: resolved.maxElements,
    maxRows: resolved.maxRows,
  }
  registerCuaTools(ctx, resolvedCfg)
}
