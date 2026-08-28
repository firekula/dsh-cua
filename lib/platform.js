/**
 * cua-driver 的平台差异集中在这里。
 *
 * 上游驱动（trycua/cua 的 cua-driver-rs）在 macOS / Windows / Linux 上提供同一套
 * 可移植工具协议；平台差异只有三处：可执行文件名、插件自带二进制的 vendor 布局、
 * daemon 的本地端点地址与启动指引。
 *
 * @module dsh-cua/platform
 */
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** 驱动二进制文件名：Windows 带 `.exe`，其余平台无后缀。 */
export function driverBinaryName(platform = process.platform) {
    return platform === 'win32' ? 'cua-driver.exe' : 'cua-driver';
}
/**
 * 插件自带的驱动二进制路径；该平台没有自带副本时返回 undefined。
 *
 * 目前只自带 Windows x64。macOS 不自带：驱动以签名 CuaDriver.app 分发，
 * TCC 授权（辅助功能/屏幕录制）绑定安装位置，脱离上游安装器的固定位置
 * 会被系统击杀或反复要求授权——macOS 经全局安装解析（见 daemonSetupGuide）。
 */
export function vendoredDriverPath(platform = process.platform, arch = process.arch) {
    if (platform === 'win32' && arch === 'x64') {
        return fileURLToPath(new URL('../vendor/bin/windows-x86_64/cua-driver.exe', import.meta.url));
    }
    return undefined;
}
/**
 * 解析驱动可执行文件的绝对路径。
 *
 * 候选顺序：`binDir` 配置 → `CUA_DRIVER_BIN` 环境变量 → 插件自带副本 → `PATH`。
 * 全部不存在时返回 `origin: 'missing'`，`path` 为首个（最具体的）候选，供报错展示。
 */
export function resolveDriverPath(binDir, env, platform = process.platform, arch = process.arch) {
    const name = driverBinaryName(platform);
    const candidates = [];
    if (binDir.length > 0) {
        candidates.push({
            path: isAbsolute(binDir) ? join(binDir, name) : join(process.cwd(), binDir, name),
            origin: 'binDir',
        });
    }
    if (env !== undefined && env.length > 0) {
        candidates.push({ path: env, origin: 'env' });
    }
    const vendored = vendoredDriverPath(platform, arch);
    if (vendored !== undefined) {
        candidates.push({ path: vendored, origin: 'vendored' });
    }
    const pathEnv = process.env['PATH'] ?? '';
    for (const dir of pathEnv.split(delimiter)) {
        if (dir.length === 0)
            continue;
        candidates.push({ path: join(dir, name), origin: 'path' });
    }
    const found = candidates.find((candidate) => existsSync(candidate.path));
    if (found !== undefined)
        return found;
    return candidates[0] ?? { path: name, origin: 'missing' };
}
/** daemon 本地端点地址（与上游 `serve` 的默认值一致）。 */
export function daemonEndpoint(platform = process.platform) {
    if (platform === 'win32')
        return '\\\\.\\pipe\\cua-driver';
    if (platform === 'linux')
        return '~/.cache/cua-driver/cua-driver.sock';
    return '~/Library/Caches/cua-driver/cua-driver.sock';
}
/**
 * daemon 不可达时给用户的分平台启动指引（含 macOS 安装与 TCC 授权）。
 */
export function daemonSetupGuide(platform = process.platform) {
    const serveHint = `确认 ${daemonEndpoint(platform)} 存在后重试。可用 \`cua_status\` 工具或 \`cua-driver doctor\` 自检。`;
    if (platform === 'darwin') {
        return (`cua-driver daemon 未运行。若尚未安装，先执行上游安装脚本：`
            + `\`/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"\`；`
            + `然后运行 \`cua-driver permissions grant\` 完成辅助功能/屏幕录制授权（每个 macOS 会话只需一次），`
            + `再在一个普通终端执行 \`cua-driver serve\` 启动常驻服务（或 \`cua-driver autostart enable\` 注册登录自启）。${serveHint}`);
    }
    const linuxHint = platform === 'linux'
        ? `若尚未安装，先执行上游安装脚本：\`/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)"\`。`
        : '';
    return (`cua-driver daemon 未运行。${linuxHint}`
        + `请在一个普通终端执行 \`cua-driver serve\` 启动常驻服务`
        + `（或 \`cua-driver autostart enable\` 注册登录自启）。${serveHint}`);
}
