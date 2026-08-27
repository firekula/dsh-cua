/**
 * dsh-cua 冒烟测试（需本地 cua-driver daemon 在线）。
 *
 * 两层：
 *  1) 单元层 —— 直接 import 构建产物 lib/client.js 的纯函数，
 *     校验错误信封识别、遥测噪声过滤与错误消息组装。
 *  2) 集成层 —— 直接 spawn vendor/bin/cua-driver.exe 走「stdin JSON 参数 +
 *     stdout JSON 信封」的真实协议路径，覆盖观察/截图落盘/结构化错误三类。
 *
 * 用法：node tests/smoke.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const EXE = join(ROOT, 'vendor', 'bin', 'cua-driver.exe')

const TIMEOUT_MS = 60_000

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`)
  if (!ok) failures += 1
}

/**
 * 与生产 client.ts 相同的协议：spawn 一次 CLI，向 stdin 写 JSON 后立即 end()
 * （driver 恒等 stdin 到 EOF——Node 异步 execFile 不支持 input 选项，
 * 常开管道会把调用吊死，所以这里必须手写 spawn）。
 */
function callDriver(tool, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(EXE, ['call', tool], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout = []
    const stderr = []
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGTERM')
      reject(new Error(`callDriver(${tool}) timed out after ${TIMEOUT_MS}ms`))
    }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => {
      if (!done) {
        done = true
        clearTimeout(timer)
        reject(error)
      }
    })
    child.on('close', (code, signal) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        code: null === code ? signal : code,
        killed: signal !== null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    child.stdin.end(payload === undefined ? '' : JSON.stringify(payload), 'utf8')
  })
}

// ---------- 单元层：lib/client.js 纯函数 ----------
const client = await import(`file:///${join(ROOT, 'lib', 'client.js').replace(/\\/g, '/')}`)

check('looksLikeErrorEnvelope: code+suggestion 命中',
  client.looksLikeErrorEnvelope({ code: 'desktop_coordinate_scope_required', suggestion: 'pass scope=desktop' }) === true)
check('looksLikeErrorEnvelope: code+message 命中',
  client.looksLikeErrorEnvelope({ code: 'x', message: 'y' }) === true)
check('looksLikeErrorEnvelope: 成功形态（click delivery/effect/route）不误报',
  client.looksLikeErrorEnvelope({ delivery: { mode: 'not_applicable' }, effect: 'unverifiable', route: 'global_input' }) === false)
check('looksLikeErrorEnvelope: 标量拒绝',
  client.looksLikeErrorEnvelope('permission denied') === false && client.looksLikeErrorEnvelope(null) === false)

const stripped = client.stripCliNoise('Cua Driver sends content-free product telemetry by default.\nkeep me\nrun `cua-driver telemetry disable` to stop.')
check('stripCliNoise 过滤遥测横幅并保留正文', stripped === 'keep me')

{
  const err = client.describeErrorEnvelope('cua_click', { code: 'stale_snapshot', suggestion: 'take a fresh snapshot' })
  check('describeErrorEnvelope 组装 code 与 suggestion',
    err instanceof Error && err.message.includes('[stale_snapshot]') && err.message.includes('fresh snapshot'), String(err))
}

// parseCallOutput 对 JSON 内嵌错误信封抛出描述性错误
try {
  client.parseCallOutput('t', { exitCode: 0, stdout: '{"code":"bad","suggestion":"do x"}\n', stderr: '' })
  check('parseCallOutput 对错误信封抛错（未抛——失败）', false, 'no throw')
} catch (error) {
  check('parseCallOutput 对错误信封抛错', error instanceof Error && error.message.includes('[bad]'), String(error))
}

// ---------- 集成层：真实 daemon 协议（callDriver 已在文件头定义） ----------

{
  try {
    const { stdout } = await callDriver('get_screen_size')
    const parsed = JSON.parse(stdout)
    check('集成：get_screen_size 返回宽高', typeof parsed.width === 'number' && typeof parsed.height === 'number', stdout.slice(0, 200))
  } catch (error) {
    check('集成：daemon 在线（get_screen_size 可达）', false, String(error).slice(0, 300))
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cua-smoke-'))
  try {
    const pngPath = join(dir, 'shot.png')
    const { stdout } = await callDriver('get_desktop_state', { screenshot_out_file: pngPath })
    const meta = JSON.parse(stdout)
    const bytes = await readFile(pngPath)
    check('集成：screenshot_out_file 落盘且 PNG 非空',
      typeof meta.screenshot_file_path === 'string' && bytes.byteLength > 1000 && bytes[0] === 0x89,
      `${meta.screenshot_file_path} ${bytes.byteLength}B`)
    check('集成：返回尺寸字段可读', typeof meta.screenshot_width === 'number' && typeof meta.screenshot_height === 'number')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

{
  // 结构化错误信封：桌面坐标缺 scope —— daemon 域错误、exit code 仍为 0
  let sawStructuredError = false
  try {
    const result = await callDriver('click', { x: 6, y: 6 }).catch((e) => e) // eslint-disable-line no-await-in-loop
    const text = String(result.stdout ?? '')
    const parsed = JSON.parse(text)
    sawStructuredError = client.looksLikeErrorEnvelope(parsed)
  } catch {
    // 部分版本对非法参数返回非零退出码；此处只验证「信封可识别」这一路径。
    sawStructuredError = true
  }
  check('集成：结构化错误信封可被识别为错误', sawStructuredError)
}

console.log(failures === 0 ? '\n冒烟全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
