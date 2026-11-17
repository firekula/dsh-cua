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

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  GRACE_MS,
  parseCallOutput,
  runCua,
  stripCliNoise,
  summarizeStatus,
  type CuaImageRef,
  type CuaValue,
} from './client.js'
import { daemonSetupGuide } from './platform.js'

/**
 * The plugin authors tool options against local structural mirrors (CuaValue,
 * hand-written DSL literals) and hands them to defineTool opaquely. Reasons:
 * (a) the workspace ships several nominal instances of its own helper types,
 * and full generic inference would force this file to adopt exactly one;
 * (b) instantiating InferArgs over a dynamic ParameterSchemaSpec record blows
 * TS recursion limits. Schemas below are still written in the author DSL and
 * enforced at runtime by the tool pipeline; narrowing happens at this single
 * line instead of leaking casts across the whole suite.
 */
const defineOpaqueTool = defineTool as unknown as (options: object) => unknown

/** Plugin configuration resolved once at apply time. */
export interface ResolvedConfig {
  exePath: string
  timeoutMs: number
  maxElements: number
  maxRows: number
}

/** Tools that change machine state — routed through the approval gate. */
export const ACT_TOOLS: ReadonlySet<string> = new Set([
  'cua_click',
  'cua_type_text',
  'cua_press_key',
  'cua_hotkey',
  'cua_scroll',
  'cua_set_value',
  'cua_bring_to_front',
])

// ---------------------------------------------------------------------------
// small validators

/** Lossy-JSON tolerant integer assertion. */
function assertInt(args: Record<string, unknown>, key: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TypeError(`cua: "${key}" must be an integer in [${min}, ${max === Number.MAX_SAFE_INTEGER ? '∞' : max}]`)
  }
  return value
}

/** Drop undefined entries before forwarding to the driver. */
function compact(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

const DELIVERY_MODES = ['background', 'foreground'] as const

/** Shared addressing resolution across click/type/key/hotkey/scroll. */
function resolveActionTarget(args: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const token = args.element_token
  const hasToken = typeof token === 'string' && token.length > 0 && token.length <= 256
  const pid = assertInt(args, 'pid', 0)
  const windowId = assertInt(args, 'window_id', 0)
  const x = assertInt(args, 'x', 0)
  const y = assertInt(args, 'y', 0)
  const scope = args.scope === 'desktop' || args.scope === 'window' ? args.scope : undefined

  let target: Record<string, unknown>
  if (hasToken) {
    // The token carries its window/pid binding; staleness fails closed
    // server-side, so stale snapshots can never silently misfire.
    target = { element_token: token }
    if (windowId !== undefined) target.window_id = windowId
  } else if (x !== undefined || y !== undefined) {
    if (x === undefined || y === undefined) {
      throw new TypeError('cua: pixel targeting needs both "x" and "y"')
    }
    if (scope === 'desktop') {
      target = { scope: 'desktop', x, y }
    } else if (pid !== undefined && windowId !== undefined) {
      target = { scope: 'window', pid, window_id: windowId, x, y }
    } else {
      throw new TypeError('cua: 像素定位需要 window 目标（pid + window_id）或显式 scope:"desktop"')
    }
  } else if (pid !== undefined && windowId !== undefined) {
    target = { scope: 'window', pid, window_id: windowId }
  } else if (pid !== undefined) {
    target = { pid }
  } else {
    throw new TypeError(
      'cua: 缺少操作目标 —— 提供 element_token（首选）、pid+window_id、或像素坐标（x,y，配 window 目标或 scope:"desktop"）',
    )
  }
  return { ...target, ...extra }
}

/** Optional delivery_mode passthrough with strict enumeration. */
function resolveDeliveryMode(args: Record<string, unknown>): Record<string, unknown> {
  const mode = args.delivery_mode
  if (mode === undefined) return {}
  if (typeof mode === 'string' && (DELIVERY_MODES as readonly string[]).includes(mode)) {
    return { delivery_mode: mode }
  }
  throw new TypeError('cua: "delivery_mode" must be "background" or "foreground"')
}

/** Defensive row extraction: the daemon evolved several list shapes. */
function extractRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data
  if (typeof data === 'object' && data !== null) {
    for (const key of ['windows', 'apps', '_legacy_windows', 'results']) {
      const value = (data as Record<string, unknown>)[key]
      if (Array.isArray(value)) return value
    }
  }
  return []
}

