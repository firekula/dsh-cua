# dsh-cua

**DeepSeek Harness（DSH）的计算机控制插件：让 agent 安全地看见并操作这台电脑——无障碍元素级定位、默认后台投递不抢焦点、每一步可审批、可验证。**

由 [cua-driver](https://github.com/trycua/cua)（trycua 开源的跨平台 computer-use 驱动，支持 macOS / Windows / Linux）提供底层能力：插件把驱动的原子操作封装成 14 个模型工具，全部走 DSH 原生的工具注册、审批面板与图片附件体系，不依赖 MCP。

> 上游驱动是同一套跨平台协议（元素树 Windows 下经 UIA、macOS 下经原生 Accessibility）。本插件自带 Windows x86_64 驱动二进制（`vendor/bin/`），开箱即用；macOS / Linux 经上游安装器全局安装驱动后由插件自动解析（macOS 的 TCC 授权绑定安装位置，自带二进制会被系统拒绝，故走安装器固定位置）。

## 能力

**给 agent 的 14 个工具**（观察类静默放行；动作类默认弹审批面板）：

| 工具 | 说明 |
|---|---|
| `cua_status` | 驱动 daemon 是否在线；离线附启动指引 |
| `cua_list_windows` / `cua_list_apps` | 顶层窗口清单（pid / window_id / 标题 / 边界）；运行中与已安装应用清单 |
| `cua_window_state` | 指定窗口的无障碍元素树快照：结构化 elements（`element_token`/role/label/frame）+ Markdown 树 + 窗口截图 |
| `cua_desktop_screenshot` | 主屏全屏截图（真实物理像素） |
| `cua_zoom` | 放大窗口截图的局部区域（小字号 / 密集控件） |
| `cua_verify_state` | 操作后断言验证：元素存在/启用/选中/值相等、窗口边界（容差 px）；结果三态 satisfied / unsatisfied / unknown，unknown 永不当作成功 |
| `cua_click` / `cua_type_text` / `cua_press_key` / `cua_hotkey` / `cua_scroll` | 点击（左/右/中、双击三击）、输入文本、按键、组合键、滚动——目标可以是元素 token、窗口像素或桌面坐标 |
| `cua_set_value` | 经无障碍 SetValue 直接给控件赋值（比逐字键入可靠，写入后回读校验） |
| `cua_bring_to_front` | 把窗口带到前台（后台投递路径通常用不到） |

**寻址优先级**（与驱动一致的推荐工作流）：

1. 优先 `element_token`——来自最近一次 `cua_window_state`，携带窗口绑定，快照过期会显式报错（fail closed），不会静默点错地方；
2. 像素坐标只留给 canvas / 视频 / 自绘表面等非 UIA 区域（窗口内坐标基于该窗口的截图，桌面坐标基于 `cua_desktop_screenshot`）；
3. 非法参数组合在插件层直接拒绝，不会发出任何输入。

**给用户的保证**：截图作为图片附件进入会话（agent 看到的就是它用来定坐标的那张图）；列表截断、快照降级等不完整状态都会如实上报；每个动作前审批面板写明「做什么、打到哪个窗口」。

## 工作方式

一次工具调用 = spawn 一次驱动 CLI（stdin 送 JSON、stdout 收 JSON），实际状态常驻本地 daemon 里（端点按平台不同：macOS `~/Library/Caches/cua-driver/cua-driver.sock`，Linux `~/.cache/cua-driver/cua-driver.sock`，Windows `\\.\pipe\cua-driver`）。CLI 进程无状态、崩溃即隔离，绝不把 harness 拖下水；驱动的域级错误（如快照过期）以结构化信封返回并转成模型可读消息。

因为每次调用都是独立进程，插件给整套工具用一个按 harness 进程号生成的驱动 session 标签（`dsh-cua-<pid>`）：一次 `cua_window_state` 产生的快照 / zoom 上下文能被后续调用继续使用，同时不会和另一个并发 harness 串台。截图有两条落地路径：窗口与桌面状态由驱动按 `screenshot_out_file` 直接写文件，`cua_zoom` 则由驱动返回内联 base64，插件解码后同样存入 dsh 图片附件。

## 兼容性

- **DSH**：声明 `engines.dsh` 为 `>=0.2.2-rc.3 <0.3.0`，按 0.2.2-rc.3 的工具注册 / 输出 schema / 审批闸门 / attachment / subprocess 接口验证（含 `tests/compat.mjs`）。
- **驱动**：自带 Windows x64 驱动 `0.37.0`（`vendor/bin/windows-x86_64`），与当前 daemon 协议一致；daemon 需由同版本或兼容版本的 `cua-driver serve` 提供。
- 工具契约按驱动 0.37 对齐：`get_window_state` 显式请求 `tree_format:"both"` 才返回结构化 `elements`；`zoom` 用内联截图；`set_value` 只接受 `element_token`；`verify_state` 的新旧结果形态都能读。

## 示例输出

**以下为构造的示例数据**，仅用于展示输出形态（非真实采集）。

`cua_window_state`（节选）——模型拿到 summary、结构化 `elements`，截图作为图片附件随行：

```jsonc
{
  "source": "cua-driver",
  "tool": "get_window_state",
  "summary": "窗口快照完成（snapshot_id=s00000042，elements 88/88）。",
  "data": {
    "snapshot_id": "s00000042",
    "total_element_count": 88,
    "returned_element_count": 88,
    "elements": [
      { "index": 0,  "element_token": "s00000042:0",  "role": "Window", "label": "示例计算器" },
      { "index": 17, "element_token": "s00000042:17", "role": "Button", "label": "7", "frame": { "x": 24,  "y": 210, "w": 72, "h": 56 }, "enabled": true },
      { "index": 21, "element_token": "s00000042:21", "role": "Button", "label": "+", "frame": { "x": 184, "y": 210, "w": 72, "h": 56 }, "enabled": true },
      { "index": 30, "element_token": "s00000042:30", "role": "Edit",   "label": "结果", "value": "0", "enabled": true }
    ]
  },
  "image": { "attachmentId": "sha256:9f2c…", "mediaType": "image/png", "bytes": 48213, "width": 960, "height": 1240, "name": "get_window_state.png" }
}
```

随后点「7」并断言结果框的值——动作先过审批面板，验证给确定性闭环：

```text
cua_click { "element_token": "s00000042:17" }
  → 审批面板「dsh-cua 请求执行「鼠标点击」（目标：元素 s00000042:17）」→ 允许 → {}

cua_verify_state { "pid": 4242, "window_id": 197001, "expect": [
    { "element": { "selector": { "role": "Edit", "label_contains": "结果" }, "value_equals": "7" } }] }
  → { "predicates": [ { "status": "satisfied" } ], "status": "satisfied" }
```

断言读不到目标时返回 `unknown` 并如实说明——`unknown` 永不当作成功。

## 安装

**前置**：一个带 profile 的 DSH 部署；驱动 daemon 在线。

```sh
# macOS：先全局安装驱动（装到 ~/.local/bin 并接入 PATH），再授权、启动
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver permissions grant   # 辅助功能 + 屏幕录制，每个 macOS 会话只需一次
cua-driver serve               # 或 cua-driver autostart enable 注册登录自启

# Linux：同款安装脚本，然后启动
/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"
cua-driver serve

# Windows（PowerShell）：自带二进制开箱即用
vendor\bin\windows-x86_64\cua-driver.exe serve
# 或全局安装后：cua-driver serve（或 cua-driver autostart enable 注册登录自启）
```

```sh
dsh plugin --profile web add github:hfyydd/dsh-cua
# 或本地开发版：dsh plugin --profile web add link:/path/to/dsh-cua
# 或从打包产物安装：dsh plugin --profile web add file:C:/path/to/dsh-cua-0.2.0.tgz
```

插件的 bundle patch 会自动挂载，无需手改组合配置。**重启 `dsh web`** 后验证：

```sh
dsh --profile web --dump-config   # 输出应包含 id: cua / name: dsh-cua
```

在对话里让 agent「列出当前所有窗口，截个图看看桌面上有什么」即为通。

## 配置

可选，在 profile 的 `cordis.patch.yml` 按 id 覆盖：

```yaml
- id: cua
  config:
    requireApproval: true   # 每个动作前弹审批面板（false 可关闭插件层审批）
    disabled: false         # true = 不注册任何工具
    timeoutMs: 15000        # 工具协作式超时（2000–120000）
    maxElements: 200        # 单次快照转发的元素上限（20–5000）
    maxRows: 120            # list_windows/list_apps 单次转发行数上限（10–1000）
    binDir: ""              # 自定义驱动二进制目录；留空按优先级解析
```

驱动二进制解析优先级：`binDir` 配置 → 环境变量 `CUA_DRIVER_BIN` → 插件自带副本（Windows x64）→ `PATH` 上的全局 `cua-driver`。macOS / Linux 没有自带副本（TCC 授权绑定安装位置，见上），请用上游安装器全局安装或用前两种方式显式指定。

## 安全模型

双层闸门，缺一仍可拦截：

1. **插件层**：七个动作类工具经 `tools/pre-execute` 返回 `ask` 决策，由 DSH 原生审批面板呈现并可拒绝；观察类只读不拦截。
2. **驱动层（cua-driver 原生）**：daemon 维护 permission mode（standard / bounded / unrestricted）、session 授权租约、capability manifest 与 `revoke` 命令——即使插件层被绕过，驱动策略仍然生效。

cua-driver 默认发送内容无关遥测，介意可在终端执行一次 `cua-driver telemetry disable`（与本插件无关的全局设置）。

## 开发

```sh
npm install
npm run build          # tsc：src/ → lib/
node tests/smoke.mjs   # 冒烟：纯函数单测 + 真实 CLI 协议集成（集成层需驱动二进制与 daemon，缺失时自动跳过）
node tests/compat.mjs vendor/bin/windows-x86_64/cua-driver.exe   # 兼容性：真实 dsh 0.2 API + 真实驱动的 14 工具往返；加 --actions 会驱动一个临时记事本验证输入与断言
node tests/e2e.mjs     # 完整 web profile 启动，验证 loader 树 / 工具执行 / 图片附件（需 daemon 在线）
```

## 已知限制

- 插件自带二进制的平台：Windows x64；macOS 与 Linux 走全局驱动（上游 `install.sh`）。
- 自带驱动版本为 `0.37.0`；驱动 daemon 必须来自同一版本线，否则 CLI 会报 contract 版本不匹配（插件会把该错误原样转给模型）。
- 多显示器暂只覆盖主屏（跟随上游当前版本行为）。
- 驱动的浏览器 CDP 工具组（browser_navigate / browser_click 等）与应用生命周期组（launch_app / invoke_menu）尚未注册，欢迎 PR——往 `PassToolSpec` 加一条即可。

## License

MIT。`vendor/bin` 内的 cua-driver 二进制来自 [trycua/cua](https://github.com/trycua/cua) 上游 release（版本与校验见 `vendor/bin/README.md`），依其许可证分发。
