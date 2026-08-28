/**
 * cua-driver 的平台差异集中在这里。
 *
 * 上游驱动（trycua/cua 的 cua-driver-rs）在 macOS / Windows / Linux 上提供同一套
 * 可移植工具协议；平台差异只有三处：可执行文件名、插件自带二进制的 vendor 布局、
 * daemon 的本地端点地址与启动指引。
 *
 * @module dsh-cua/platform
 */
/** 驱动二进制文件名：Windows 带 `.exe`，其余平台无后缀。 */
export declare function driverBinaryName(platform?: NodeJS.Platform): string;
/**
 * 插件自带的驱动二进制路径；该平台没有自带副本时返回 undefined。
 *
 * 目前只自带 Windows x64。macOS 不自带：驱动以签名 CuaDriver.app 分发，
 * TCC 授权（辅助功能/屏幕录制）绑定安装位置，脱离上游安装器的固定位置
 * 会被系统击杀或反复要求授权——macOS 经全局安装解析（见 daemonSetupGuide）。
 */
export declare function vendoredDriverPath(platform?: NodeJS.Platform, arch?: NodeJS.Architecture): string | undefined;
/** 解析来源：显式配置永远优先，其次插件自带副本，最后 PATH。 */
export type DriverResolutionOrigin = 'binDir' | 'env' | 'vendored' | 'path' | 'missing';
/** 一次驱动二进制解析的结果；`missing` 时 `path` 指向最具体的候选位置。 */
export interface DriverResolution {
    path: string;
    origin: DriverResolutionOrigin;
}
/**
 * 解析驱动可执行文件的绝对路径。
 *
 * 候选顺序：`binDir` 配置 → `CUA_DRIVER_BIN` 环境变量 → 插件自带副本 → `PATH`。
 * 全部不存在时返回 `origin: 'missing'`，`path` 为首个（最具体的）候选，供报错展示。
 */
export declare function resolveDriverPath(binDir: string, env: string | undefined, platform?: NodeJS.Platform, arch?: NodeJS.Architecture): DriverResolution;
/** daemon 本地端点地址（与上游 `serve` 的默认值一致）。 */
export declare function daemonEndpoint(platform?: NodeJS.Platform): string;
/**
 * daemon 不可达时给用户的分平台启动指引（含 macOS 安装与 TCC 授权）。
 */
export declare function daemonSetupGuide(platform?: NodeJS.Platform): string;
