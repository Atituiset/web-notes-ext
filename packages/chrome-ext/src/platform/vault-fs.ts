/**
 * VaultFS 端口 chrome 实现 — Filesystem Access API。
 * vault 目录句柄持久化在 IndexedDB handles store（键 'vault'），与原 obsidian.js 一致。
 *
 * 路径约定：相对 vault 根、'/' 分隔（如 'Markpilot-Memory/x.md'），写路径自动建目录。
 * UI 层的目录选择/权限恢复函数（pickVault / vaultPermissionState / ensureVaultPermission）
 * 也由本模块导出 —— 它们就是适配器内部逻辑的对外暴露。
 */
import type { VaultFS } from '../../../core/src/ports.js';
import { idbGet, idbPut } from '../lib/db.js';

async function getVaultHandle(): Promise<FileSystemDirectoryHandle | null> {
  const row = await idbGet('handles', 'vault');
  return row || null;
}

/** 必须在用户手势内调用 (坑 #2)。返回 handle。 */
export async function pickVault() {
  if (!(window as any).showDirectoryPicker) throw new Error('当前浏览器不支持 Filesystem Access API');
  const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
  await idbPut('handles', 'vault', handle);
  return handle;
}

/** 恢复权限；granted → true。needs-prompt 时 UI 需让用户点一次按钮调 ensureVaultPermission。 */
export async function vaultPermissionState(): Promise<string> {
  const h = await getVaultHandle();
  if (!h) return 'no-handle';
  return (await (h as any).queryPermission({ mode: 'readwrite' })) || 'prompt';
}

export async function ensureVaultPermission(): Promise<FileSystemDirectoryHandle> {
  const h = await getVaultHandle();
  if (!h) throw new Error('未授权 vault 目录');
  if ((await (h as any).queryPermission({ mode: 'readwrite' })) === 'granted') return h;
  const r = await (h as any).requestPermission({ mode: 'readwrite' });
  if (r !== 'granted') throw new Error('vault 权限被拒绝');
  return h;
}

function splitPath(path: string): string[] {
  return String(path).split('/').filter(Boolean);
}

async function walkDir(root: FileSystemDirectoryHandle, segs: string[], create: boolean) {
  let dir = root;
  for (const s of segs) dir = await dir.getDirectoryHandle(s, { create });
  return dir;
}

export const chromeVaultFS: VaultFS = {
  permissionState: () => vaultPermissionState(),
  ensureAccess: async () => {
    await ensureVaultPermission();
  },
  async readText(path) {
    const segs = splitPath(path);
    const name = segs.pop()!;
    try {
      const root = await ensureVaultPermission();
      const dir = await walkDir(root, segs, false);
      const fh = await dir.getFileHandle(name, { create: false });
      return await (await fh.getFile()).text();
    } catch {
      return null; // 文件/目录不存在或权限中断
    }
  },
  async writeText(path, content) {
    const segs = splitPath(path);
    const name = segs.pop()!;
    const root = await ensureVaultPermission();
    const dir = await walkDir(root, segs, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  },
  async listFiles(dir) {
    const root = await ensureVaultPermission();
    const dh = await walkDir(root, splitPath(dir), true); // 记忆目录不存在时创建（与原 memDir 一致）
    const out: { name: string; mtime: number }[] = [];
    for await (const [name, handle] of (dh as any).entries()) {
      if (handle.kind !== 'file') continue;
      // getFile() 只取元数据不读全文 —— mtime 缓存核对的延迟关键（评测发现 #3）
      const f = await (handle as FileSystemFileHandle).getFile();
      out.push({ name, mtime: f.lastModified });
    }
    return out;
  },
  async deleteFile(path) {
    const segs = splitPath(path);
    const name = segs.pop()!;
    const root = await ensureVaultPermission();
    const dir = await walkDir(root, segs, false);
    await dir.removeEntry(name);
  },
};
