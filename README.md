# dsh-cua

**DeepSeek Harness 的计算机控制（Computer Use）插件：把本机 [cua-driver](https://github.com/trycua/cua) daemon 的 63 个原语浓缩成 14 个模型工具——UIA 元素级寻址、默认后台投递不抢焦点、结构化错误、窗口/桌面截图直挂 attachment。**

`dsh-cua` 是一个 Cordis 插件，零 MCP、零原生模块：每次工具调用按 dsh-goz 同款模式 spawn 一次自带的 `cua-driver.exe` CLI，经 stdin 送 JSON 参数、从 stdout 收 JSON 结果；真正的状态（UIA 快照、会话、权限策略）全部常驻在 `\\.\pipe\cua-driver` 后面的 Rust daemon 里。

> 兼容目标：DeepSeek Harness `0.1.x`（web profile），cua-driver `0.22.1`（Windows x86_64 二进制已打进 `vendor/bin/`）。仅支持 Windows。

## 与 @crazy_th/dsh-computer-use 的关系

两者定位不同，可以共存：

| | @crazy_th/dsh-computer-use | **dsh-cua（本插件）** |
|---|---|---|
| 执行模型 | 每动作 spawn PowerShell + 内联 C# P/Invoke | 常驻 cua-driver daemon，CLI 仅作一次性信使 |
| 目标寻址 | 无目标概念，输入发给 OS 当前焦点窗口 | pid / window_id / element_token 三级寻址 |
| 后台操作 | 不可能（抢焦点） | 默认 background delivery（UIA hit-test → InvokePattern），失败时结构化报错引导显式升级 foreground |
| 元素交互 | 纯像素坐标 | UIA 树快照 + InvokePattern / ValuePattern |
| 操作后验证 | 无 | `cua_verify_state` 谓词断言（satisfied / unsatisfied / unknown 三态） |
| 浏览器 | 无 | 驱动侧含 CDP 绑定（本插件暂未暴露，见路线图） |

## 安装

### 方式 A：`dsh plugin add`（官方命令）

```powershell
dsh plugin --profile web add link:C:/path/to/dsh-cua
```

该命令在 profile 内转发给 pnpm，效果与方式 B 等价。

### 方式 B：手动 link（本仓库的实际交付路径，已验证）

编辑 `~/.dsh/profiles/web/package.json`，在 `dsh.profile.bundles` 数组加入 `"dsh-cua"`，在 `dependencies` 加入：

```json
"dsh-cua": "link:C:/Users/Administrator/Desktop/dsh/dsh-cua"
```

然后在 profile 目录执行 `pnpm install --ignore-scripts`。装完后 `dsh-cua` 会以符号链接出现在 `~/.dsh/profiles/web/node_modules/`，bundle 层自动 insert 插件（无需改 `cordis.patch.yml`）。

### 启动 daemon

```powershell
cua-driver serve            # 前台运行
cua-driver autostart enable # 登录自启（Windows 计划任务）
```

重启 `dsh web` 后即可。若没有全局 cua-driver，可直接用插件自带副本：

```powershell
& "C:\path\to\dsh-cua\vendor\bin\cua-driver.exe" serve
```

### 验证安装

```powershell
dsh --profile web --dump-config
# 输出中应包含 id: cua / name: dsh-cua 的插件条目
```

在对话里让 agent「列出当前所有窗口并截图看看桌面上有什么」即为通。

## 工具一览

### 观察（不弹审批）

| 工具 | 参数要点 | 用途 |
|---|---|---|
| `cua_status` | — | daemon 是否在线；离线时附启动指引 |
| `cua_list_windows` | — | 全部顶层窗口：pid / window_id / 标题 / 边界 / 可见性 |
| `cua_list_apps` | — | 正在运行 + 已安装的应用清单（找 pid 用） |
| `cua_window_state` | `pid`, `window_id`, `query?`, `max_elements?`, `max_depth?`, `include_screenshot?=true` | UIA 元素树快照：结构化 elements（element_token/role/label/frame）+ Markdown 树 + 窗口截图 |
| `cua_desktop_screenshot` | — | 主显示器全屏截图（真实物理像素，desktop 像素坐标的坐标系来源） |
| `cua_zoom` | `window_id`, `region=[x1,y1,x2,y2]` | 放大窗口截图局部区域（小字号/密集控件） |
| `cua_verify_state` | `pid`, `window_id`, `expect(1–8 谓词)` | 确定性断言：元素存在/启用/选中/值相等、窗口边界（容差 px）；unknown 永不代表成功 |

### 操作（默认每次弹审批面板）

| 工具 | 参数要点 |
|---|---|
| `cua_click` | `element_token` 或（`pid`+`window_id`+`x,y`）或（`scope:"desktop"`+屏幕坐标）；`button`/`count`(1–3 双击三击)/`delivery_mode` |
| `cua_type_text` | `text`(≤10000)；带 token 经 ValuePattern 写入并回读校验；`delay_ms`(0–200) |
| `cua_press_key` | `key` + 可选 `modifiers[]`（ctrl/shift/alt/win） |
| `cua_hotkey` | `keys`(2–4 键组合，如 `["ctrl","shift","t"]`) |
| `cua_scroll` | `direction`(up/down/left/right)、`amount`(1–50)、`by`(line/page) |
| `cua_set_value` | 通过 UIA ValuePattern 直接赋值（比逐字输入可靠）：token 或 index 四元组 |
| `cua_bring_to_front` | 激活窗口到前台（后台投递路径通常无需调用） |

### 寻址规则（模型可见提示词同步教了这套）

1. **首选 element_token** —— 来自最近一次 `cua_window_state` 的 `elements[].element_token`，携带窗口绑定、过期显式报错（fail closed）。
2. **像素坐标只留给非 UIA 表面**（canvas/视频/自绘）：窗口内坐标 = 该窗口最近一次截图的（缩放后）像素；桌面绝对坐标 = `scope:"desktop"` + `cua_desktop_screenshot` 的物理像素。
3. 非法组合在插件参数层直接 TypeError 拒绝，不会发出任何输入。

## 配置

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml —— 按 id 覆盖即可
- id: cua
  config:
    requireApproval: true   # 每个动作前向用户弹审批面板
    disabled: false         # true = 整个套件不注册任何工具
    timeoutMs: 15000        # 协作式工具超时预算（2000–120000）
    maxElements: 200        # 单次快照转发的 UIA 元素上限（20–5000）
    maxRows: 120            # list_windows/list_apps 单次转发行数上限（10–1000）
    binDir: ""              # 自定义 cua-driver.exe 目录；留空用 vendor/bin/
```

也可用环境变量 `CUA_DRIVER_BIN` 直接指定驱动可执行文件。

## 安全模型（双层闸门）

1. **插件层（dsh 习惯）**：所有观察类工具静默放行；七个动作类工具在 `tools/pre-execute` 返回 `ask` 决策，由 dsh 原生审批面板呈现「做什么 + 打到哪个窗口」，用户可拒绝。`requireApproval: false` 可关掉这一层。
2. **驱动层（cua-driver 原生）**：daemon 自身维护 permission mode（standard/bounded/unrestricted）、session 授权租约、capability manifest 与 revoke 命令；即使插件层被绕过，驱动策略仍在。默认 standard 模式对每个调用做风险分类。

driver 默认发送内容无关遥测；介意可在终端执行 `cua-driver telemetry disable`（与本插件运行无关的一次性设置）。

## 架构

```
┌──────────────┐  ctx.subprocess.spawn(一次性)   ┌────────────────┐  \\.\pipe\cua-driver  ┌───────────────┐
│ dsh agent    │ ── cua_click {"element_token":…} ─▶│ cua-driver.exe │ ── stdin JSON / JSON ──▶│ cua-daemon(RS)│
│ (模型工具)    │ ◀─ {summary,data,image}          │  (CLI 信使)     │ ◀───────────────────────│ UIA/CDP/输入  │
└──────────────┘                                  └────────────────┘                         └───────────────┘
      ▲                                                    │ PNG(screenshot_out_file)
      └── attachments.saveImage ← readFile ← 临时目录 ◀────┘
```

- **协议细节**：driver 的 `call` 无论有无参数都会读 stdin 到 EOF——客户端必须显式关闭 stdin（生产 client 用 `stdin:'pipe'+end()`；这也是用 Node 异步 execFile 直接调它会吊死的原因）。
- **错误信封**：域级错误（如 stale snapshot、坐标缺 scope）以 `{code,suggestion}` JSON 打在 stdout 且 exit code 为 0；退出码只在进程级失败时生效。client.ts 的 `parseCallOutput` 据此把两类失败统一映射成模型可读消息。
- **诚实位**：list 类超限截断时改写返回并在 summary 注明总数；快照降级（degraded/degraded_reason）与 escalation 提示原样透传，模型永远知道看到了什么、缺什么。

## 开发

```sh
npm run build            # tsc 编译 src/ → lib/
node tests/smoke.mjs     # 冒烟：纯函数单测 + 真实 CLI 协议集成（需 daemon 在线）
node tests/e2e.mjs       # 完整 web profile 启动，验证 loader 树/工具执行/attachment（需 daemon 在线）
```

e2e 通过已构建的宿主 CLI（`deepseek-harness/apps/cli/lib`）启动真实 profile 树，插件必须先以 link 方式装进 profile（见上文安装）。

类型边界说明：`src/tools.ts` 以局部结构镜像（CuaValue/CuaImageRef + 手写 DSL 字面量）创作工具选项，仅在 `defineOpaqueTool` 一处收窄交给宿主——workspace 同时存在多份同名名义类型的实例，全面泛型推断既会锁死身份又会触发 TS 递归深度上限；schema 本体仍完全是 author DSL 并由运行时管线强制校验。

## 已知限制 / 路线图

- 仅 Windows（随驱动能力面）；macOS/Linux 待上游 driver 支持后在 argv 层自然解封。
- 未暴露驱动的浏览器 CDP 工具组（browser_navigate/click/type/dialog/download）与应用生命周期组（launch_app/invoke_menu）——加进 PassToolSpec 即一行注册的事，欢迎 PR。
- 多显示器只覆盖主屏（跟随驱动当前 release 行为）。
- cua-driver 桌面 App/技能包生态（skills install）与本插件互不影响，可并行使用。

## License

MIT。vendor/bin 内的 cua-driver 二进制来自 [trycua/cua](https://github.com/trycua/cua) 上游 release（依其 LICENSE 分发）。