/** Truncate oversized lists honestly, tagging the copy instead of lying. */
function truncateRows(rows: unknown[], cap: number): { data: unknown; truncated: boolean } {
  if (rows.length <= cap) return { data: undefined, truncated: false }
  return { data: { ...{}, _plugin_note: `返回前 ${cap} 条（共 ${rows.length} 条），请细化过滤条件`, items: rows.slice(0, cap) }, truncated: true }
}

// ---------------------------------------------------------------------------
// screenshot plumbing

interface ScreenshotOutcome {
  value: CuaValue
}

/** Declared media type of an inline screenshot payload, defaulting to PNG. */
function screenshotMediaType(data: Record<string, unknown>): { mediaType: string; extension: string } {
  const declared = typeof data.screenshot_mime_type === 'string' ? data.screenshot_mime_type
    : typeof data.mime_type === 'string' ? data.mime_type : 'image/png'
  if (declared === 'image/jpeg') return { mediaType: declared, extension: 'jpg' }
  if (declared === 'image/webp') return { mediaType: declared, extension: 'webp' }
  if (declared === 'image/gif') return { mediaType: declared, extension: 'gif' }
  return { mediaType: 'image/png', extension: 'png' }
}

/**
 * Run a driver call whose response carries a screenshot, persist it as a dsh
 * image attachment and reference it from the returned value.
 *
 * Two transports exist: tools that accept `screenshot_out_file` (window and
 * desktop state) write the image themselves, while `zoom` rejects that
 * argument and returns the bytes inline as base64 instead.
 */
async function callWithScreenshot(
  ctx: Context & { attachments?: AttachmentsLike },
  exec: { signal: AbortSignal },
  cfg: ResolvedConfig,
  pluginTool: string,
  driverTool: string,
  argvTail: readonly string[],
  payload: Record<string, unknown>,
  summary: string,
  graceMs: number,
  supportsOutFile = true,
): Promise<ScreenshotOutcome> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cua-'))
  try {
    const outPath = join(dir, 'capture.png')
    const request = supportsOutFile ? { ...payload, screenshot_out_file: outPath } : payload
    const run = await runCua(ctx, exec, pluginTool, cfg.exePath, [...argvTail, driverTool], request, graceMs)
    let parsed: unknown
    try {
      parsed = parseCallOutput(driverTool, run)
    } catch (error: unknown) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    const data: Record<string, unknown> = typeof parsed === 'object' && parsed !== null ? { ...(parsed as Record<string, unknown>) } : {}
    let image: CuaImageRef | null = null

    // Inline base64 screenshots still carry the image bytes; the `*_png_b64`
    // name is historical and the declared MIME type is authoritative.
    const inline = typeof data.screenshot_png_b64 === 'string'
      ? data.screenshot_png_b64
      : typeof data.screenshot_base64 === 'string' ? data.screenshot_base64 : null
    const writtenPath = typeof data.screenshot_file_path === 'string' ? data.screenshot_file_path : null
    let bytes: Buffer | null = null
    if (writtenPath !== null) bytes = await readFile(writtenPath)
    else if (inline !== null) bytes = Buffer.from(inline, 'base64')

    if (bytes !== null && ctx.attachments !== undefined) {
      const { mediaType, extension } = writtenPath !== null
        ? { mediaType: 'image/png', extension: 'png' }
        : screenshotMediaType(data)
      const name = `${driverTool}.${extension}`
      const ref = await ctx.attachments.saveImage({ data: bytes, mediaType, name })
      // The stored reference carries the verified intrinsic dimensions; a
      // synthesized one (null width/height) would break later image reads and
      // the request-size projection that consumes it.
      image = {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: ref.name ?? name,
      }
    } else if (ctx.attachments === undefined && (writtenPath !== null || inline !== null)) {
      // Profile without the attachment service: degrade to a pointer note.
      data._plugin_note = writtenPath !== null
        ? '当前 profile 无 attachment 服务；PNG 已写到驱动侧临时路径并即将清理。'
        : '当前 profile 无 attachment 服务；驱动返回的内联截图未被保存。'
    }
    return { value: { source: 'cua-driver', tool: driverTool, summary, data: data as never, image } }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// shared renderers

/** Render envelope text; images ride along as separate blocks. */
function renderValue(_args: unknown, value: CuaValue): Array<{ type: 'image'; attachment: LocalImageRef } | { type: 'text'; text: string }> {
  const blocks: Array<{ type: 'image'; attachment: LocalImageRef } | { type: 'text'; text: string }> = []
  if (value.image !== null) {
    blocks.push({ type: 'image', attachment: value.image })
  }
  const lines: string[] = [`cua ${value.tool}：${value.summary}`]
  const body = JSON.stringify(value.data, null, 1)
  if (body.length > 0 && body !== '{}') {
    lines.push(body.length > 12_000 ? `${body.slice(0, 12_000)}\n…（超长截断）` : body)
  }
  blocks.push({ type: 'text', text: lines.join('\n') })
  return blocks
}

/** Minimal structural mirror of a dsh image attachment reference. */
interface LocalImageRef {
  attachmentId: string
  mediaType: string
  bytes: number
  width: number
  height: number
  name: string
}

/** Structural saveImage contract — avoids importing the branded instance. */
interface AttachmentsLike {
  saveImage(input: { data: Buffer; mediaType: string; name: string }): Promise<{
    attachmentId: string
    mediaType: string
    bytes: number
    width: number
    height: number
    name?: string
  }>
}

/** Canonical output schema shared by every tool in this suite. */
interface CuaOutputSchema {
  type: 'object'
  additionalProperties: false
  properties: {
    source: { type: 'string'; required: true }
    tool: { type: 'string'; required: true }
    summary: { type: 'string'; required: true }
    data: { type: 'json'; required: true }
    image:
      | { type: 'null'; required: true }
      | {
          oneOf: [
            { type: 'null' },
            {
              type: 'object'
              additionalProperties: false
              properties: {
                attachmentId: { type: 'string' }
                mediaType: { type: 'string' }
                bytes: { type: 'number' }
                width: { type: 'number' }
                height: { type: 'number' }
                name: { type: 'string' }
              }
            },
          ]
          required: true
        }
  }
}

function outputSchema(hasImage: boolean): CuaOutputSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      source: { type: 'string', required: true },
      tool: { type: 'string', required: true },
      summary: { type: 'string', required: true },
      data: { type: 'json', required: true },
      image: hasImage
        ? {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attachmentId: { type: 'string' },
                  mediaType: { type: 'string' },
                  bytes: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  name: { type: 'string' },
                },
              },
            ],
            required: true,
          }
        : { type: 'null', required: true },
    },
  }
}

