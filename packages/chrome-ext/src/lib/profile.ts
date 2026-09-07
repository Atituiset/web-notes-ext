/**
 * 用户画像（Phase 5）— 派生物而非新存储。
 *
 * 画像 = LLM 对既有记忆库的一次聚合，产出 Markpilot-Memory/_profile.md：
 * 角色与领域（带置信度）、知识背景、偏好、活跃主题。
 * frontmatter type=profile —— listMemories 只收 type=memory，天然跳过，不污染检索。
 *
 * 注入优先级等同 pinned（「用户是谁」卡片），由 chat-pipeline 在记忆之前注入；
 * 它不经 searchMemories，因此不影响检索指标。
 *
 * 生成触发：options 页手动按钮；settings.profileMemoryCount 记录生成时的记忆数，
 * 用于「距上次生成新增 N 条」的 stale 提示。
 */

import { listMemories, MEM_DIR } from './memory.js';
import { vaultPermissionState, ensureVaultPermission } from './obsidian.js';
import { parseFrontmatter } from './markdown.js';
import { streamChat } from './llm/index.js';
import { saveSettings } from './db.js';

export const PROFILE_FILE = '_profile.md';

const PROFILE_SYSTEM =
  '你是用户画像分析师。根据给定的用户记忆条目，生成一份结构化的用户画像（Markdown）。' +
  '要求：\n' +
  '1. 只依据记忆条目中有依据的内容，不要编造；依据少就标低置信度或不写。\n' +
  '2. 固定四个小节（二级标题）：「角色与领域」（每条带高/中/低置信度）、「知识背景」、「偏好」、「活跃主题」。\n' +
  '3. 语言与记忆条目的主要语言一致（中文为主则用中文）。\n' +
  '4. 总长度控制在 400 字以内，条目化，不要前言后语。';

/** 画像 prompt 组装（纯函数，导出供单测） */
export function buildProfilePrompt(memories: { body: string; tags: string[] }[]): string {
  const lines = memories.map((m, i) => `${i + 1}. [${m.tags.join('/') || 'note'}] ${m.body}`);
  return '以下是用户的记忆条目，请生成用户画像：\n\n' + lines.join('\n');
}

async function profileDir(): Promise<FileSystemDirectoryHandle | null> {
  if ((await vaultPermissionState()) !== 'granted') return null;
  const root = await ensureVaultPermission();
  return root.getDirectoryHandle(MEM_DIR, { create: true });
}

/** 读取当前画像正文；不存在返回 null */
export async function getProfile(): Promise<string | null> {
  const dir = await profileDir();
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(PROFILE_FILE);
    const parsed = parseFrontmatter(await (await fh.getFile()).text());
    return parsed.attrs.type === 'profile' ? parsed.body.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 生成/更新画像：聚合全部记忆 → LLM → 写 _profile.md。
 * @throws 记忆库为空 / vault 未授权 / LLM 未配置或调用失败
 * @returns { file, memoryCount }
 */
export async function generateProfile(settings: any): Promise<{ file: string; memoryCount: number }> {
  const memories = await listMemories();
  if (!memories.length) throw new Error('EMPTY');

  // 预算内装入：按 hits+recency 粗略排序取前 ~4000 字（画像应偏向重要记忆）
  const sorted = [...memories].sort((a, b) => b.hits - a.hits || b.updated.localeCompare(a.updated));
  const packed: { body: string; tags: string[] }[] = [];
  let chars = 0;
  for (const m of sorted) {
    if (chars + m.body.length > 4000) break;
    packed.push({ body: m.body, tags: m.tags });
    chars += m.body.length;
  }

  const { text } = await streamChat({
    settings,
    messages: [
      { role: 'system', content: PROFILE_SYSTEM },
      { role: 'user', content: buildProfilePrompt(packed) },
    ],
  });
  const body = text.trim();
  if (!body) throw new Error('LLM 返回空画像');

  const dir = await profileDir();
  if (!dir) throw new Error('vault 未授权');
  const today = new Date().toISOString().slice(0, 10);
  const md = [
    '---',
    'type: profile',
    'updated: ' + today,
    'memoryCount: ' + memories.length,
    '---',
    '',
    body,
    '',
  ].join('\n');
  const fh = await dir.getFileHandle(PROFILE_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(md);
  await w.close();

  await saveSettings({ profileMemoryCount: memories.length, profileUpdated: today });
  return { file: PROFILE_FILE, memoryCount: memories.length };
}
