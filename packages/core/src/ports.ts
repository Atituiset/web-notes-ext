/**
 * 平台端口注册表（ports & adapters）— core 模块访问宿主能力的唯一入口。
 *
 * 宿主（chrome-ext / 未来的 vscode-ext / 测试）在启动时 configurePlatform 注入适配器；
 * core 内部经下方 getter 取端口。未配置即使用的端口抛明确错误 —— 例外：
 * PermissionGate 与 I18n 默认 no-op / 空串（调用点自带英文/中文兜底文案），
 * 保证纯函数单测与 Node 环境无需配置即可跑（与原 globalThis.chrome 软守卫等价）。
 */

/** vault 文件系统（Obsidian vault / 记忆库目录）。path 均相对 vault 根，可含子目录 */
export interface VaultFS {
  /** 权限状态（沿用原 obsidian.js 语义）：'granted' | 'prompt' | 'no-handle' */
  permissionState(): Promise<string>;
  /** 确保可读写（恢复权限；须授权时可能要求用户手势）。未授权抛错 */
  ensureAccess(): Promise<void>;
  /** 读文件全文；不存在返回 null */
  readText(path: string): Promise<string | null>;
  /** 写文件（父目录自动创建，整文件覆盖） */
  writeText(path: string, content: string): Promise<void>;
  /** 列出目录下的文件（仅文件，含 mtime 供缓存核对）；目录不存在时创建并返回 [] */
  listFiles(dir: string): Promise<{ name: string; mtime: number }[]>;
  deleteFile(path: string): Promise<void>;
}

/** 通用键值存储（embedding 向量缓存等） */
export interface KVStore {
  get(key: string): Promise<any>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<void>;
  /** 按前缀列键（无匹配返回 []） */
  listKeys(prefix: string): Promise<string[]>;
}

/** 应用设置存取（形状同 db.js 的 settings store：getSettings 合并默认值，saveSettings 打补丁） */
export interface SettingsStore {
  getSettings(): Promise<any>;
  saveSettings(patch: any): Promise<void>;
}

/** 网络宿主权限 */
export interface PermissionGate {
  /** fetch 前守卫：url 对应 origin 未授权时抛引导性错误；非法 url 直接放行 */
  ensureHost(url: string): Promise<void>;
  /** 用户手势内为 url 所在站点发起授权请求；已授权/授权成功 true，拒绝或非手势 false */
  requestHost(url: string): Promise<boolean>;
}

/** UI 文案（chrome.i18n 语义）；取不到返回 ''，调用方自带兜底文案 */
export interface I18n {
  msg(key: string, ...subs: (string | number)[]): string;
}

/** 包内静态资源 URL 解析（transformers.js / wasm 等运行时 import 用） */
export interface AssetResolver {
  resolveAssetUrl(path: string): string;
}

/** 页面正文提取源（tab/编辑器视图的实现由宿主给） */
export interface TextSource {
  /** 提取页面正文；受限页面/未授权返回 null */
  getPageText(tabId: number): Promise<string | null>;
}

export interface PlatformPorts {
  vaultFS?: VaultFS;
  kv?: KVStore;
  settings?: SettingsStore;
  permissions?: PermissionGate;
  i18n?: I18n;
  assets?: AssetResolver;
  textSource?: TextSource;
}

let _ports: PlatformPorts = {};

/** 注入平台适配器（部分字段，多次调用合并）；须在触碰 core 业务前调用 */
export function configurePlatform(partial: PlatformPorts): void {
  _ports = { ..._ports, ...partial };
}

function missing(name: string): never {
  throw new Error(`@markpilot/core: 平台端口 ${name} 未配置 — 启动时先 configurePlatform({ ${name}: ... })`);
}

export function vaultFS(): VaultFS {
  return _ports.vaultFS || missing('vaultFS');
}

export function kvStore(): KVStore {
  return _ports.kv || missing('kv');
}

export function settingsStore(): SettingsStore {
  return _ports.settings || missing('settings');
}

export function permissionGate(): PermissionGate {
  // 无 chrome.permissions 的环境（单测）直接放行 —— 与原软守卫等价
  return _ports.permissions || { ensureHost: async () => {}, requestHost: async () => false };
}

export function i18n(): I18n {
  // 默认取不到文案：返回 ''，调用点 || 兜底（与原 chrome?.i18n?.getMessage || fallback 等价）
  return _ports.i18n || { msg: () => '' };
}

export function assetResolver(): AssetResolver {
  return _ports.assets || missing('assets');
}

export function textSource(): TextSource {
  return _ports.textSource || missing('textSource');
}
