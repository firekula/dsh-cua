# vendor/bin — 自带的 cua-driver 二进制

来自上游 [trycua/cua](https://github.com/trycua/cua) 的 `cua-driver-rs` release，按平台分目录。解析逻辑见 `src/platform.ts`。

| 目录 | 覆盖 | 上游版本 | 来源资产 |
|---|---|---|---|
| `windows-x86_64/cua-driver.exe` (+ `cua-driver-uia.exe`) | Windows x64 | 早于 v0.22.2（初版引入，待对齐后更新此表） | 上游 windows release zip |

**为什么不自带 macOS**：macOS 的驱动以签名 `CuaDriver.app` 分发，TCC 授权（辅助功能/屏幕录制）绑定安装位置——实测把二进制或整个 bundle 放进 node_modules，`serve` 会被系统 SIGKILL 或每次安装路径变化都要求重新授权。macOS/Linux 统一走上游安装器（`install.sh`，装到固定位置并接入 PATH），插件按 `binDir` → `CUA_DRIVER_BIN` → 插件自带副本 → `PATH` 解析。

上游 release 附带 `checksums.txt`，替换二进制时先核对压缩包哈希再解包，并更新本表。
