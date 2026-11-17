/**
 * Compatibility harness: execute the built plugin through the real dsh
 * 0.2.2-rc.3 APIs (schema compilation, tool definitions) and the real
 * cua-driver daemon, without booting a full Harness.
 *
 * Verifies, for every registered tool:
 *  - the tool definition registers (defineTool compiled its author DSL),
 *  - its output schema is inside dsh-tools' enforced JSON-Schema subset,
 *  - a real driver round-trip returns a value that validates against that
 *    schema and renders to model-facing blocks,
 *  - the approval gate classifies action tools as `ask`.
 */
import { spawn } from 'node:child_process'
import { validateJsonSchemaValue, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'

const EXE = process.argv[2]
if (EXE === undefined) throw new Error('usage: node tests/compat.mjs <cua-driver.exe>')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`)
  if (!ok) failures += 1
}

/** dsh AttachmentStore.saveImage stand-in that reports the PNG's real dimensions. */
async function saveImage({ data, mediaType, name }) {
  const png = data[0] === 0x89 && data[1] === 0x50
  const width = png ? data.readUInt32BE(16) : 0
  const height = png ? data.readUInt32BE(20) : 0
  return { attachmentId: `sha256:${'0'.repeat(64)}`, mediaType, bytes: data.byteLength, width, height, name }
}

/** dsh subprocess Service stand-in implementing the spawn contract the client uses. */
function spawnHandle(spec) {
  const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, windowsHide: true })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))
  child.stdin.on('error', () => {})
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ exitCode: code, signal }))
  })
  const reader = (chunks) => ({
    readFrom: () => ({ text: Buffer.concat(chunks).toString('utf8'), nextOffset: 0, lossy: false }),
  })
  return {
    stdin: child.stdin,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
    done,
    terminate: () => { child.kill() },
    waitForExit: async () => true,
  }
}

const definitions = new Map()
const sections = []
const handlers = new Map()
const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  on: (event, handler) => { handlers.set(event, handler) },
  systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
  tools: { register: (definition) => { definitions.set(definition.name, definition); return () => {} } },
  attachments: { saveImage },
  subprocess: { spawn: spawnHandle },
}

apply(ctx, { binDir: '' })

console.log(`registered ${definitions.size} tools: ${[...definitions.keys()].sort().join(', ')}`)
check('注册 14 个工具', definitions.size === 14, String(definitions.size))
check('system prompt 段落已注册', sections.length === 1 && sections[0].name === 'tool:cua_*')
check('审批闸门监听已注册', handlers.has('tools/pre-execute'))

for (const definition of definitions.values()) {
  try {
    assertSupportedJsonSchema(definition.output.schema)
    check(`${definition.name}: 输出 schema 合法`, true)
  } catch (error) {
    check(`${definition.name}: 输出 schema 合法`, false, String(error))
  }
}

const signal = new AbortController().signal
const call = async (name, args) => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`tool ${name} is not registered`)
  const value = await definition.execute(args, { signal, callId: 'c1', rootCallId: 'c1', token: Symbol('t') })
  const violations = validateJsonSchemaValue(definition.output.schema, value, 'value')
  check(`${name}: 返回值符合输出 schema`, violations.length === 0, violations.join('; '))
  const blocks = definition.output.render(args, value)
  const image = blocks.find((block) => block.type === 'image')
  if (name === 'cua_window_state' || name === 'cua_desktop_screenshot' || name === 'cua_zoom') {
    check(`${name}: 图片块携带完整引用`, image !== undefined
      && typeof image.attachment.attachmentId === 'string'
      && typeof image.attachment.width === 'number'
      && typeof image.attachment.height === 'number'
      && typeof image.attachment.bytes === 'number', JSON.stringify(blocks[0]))
  }
  const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  return { value, text }
}

const status = await call('cua_status', {})
check('cua_status: daemon 在线', status.value.data.online === true, status.text.slice(0, 200))

const windows = await call('cua_list_windows', {})
const rows = windows.value.data.windows ?? windows.value.data.items ?? []
check('cua_list_windows: 返回窗口行', Array.isArray(rows) && rows.length > 0, windows.text.slice(0, 200))
const target = rows.find((row) => row.title && row.pid > 0) ?? rows[0]
check('cua_list_windows: 行含 pid/window_id/title', target?.pid > 0 && target?.window_id > 0)

await call('cua_list_apps', {})

const state = await call('cua_window_state', { pid: target.pid, window_id: target.window_id, max_elements: 40 })
check('cua_window_state: 返回结构化 elements', Array.isArray(state.value.data.elements) && state.value.data.elements.length > 0, state.text.slice(0, 300))
check('cua_window_state: element_token 形态 <snapshot>:N',
  /^s[0-9a-z]+:\d+$/.test(String(state.value.data.elements?.[0]?.element_token ?? '')), String(state.value.data.elements?.[0]?.element_token))

await call('cua_desktop_screenshot', {})
await call('cua_zoom', { pid: target.pid, window_id: target.window_id, region: [0, 0, 240, 160] })

const verify = await call('cua_verify_state', { pid: target.pid, window_id: target.window_id, expect: [{ window: { exists: true } }] })
check('cua_verify_state: 汇总读到 satisfied', verify.text.includes('satisfied'), verify.text.slice(0, 200))

// Stale/unknown token must surface as an error, never as silent success.
try {
  await call('cua_click', { element_token: 's00000099:7' })
  check('cua_click: 过期 token 显式报错', false, 'returned success')
} catch (error) {
  check('cua_click: 过期 token 显式报错', /stale_element_token|stale/i.test(String(error)), String(error))
}

// Argument validation happens in the plugin before any input is sent.
try {
  await call('cua_set_value', { value: 'x' })
  check('cua_set_value: 缺 element_token 时拒绝', false, 'returned success')
} catch (error) {
  check('cua_set_value: 缺 element_token 时拒绝', /element_token/.test(String(error)), String(error))
}

const gate = handlers.get('tools/pre-execute')
const askClick = await gate({ name: 'cua_click', arguments: { element_token: 's00000002:1' } }, async () => ({ kind: 'allow' }))
check('审批闸门：动作类返回 ask', askClick.kind === 'ask' && typeof askClick.reason === 'string', JSON.stringify(askClick))
const allowRead = await gate({ name: 'cua_list_windows', arguments: {} }, async () => ({ kind: 'allow' }))
check('审批闸门：观察类放行', allowRead.kind === 'allow', JSON.stringify(allowRead))

// Optional live-action leg (`--actions`): drives a scratch Notepad through
// element-token addressing so type/verify are exercised for real, then closes
// it through the driver's own kill_app.
if (process.argv.includes('--actions')) {
  const rawCall = (tool, payload) => new Promise((resolve, reject) => {
    const child = spawn(EXE, ['call', tool], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const out = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.on('error', reject)
    child.on('close', () => {
      const text = Buffer.concat(out).toString('utf8').split(/\r?\n/).filter((line) => !/telemetry/i.test(line)).join('\n')
      try { resolve(JSON.parse(text)) } catch { reject(new Error(text.slice(0, 300))) }
    })
    child.stdin.end(JSON.stringify(payload), 'utf8')
  })

  const launched = await rawCall('launch_app', { name: 'notepad.exe' })
  const noteWindow = (launched.windows ?? []).find((row) => row.title && row.pid === undefined) ?? (launched.windows ?? [])[0]
  const notePid = launched.pid
  check('动作：notepad 启动并返回窗口', notePid > 0 && noteWindow !== undefined, JSON.stringify(launched).slice(0, 300))

  try {
    if (noteWindow !== undefined) {
      const noteState = await call('cua_window_state', { pid: notePid, window_id: noteWindow.window_id, max_elements: 150 })
      const rows = noteState.value.data.elements ?? []
      const editable = rows.find((row) => /Edit|Document|TextArea/i.test(String(row.role ?? '')))
      check('动作：元素树含可编辑目标', editable !== undefined, JSON.stringify(rows.map((row) => row.role)).slice(0, 300))

      if (editable !== undefined) {
        const typed = await call('cua_type_text', { element_token: editable.element_token, text: 'dsh-cua compat check' })
        check('动作：type_text 成功', typed.value.data !== undefined, typed.text.slice(0, 200))
        const after = await call('cua_verify_state', {
          pid: notePid,
          window_id: noteWindow.window_id,
          expect: [{ element: { selector: { role: String(editable.role) }, value_equals: 'dsh-cua compat check' } }],
        })
        check('动作：verify_state 断言文本写入', after.text.includes('satisfied'), after.text.slice(0, 300))
      }
    }
  } finally {
    await rawCall('kill_app', { pid: notePid }).catch(() => {})
  }
}

console.log(failures === 0 ? '\n兼容性验证全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