interface PassToolSpec {
  name: string
  driverName: string
  description: string
  parameters: Record<string, unknown>
  act: boolean
  buildPayload: (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** Optional client-side rewrite of parsed driver output before it reaches the value envelope. */
  transform?: (data: unknown) => unknown
  summarize?: (data: unknown, args: Record<string, unknown>) => string
  image?: boolean
  /** Whether the driver verb accepts `screenshot_out_file`; `zoom` returns inline base64 instead. */
  screenshotOutFile?: boolean
}

/** Register one passthrough tool bound to a driver verb. */
function registerPassTool(
  ctx: Context,
  cfg: ResolvedConfig,
  spec: PassToolSpec,
): void {
  const graceMs = Math.min(GRACE_MS, Math.floor(cfg.timeoutMs / 4))
  const runWithArgs = async (
    args: Record<string, unknown>,
    exec: { signal: AbortSignal },
    payload: Record<string, unknown>,
  ): Promise<CuaValue> => {
    if (spec.image === true) {
      const outcome = await callWithScreenshot(
        ctx as Parameters<typeof callWithScreenshot>[0],
        exec,
        cfg,
        spec.name,
        spec.driverName,
        ['call'],
        payload,
        spec.summarize?.(undefined, args) ?? '完成。',
        graceMs,
        spec.screenshotOutFile !== false,
      )
      return outcome.value
    }
    const run = await runCua(ctx, exec, spec.name, cfg.exePath, ['call', spec.driverName], payload, graceMs)
    let parsed: unknown = parseCallOutput(spec.driverName, run)
    if (spec.transform !== undefined) parsed = spec.transform(parsed)
    return {
      source: 'cua-driver',
      tool: spec.driverName,
      summary: spec.summarize?.(parsed, args) ?? defaultSummary(parsed),
      data: parsed as never,
      image: null,
    }
  }

  ctx.tools.register(defineOpaqueTool({
    name: spec.name,
    description: spec.description,
    // Built dynamically from PassToolSpec; written in the author DSL and
    // enforced by the runtime pipeline — see the defineOpaqueTool note.
    parameters: spec.parameters,
    timeoutMs: cfg.timeoutMs,
    output: { schema: outputSchema(spec.image === true), render: renderValue },
    async execute(rawArgs: unknown, exec: { signal: AbortSignal }) {
      const args = (rawArgs ?? {}) as Record<string, unknown>
      const payload = await spec.buildPayload(args)
      return runWithArgs(args, exec, payload)
    },
  }) as never)
}

/** Human-readable one-liner for action results (delivery/route/effect). */
function defaultSummary(data: unknown): string {
  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>
    const delivery = typeof record.delivery === 'object' && record.delivery !== null
      ? String((record.delivery as Record<string, unknown>).mode ?? '') : ''
    const parts = [
      record.route === undefined ? '' : `route=${String(record.route)}`,
      delivery === '' ? '' : `delivery=${delivery}`,
      record.effect === undefined ? '' : `effect=${String(record.effect)}`,
    ].filter((part) => part.length > 0)
    if (parts.length > 0) return `已完成（${parts.join(', ')}）。`
  }
  return '已完成。'
}

