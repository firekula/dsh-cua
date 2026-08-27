/**
 * dsh-cua 端到端测试：通过【已构建】的 dsh CLI 产物启动完整 web profile
 * （与 dsh-goz/e2e 相同的宿主接线），验证：
 *
 *  1. cua 条目出现在 loader 树且 fiber 为 ACTIVE
 *  2. 负向对照：未注册工具名被拒绝 —— 与后续成功执行互为证明
 *  3. cua_status 在线（daemon 需运行）
 *  4. cua_list_windows 返回结构化窗口行
 *  5. cua_window_state 参数校验缺参必须 isError；合法调用返回 snapshot 结构
 *  6. cua_desktop_screenshot 持久化图片 attachment 且 render 含 image 块
 *  7. click 缺目标时被参数校验拒绝（不发输入）
 *
 * 用法：node tests/e2e.mjs   （需 daemon 在线）
 */
import { readFileSync } from 'node:fs'

const CLI_LIB = 'C:/Users/Administrator/Desktop/dsh/deepseek-harness/apps/cli/lib'
const bootChunk = /profile-boot-[A-Za-z0-9_-]+\.js/.exec(readFileSync(`${CLI_LIB}/bin.js`, 'utf8'))?.[0]
if (bootChunk === undefined) throw new Error('e2e: cannot locate profile-boot chunk in dsh CLI lib')
const { runProfile } = await import(`file:///${CLI_LIB}/${bootChunk}`)
const { createLaunchEnvironmentSnapshot } = await import(
  'file:///C:/Users/Administrator/Desktop/dsh/deepseek-harness/packages/util/launch-environment/lib/index.js'
)

const FIBER = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING']

const { ctx } = await runProfile({
  environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]),
  profile: 'web',
  // 插件经 web profile 的 bundle 依赖自动 insert（profiles/web/node_modules/dsh-cua
  // → 本目录 link）。这里只叠加「关掉 webserver/前端」的诊断层。
  patchFiles: ['C:/Users/Administrator/Desktop/dsh/dsh-cua/tests/diag-noserver.patch.yml'],
  args: [],
})

let failures = 0
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      ${detail}`}`)
  if (!ok) failures += 1
}

async function runTool(name, args) {
  return ctx.tools.execute({
    callId: `e2e-${name}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    arguments: args,
    signal: AbortSignal.timeout(60_000),
  })
}

// 1. loader 树中的 cua 条目
{
  const rows = []
  for (const entry of ctx.loader.entries()) {
    const phase = entry.fiber === undefined ? 'NO-FIBER' : FIBER[entry.fiber.state]
    rows.push({ id: entry.id, name: entry.options.name, phase, disabled: entry.disabled === true })
  }
  const cua = rows.filter((r) => String(r.id).includes('cua') || String(r.name).includes('dsh-cua'))
  check('loader 树中存在 cua 条目', cua.length > 0, JSON.stringify(rows.map((r) => r.id)))
  for (const g of cua) {
    check(`cua fiber=${g.phase} disabled=${g.disabled}`, g.phase === 'ACTIVE' && !g.disabled, JSON.stringify(g))
  }
}

// 2. 负向对照
{
  const r = await runTool('definitely_not_a_registered_tool', {})
  check('未注册工具名被拒绝（负向对照）', r.isError === true, JSON.stringify(r).slice(0, 300))
}

// 3. status
{
  const r = await runTool('cua_status', {})
  const ok = r.isError === false && r.value?.data?.online === true
  check('cua_status 在线', ok, JSON.stringify(r).slice(0, 400))
}

// 4. list_windows
{
  const r = await runTool('cua_list_windows', {})
  const rows = Array.isArray(r.value?.data) ? r.value.data : (r.value?.data?._legacy_windows ?? [])
  check('cua_list_windows 返回窗口数组且非空',
    r.isError === false && Array.isArray(rows) && rows.length > 0 && typeof rows[0]?.pid === 'number',
    JSON.stringify(r.value?.summary ?? r).slice(0, 300))
  console.log(`      ${String(r.value?.summary ?? '')}`)
}

// 5. window_state 校验 + 正路
{
  const bad = await runTool('cua_window_state', { pid: 4 })
  check('cua_window_state 缺 window_id 被 isError 拒绝', bad.isError === true, JSON.stringify(bad).slice(0, 300))

  const wins = await runTool('cua_list_windows', {})
  const rows = Array.isArray(wins.value?.data) ? wins.value.data : (wins.value?.data?._legacy_windows ?? [])
  const target = rows.find((w) => w.is_on_screen === true) ?? rows[0]
  if (target === undefined) {
    check('cua_window_state 正路（无可用窗口，跳过执行段）', false)
  } else {
    const good = await runTool('cua_window_state', {
      pid: target.pid,
      window_id: target.window_id,
      include_screenshot: false,
      max_elements: 50,
    })
    check('cua_window_state 合法调用返回 snapshot 结构',
      good.isError === false
      && typeof good.value?.data?.snapshot_id === 'string'
      && Array.isArray(good.value.data.elements),
      JSON.stringify(good).slice(0, 500))
    console.log(`      ${String(good.value?.summary ?? '')}`)
  }
}

// 6. desktop screenshot + attachment
{
  const r = await runTool('cua_desktop_screenshot', {})
  const img = r.value?.image
  const ok = r.isError === false
    && img !== null && typeof img?.attachmentId === 'string'
    && Number(img?.bytes) > 1000
    && Array.isArray(r.content) && r.content.some((b) => b.type === 'image')
  check('cua_desktop_screenshot 附着 PNG 且 content 含 image 块', ok, JSON.stringify(r.value?.image ?? r).slice(0, 300))
  console.log(`      ${String(r.value?.summary ?? '')}`)
}

// 7. click 无目标 → 参数层 TypeError（不打扰真实桌面）
{
  const r = await runTool('cua_click', {})
  check('cua_click 缺目标被参数校验拒绝', r.isError === true, JSON.stringify(r).slice(0, 300))
}

// 8. verify_state 真实调用（只读 UIA）：用上一步窗口的真实边界做谓词，
//    容差 200px 内必 satisfied —— 钉死最复杂的一条透传链路，且零副作用。
{
  const wins = await runTool('cua_list_windows', {})
  const rows = Array.isArray(wins.value?.data) ? wins.value.data : (wins.value?.data?._legacy_windows ?? [])
  const t = rows.find((w) => w.is_on_screen === true && w.width > 0 && w.height > 0)
  if (t === undefined) {
    check('cua_verify_state 真实边界断言（无可测窗口，跳过）', false)
  } else {
    const r = await runTool('cua_verify_state', {
      pid: t.pid,
      window_id: t.window_id,
      expect: [{ window: { bounds: { x: t.x, y: t.y, width: t.width, height: t.height, tolerance_px: 200 } } }],
    })
    const verdict = JSON.stringify(r.value?.data ?? {})
    check('cua_verify_state 边界谓词 satisfied',
      r.isError === false && !verdict.includes('"satisfied":false') && verdict.length > 2,
      JSON.stringify(r.value?.summary ?? r).slice(0, 300))
    console.log(`      ${String(r.value?.summary ?? '')} ${verdict.slice(0, 160)}`)
  }
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exit(failures === 0 ? 0 : 1)
