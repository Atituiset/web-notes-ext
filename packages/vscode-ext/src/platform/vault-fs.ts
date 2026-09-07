/**
 * VaultFS 端口 VS Code 实现 — node:fs/promises，根 = 配置的 markpilot.vaultPath。
 * 未配置 vaultPath 时按 'no-handle' 语义降级：记忆检索静默为空，写入操作抛引导性错误。
 */
import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { VaultFS } from '../../../core/src/ports.js';

function vaultRoot(): string {
  return String(vscode.workspace.getConfiguration('markpilot').get('vaultPath') || '').trim();
}

async function requireRoot(): Promise<string> {
  const root = vaultRoot();
  if (!root) throw new Error('未配置 vault 目录 — 请设置 markpilot.vaultPath（Obsidian vault 绝对路径）');
  const st = await fs.stat(root).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('vault 目录不存在: ' + root);
  return root;
}

// 端口路径是 posix 相对路径，落盘前拼到根下
function resolve(root: string, p: string): string {
  return path.join(root, ...String(p).split('/').filter(Boolean));
}

export const vscodeVaultFS: VaultFS = {
  async permissionState() {
    if (!vaultRoot()) return 'no-handle';
    const st = await fs.stat(vaultRoot()).catch(() => null);
    return st && st.isDirectory() ? 'granted' : 'no-handle';
  },
  async ensureAccess() {
    await requireRoot();
  },
  async readText(p) {
    try {
      const root = await requireRoot();
      return await fs.readFile(resolve(root, p), 'utf8');
    } catch {
      return null; // 文件不存在或 vault 未配置
    }
  },
  async writeText(p, content) {
    const root = await requireRoot();
    const abs = resolve(root, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  },
  async listFiles(dir) {
    const root = await requireRoot();
    const abs = resolve(root, dir);
    await fs.mkdir(abs, { recursive: true }); // 目录不存在时创建（与端口语义一致）
    const out: { name: string; mtime: number }[] = [];
    for (const e of await fs.readdir(abs, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      const st = await fs.stat(path.join(abs, e.name));
      out.push({ name: e.name, mtime: st.mtimeMs });
    }
    return out;
  },
  async deleteFile(p) {
    const root = await requireRoot();
    await fs.rm(resolve(root, p));
  },
};