// ---------------------------------------------------------------------------
// public registration entry

/** Snapshot 参数上限：元素树会被模型端的 max_elements 夹紧。 */
export function registerCuaTools(
  ctx: Context,
  cfg: ResolvedConfig,
): void {
  const commonHint =
    '优先 element_token（来自最近一次 cua_window_state 的 elements[].element_token，携带窗口绑定且过期会显式报错）；'
    + '仅 canvas/视频/自绘表面才用像素坐标（窗口内坐标配 pid+window_id，桌面绝对坐标配 scope:"desktop"）。'

  // ---- observation -------------------------------------------------------

  registerPassTool(ctx, cfg, {
    name: 'cua_list_windows',
    driverName: 'list_windows',
    description:
      '列出系统全部顶层窗口（pid / window_id / 标题 / 边界 / 是否可见 / 是否最小化）。'
      + '这是几乎一切窗口操作的入口：先用它找到目标窗口的 pid 与 window_id。',
    parameters: {},
    act: false,
    buildPayload: () => ({}),
    transform: (data) => truncateRows(extractRows(data), cfg.maxRows).data ?? data,
    summarize: (data) => {
      const rows = extractRows(data)
      const capped = rows.slice(0, cfg.maxRows)
      const visible = capped.filter((row) => (row as { is_on_screen?: boolean }).is_on_screen === true).length
      const more = rows.length > capped.length ? `，其余 ${rows.length - capped.length} 条已截断` : ''
      return `共 ${rows.length} 个顶层窗口，返回 ${capped.length} 个（其中 ${visible} 个在屏上${more}）。`
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_list_apps',
    driverName: 'list_apps',
    description:
      '列出正在运行以及已安装未运行的应用（含 per-app 状态标志）。用于按应用名找 pid，再进入窗口级操作。',
    parameters: {},
    act: false,
    buildPayload: () => ({}),
    transform: (data) => truncateRows(extractRows(data), cfg.maxRows).data ?? data,
    summarize: (data) => {
      const rows = extractRows(data)
      const shown = Math.min(rows.length, cfg.maxRows)
      const more = rows.length > shown ? `，已截断` : ''
      return `共 ${rows.length} 个应用条目，返回 ${shown} 个${more}。`
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_window_state',
    driverName: 'get_window_state',
    description:
      '观察一个指定窗口：走无障碍元素树（Windows 下为 UIA、macOS 下为原生 Accessibility，协议一致），'
      + '返回结构化 elements 数组（element_token / role / label / frame / enabled）与 Markdown 树，'
      + '默认附带窗口截图作为 grounding。元素树为空（degraded）时说明该窗口是非无障碍表面，应改用像素路径。'
      + '任何后续动作都应基于最新快照的 element_token。',
    parameters: {
      pid: { type: 'number', required: true, description: '目标进程 id（来自 cua_list_windows / cua_list_apps）。' },
      window_id: { type: 'number', required: true, description: '目标窗口 id（必须属于该 pid）。' },
      query: {
        type: 'string',
        description: '大小写不敏感子串过滤：只保留匹配元素及其祖先链（原始 index 不变）。大树上先过滤再看。',
      },
      max_elements: { type: 'number', description: `最多遍历的元素节点数（默认 ${Math.min(500, cfg.maxElements)}，上限 ${cfg.maxElements}）。` },
      max_depth: { type: 'number', description: '元素树深度上限（默认 25）。菜单/Electron 深树可调低。' },
      include_screenshot: { type: 'boolean', description: '是否附带窗口截图（默认 true，作为坐标换算依据）。' },
    },
    act: false,
    image: true,
    buildPayload: (args) => {
      const pid = assertInt(args, 'pid', 0)
      const windowId = assertInt(args, 'window_id', 0)
      if (pid === undefined || windowId === undefined) throw new TypeError('cua_window_state: "pid" 和 "window_id" 为必填整数')
      const maxElements = Math.min(assertInt(args, 'max_elements', 1, 5_000) ?? Math.min(500, cfg.maxElements), cfg.maxElements)
      return compact({
        pid,
        window_id: windowId,
        query: typeof args.query === 'string' ? args.query.slice(0, 128) : undefined,
        max_elements: maxElements,
        max_depth: assertInt(args, 'max_depth', 1, 60),
        include_screenshot: typeof args.include_screenshot === 'boolean' ? args.include_screenshot : undefined,
        // Current drivers emit Markdown by default and only include the
        // structured `elements` rows this suite addresses by when an explicit
        // representation is requested.
        tree_format: 'both',
      })
    },
    summarize: (data) => {
      if (typeof data !== 'object' || data === null) return '快照完成。'
      const r = data as Record<string, unknown>
      const counts = `elements ${String(r.returned_element_count ?? '?')}/${String(r.total_element_count ?? '?')}`
      if (r.degraded === true) return `快照降级：${String(r.degraded_reason ?? '未知原因')}（${counts}）。${escalationHint(r.escalation)}`
      if (r.truncated === true) return `窗口快照完成（snapshot_id=${String(r.snapshot_id ?? '?')}，${counts}，达到 max_elements 上限已截断）。`
      return `窗口快照完成（snapshot_id=${String(r.snapshot_id ?? '?')}，${counts}）。`
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_desktop_screenshot',
    driverName: 'get_desktop_state',
    description:
      '截取整个主显示器（真实物理像素，无缩放）。返回图可作为 scope:"desktop" 像素操作的坐标系来源。',
    parameters: {},
    act: false,
    image: true,
    buildPayload: () => ({}),
    summarize: (data) => {
      if (typeof data === 'object' && data !== null) {
        const r = data as Record<string, unknown>
        return `桌面截图完成（${String(r.screen_width ?? '?')}×${String(r.screen_height ?? '?')}，scale=${String(r.scale_factor ?? '?')}）。`
      }
      return '桌面截图完成。'
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_zoom',
    driverName: 'zoom',
    description:
      '把窗口截图的一个矩形区域放大到原生分辨率返回。用 cua_window_state 的截图（缩放后像素）选 region，'
      + '看小字号/密集控件时使用；其后的像素动作可依赖驱动的 zoom 反解。',
    parameters: {
      pid: { type: 'number', description: '目标进程 id。' },
      window_id: { type: 'number', required: true, description: '目标窗口句柄。' },
      region: { type: 'array', required: true, description: '[x1, y1, x2, y2]，窗口截图（缩放后）像素。' },
    },
    act: false,
    image: true,
    screenshotOutFile: false,
    buildPayload: (args) => {
      const pid = assertInt(args, 'pid', 0)
      const windowId = assertInt(args, 'window_id', 0)
      if (windowId === undefined) throw new TypeError('cua_zoom: "window_id" 必填')
      const region = args.region
      if (!Array.isArray(region) || region.length !== 4 || !region.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
        throw new TypeError('cua_zoom: "region" 必须是 [x1,y1,x2,y2] 非负数字数组')
      }
      const [x1, y1, x2, y2] = region as [number, number, number, number]
      return compact({ pid, window_id: windowId, x1, y1, x2, y2 })
    },
    summarize: () => '区域放大完成。',
  })

  // ---- actions -----------------------------------------------------------

  registerPassTool(ctx, cfg, {
    name: 'cua_click',
    driverName: 'click',
    description:
      `在目标窗口上点击（左/右/中键，支持双击三击）。${commonHint} 默认后台投递：优先经无障碍 Invoke/action 路径不抢焦点，不可行时驱动会用结构化错误提示而不是强行切前台。`,
    parameters: {
      element_token: { type: 'string', description: '来自 cua_window_state 的元素句柄（推荐）。提供它就不要传坐标。' },
      pid: { type: 'number', description: '窗口目标的进程 id。' },
      window_id: { type: 'number', description: '窗口目标的句柄。' },
      scope: { type: 'string', enum: ['window', 'desktop'], description: 'scope:"desktop" 表示 x/y 是桌面绝对坐标（作用于最前台）。' },
      x: { type: 'number', description: '窗口本地截图像素（scope=window）或桌面物理像素（scope=desktop）。' },
      y: { type: 'number', description: '同 x。' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: '鼠标键，默认 left。' },
      count: { type: 'number', description: '连击次数 1–3（2 即双击）。' },
      delivery_mode: { type: 'string', enum: ['background', 'foreground'], description: '保持默认 background；收到 background_unavailable 类错误后才显式升级。' },
    },
    act: true,
    buildPayload: (args) => {
      if (args.count !== undefined) assertInt(args, 'count', 1, 3)
      const button = args.button
      if (button !== undefined && button !== 'left' && button !== 'right' && button !== 'middle') {
        throw new TypeError('cua_click: "button" 只能是 left/right/middle')
      }
      const extra: Record<string, unknown> = { ...resolveDeliveryMode(args) }
      if (args.from_zoom === true) extra.from_zoom = true
      if (button !== undefined) extra.button = button
      if (args.count !== undefined) extra.count = args.count
      return resolveActionTarget(args, extra)
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_type_text',
    driverName: 'type_text',
    description:
      `向目标写入 Unicode 文本。带 element_token 时经无障碍 SetValue 写入并回读校验；否则逐字符投递到窗口焦点控件。${commonHint}`,
    parameters: {
      text: { type: 'string', required: true, description: '要输入的文本（≤10000 字符）。' },
      element_token: { type: 'string', description: '目标输入框元素（推荐）。' },
      pid: { type: 'number', description: '窗口目标进程 id。' },
      window_id: { type: 'number', description: '窗口目标句柄。' },
      scope: { type: 'string', enum: ['window', 'desktop'], description: '"desktop" 表示输入到当前前台应用。' },
      delay_ms: { type: 'number', description: '字符间隔毫秒（默认 30，0–200）。' },
      delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
    },
    act: true,
    buildPayload: (args) => {
      const text = args.text
      if (typeof text !== 'string' || text.length === 0 || text.length > 10_000) {
        throw new TypeError('cua_type_text: "text" 必须是 1–10000 字符的字符串')
      }
      const extra: Record<string, unknown> = { text, ...resolveDeliveryMode(args) }
      const delay = assertInt(args, 'delay_ms', 0, 200)
      if (delay !== undefined) extra.delay_ms = delay
      return resolveActionTarget(compact({ ...args, text: undefined }), extra)
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_press_key',
    driverName: 'press_key',
    description:
      `按下一个单键（可带修饰键），送达目标窗口焦点元素。${commonHint}`,
    parameters: {
      key: { type: 'string', required: true, description: '键名：return/tab/escape/up/down/left/right/space/delete/home/end/pageup/pagedown/f1-f12/字母/数字。' },
      modifiers: { type: 'array', description: '修饰键数组，取值 ctrl/shift/alt/win。' },
      element_token: { type: 'string', description: '先聚焦该元素再按键。' },
      pid: { type: 'number', description: '窗口目标进程 id。' },
      window_id: { type: 'number', description: '窗口目标句柄。' },
      scope: { type: 'string', enum: ['window', 'desktop'], description: '"desktop" 送往当前前台应用。' },
      delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
    },
    act: true,
    buildPayload: (args) => {
      const key = args.key
      if (typeof key !== 'string' || key.length === 0 || key.length > 32) {
        throw new TypeError('cua_press_key: "key" 必须是 1–32 字符的键名')
      }
      const modifiers = args.modifiers
      if (modifiers !== undefined) {
        if (!Array.isArray(modifiers) || modifiers.length > 4 || !modifiers.every((m) => m === 'ctrl' || m === 'shift' || m === 'alt' || m === 'win')) {
          throw new TypeError('cua_press_key: "modifiers" 只能由 ctrl/shift/alt/win 组成（≤4 个）')
        }
      }
      const extra: Record<string, unknown> = { key, ...resolveDeliveryMode(args) }
      if (modifiers !== undefined) extra.modifiers = modifiers
      return resolveActionTarget(compact({ ...args, key: undefined, modifiers: undefined }), extra)
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_hotkey',
    driverName: 'hotkey',
    description:
      `同时按下组合键（如 ["ctrl","c"]；至少两键）。${commonHint}`,
    parameters: {
      keys: { type: 'array', required: true, description: '修饰键 + 一个普通键，例如 ["ctrl","shift","t"]。' },
      element_token: { type: 'string', description: '先聚焦该元素再触发组合键。' },
      pid: { type: 'number', description: '窗口目标进程 id。' },
      window_id: { type: 'number', description: '窗口目标句柄。' },
      scope: { type: 'string', enum: ['window', 'desktop'], description: '"desktop" 送往当前前台应用。' },
      delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
    },
    act: true,
    buildPayload: (args) => {
      const keys = args.keys
      if (!Array.isArray(keys) || keys.length < 2 || keys.length > 4 || !keys.every((k) => typeof k === 'string' && k.length >= 1 && k.length <= 24)) {
        throw new TypeError('cua_hotkey: "keys" 必须是 2–4 个键名字符串')
      }
      const extra: Record<string, unknown> = { keys, ...resolveDeliveryMode(args) }
      return resolveActionTarget(compact({ ...args, keys: undefined }), extra)
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_scroll',
    driverName: 'scroll',
    description:
      `滚动目标区域（方向 up/down/left/right，单位 line/page，默认 line×3）。窗口目标滚其焦点区域；desktop 目标需要屏幕绝对 x/y。${commonHint}`,
    parameters: {
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'number', description: '滚动刻度数 1–50，默认 3。' },
      by: { type: 'string', enum: ['line', 'page'], description: '滚动粒度，默认 line。' },
      pid: { type: 'number', description: '窗口目标进程 id。' },
      window_id: { type: 'number', description: '窗口目标句柄。' },
      scope: { type: 'string', enum: ['window', 'desktop'] },
      x: { type: 'number', description: 'desktop 目标时必填的屏幕像素坐标。' },
      y: { type: 'number', description: '同 x。' },
      delivery_mode: { type: 'string', enum: ['background', 'foreground'] },
    },
    act: true,
    buildPayload: (args) => {
      const direction = args.direction
      if (direction !== 'up' && direction !== 'down' && direction !== 'left' && direction !== 'right') {
        throw new TypeError('cua_scroll: "direction" 必填且只能是 up/down/left/right')
      }
      const amount = assertInt(args, 'amount', 1, 50)
      const by = args.by === 'line' || args.by === 'page' ? args.by : undefined
      const extra: Record<string, unknown> = { direction, ...resolveDeliveryMode(args) }
      if (amount !== undefined) extra.amount = amount
      if (by !== undefined) extra.by = by
      return resolveActionTarget(compact({ ...args, direction: undefined, amount: undefined, by: undefined }), extra)
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_set_value',
    driverName: 'set_value',
    description:
      '通过无障碍 SetValue 直接给控件赋值（比逐字输入更可靠）：必须提供来自最新 cua_window_state 的 element_token。赋值类型由控件原生类型自动转换，过期 token 显式报错。',
    parameters: {
      value: { type: 'string', required: true, description: '新值（≤4096 字符），驱动会按控件原生类型自动转换。' },
      element_token: { type: 'string', required: true, description: '来自 cua_window_state 的元素句柄（携带窗口绑定，过期 fail closed）。' },
      window_id: { type: 'number', description: '可选：显式绑定窗口句柄，缺省由 element_token 携带。' },
    },
    act: true,
    buildPayload: (args) => {
      const value = args.value
      if (typeof value !== 'string' || value.length > 4_096) {
        throw new TypeError('cua_set_value: "value" 必须是 ≤4096 字符的字符串')
      }
      const token = args.element_token
      if (typeof token !== 'string' || token.length === 0) {
        throw new TypeError('cua_set_value: 需要 element_token（来自最新 cua_window_state 快照）')
      }
      const windowId = assertInt(args, 'window_id', 0)
      return compact({ element_token: token, window_id: windowId, value })
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_verify_state',
    driverName: 'verify_state',
    description:
      '对一个窗口做确定性断言验证（最多 8 个谓词 AND 组合）：元素是否存在/启用/选中/值相等，或窗口边界是否匹配（容差 px）。'
      + '每个谓词结果是 satisfied / unsatisfied / unknown 三态，unknown 绝不会被当作成功。建议把它当作每次关键操作后的自检闭环。',
    parameters: {
      pid: { type: 'number', required: true, description: '目标进程 id。' },
      window_id: { type: 'number', required: true, description: '目标窗口句柄。' },
      expect: {
        type: 'array',
        required: true,
        description: '谓词数组（1–8 条），每条形如 {"element":{"selector":{"role":"Button","label_contains":"保存"},"exists":true}} 或 {"window":{"bounds":{...}}}。',
      },
    },
    act: false,
    buildPayload: (args) => {
      const pid = assertInt(args, 'pid', 0)
      const windowId = assertInt(args, 'window_id', 0)
      const expect = args.expect
      if (pid === undefined || windowId === undefined) throw new TypeError('cua_verify_state: "pid"/"window_id" 必填')
      if (!Array.isArray(expect) || expect.length < 1 || expect.length > 8 || !expect.every((p) => typeof p === 'object' && p !== null)) {
        throw new TypeError('cua_verify_state: "expect" 必须是 1–8 个谓词对象')
      }
      return { pid, window_id: windowId, expect }
    },
    summarize: (data) => {
      if (typeof data === 'object' && data !== null) {
        const r = data as Record<string, unknown>
        if (typeof r.summary === 'string') return r.summary
        // Current drivers report `predicates[].status` plus a top-level
        // `status`; older builds reported `results[].state`.
        const rows = Array.isArray(r.predicates) ? r.predicates as unknown[]
          : Array.isArray(r.results) ? r.results as unknown[] : []
        const stateOf = (row: unknown): string | undefined => {
          const record = row as { status?: unknown; state?: unknown }
          return typeof record.status === 'string' ? record.status : typeof record.state === 'string' ? record.state : undefined
        }
        const satisfied = rows.filter((row) => stateOf(row) === 'satisfied').length
        if (rows.length > 0) {
          const overall = typeof r.status === 'string' ? `总判定 ${r.status}，` : ''
          return `${overall}${satisfied}/${rows.length} 个谓词 satisfied。`
        }
      }
      return '验证完成。'
    },
  })

  registerPassTool(ctx, cfg, {
    name: 'cua_bring_to_front',
    driverName: 'bring_to_front',
    description: '把目标窗口激活到前台。仅在确需用户可见焦点时使用；后台投递路径通常不需要调用它。',
    parameters: {
      pid: { type: 'number', required: true, description: '目标进程 id。' },
      window_id: { type: 'number', description: '缺省取该 pid 第一个可见顶层窗口。' },
    },
    act: true,
    buildPayload: (args) => {
      const pid = assertInt(args, 'pid', 0)
      if (pid === undefined) throw new TypeError('cua_bring_to_front: "pid" 必填')
      return compact({ pid, window_id: assertInt(args, 'window_id', 0) })
    },
  })

  // cua_status 用的是 status 子命令而非 call，单独注册：
  ctx.tools.register(defineOpaqueTool({
    name: 'cua_status',
    description:
      '检查本机 cua-driver daemon 是否在线及运行模式。首次使用其它 cua_* 工具前建议先调用；离线时返回启动指引。',
    parameters: {},
    timeoutMs: cfg.timeoutMs,
    output: { schema: outputSchema(false), render: renderValue },
    async execute(_args: unknown, exec: { signal: AbortSignal }) {
      const graceMs = Math.min(GRACE_MS, Math.floor(cfg.timeoutMs / 4))
      const run = await runCua(ctx, exec, 'cua_status', cfg.exePath, ['status'], undefined, graceMs)
      const offline = run.exitCode !== 0 || /not running|cannot connect/i.test(run.stdout + run.stderr)
      return {
        source: 'cua-driver',
        tool: 'status',
        summary: offline ? `daemon 离线。${daemonSetupGuide()}` : 'daemon 在线。',
        data: { online: !offline, detail: stripCliNoise(run.stdout) },
        image: null,
      }
    },
  }) as never)
}

function escalationHint(escalation: unknown): string {
  if (typeof escalation === 'object' && escalation !== null) {
    const reason = (escalation as Record<string, unknown>).reason
    if (typeof reason === 'string') return reason
  }
  return ''
}
